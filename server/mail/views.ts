// Conversation lists, computed from the local index. A conversation appears in a view
// when any of its messages matches (Inbox: a message in INBOX; Starred: a flagged
// message anywhere; a label: a message carrying the keyword), and is shown with all
// its messages from every folder except Trash and Spam — the way Gmail does it.
import { db, placeholders } from "../db.ts";
import { type Addresses, type MailboxRow, type MessageRow, getMailbox, specialMailboxes, specialUseName } from "../imap/store.ts";
import { isSystemKeyword, unpackKeywords } from "./keywords.ts";

export type View =
  | { kind: "mailbox"; mailboxId: number }
  | { kind: "starred" }
  | { kind: "all" }
  | { kind: "label"; keyword: string }
  /** Search results. `includeHidden` when the search itself covered Trash/Spam. */
  | { kind: "threads"; ids: number[]; includeHidden?: boolean };

const SPECIAL_VIEWS = { inbox: "inbox", sent: "sent", drafts: "drafts", spam: "junk", trash: "trash", archive: "archive" } as const;

/** "inbox", "starred", "folder:12", "label:work" … → View. */
export function parseView(accountId: number, view: string): View | null {
  if (view === "starred") return { kind: "starred" };
  if (view === "all") return { kind: "all" };
  if (view.startsWith("label:")) {
    const keyword = view.slice(6).toLowerCase();
    return keyword ? { kind: "label", keyword } : null;
  }
  if (view.startsWith("folder:")) {
    const mb = getMailbox(accountId, Number(view.slice(7)));
    return mb ? { kind: "mailbox", mailboxId: mb.id } : null;
  }
  const use = SPECIAL_VIEWS[view as keyof typeof SPECIAL_VIEWS];
  if (use) {
    const mb = specialMailboxes(accountId)[use];
    // A server without that folder (no Archive, say): an empty view rather than an error.
    return { kind: "mailbox", mailboxId: mb?.id ?? -1 };
  }
  return null;
}

/** Trash and Spam are hidden from conversations, unless you are looking at them. */
function hiddenMailboxes(accountId: number, view: View): { hidden: number[]; only: number | null } {
  if (view.kind === "threads" && view.includeHidden) return { hidden: [], only: null };
  const special = specialMailboxes(accountId);
  const hidden = [special.trash?.id, special.junk?.id].filter((x): x is number => x !== undefined);
  if (view.kind === "mailbox" && hidden.includes(view.mailboxId)) return { hidden: [], only: view.mailboxId };
  return { hidden, only: null };
}

function viewFilter(accountId: number, view: View, hidden: number[]): { sql: string; params: (number | string)[] } {
  const notHidden = hidden.length ? `AND mailbox_id NOT IN (${placeholders(hidden.length)})` : "";
  switch (view.kind) {
    case "mailbox":
      return { sql: "SELECT thread_id FROM messages WHERE mailbox_id = ?", params: [view.mailboxId] };
    case "starred":
      return { sql: `SELECT thread_id FROM messages WHERE account_id = ? AND flagged = 1 ${notHidden}`, params: [accountId, ...hidden] };
    case "label":
      return {
        sql: `SELECT thread_id FROM messages WHERE account_id = ? AND instr(keywords, ?) > 0 ${notHidden}`,
        params: [accountId, ` ${view.keyword} `, ...hidden],
      };
    case "all":
      return { sql: `SELECT thread_id FROM messages WHERE account_id = ? ${notHidden}`, params: [accountId, ...hidden] };
    case "threads":
      return { sql: `SELECT value AS thread_id FROM json_each(?)`, params: [JSON.stringify(view.ids)] };
  }
}

export interface Participant {
  name: string;
  address: string;
  me: boolean;
  unread: boolean;
}

export interface ThreadSummary {
  id: number;
  subject: string;
  snippet: string;
  date: number;
  unread: boolean;
  starred: boolean;
  count: number;
  /** Senders in conversation order, one entry per distinct sender (first appearance). */
  participants: Participant[];
  /** For Sent: who the latest message from me went to. */
  recipients: string[];
  labels: string[];
  attachments: boolean;
  drafts: number;
  mailboxIds: number[];
}

