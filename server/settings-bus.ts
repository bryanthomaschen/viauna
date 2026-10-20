// How a settings change made in one process reaches the others at once, rather than on a
// timer. The `viauna` command tells the server on the same host through a socket in the
// data directory; servers sharing a PostgreSQL database tell each other with
// LISTEN/NOTIFY. A notification only says "settings changed": each server then re-reads
// them from the database, which stays the one source of truth, so a lost or repeated
// notification can't leave a wrong value. A check once a minute stays as the safety net,
// for servers sharing MySQL/MariaDB (which has no notifications) and for a notification
// lost to a dropped connection.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { sql } from "kysely";
import { log } from "./log.ts";
import { state, stateStore } from "./state/db.ts";

const CHANNEL = "viauna_settings";
const SAFETY_MS = 60_000;
const RECONNECT_MS = 5_000;

let where: { dataDir: string; databaseUrl: string | undefined } | null = null;
let listening = false;

/** Where this process's store is, for announcing (set when storage opens, here or in the command line). */
export function configureSettingsBus(dataDir: string, databaseUrl: string | undefined) {
  where = { dataDir, databaseUrl };
}

export const socketPath = (dataDir: string) => path.join(dataDir, "viauna.sock");

/** Tells the server running on this data directory that settings changed. Never fails. */
export function pingServer(dataDir: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const conn = net.connect(socketPath(dataDir));
    const done = (ok: boolean) => {
      clearTimeout(timer);
      conn.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    conn.on("connect", () => conn.end("settings\n", () => done(true)));
    conn.on("error", () => done(false));
  });
}

/** After a change here: tells other servers (PostgreSQL) and, from the command line, this host's server. */
export async function announceSettingsChange() {
  if (!where) return;
  if (stateStore().dialect === "postgres") {
    await sql`select pg_notify(${CHANNEL}, '')`.execute(state()).catch((err) => log.warn("couldn't notify other servers of a settings change", { error: (err as Error).message }));
  }
  if (!listening) await pingServer(where.dataDir);
}

/**
 * In the server: re-reads the settings whenever another process says they changed, and
 * once a minute regardless. Returns a function that stops listening.
 */
export async function listenForSettings(reload: () => Promise<void>): Promise<() => Promise<void>> {
  if (!where) throw new Error("The settings bus isn't configured; storage must be initialised first.");
  const { dataDir, databaseUrl } = where;
  const run = () => void reload().catch((err) => log.warn("couldn't re-read the settings", { error: (err as Error).message }));
  const stops: (() => Promise<void> | void)[] = [];

  // The command line on this host. A socket left by a server that didn't stop cleanly
  // is replaced; if one can't be made here, the minute's check covers it.
  const file = socketPath(dataDir);
  const server = net.createServer((conn) => {
    conn.on("error", () => {});
    conn.on("data", () => {});
    conn.on("end", run);
  });
  try {
    fs.rmSync(file, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(file, () => resolve());
    });
    fs.chmodSync(file, 0o600);
    listening = true;
    stops.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          fs.rmSync(file, { force: true });
        }),
    );
  } catch (err) {
    log.warn("no settings socket: command-line changes apply within a minute", { error: (err as Error).message });
  }

  // Other servers on the same PostgreSQL database.
  if (stateStore().dialect === "postgres" && databaseUrl) {
    const pg = (await import("pg")).default;
    let client: InstanceType<typeof pg.Client> | null = null;
    let stopped = false;
    let retry: NodeJS.Timeout | null = null;
    const connect = async () => {
      const c = new pg.Client({ connectionString: databaseUrl });
      c.on("notification", (n) => n.channel === CHANNEL && run());
      c.on("error", (err) => {
        if (client !== c) return;
        client = null;
        log.warn("lost the connection that hears of settings changes; reconnecting", { error: err.message });
        c.end().catch(() => {});
        if (!stopped) retry = setTimeout(() => void connect(), RECONNECT_MS);
      });
      try {
        await c.connect();
        await c.query(`LISTEN ${CHANNEL}`);
        client = c;
        // Notifications sent while this wasn't listening are gone: catch up.
        run();
      } catch (err) {
        log.warn("couldn't listen for settings changes; trying again", { error: (err as Error).message });
        c.end().catch(() => {});
        if (!stopped) retry = setTimeout(() => void connect(), RECONNECT_MS);
      }
    };
    await connect();
    stops.push(async () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      await client?.end().catch(() => {});
    });
  }

  const safety = setInterval(run, SAFETY_MS);
  safety.unref();
  stops.push(() => clearInterval(safety));
  return async () => {
    for (const stop of stops) await stop();
    listening = false;
  };
}
