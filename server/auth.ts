// Sign-in is the mailbox's own IMAP login — Viauna has no user database of its own.
// A browser session can hold several mailboxes (Gmail's account switcher), each
// proven with its own password at sign-in.
import type { Transaction } from "kysely";
import { type Endpoint, type Security, config, endpointKey, setting } from "./config.ts";
import {
  type Credentials,
  decryptCredentials,
  encryptCredentials,
  newSessionCookie,
  parseSessionCookie,
  sha256,
} from "./crypto.ts";
import { verifyLogin } from "./imap/connection.ts";
import { markProven, stopRuntime } from "./imap/pool.ts";
import { ensureIndexAccount } from "./imap/store.ts";
import { checkCustomHost } from "./netpolicy.ts";
import type { AccountInfo } from "./imap/runtime.ts";
import { log } from "./log.ts";
import { passwordChangeFor, runPasswordChange } from "./password.ts";
import { type StateSchema, state, stateStore, toNumber } from "./state/db.ts";

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
  /** The expiry moved on just now: the browser's cookie should too. */
  extended?: boolean;
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

export async function loadSession(cookie: string | undefined): Promise<AuthContext | null> {
  const parsed = parseSessionCookie(cookie);
  if (!parsed) return null;
  const hash = sha256(parsed.sid);
  const now = Date.now();
  const session = await state()
    .selectFrom("sessions")
    .select(["id", "seen_at", "expires_at"])
    .where("id", "=", hash)
    .executeTakeFirst();
  if (!session || session.expires_at < now) return null;
  const extended = now - session.seen_at > 3600_000;
  if (extended) {
    // Sliding expiry, written at most hourly.
    await state()
      .updateTable("sessions")
      .set({ seen_at: now, expires_at: now + config.sessionDays * DAY })
      .where("id", "=", hash)
      .execute();
  }
  const rows = await state()
    .selectFrom("session_accounts as sa")
    .innerJoin("accounts as a", "a.id", "sa.account_id")
    .select(["a.id", "a.login", "a.email", "a.imap", "a.smtp", "sa.credential"])
    .where("sa.session_id", "=", hash)
    .orderBy("sa.position")
    .execute();
  for (const r of rows) ensureIndexAccount(r);
  return {
    sessionHash: hash,
    cookieKey: parsed.key,
    accounts: rows.map((r, index) => ({ index, account: accountInfo(r), credential: r.credential })),
    extended,
  };
}

export function credentialsFor(ctx: AuthContext, sa: SessionAccount): Credentials | null {
  return decryptCredentials(sa.credential, ctx.cookieKey, ctx.sessionHash, sa.account.id);
}

/**
 * Keeps the password for an address's own mail server (identities.ts) with the mailbox's in
 * this session, encrypted the same way, so only this browser can use it and it goes when
 * the session does; null forgets it. Returns the session's credentials as they now are.
 */
export async function keepServerPassword(ctx: AuthContext, sa: SessionAccount, identityId: number, server: Credentials | null): Promise<Credentials> {
  const creds = credentialsFor(ctx, sa);
  if (!creds) throw new Error("This session's sign-in for the mailbox can't be read.");
  const servers = { ...creds.servers };
  if (server) servers[identityId] = { user: server.user, pass: server.pass };
  else delete servers[identityId];
  const next: Credentials = { ...creds, servers };
  const credential = encryptCredentials(next, ctx.cookieKey, ctx.sessionHash, sa.account.id);
  await state()
    .updateTable("session_accounts")
    .set({ credential })
    .where("session_id", "=", ctx.sessionHash)
    .where("account_id", "=", sa.account.id)
    .execute();
  sa.credential = credential;
  return next;
}

// ------------------------------------------------------------------ rate limiting

const attempts = new Map<string, { count: number; reset: number }>();
const WINDOW = 15 * 60_000;

/**
 * Counts an attempt *before* the login is tried, so a burst of parallel requests
 * can't all slip under the limit while the first is still waiting on the server.
 * Returns false when the key is over its limit.
 */
