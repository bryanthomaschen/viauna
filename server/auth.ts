// Sign-in is the mailbox's own IMAP login — Viauna has no user database of its own.
// A browser session can hold several mailboxes (Gmail's account switcher), each
// proven with its own password at sign-in.
import net from "node:net";
import { type Endpoint, type Security, config } from "./config.ts";
import {
  type Credentials,
  decryptCredentials,
  encryptCredentials,
  newSessionCookie,
  parseSessionCookie,
  sha256,
} from "./crypto.ts";
import { db } from "./db.ts";
import { verifyLogin } from "./imap/connection.ts";
import { markProven } from "./imap/pool.ts";
import { connectTarget } from "./netpolicy.ts";
import type { AccountInfo } from "./imap/runtime.ts";

export const COOKIE_NAME = "viauna_session";
const DAY = 86_400_000;

export interface SessionAccount {
  index: number;
  account: AccountInfo;
  credential: Uint8Array;
}

export interface AuthContext {
  sessionHash: string;
  cookieKey: string;
  accounts: SessionAccount[];
}

interface AccountRecord {
  id: number;
  login: string;
  email: string;
  imap: string;
  smtp: string;
}

export function accountInfo(row: AccountRecord): AccountInfo {
  return { id: row.id, login: row.login, email: row.email, imap: JSON.parse(row.imap), smtp: JSON.parse(row.smtp) };
}

/** Stable JSON for an endpoint: it is part of the account's identity. */
function endpointKey(e: Endpoint): string {
  return JSON.stringify({ host: e.host.toLowerCase(), port: e.port, security: e.security, servername: e.servername ?? null, verify: e.verify, ...(e.custom ? { custom: true } : {}) });
}

export function loadSession(cookie: string | undefined): AuthContext | null {
  const parsed = parseSessionCookie(cookie);
  if (!parsed) return null;
  const hash = sha256(parsed.sid);
  const now = Date.now();
  const session = db().get<{ id: string; seen_at: number; expires_at: number }>(
    "SELECT id, seen_at, expires_at FROM sessions WHERE id = ?",
    hash,
  );
  if (!session || session.expires_at < now) return null;
  if (now - session.seen_at > 3600_000) {
    // Sliding expiry, written at most hourly.
    db().run("UPDATE sessions SET seen_at = ?, expires_at = ? WHERE id = ?", now, now + config.sessionDays * DAY, hash);
  }
  const rows = db().all<AccountRecord & { credential: Uint8Array }>(
    `SELECT a.id, a.login, a.email, a.imap, a.smtp, sa.credential FROM session_accounts sa
     JOIN accounts a ON a.id = sa.account_id WHERE sa.session_id = ? ORDER BY sa.position`,
    hash,
  );
  return {
    sessionHash: hash,
    cookieKey: parsed.key,
    accounts: rows.map((r, index) => ({ index, account: accountInfo(r), credential: r.credential })),
  };
}

export function credentialsFor(ctx: AuthContext, sa: SessionAccount): Credentials | null {
  return decryptCredentials(sa.credential, ctx.cookieKey, ctx.sessionHash, sa.account.id);
}

// ------------------------------------------------------------------ rate limiting

const attempts = new Map<string, { count: number; reset: number }>();
const WINDOW = 15 * 60_000;

/**
 * Counts an attempt *before* the login is tried, so a burst of parallel requests
 * can't all slip under the limit while the first is still waiting on the server.
 * Returns false when the key is over its limit.
 */
function take(key: string, max: number): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.reset < now) {
    attempts.set(key, { count: 1, reset: now + WINDOW });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

/** A successful login doesn't count against the account or the address. */
function giveBack(key: string) {
  const entry = attempts.get(key);
  if (entry && entry.count > 0) entry.count--;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
}, 60_000).unref();

// ------------------------------------------------------------------ sign-in

export interface ServerInput {
  host: string;
  port: number;
  security: Security;
}

export interface SignInInput {
  email: string;
  password: string;
  /** Login name when it isn't the email address. */
  username?: string;
  imap?: ServerInput;
  smtp?: ServerInput;
}

export type SignInResult =
  | { ok: true; cookie?: string; index: number }
  | { ok: false; status: number; error: string };

/** A user-supplied server must be a public host, or it is a way to probe our network. */
async function checkCustomHost(host: string): Promise<string | null> {
  if (!/^[a-z0-9.-]{1,253}$/i.test(host) && !net.isIP(host)) return "That server name isn't valid.";
  try {
    await connectTarget({ host, port: 0, security: "tls", verify: true, custom: true });
  } catch (err) {
    return (err as Error).message;
  }
  return null;
}

function validPort(p: unknown): p is number {
  return typeof p === "number" && Number.isInteger(p) && p > 0 && p < 65536;
}

async function resolveEndpoints(input: SignInInput): Promise<{ imap: Endpoint; smtp: Endpoint } | { error: string }> {
  const custom = input.imap?.host || input.smtp?.host;
  if (custom) {
    if (!config.allowCustomServers) return { error: "This server only signs in to its own mail server." };
    const imap = input.imap;
    const smtp = input.smtp;
    if (!imap?.host || !smtp?.host || !validPort(imap.port) || !validPort(smtp.port)) {
      return { error: "Enter both the IMAP and SMTP server." };
    }
    for (const host of [imap.host, smtp.host]) {
      const problem = await checkCustomHost(host);
      if (problem) return { error: problem };
    }
    const sec = (s: Security): Security => (["tls", "starttls", "none"].includes(s) ? s : "tls");
    return {
      imap: { host: imap.host, port: imap.port, security: sec(imap.security), verify: true, custom: true },
      smtp: { host: smtp.host, port: smtp.port, security: sec(smtp.security), verify: true, custom: true },
    };
  }
  if (!config.imap || !config.smtp) {
    return { error: "No mail server is configured. Set IMAP_HOST and SMTP_HOST, or ALLOW_CUSTOM_SERVERS." };
  }
  return { imap: config.imap, smtp: config.smtp };
}

