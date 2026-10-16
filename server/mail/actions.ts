// Archive, delete, move, star, read, label — applied to whole conversations (as in
// Gmail) or to single messages. Each runs as one IMAP command per source folder,
// updates the local index straight away, and returns an undo token when the
// operation is reversible.
import type { AccountRuntime } from "../imap/runtime.ts";
import { randomToken } from "../crypto.ts";
import { db, placeholders } from "../db.ts";
import {
  type MailboxRow,
  type MessageRow,
  type SpecialUse,
  deleteMessages,
  getMailbox,
  getMailboxByPath,
  moveRows,
  specialMailboxes,
  specialUseName,
  updateFlags,
} from "../imap/store.ts";
import { myAddresses } from "../settings.ts";
import { unpackKeywords } from "./keywords.ts";
import type { View } from "./views.ts";

export type ActionName =
  | "archive" | "trash" | "delete" | "spam" | "notspam" | "inbox" | "move"
  | "read" | "unread" | "star" | "unstar" | "label" | "unlabel";

export interface ActionInput {
  action: ActionName;
  threads?: number[];
  messages?: { mailboxId: number; uid: number }[];
  view: View;
  /** Destination folder for "move". */
  target?: number;
  /** Keyword for "label" / "unlabel". */
  keyword?: string;
}

type Op =
  | { kind: "move"; from: number; to: number; uids: number[] }
  | { kind: "flags"; mailbox: number; uids: number[]; add: string[]; remove: string[] };

interface UndoEntry {
  accountId: number;
  ops: Op[];
  expires: number;
}

const undoLog = new Map<string, UndoEntry>();

export class ActionError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function rowsFor(accountId: number, input: ActionInput): MessageRow[] {
  if (input.messages?.length) {
    const out: MessageRow[] = [];
    for (const ref of input.messages.slice(0, 5000)) {
      const row = db().get<MessageRow>(
        "SELECT * FROM messages WHERE account_id = ? AND mailbox_id = ? AND uid = ?",
        accountId, ref.mailboxId, ref.uid,
      );
      if (row) out.push(row);
    }
    return out;
  }
  const ids = (input.threads ?? []).slice(0, 2000);
  if (!ids.length) return [];
  return db().all<MessageRow>(
    `SELECT * FROM messages WHERE account_id = ? AND thread_id IN (${placeholders(ids.length)}) ORDER BY date ASC`,
    accountId,
    ...ids,
  );
}

const DEFAULT_NAMES: Partial<Record<SpecialUse, string>> = { archive: "Archive", trash: "Trash", junk: "Junk" };

/** The special folder for `use`, created (Archive/Trash/Junk) if the server has none. */
async function ensureSpecial(rt: AccountRuntime, use: SpecialUse): Promise<MailboxRow> {
  const existing = specialMailboxes(rt.account.id)[use];
  if (existing) return existing;
  const name = DEFAULT_NAMES[use];
  if (!name) throw new ActionError(`This mailbox has no ${use} folder.`);
  const byName = getMailboxByPath(rt.account.id, name);
  if (byName) return byName;
  const client = await rt.fg.get();
  await client.mailboxCreate(name);
  await client.mailboxSubscribe(name).catch(() => {});
  db().run(
    `INSERT OR IGNORE INTO mailboxes (account_id, path, name, special_use, subscribed, selectable) VALUES (?, ?, ?, ?, 1, 1)`,
    rt.account.id, name, name, `\\${use[0].toUpperCase()}${use.slice(1)}`,
  );
  const row = getMailboxByPath(rt.account.id, name)!;
  rt.syncMailboxSoon(row.id);
  return row;
}

function groupByMailbox(rows: MessageRow[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const r of rows) {
    const list = out.get(r.mailbox_id) ?? [];
    list.push(r.uid);
    out.set(r.mailbox_id, list);
  }
  return out;
}

