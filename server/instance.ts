// The instance's own settings: those in config.ts's SETTINGS, changed from the admin
// page or the command line while Viauna runs. They live in the state store, so every
// instance sharing a database sees them, and each re-reads them every few seconds (a
// change from the command line, another process, lands the same way). A setting given
// in the environment wins and can't be changed here. Every change is recorded in
// admin_log, with who made it, for the admin page's list of recent changes.
import {
  type Endpoint,
  type SettingDef,
  type SettingKey,
  type SettingValue,
  SETTINGS,
  VERSION,
  config,
  endpointKey,
  lockedBy,
  parseSetting,
  setOverrides,
  setting,
  settingDef,
} from "./config.ts";
import type { AccountInfo } from "./imap/runtime.ts";
import { log } from "./log.ts";
import { state, stateStore } from "./state/db.ts";

/** Who made a change from the console, in the record of changes. */
export const COMMAND_LINE = "command line";

/** How often each instance re-reads the settings, so changes made elsewhere apply. */
const RELOAD_MS = 10_000;

const sameValue = (a: SettingValue, b: SettingValue) => JSON.stringify(a) === JSON.stringify(b);

interface Stored {
  value: SettingValue;
  updatedAt: number;
  updatedBy: string;
}

/** Stored values that still pass validation; one an older version allowed is skipped. */
async function readStored(): Promise<Map<SettingKey, Stored>> {
  const rows = await state().selectFrom("instance_settings").selectAll().execute();
  const out = new Map<SettingKey, Stored>();
  for (const row of rows) {
    const def = SETTINGS.find((d) => d.key === row.name);
    if (!def) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(row.value);
    } catch {
      raw = undefined;
    }
    const parsed = parseSetting(def, raw);
    if ("error" in parsed) {
      log.warn("ignoring a stored setting that is no longer valid", { setting: def.env, error: parsed.error });
      continue;
    }
    out.set(def.key, { value: parsed.value, updatedAt: row.updated_at, updatedBy: row.updated_by });
  }
  return out;
}

export async function loadInstanceSettings() {
  const stored = await readStored();
  setOverrides(new Map([...stored].map(([k, s]) => [k, s.value])));
}

/** Keeps this instance's settings current; returns a function that stops it. */
export function watchInstanceSettings(ms = RELOAD_MS): () => void {
  const timer = setInterval(() => {
    loadInstanceSettings().catch((err) => log.warn("couldn't re-read the settings", { error: (err as Error).message }));
  }, ms);
  timer.unref();
  return () => clearInterval(timer);
}

export interface SettingInfo {
  key: SettingKey;
  env: string;
  type: SettingDef["type"];
  section: string;
  label: string;
  help: string;
  value: SettingValue;
  default: SettingValue;
  /** "environment": set there, and locked; "changed": from the admin page or command line. */
  source: "environment" | "changed" | "default";
  updatedAt: number | null;
  updatedBy: string | null;
  min?: number;
  max?: number;
  unit?: string;
  choices?: { value: string; label: string }[];
}

export async function describeSettings(): Promise<SettingInfo[]> {
  const stored = await readStored();
  return SETTINGS.map((def) => {
    const s = stored.get(def.key);
    const locked = lockedBy(def.key);
    return {
      key: def.key,
      env: def.env,
      type: def.type,
      section: def.section,
      label: def.label,
      help: def.help,
      value: setting(def.key),
      default: def.default,
      source: locked ? "environment" : s ? "changed" : "default",
      updatedAt: !locked && s ? s.updatedAt : null,
      updatedBy: !locked && s ? s.updatedBy : null,
      ...(def.type === "integer" ? { min: def.min, max: def.max, unit: def.unit } : {}),
      ...(def.type === "choice" ? { choices: def.choices } : {}),
    };
  });
}

export type ChangeResult = { changed: SettingKey[] } | { error: string; setting?: string };

/**
 * Applies a set of changes, all or none: `{ name: value }`, where the name is the
 * setting's key or its environment variable, and a null value puts it back to its
 * default. Each change is recorded with `actor`.
 */