export function take(key: string, max: number): boolean {
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
  const imapKey = endpointKey(endpoints.imap);
  const { account, cookie, index } = await state().transaction().execute(async (trx) => {
    const account = await upsertAccount(trx, {
      login, email, imap: imapKey, imap_hash: sha256(imapKey), smtp: endpointKey(endpoints.smtp), settings: "{}", created_at: now,
    });

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
      await trx
        .insertInto("sessions")
        .values({ id: sessionHash, created_at: now, seen_at: now, expires_at: now + config.sessionDays * DAY, user_agent: meta.userAgent.slice(0, 300), ip: meta.ip })
        .execute();
    }
    const credential = encryptCredentials(creds, cookieKey, sessionHash, account.id);
    const current = await trx
      .selectFrom("session_accounts")
      .select("position")
      .where("session_id", "=", sessionHash)
      .where("account_id", "=", account.id)
      .executeTakeFirst();
    if (current) {
      await trx
        .updateTable("session_accounts")
        .set({ credential })
        .where("session_id", "=", sessionHash)
        .where("account_id", "=", account.id)
        .execute();
    } else {
      const max = await trx
        .selectFrom("session_accounts")
        .select((eb) => eb.fn.max("position").as("p"))
        .where("session_id", "=", sessionHash)
        .executeTakeFirst();
      const position = max?.p === null || max?.p === undefined ? 0 : toNumber(max.p) + 1;
      await trx.insertInto("session_accounts").values({ session_id: sessionHash, account_id: account.id, position, credential }).execute();
    }
    const ordered = await trx
      .selectFrom("session_accounts")
      .select("account_id")
      .where("session_id", "=", sessionHash)
      .orderBy("position")
      .execute();
    return { account, cookie, index: ordered.findIndex((r) => r.account_id === account.id) };
  });
  ensureIndexAccount(account);
  markProven(account.id, creds);
  return { ok: true, cookie, index };
}

/** Creates the account, or refreshes its address and SMTP server if it exists. */
async function upsertAccount(trx: Transaction<StateSchema>, values: Omit<AccountRecord, "id"> & { imap_hash: string; settings: string; created_at: number }) {
  const insert = trx.insertInto("accounts").values(values);
  const update = { email: values.email, smtp: values.smtp };
  await (stateStore().dialect === "mysql"
    ? insert.onDuplicateKeyUpdate(update)
    : insert.onConflict((oc) => oc.columns(["login", "imap_hash"]).doUpdateSet(update))
  ).execute();
  return trx
    .selectFrom("accounts")
    .select(["id", "login", "email", "imap", "smtp"])
    .where("login", "=", values.login)
    .where("imap_hash", "=", values.imap_hash)
    .executeTakeFirstOrThrow();
}

// ------------------------------------------------------------------ password change

export type PasswordChangeResult = { ok: true; signedOut: number } | { ok: false; status: number; error: string };

const MIN_PASSWORD = 8;

/**
 * Changes the mailbox password through the operator's command or webhook (password.ts),
 * after checking the current one with the mail server. Then this session keeps working
 * with the new password, and every other session signed in to the mailbox is signed out
 * of it, as after a password change anywhere else.
 */
