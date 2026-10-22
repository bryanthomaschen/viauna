// One AccountRuntime per signed-in mailbox, shared by every session of that account.
// It owns three IMAP connections:
//
//   fg    user-initiated work (open a message, move, flag, search) — never queued
//         behind background sync, so clicks stay fast;
//   bg    the sync loop: folder list, new mail, flag changes, backfill, snippets;
//   idle  sits in IDLE on INBOX so new mail shows up within a second.
//
// Runtimes start when a session uses the account and stop after a few idle minutes;
// the local index persists, so the next start only fetches what changed.
import { EventEmitter } from "node:events";
import type { FetchMessageObject, ImapFlow, ListResponse, MailboxObject } from "imapflow";
import type { Endpoint } from "../config.ts";
import { type Credentials, credentialFingerprint } from "../crypto.ts";
import { db, placeholders } from "../db.ts";
import { log } from "../log.ts";
import { buildSnippet } from "../mail/snippet.ts";
import { type TextPart, hasCalendarPart } from "../mail/structure.ts";
import { Connection, resolvedOptions } from "./connection.ts";
import {
  type MailboxRow,
  deleteMessages,
  getMailboxByPath,
  getMailboxes,
  insertFetched,
  resetMailbox,
  specialUseName,
  updateFlags,
} from "./store.ts";

export interface AccountInfo {
  id: number;
  login: string;
  email: string;
  imap: Endpoint;
  smtp: Endpoint;
}

export interface ChangeEvent {
  accountId: number;
  mailboxIds: number[];
  /** Newly arrived INBOX messages, for desktop notifications. */
  arrived?: { threadId: number; from: string; subject: string }[];
}

const FIRST_BATCH = 300;
const BACKFILL_BATCH = 500;
const SNIPPET_BATCH = 60;
const POLL_MS = 60_000;
const ENVELOPE_QUERY = {
  uid: true,
  flags: true,
  envelope: true,
  bodyStructure: true,
  internalDate: true,
  size: true,
  headers: ["references"],
} as const;

type Task = "list" | "snippets" | "backfill" | `sync:${number}`;

function priority(task: Task, inboxId: number | undefined): number {
  if (task === "list") return 0;
  if (task === `sync:${inboxId}`) return 1;
  if (task.startsWith("sync:")) return 2;
  if (task === "snippets") return 3;
  return 4;
}

/** Order folders are first synced in: what the user looks at first. */
function syncOrder(mb: MailboxRow): number {
  switch (specialUseName(mb.special_use)) {
    case "inbox": return 0;
    case "sent": return 1;
    case "drafts": return 2;
    case "archive": return 3;
    case "junk": return 5;
    case "trash": return 6;
    default: return 4;
  }
}

/** A NO/BAD answer about particular messages, as opposed to a dead connection. */
function isServerRefusal(err: unknown): boolean {
  const e = err as { responseStatus?: string; serverResponseCode?: string };
  return e?.responseStatus === "NO" || e?.responseStatus === "BAD" || !!e?.serverResponseCode;
}

export function syncable(mb: MailboxRow): boolean {
  return !!mb.selectable && (!!mb.subscribed || !!mb.special_use);
}

export class AccountRuntime extends EventEmitter {
  readonly fg: Connection;
  readonly bg: Connection;
  readonly idle: Connection;
  readonly fingerprint: string;
  lastUsed = Date.now();
  /** When this runtime's own password was last proven by a fresh login. */
  verifiedAt = Date.now();
  subscribers = 0;
  authFailed = false;
  lastError: string | null = null;

  private active = false;
  private queue = new Set<Task>();
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private idleReconnect: NodeJS.Timeout | null = null;
  private idleSyncTimer: NodeJS.Timeout | null = null;
  /** UIDs below backfill_uid still to index, per mailbox (computed once per start). */
  private pending = new Map<number, number[]>();
  /** Consecutive failures per task, for that task's own backoff. */
  private failures = new Map<Task, number>();
  private retryTimers = new Map<Task, NodeJS.Timeout>();
  private pendingChanges = new Set<number>();
  private pendingArrivals: NonNullable<ChangeEvent["arrived"]> = [];
  private emitTimer: NodeJS.Timeout | null = null;