function displayName(a: { name?: string; address: string } | undefined): string {
  if (!a) return "";
  return a.name?.trim() || a.address.split("@")[0];
}

/** One message per Message-ID: a copy in Archive and Inbox is still one message. */
export function dedupe<T extends Pick<MessageRow, "message_id" | "mailbox_id">>(rows: T[], prefer?: (a: T, b: T) => boolean): T[] {
  const seen = new Map<string, number>();
  const out: T[] = [];
  for (const row of rows) {
    if (!row.message_id) {
      out.push(row);
      continue;
    }
    const at = seen.get(row.message_id);
    if (at === undefined) {
      seen.set(row.message_id, out.length);
      out.push(row);
    } else if (prefer?.(row, out[at])) {
      out[at] = row;
    }
  }
  return out;
}

const REPLY_PREFIX = /^\s*(re|fw|fwd|aw|sv|wg|tr)\s*(\[\d+\])?\s*:/i;

/** Date order; within the same second (Date headers have no finer resolution) the original before its replies. */
function chronological(a: MessageRow, b: MessageRow): number {
  return a.date - b.date || Number(REPLY_PREFIX.test(a.subject)) - Number(REPLY_PREFIX.test(b.subject)) || a.uid - b.uid;
}

export function threadMessages(accountId: number, threadIds: number[], view: View): MessageRow[] {
  if (!threadIds.length) return [];
  const { hidden, only } = hiddenMailboxes(accountId, view);
  const scope = only !== null
    ? "AND mailbox_id = ?"
    : hidden.length ? `AND mailbox_id NOT IN (${placeholders(hidden.length)})` : "";
  const scopeParams = only !== null ? [only] : hidden;
  return db()
    .all<MessageRow>(
      `SELECT * FROM messages WHERE account_id = ? AND thread_id IN (${placeholders(threadIds.length)}) ${scope}`,
      accountId,
      ...threadIds,
      ...scopeParams,
    )
    .sort(chronological);
}

export function listThreads(
  accountId: number,
  view: View,
  page: number,
  size: number,
  me: Set<string>,
): { threads: ThreadSummary[]; total: number } {
  const { hidden, only } = hiddenMailboxes(accountId, view);
  const filter = viewFilter(accountId, view, hidden);
  const scope = only !== null
    ? "AND m.mailbox_id = ?"
    : hidden.length ? `AND m.mailbox_id NOT IN (${placeholders(hidden.length)})` : "";
  const scopeParams = only !== null ? [only] : hidden;

  const total = db().get<{ n: number }>(`SELECT COUNT(DISTINCT thread_id) AS n FROM (${filter.sql})`, ...filter.params)!.n;
  const page_ = db().all<{ id: number; latest: number }>(
    `SELECT m.thread_id AS id, MAX(m.date) AS latest FROM messages m
     WHERE m.account_id = ? AND m.thread_id IN (${filter.sql}) ${scope}
     GROUP BY m.thread_id ORDER BY latest DESC LIMIT ? OFFSET ?`,
    accountId,
    ...filter.params,
    ...scopeParams,
    size,
    page * size,
  );
  return { threads: summarize(accountId, page_.map((r) => r.id), view, me), total };
}

