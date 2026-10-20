// Moves state from one store into another, ids and all: an account's id is part of
// the key that encrypts its saved passwords, so renumbering would sign everyone out.
import { type Kysely, sql } from "kysely";
import { sha256 } from "../crypto.ts";
import { STATE_TABLES, type StateSchema, type StateStore, toNumber } from "./db.ts";

const BATCH = 100;

export async function isEmpty(db: Kysely<StateSchema>): Promise<boolean> {
  const row = await db.selectFrom("accounts").select((eb) => eb.fn.countAll().as("n")).executeTakeFirst();
  return toNumber(row?.n) === 0;
}

/** Fits a source row to the current schema; 0.1's single database had no imap_hash. */
function adapt(table: (typeof STATE_TABLES)[number], row: Record<string, unknown>): Record<string, unknown> {
  if (table === "accounts") {
    return { ...row, imap_hash: row.imap_hash ?? sha256(String(row.imap)), settings: row.settings ?? "{}" };
  }
  if (table === "session_accounts") return { ...row, credential: Buffer.from(row.credential as Uint8Array) };
  return row;
}

/**
 * Copies every state table from `from` into `to`, in one transaction. Returns row
 * counts. Tables the source doesn't have yet (0.1's file predates the admin tables) are
 * left empty.
 */
export async function copyState(from: Kysely<any>, to: StateStore): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const present = new Set((await from.introspection.getTables()).map((t) => t.name));
  await to.db.transaction().execute(async (trx) => {
    for (const table of STATE_TABLES) {
      if (!present.has(table)) continue;
      const rows = (await from.selectFrom(table).selectAll().execute()) as Record<string, unknown>[];
      counts[table] = rows.length;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH).map((r) => adapt(table, r));
        await trx.insertInto(table).values(batch as never).execute();
      }
    }
    if (to.dialect === "postgres") {
      // The rows kept their ids; move the sequences past them.
      for (const table of ["accounts", "admin_log", "contacts", "contact_books", "contact_deletions"]) {
        await sql`SELECT setval(pg_get_serial_sequence(${table}, 'id'), COALESCE((SELECT MAX(id) FROM ${sql.table(table)}), 0) + 1, false)`.execute(trx);
      }
    }
  });
  return counts;
}