  readonly account: AccountInfo;
  private creds: Credentials;

  constructor(account: AccountInfo, creds: Credentials) {
    super();
    this.account = account;
    this.creds = creds;
    this.setMaxListeners(100);
    this.fingerprint = credentialFingerprint(creds);
    const options = (extra = {}) => () => resolvedOptions(account.imap, this.creds, extra);
    this.fg = new Connection(`${account.id}/fg`, options({ disableAutoIdle: true }));
    this.bg = new Connection(`${account.id}/bg`, options({ disableAutoIdle: true }));
    this.idle = new Connection(`${account.id}/idle`, options({ qresync: true, maxIdleTime: 5 * 60_000, autoIdleDelay: 500 }));
    for (const conn of [this.fg, this.bg, this.idle]) {
      conn.onAuthFailure = () => {
        this.authFailed = true;
        this.emit("auth-failed");
      };
    }
  }

  get credentials(): Credentials {
    return this.creds;
  }

  touch() {
    this.lastUsed = Date.now();
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.schedule("list");
    this.startIdle();
    this.pollTimer = setInterval(() => this.schedule("list"), POLL_MS);
  }

  async stop() {
    this.active = false;
    for (const t of [this.pollTimer, this.idleReconnect, this.idleSyncTimer, this.emitTimer, ...this.retryTimers.values()]) {
      if (t) clearTimeout(t);
    }
    this.retryTimers.clear();
    this.pollTimer = null;
    this.emit("stopped");
    await Promise.all([this.fg.close(), this.bg.close(), this.idle.close()]);
  }

  /** Runs fn with `path` selected on the foreground connection. */
  async withMailbox<T>(path: string, fn: (client: ImapFlow, box: MailboxObject) => Promise<T>, readOnly = false): Promise<T> {
    this.touch();
    const client = await this.fg.get();
    const lock = await client.getMailboxLock(path, { readOnly });
    try {
      return await fn(client, client.mailbox as MailboxObject);
    } finally {
      lock.release();
    }
  }

