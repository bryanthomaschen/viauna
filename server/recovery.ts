// Getting back in (design/mailbox-administration.md): a recovery email address and backup
// codes, set up while signed in (Settings > Accounts) and used from the sign-in page's
// "Forgot password?"; and an admin's one-time reset link, for someone with neither.
//
// Viauna resets nothing itself. Once someone has proven who they are, it asks the
// operator's backend to set the new password (password.ts, "setPassword"), then signs that
// mailbox out everywhere and sends notices from its own sender (SENDER_ADDRESS).
//
// Kept in the state store: the recovery address; the code waiting for it (to confirm the
// address, or to reset the password), with when it expires and the wrong tries; backup
// codes; and one-time reset tokens. Codes and tokens only as keyed hashes (HMAC-SHA256
// with the server secret), so a copy of the database alone can't be used to test guesses.
//
// "Forgot password?" answers the same whether or not a mailbox exists or has recovery set
// up, and sends its email after answering, so neither its words nor its timing tell
// anyone which mailboxes do.
import crypto from "node:crypto";
import { MIN_PASSWORD, newPasswordProblem } from "./breach.ts";
import { giveBack, take } from "./auth.ts";
import { config, endpointKey, onOwnServer, setting, verifiedAddress } from "./config.ts";
import { getServerSecret, sha256 } from "./crypto.ts";
import { verifyLogin } from "./imap/connection.ts";
import { stopRuntime } from "./imap/pool.ts";
import type { AccountInfo } from "./imap/runtime.ts";
import { log } from "./log.ts";
import { canReset, runPasswordReset } from "./password.ts";
import { sendAsSender } from "./sender.ts";
import { state } from "./state/db.ts";

export class RecoveryError extends Error {
  status: 400 | 404 | 410 | 429 | 502;
  constructor(message: string, status: 400 | 404 | 410 | 429 | 502 = 400) {
    super(message);
    this.status = status;
  }
}

export const RECOVERY_LIMITS = {
  /** A code to confirm a recovery address works this long. */
  confirmMinutes: 60,
  /** A code emailed for a reset, and the token any proof gives, work this long. */
  resetMinutes: 15,
  /** An admin's reset link works this long. */
  adminLinkHours: 24,
  /** Wrong tries at one emailed code before it's void. */
  tries: 5,
  /** Codes emailed for one mailbox a day, to confirm or to reset. */
  codesPerDay: 5,
  resendAfterMs: 60_000,
  backupCodes: 10,
};

const DAY = 86_400_000;
const MINUTE = 60_000;
const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const WRONG_CODE = "That code isn't right, or it has expired.";
const LINK_GONE = "This reset has expired or was already used. Start again.";

/** HMAC-SHA256 with the server secret, under a label that says what it's for. */
const keyed = (...parts: (string | number)[]) => crypto.createHmac("sha256", getServerSecret()).update(`viauna:${parts.join(":")}`).digest("hex");
const codeHash = (accountId: number, purpose: string, code: string) => keyed("recovery-code", "v1", accountId, purpose, code);
const backupHash = (accountId: number, code: string) => keyed("backup-code", "v1", accountId, code);
const tokenHash = (token: string) => keyed("reset-token", "v1", token);

