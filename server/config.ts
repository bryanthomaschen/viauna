// Every setting can come from the environment, so the same image runs anywhere. See
// docs/self-hosting/configuration.md for the operator-facing description of each.
//
// Those in SETTINGS can also be changed while Viauna runs, from the admin page or the
// command line (instance.ts); a value given in the environment wins and locks it. The
// rest are read once, from the environment only: where to listen and keep data, the
// mail server (it is part of each account's identity), and anything that could run
// code, reach the internal network or send people's passwords somewhere, so that a
// stolen admin session can't do any of those.
import path from "node:path";
import pkg from "../package.json" with { type: "json" };

/** The release, or for an edge build the release it follows and its commit (see build-server.mjs). */
export const VERSION = process.env.VIAUNA_VERSION || pkg.version;

export type Security = "tls" | "starttls" | "none";

export interface Endpoint {
  host: string;
  port: number;
  security: Security;
  /** TLS server name to verify against when `host` is an internal alias or an IP. */
  servername?: string;
  /** Verify the server's certificate. Only ever false for development servers. */
  verify: boolean;
  /** Entered by a user (ALLOW_CUSTOM_SERVERS), so re-vetted before every connection. */
  custom?: boolean;
}

function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

const TRUE = ["1", "true", "yes", "on"];
const FALSE = ["0", "false", "no", "off"];

function bool(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (value === undefined) return fallback;
  if (TRUE.includes(value.toLowerCase())) return true;
  if (FALSE.includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be true or false, got "${value}"`);
}

function int(name: string, fallback: number): number {
  const value = env(name);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${value}"`);
  return n;
}

/** An http(s) address, which may hold an {email} placeholder. */
function webAddress(name: string): string | undefined {
  const value = env(name);
  if (value === undefined) return undefined;
  let url: URL | null;
  try {
    url = new URL(value.replaceAll("{email}", "x"));
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) throw new Error(`${name} must be an http:// or https:// address, got "${value}"`);
  return value;
}

function security(name: string, fallback: Security): Security {
  const value = (env(name) ?? fallback).toLowerCase();
  if (value === "tls" || value === "starttls" || value === "none") return value;
  throw new Error(`${name} must be one of tls, starttls, none — got "${value}"`);
}

function endpoint(prefix: "IMAP" | "SMTP", defaultPort: number): Endpoint | null {
  const host = env(`${prefix}_HOST`);
  if (!host) return null;
  return {
    host,
    port: int(`${prefix}_PORT`, defaultPort),
    security: security(`${prefix}_SECURITY`, "tls"),
    servername: env(`${prefix}_TLS_SERVERNAME`),
    verify: bool(`${prefix}_TLS_VERIFY`, true),
  };
}

/** Stable JSON for an endpoint: part of an account's identity, so key order is fixed. */
export function endpointKey(e: Endpoint): string {
  return JSON.stringify({ host: e.host.toLowerCase(), port: e.port, security: e.security, servername: e.servername ?? null, verify: e.verify, ...(e.custom ? { custom: true } : {}) });
}

// ------------------------------------------------------------ changeable settings

export type SettingValue = boolean | number | string | string[];

interface Common<K extends string, V extends SettingValue> {
  key: K;
  /** The environment variable that sets it, and locks it. */
  env: string;
  default: V;
  section: string;
  label: string;
  help: string;
}

export type SettingDef =
  | (Common<"allowCustomServers", boolean> & { type: "boolean" })
  | (Common<"sessionDays" | "maxAccounts" | "maxUploadMb" | "cacheMb", number> & { type: "integer"; min: number; max: number; unit: string })
  | (Common<"appName", string> & { type: "text"; max: number; required?: boolean })
  | (Common<"admins" | "allowedDomains", string[]> & { type: "list"; item: "address" | "domain" })
  | (Common<"passwordChange", string> & { type: "choice"; choices: { value: string; label: string }[] });

export type SettingKey = SettingDef["key"];

export interface SettingValues {
  admins: string[];
  allowedDomains: string[];
  allowCustomServers: boolean;
  sessionDays: number;
  maxAccounts: number;
  maxUploadMb: number;
  cacheMb: number;
  appName: string;
  passwordChange: "off" | "link" | "command" | "webhook";
}