export async function changeSettings(patch: Record<string, unknown>, actor: string): Promise<ChangeResult> {
  const changes: { def: SettingDef; value: SettingValue | null }[] = [];
  for (const [name, input] of Object.entries(patch)) {
    const def = settingDef(name);
    if (!def) return { error: `There's no setting called ${name}.`, setting: name };
    const env = lockedBy(def.key);
    if (env) return { error: `${def.label} is set by ${env} in the environment; change it there.`, setting: def.key };
    if (input === null) {
      changes.push({ def, value: null });
      continue;
    }
    const parsed = parseSetting(def, input);
    if ("error" in parsed) return { error: parsed.error, setting: def.key };
    changes.push({ def, value: parsed.value });
  }

  const now = Date.now();
  const changed: SettingKey[] = [];
  await state().transaction().execute(async (trx) => {
    for (const { def, value } of changes) {
      const row = await trx.selectFrom("instance_settings").select("value").where("name", "=", def.key).executeTakeFirst();
      const before = row ? (JSON.parse(row.value) as SettingValue) : null;
      // A value equal to the default is stored all the same: it was chosen, and it
      // should stay put if a later version changes the default.
      if (before === null ? value === null : value !== null && sameValue(before, value)) continue;
      if (value === null) {
        await trx.deleteFrom("instance_settings").where("name", "=", def.key).execute();
      } else {
        const values = { name: def.key, value: JSON.stringify(value), updated_at: now, updated_by: actor };
        const update = { value: values.value, updated_at: now, updated_by: actor };
        const insert = trx.insertInto("instance_settings").values(values);
        await (stateStore().dialect === "mysql"
          ? insert.onDuplicateKeyUpdate(update)
          : insert.onConflict((oc) => oc.column("name").doUpdateSet(update))
        ).execute();
      }
      await trx
        .insertInto("admin_log")
        .values({
          at: now,
          actor,
          setting: def.key,
          old_value: before === null ? null : JSON.stringify(before),
          new_value: value === null ? null : JSON.stringify(value),
        })
        .execute();
      changed.push(def.key);
    }
  });
  if (changed.length) {
    log.info("settings changed", { by: actor, settings: changed.map((k) => settingDef(k)!.env) });
    await loadInstanceSettings();
  }
  return { changed };
}

export interface ChangeRecord {
  at: number;
  actor: string;
  setting: string;
  label: string;
  env: string;
  /** null: the default. */
  oldValue: SettingValue | null;
  newValue: SettingValue | null;
}

export async function recentChanges(limit = 25): Promise<ChangeRecord[]> {
  const rows = await state().selectFrom("admin_log").selectAll().orderBy("at", "desc").orderBy("id", "desc").limit(limit).execute();
  const json = (v: string | null) => (v === null ? null : (JSON.parse(v) as SettingValue));
  return rows.map((r) => {
    const def = settingDef(r.setting);
    return {
      at: r.at,
      actor: r.actor,
      setting: r.setting,
      label: def?.label ?? r.setting,
      env: def?.env ?? r.setting,
      oldValue: json(r.old_value),
      newValue: json(r.new_value),
    };
  });
}

/**
 * Whether an account may use the admin page: its login is an admin's, and it signed in
 * through this server's own mail server. A login on a server someone entered at sign-in
 * proves nothing, since anyone can run a server that accepts any password for any name.
 * The login is compared, not the address typed: it's what the mail server checked.
 */
export function isAdmin(account: AccountInfo): boolean {
  if (!config.imap || account.imap.custom) return false;
  if (endpointKey(account.imap) !== endpointKey(config.imap)) return false;
  return setting("admins").includes(account.login);
}

const describeEndpoint = (e: Endpoint | null) =>
  e && `${e.host}:${e.port}, ${{ tls: "TLS", starttls: "STARTTLS", none: "unencrypted" }[e.security]}${e.verify ? "" : ", certificate not checked"}`;

/**
 * What the environment fixed, for the admin page: the settings no admin can change.
 * Secrets and commands are reported as set or not, never shown.
 */
export function serverFacts() {
  const store = stateStore();
  return {
    version: VERSION,
    imap: describeEndpoint(config.imap),
    smtp: describeEndpoint(config.smtp),
    database: store.dialect === "sqlite" ? `SQLite, ${store.where}` : `${store.dialect === "postgres" ? "PostgreSQL" : "MySQL/MariaDB"}, ${store.where}`,
    dataDir: config.dataDir,
    publicUrl: config.publicUrl ?? null,
    trustProxy: config.trustProxy,
    allowPrivateServers: config.allowPrivateServers,
    passwordUrl: config.passwordChangeUrl ?? null,
    passwordCommand: !!config.passwordCommand,
    passwordWebhook: !!config.passwordWebhook,
  };
}