async function move(rt: AccountRuntime, from: MailboxRow, to: MailboxRow, uids: number[]): Promise<Op | null> {
  if (!uids.length || from.id === to.id) return null;
  const result = await rt.withMailbox(from.path, (client) => client.messageMove(uids.join(","), to.path, { uid: true }));
  if (result && result.uidMap?.size) {
    moveRows(from.id, to.id, result.uidMap);
    const unmapped = uids.filter((u) => !result.uidMap!.has(u));
    deleteMessages(from.id, unmapped);
    if (unmapped.length) rt.syncMailboxSoon(to.id);
    return { kind: "move", from: to.id, to: from.id, uids: [...result.uidMap.values()] };
  }
  // No UIDPLUS: we don't know the new UIDs, so drop the rows and let sync re-add them.
  deleteMessages(from.id, uids);
  rt.syncMailboxSoon(to.id);
  return null;
}

async function setFlags(rt: AccountRuntime, mb: MailboxRow, rows: MessageRow[], add: string[], remove: string[]): Promise<Op | null> {
  if (!rows.length) return null;
  const uids = rows.map((r) => r.uid).join(",");
  await rt.withMailbox(mb.path, async (client, box) => {
    // PERMANENTFLAGS (from a read-write SELECT) says whether custom keywords stick here.
    const custom = add.filter((f) => !f.startsWith("\\"));
    if (custom.length && box.permanentFlags && !box.permanentFlags.has("\\*") && !custom.every((f) => box.permanentFlags!.has(f))) {
      db().run("UPDATE mailboxes SET keywords_allowed = 0 WHERE id = ?", mb.id);
      throw new ActionError(`The mail server doesn't allow labels in "${mb.name}".`);
    }
    if (add.length) await client.messageFlagsAdd(uids, add, { uid: true, silent: true });
    if (remove.length) await client.messageFlagsRemove(uids, remove, { uid: true, silent: true });
  });
  for (const r of rows) {
    const flags = new Set<string>(unpackKeywords(r.keywords));
    if (r.seen) flags.add("\\Seen");
    if (r.flagged) flags.add("\\Flagged");
    if (r.answered) flags.add("\\Answered");
    if (r.draft) flags.add("\\Draft");
    if (r.forwarded) flags.add("$forwarded");
    const lower = (f: string) => (f.startsWith("\\") ? f : f.toLowerCase());
    for (const f of add) flags.add(lower(f));
    for (const f of remove) flags.delete(lower(f));
    updateFlags(rt.account.id, mb.id, r.uid, flags);
  }
  return { kind: "flags", mailbox: mb.id, uids: rows.map((r) => r.uid), add: remove, remove: add };
}

/** Each conversation's latest message, preferring ones that pass `prefer`. Rows are in date order. */
function latestPerThread(rows: MessageRow[], prefer: (r: MessageRow) => boolean): MessageRow[] {
  const byThread = new Map<number, MessageRow[]>();
  for (const r of rows) byThread.set(r.thread_id, [...(byThread.get(r.thread_id) ?? []), r]);
  return [...byThread.values()].map((list) => [...list].reverse().find(prefer) ?? list[list.length - 1]);
}

function has(row: MessageRow, flag: string): boolean {
  switch (flag) {
    case "\\Seen": return !!row.seen;
    case "\\Flagged": return !!row.flagged;
    default: return row.keywords.includes(` ${flag.toLowerCase()} `);
  }
}

function validKeyword(keyword: string | undefined): string {
  if (!keyword || keyword.length > 120 || !/^[^\s(){}%*"\\\]\x00-\x1f\x7f$][^\s(){}%*"\\\]\x00-\x1f\x7f]*$/.test(keyword)) {
    throw new ActionError("Invalid label.");
  }
  return keyword.toLowerCase();
}

