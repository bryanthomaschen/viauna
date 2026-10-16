// The local index: rows that mirror what the IMAP server holds, written by the sync
// engine and by actions (which update it immediately rather than waiting for a resync).
import type { FetchMessageObject, MessageAddressObject } from "imapflow";
import { db, placeholders } from "../db.ts";
import { isSystemKeyword, keywordToLabel, packKeywords, unpackKeywords } from "../mail/keywords.ts";
import { countAttachments, findTextPart } from "../mail/structure.ts";
import { assignThread, normalizeMessageId, parseMessageIds } from "../mail/threading.ts";

export interface MailboxRow {
  id: number;
  account_id: number;
  path: string;
  name: string;
  delimiter: string | null;
  parent_path: string | null;
  special_use: string | null;
  subscribed: number;
  selectable: number;
  uidvalidity: string | null;
  uidnext: number | null;
  highestmodseq: string | null;
  total: number | null;
  unseen: number | null;
  keywords_allowed: number | null;
  synced_uidnext: number;
  synced_modseq: string | null;
  backfill_uid: number | null;
  backfill_done: number;
}

export interface MessageRow {
  mailbox_id: number;
  uid: number;
  account_id: number;
  thread_id: number;
  message_id: string | null;
  subject: string;
  from_name: string | null;
  from_addr: string | null;
  addresses: string;
  date: number;
  size: number | null;
  seen: number;
  flagged: number;
  answered: number;
  draft: number;
  forwarded: number;
  keywords: string;
  attachments: number;
  snippet: string | null;
  text_part: string | null;
}

export interface Address {
  name?: string;
  address: string;
}

export interface Addresses {
  from: Address[];
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
}

export type SpecialUse = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive";

const SPECIAL_FLAGS: Record<string, SpecialUse> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Junk": "junk",
  "\\Archive": "archive",
};

export function specialUseName(flag: string | null): SpecialUse | null {
  return flag ? (SPECIAL_FLAGS[flag] ?? null) : null;
}

export function getMailboxes(accountId: number): MailboxRow[] {
  return db().all<MailboxRow>("SELECT * FROM mailboxes WHERE account_id = ? ORDER BY path", accountId);
}

export function getMailbox(accountId: number, id: number): MailboxRow | undefined {
  return db().get<MailboxRow>("SELECT * FROM mailboxes WHERE account_id = ? AND id = ?", accountId, id);
}

export function getMailboxByPath(accountId: number, path: string): MailboxRow | undefined {
  return db().get<MailboxRow>("SELECT * FROM mailboxes WHERE account_id = ? AND path = ?", accountId, path);
}

export function specialMailboxes(accountId: number): Partial<Record<SpecialUse, MailboxRow>> {
  const out: Partial<Record<SpecialUse, MailboxRow>> = {};
  for (const mb of getMailboxes(accountId)) {
    const use = specialUseName(mb.special_use);
    if (use && !out[use]) out[use] = mb;
  }
  return out;
}

function addresses(list: MessageAddressObject[] | undefined): Address[] {
  return (list ?? [])
    .filter((a) => a.address)
    .map((a) => ({ address: a.address!.toLowerCase(), ...(a.name ? { name: a.name } : {}) }));
}