// Crockford's base32: no I, L, O or U, so a code read aloud or copied by hand survives.
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** "7KQ2M-9XDR4": 50 random bits, in two groups. */
function newBackupCode(): string {
  const bytes = crypto.randomBytes(10);
  const chars = [...bytes].map((b) => BASE32[b & 31]).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

/** As typed: any case, spaces and dashes, and the letters people mistake for digits. */
export function normalizeBackupCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

const isEmailedCode = (input: string) => /^\d{8}$/.test(input.replace(/[\s-]/g, ""));

// ------------------------------------------------------------ who

type OwnAccount = { id: number; login: string; email: string };

/** The account on this server's own mail server with this login or address, if it ever signed in here. */
async function ownAccount(address: string): Promise<OwnAccount | null> {
  if (!config.imap) return null;
  const imapHash = sha256(endpointKey(config.imap));
  const row = await state()
    .selectFrom("accounts")
    .select(["id", "login", "email"])
    .where("imap_hash", "=", imapHash)
    .where((eb) => eb.or([eb("login", "=", address), eb("email", "=", address)]))
    .orderBy("id")
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Whether "Forgot password?" is offered here, and with which methods: each is the admin's
 * to turn off (PASSWORD_RECOVERY_EMAIL, PASSWORD_RECOVERY_CODES), and both need a backend
 * that can reset passwords; a recovery address also needs a sender to email codes from.
 */
export async function recoveryOffered(): Promise<{ offered: boolean; email: boolean; codes: boolean }> {
  const resets = !!config.imap && (await canReset());
  const email = resets && setting("recoveryEmail") && !!config.sender;
  const codes = resets && setting("recoveryCodes");
  return { offered: email || codes, email, codes };
}

function cleanAddress(input: unknown): string {
  return String(input ?? "").trim().toLowerCase();
}

/** Re-proves the mailbox password before recovery is changed, counted like a password change. */
async function provePassword(account: AccountInfo, password: unknown, ip: string): Promise<void> {
  const pass = typeof password === "string" ? password : "";
  if (!pass) throw new RecoveryError("Enter your password.");
  const key = `password:${account.login.toLowerCase()}`;
  if (!take(`ip:${ip}`, 20) || !take(key, 5)) throw new RecoveryError("Too many attempts. Wait a few minutes and try again.", 429);
  const check = await verifyLogin(account.imap, { user: account.login, pass });
  if (!check.ok) {
    if (check.reason !== "auth") giveBack(key);
    throw check.reason === "auth" ? new RecoveryError("Your password isn't right.") : new RecoveryError(check.message, 502);
  }
  giveBack(key);
  giveBack(`ip:${ip}`);
}

// ------------------------------------------------------------ mail

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const spaced = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;
const when = (at: number) => new Date(at).toUTCString().replace("GMT", "UTC");

function mail(subject: string, paragraphs: string[], code?: string) {
  const text = paragraphs.join("\n\n").replace("{code}", code ? `    ${spaced(code)}` : "");
  const html = paragraphs
    .map((p) => (p === "{code}" && code ? `<p style="font-size:24px;letter-spacing:2px;margin:16px 0"><b>${spaced(code)}</b></p>` : `<p>${escape(p)}</p>`))
    .join("");
  return { subject, text, html };
}

/** A notice from Viauna's own sender; if there's none, or it fails, that's only logged. */
async function notify(to: string | null, content: { subject: string; text: string; html: string }, what: string) {
  if (!to || !config.sender) return;
  try {
    await sendAsSender(to, content);
  } catch (err) {
    log.warn("recovery notice not sent", { what, error: (err as Error).message });
  }
}

/** The mailbox's own address, for notices: as its mail server vouched for it. */
async function mailboxAddress(accountId: number): Promise<string | null> {
  const row = await state().selectFrom("accounts").select(["login", "email", "imap"]).where("id", "=", accountId).executeTakeFirst();
  return row ? verifiedAddress({ ...row, imap: JSON.parse(row.imap) }) : null;
}

const STRAIGHT_AWAY = "If this wasn't you, change your password now, or ask whoever runs this mail server for help.";

// ------------------------------------------------------------ setting it up

export interface RecoveryStatus {
  /** Recovery can be set up for this mailbox, one way or another. */
  offered: boolean;
  /** A recovery address can be used (turned on, and Viauna has a sender to email codes from). */
  emailOffered: boolean;
  /** Backup codes can be used. */
  codesOffered: boolean;
  address: string | null;
  confirmed: boolean;
  /** When a code to confirm the address went; null if none is waiting. */
  codeSentAt: number | null;
  backupCodes: { left: number; total: number; createdAt: number } | null;
}

export async function recoveryStatus(account: AccountInfo): Promise<RecoveryStatus> {
  const { offered, email, codes: codesOn } = await recoveryOffered();
  const here = offered && onOwnServer(account);
  const row = await state().selectFrom("recovery_addresses").selectAll().where("account_id", "=", account.id).executeTakeFirst();
  const codes = await state().selectFrom("backup_codes").select(["used_at", "created_at"]).where("account_id", "=", account.id).execute();
  const waiting = !!row && !row.confirmed_at && row.code_purpose === "confirm" && (row.code_expires_at ?? 0) > Date.now() && row.code_tries < RECOVERY_LIMITS.tries;
  return {
    offered: here,
    emailOffered: here && email,
    codesOffered: here && codesOn,
    address: row?.address ?? null,
    confirmed: !!row?.confirmed_at,
    codeSentAt: waiting ? row!.code_sent_at : null,
    backupCodes: codes.length ? { left: codes.filter((c) => !c.used_at).length, total: codes.length, createdAt: Math.min(...codes.map((c) => Number(c.created_at))) } : null,
  };
}

async function mustBeOffered(account: AccountInfo, method: "email" | "codes") {
  const status = await recoveryStatus(account);
  if (!(method === "email" ? status.emailOffered : status.codesOffered)) {
    throw new RecoveryError(method === "email" ? "Recovery by email isn't available here." : "Backup codes aren't available here.", 404);
  }
  return status;
}

/**
 * Emails a new code to the recovery address, for confirming it or for a reset, within the
 * limits. `quiet`: over a limit, send nothing and say nothing (Forgot password? must
 * answer the same either way).
 */
async function sendCode(accountId: number, purpose: "confirm" | "reset", subjectFor: (code: string) => ReturnType<typeof mail>, quiet: boolean) {
  const row = await state().selectFrom("recovery_addresses").selectAll().where("account_id", "=", accountId).executeTakeFirst();
  if (!row) return;
  const now = Date.now();
  const day = Math.floor(now / DAY);
  const today = row.codes_day === day ? row.codes_sent : 0;
  const fail = (message: string) => {
    if (!quiet) throw new RecoveryError(message, 429);
  };
  if (row.code_sent_at && now - row.code_sent_at < RECOVERY_LIMITS.resendAfterMs) return fail("A code went less than a minute ago. Wait a moment.");
  if (today >= RECOVERY_LIMITS.codesPerDay) return fail(`${RECOVERY_LIMITS.codesPerDay} codes went to ${row.address} today. Try again tomorrow.`);
  const code = String(crypto.randomInt(0, 100_000_000)).padStart(8, "0");
  const minutes = purpose === "confirm" ? RECOVERY_LIMITS.confirmMinutes : RECOVERY_LIMITS.resetMinutes;
  await state()
    .updateTable("recovery_addresses")
    .set({ code_hash: codeHash(accountId, purpose, code), code_purpose: purpose, code_expires_at: now + minutes * MINUTE, code_tries: 0, code_sent_at: now, codes_day: day, codes_sent: today + 1 })
    .where("account_id", "=", accountId)
    .execute();
  try {
    await sendAsSender(row.address, subjectFor(code));
  } catch (err) {
    log.warn("recovery code not sent", { purpose, error: (err as Error).message });
    if (!quiet) throw new RecoveryError("The code couldn't be sent. Try again later.", 502);
  }
}

const confirmMail = (mailbox: string, address: string) => (code: string) =>
  mail(`${spaced(code)} is your code to confirm ${address}`, [
    `${mailbox} asked to use ${address} to get back in if its password is forgotten. To allow it, enter this code in Settings > Accounts, under Recovery:`,
    "{code}",
    `It works for ${RECOVERY_LIMITS.confirmMinutes} minutes. If you didn't ask for this, ignore this message: ${address} isn't used without the code.`,
  ], code);

/** Sets (or replaces) the recovery address and emails it a code; it's used only once confirmed. */
export async function setRecoveryAddress(account: AccountInfo, input: { password?: unknown; address?: unknown }, meta: { ip: string }): Promise<RecoveryStatus> {
  await mustBeOffered(account, "email");
  const address = cleanAddress(input.address);
  if (!ADDRESS.test(address) || address.length > 320) throw new RecoveryError("Enter an email address, such as you@example.com.");
  if (address === account.email.toLowerCase() || address === account.login.toLowerCase()) {
    throw new RecoveryError("Use an address other than this mailbox's: you'd need it to get back in.");
  }
  await provePassword(account, input.password, meta.ip);
  const now = Date.now();
  const existing = await state().selectFrom("recovery_addresses").select(["address", "codes_day", "codes_sent", "code_sent_at"]).where("account_id", "=", account.id).executeTakeFirst();
  if (existing) {
    // A new address starts unconfirmed; the day's count of codes carries over.
    await state()
      .updateTable("recovery_addresses")
      .set({ address, confirmed_at: null, code_hash: null, code_purpose: null, code_expires_at: null, code_tries: 0, ...(existing.address !== address ? { code_sent_at: null } : {}) })
      .where("account_id", "=", account.id)
      .execute();
  } else {
    await state().insertInto("recovery_addresses").values({ account_id: account.id, address, created_at: now }).execute();
  }
  await sendCode(account.id, "confirm", confirmMail(account.email, address), false);
  return recoveryStatus(account);
}

export async function resendConfirmation(account: AccountInfo): Promise<RecoveryStatus> {
  await mustBeOffered(account, "email");
  const row = await state().selectFrom("recovery_addresses").select(["address", "confirmed_at"]).where("account_id", "=", account.id).executeTakeFirst();
  if (!row || row.confirmed_at) throw new RecoveryError("There's no address waiting to be confirmed.");
  await sendCode(account.id, "confirm", confirmMail(account.email, row.address), false);
  return recoveryStatus(account);
}

/**
 * Checks an emailed code against the one waiting for this purpose. The try is counted
 * before the code is compared, so tries in parallel can't get past the limit.
 */
async function takeCode(accountId: number, purpose: "confirm" | "reset", input: string): Promise<boolean> {
  const code = input.replace(/[\s-]/g, "");
  const row = await state().selectFrom("recovery_addresses").selectAll().where("account_id", "=", accountId).executeTakeFirst();
  const expected = codeHash(accountId, purpose, /^\d{8}$/.test(code) ? code : "x");
  if (!row || row.code_purpose !== purpose || !row.code_hash || (row.code_expires_at ?? 0) < Date.now()) return false;
  const took = await state()
    .updateTable("recovery_addresses")
    .set((eb) => ({ code_tries: eb("code_tries", "+", 1) }))
    .where("account_id", "=", accountId)
    .where("code_tries", "<", RECOVERY_LIMITS.tries)
    .executeTakeFirst();
  if (!Number(took.numUpdatedRows)) return false;
  if (!/^\d{8}$/.test(code) || !crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(row.code_hash, "hex"))) return false;
  // Used: it can't be used again, and the wait between codes (which stops a second one
  // while this one was waiting) is over. The day's count still holds.
  await state().updateTable("recovery_addresses").set({ code_hash: null, code_purpose: null, code_expires_at: null, code_tries: 0, code_sent_at: null }).where("account_id", "=", accountId).execute();
  return true;
}

export async function confirmRecoveryAddress(account: AccountInfo, input: { code?: unknown }): Promise<RecoveryStatus> {
  await mustBeOffered(account, "email");
  const row = await state().selectFrom("recovery_addresses").select(["address", "code_tries"]).where("account_id", "=", account.id).executeTakeFirst();
  if (!row) throw new RecoveryError("Add a recovery address first.");
  if (!(await takeCode(account.id, "confirm", String(input.code ?? "")))) {
    const left = RECOVERY_LIMITS.tries - row.code_tries - 1;
    throw new RecoveryError(left > 0 ? `That code isn't right, or it has expired. ${left === 1 ? "One more try" : `${left} more tries`}.` : "That code isn't right. Send a new one.");
  }
  await state().updateTable("recovery_addresses").set({ confirmed_at: Date.now() }).where("account_id", "=", account.id).execute();
  log.info("recovery address confirmed", { account: account.id });
  void notify(await mailboxAddress(account.id), mail(`${row.address} can now reset your password`, [
    `${row.address} was confirmed as the recovery address for ${account.email}: a code sent to it can now be used to choose a new password.`,
    `${STRAIGHT_AWAY} Remove the address in Settings > Accounts, under Recovery.`,
  ]), "address confirmed");
  return recoveryStatus(account);
}

/** Allowed even with recovery turned off: it can only take a way in away. */
export async function removeRecoveryAddress(account: AccountInfo, input: { password?: unknown }, meta: { ip: string }): Promise<RecoveryStatus> {
  const row = await state().selectFrom("recovery_addresses").select(["address", "confirmed_at"]).where("account_id", "=", account.id).executeTakeFirst();
  if (!row) return recoveryStatus(account);
  await provePassword(account, input.password, meta.ip);
  await state().deleteFrom("recovery_addresses").where("account_id", "=", account.id).execute();
  log.info("recovery address removed", { account: account.id });
  if (row.confirmed_at) {
    void notify(await mailboxAddress(account.id), mail("Your recovery address was removed", [
      `${row.address} is no longer the recovery address for ${account.email}.`,
      STRAIGHT_AWAY,
    ]), "address removed");
  }
  return recoveryStatus(account);
}

/** Makes a new set of backup codes, which voids the old; they're shown once, now. */
export async function newBackupCodes(account: AccountInfo, input: { password?: unknown }, meta: { ip: string }): Promise<{ codes: string[]; status: RecoveryStatus }> {
  await mustBeOffered(account, "codes");
  await provePassword(account, input.password, meta.ip);
  const codes = Array.from({ length: RECOVERY_LIMITS.backupCodes }, newBackupCode);
  const now = Date.now();
  const had = await state().transaction().execute(async (trx) => {
    const old = await trx.deleteFrom("backup_codes").where("account_id", "=", account.id).executeTakeFirst();
    await trx
      .insertInto("backup_codes")
      .values(codes.map((c) => ({ account_id: account.id, code_hash: backupHash(account.id, normalizeBackupCode(c)), created_at: now })))
      .execute();
    return Number(old.numDeletedRows) > 0;
  });
  log.info("backup codes made", { account: account.id, replaced: had });
  void notify(await mailboxAddress(account.id), mail(had ? "New backup codes were made" : "Backup codes were made", [
    `${RECOVERY_LIMITS.backupCodes} backup codes were made for ${account.email}; each can be used once to choose a new password.${had ? " The old ones no longer work." : ""}`,
    `${STRAIGHT_AWAY} Make new ones in Settings > Accounts, under Recovery, which voids these.`,
  ]), "backup codes made");
  return { codes, status: await recoveryStatus(account) };
}

// ------------------------------------------------------------ Forgot password?

async function mustBeOfferedPublicly() {
  const offered = await recoveryOffered();
  if (!offered.offered) throw new RecoveryError("Recovery isn't available here.", 404);
  return offered;
}

/**
 * Step 1: someone typed an address. If it has a confirmed recovery address, a code goes
 * there, after the answer. The answer is the same whatever the address.
 */
export async function startRecovery(input: { email?: unknown }, meta: { ip: string }): Promise<void> {
  const { email } = await mustBeOfferedPublicly();
  if (!take(`recover-ip:${meta.ip}`, 10)) throw new RecoveryError("Too many attempts. Wait a few minutes and try again.", 429);
  const address = cleanAddress(input.email);
  if (!ADDRESS.test(address)) throw new RecoveryError("Enter your email address.");
  void (async () => {
    const account = await ownAccount(address);
    if (!account || !email) return;
    const row = await state().selectFrom("recovery_addresses").select(["confirmed_at"]).where("account_id", "=", account.id).executeTakeFirst();
    if (!row?.confirmed_at) return;
    await sendCode(account.id, "reset", (code) =>
      mail(`${spaced(code)} is your code to reset the password for ${account.email}`, [
        `Someone, hopefully you, asked to choose a new password for ${account.email}. To go on, enter this code on the sign-in page:`,
        "{code}",
        `It works for ${RECOVERY_LIMITS.resetMinutes} minutes. If it wasn't you, ignore this message: the password stays as it is.`,
      ], code), true);
  })().catch((err) => log.warn("recovery code not sent", { error: (err as Error).message }));
}

/**
 * Step 2: a code, emailed or a backup code. Right, it gives a one-time token to choose
 * the new password with; wrong, the same answer whatever was wrong.
 */
export async function verifyRecovery(input: { email?: unknown; code?: unknown }, meta: { ip: string }): Promise<{ token: string; email: string; expiresAt: number }> {
  const offered = await mustBeOfferedPublicly();
  const address = cleanAddress(input.email);
  const code = String(input.code ?? "").trim();
  if (!code) throw new RecoveryError("Enter the code.");
  if (!take(`ip:${meta.ip}`, 20) || !take(`recover:${address}`, 8)) throw new RecoveryError("Too many attempts. Wait a few minutes and try again.", 429);
  const account = await ownAccount(address);
  let method: "email" | "backup" | null = null;
  if (account && isEmailedCode(code)) {
    if (offered.email && (await takeCode(account.id, "reset", code))) method = "email";
  } else if (account && offered.codes) {
    const hash = backupHash(account.id, normalizeBackupCode(code));
    const used = await state()
      .updateTable("backup_codes")
      .set({ used_at: Date.now() })
      .where("account_id", "=", account.id)
      .where("code_hash", "=", hash)
      .where("used_at", "is", null)
      .executeTakeFirst();
    if (Number(used.numUpdatedRows)) method = "backup";
  } else {
    backupHash(0, normalizeBackupCode(code)); // the same work either way
  }
  if (!account || !method) throw new RecoveryError(WRONG_CODE);
  giveBack(`recover:${address}`);
  log.info("recovery proven", { account: account.id, method });
  return issueToken({ login: account.login, email: account.email, reason: "reset", createdBy: `recovery:${method}`, minutes: RECOVERY_LIMITS.resetMinutes });
}

async function issueToken(t: { login: string; email: string; reason: "reset" | "admin"; createdBy: string; minutes: number }) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + t.minutes * MINUTE;
  await state()
    .insertInto("password_resets")
    .values({ token_hash: tokenHash(token), login: t.login, email: t.email, reason: t.reason, created_by: t.createdBy, created_at: now, expires_at: expiresAt })
    .execute();
  return { token, email: t.email, expiresAt };
}