  /** Records that local rows changed; listeners hear about it once per tick. */
  notify(mailboxIds: number[], arrived?: ChangeEvent["arrived"]) {
    for (const id of mailboxIds) this.pendingChanges.add(id);
    if (arrived) this.pendingArrivals.push(...arrived);
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      const event: ChangeEvent = { accountId: this.account.id, mailboxIds: [...this.pendingChanges] };
      if (this.pendingArrivals.length) event.arrived = this.pendingArrivals;
      this.pendingChanges = new Set();
      this.pendingArrivals = [];
      this.emit("change", event);
    }, 150);
  }

  schedule(task: Task) {
    if (!this.active) return;
    this.queue.add(task);
    void this.drain();
  }

  syncMailboxSoon(mailboxId: number) {
    this.schedule(`sync:${mailboxId}`);
  }

  // ---------------------------------------------------------------- task loop

  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.active && this.queue.size && !this.authFailed) {
        const inboxId = getMailboxByPath(this.account.id, "INBOX")?.id;
        const task = [...this.queue].sort((a, b) => priority(a, inboxId) - priority(b, inboxId))[0];
        this.queue.delete(task);
        try {
          await this.run(task);
          this.failures.delete(task);
          if (task === "list") this.lastError = null;
        } catch (err) {
          // Each task backs off on its own, so one that keeps failing can neither
          // spin nor be reset by another task's success.
          const n = (this.failures.get(task) ?? 0) + 1;
          this.failures.set(task, n);
          this.lastError = (err as Error).message;
          log.warn("sync task failed", { account: this.account.id, task, attempt: n, error: this.lastError });
          const delay = Math.min(10 * 60_000, 2000 * 2 ** Math.min(n, 9));
          clearTimeout(this.retryTimers.get(task));
          this.retryTimers.set(task, setTimeout(() => { this.retryTimers.delete(task); this.schedule(task); }, delay));
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async run(task: Task) {
    if (task === "list") return this.refreshList();
    if (task === "snippets") return this.fillSnippets();
    if (task === "backfill") return this.backfill();
    const id = Number(task.slice(5));
    const mb = db().get<MailboxRow>("SELECT * FROM mailboxes WHERE id = ?", id);
    if (mb && syncable(mb)) await this.syncMailbox(mb);
  }

  // ---------------------------------------------------------------- folder list

  private async refreshList() {
    const client = await this.bg.get();
    const list = await client.list({
      statusQuery: { messages: true, uidNext: true, uidValidity: true, unseen: true, highestModseq: true },
    });
    const changed = this.storeList(list);
    for (const mb of changed.sort((a, b) => syncOrder(a) - syncOrder(b))) this.schedule(`sync:${mb.id}`);
    this.schedule("snippets");
    this.schedule("backfill");
  }

  /** Upserts the folder list; returns syncable folders whose status moved on. */
  private storeList(list: ListResponse[]): MailboxRow[] {
    const accountId = this.account.id;
    const changed: MailboxRow[] = [];
    let structural = false;
    db().tx(() => {
      const known = new Map(getMailboxes(accountId).map((m) => [m.path, m]));
      const seen = new Set<string>();
      for (const entry of list) {
        seen.add(entry.path);
        const special = entry.path.toUpperCase() === "INBOX" ? "\\Inbox" : (entry.specialUse ?? null);
        const selectable = entry.flags.has("\\Noselect") || entry.flags.has("\\NonExistent") ? 0 : 1;
        const s = entry.status;
        const prev = known.get(entry.path);
        if (!prev) structural = true;
        db().run(
          `INSERT INTO mailboxes (account_id, path, name, delimiter, parent_path, special_use, subscribed, selectable,
             uidvalidity, uidnext, highestmodseq, total, unseen)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, path) DO UPDATE SET
             name = excluded.name, delimiter = excluded.delimiter, parent_path = excluded.parent_path,
             special_use = excluded.special_use, subscribed = excluded.subscribed, selectable = excluded.selectable,
             uidnext = excluded.uidnext, highestmodseq = excluded.highestmodseq, total = excluded.total,
             unseen = excluded.unseen`,
          accountId, entry.path, entry.name, entry.delimiter ?? null, entry.parentPath || null, special,
          entry.subscribed ? 1 : 0, selectable,
          s?.uidValidity?.toString() ?? null, s?.uidNext ?? null, s?.highestModseq?.toString() ?? null,
          s?.messages ?? null, s?.unseen ?? null,
        );
        const row = getMailboxByPath(accountId, entry.path)!;
        if (!syncable(row)) continue;
        const moved =
          !prev ||
          row.synced_uidnext === 0 ||
          (s?.uidNext !== undefined && s.uidNext !== row.synced_uidnext) ||
          (s?.highestModseq !== undefined && s.highestModseq.toString() !== row.synced_modseq) ||
          (s?.uidValidity !== undefined && row.uidvalidity !== null && s.uidValidity.toString() !== row.uidvalidity) ||
          (s?.messages !== undefined && prev.total !== s.messages) ||
          (s?.highestModseq === undefined && s?.unseen !== undefined && prev.unseen !== s.unseen);
        if (moved) changed.push(row);
      }
      for (const [path, mb] of known) {
        if (!seen.has(path)) {
          structural = true;
          db().run("DELETE FROM mailboxes WHERE id = ?", mb.id);
        }
      }
    });
    if (structural) this.notify([]);
    return changed;
  }

  // ---------------------------------------------------------------- one folder

  /**
   * Selects `path` on the background connection, re-selecting if it is already open:
   * a connection that isn't idling hears nothing about new mail, so a selection it
   * kept from earlier carries a stale UIDNEXT. (Read-only, so CLOSE expunges nothing.)
   */
  private async freshLock(client: ImapFlow, path: string) {
    if (client.mailbox && (client.mailbox as MailboxObject).path === path) await client.mailboxClose();
    return client.getMailboxLock(path, { readOnly: true });
  }

  async syncMailbox(mb: MailboxRow) {
    const client = await this.bg.get();
    const lock = await this.freshLock(client, mb.path);
    let changed = false;
    const arrived: NonNullable<ChangeEvent["arrived"]> = [];
    // New mail in the Inbox with a calendar object: invitations, for invitations.ts to handle.
    const withCalendar: number[] = [];
    try {
      const box = client.mailbox as MailboxObject;
      let state = db().get<MailboxRow>("SELECT * FROM mailboxes WHERE id = ?", mb.id)!;
      const validity = box.uidValidity.toString();
      if (state.uidvalidity && state.uidvalidity !== validity) {
        // UIDVALIDITY changed: every UID we hold is meaningless now.
        resetMailbox(mb.id);
        this.pending.delete(mb.id);
        state = db().get<MailboxRow>("SELECT * FROM mailboxes WHERE id = ?", mb.id)!;
        changed = true;
      }
      const modseq = box.highestModseq?.toString() ?? null;
      const isInbox = specialUseName(mb.special_use) === "inbox";

      if (state.synced_uidnext === 0) {
        // First sync: index the newest messages now, the rest via backfill.
        const uids = await this.allUids(client, "1:*");
        const newest = uids.slice(-FIRST_BATCH);
        if (newest.length) await this.fetchInto(client, state, newest.join(","));
        this.pending.set(mb.id, uids.slice(0, uids.length - newest.length));
        db().run(
          "UPDATE mailboxes SET backfill_uid = ?, backfill_done = ? WHERE id = ?",
          newest[0] ?? box.uidNext,
          uids.length <= FIRST_BATCH ? 1 : 0,
          mb.id,
        );
        changed = changed || newest.length > 0;
      } else {
        const floor = state.backfill_uid ?? 1;
        // 1. New messages.
        if (box.uidNext > state.synced_uidnext) {
          const added = await this.fetchInto(client, state, `${state.synced_uidnext}:*`, state.synced_uidnext, isInbox ? withCalendar : undefined);
          if (added.length) changed = true;
          if (isInbox) {
            for (const row of added) {
              if (!row.seen) arrived.push({ threadId: row.thread_id, from: row.from_name || row.from_addr || "", subject: row.subject });
            }
          }
        }
        // 2. Flag changes made elsewhere.
        if (modseq && state.synced_modseq && modseq !== state.synced_modseq) {
          for await (const msg of client.fetch(`${floor}:*`, { uid: true, flags: true }, { uid: true, changedSince: BigInt(state.synced_modseq) })) {
            if (msg.uid < state.synced_uidnext) {
              updateFlags(this.account.id, mb.id, msg.uid, msg.flags ?? new Set());
              changed = true;
            }
          }
        } else if (!modseq) {
          // No CONDSTORE: re-read flags of what we hold.
          for await (const msg of client.fetch(`${floor}:*`, { uid: true, flags: true }, { uid: true })) {
            updateFlags(this.account.id, mb.id, msg.uid, msg.flags ?? new Set());
          }
          changed = true;
        }
        // 3. Expunged messages: compare the UID set we index against the server's.
        if (box.exists !== state.synced_total || modseq !== state.synced_modseq || !modseq) {
          const server = new Set(await this.allUids(client, `${floor}:*`, floor));
          const local = db().all<{ uid: number }>("SELECT uid FROM messages WHERE mailbox_id = ? AND uid >= ?", mb.id, floor);
          const gone = local.map((r) => r.uid).filter((uid) => !server.has(uid));
          if (gone.length) {
            deleteMessages(mb.id, gone);
            changed = true;
          }
        }
      }

      db().run(
        `UPDATE mailboxes SET uidvalidity = ?, uidnext = ?, highestmodseq = ?, total = ?,
           synced_uidnext = ?, synced_modseq = ?, synced_total = ? WHERE id = ?`,
        validity, box.uidNext, modseq, box.exists, box.uidNext, modseq, box.exists, mb.id,
      );
    } finally {
      lock.release();
    }
    await this.refreshUnseen(mb);
    if (changed) {
      this.notify([mb.id], arrived.length ? arrived : undefined);
      this.schedule("snippets");
    }
    if (withCalendar.length) this.emit("invitations", mb, withCalendar);
  }

  private async refreshUnseen(mb: MailboxRow) {
    try {
      const client = await this.bg.get();
      const status = await client.status(mb.path, { unseen: true, messages: true });
      if (status) db().run("UPDATE mailboxes SET unseen = ? WHERE id = ?", status.unseen ?? null, mb.id);
    } catch {
      // Counts refresh again on the next poll.
    }
  }

  /** UIDs in `range`, ascending. `min` drops the "N:*" quirk that returns the last message. */
  private async allUids(client: ImapFlow, range: string, min = 1): Promise<number[]> {
    const result = await client.search({ uid: range }, { uid: true });
    return (Array.isArray(result) ? result : []).filter((u) => u >= min).sort((a, b) => a - b);
  }

  /** Fetches and indexes messages; with `calendar`, notes there the ones that carry a calendar object. */
  private async fetchInto(client: ImapFlow, mb: MailboxRow, range: string, min = 1, calendar?: number[]) {
    const rows: ReturnType<typeof insertFetched>[] = [];
    const seen = new Set<number>();
    try {
      for await (const msg of client.fetch(range, ENVELOPE_QUERY as never, { uid: true })) {
        if ((msg as FetchMessageObject).uid < min) continue;
        seen.add(msg.uid);
        rows.push(insertFetched(this.account.id, mb, msg as FetchMessageObject));
        if (calendar && hasCalendarPart((msg as FetchMessageObject).bodyStructure)) calendar.push(msg.uid);
      }
    } catch (err) {
      if (!isServerRefusal(err)) throw err;
      // One message the server can't produce (a corrupt file, a broken MIME tree)
      // must not stall the folder: retry one by one and skip what still fails.
      const uids = /^[\d,]+$/.test(range) ? range.split(",").map(Number) : await this.allUids(client, range, min);
      for (const uid of uids) {
        if (seen.has(uid)) continue;
        try {
          for await (const msg of client.fetch(String(uid), ENVELOPE_QUERY as never, { uid: true })) {
            rows.push(insertFetched(this.account.id, mb, msg as FetchMessageObject));
          }
        } catch (inner) {
          if (!isServerRefusal(inner)) throw inner;
          log.warn("skipping a message the server can't fetch", { account: this.account.id, mailbox: mb.id, uid });
        }
      }
    }
    return rows;
  }

  // ---------------------------------------------------------------- backfill

  private async backfill() {
    const boxes = getMailboxes(this.account.id)
      .filter((m) => syncable(m) && !m.backfill_done && m.synced_uidnext > 0)
      .sort((a, b) => syncOrder(a) - syncOrder(b));
    const mb = boxes[0];
    if (!mb) return;
    const client = await this.bg.get();
    const lock = await client.getMailboxLock(mb.path, { readOnly: true });
    let done = false;
    try {
      let pending = this.pending.get(mb.id);
      if (!pending) {
        pending = mb.backfill_uid && mb.backfill_uid > 1 ? await this.allUids(client, `1:${mb.backfill_uid - 1}`) : [];
        pending = pending.filter((u) => u < (mb.backfill_uid ?? Infinity));
        this.pending.set(mb.id, pending);
      }
      const batch = pending.splice(Math.max(0, pending.length - BACKFILL_BATCH));
      if (batch.length) await this.fetchInto(client, mb, batch.join(","));
      done = pending.length === 0;
      db().run(
        "UPDATE mailboxes SET backfill_uid = ?, backfill_done = ? WHERE id = ?",
        batch[0] ?? mb.backfill_uid,
        done ? 1 : 0,
        mb.id,
      );
    } finally {
      lock.release();
    }
    this.notify([mb.id]);
    this.schedule("snippets");
    // Yield to anything more urgent, then carry on.
    if (!done || boxes.length > 1) this.schedule("backfill");
  }

  // ---------------------------------------------------------------- snippets

  private async fillSnippets() {
    const todo = db().all<{ mailbox_id: number; uid: number; text_part: string; path: string; special_use: string | null }>(
      `SELECT m.mailbox_id, m.uid, m.text_part, b.path, b.special_use FROM messages m JOIN mailboxes b ON b.id = m.mailbox_id
       WHERE m.account_id = ? AND m.snippet IS NULL AND m.text_part IS NOT NULL
       ORDER BY (b.special_use = '\\Inbox') DESC, m.date DESC LIMIT ?`,
      this.account.id,
      SNIPPET_BATCH,
    );
    if (!todo.length) return;
    const mailboxId = todo[0].mailbox_id;
    const rows = todo.filter((r) => r.mailbox_id === mailboxId);
    const byPart = new Map<string, { uid: number; part: TextPart }[]>();
    for (const r of rows) {
      const part = JSON.parse(r.text_part) as TextPart;
      const list = byPart.get(part.part) ?? [];
      list.push({ uid: r.uid, part });
      byPart.set(part.part, list);
    }
    const client = await this.bg.get();
    const lock = await client.getMailboxLock(rows[0].path, { readOnly: true });
    const done = new Set<number>();
    try {
      for (const [key, items] of byPart) {
        const parts = new Map(items.map((i) => [i.uid, i.part]));
        const query = { uid: true, bodyParts: [{ key, start: 0, maxLength: 3072 }] };
        const store = (msg: FetchMessageObject) => {
          const part = parts.get(msg.uid);
          if (!part) return;
          const [partKey, raw] = [...(msg.bodyParts ?? new Map<string, Buffer>())][0] ?? [];
          // A refused BINARY fetch still yields the message, just without the part:
          // leave it for the fallback below rather than recording an empty snippet.
          if (!raw) return;
          let snippet = "";
          try {
            snippet = buildSnippet(raw, part, !!msg.binaryParts?.has(partKey!));
          } catch {
            snippet = "";
          }
          db().run("UPDATE messages SET snippet = ? WHERE mailbox_id = ? AND uid = ?", snippet, mailboxId, msg.uid);
          done.add(msg.uid);
        };
        try {
          for await (const msg of client.fetch(items.map((i) => i.uid).join(","), query, { uid: true, binary: true })) store(msg);
        } catch (err) {
          if (!isServerRefusal(err)) throw err;
          // BINARY is refused for parts with an encoding the server doesn't know
          // (NO [UNKNOWN-CTE]); fetch those one at a time, undecoded. Whatever still
          // fails is left to the empty-snippet sweep below.
          for (const { uid } of items) {
            if (done.has(uid)) continue;
            try {
              for await (const msg of client.fetch(String(uid), query, { uid: true })) store(msg);
            } catch (inner) {
              if (!isServerRefusal(inner)) throw inner;
            }
          }
        }
      }
    } finally {
      lock.release();
    }
    // Anything the server didn't return (expunged meanwhile, broken structure) gets an
    // empty snippet so it isn't retried forever.
    const missing = rows.map((r) => r.uid).filter((u) => !done.has(u));
    if (missing.length) {
      db().run(
        `UPDATE messages SET snippet = '' WHERE mailbox_id = ? AND uid IN (${placeholders(missing.length)})`,
        mailboxId,
        ...missing,
      );
    }
    this.notify([mailboxId]);
    this.schedule("snippets");
  }

  // ---------------------------------------------------------------- IDLE

  private startIdle() {
    if (!this.active || this.authFailed) return;
    this.idle.onOpen = (client) => {
      const poke = () => {
        const inbox = getMailboxByPath(this.account.id, "INBOX");
        if (!inbox) return;
        // Coalesce bursts (a 50-message move arrives as 50 EXISTS updates).
        if (this.idleSyncTimer) clearTimeout(this.idleSyncTimer);
        this.idleSyncTimer = setTimeout(() => this.schedule(`sync:${inbox.id}`), 300);
      };
      client.on("exists", poke);
      client.on("expunge", poke);
      client.on("flags", poke);
    };
    this.idle.onClose = () => {
      if (!this.active) return;
      this.idleReconnect = setTimeout(() => this.startIdle(), 5000);
    };
    this.idle
      .get()
      .then((client) => client.mailboxOpen("INBOX", { readOnly: true }))
      .catch((err) => {
        log.debug("idle connection failed", { account: this.account.id, error: (err as Error).message });
        if (this.active && !this.authFailed) this.idleReconnect = setTimeout(() => this.startIdle(), 30_000);
      });
  }
}
