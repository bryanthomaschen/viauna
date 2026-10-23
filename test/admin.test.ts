// Settings changed while running (config.ts SETTINGS, instance.ts), who counts as an
// admin, and the `viauna` command line.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { main } from "../server/cli.ts";
import { type SettingDef, config, endpointKey, lockedBy, parseSetting, readEnvironment, setting, settingDef } from "../server/config.ts";
import type { AccountInfo } from "../server/imap/runtime.ts";
import { changeSettings, describeSettings, isAdmin, loadInstanceSettings, recentChanges } from "../server/instance.ts";
import { type StateStore, openState, setState, state } from "../server/state/db.ts";
import { ENGINES, emptyDatabase } from "./databases.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "viauna-test-"));
const def = (name: string) => settingDef(name) as SettingDef;

describe("parsing a setting", () => {
  it("takes on and off in the usual spellings, and nothing else", () => {
    for (const v of [true, "1", "true", "Yes", "on"]) expect(parseSetting(def("ALLOW_CUSTOM_SERVERS"), v)).toEqual({ value: true });
    for (const v of [false, "0", "false", "NO", "off"]) expect(parseSetting(def("ALLOW_CUSTOM_SERVERS"), v)).toEqual({ value: false });
    for (const v of ["maybe", 1, null, ""]) expect(parseSetting(def("ALLOW_CUSTOM_SERVERS"), v)).toHaveProperty("error");
  });

  it("keeps whole numbers within range", () => {
    expect(parseSetting(def("SESSION_DAYS"), "7")).toEqual({ value: 7 });
    expect(parseSetting(def("SESSION_DAYS"), 365)).toEqual({ value: 365 });
    for (const v of ["0", 3651, 2.5, "seven", ""]) expect(parseSetting(def("SESSION_DAYS"), v)).toHaveProperty("error");
    expect(parseSetting(def("CACHE_MB"), 0)).toEqual({ value: 0 });
  });

  it("normalises lists, and refuses what isn't a domain or address", () => {
    expect(parseSetting(def("ALLOWED_DOMAINS"), " Example.com, @example.org,,example.com ")).toEqual({ value: ["example.com", "example.org"] });
    expect(parseSetting(def("ALLOWED_DOMAINS"), "")).toEqual({ value: [] });
    expect(parseSetting(def("ALLOWED_DOMAINS"), ["a.test", "not a domain"])).toEqual({ error: '"not a domain" isn\'t a domain.' });
    expect(parseSetting(def("ADMIN_ADDRESSES"), ["Ann@Example.com"])).toEqual({ value: ["ann@example.com"] });
    expect(parseSetting(def("ADMIN_ADDRESSES"), "ann")).toHaveProperty("error");
    expect(parseSetting(def("ADMIN_ADDRESSES"), [1])).toHaveProperty("error");
  });

  it("reads links as a list or as JSON, for everyone unless they're for admins", () => {
    const admin = { label: "Mail admin", url: "https://mail.example.com/admin", for: "admins" };
    expect(parseSetting(def("LINKS"), [{ label: " Help ", url: "https://help.example.com" }, admin])).toEqual({
      value: [{ label: "Help", url: "https://help.example.com", for: "everyone" }, admin],
    });
    expect(parseSetting(def("LINKS"), JSON.stringify([admin]))).toEqual({ value: [admin] });
    expect(parseSetting(def("LINKS"), "")).toEqual({ value: [] });
    const many = Array.from({ length: 21 }, () => ({ label: "x", url: "https://a.test" }));
    for (const bad of ["[{", [{ label: "x", url: "javascript:alert(1)" }], [{ label: "", url: "https://a.test" }], [{ label: "x", url: "https://a.test", for: "nobody" }], many]) {
      expect(parseSetting(def("LINKS"), bad)).toHaveProperty("error");
    }
  });

  it("checks text and choices", () => {
    expect(parseSetting(def("APP_NAME"), "  Mail  ")).toEqual({ value: "Mail" });
    expect(parseSetting(def("APP_NAME"), " ")).toHaveProperty("error");
    expect(parseSetting(def("APP_NAME"), "a\nb")).toHaveProperty("error");
    expect(parseSetting(def("PASSWORD_CHANGE"), "link")).toEqual({ value: "link" });
    expect(parseSetting(def("PASSWORD_CHANGE"), "ldap")).toEqual({ value: "ldap" });
    expect(parseSetting(def("PASSWORD_CHANGE"), "carrier pigeon")).toHaveProperty("error");
  });

  it("keeps where passwords go out of reach of the admin page", () => {
    for (const env of ["PASSWORD_CHANGE_URL", "PASSWORD_CHANGE_COMMAND", "PASSWORD_CHANGE_WEBHOOK", "ALLOW_PRIVATE_SERVERS", "IMAP_HOST", "DATABASE_URL"]) {
      expect(settingDef(env)).toBeUndefined();
    }
  });

  it("refuses to start with an invalid value in the environment", () => {
    try {
      expect(() => readEnvironment({ SESSION_DAYS: "forever" })).toThrow(/^SESSION_DAYS="forever": Session length must be a whole number/);
      expect(() => readEnvironment({ ALLOW_CUSTOM_SERVERS: "ture" })).toThrow(/ALLOW_CUSTOM_SERVERS/);
    } finally {
      readEnvironment();
    }
  });
});