async function liveToken(token: unknown) {
  const t = typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  if (!t) return null;
  const row = await state().selectFrom("password_resets").selectAll().where("token_hash", "=", tokenHash(t)).executeTakeFirst();
  return row && !row.used_at && row.expires_at > Date.now() ? row : null;
}

/** For the reset page: whose password the token is for, so it can say so. */
export async function resetTokenInfo(token: unknown): Promise<{ email: string; reason: string; expiresAt: number }> {
  const row = await liveToken(token);
  if (!row) throw new RecoveryError(LINK_GONE, 410);
  return { email: row.email, reason: row.reason, expiresAt: row.expires_at };
}

/** Signs the mailbox out of every session, and stops its sync, which used the old password. */
async function signOutEverywhere(login: string): Promise<number> {
  if (!config.imap) return 0;
  const imapHash = sha256(endpointKey(config.imap));
  const ids = (await state().selectFrom("accounts").select("id").where("login", "=", login).where("imap_hash", "=", imapHash).execute()).map((r) => r.id);
  if (!ids.length) return 0;
  const signedOut = await state().transaction().execute(async (trx) => {
    const sessions = [...new Set((await trx.selectFrom("session_accounts").select("session_id").where("account_id", "in", ids).execute()).map((r) => r.session_id))];
    if (!sessions.length) return 0;
    await trx.deleteFrom("session_accounts").where("account_id", "in", ids).execute();
    const left = new Set((await trx.selectFrom("session_accounts").select("session_id").where("session_id", "in", sessions).execute()).map((r) => r.session_id));
    const empty = sessions.filter((s) => !left.has(s));
    if (empty.length) await trx.deleteFrom("sessions").where("id", "in", empty).execute();
    return sessions.length;
  });
  for (const id of ids) await stopRuntime(id);
  return signedOut;
}

