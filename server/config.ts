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

/** An http(s) address, which may hold an {email} (or {login}, {user}, {domain}) placeholder. */
function webAddress(name: string): string | undefined {
  const value = env(name);
  if (value === undefined) return undefined;
  let url: URL | null;
  try {
    url = new URL(value.replace(/\{(email|login|user|domain)\}/g, "x"));
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) throw new Error(`${name} must be an http:// or https:// address, got "${value}"`);
  return value;
}

/** Where a password change over LDAP goes (password.ts). */
export interface LdapTarget {
  url: string;
  /** For an ldap:// address: upgrade with StartTLS before sending any password. */
  startTls: boolean;
  /** Check the directory's certificate. */
  verify: boolean;
  /** The user's DN, from a template with {user}, {login} and {domain} in it. */
  userDn?: string;
  /** Or found by a search, as the service account if one is given. */
  search?: { base: string; filter: string; bindDn?: string; bindPassword?: string };
}

function ldapTarget(): LdapTarget | undefined {
  const url = env("PASSWORD_CHANGE_LDAP_URL");
  if (url === undefined) return undefined;
  const scheme = /^(ldaps?):\/\/[^/?#\s]+\/?$/i.exec(url)?.[1]?.toLowerCase();
  if (!scheme) throw new Error(`PASSWORD_CHANGE_LDAP_URL must be an ldap:// or ldaps:// address with no path, got "${url}"`);
  const placeholder = /\{(user|login)\}/;
  const userDn = env("PASSWORD_CHANGE_LDAP_USER_DN");
  const base = env("PASSWORD_CHANGE_LDAP_SEARCH_BASE");
  if (!userDn === !base) {
    throw new Error("With PASSWORD_CHANGE_LDAP_URL, set either PASSWORD_CHANGE_LDAP_USER_DN or PASSWORD_CHANGE_LDAP_SEARCH_BASE");
  }
  if (userDn && !placeholder.test(userDn)) throw new Error("PASSWORD_CHANGE_LDAP_USER_DN must contain {user} or {login}");
  const filter = env("PASSWORD_CHANGE_LDAP_SEARCH_FILTER", "(mail={login})")!;
  if (base && !placeholder.test(filter)) throw new Error("PASSWORD_CHANGE_LDAP_SEARCH_FILTER must contain {user} or {login}");
  const bindDn = env("PASSWORD_CHANGE_LDAP_BIND_DN");
  const bindPassword = env("PASSWORD_CHANGE_LDAP_BIND_PASSWORD");
  if (!bindDn !== !bindPassword) throw new Error("PASSWORD_CHANGE_LDAP_BIND_DN and PASSWORD_CHANGE_LDAP_BIND_PASSWORD go together");
  return {
    url,
    startTls: scheme === "ldap" && bool("PASSWORD_CHANGE_LDAP_STARTTLS", true),
    verify: bool("PASSWORD_CHANGE_LDAP_TLS_VERIFY", true),
    ...(userDn ? { userDn } : { search: { base: base!, filter, bindDn, bindPassword } }),
  };
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

/**
 * The ManageSieve server (RFC 5804) for filters and the vacation responder: unless
 * MANAGESIEVE_* say otherwise, the IMAP host on port 4190, with STARTTLS (or none if IMAP
 * has none), and the same certificate name and checking.
 */
function sieveEndpoint(imap: Endpoint | null): Endpoint | null {
  const host = env("MANAGESIEVE_HOST") ?? imap?.host;
  if (!host) return null;
  const sameHost = !env("MANAGESIEVE_HOST") || env("MANAGESIEVE_HOST") === imap?.host;
  return {
    host,
    port: int("MANAGESIEVE_PORT", 4190),
    security: env("MANAGESIEVE_SECURITY") ? security("MANAGESIEVE_SECURITY", "starttls") : imap?.security === "none" ? "none" : "starttls",
    servername: env("MANAGESIEVE_TLS_SERVERNAME") ?? (sameHost ? imap?.servername : undefined),
    verify: env("MANAGESIEVE_TLS_VERIFY") !== undefined ? bool("MANAGESIEVE_TLS_VERIFY", true) : (imap?.verify ?? true),
  };
}

/** Viauna's own sender (sender.ts): a mailbox the server sends from itself, with its SMTP server. */
export interface Sender {
  address: string;
  /** The From name; unset: APP_NAME at the time. */
  name: string | undefined;
  login: string;
  password: string | undefined;
  smtp: Endpoint;
}

/**
 * The sender, if SENDER_ADDRESS names one: by default it logs in as that address to the
 * SMTP server people send through (SMTP_HOST), unless SENDER_SMTP_* say otherwise.
 */
function senderConfig(smtp: Endpoint | null): Sender | null {
  const address = env("SENDER_ADDRESS");
  if (address === undefined) return null;
  if (!/^[^\s@<>",]+@[^\s@<>",]+$/.test(address)) throw new Error(`SENDER_ADDRESS must be an email address, got "${address}"`);
  const own = env("SENDER_SMTP_HOST");
  const sameHost = !own || own === smtp?.host;
  const host = own ?? smtp?.host;
  if (!host) throw new Error("SENDER_ADDRESS needs an SMTP server: set SMTP_HOST, or SENDER_SMTP_HOST");
  return {
    address,
    name: env("SENDER_NAME"),
    login: env("SENDER_LOGIN", address)!,
    password: env("SENDER_PASSWORD"),
    smtp: {
      host,
      port: int("SENDER_SMTP_PORT", sameHost && smtp ? smtp.port : 465),
      security: env("SENDER_SMTP_SECURITY") ? security("SENDER_SMTP_SECURITY", "tls") : sameHost && smtp ? smtp.security : "tls",
      servername: env("SENDER_SMTP_TLS_SERVERNAME") ?? (sameHost ? smtp?.servername : undefined),
      verify: env("SENDER_SMTP_TLS_VERIFY") !== undefined ? bool("SENDER_SMTP_TLS_VERIFY", true) : sameHost && smtp ? smtp.verify : true,
    },
  };
}

/** Stable JSON for an endpoint: part of an account's identity, so key order is fixed. */
export function endpointKey(e: Endpoint): string {
  return JSON.stringify({ host: e.host.toLowerCase(), port: e.port, security: e.security, servername: e.servername ?? null, verify: e.verify, ...(e.custom ? { custom: true } : {}) });
}

/**
 * Whether an account signed in through this server's own mail server (IMAP_HOST), not
 * one someone typed in at sign-in. Only these can be admins, change passwords through
 * the operator's systems, or sync with the operator's CardDAV server: anyone can run a
 * server that accepts any name, and a typed-in server's password isn't ours to send on.
 */
export function onOwnServer(account: { imap: Endpoint }): boolean {
  return !!config.imap && !account.imap.custom && endpointKey(account.imap) === endpointKey(config.imap);
}

/**
 * The address this server's own mail server vouched for when the account signed in: its
 * login, where that is the address it shows. Null otherwise. The address typed in at
 * sign-in proves nothing by itself, since a separate username can sign in to one mailbox
 * under another's address; so anything that reaches other people's mailboxes in this
 * mailbox's name (email reminders, answers and changes counted directly in other
 * mailboxes' calendars) goes by this, never by `email` alone or by an alias.
 */
export function verifiedAddress(account: { imap: Endpoint; login: string; email: string }): string | null {
  const address = account.email.toLowerCase();
  return onOwnServer(account) && account.login.toLowerCase() === address ? address : null;
}

// ------------------------------------------------------------ changeable settings

/** A link in the apps menu (LINKS): for everyone, or only in admins' mailboxes. */
export interface Link {
  label: string;
  url: string;
  for: "everyone" | "admins";
}

export type SettingValue = boolean | number | string | string[] | Link[];

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
  | (Common<"allowCustomServers" | "contacts" | "contactsSync" | "calendar" | "calendarFeeds" | "calendarSecrets" | "browserNotifications" | "filters" | "vacation" | "filterForwarding" | "sendAsServers", boolean> & { type: "boolean" })
  | (Common<"sessionDays" | "maxAccounts" | "maxUploadMb" | "cacheMb", number> & { type: "integer"; min: number; max: number; unit: string })
  | (Common<"appName", string> & { type: "text"; max: number; required?: boolean })
  | (Common<"admins" | "allowedDomains", string[]> & { type: "list"; item: "address" | "domain" })
  | (Common<"passwordChange" | "sendAs", string> & { type: "choice"; choices: { value: string; label: string }[] })
  | (Common<"links", Link[]> & { type: "links" });

export type SettingKey = SettingDef["key"];

export interface SettingValues {
  admins: string[];
  allowedDomains: string[];
  allowCustomServers: boolean;
  contacts: boolean;
  contactsSync: boolean;
  calendar: boolean;
  calendarFeeds: boolean;
  calendarSecrets: boolean;
  browserNotifications: boolean;
  filters: boolean;
  vacation: boolean;
  filterForwarding: boolean;
  sendAs: "confirm" | "server" | "off";
  sendAsServers: boolean;
  sessionDays: number;
  maxAccounts: number;
  maxUploadMb: number;
  cacheMb: number;
  appName: string;
  links: Link[];
  passwordChange: "off" | "link" | "command" | "webhook" | "ldap";
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
    key: "contacts", env: "CONTACTS", type: "boolean", default: true,
    section: "Features", label: "Contacts",
    help: "Each mailbox's address book, with vCard import and export, and suggestions from it while writing.",
  },
  {
    key: "contactsSync", env: "CONTACTS_SYNC", type: "boolean", default: true,
    section: "Features", label: "Contacts sync",
    help: "Keep each mailbox's contacts in step with your CardDAV server (CARDDAV_URL, set in the environment), signed in as the mailbox.",
  },
  {
    key: "calendar", env: "CALENDAR", type: "boolean", default: true,
    section: "Features", label: "Calendar",
    help: "Each mailbox's calendars, kept by Viauna in standard iCalendar.",
  },
  {
    key: "calendarFeeds", env: "CALENDAR_FEEDS", type: "boolean", default: true,
    section: "Features", label: "Calendars from the web",
    help: "Let people add a calendar by its address (public holidays, fixtures, another service's calendar), which this server fetches from the internet every 6 hours.",
  },
  {
    key: "calendarSecrets", env: "CALENDAR_SECRET_ADDRESSES", type: "boolean", default: true,
    section: "Features", label: "Secret calendar addresses",
    help: "Let people give a calendar a secret address, so another app can show it read-only: all of it, or only when they're busy. Anyone who has the address can see what it shows, without signing in.",
  },
  {
    key: "browserNotifications", env: "BROWSER_NOTIFICATIONS", type: "boolean", default: true,
    section: "Features", label: "Notifications with Viauna closed",
    help: "Let people have their browser show calendar reminders when no Viauna tab is open. They go, encrypted, through each browser's push service (Google's for Chrome, Mozilla's for Firefox, Apple's for Safari).",
  },
  {
    key: "filters", env: "FILTERS", type: "boolean", default: true,
    section: "Features", label: "Filters",
    help: "Rules that sort mail as it arrives, kept on your mail server as Sieve (over ManageSieve).",
  },
  {
    key: "filterForwarding", env: "FILTER_FORWARDING", type: "boolean", default: false,
    section: "Features", label: "Forwarding in filters",
    help: "Let a filter forward mail to another address. Off by default: a stolen session could otherwise send someone's mail elsewhere without a trace in their inbox.",
  },
  {
    key: "vacation", env: "VACATION", type: "boolean", default: true,
    section: "Features", label: "Vacation responder",
    help: "Automatic replies while someone is away, sent by your mail server.",
  },
  {
    key: "sendAs", env: "SEND_AS", type: "choice", default: "confirm",
    choices: [
      { value: "confirm", label: "Once a code emailed to the address is entered" },
      { value: "server", label: "Once your mail server accepts it as a sender" },
      { value: "off", label: "Only each mailbox's own address" },
    ],
    section: "Sending", label: "Sending as other addresses",
    help: "When someone can send from an address other than their mailbox's (Settings > Accounts > Send mail as). Choose your mail server only if it refuses senders a login doesn't own, as Mailu and mailcow do. Your mail server can refuse an address either way.",
  },
  {
    key: "sendAsServers", env: "SEND_AS_SERVERS", type: "boolean", default: false,
    section: "Sending", label: "Other providers' mail servers",
    help: "Let an address be sent through its own provider's mail server (SMTP), for an address at another provider, so the mail passes that provider's checks. This server then connects to the servers people enter. Each server's password is kept only in the browser session that entered it.",
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
    key: "links", env: "LINKS", type: "links", default: [],
    section: "Appearance", label: "Links",
    help: "Links in the apps menu (the four squares, top right), for everyone or only in admins' mailboxes: your mail server's own pages, a help page, an intranet. Each opens in a new tab.",
  },
  {
    key: "passwordChange", env: "PASSWORD_CHANGE", type: "choice", default: "off",
    choices: [
      { value: "off", label: "Off" },
      { value: "link", label: "A link to your mail server's own page" },
      { value: "command", label: "A command you provide" },
      { value: "webhook", label: "A webhook you provide" },
      { value: "ldap", label: "Your LDAP directory" },
    ],
    section: "Password changes", label: "Change password",
    help: "How people change their mailbox password, from Settings > Accounts. Where each one goes is set in the environment.",
  },
];

const MAX_LINKS = 20;
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
    case "links": {
      // From the API, a list; from the environment or the command line, that list as JSON.
      let items: unknown = input;
      if (text !== null) {
        try {
          items = text ? JSON.parse(text) : [];
        } catch {
          return { error: `${def.label} must be a JSON list, such as [{"label": "Mail admin", "url": "https://mail.example.com/admin", "for": "admins"}].` };
        }
      }
      if (!Array.isArray(items) || items.length > MAX_LINKS) return { error: `${def.label} must be a list of at most ${MAX_LINKS}.` };
      const out: Link[] = [];
      for (const item of items as Record<string, unknown>[]) {
        const label = String(item?.label ?? "").trim();
        const url = String(item?.url ?? "").trim();
        const audience = item?.for === undefined || item?.for === "everyone" ? "everyone" : item?.for === "admins" ? "admins" : null;
        if (!label || label.length > 60 || /[\x00-\x1f]/.test(label)) return { error: "Each link needs a label of at most 60 characters, on one line." };
        if (!/^https?:\/\//i.test(url) || url.length > 2000 || !URL.canParse(url)) return { error: `"${url}" isn't a web address (https://…).` };
        if (!audience) return { error: `A link is for "everyone" or for "admins".` };
        out.push({ label, url, for: audience });
      }
      return { value: out };
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
  managesieve: sieveEndpoint(endpoint("IMAP", 993)),
  /**
   * Viauna's own sender, for reminders by email (sender.ts); null if SENDER_ADDRESS isn't
   * set. Environment only: it holds a password.
   */
  sender: senderConfig(endpoint("SMTP", 465)),
  /** Custom servers and calendar feeds may not resolve to private/loopback addresses unless this is on. */
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
  /** A directory that changes the password with the LDAP Password Modify operation. */
  passwordLdap: ldapTarget(),

  /**
   * The CardDAV server contacts sync with (contacts-sync.ts), signed in as each mailbox
   * with its own password, so set only here. {login}, {user} and {domain} are filled in.
   */
  carddavUrl: webAddress("CARDDAV_URL"),

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
