// The state store's schema, written once for SQLite, PostgreSQL and MySQL/MariaDB.
// Where they differ: auto-increment ids, the binary type, and MySQL's table options
// (utf8mb4 with binary collation, so comparisons are exact as they are elsewhere).
// Foreign keys are table constraints, because MySQL ignores inline REFERENCES.
// Timestamps are milliseconds since the epoch, so they need 64 bits.
import { type ColumnDefinitionBuilder, type Kysely, sql } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";
import type { Dialect } from "./db.ts";

export function migrations(dialect: Dialect): MigrationProvider {
  const blob = dialect === "postgres" ? "bytea" : "blob";
  const table = (db: Kysely<unknown>, name: string) => {
    const t = db.schema.createTable(name);
    return dialect === "mysql" ? t.modifyEnd(sql`engine=InnoDB default charset=utf8mb4 collate=utf8mb4_bin`) : t;
  };
  const serial = dialect === "postgres" ? "serial" : "integer";
  const serialKey = (c: ColumnDefinitionBuilder) => (dialect === "postgres" ? c.primaryKey() : c.primaryKey().autoIncrement());
  const all: Record<string, Migration> = {
    "0001_initial": {
      async up(db: Kysely<any>) {
        await table(db, "accounts")
          .addColumn("id", serial, serialKey)
          .addColumn("login", "varchar(320)", (c) => c.notNull())
          .addColumn("email", "varchar(320)", (c) => c.notNull())
          .addColumn("imap", "text", (c) => c.notNull()) // JSON Endpoint
          .addColumn("imap_hash", "varchar(64)", (c) => c.notNull()) // sha256 of imap, for the unique key
          .addColumn("smtp", "text", (c) => c.notNull()) // JSON Endpoint
          .addColumn("settings", "text", (c) => c.notNull()) // JSON AccountSettings
          .addColumn("created_at", "bigint", (c) => c.notNull())
          .addUniqueConstraint("accounts_identity", ["login", "imap_hash"])
          .execute();

        await table(db, "sessions")
          .addColumn("id", "varchar(64)", (c) => c.primaryKey()) // sha256 of the cookie's session id
          .addColumn("created_at", "bigint", (c) => c.notNull())
          .addColumn("seen_at", "bigint", (c) => c.notNull())
          .addColumn("expires_at", "bigint", (c) => c.notNull())
          .addColumn("user_agent", "varchar(300)")
          .addColumn("ip", "varchar(64)")
          .execute();
        await db.schema.createIndex("sessions_expires").on("sessions").column("expires_at").execute();

        await table(db, "session_accounts")
          .addColumn("session_id", "varchar(64)", (c) => c.notNull())
          .addColumn("account_id", "integer", (c) => c.notNull())
          .addColumn("position", "integer", (c) => c.notNull())
          .addColumn("credential", blob, (c) => c.notNull()) // AES-256-GCM, keyed from the cookie
          .addPrimaryKeyConstraint("session_accounts_pk", ["session_id", "account_id"])
          .addForeignKeyConstraint("session_accounts_session", ["session_id"], "sessions", ["id"], (fk) => fk.onDelete("cascade"))
          .addForeignKeyConstraint("session_accounts_account", ["account_id"], "accounts", ["id"], (fk) => fk.onDelete("cascade"))
          .execute();

        // Label names and colours chosen here; the labels themselves are IMAP keywords.
        await table(db, "labels")
          .addColumn("account_id", "integer", (c) => c.notNull())
          .addColumn("keyword", "varchar(255)", (c) => c.notNull())
          .addColumn("name", "varchar(255)", (c) => c.notNull())
          .addColumn("color", "varchar(7)")
          .addColumn("created_at", "bigint", (c) => c.notNull())
          .addPrimaryKeyConstraint("labels_pk", ["account_id", "keyword"])
          .addForeignKeyConstraint("labels_account", ["account_id"], "accounts", ["id"], (fk) => fk.onDelete("cascade"))
          .execute();

        await table(db, "trusted_senders")
          .addColumn("account_id", "integer", (c) => c.notNull())
          .addColumn("address", "varchar(320)", (c) => c.notNull())
          .addPrimaryKeyConstraint("trusted_senders_pk", ["account_id", "address"])
          .addForeignKeyConstraint("trusted_senders_account", ["account_id"], "accounts", ["id"], (fk) => fk.onDelete("cascade"))
          .execute();
      },
    },

    // 0.3: settings changed from the admin page or the command line, and a record of
    // every change. Settings left at their default have no row.
    "0002_admin": {
      async up(db: Kysely<any>) {
        await table(db, "instance_settings")
          .addColumn("name", "varchar(64)", (c) => c.primaryKey())
          .addColumn("value", "text", (c) => c.notNull()) // JSON
          .addColumn("updated_at", "bigint", (c) => c.notNull())
          .addColumn("updated_by", "varchar(320)", (c) => c.notNull())
          .execute();

        await table(db, "admin_log")
          .addColumn("id", serial, serialKey)
          .addColumn("at", "bigint", (c) => c.notNull())
          .addColumn("actor", "varchar(320)", (c) => c.notNull()) // an admin's address, or "command line"
          .addColumn("setting", "varchar(64)", (c) => c.notNull())
          .addColumn("old_value", "text") // JSON; null for the default
          .addColumn("new_value", "text")
          .execute();
        await db.schema.createIndex("admin_log_at").on("admin_log").column("at").execute();
      },
    },

    // 0.4: the address book. Each contact is kept whole, as its vCard, with the name to
    // sort by and a lower-cased text to search (the engines differ in case and collation),
    // and its addresses in their own table, for suggestions and for "is this a contact".
    "0003_contacts": {
      async up(db: Kysely<any>) {
        await table(db, "contacts")
          .addColumn("id", serial, serialKey)
          .addColumn("account_id", "integer", (c) => c.notNull())
          .addColumn("uid", "varchar(255)", (c) => c.notNull())
          .addColumn("name", "varchar(500)", (c) => c.notNull())
          .addColumn("sort_key", "varchar(500)", (c) => c.notNull())
          .addColumn("search", "text", (c) => c.notNull())
          .addColumn("vcard", dialect === "mysql" ? sql`mediumtext` : "text", (c) => c.notNull()) // MySQL's text is 64 KB
          .addColumn("created_at", "bigint", (c) => c.notNull())
          .addColumn("updated_at", "bigint", (c) => c.notNull())
          .addUniqueConstraint("contacts_uid", ["account_id", "uid"])
          .addForeignKeyConstraint("contacts_account", ["account_id"], "accounts", ["id"], (fk) => fk.onDelete("cascade"))
          .execute();
        await db.schema.createIndex("contacts_sort").on("contacts").columns(["account_id", "sort_key"]).execute();

        await table(db, "contact_emails")
          .addColumn("contact_id", "integer", (c) => c.notNull())
          .addColumn("account_id", "integer", (c) => c.notNull())
          .addColumn("position", "integer", (c) => c.notNull())
          .addColumn("address", "varchar(320)", (c) => c.notNull()) // lower-cased
          .addPrimaryKeyConstraint("contact_emails_pk", ["contact_id", "position"])
          .addForeignKeyConstraint("contact_emails_contact", ["contact_id"], "contacts", ["id"], (fk) => fk.onDelete("cascade"))
          .execute();
        await db.schema.createIndex("contact_emails_address").on("contact_emails").columns(["account_id", "address"]).execute();
      },
    },

    // 0.4: syncing contacts with a CardDAV server. A contact in an address book there
    // has its book, its URL and ETag; dirty marks a change not yet sent, and base keeps
    // the card as last synced until it is, for merging with a change made elsewhere.
    // Deleting one queues the deletion, since its row is gone at once.
    "0004_carddav": {
      async up(db: Kysely<any>) {
        await table(db, "contact_books")
          .addColumn("id", serial, serialKey)
          .addColumn("account_id", "integer", (c) => c.notNull())
          .addColumn("url", "text", (c) => c.notNull())
          .addColumn("url_hash", "varchar(64)", (c) => c.notNull()) // sha256 of url, for the unique key
          .addColumn("name", "varchar(255)", (c) => c.notNull())
          .addColumn("sync_token", "text")
          .addColumn("synced_at", "bigint")
          .addColumn("created_at", "bigint", (c) => c.notNull())
          .addUniqueConstraint("contact_books_url", ["account_id", "url_hash"])
          .addForeignKeyConstraint("contact_books_account", ["account_id"], "accounts", ["id"], (fk) => fk.onDelete("cascade"))
          .execute();

        await db.schema.alterTable("contacts").addColumn("book_id", "integer").execute();
        await db.schema.alterTable("contacts").addColumn("href", "text").execute();
        await db.schema.alterTable("contacts").addColumn("etag", "varchar(255)").execute();
        await db.schema.alterTable("contacts").addColumn("dirty", "integer", (c) => c.notNull().defaultTo(0)).execute();
        await db.schema.alterTable("contacts").addColumn("base", dialect === "mysql" ? sql`mediumtext` : "text").execute();
        await db.schema.createIndex("contacts_book").on("contacts").columns(["account_id", "book_id"]).execute();

        await table(db, "contact_deletions")
          .addColumn("id", serial, serialKey)
          .addColumn("account_id", "integer", (c) => c.notNull())
          .addColumn("book_id", "integer", (c) => c.notNull())
          .addColumn("href", "text", (c) => c.notNull())
          .addColumn("etag", "varchar(255)")
          .addForeignKeyConstraint("contact_deletions_account", ["account_id"], "accounts", ["id"], (fk) => fk.onDelete("cascade"))
          .execute();
      },
    },

    // 0.6: calendars. Each event is kept whole, as the iCalendar object for its UID (the
    // event and any changed occurrences), with its title and a lower-cased text to search,
    // and when it starts and ends in UTC milliseconds to find the ones in a range. An
    // all-day or floating event's times are taken as UTC there; queries allow a day either
    // side, and the exact times are worked out in the reader's time zone.
    "0005_calendars": {
      async up(db: Kysely<any>) {
        await table(db, "calendars")
          .addColumn("id", serial, serialKey)
          .addColumn("account_id", "integer", (c) => c.notNull())
          .addColumn("name", "varchar(255)", (c) => c.notNull())
          .addColumn("color", "varchar(32)", (c) => c.notNull())
          .addColumn("position", "integer", (c) => c.notNull())
          .addColumn("visible", "integer", (c) => c.notNull().defaultTo(1))
          // The mailbox's own calendar, made on its first visit, has its account id here and
          // can't be deleted. Unique, so two pages opening at once can't make two; every
          // engine lets other calendars share NULL.
          .addColumn("primary_of", "integer")
          .addColumn("created_at", "bigint", (c) => c.notNull())
          .addColumn("updated_at", "bigint", (c) => c.notNull())
          .addUniqueConstraint("calendars_primary", ["primary_of"])
          .addForeignKeyConstraint("calendars_account", ["account_id"], "accounts", ["id"], (fk) => fk.onDelete("cascade"))
          .execute();
        await db.schema.createIndex("calendars_account").on("calendars").columns(["account_id", "position"]).execute();

        await table(db, "events")
          .addColumn("id", serial, serialKey)
          .addColumn("account_id", "integer", (c) => c.notNull())
          .addColumn("calendar_id", "integer", (c) => c.notNull())
          .addColumn("uid", "varchar(255)", (c) => c.notNull())
          .addColumn("title", "varchar(500)", (c) => c.notNull())
          .addColumn("search", "text", (c) => c.notNull())
          .addColumn("ics", dialect === "mysql" ? sql`mediumtext` : "text", (c) => c.notNull())
          .addColumn("start_at", "bigint", (c) => c.notNull())
          .addColumn("end_at", "bigint", (c) => c.notNull())
          .addColumn("all_day", "integer", (c) => c.notNull())
          .addColumn("created_at", "bigint", (c) => c.notNull())
          .addColumn("updated_at", "bigint", (c) => c.notNull())
          .addUniqueConstraint("events_uid", ["calendar_id", "uid"])
          .addForeignKeyConstraint("events_calendar", ["calendar_id"], "calendars", ["id"], (fk) => fk.onDelete("cascade"))
          .addForeignKeyConstraint("events_account", ["account_id"], "accounts", ["id"], (fk) => fk.onDelete("cascade"))
          .execute();
        await db.schema.createIndex("events_range").on("events").columns(["account_id", "start_at"]).execute();
      },
    },
  };
  return { getMigrations: async () => all };
}