/**
 * Step 3: the new password, with the token from step 2 or an admin's link. The backend
 * sets it; then every session of the mailbox ends, other tokens for it are void, and
 * notices go to the mailbox and its recovery address.
 */
export async function finishReset(input: { token?: unknown; password?: unknown }, meta: { ip: string }): Promise<{ email: string }> {
  if (!take(`ip:${meta.ip}`, 20)) throw new RecoveryError("Too many attempts. Wait a few minutes and try again.", 429);
  const row = await liveToken(input.token);
  if (!row) throw new RecoveryError(LINK_GONE, 410);
  const password = typeof input.password === "string" ? input.password : "";
  if (password.length < MIN_PASSWORD) throw new RecoveryError(`Use at least ${MIN_PASSWORD} characters.`);
  const problem = await newPasswordProblem(password);
  if (problem) throw new RecoveryError(problem);
  const by = row.reason === "admin" ? row.created_by : "recovery";
  const result = await runPasswordReset({ login: row.login, email: row.email, newPassword: password, reason: row.reason === "admin" ? "admin" : "reset", by });
  if (!result.ok) throw new RecoveryError(result.error, 502);
  const now = Date.now();
  // This one and any other waiting for the mailbox: done.
  await state().updateTable("password_resets").set({ used_at: now }).where("login", "=", row.login).where("used_at", "is", null).execute();
  const signedOut = await signOutEverywhere(row.login);
  giveBack(`ip:${meta.ip}`);
  log.info("password reset", { by: row.reason === "admin" ? "admin" : row.created_by, signedOut });

  const how =
    row.reason === "admin" ? `a reset link from ${row.created_by}` : row.created_by === "recovery:backup" ? "one of your backup codes" : "a code sent to your recovery address";
  const notice = mail("Your password was reset", [
    `The password for ${row.email} was changed on ${when(now)}, using ${how}.`,
    "Every browser signed in to it has been signed out, and your mail apps will ask for the new password.",
    "If this wasn't you, ask whoever runs this mail server for help straight away.",
  ]);
  const account = await ownAccount(row.login);
  const mailbox = account ? await mailboxAddress(account.id) : row.login === row.email ? row.email : null;
  void notify(mailbox, notice, "password reset");
  if (account) {
    const recovery = await state().selectFrom("recovery_addresses").select(["address", "confirmed_at"]).where("account_id", "=", account.id).executeTakeFirst();
    if (recovery?.confirmed_at) void notify(recovery.address, notice, "password reset, to the recovery address");
  }
  return { email: row.email };
}

