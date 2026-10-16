// Gmail's search syntax, translated to IMAP SEARCH and run on the server — so body
// text is searched with the server's full-text index (Dovecot FTS, for instance),
// not limited to whatever this client has cached.
import type { SearchObject } from "imapflow";
import { db, placeholders } from "../db.ts";
import { type AccountRuntime, syncable } from "../imap/runtime.ts";
import { type MailboxRow, getMailboxes, insertFetched, specialUseName } from "../imap/store.ts";
import { labelToKeyword } from "./keywords.ts";

export interface ParsedQuery {
  criteria: SearchObject;
  hasAttachment: boolean | null;
  /** "anywhere", a special-use name, or a folder name. Null: everywhere but Trash/Spam. */
  scope: string | null;
  empty: boolean;
}

type Crit = SearchObject;

/** Splits on spaces, keeping "quoted phrases" and op:"quoted values" together. */
export function tokenize(q: string): string[] {
  const out: string[] = [];
  const re = /(-?[a-z_]+:)?"([^"]*)"|\S+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    if (m[2] !== undefined) out.push(`${m[1] ?? ""}"${m[2]}"`);
    else out.push(m[0]);
  }
  return out;
}

const UNITS: Record<string, number> = { d: 86_400_000, w: 7 * 86_400_000, m: 30 * 86_400_000, y: 365 * 86_400_000 };

function parseDate(value: string): Date | null {
  const m = value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t) : null;
}

function parseSize(value: string): number | null {
  const m = value.match(/^(\d+(?:\.\d+)?)([kmg]?)b?$/i);
  if (!m) return null;
  const mult = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as "" | "k" | "m" | "g"];
  return Math.round(Number(m[1]) * mult);
}

function unquote(v: string): string {
  return v.replace(/^"|"$/g, "");
}

function negate(c: Crit): Crit {
  const keys = Object.keys(c);
  if (keys.length === 1 && keys[0] === "not") return c.not as Crit;
  return { not: c };
}

/** AND of criteria, nesting only where IMAP's one-key-per-object shape requires it. */
export function and(crits: Crit[]): Crit {
  const base: Record<string, unknown> = {};
  const rest: Crit[] = [];
  for (const c of crits) {
    const keys = Object.keys(c);
    if (keys.length === 1 && keys[0] !== "not" && !(keys[0] in base)) base[keys[0]] = (c as Record<string, unknown>)[keys[0]];
    else rest.push(c);
  }
  if (rest.length === 1) base.not = negate(rest[0]);
  else if (rest.length > 1) base.not = { or: rest.map(negate) };
  if (!Object.keys(base).length) base.all = true;
  return base as Crit;
}

export function parseQuery(q: string): ParsedQuery {
  const crits: Crit[] = [];
  let hasAttachment: boolean | null = null;
  let scope: string | null = null;
  for (const token of tokenize(q.trim())) {
    const neg = token.startsWith("-") && token.length > 1;
    const t = neg ? token.slice(1) : token;
    const m = t.match(/^([a-z_]+):(.+)$/i);
    let crit: Crit | null = null;
    if (m) {
      const op = m[1].toLowerCase();
      const value = unquote(m[2]);
      switch (op) {
        case "from": case "to": case "cc": case "bcc": case "subject":
          crit = { [op]: value };
          break;
        case "label":
          crit = { keyword: labelToKeyword(value) };
          break;
        case "in":
          scope = value.toLowerCase();
          break;
        case "is": {
          const v = value.toLowerCase();
          if (v === "unread") crit = { seen: false };
          else if (v === "read") crit = { seen: true };
          else if (v === "starred") crit = { flagged: true };
          else if (v === "unstarred") crit = { flagged: false };
          else if (v === "answered" || v === "replied") crit = { answered: true };
          break;
        }
        case "has":
          if (/^attachments?$/i.test(value)) hasAttachment = !neg;
          break;
        case "before": case "older": {
          const d = parseDate(value);
          if (d) crit = { before: d };
          break;
        }
        case "after": case "newer": case "since": {
          const d = parseDate(value);
          if (d) crit = { since: d };
          break;
        }
        case "older_than": case "newer_than": {
          const mm = value.match(/^(\d+)([dwmy])$/i);
          if (mm) {
            const d = new Date(Date.now() - Number(mm[1]) * UNITS[mm[2].toLowerCase()]);
            crit = op === "older_than" ? { before: d } : { since: d };
          }
          break;
        }
        case "larger": case "smaller": {
          const n = parseSize(value);
          if (n !== null) crit = { [op]: n };
          break;
        }
        default:
          // Not an operator we know (a URL, "re:" …): search it as text.
          crit = { text: t };
      }
    } else {
      const text = unquote(t);
      if (text) crit = { text };
    }
    if (crit) crits.push(neg ? negate(crit) : crit);
  }
  return { criteria: and(crits), hasAttachment, scope, empty: crits.length === 0 && hasAttachment === null && scope === null };
}