export function summarize(accountId: number, ids: number[], view: View, me: Set<string>): ThreadSummary[] {
  const rows = threadMessages(accountId, ids, view);
  const byThread = new Map<number, MessageRow[]>();
  for (const r of rows) {
    const list = byThread.get(r.thread_id) ?? [];
    list.push(r);
    byThread.set(r.thread_id, list);
  }
  const special = specialMailboxes(accountId);
  const draftsId = special.drafts?.id;
  const out: ThreadSummary[] = [];
  for (const id of ids) {
    const all = byThread.get(id);
    if (!all?.length) continue;
    const msgs = dedupe(all);
    const participants: Participant[] = [];
    let unread = false;
    let starred = false;
    let attachments = false;
    let drafts = 0;
    const labels = new Set<string>();
    const mailboxIds = new Set<number>();
    let recipients: string[] = [];
    for (const m of msgs) {
      const addrs = JSON.parse(m.addresses) as Addresses;
      const from = addrs.from[0];
      const mine = !!from && me.has(from.address);
      const isDraft = !!m.draft || m.mailbox_id === draftsId;
      if (isDraft) drafts++;
      const msgUnread = !m.seen && !isDraft && !mine;
      unread ||= msgUnread;
      starred ||= !!m.flagged;
      attachments ||= m.attachments > 0;
      for (const kw of unpackKeywords(m.keywords)) if (!isSystemKeyword(kw)) labels.add(kw);
      mailboxIds.add(m.mailbox_id);
      if (mine) recipients = [...addrs.to, ...addrs.cc].map(displayName);
      if (isDraft || !from) continue;
      const existing = participants.find((p) => p.address === from.address);
      if (existing) {
        existing.unread ||= msgUnread;
      } else {
        participants.push({ name: mine ? "me" : displayName(from), address: from.address, me: mine, unread: msgUnread });
      }
    }
    // Copies outside the scope still tell us where the conversation lives (for the
    // "Inbox" chip in search results), so list them from the full row set.
    const latest = msgs[msgs.length - 1];
    out.push({
      id,
      subject: msgs[0].subject,
      snippet: latest.snippet ?? "",
      date: latest.date,
      unread,
      starred,
      count: msgs.length,
      participants,
      recipients,
      labels: [...labels],
      attachments,
      drafts,
      mailboxIds: [...mailboxIds],
    });
  }
  return out;
}

export interface MessageMeta {
  mailboxId: number;
  uid: number;
  messageId: string | null;
  subject: string;
  date: number;
  from: Addresses["from"];
  to: Addresses["to"];
  cc: Addresses["cc"];
  bcc: Addresses["bcc"];
  replyTo: Addresses["replyTo"];
  snippet: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  labels: string[];
  attachments: number;
  size: number | null;
  /** Every folder holding a copy, e.g. [Inbox, Archive]. */
  mailboxIds: number[];
}

export function conversation(accountId: number, threadId: number, view: View): { subject: string; messages: MessageMeta[]; labels: string[] } | null {
  const rows = threadMessages(accountId, [threadId], view);
  if (!rows.length) return null;
  const copies = new Map<string, Set<number>>();
  for (const r of rows) {
    if (!r.message_id) continue;
    const set = copies.get(r.message_id) ?? new Set();
    set.add(r.mailbox_id);
    copies.set(r.message_id, set);
  }
  const mailboxes = new Map<number, MailboxRow>();
  for (const id of new Set(rows.map((r) => r.mailbox_id))) {
    const mb = getMailbox(accountId, id);
    if (mb) mailboxes.set(id, mb);
  }
  // Prefer the Inbox copy (actions on it are what the user means), then anything but Sent.
  const rank = (r: MessageRow) => {
    const use = specialUseName(mailboxes.get(r.mailbox_id)?.special_use ?? null);
    return use === "inbox" ? 0 : use === "sent" ? 2 : 1;
  };
  const msgs = dedupe(rows, (a, b) => rank(a) < rank(b));
  const labels = new Set<string>();
  const messages = msgs.map((m): MessageMeta => {
    const addrs = JSON.parse(m.addresses) as Addresses;
    const kws = unpackKeywords(m.keywords).filter((k) => !isSystemKeyword(k));
    kws.forEach((k) => labels.add(k));
    return {
      mailboxId: m.mailbox_id,
      uid: m.uid,
      messageId: m.message_id,
      subject: m.subject,
      date: m.date,
      ...addrs,
      snippet: m.snippet ?? "",
      seen: !!m.seen,
      flagged: !!m.flagged,
      answered: !!m.answered,
      draft: !!m.draft,
      labels: kws,
      attachments: m.attachments,
      size: m.size,
      mailboxIds: m.message_id ? [...(copies.get(m.message_id) ?? [m.mailbox_id])] : [m.mailbox_id],
    };
  });
  return { subject: msgs[0].subject, messages, labels: [...labels] };
}