/** In the order the admin page and `viauna settings` show them. */
export const SETTINGS: readonly SettingDef[] = [
  {
    key: "admins", env: "ADMIN_ADDRESSES", type: "list", item: "address", default: [],
    section: "Admins", label: "Admin mailboxes",
    help: "Mailbox addresses that can open the admin page, signed in through this server's own mail server.",
  },
  {
    key: "allowedDomains", env: "ALLOWED_DOMAINS", type: "list", item: "domain", default: [],
    section: "Who can sign in", label: "Allowed domains",
    help: "Only addresses in these domains can sign in. Empty: any address your mail server accepts.",
  },
  {
    key: "allowCustomServers", env: "ALLOW_CUSTOM_SERVERS", type: "boolean", default: false,
    section: "Who can sign in", label: "Other mail servers",
    help: "Let people enter their own IMAP and SMTP servers, and a username, on the sign-in page.",
  },
  {
    key: "sessionDays", env: "SESSION_DAYS", type: "integer", min: 1, max: 3650, unit: "days", default: 30,
    section: "Sessions and limits", label: "Session length",
    help: "How long a session lasts without a visit. Each visit extends it.",
  },
  {
    key: "maxAccounts", env: "MAX_ACCOUNTS", type: "integer", min: 1, max: 100, unit: "accounts", default: 10,
    section: "Sessions and limits", label: "Accounts per browser",
    help: "Mailboxes one browser can be signed in to at once.",
  },
  {
    key: "maxUploadMb", env: "MAX_UPLOAD_MB", type: "integer", min: 1, max: 10240, unit: "MB", default: 25,
    section: "Sessions and limits", label: "Largest attachment",
    help: "Your reverse proxy and mail server must accept messages at least this big.",
  },
  {
    key: "cacheMb", env: "CACHE_MB", type: "integer", min: 0, max: 10_000_000, unit: "MB", default: 1024,
    section: "Sessions and limits", label: "Message cache",
    help: "Disk space for downloaded messages, so opening them again is instant.",
  },
  {
    key: "appName", env: "APP_NAME", type: "text", max: 60, required: true, default: "Viauna",
    section: "Appearance", label: "Name",
    help: "Shown in the title bar and on the sign-in page.",
  },
  {
    key: "passwordChange", env: "PASSWORD_CHANGE", type: "choice", default: "off",
    choices: [
      { value: "off", label: "Off" },
      { value: "link", label: "A link to your mail server's own page" },
      { value: "command", label: "A command you provide" },
      { value: "webhook", label: "A webhook you provide" },
    ],
    section: "Password changes", label: "Change password",
    help: "How people change their mailbox password, from Settings > Accounts. Where each one goes is set in the environment.",
  },
];

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const ADDRESS = /^[^\s@,]+@[^\s@,]+$/;

export function settingDef(name: string): SettingDef | undefined {
  return SETTINGS.find((d) => d.key === name || d.env === name.toUpperCase());
}

/**
 * Checks a value for a setting and puts it in its stored form. Accepts what the API
 * sends (booleans, numbers, arrays) and what the environment and the command line
 * send (strings).
 */
export function parseSetting(def: SettingDef, input: unknown): { value: SettingValue } | { error: string } {
  const text = typeof input === "string" ? input.trim() : null;
  switch (def.type) {
    case "boolean": {
      if (typeof input === "boolean") return { value: input };
      if (text !== null && TRUE.includes(text.toLowerCase())) return { value: true };
      if (text !== null && FALSE.includes(text.toLowerCase())) return { value: false };
      return { error: `${def.label} must be on or off.` };
    }
    case "integer": {
      const n = typeof input === "number" ? input : text ? Number(text) : NaN;
      if (!Number.isInteger(n) || n < def.min || n > def.max) {
        return { error: `${def.label} must be a whole number from ${def.min} to ${def.max.toLocaleString("en")} ${def.unit}.` };
      }
      return { value: n };
    }
    case "text": {
      if (text === null) return { error: `${def.label} must be text.` };
      if (def.required && !text) return { error: `${def.label} can't be empty.` };
      if (text.length > def.max || /[\x00-\x1f]/.test(text)) return { error: `${def.label} must be at most ${def.max} characters, on one line.` };
      return { value: text };
    }
    case "list": {
      const items = Array.isArray(input) ? input : text !== null ? text.split(",") : null;
      if (!items || items.length > 1000) return { error: `${def.label} must be a list.` };
      const out: string[] = [];
      for (const item of items) {
        if (typeof item !== "string") return { error: `${def.label} must be a list of text.` };
        let v = item.trim().toLowerCase();
        if (def.item === "domain") v = v.replace(/^@/, "");
        if (!v) continue;
        if (def.item === "domain" ? !DOMAIN.test(v) : !ADDRESS.test(v)) {
          return { error: `"${item.trim()}" isn't ${def.item === "domain" ? "a domain" : "an email address"}.` };
        }
        if (!out.includes(v)) out.push(v);
      }
      return { value: out };
    }
    case "choice": {
      const choice = def.choices.find((c) => c.value === text);
      return choice ? { value: choice.value } : { error: `${def.label} must be one of ${def.choices.map((c) => c.value).join(", ")}.` };
    }
  }
}