export async function changePassword(
  ctx: AuthContext,
  sa: SessionAccount,
  input: { current?: unknown; next?: unknown },
  meta: { ip: string },
): Promise<PasswordChangeResult> {
  const how = passwordChangeFor(sa.account);
  if (!how || how.method !== "form") return { ok: false, status: 400, error: "Password changes aren't available here." };
  const current = typeof input.current === "string" ? input.current : "";
  const next = typeof input.next === "string" ? input.next : "";
  if (!current) return { ok: false, status: 400, error: "Enter your current password." };
  if (next.length < MIN_PASSWORD) return { ok: false, status: 400, error: `Use at least ${MIN_PASSWORD} characters.` };
  if (next.length > 1024) return { ok: false, status: 400, error: "That password is too long." };
  if (next === current) return { ok: false, status: 400, error: "Choose a password different from your current one." };

  const { login, email } = sa.account;
  const key = `password:${login.toLowerCase()}`;
  if (!take(`ip:${meta.ip}`, 20) || !take(key, 5)) {
    return { ok: false, status: 429, error: "Too many attempts. Wait a few minutes and try again." };
  }
  const check = await verifyLogin(sa.account.imap, { user: login, pass: current });
  if (!check.ok) {
    if (check.reason !== "auth") giveBack(key);
    return check.reason === "auth"
      ? { ok: false, status: 400, error: "Your current password isn't right." }
      : { ok: false, status: 502, error: check.message };
  }

  const result = await runPasswordChange({ login, email, currentPassword: current, newPassword: next });
  if (!result.ok) return { ok: false, status: 400, error: result.error };
  giveBack(key);
  giveBack(`ip:${meta.ip}`);

  // Other addresses' server passwords stay with this session; the others are signed out.
  const creds: Credentials = { ...credentialsFor(ctx, sa), user: login, pass: next };
  const credential = encryptCredentials(creds, ctx.cookieKey, ctx.sessionHash, sa.account.id);
  const signedOut = await state().transaction().execute(async (trx) => {
    await trx
      .updateTable("session_accounts")
      .set({ credential })
      .where("session_id", "=", ctx.sessionHash)
      .where("account_id", "=", sa.account.id)
      .execute();
    const others = (
      await trx
        .selectFrom("session_accounts")
        .select("session_id")
        .where("account_id", "=", sa.account.id)
        .where("session_id", "!=", ctx.sessionHash)
        .execute()
    ).map((r) => r.session_id);
    if (!others.length) return 0;
    await trx.deleteFrom("session_accounts").where("account_id", "=", sa.account.id).where("session_id", "in", others).execute();
    // A session that held only this mailbox is now empty: end it.
    const left = new Set(
      (await trx.selectFrom("session_accounts").select("session_id").where("session_id", "in", others).execute()).map((r) => r.session_id),
    );
    const empty = others.filter((id) => !left.has(id));
    if (empty.length) await trx.deleteFrom("sessions").where("id", "in", empty).execute();
    return others.length;
  });
  // The running sync still logs in with the old password; start it afresh. The new
  // one is proven on first use, like any other.
  await stopRuntime(sa.account.id);
  log.info("password changed", { account: sa.account.id, method: setting("passwordChange"), otherSessionsSignedOut: signedOut });
  return { ok: true, signedOut };
}

/** Signs one account out of the session; returns true if the session is now empty. */
export async function signOutAccount(ctx: AuthContext, accountId: number): Promise<boolean> {
  return state().transaction().execute(async (trx) => {
    await trx.deleteFrom("session_accounts").where("session_id", "=", ctx.sessionHash).where("account_id", "=", accountId).execute();
    const left = await trx
      .selectFrom("session_accounts")
      .select((eb) => eb.fn.countAll().as("n"))
      .where("session_id", "=", ctx.sessionHash)
      .executeTakeFirst();
    if (toNumber(left?.n) > 0) return false;
    await trx.deleteFrom("sessions").where("id", "=", ctx.sessionHash).execute();
    return true;
  });
}

export async function signOutAll(ctx: AuthContext) {
  await state().deleteFrom("sessions").where("id", "=", ctx.sessionHash).execute();
}

/** Whether this session is still signed in to the account and unexpired. */
export async function isSignedIn(sessionHash: string, accountId: number): Promise<boolean> {
  const row = await state()
    .selectFrom("session_accounts as sa")
    .innerJoin("sessions as s", "s.id", "sa.session_id")
    .select("sa.account_id")
    .where("sa.session_id", "=", sessionHash)
    .where("sa.account_id", "=", accountId)
    .where("s.expires_at", ">", Date.now())
    .executeTakeFirst();
  return !!row;
}

setInterval(() => {
  state()
    .deleteFrom("sessions")
    .where("expires_at", "<", Date.now())
    .execute()
    .catch((err) => log.warn("expired session cleanup failed", { error: (err as Error).message }));
}, 3600_000).unref();
