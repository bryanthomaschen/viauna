// Conversations, the way Gmail groups them: messages join a thread through
// Message-ID / In-Reply-To / References, across folders (so your reply in Sent sits
// under the message it answers in the Inbox), but a reply that changes the subject
// starts a new conversation instead of being glued onto an old one.
import { type Database, placeholders } from "../db.ts";

const PREFIX = /^\s*((re|fw|fwd|aw|sv|vs|antw|wg|tr|rif|r|enc|odp|res|ynt|atb|vb)(\s*\[\d+\]|\s*\(\d+\))?\s*[:：]|\[[^\]]{1,60}\])\s*/i;

/** Subject with reply/forward prefixes and [list] tags removed, lowercased. */
export function subjectKey(subject: string | null | undefined): string {
  let s = (subject ?? "").trim();
  for (let i = 0; i < 10; i++) {
    const next = s.replace(PREFIX, "");
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Every <message-id> in a References / In-Reply-To header value. */
export function parseMessageIds(value: string | null | undefined): string[] {
  if (!value) return [];
  const ids = value.match(/<[^<>\s]+>/g);
  if (ids) return ids.map((id) => id.toLowerCase());
  // A bare id without angle brackets (seen from some broken mailers).
  const bare = value.trim();
  return bare && !/\s/.test(bare) ? [`<${bare.toLowerCase()}>`] : [];
}

export function normalizeMessageId(value: string | null | undefined): string | null {
  return parseMessageIds(value)[0] ?? null;
}

export interface ThreadInput {
  messageId: string | null;
  /** Sender address: a "copy" must come from the same sender, or a stranger could
   * reuse the Message-ID of a message you sent to graft theirs onto your thread. */
  from?: string | null;
  /** In-Reply-To first, then References (any order is fine). */
  parents: string[];
  subject: string;
}

function compatible(a: string, b: string): boolean {
  return a === b || a === "" || b === "";
}

/**
 * Returns the thread id for a new message, creating or merging threads as needed.
 * Must run inside a transaction alongside the message insert.
 */
export function assignThread(db: Database, accountId: number, input: ThreadInput): number {
  const key = subjectKey(input.subject);
  const ids = [...new Set([input.messageId, ...input.parents].filter((x): x is string => !!x))];

  let chosen: number | null = null;
  const toMerge = new Set<number>();

  if (ids.length) {
    const rows = db.all<{ message_id: string; thread_id: number; subject_key: string }>(
      `SELECT r.message_id, r.thread_id, t.subject_key FROM thread_refs r JOIN threads t ON t.id = r.thread_id
       WHERE r.account_id = ? AND r.message_id IN (${placeholders(ids.length)})`,
      accountId,
      ...ids,
    );
    // A copy of a message we already hold (same Message-ID in another folder) always
    // belongs to that message's thread, whatever its subject. An id that is only a
    // placeholder claimed by a reply is an ordinary candidate.
    if (input.messageId) {
      const copy = db.get<{ thread_id: number }>(
        "SELECT thread_id FROM messages WHERE account_id = ? AND message_id = ? AND COALESCE(from_addr, '') = ? LIMIT 1",
        accountId,
        input.messageId,
        input.from ?? "",
      );
      if (copy) chosen = copy.thread_id;
    }
    for (const r of rows) {
      if (r.thread_id === chosen) continue;
      if (!compatible(r.subject_key, key)) continue;
      if (chosen === null) chosen = r.thread_id;
      else toMerge.add(r.thread_id);
    }
  }

  if (chosen === null) {
    const res = db.run("INSERT INTO threads (account_id, subject_key) VALUES (?, ?)", accountId, key);
    chosen = Number(res.lastInsertRowid);
  }

  for (const other of toMerge) {
    // Keep the lower id; it is the older conversation.
    const current: number = chosen;
    const [keep, drop] = other < current ? [other, current] : [current, other];
    db.run("UPDATE messages SET thread_id = ? WHERE account_id = ? AND thread_id = ?", keep, accountId, drop);
    db.run("UPDATE thread_refs SET thread_id = ? WHERE account_id = ? AND thread_id = ?", keep, accountId, drop);
    db.run("DELETE FROM threads WHERE id = ?", drop);
    chosen = keep;
  }

  // Record this message's id, and claim referenced ids nobody has claimed yet, so a
  // parent that arrives later finds us. Ids already owned by another (subject-
  // incompatible) thread keep their owner.
  for (const id of ids) {
    db.run("INSERT OR IGNORE INTO thread_refs (account_id, message_id, thread_id) VALUES (?, ?, ?)", accountId, id, chosen);
  }
  // Take over this id's mapping only from a placeholder; an id that a real message
  // already carries stays with that message's thread.
  if (input.messageId && !db.get("SELECT 1 FROM messages WHERE account_id = ? AND message_id = ? LIMIT 1", accountId, input.messageId)) {
    db.run("UPDATE thread_refs SET thread_id = ? WHERE account_id = ? AND message_id = ?", chosen, accountId, input.messageId);
  }
  return chosen;
}
