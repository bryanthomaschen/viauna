// The state store's schema, written once for SQLite, PostgreSQL and MySQL/MariaDB.
// Where they differ: auto-increment ids, the binary type, and MySQL's table options
// (utf8mb4 with binary collation, so comparisons are exact as they are elsewhere).
// Foreign keys are table constraints, because MySQL ignores inline REFERENCES.
// Timestamps are milliseconds since the epoch, so they need 64 bits.
import { type ColumnDefinitionBuilder, type Kysely, sql } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";
import { cardIndex, parseVCards } from "../vcard.ts";
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

    // 0.6: contacts' labels (CATEGORIES) and dates (birthdays, anniversaries and others),
    // kept beside each card like its addresses: labels to filter by and suggest, dates for
    // the Birthdays calendar. Filled from the cards already here, whose search text is
    // made again too, now with nicknames in it.
    "0006_contact_details": {
      async up(db: Kysely<any>) {
        await table(db, "contact_labels")
          .addColumn("contact_id", "integer", (c) => c.notNull())
          .addColumn("account_id", "integer", (c) => c.notNull())
          .addColumn("position", "integer", (c) => c.notNull())
          .addColumn("label", "varchar(100)", (c) => c.notNull())
          .addColumn("label_key", "varchar(100)", (c) => c.notNull()) // folded, so "church" and "Church" are one label
          .addPrimaryKeyConstraint("contact_labels_pk", ["contact_id", "position"])
          .addForeignKeyConstraint("contact_labels_contact", ["contact_id"], "contacts", ["id"], (fk) => fk.onDelete("cascade"))
          .execute();
        await db.schema.createIndex("contact_labels_key").on("contact_labels").columns(["account_id", "label_key"]).execute();

        await table(db, "contact_dates")
          .addColumn("contact_id", "integer", (c) => c.notNull())
          .addColumn("account_id", "integer", (c) => c.notNull())
          .addColumn("position", "integer", (c) => c.notNull())
          .addColumn("kind", "varchar(16)", (c) => c.notNull()) // birthday, anniversary or other
          .addColumn("label", "varchar(100)", (c) => c.notNull()) // an other date's own words
          .addColumn("year", "integer") // null: not known
          .addColumn("month", "integer", (c) => c.notNull())
          .addColumn("day", "integer", (c) => c.notNull())
          .addPrimaryKeyConstraint("contact_dates_pk", ["contact_id", "position"])
          .addForeignKeyConstraint("contact_dates_contact", ["contact_id"], "contacts", ["id"], (fk) => fk.onDelete("cascade"))
          .execute();
        await db.schema.createIndex("contact_dates_account").on("contact_dates").column("account_id").execute();

        for (let after = 0; ; ) {
          const rows = await db.selectFrom("contacts").select(["id", "account_id", "vcard"]).where("id", ">", after).orderBy("id").limit(500).execute();
          if (!rows.length) break;
          after = rows[rows.length - 1].id;
          for (const row of rows) {
            const card = parseVCards(row.vcard)[0];
            if (!card) continue;
            const index = cardIndex(card);
            await db.updateTable("contacts").set({ search: index.search }).where("id", "=", row.id).execute();
            if (index.labels.length) {
              await db
                .insertInto("contact_labels")
                .values(index.labels.map((l, position) => ({ contact_id: row.id, account_id: row.account_id, position, label: l.label, label_key: l.key })))
                .execute();
            }
            if (index.dates.length) {
              await db
                .insertInto("contact_dates")
                .values(index.dates.map((d, position) => ({ contact_id: row.id, account_id: row.account_id, position, ...d })))
                .execute();
            }
          }
        }
      },
    },

    // 0.6: calendars Viauna makes from something else. A calendar's kind says which:
    // "events", kept here; or "birthdays", its mailbox's contacts' dates, made into events
    // as they're asked for and never stored. The Birthdays calendar has its account id in
    // birthdays_of, unique, so each mailbox has one however many pages open at once.
    "0007_calendar_kinds": {
      async up(db: Kysely<any>) {
        await db.schema.alterTable("calendars").addColumn("kind", "varchar(16)", (c) => c.notNull().defaultTo("events")).execute();
        await db.schema.alterTable("calendars").addColumn("birthdays_of", "integer").execute();
        await db.schema.createIndex("calendars_birthdays").on("calendars").column("birthdays_of").unique().execute();
      },
    },

    // 0.6: calendars from elsewhere by their address, kind "feed". Viauna fetches the
    // address and keeps its events as the calendar's, with the validators to ask whether it
    // changed (ETag, Last-Modified), when it last tried and last got it, what went wrong
    // if it didn't, and when to fetch it next.
    "0008_calendar_feeds": {
      async up(db: Kysely<any>) {
        for (const [name, type] of [
          ["source_url", "text"], ["etag", "varchar(255)"], ["last_modified", "varchar(64)"], ["checked_at", "bigint"],
          ["fetched_at", "bigint"], ["fetch_error", "text"], ["next_fetch_at", "bigint"],
        ] as const) {
          await db.schema.alterTable("calendars").addColumn(name, type).execute();
        }
      },
    },

    // 0.6: a secret address for a calendar, for another app to show it read-only. Only
    // its token's hash is kept (unique, to find the calendar by), with whether it shows the
    // whole calendar or only when you're busy, when it was made and when it was last used.
    "0009_secret_addresses": {
      async up(db: Kysely<any>) {
        await db.schema.alterTable("calendars").addColumn("secret_hash", "varchar(64)").execute();
        await db.schema.alterTable("calendars").addColumn("secret_mode", "varchar(8)").execute();
        await db.schema.alterTable("calendars").addColumn("secret_created_at", "bigint").execute();
        await db.schema.alterTable("calendars").addColumn("secret_fetched_at", "bigint").execute();
        await db.schema.createIndex("calendars_secret").on("calendars").column("secret_hash").unique().execute();
      },
    },

    // 0.6: reminders. Each event keeps when its next reminder is due, for the scheduler to
    // find, and when it last looked, so a reminder is sent once. Events that may have one
    // are due at once, for the first round to work out when (and send nothing past).
    "0010_reminders": {
      async up(db: Kysely<any>) {
        await db.schema.alterTable("events").addColumn("alarm_at", "bigint").execute();
        await db.schema.alterTable("events").addColumn("alarm_checked_at", "bigint").execute();
        await db.schema.createIndex("events_alarm").on("events").column("alarm_at").execute();
        await db.updateTable("events").set({ alarm_at: 0 }).where("ics", "like", "%BEGIN:VALARM%").execute();
      },
    },

    // 0.6: browsers that show this mailbox's reminders with Viauna closed (Web Push): the
    // address of each one's push service, its keys, and how sending to it has gone.
    "0011_push_subscriptions": {
      async up(db: Kysely<any>) {
        await table(db, "push_subscriptions")
          .addColumn("id", serial, serialKey)
          .addColumn("account_id", "integer", (c) => c.notNull())
          .addColumn("endpoint", "text", (c) => c.notNull())
          .addColumn("endpoint_hash", "varchar(64)", (c) => c.notNull()) // sha256 of endpoint, for the unique key
          .addColumn("p256dh", "varchar(128)", (c) => c.notNull())
          .addColumn("auth", "varchar(64)", (c) => c.notNull())
          .addColumn("user_agent", "varchar(300)")
          .addColumn("created_at", "bigint", (c) => c.notNull())
          .addColumn("last_ok_at", "bigint")
          .addColumn("failures", "integer", (c) => c.notNull().defaultTo(0))
          .addUniqueConstraint("push_subscriptions_endpoint", ["account_id", "endpoint_hash"])
          .addForeignKeyConstraint("push_subscriptions_account", ["account_id"], "accounts", ["id"], (fk) => fk.onDelete("cascade"))
          .execute();
      },
    },

    // 0.6: the addresses a mailbox sends as, each confirmed before it's used: by a code
    // emailed to it (only its keyed hash kept, with when it expires, the wrong tries and the
    // codes sent today), or by the mail server accepting it as a sender. An address can have
    // its provider's mail server, whose password stays in the session that entered it. The
    // aliases kept in settings move here, not confirmed: nothing showed they were anyone's.
    "0012_identities": {
      async up(db: Kysely<any>) {
        await table(db, "identities")
          .addColumn("id", serial, serialKey)
          .addColumn("account_id", "integer", (c) => c.notNull())
          .addColumn("address", "varchar(320)", (c) => c.notNull())
          .addColumn("name", "varchar(200)", (c) => c.notNull())
          .addColumn("position", "integer", (c) => c.notNull())
          .addColumn("confirmed_at", "bigint")
          .addColumn("confirmed_by", "varchar(8)") // "code" or "server"
          .addColumn("code_hash", "varchar(64)")
          .addColumn("code_expires_at", "bigint")
          .addColumn("code_tries", "integer", (c) => c.notNull().defaultTo(0))
          .addColumn("code_sent_at", "bigint")
          .addColumn("codes_day", "integer", (c) => c.notNull().defaultTo(0)) // days since the epoch
          .addColumn("codes_sent", "integer", (c) => c.notNull().defaultTo(0)) // on that day
          .addColumn("smtp", "text") // JSON: host, port, security, login
          .addColumn("created_at", "bigint", (c) => c.notNull())
          .addUniqueConstraint("identities_address", ["account_id", "address"])
          .addForeignKeyConstraint("identities_account", ["account_id"], "accounts", ["id"], (fk) => fk.onDelete("cascade"))
          .execute();
        const accounts = await db.selectFrom("accounts").select(["id", "email", "settings"]).execute();
        for (const a of accounts as { id: number; email: string; settings: string }[]) {
          let settings: Record<string, unknown>;
          try {
            settings = JSON.parse(a.settings ?? "{}");
          } catch {
            continue;
          }
          const aliases = Array.isArray(settings.aliases) ? (settings.aliases as { name?: unknown; address?: unknown }[]) : [];
          const seen = new Set([String(a.email).toLowerCase()]);
          let position = 0;
          for (const alias of aliases) {
            const address = String(alias?.address ?? "").trim().toLowerCase();
            if (!/^[^\s@<>]+@[^\s@<>]+$/.test(address) || address.length > 320 || seen.has(address)) continue;
            seen.add(address);
            await db.insertInto("identities")
              .values({ account_id: a.id, address, name: String(alias?.name ?? "").slice(0, 200).trim(), position: position++, created_at: Date.now() })
              .execute();
          }
          delete settings.aliases;
          await db.updateTable("accounts").set({ settings: JSON.stringify(settings) }).where("id", "=", a.id).execute();
        }
      },
    },
  };
  return { getMigrations: async () => all };
}