describe("who is an admin", () => {
  const configured = JSON.parse(endpointKey(config.imap!));
  const account = (login: string, imap: AccountInfo["imap"] = configured): AccountInfo =>
    ({ id: 1, login, email: "ann@example.test", imap, smtp: configured }) as AccountInfo;

  beforeEach(() => readEnvironment({ ...process.env, ADMIN_ADDRESSES: "ann@example.test" }));
  afterEach(() => readEnvironment());

  it("is a listed login on this server's own mail server", () => {
    expect(isAdmin(account("ann@example.test"))).toBe(true);
  });

  it("is never an account on a server entered at sign-in, whatever its name", () => {
    expect(isAdmin(account("ann@example.test", { ...configured, custom: true }))).toBe(false);
    expect(isAdmin(account("ann@example.test", { ...configured, host: "imap.attacker.test" }))).toBe(false);
  });

  it("goes by the login the server checked, not the address typed", () => {
    // The address is ann's, but the mail server checked bob's password.
    expect(isAdmin(account("bob@example.test"))).toBe(false);
    expect(isAdmin(account("Ann@example.test"))).toBe(false);
  });
});

describe.each(ENGINES)("instance settings on $name", ({ url }) => {
  let store: StateStore;
  let dir: string;

  // Schema changes are slow on MySQL, so the store is made once and only these tables
  // are emptied between tests.
  beforeAll(async () => {
    dir = tmp();
    if (url) await emptyDatabase(url);
    store = await openState(url, path.join(dir, "state.db"));
  });

  afterAll(async () => {
    await store.db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    setState(store);
    await state().deleteFrom("instance_settings").execute();
    await state().deleteFrom("admin_log").execute();
    await loadInstanceSettings();
  });

  afterEach(() => {
    readEnvironment();
    setState(null);
  });

  it("starts from the defaults", async () => {
    expect(setting("sessionDays")).toBe(30);
    expect(config.maxUploadBytes).toBe(25 * 1024 * 1024);
    const all = await describeSettings();
    expect(all.find((s) => s.key === "sessionDays")).toMatchObject({ value: 30, source: "default", updatedBy: null });
  });

  it("changes settings by name or environment variable, and records who did", async () => {
    expect(await changeSettings({ SESSION_DAYS: "7", allowedDomains: ["example.test"] }, "ann@example.test")).toEqual({
      changed: ["sessionDays", "allowedDomains"],
    });
    expect(config.sessionDays).toBe(7);
    expect(config.allowedDomains).toEqual(["example.test"]);
    const info = (await describeSettings()).find((s) => s.key === "sessionDays")!;
    expect(info).toMatchObject({ value: 7, source: "changed", updatedBy: "ann@example.test" });
    expect(info.updatedAt).toBeGreaterThan(Date.now() - 60_000);

    const log = await recentChanges();
    expect(log.map((c) => [c.env, c.actor, c.oldValue, c.newValue])).toEqual(
      expect.arrayContaining([
        ["SESSION_DAYS", "ann@example.test", null, 7],
        ["ALLOWED_DOMAINS", "ann@example.test", null, ["example.test"]],
      ]),
    );
  });

  it("records nothing for a change that changes nothing, and resets to the default", async () => {
    await changeSettings({ maxAccounts: 3 }, "ann@example.test");
    expect(await changeSettings({ maxAccounts: "3" }, "ann@example.test")).toEqual({ changed: [] });
    expect(await changeSettings({ maxAccounts: null }, "command line")).toEqual({ changed: ["maxAccounts"] });
    expect(config.maxAccountsPerSession).toBe(10);
    expect((await recentChanges()).map((c) => [c.actor, c.oldValue, c.newValue])).toEqual([
      ["command line", 3, null],
      ["ann@example.test", null, 3],
    ]);
  });

  it("applies all of a change or none of it", async () => {
    const result = await changeSettings({ sessionDays: 5, maxAccounts: 0 }, "ann@example.test");
    expect(result).toMatchObject({ setting: "maxAccounts" });
    expect(setting("sessionDays")).toBe(30);
    expect(await recentChanges()).toEqual([]);
    expect(await changeSettings({ NOPE: 1 }, "ann@example.test")).toHaveProperty("error");
  });

  it("can't change a setting the environment sets", async () => {
    readEnvironment({ ...process.env, SESSION_DAYS: "14" });
    expect(lockedBy("sessionDays")).toBe("SESSION_DAYS");
    expect(await changeSettings({ sessionDays: 3 }, "ann@example.test")).toEqual({
      error: "Session length is set by SESSION_DAYS in the environment; change it there.",
      setting: "sessionDays",
    });
    expect((await describeSettings()).find((s) => s.key === "sessionDays")).toMatchObject({ value: 14, source: "environment" });
  });

  it("picks up a change made by another process", async () => {
    await state()
      .insertInto("instance_settings")
      .values({ name: "appName", value: JSON.stringify("Team Mail"), updated_at: 1, updated_by: "command line" })
      .execute();
    expect(config.appName).toBe("Viauna");
    await loadInstanceSettings();
    expect(config.appName).toBe("Team Mail");
  });

  it("skips a stored value that is no longer valid", async () => {
    await state()
      .insertInto("instance_settings")
      .values([
        { name: "maxAccounts", value: "500", updated_at: 1, updated_by: "x" },
        { name: "sessionDays", value: "not json", updated_at: 1, updated_by: "x" },
        { name: "retired", value: "1", updated_at: 1, updated_by: "x" },
      ])
      .execute();
    await loadInstanceSettings();
    expect(setting("maxAccounts")).toBe(10);
    expect(setting("sessionDays")).toBe(30);
  });
});

