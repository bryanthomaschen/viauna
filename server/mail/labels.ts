// Label definitions (display name, colour) live in the local database; the labels
// themselves are keywords on the messages, on the server. Renaming or deleting a
// label therefore rewrites keywords on the server, folder by folder.
import { db, placeholders } from "../db.ts";
import { type AccountRuntime, syncable } from "../imap/runtime.ts";
import { type MessageRow, getMailboxes, updateFlags } from "../imap/store.ts";
import { labelToKeyword, unpackKeywords } from "./keywords.ts";

export interface Label {
  keyword: string;
  name: string;
  color: string | null;
  total: number;
  unread: number;
}

/** Gmail's label palette (background colours). */
export const LABEL_COLORS = [
  "#fb4c2f", "#ffad47", "#fad165", "#16a766", "#43d692", "#4a86e8", "#a479e2", "#f691b3",
  "#f6c5be", "#ffe6c7", "#fef1d1", "#b9e4d0", "#c6f3de", "#c9daf8", "#e4d7f5", "#fcdee8",
  "#cccccc", "#666666",
];

export class LabelError extends Error {}

export function listLabels(accountId: number): Label[] {
  const rows = db().all<{ keyword: string; name: string; color: string | null }>(
    "SELECT keyword, name, color FROM labels WHERE account_id = ? ORDER BY name COLLATE NOCASE",
    accountId,
  );
  return rows.map((r) => {
    const counts = db().get<{ total: number; unread: number }>(
      `SELECT COUNT(DISTINCT thread_id) AS total,
              COUNT(DISTINCT CASE WHEN seen = 0 THEN thread_id END) AS unread
       FROM messages WHERE account_id = ? AND instr(keywords, ?) > 0`,
      accountId,
      ` ${r.keyword} `,
    )!;
    return { ...r, total: counts.total, unread: counts.unread };
  });
}

function validName(name: unknown): string {
  const n = String(name ?? "").trim().replace(/\s+/g, " ");
  if (!n || n.length > 100) throw new LabelError("Label names need 1–100 characters.");
  return n;
}

function validColor(color: unknown): string | null {
  if (color === null || color === undefined || color === "") return null;
  const c = String(color).toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(c)) throw new LabelError("Invalid colour.");
  return c;
}

export function createLabel(accountId: number, name: unknown, color?: unknown): Label {
  const n = validName(name);
  const keyword = labelToKeyword(n);
  const exists = db().get("SELECT 1 FROM labels WHERE account_id = ? AND keyword = ?", accountId, keyword);
  if (exists) throw new LabelError(`There is already a label called "${n}".`);
  db().run(
    "INSERT INTO labels (account_id, keyword, name, color, created_at) VALUES (?, ?, ?, ?, ?)",
    accountId, keyword, n, validColor(color), Date.now(),
  );
  return { keyword, name: n, color: validColor(color), total: 0, unread: 0 };
}

/** Replaces keyword `from` with `to` (or removes it, when `to` is null) on every message. */
async function retag(rt: AccountRuntime, from: string, to: string | null) {
  const touched: number[] = [];
  for (const mb of getMailboxes(rt.account.id).filter(syncable)) {
    const uids = await rt.withMailbox(mb.path, async (client) => {
      const found = await client.search({ keyword: from }, { uid: true });
      const list = Array.isArray(found) ? found : [];
      if (!list.length) return list;
      const range = list.join(",");
      if (to) await client.messageFlagsAdd(range, [to], { uid: true, silent: true });
      await client.messageFlagsRemove(range, [from], { uid: true, silent: true });
      return list;
    });
    if (!uids.length) continue;
    touched.push(mb.id);
    for (let i = 0; i < uids.length; i += 500) {
      const chunk = uids.slice(i, i + 500);
      const rows = db().all<MessageRow>(
        `SELECT * FROM messages WHERE mailbox_id = ? AND uid IN (${placeholders(chunk.length)})`,
        mb.id,
        ...chunk,
      );
      for (const r of rows) {
        const flags = new Set(unpackKeywords(r.keywords).filter((k) => k !== from));
        if (to) flags.add(to);
        if (r.seen) flags.add("\\Seen");
        if (r.flagged) flags.add("\\Flagged");
        if (r.answered) flags.add("\\Answered");
        if (r.draft) flags.add("\\Draft");
        updateFlags(rt.account.id, mb.id, r.uid, flags);
      }
    }
  }
  rt.notify(touched);
}

export async function updateLabel(rt: AccountRuntime, keyword: string, patch: { name?: unknown; color?: unknown }): Promise<Label> {
  const accountId = rt.account.id;
  const row = db().get<{ keyword: string; name: string; color: string | null }>(
    "SELECT keyword, name, color FROM labels WHERE account_id = ? AND keyword = ?",
    accountId,
    keyword,
  );
  if (!row) throw new LabelError("No such label.");
  let next = row.keyword;
  let name = row.name;
  if (patch.name !== undefined) {
    name = validName(patch.name);
    next = labelToKeyword(name);
    if (next !== row.keyword) {
      if (db().get("SELECT 1 FROM labels WHERE account_id = ? AND keyword = ?", accountId, next)) {
        throw new LabelError(`There is already a label called "${name}".`);
      }
      await retag(rt, row.keyword, next);
    }
  }
  const color = patch.color !== undefined ? validColor(patch.color) : row.color;
  db().tx(() => {
    db().run("DELETE FROM labels WHERE account_id = ? AND keyword = ?", accountId, row.keyword);
    db().run(
      "INSERT OR REPLACE INTO labels (account_id, keyword, name, color, created_at) VALUES (?, ?, ?, ?, ?)",
      accountId, next, name, color, Date.now(),
    );
  });
  return { keyword: next, name, color, total: 0, unread: 0 };
}

export async function deleteLabel(rt: AccountRuntime, keyword: string) {
  await retag(rt, keyword, null);
  db().run("DELETE FROM labels WHERE account_id = ? AND keyword = ?", rt.account.id, keyword);
}

export function searchContacts(accountId: number, q: string, limit = 8) {
  const term = q.trim().toLowerCase();
  if (!term) return [];
  const like = `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return db().all<{ address: string; name: string | null }>(
    `SELECT address, name FROM contacts
     WHERE account_id = ? AND (address LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\')
       AND address NOT LIKE 'no-reply%' AND address NOT LIKE 'noreply%' AND address NOT LIKE 'mailer-daemon%'
     ORDER BY (address LIKE ? ESCAPE '\\') DESC, sent * 5 + received DESC, last_at DESC LIMIT ?`,
    accountId, like, like, `${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`, limit,
  );
}
