// The state store: what must survive, unlike the mail index (../db.ts), which is a
// cache of the IMAP server. Accounts, sessions, settings, label names and colours,
// trusted senders, the instance's own settings with a record of their changes, and each
// mailbox's address book and calendars. SQLite in DATA_DIR by default; PostgreSQL or MySQL/MariaDB
// when DATABASE_URL says so. One schema and one set of queries (Kysely) for all three.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Generated, type InsertQueryBuilder, Kysely, MysqlDialect, PostgresDialect, SqliteDialect } from "kysely";
import { Migrator } from "kysely/migration";
import { migrations } from "./migrations.ts";
import { nodeSqlite } from "./node-sqlite.ts";

export interface AccountTable {
  id: Generated<number>;
  login: string;
  email: string;
  imap: string;
  imap_hash: string;
  smtp: string;
  settings: string;
  created_at: number;
}

export interface SessionTable {
  id: string;
  created_at: number;
  seen_at: number;
  expires_at: number;
  user_agent: string | null;
  ip: string | null;
}

export interface SessionAccountTable {
  session_id: string;
  account_id: number;
  position: number;
  credential: Uint8Array;
}

export interface LabelTable {
  account_id: number;
  keyword: string;
  name: string;
  color: string | null;
  created_at: number;
}

export interface TrustedSenderTable {
  account_id: number;
  address: string;
}

export interface InstanceSettingTable {
  name: string;
  value: string;
  updated_at: number;
  updated_by: string;
}

export interface AdminLogTable {
  id: Generated<number>;
  at: number;
  actor: string;
  setting: string;
  old_value: string | null;
  new_value: string | null;
}

export interface ContactTable {
  id: Generated<number>;
  account_id: number;
  uid: string;
  name: string;
  sort_key: string;
  search: string;
  vcard: string;
  created_at: number;
  updated_at: number;
  /** In an address book on the CardDAV server: which, at what URL, with what ETag. */
  book_id: number | null;
  href: string | null;
  etag: string | null;
  /** 1: changed here, not yet sent to the server. */
  dirty: Generated<number>;
  /** While dirty: the card as last synced, for a three-way merge. */
  base: string | null;
}

export interface ContactBookTable {
  id: Generated<number>;
  account_id: number;
  url: string;
  url_hash: string;
  name: string;
  sync_token: string | null;
  synced_at: number | null;
  created_at: number;
}

export interface ContactDeletionTable {
  id: Generated<number>;
  account_id: number;
  book_id: number;
  href: string;
  etag: string | null;
}

export interface ContactEmailTable {
  contact_id: number;
  account_id: number;
  position: number;
  address: string;
}

export interface CalendarTable {
  id: Generated<number>;
  account_id: number;
  name: string;
  color: string;
  position: number;
  visible: Generated<number>;
  /** The account id, on the mailbox's own calendar; null on the others. */
  primary_of: number | null;
  created_at: number;
  updated_at: number;
}

export interface EventTable {
  id: Generated<number>;
  account_id: number;
  calendar_id: number;
  uid: string;
  title: string;
  search: string;
  /** The whole iCalendar object for this UID: the event, any changed occurrences, its time zones. */
  ics: string;
  /** UTC milliseconds; an all-day or floating event's are its local times read as UTC. */
  start_at: number;
  end_at: number;
  all_day: number;
  created_at: number;
  updated_at: number;
}

export interface StateSchema {
  accounts: AccountTable;
  sessions: SessionTable;
  session_accounts: SessionAccountTable;
  labels: LabelTable;
  trusted_senders: TrustedSenderTable;
  instance_settings: InstanceSettingTable;
  admin_log: AdminLogTable;
  contacts: ContactTable;
  contact_emails: ContactEmailTable;
  contact_books: ContactBookTable;
  contact_deletions: ContactDeletionTable;
  calendars: CalendarTable;
  events: EventTable;
}