export async function signIn(
  input: SignInInput,
  existing: AuthContext | null,
  meta: { ip: string; userAgent: string },
): Promise<SignInResult> {
  const email = String(input.email ?? "").trim().toLowerCase();
  const password = String(input.password ?? "");
  const login = String(input.username ?? "").trim() || email;
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || !password) {
    return { ok: false, status: 400, error: "Enter your email address and password." };
  }
  if (config.allowedDomains.length) {
    // The login is what the mail server authenticates, so that is what must be in
    // an allowed domain — not just the address typed in the email box.
    const loginDomain = login.includes("@") ? login.split("@").pop()!.toLowerCase() : null;
    const ok = (d: string | null) => !!d && config.allowedDomains.includes(d);
    if (!ok(email.split("@")[1]) || !ok(loginDomain)) {
      return { ok: false, status: 403, error: "That address can't sign in here." };
    }
  }
  const loginKey = `login:${login.toLowerCase()}`;
  if (!take(`ip:${meta.ip}`, 20) || !take(loginKey, 8)) {
    return { ok: false, status: 429, error: "Too many attempts. Wait a few minutes and try again." };
  }
  if (existing && existing.accounts.length >= config.maxAccountsPerSession) {
    return { ok: false, status: 400, error: `You can be signed in to at most ${config.maxAccountsPerSession} accounts.` };
  }

  const endpoints = await resolveEndpoints(input);
  if ("error" in endpoints) return { ok: false, status: 400, error: endpoints.error };

  const creds: Credentials = { user: login, pass: password };
  const result = await verifyLogin(endpoints.imap, creds);
  if (!result.ok) {
    // A server we couldn't reach says nothing about the password.
    if (result.reason !== "auth") giveBack(loginKey);
    return { ok: false, status: result.reason === "auth" ? 401 : 502, error: result.message };
  }
  giveBack(loginKey);
  giveBack(`ip:${meta.ip}`);

  const now = Date.now();
  return db().tx(() => {
    const imapKey = endpointKey(endpoints.imap);
    db().run(
      `INSERT INTO accounts (login, email, imap, smtp, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (login, imap) DO UPDATE SET email = excluded.email, smtp = excluded.smtp`,
      login, email, imapKey, endpointKey(endpoints.smtp), now,
    );
    const account = db().get<{ id: number }>("SELECT id FROM accounts WHERE login = ? AND imap = ?", login, imapKey)!;
    markProven(account.id, creds);

    let cookie: string | undefined;
    let sessionHash: string;
    let cookieKey: string;
    if (existing) {
      sessionHash = existing.sessionHash;
      cookieKey = existing.cookieKey;
    } else {
      const fresh = newSessionCookie();
      cookie = fresh.value;
      sessionHash = sha256(fresh.sid);
      cookieKey = fresh.key;
      db().run(
        "INSERT INTO sessions (id, created_at, seen_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)",
        sessionHash, now, now, now + config.sessionDays * DAY, meta.userAgent.slice(0, 300), meta.ip,
      );
    }
    const credential = encryptCredentials(creds, cookieKey, sessionHash, account.id);
    const current = db().get<{ position: number }>(
      "SELECT position FROM session_accounts WHERE session_id = ? AND account_id = ?",
      sessionHash, account.id,
    );
    if (current) {
      db().run("UPDATE session_accounts SET credential = ? WHERE session_id = ? AND account_id = ?", credential, sessionHash, account.id);
    } else {
      const max = db().get<{ p: number | null }>("SELECT MAX(position) AS p FROM session_accounts WHERE session_id = ?", sessionHash);
      db().run(
        "INSERT INTO session_accounts (session_id, account_id, position, credential) VALUES (?, ?, ?, ?)",
        sessionHash, account.id, (max?.p ?? -1) + 1, credential,
      );
    }
    const ordered = db().all<{ account_id: number }>(
      "SELECT account_id FROM session_accounts WHERE session_id = ? ORDER BY position",
      sessionHash,
    );
    return { ok: true as const, cookie, index: ordered.findIndex((r) => r.account_id === account.id) };
  });
}

/** Signs one account out of the session; returns true if the session is now empty. */
export function signOutAccount(ctx: AuthContext, accountId: number): boolean {
  db().run("DELETE FROM session_accounts WHERE session_id = ? AND account_id = ?", ctx.sessionHash, accountId);
  const left = db().get<{ n: number }>("SELECT COUNT(*) AS n FROM session_accounts WHERE session_id = ?", ctx.sessionHash)!;
  if (left.n === 0) db().run("DELETE FROM sessions WHERE id = ?", ctx.sessionHash);
  return left.n === 0;
}

export function signOutAll(ctx: AuthContext) {
  db().run("DELETE FROM sessions WHERE id = ?", ctx.sessionHash);
}

setInterval(() => {
  db().run("DELETE FROM sessions WHERE expires_at < ?", Date.now());
}, 3600_000).unref();
