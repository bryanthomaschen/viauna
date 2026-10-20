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
  };
  return { getMigrations: async () => all };
}