export async function perform(rt: AccountRuntime, input: ActionInput): Promise<{ undo?: string; count: number }> {
  const accountId = rt.account.id;
  const rows = rowsFor(accountId, input);
  if (!rows.length) return { count: 0 };
  const special = specialMailboxes(accountId);
  const use = (r: MessageRow) => specialUseName(getMailboxCached(accountId, r.mailbox_id)?.special_use ?? null);
  const viewMailbox = input.view.kind === "mailbox" ? input.view.mailboxId : null;
  const inScope = (r: MessageRow) => {
    const u = use(r);
    if (viewMailbox !== null && (special.trash?.id === viewMailbox || special.junk?.id === viewMailbox)) return r.mailbox_id === viewMailbox;
    return u !== "trash" && u !== "junk";
  };
  const ops: Op[] = [];
  const touched = new Set<number>();
  const me = myAddresses(accountId, rt.account.email);

  const moveAll = async (selected: MessageRow[], to: MailboxRow) => {
    for (const [from, uids] of groupByMailbox(selected)) {
      const mb = getMailbox(accountId, from);
      if (!mb) continue;
      const op = await move(rt, mb, to, uids);
      if (op) ops.push(op);
      touched.add(from).add(to.id);
    }
  };
  const flagAll = async (selected: MessageRow[], add: string[], remove: string[]) => {
    const byBox = new Map<number, MessageRow[]>();
    for (const r of selected) byBox.set(r.mailbox_id, [...(byBox.get(r.mailbox_id) ?? []), r]);
    for (const [id, list] of byBox) {
      const mb = getMailbox(accountId, id);
      if (!mb) continue;
      const op = await setFlags(rt, mb, list, add, remove);
      if (op) ops.push(op);
      touched.add(id);
    }
  };

  // Movable: what "move this conversation" means — not your Sent copies or drafts.
  const movable = (r: MessageRow) => {
    if (viewMailbox !== null && input.view.kind === "mailbox" && !input.messages?.length) return r.mailbox_id === viewMailbox;
    const u = use(r);
    return u !== "sent" && u !== "drafts" && u !== "trash" && u !== "junk";
  };

  switch (input.action) {
    case "archive": {
      const inbox = special.inbox;
      const selected = rows.filter((r) => (input.messages?.length ? true : r.mailbox_id === inbox?.id));
      await moveAll(selected.filter((r) => use(r) !== "archive"), await ensureSpecial(rt, "archive"));
      break;
    }
    case "trash": {
      const trash = await ensureSpecial(rt, "trash");
      // Deleting from Drafts discards the drafts, not the conversation they answer.
      const draftsView = viewMailbox !== null && viewMailbox === special.drafts?.id && !input.messages?.length;
      await moveAll(rows.filter((r) => r.mailbox_id !== trash.id && (!draftsView || r.mailbox_id === viewMailbox)), trash);
      break;
    }
    case "delete": {
      // Permanent: only ever messages already in Trash or Spam, and from a folder
      // view only the ones in that folder.
      const selected = rows.filter((r) => {
        const u = use(r);
        if (u !== "trash" && u !== "junk") return false;
        return input.messages?.length || viewMailbox === null ? true : r.mailbox_id === viewMailbox;
      });
      for (const [id, uids] of groupByMailbox(selected)) {
        const mb = getMailbox(accountId, id);
        if (!mb) continue;
        await rt.withMailbox(mb.path, (client) => client.messageDelete(uids.join(","), { uid: true }));
        deleteMessages(id, uids);
        touched.add(id);
      }
      break;
    }
    case "spam": {
      const junk = await ensureSpecial(rt, "junk");
      await moveAll(rows.filter((r) => movable(r) && r.mailbox_id !== junk.id), junk);
      break;
    }
    case "notspam": {
      const inbox = special.inbox;
      if (!inbox) throw new ActionError("No inbox.");
      await moveAll(rows.filter((r) => use(r) === "junk"), inbox);
      break;
    }
    case "inbox": {
      const inbox = special.inbox;
      if (!inbox) throw new ActionError("No inbox.");
      const selected = rows.filter((r) => {
        if (r.mailbox_id === inbox.id) return false;
        if (viewMailbox !== null && !input.messages?.length) return r.mailbox_id === viewMailbox;
        const u = use(r);
        return u !== "sent" && u !== "drafts" && u !== "junk" && u !== "trash";
      });
      await moveAll(selected, inbox);
      break;
    }
    case "move": {
      const target = input.target !== undefined ? getMailbox(accountId, input.target) : undefined;
      if (!target || !target.selectable) throw new ActionError("Choose a folder to move to.");
      await moveAll(rows.filter((r) => movable(r) && r.mailbox_id !== target.id), target);
      break;
    }
    case "read":
      await flagAll(rows.filter((r) => inScope(r) && !r.seen), ["\\Seen"], []);
      break;
    case "unread": {
      // Gmail marks a conversation unread by its latest message from someone else
      // (your own reply being unread would leave the conversation looking read).
      const scoped = rows.filter(inScope);
      const selected = input.messages?.length ? scoped : latestPerThread(scoped, (r) => !me.has(r.from_addr ?? ""));
      await flagAll(selected.filter((r) => r.seen), [], ["\\Seen"]);
      break;
    }
    case "star": {
      const scoped = rows.filter(inScope);
      const target = input.messages?.length ? scoped : latestPerThread(scoped, () => true);
      await flagAll(target.filter((r) => !r.flagged), ["\\Flagged"], []);
      break;
    }
    case "unstar":
      await flagAll(rows.filter((r) => inScope(r) && r.flagged), [], ["\\Flagged"]);
      break;
    case "label": {
      const kw = validKeyword(input.keyword);
      await flagAll(rows.filter((r) => inScope(r) && !has(r, kw)), [kw], []);
      break;
    }
    case "unlabel": {
      const kw = validKeyword(input.keyword);
      await flagAll(rows.filter((r) => has(r, kw)), [], [kw]);
      break;
    }
    default:
      throw new ActionError("Unknown action.");
  }

  rt.notify([...touched]);
  let undo: string | undefined;
  if (ops.length && input.action !== "delete") {
    undo = randomToken(16);
    undoLog.set(undo, { accountId, ops, expires: Date.now() + 10 * 60_000 });
  }
  return { undo, count: rows.length };
}

