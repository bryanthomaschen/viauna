// How a settings change made in another process reaches the running server
// (server/settings-bus.ts): the command line through the data directory's socket, other
// servers through PostgreSQL's LISTEN/NOTIFY.
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setting } from "../server/config.ts";
import { loadInstanceSettings } from "../server/instance.ts";
import { announceSettingsChange, configureSettingsBus, listenForSettings, pingServer, socketPath } from "../server/settings-bus.ts";
import { type StateStore, openState, setState } from "../server/state/db.ts";
import { emptyDatabase } from "./databases.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "viauna-test-"));

describe("telling the running server that settings changed", () => {
  let dir: string;
  let store: StateStore;
  let stop: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    dir = tmp();
    store = await openState(undefined, path.join(dir, "state.db"));
    setState(store);
    configureSettingsBus(dir, undefined);
  });

  afterEach(async () => {
    await stop?.();
    stop = null;
    setState(null);
    await store.db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("re-reads them as soon as the command line says so", async () => {
    const reload = vi.fn(async () => {});
    stop = await listenForSettings(reload);
    expect(fs.statSync(socketPath(dir)).mode & 0o777).toBe(0o600);
    expect(await pingServer(dir)).toBe(true);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 500 });
  });

  it("is told by the command line after it changes something", async () => {
    // Stands in for the server; this process is the command line, not listening itself.
    const heard: string[] = [];
    const server = net.createServer((c) => c.on("data", (d) => heard.push(d.toString())));
    await new Promise<void>((r) => server.listen(socketPath(dir), r));
    try {
      await announceSettingsChange();
      await vi.waitFor(() => expect(heard.join("")).toBe("settings\n"), { timeout: 500 });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("doesn't wait or fail when no server is running", async () => {
    const started = Date.now();
    expect(await pingServer(dir)).toBe(false);
    await announceSettingsChange();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("replaces a socket left by a server that didn't stop cleanly", async () => {
    fs.writeFileSync(socketPath(dir), "");
    const reload = vi.fn(async () => {});
    stop = await listenForSettings(reload);
    expect(await pingServer(dir)).toBe(true);
    await vi.waitFor(() => expect(reload).toHaveBeenCalled(), { timeout: 500 });
    await stop();
    stop = null;
    expect(fs.existsSync(socketPath(dir))).toBe(false);
  });

  it("applies a change made with the viauna command in about a second", async () => {
    stop = await listenForSettings(loadInstanceSettings);
    await loadInstanceSettings();
    expect(setting("appName")).toBe("Viauna");
    const cli = path.resolve("server/cli.ts");
    await new Promise<void>((resolve, reject) =>
      execFile(process.execPath, ["--disable-warning=ExperimentalWarning", cli, "settings", "set", "APP_NAME", "Post Office"], { env: { ...process.env, DATA_DIR: dir } }, (err) =>
        err ? reject(err) : resolve(),
      ),
    );
    // The command has exited; nothing here re-read the settings but the listener.
    await vi.waitFor(() => expect(setting("appName")).toBe("Post Office"), { timeout: 1000 });
  });
});

// Servers sharing one PostgreSQL database, when VIAUNA_TEST_PG names one.
const PG = process.env.VIAUNA_TEST_PG;

describe.skipIf(!PG)("servers sharing PostgreSQL", () => {
  let dir: string;
  let store: StateStore;
  let other: StateStore;
  let stop: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    dir = tmp();
    await emptyDatabase(PG!);
    store = await openState(PG, ":memory:");
    other = await openState(PG, ":memory:");
    setState(store);
    configureSettingsBus(dir, PG);
  });

  afterEach(async () => {
    await stop?.();
    stop = null;
    setState(null);
    await store.db.destroy();
    await other.db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("re-read them when another server announces a change", async () => {
    const reload = vi.fn(async () => {});
    stop = await listenForSettings(reload);
    // Once on connecting, to catch up on anything missed while not listening.
    expect(reload).toHaveBeenCalledTimes(1);
    await sql`select pg_notify('viauna_settings', '')`.execute(other.db);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2), { timeout: 1000 });
  });

  it("listen again after losing the connection, and catch up", async () => {
    const reload = vi.fn(async () => {});
    stop = await listenForSettings(reload);
    await sql`select pg_terminate_backend(pid) from pg_stat_activity where query = 'LISTEN viauna_settings'`.execute(other.db);
    // Reconnected (within RECONNECT_MS) and re-read once for what it may have missed.
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2), { timeout: 8000, interval: 100 });
    await sql`select pg_notify('viauna_settings', '')`.execute(other.db);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(3), { timeout: 1000 });
  }, 10_000);

  it("announce their own changes to the others", async () => {
    const heard = vi.fn();
    const pg = (await import("pg")).default;
    const listener = new pg.Client({ connectionString: PG });
    await listener.connect();
    try {
      listener.on("notification", (n) => heard(n.channel));
      await listener.query("LISTEN viauna_settings");
      await announceSettingsChange();
      await vi.waitFor(() => expect(heard).toHaveBeenCalledWith("viauna_settings"), { timeout: 1000 });
    } finally {
      await listener.end();
    }
  });
});
