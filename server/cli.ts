// The `viauna` command: change a server's settings and admins from its console, for
// example `docker exec viauna viauna admin add you@example.com`. It writes to the same
// state store as the server, which applies the change within seconds; it never touches
// the mail index or anything else the running server owns.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION, type SettingValue, config, lockedBy, parseSetting, setting, settingDef } from "./config.ts";
import { COMMAND_LINE, type SettingInfo, changeSettings, describeSettings, loadInstanceSettings, recentChanges } from "./instance.ts";
import { quietLogs } from "./log.ts";
import { configureSettingsBus } from "./settings-bus.ts";
import { copyStatePending } from "./storage.ts";
import { openState, setState, stateStore } from "./state/db.ts";

const USAGE = `Usage: viauna <command>

  settings                    every setting, its value, and where that comes from
  settings set NAME VALUE     change a setting; NAME as in the environment, e.g. ALLOWED_DOMAINS
                              (lists are comma-separated; "" is an empty list)
  settings reset NAME         put a setting back to its default
  admin list                  who can open the admin page
  admin add ADDRESS           let a mailbox open the admin page
  admin remove ADDRESS        stop a mailbox opening it
  changes                     recent changes, newest first
  version                     the version of Viauna

Settings set in the environment can only be changed there. Changes apply to the
running server at once.`;

export interface Output {
  out: (line: string) => void;
  err: (line: string) => void;
}

export class UsageError extends Error {}

const when = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export function formatValue(value: SettingValue | null, unit?: string): string {
  if (value === null) return "(default)";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") return unit ? `${value} ${unit}` : String(value);
  if (Array.isArray(value)) return value.length ? value.join(", ") : "(none)";
  return value === "" ? "(none)" : value;
}

function source(s: SettingInfo): string {
  if (s.source === "environment") return "set in the environment";
  if (s.source === "changed") return `changed by ${s.updatedBy}, ${when(s.updatedAt!)}`;
  return "default";
}

async function listSettings(io: Output) {
  const all = await describeSettings();
  const width = Math.max(...all.map((s) => s.env.length));
  let section = "";
  for (const s of all) {
    if (s.section !== section) {
      if (section) io.out("");
      section = s.section;
      io.out(section);
    }
    io.out(`  ${s.env.padEnd(width)}  ${formatValue(s.value, s.unit)}  (${source(s)})`);
  }
}

async function apply(patch: Record<string, unknown>, io: Output): Promise<boolean> {
  const result = await changeSettings(patch, COMMAND_LINE);
  if ("error" in result) {
    io.err(result.error);
    return false;
  }
  return true;
}

async function admins(args: string[], io: Output): Promise<number> {
  const [action, address] = args;
  const current = setting("admins");
  if (!action || action === "list") {
    if (!current.length) io.out("No admins yet. Add one with: viauna admin add you@example.com");
    for (const a of current) io.out(a);
    if (lockedBy("admins")) io.out("(set by ADMIN_ADDRESSES in the environment)");
    return 0;
  }
  if ((action !== "add" && action !== "remove") || !address) throw new UsageError();
  if (lockedBy("admins")) {
    io.err("Admins are set by ADMIN_ADDRESSES in the environment; change them there.");
    return 1;
  }
  const parsed = parseSetting(settingDef("admins")!, address);
  if ("error" in parsed) {
    io.err(parsed.error);
    return 1;
  }
  const [who] = parsed.value as string[];
  if (action === "add") {
    if (current.includes(who)) {
      io.out(`${who} is already an admin.`);
      return 0;
    }
    if (!(await apply({ admins: [...current, who] }, io))) return 1;
    io.out(`${who} can now open the admin page, at /admin once signed in.`);
    if (!config.imap) io.err("Note: no IMAP_HOST is set. Admins must sign in through this server's own mail server, so nobody can open the admin page until one is.");
  } else {
    if (!current.includes(who)) {
      io.out(`${who} isn't an admin.`);
      return 0;
    }
    if (!(await apply({ admins: current.filter((a) => a !== who) }, io))) return 1;
    io.out(`${who} is no longer an admin.`);
  }
  return 0;
}

async function settings(args: string[], io: Output): Promise<number> {
  const [action, name, ...rest] = args;
  if (!action || action === "list") {
    await listSettings(io);
    return 0;
  }
  if (action === "set" && name && rest.length === 1) {
    const def = settingDef(name);
    if (!def) {
      io.err(`There's no setting called ${name}. \`viauna settings\` lists them.`);
      return 1;
    }
    if (!(await apply({ [def.key]: rest[0] }, io))) return 1;
    io.out(`${def.env} is now ${formatValue(setting(def.key), def.type === "integer" ? def.unit : undefined)}.`);
    return 0;
  }
  if (action === "reset" && name && !rest.length) {
    const def = settingDef(name);
    if (!def) {
      io.err(`There's no setting called ${name}. \`viauna settings\` lists them.`);
      return 1;
    }
    if (!(await apply({ [def.key]: null }, io))) return 1;
    io.out(`${def.env} is back to its default, ${formatValue(setting(def.key), def.type === "integer" ? def.unit : undefined)}.`);
    return 0;
  }
  throw new UsageError();
}

async function changes(io: Output): Promise<number> {
  const list = await recentChanges(50);
  if (!list.length) io.out("No changes yet.");
  for (const c of list) {
    io.out(`${when(c.at)}  ${c.actor}: ${c.env} ${formatValue(c.oldValue)} -> ${formatValue(c.newValue)}`);
  }
  return 0;
}

export interface Where {
  dataDir: string;
  databaseUrl: string | undefined;
}

/** Opens the state store as the server would, but refuses while an upgrade is pending. */
async function open({ dataDir, databaseUrl }: Where): Promise<string | null> {
  if (fs.existsSync(path.join(dataDir, "viauna.db")) && !fs.existsSync(path.join(dataDir, "index.db"))) {
    return "Start Viauna once first: it upgrades this data directory from 0.1 on its first start.";
  }
  setState(await openState(databaseUrl, path.join(dataDir, "state.db")));
  configureSettingsBus(dataDir, databaseUrl);
  if (await copyStatePending(dataDir)) {
    return "Start Viauna once first: on its first start with DATABASE_URL, it copies state.db into that database.";
  }
  await loadInstanceSettings();
  return null;
}

async function close() {
  let store;
  try {
    store = stateStore();
  } catch {
    return;
  }
  await store.db.destroy();
  setState(null);
}

export async function main(argv: string[], io: Output, where: Where = { dataDir: config.dataDir, databaseUrl: config.databaseUrl }): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE);
    return command ? 0 : 2;
  }
  if (command === "version" || command === "--version") {
    io.out(VERSION);
    return 0;
  }
  if (!["settings", "admin", "admins", "changes"].includes(command)) {
    io.err(USAGE);
    return 2;
  }
  quietLogs();
  const problem = await open(where);
  try {
    if (problem) {
      io.err(problem);
      return 1;
    }
    if (command === "settings") return await settings(args, io);
    if (command === "changes") return await changes(io);
    return await admins(args, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(USAGE);
      return 2;
    }
    throw err;
  } finally {
    await close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) }).then(
    (code) => process.exit(code),
    (err) => {
      console.error((err as Error).message);
      process.exit(1);
    },
  );
}