function scopeMailboxes(accountId: number, scope: string | null): MailboxRow[] {
  const boxes = getMailboxes(accountId).filter(syncable);
  if (scope === "anywhere") return boxes;
  if (scope) {
    const aliases: Record<string, string> = { inbox: "inbox", sent: "sent", drafts: "drafts", draft: "drafts", spam: "junk", junk: "junk", trash: "trash", bin: "trash", archive: "archive" };
    const special = aliases[scope];
    if (special) return boxes.filter((b) => specialUseName(b.special_use) === special);
    return boxes.filter((b) => b.path.toLowerCase() === scope || b.name.toLowerCase() === scope);
  }
  return boxes.filter((b) => {
    const u = specialUseName(b.special_use);
    return u !== "trash" && u !== "junk";
  });
}

const cache = new Map<string, { ids: number[]; at: number }>();
const MAX_PER_FOLDER = 3000;

export async function searchThreads(rt: AccountRuntime, q: string): Promise<number[]> {
  const key = `${rt.account.id}\0${q}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.ids;

  const parsed = parseQuery(q);
  const threads = new Map<number, number>();
  for (const mb of scopeMailboxes(rt.account.id, parsed.scope)) {
    const uids = await rt.withMailbox(
      mb.path,
      async (client) => {
        const found = await client.search(parsed.criteria, { uid: true });
        const list = (Array.isArray(found) ? found : []).sort((a, b) => b - a).slice(0, MAX_PER_FOLDER);
        // Matches older than what we've indexed so far: index them now.
        const floor = db().get<{ backfill_uid: number | null }>("SELECT backfill_uid FROM mailboxes WHERE id = ?", mb.id)?.backfill_uid;
        const missing = list.filter((u) => floor && u < floor && !db().get("SELECT 1 FROM messages WHERE mailbox_id = ? AND uid = ?", mb.id, u));
        if (missing.length) {
          const query = { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true, headers: ["references"] };
          for await (const msg of client.fetch(missing.join(","), query, { uid: true })) insertFetched(rt.account.id, mb, msg);
        }
        return list;
      },
      true,
    );
    for (let i = 0; i < uids.length; i += 500) {
      const chunk = uids.slice(i, i + 500);
      const rows = db().all<{ thread_id: number; date: number; attachments: number }>(
        `SELECT thread_id, date, attachments FROM messages WHERE mailbox_id = ? AND uid IN (${placeholders(chunk.length)})`,
        mb.id,
        ...chunk,
      );
      for (const r of rows) {
        if (parsed.hasAttachment === true && !r.attachments) continue;
        if (parsed.hasAttachment === false && r.attachments) continue;
        threads.set(r.thread_id, Math.max(threads.get(r.thread_id) ?? 0, r.date));
      }
    }
  }
  const ids = [...threads.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  cache.set(key, { ids, at: Date.now() });
  if (cache.size > 200) cache.delete(cache.keys().next().value!);
  return ids;
}
