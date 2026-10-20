// Opens both stores at startup: the state store (state/db.ts) and the mail index
// (db.ts, always index.db in DATA_DIR). Also moves older layouts forward:
//
// - 0.1 kept everything in viauna.db. Its accounts, sessions, settings, label colours
//   and trusted senders are copied into the state store, and the file, now only an
//   index, is renamed index.db.
// - Setting DATABASE_URL after running on the default SQLite store: an empty database
//   is filled from state.db, so switching engines keeps everyone signed in.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Kysely, SqliteDialect } from "kysely";
import { config } from "./config.ts";
import { Database, setDatabase } from "./db.ts";
import { log } from "./log.ts";
import { copyState, isEmpty } from "./state/copy.ts";
import { type StateStore, openState, setState, stateStore } from "./state/db.ts";
import { nodeSqlite } from "./state/node-sqlite.ts";

export interface StorageOptions {
  dataDir?: string;
  databaseUrl?: string;
}

function sqliteReader(file: string): Kysely<any> {
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA busy_timeout = 5000;");
  return new Kysely({ dialect: new SqliteDialect({ database: nodeSqlite(raw) }) });
}

function hasTable(file: string, table: string): boolean {
  const raw = new DatabaseSync(file);
  try {
    return !!raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  } finally {
    raw.close();
  }
}

/** 0.1's viauna.db: copy its state out, then keep it as the index. */
async function upgradeSingleFile(legacy: string, index: string, store: StateStore) {
  if (hasTable(legacy, "sessions")) {
    if (await isEmpty(store.db)) {
      const source = sqliteReader(legacy);
      try {
        const counts = await copyState(source, store);
        log.info("moved accounts and sessions out of viauna.db", { into: store.where, ...counts });
      } finally {
        await source.destroy();
      }
    } else {
      log.warn("viauna.db has accounts, but the state store already has its own; keeping the store's", { store: store.where });
    }
  }
  // Fold the write-ahead log in before renaming, so the index moves as one file.
  const raw = new DatabaseSync(legacy);
  raw.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  raw.close();
  fs.renameSync(legacy, index);
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(legacy + suffix, { force: true });
  log.info("viauna.db is now index.db");
}

/** Cached messages used to be filed under local account ids; see mail/fetch.ts. */
function dropOldCacheLayout(dataDir: string) {
  const root = path.join(dataDir, "cache");
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) if (/^\d+$/.test(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
}

export async function initStorage(opts: StorageOptions = {}) {
  const dataDir = opts.dataDir ?? config.dataDir;
  const databaseUrl = "databaseUrl" in opts ? opts.databaseUrl : config.databaseUrl;
  fs.mkdirSync(dataDir, { recursive: true });
  const stateFile = path.join(dataDir, "state.db");
  const indexFile = path.join(dataDir, "index.db");
  const legacyFile = path.join(dataDir, "viauna.db");

  const store = await openState(databaseUrl, stateFile);
  setState(store);
  log.info("state store open", { engine: store.dialect, where: store.where });

  if (fs.existsSync(legacyFile) && !fs.existsSync(indexFile)) {
    await upgradeSingleFile(legacyFile, indexFile, store);
  } else if (store.dialect !== "sqlite" && fs.existsSync(stateFile) && (await isEmpty(store.db))) {
    const local = await openState(undefined, stateFile);
    try {
      const counts = await copyState(local.db, store);
      log.info("copied state.db into the new database; state.db is no longer used", { into: store.where, ...counts });
    } finally {
      await local.db.destroy();
    }
  }

  setDatabase(new Database(indexFile));
  dropOldCacheLayout(dataDir);
}

export async function closeStorage() {
  await stateStore().db.destroy();
  setState(null);
}