describe("the viauna command", () => {
  let dir: string;
  let lines: string[];
  let errors: string[];
  const io = { out: (l: string) => lines.push(l), err: (l: string) => errors.push(l) };
  const run = (...argv: string[]) => main(argv, io, { dataDir: dir, databaseUrl: undefined });

  beforeEach(() => {
    dir = tmp();
    lines = [];
    errors = [];
  });

  afterEach(() => {
    readEnvironment();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists every setting with where its value comes from", async () => {
    expect(await run("settings")).toBe(0);
    const text = lines.join("\n");
    expect(text).toMatch(/^Admins\n {2}ADMIN_ADDRESSES +\(none\) +\(default\)/);
    expect(text).toMatch(/SESSION_DAYS +30 days +\(default\)/);
  });

  it("sets and resets a setting, and keeps the record", async () => {
    expect(await run("settings", "set", "max_upload_mb", "50")).toBe(0);
    expect(lines.pop()).toBe("MAX_UPLOAD_MB is now 50 MB.");
    expect(await run("settings")).toBe(0);
    expect(lines.join("\n")).toMatch(/MAX_UPLOAD_MB +50 MB +\(changed by command line, \d{4}-\d\d-\d\d \d\d:\d\d UTC\)/);
    expect(await run("settings", "reset", "MAX_UPLOAD_MB")).toBe(0);
    expect(lines.pop()).toBe("MAX_UPLOAD_MB is back to its default, 25 MB.");
    lines = [];
    expect(await run("changes")).toBe(0);
    expect(lines[0]).toMatch(/command line: MAX_UPLOAD_MB 50 -> \(default\)$/);
    expect(lines[1]).toMatch(/command line: MAX_UPLOAD_MB \(default\) -> 50$/);
  });

  it("adds and removes admins", async () => {
    expect(await run("admin", "list")).toBe(0);
    expect(lines.pop()).toMatch(/^No admins yet/);
    expect(await run("admin", "add", "Ann@Example.test")).toBe(0);
    expect(await run("admin", "add", "bob@example.test")).toBe(0);
    expect(await run("admin", "add", "bob@example.test")).toBe(0);
    expect(lines.pop()).toBe("bob@example.test is already an admin.");
    lines = [];
    expect(await run("admin", "list")).toBe(0);
    expect(lines).toEqual(["ann@example.test", "bob@example.test"]);
    expect(await run("admin", "remove", "ann@example.test")).toBe(0);
    lines = [];
    expect(await run("admin")).toBe(0);
    expect(lines).toEqual(["bob@example.test"]);
    expect(await run("admin", "add", "not-an-address")).toBe(1);
  });

  it("explains what it can't change", async () => {
    readEnvironment({ ...process.env, ADMIN_ADDRESSES: "ann@example.test", SESSION_DAYS: "9" });
    expect(await run("admin", "add", "bob@example.test")).toBe(1);
    expect(errors.pop()).toMatch(/set by ADMIN_ADDRESSES in the environment/);
    expect(await run("settings", "set", "SESSION_DAYS", "3")).toBe(1);
    expect(errors.pop()).toMatch(/set by SESSION_DAYS in the environment/);
    expect(await run("settings", "set", "NOPE", "3")).toBe(1);
    expect(await run("settings", "set", "SESSION_DAYS")).toBe(2);
    expect(await run("frobnicate")).toBe(2);
  });

  it("waits for the server to upgrade a 0.1 data directory first", async () => {
    fs.writeFileSync(path.join(dir, "viauna.db"), "");
    expect(await run("admin", "add", "ann@example.test")).toBe(1);
    expect(errors.pop()).toMatch(/^Start Viauna once first/);
    expect(fs.existsSync(path.join(dir, "state.db"))).toBe(false);
  });
});