function headerDate(value: Date | string | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * When the message is "dated". The Date header is what the sender's clock said; the
 * internal date is when it arrived here. Header dates in the future relative to
 * arrival are spam's favourite trick for sticking to the top of the inbox, so those
 * fall back to arrival time.
 */
export function messageDate(header: number | null, internal: number | null): number {
  if (header && internal) return header > internal + 2 * 3600_000 ? internal : header;
  return header ?? internal ?? Date.now();
}

export interface FlagState {
  seen: number;
  flagged: number;
  answered: number;
  draft: number;
  forwarded: number;
  keywords: string;
}

export function flagState(flags: Set<string> | undefined): FlagState {
  const f = flags ?? new Set<string>();
  const lower = new Set([...f].map((x) => x.toLowerCase()));
  return {
    seen: lower.has("\\seen") ? 1 : 0,
    flagged: lower.has("\\flagged") ? 1 : 0,
    answered: lower.has("\\answered") ? 1 : 0,
    draft: lower.has("\\draft") ? 1 : 0,
    forwarded: lower.has("$forwarded") ? 1 : 0,
    keywords: packKeywords(f),
  };
}

function referencesFrom(headers: Buffer | undefined): string[] {
  if (!headers) return [];
  const text = headers.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  const match = text.match(/^references:\s*(.*)$/im);
  return parseMessageIds(match?.[1]);
}

/** Inserts (or replaces) a message fetched with envelope, flags, bodyStructure, internalDate, size, headers[references]. */
export function insertFetched(accountId: number, mailbox: MailboxRow, msg: FetchMessageObject): MessageRow {
  const env = msg.envelope ?? {};
  const messageId = normalizeMessageId(env.messageId);
  const inReplyTo = parseMessageIds(env.inReplyTo);
  const refs = referencesFrom(msg.headers);
  const addrs: Addresses = {
    from: addresses(env.from),
    to: addresses(env.to),
    cc: addresses(env.cc),
    bcc: addresses(env.bcc),
    replyTo: addresses(env.replyTo),
  };
  const subject = env.subject ?? "";
  const flags = flagState(msg.flags);
  const textPart = findTextPart(msg.bodyStructure);
  const date = messageDate(headerDate(env.date), headerDate(msg.internalDate as Date | string | undefined));

  return db().tx(() => {
    const threadId = assignThread(db(), accountId, { messageId, parents: [...inReplyTo, ...refs], subject });
    const row: MessageRow = {
      mailbox_id: mailbox.id,
      uid: msg.uid,
      account_id: accountId,
      thread_id: threadId,
      message_id: messageId,
      subject,
      from_name: addrs.from[0]?.name ?? null,
      from_addr: addrs.from[0]?.address ?? null,
      addresses: JSON.stringify(addrs),
      date,
      size: msg.size ?? null,
      ...flags,
      attachments: countAttachments(msg.bodyStructure),
      // No text part (an attachment-only message, say): there is nothing to preview.
      snippet: textPart ? null : "",
      text_part: textPart ? JSON.stringify(textPart) : null,
    };
    db().run(
      `INSERT OR REPLACE INTO messages (mailbox_id, uid, account_id, thread_id, message_id, subject, from_name, from_addr,
         addresses, date, size, seen, flagged, answered, draft, forwarded, keywords, attachments, snippet, text_part)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.mailbox_id, row.uid, row.account_id, row.thread_id, row.message_id, row.subject, row.from_name, row.from_addr,
      row.addresses, row.date, row.size, row.seen, row.flagged, row.answered, row.draft, row.forwarded, row.keywords,
      row.attachments, row.snippet, row.text_part,
    );
    recordContacts(accountId, mailbox, addrs, date);
    discoverLabels(accountId, row.keywords);
    return row;
  });
}

function recordContacts(accountId: number, mailbox: MailboxRow, addrs: Addresses, date: number) {
  const use = specialUseName(mailbox.special_use);
  if (use === "junk" || use === "trash" || use === "drafts") return;
  const upsert = (a: Address, column: "sent" | "received") =>
    db().run(
      `INSERT INTO contacts (account_id, address, name, ${column}, last_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (account_id, address) DO UPDATE SET
         ${column} = ${column} + 1,
         name = COALESCE(excluded.name, contacts.name),
         last_at = MAX(contacts.last_at, excluded.last_at)`,
      accountId, a.address, a.name ?? null, date,
    );
  if (use === "sent") for (const a of [...addrs.to, ...addrs.cc, ...addrs.bcc]) upsert(a, "sent");
  else for (const a of addrs.from) upsert(a, "received");
}

/** Keywords set by another client become labels here too. */
function discoverLabels(accountId: number, packed: string) {
  for (const kw of unpackKeywords(packed)) {
    if (isSystemKeyword(kw)) continue;
    db().run(
      "INSERT OR IGNORE INTO labels (account_id, keyword, name, created_at) VALUES (?, ?, ?, ?)",
      accountId, kw, keywordToLabel(kw), Date.now(),
    );
  }
}

export function updateFlags(accountId: number, mailboxId: number, uid: number, flags: Set<string>) {
  const f = flagState(flags);
  if (f.keywords !== " ") discoverLabels(accountId, f.keywords);
  db().run(
    `UPDATE messages SET seen = ?, flagged = ?, answered = ?, draft = ?, forwarded = ?, keywords = ?
     WHERE mailbox_id = ? AND uid = ?`,
    f.seen, f.flagged, f.answered, f.draft, f.forwarded, f.keywords, mailboxId, uid,
  );
}

export function deleteMessages(mailboxId: number, uids: number[]) {
  if (!uids.length) return;
  db().tx(() => {
    for (let i = 0; i < uids.length; i += 500) {
      const chunk = uids.slice(i, i + 500);
      db().run(`DELETE FROM messages WHERE mailbox_id = ? AND uid IN (${placeholders(chunk.length)})`, mailboxId, ...chunk);
    }
  });
}

/** Moves rows to another mailbox after a MOVE whose COPYUID told us the new UIDs. */
export function moveRows(fromId: number, toId: number, uidMap: Map<number, number>) {
  db().tx(() => {
    for (const [from, to] of uidMap) {
      db().run("DELETE FROM messages WHERE mailbox_id = ? AND uid = ?", toId, to);
      db().run("UPDATE messages SET mailbox_id = ?, uid = ? WHERE mailbox_id = ? AND uid = ?", toId, to, fromId, from);
    }
  });
}

export function resetMailbox(mailboxId: number) {
  db().tx(() => {
    db().run("DELETE FROM messages WHERE mailbox_id = ?", mailboxId);
    db().run(
      `UPDATE mailboxes SET synced_uidnext = 0, synced_modseq = NULL, backfill_uid = NULL, backfill_done = 0, uidvalidity = NULL
       WHERE id = ?`,
      mailboxId,
    );
  });
}