// ------------------------------------------------------------ an admin's reset link

/**
 * A one-time link, good for a day, for someone with no recovery set up: they choose their
 * own password, which the admin never sees. Recorded in Recent changes.
 */
export async function createResetLink(admin: AccountInfo, input: { address?: unknown }): Promise<{ path: string; email: string; expiresAt: number }> {
  if (!(await canReset())) {
    throw new RecoveryError("Passwords can't be reset here: set MAILBOX_ADMIN to a command, webhook or directory that can.", 400);
  }
  const address = cleanAddress(input.address);
  if (!ADDRESS.test(address) || address.length > 320) throw new RecoveryError("Enter the mailbox's address, such as ann@example.com.");
  const domain = address.split("@").pop()!;
  if (config.allowedDomains.length && !config.allowedDomains.includes(domain)) throw new RecoveryError("That address can't sign in here.");
  const account = await ownAccount(address);
  const login = account?.login ?? address;
  const { token, expiresAt } = await issueToken({ login, email: account?.email ?? address, reason: "admin", createdBy: admin.login, minutes: RECOVERY_LIMITS.adminLinkHours * 60 });
  await state()
    .insertInto("admin_log")
    .values({ at: Date.now(), actor: admin.login, setting: "Password reset link", old_value: null, new_value: JSON.stringify(address) })
    .execute();
  log.info("reset link made", { by: admin.login });
  return { path: `/reset#${token}`, email: account?.email ?? address, expiresAt };
}

/** Tokens that can no longer be used are cleared away hourly, a day after they lapse. */
setInterval(() => {
  state()
    .deleteFrom("password_resets")
    .where("expires_at", "<", Date.now() - DAY)
    .execute()
    .catch((err) => log.warn("expired reset cleanup failed", { error: (err as Error).message }));
}, 3_600_000).unref();
