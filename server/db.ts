// SQLite, via the driver built into Node (no native module to compile). One file holds
// sessions, accounts and the per-account mail index; the index is a cache of the IMAP
// server and can always be rebuilt from it, so losing it costs a resync, never mail.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config } from "./config.ts";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    login TEXT NOT NULL,
    email TEXT NOT NULL,
    imap TEXT NOT NULL,            -- JSON Endpoint
    smtp TEXT NOT NULL,            -- JSON Endpoint
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    UNIQUE (login, imap)
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,           -- sha256 of the cookie's session id; the id itself is never stored
    created_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT,
    ip TEXT
  );

  CREATE TABLE session_accounts (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    credential BLOB NOT NULL,      -- AES-256-GCM, keyed from the cookie (see crypto.ts)
    PRIMARY KEY (session_id, account_id)
  );

  CREATE TABLE mailboxes (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    delimiter TEXT,
    parent_path TEXT,
    special_use TEXT,
    subscribed INTEGER NOT NULL DEFAULT 1,
    selectable INTEGER NOT NULL DEFAULT 1,
    -- What the server last reported (STATUS / SELECT).
    uidvalidity TEXT,
    uidnext INTEGER,
    highestmodseq TEXT,
    total INTEGER,
    unseen INTEGER,
    keywords_allowed INTEGER,      -- PERMANENTFLAGS includes \\*
    -- How far the local index has caught up.
    synced_uidnext INTEGER NOT NULL DEFAULT 0,
    synced_modseq TEXT,
    backfill_uid INTEGER,          -- lowest UID indexed; older ones are still to fetch
    backfill_done INTEGER NOT NULL DEFAULT 0,
    UNIQUE (account_id, path)
  );

  CREATE TABLE threads (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    subject_key TEXT NOT NULL
  );

  CREATE TABLE messages (
    mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
    uid INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    thread_id INTEGER NOT NULL,
    message_id TEXT,
    subject TEXT NOT NULL DEFAULT '',
    from_name TEXT,
    from_addr TEXT,
    addresses TEXT NOT NULL,       -- JSON { from, to, cc, bcc, replyTo }
    date INTEGER NOT NULL,         -- ms since epoch
    size INTEGER,
    seen INTEGER NOT NULL DEFAULT 0,
    flagged INTEGER NOT NULL DEFAULT 0,
    answered INTEGER NOT NULL DEFAULT 0,
    draft INTEGER NOT NULL DEFAULT 0,
    forwarded INTEGER NOT NULL DEFAULT 0,
    keywords TEXT NOT NULL DEFAULT ' ',  -- ' kw1 kw2 ', lowercased, for LIKE '% kw %'
    attachments INTEGER NOT NULL DEFAULT 0,
    snippet TEXT,
    text_part TEXT,                -- JSON { part, type, charset, encoding } used for the snippet
    PRIMARY KEY (mailbox_id, uid)
  ) WITHOUT ROWID;
  CREATE INDEX messages_thread ON messages (account_id, thread_id);
  CREATE INDEX messages_mailbox_date ON messages (mailbox_id, date DESC);
  CREATE INDEX messages_message_id ON messages (account_id, message_id);
  CREATE INDEX messages_snippet_todo ON messages (mailbox_id, date DESC) WHERE snippet IS NULL;

  -- Message-ID -> thread, including ids we have only seen referenced, so a parent that
  -- arrives after its reply still joins the same conversation.
  CREATE TABLE thread_refs (
    account_id INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    thread_id INTEGER NOT NULL,
    PRIMARY KEY (account_id, message_id)
  ) WITHOUT ROWID;
  CREATE INDEX thread_refs_thread ON thread_refs (account_id, thread_id);

  CREATE TABLE contacts (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    name TEXT,
    sent INTEGER NOT NULL DEFAULT 0,      -- times this account wrote to them
    received INTEGER NOT NULL DEFAULT 0,  -- times they wrote to this account
    last_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, address)
  ) WITHOUT ROWID;

  CREATE TABLE labels (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    keyword TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, keyword)
  ) WITHOUT ROWID;

  CREATE TABLE trusted_senders (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    PRIMARY KEY (account_id, address)
  ) WITHOUT ROWID;
  `,
];

export type Row = Record<string, SQLInputValue>;

export class Database {
  readonly raw: DatabaseSync;
  private statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  private depth = 0;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate() {
    const { user_version } = this.raw.prepare("PRAGMA user_version").get() as { user_version: number };
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  private stmt(sql: string) {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  run(sql: string, ...params: SQLInputValue[]) {
    return this.stmt(sql).run(...params);
  }

  /** Runs fn in a transaction; nested calls join the outer one. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    } finally {
      this.depth--;
    }
  }
}

let instance: Database | null = null;

export function db(): Database {
  if (!instance) instance = new Database(path.join(config.dataDir, "wren.db"));
  return instance;
}

/** For tests: point the module at a fresh database. */
export function setDatabase(next: Database) {
  instance = next;
}

/** `IN (?, ?, ?)` placeholder list for n values. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}
