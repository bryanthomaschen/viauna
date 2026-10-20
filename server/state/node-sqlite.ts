// Kysely's SQLite dialect expects better-sqlite3's interface. This gives it that
// interface over Node's built-in driver, so the default install still has no native
// module to compile.
import type { SqliteDatabase } from "kysely";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/** What Kysely sends that returns rows, for Nodes without StatementSync#columns(). */
const RETURNS_ROWS = /^\s*(select|with|pragma|values|explain)\b|\breturning\b/i;

export function nodeSqlite(db: DatabaseSync): SqliteDatabase {
  return {
    close: () => db.close(),
    prepare(sql) {
      const stmt = db.prepare(sql);
      const reader = typeof stmt.columns === "function" ? stmt.columns().length > 0 : RETURNS_ROWS.test(sql);
      const args = (params: ReadonlyArray<unknown>) => params as SQLInputValue[];
      return {
        reader,
        all: (params) => stmt.all(...args(params)),
        run: (params) => stmt.run(...args(params)),
        iterate: (params) => stmt.iterate(...args(params)),
      };
    },
  };
}