/** In dependency order, for copying from one store to another. */
export const STATE_TABLES = [
  "accounts", "sessions", "session_accounts", "labels", "trusted_senders", "instance_settings", "admin_log",
  "contact_books", "contacts", "contact_emails", "contact_deletions", "calendars", "events",
] as const;

export type Dialect = "sqlite" | "postgres" | "mysql";

export interface StateStore {
  db: Kysely<StateSchema>;
  dialect: Dialect;
  /** For logs: the engine and where, without credentials. */
  where: string;
}

/** Credentials stripped, for logging a database URL. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

export function dialectOf(url: string | undefined): Dialect {
  if (!url) return "sqlite";
  if (/^postgres(ql)?:\/\//i.test(url)) return "postgres";
  if (/^(mysql|mariadb):\/\//i.test(url)) return "mysql";
  throw new Error("DATABASE_URL must start with postgres://, postgresql://, mysql:// or mariadb://");
}

/**
 * Opens the store and brings its schema up to date. With no URL it is SQLite at
 * `sqliteFile`; ":memory:" is for tests.
 */
export async function openState(url: string | undefined, sqliteFile: string): Promise<StateStore> {
  const dialect = dialectOf(url);
  let db: Kysely<StateSchema>;
  let where: string;
  if (dialect === "sqlite") {
    if (sqliteFile !== ":memory:") fs.mkdirSync(path.dirname(sqliteFile), { recursive: true });
    const raw = new DatabaseSync(sqliteFile);
    raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    db = new Kysely<StateSchema>({ dialect: new SqliteDialect({ database: nodeSqlite(raw) }) });
    where = sqliteFile;
  } else if (dialect === "postgres") {
    const pg = (await import("pg")).default;
    // BIGINT arrives as a string by default; our values (milliseconds, counts) fit a number.
    pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
    db = new Kysely<StateSchema>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 10 }) }) });
    where = redactUrl(url!);
  } else {
    const mysql = (await import("mysql2")).default;
    const pool = mysql.createPool({ uri: url!.replace(/^mariadb:/i, "mysql:"), connectionLimit: 10, charset: "UTF8MB4_BIN" });
    db = new Kysely<StateSchema>({ dialect: new MysqlDialect({ pool }) });
    where = redactUrl(url!);
  }

  const migrator = new Migrator({
    db,
    provider: migrations(dialect),
    migrationTableName: "viauna_migrations",
    migrationLockTableName: "viauna_migration_lock",
  });
  const { error } = await migrator.migrateToLatest();
  if (error) {
    await db.destroy();
    throw error;
  }
  return { db, dialect, where };
}

let current: StateStore | null = null;

export function setState(store: StateStore | null) {
  current = store;
}

/** The open state store. Storage is opened once at startup (storage.ts). */
export function stateStore(): StateStore {
  if (!current) throw new Error("The state store isn't open; storage must be initialised first.");
  return current;
}

export function state(): Kysely<StateSchema> {
  return stateStore().db;
}

/** INSERT that skips a row whose key already exists. */
export function orIgnore<DB, T extends keyof DB & string, O>(q: InsertQueryBuilder<DB, T, O>): InsertQueryBuilder<DB, T, O> {
  return stateStore().dialect === "mysql" ? q.ignore() : q.onConflict((oc) => oc.doNothing());
}

/** A duplicate key, in whichever engine raised it. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; errno?: unknown; errcode?: unknown; message?: unknown };
  return (
    e?.code === "23505" || // PostgreSQL
    e?.code === "ER_DUP_ENTRY" || e?.errno === 1062 || // MySQL/MariaDB
    e?.errcode === 2067 || e?.errcode === 1555 || // SQLite UNIQUE / PRIMARY KEY
    (typeof e?.message === "string" && /UNIQUE constraint failed/.test(e.message))
  );
}

/** Counts come back as number, string or bigint depending on the engine. */
export function toNumber(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0);
}