export async function undo(rt: AccountRuntime, token: string): Promise<boolean> {
  const entry = undoLog.get(token);
  if (!entry || entry.accountId !== rt.account.id || entry.expires < Date.now()) return false;
  undoLog.delete(token);
  const touched = new Set<number>();
  for (const op of [...entry.ops].reverse()) {
    if (op.kind === "move") {
      const from = getMailbox(rt.account.id, op.from);
      const to = getMailbox(rt.account.id, op.to);
      if (from && to) await move(rt, from, to, op.uids);
      touched.add(op.from).add(op.to);
    } else {
      const mb = getMailbox(rt.account.id, op.mailbox);
      if (!mb) continue;
      const rows = db().all<MessageRow>(
        `SELECT * FROM messages WHERE mailbox_id = ? AND uid IN (${placeholders(op.uids.length)})`,
        mb.id,
        ...op.uids,
      );
      await setFlags(rt, mb, rows, op.add, op.remove);
      touched.add(op.mailbox);
    }
  }
  rt.notify([...touched]);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of undoLog) if (v.expires < now) undoLog.delete(k);
}, 60_000).unref();

// Mailbox rows are read once per message above; cache them for the call's duration.
const mbCache = new Map<string, { row: MailboxRow | undefined; at: number }>();
function getMailboxCached(accountId: number, id: number): MailboxRow | undefined {
  const key = `${accountId}:${id}`;
  const hit = mbCache.get(key);
  if (hit && Date.now() - hit.at < 2000) return hit.row;
  const row = getMailbox(accountId, id);
  mbCache.set(key, { row, at: Date.now() });
  if (mbCache.size > 500) mbCache.clear();
  return row;
}