/** Settings given in the environment: they win, and can't be changed while running. */
let fromEnv = new Map<SettingKey, SettingValue>();
/** Settings changed from the admin page or the command line (instance.ts keeps it current). */
let overrides = new Map<SettingKey, SettingValue>();

/** Reads the changeable settings from the environment; throws on an invalid value. */
export function readEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const next = new Map<SettingKey, SettingValue>();
  for (const def of SETTINGS) {
    const raw = source[def.env];
    if (raw === undefined || raw === "") continue;
    const parsed = parseSetting(def, raw);
    if ("error" in parsed) throw new Error(`${def.env}=${JSON.stringify(raw)}: ${parsed.error}`);
    next.set(def.key, parsed.value);
  }
  fromEnv = next;
}

export function setOverrides(values: Map<SettingKey, SettingValue>) {
  overrides = values;
}

/** The environment variable that locks this setting, if it's set. */
export function lockedBy(key: SettingKey): string | null {
  return fromEnv.has(key) ? SETTINGS.find((d) => d.key === key)!.env : null;
}

export function setting<K extends SettingKey>(key: K): SettingValues[K] {
  const value = fromEnv.get(key) ?? overrides.get(key) ?? SETTINGS.find((d) => d.key === key)!.default;
  return value as SettingValues[K];
}

readEnvironment();

// ------------------------------------------------------------ the configuration

const dataDir = path.resolve(env("DATA_DIR", "./data")!);

export const config = {
  host: env("HOST", "127.0.0.1")!,
  port: int("PORT", 3000),
  dataDir,
  /** Where accounts, sessions and settings live: unset for SQLite in DATA_DIR, or a postgres:// / mysql:// URL. */
  databaseUrl: env("DATABASE_URL"),
  /** Public origin, e.g. https://mail.example.com. Used for the CSRF origin check. */
  publicUrl: env("PUBLIC_URL"),
  /** Trust X-Forwarded-For / X-Forwarded-Proto from a reverse proxy. */
  trustProxy: bool("TRUST_PROXY", false),
  /** Mark cookies Secure. Defaults on unless PUBLIC_URL is plain http. */
  secureCookies: bool("SECURE_COOKIES", !(env("PUBLIC_URL") ?? "").startsWith("http://")),

  imap: endpoint("IMAP", 993),
  smtp: endpoint("SMTP", 465),
  /** Custom servers may not resolve to private/loopback addresses unless this is on. */
  allowPrivateServers: bool("ALLOW_PRIVATE_SERVERS", false),

  // Where password changes go (password.ts). Set only here: a page that could change
  // them could send everyone to a page or a program that collects passwords.
  /** The mail server's own password page; {email} is replaced with the address. */
  passwordChangeUrl: webAddress("PASSWORD_CHANGE_URL"),
  /** Run with a JSON request on stdin to change a password. */
  passwordCommand: env("PASSWORD_CHANGE_COMMAND"),
  /** POSTed a signed JSON request to change a password. */
  passwordWebhook: env("PASSWORD_CHANGE_WEBHOOK"),
  passwordWebhookSecret: env("PASSWORD_CHANGE_WEBHOOK_SECRET"),

  logLevel: env("LOG_LEVEL", "info")!,

  // Changeable while running (SETTINGS above), so read on every use.
  get appName() {
    return setting("appName");
  },
  get allowCustomServers() {
    return setting("allowCustomServers");
  },
  /** Domains allowed to sign in; empty means any. */
  get allowedDomains() {
    return setting("allowedDomains");
  },
  get sessionDays() {
    return setting("sessionDays");
  },
  get maxAccountsPerSession() {
    return setting("maxAccounts");
  },
  get maxUploadBytes() {
    return setting("maxUploadMb") * 1024 * 1024;
  },
  /** Disk cache for downloaded messages, in bytes. */
  get cacheBytes() {
    return setting("cacheMb") * 1024 * 1024;
  },
};

if (config.passwordWebhook && !config.passwordWebhookSecret) {
  throw new Error("PASSWORD_CHANGE_WEBHOOK needs PASSWORD_CHANGE_WEBHOOK_SECRET, so the webhook can tell Viauna's requests from anyone else's");
}

export type Config = typeof config;
