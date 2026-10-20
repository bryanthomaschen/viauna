// The state-store engines to test against: SQLite always, and PostgreSQL and
// MySQL/MariaDB when a URL for a throwaway database is given (CI does; locally see
// docs/development.md). Each test empties the database first.
//
//   VIAUNA_TEST_PG=postgres://viauna:viauna@127.0.0.1:55432/viauna
//   VIAUNA_TEST_MYSQL=mysql://viauna:viauna@127.0.0.1:53306/viauna
//   VIAUNA_TEST_MARIADB=mariadb://viauna:viauna@127.0.0.1:53307/viauna
import { STATE_TABLES, openState } from "../server/state/db.ts";

export const ENGINES: { name: string; url: string | undefined }[] = [
  { name: "sqlite", url: undefined },
  ...(
    [
      ["postgres", process.env.VIAUNA_TEST_PG],
      ["mysql", process.env.VIAUNA_TEST_MYSQL],
      ["mariadb", process.env.VIAUNA_TEST_MARIADB],
    ] as const
  )
    .filter(([, url]) => url)
    .map(([name, url]) => ({ name, url })),
];

/** Drops everything Viauna created in a server database, leaving it empty. */
export async function emptyDatabase(url: string) {
  const store = await openState(url, ":memory:");
  try {
    for (const table of [...STATE_TABLES].reverse()) await store.db.schema.dropTable(table).ifExists().execute();
    for (const table of ["viauna_migrations", "viauna_migration_lock"]) await store.db.schema.dropTable(table).ifExists().execute();
  } finally {
    await store.db.destroy();
  }
}
