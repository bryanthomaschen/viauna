// Changing and resetting mailbox passwords. Viauna keeps no passwords of its own, so it
// hands each request to whatever the operator chose with MAILBOX_ADMIN (PASSWORD_CHANGE
// before 0.7; see design/mailbox-administration.md):
//
//   link     the mail server's own page (MAILBOX_ADMIN_URL); Viauna only links to it, so
//            it changes passwords and never resets one
//   command  MAILBOX_ADMIN_COMMAND, run with the request as JSON on its stdin
//   webhook  MAILBOX_ADMIN_WEBHOOK, POSTed the request as JSON, signed with
//            MAILBOX_ADMIN_WEBHOOK_SECRET
//   ldap     MAILBOX_ADMIN_LDAP_URL: a change binds as the user with the current password,
//            then the standard Password Modify operation (RFC 3062), so the directory applies
//            its own policy and hashing; a reset, only with MAILBOX_ADMIN_LDAP_RESET, binds
//            as the service account and names the user's entry
//
// Every request to a command or webhook says what it's for in `action`: "changePassword",
// "setPassword" (a reset: no current password) or "capabilities" (which of those it
// does). One set up under its 0.6 name (PASSWORD_CHANGE_*) was written for changes only,
// so it's never sent anything else.
//
// The admin page can choose among these, but where each goes is set only in the
// environment: a page that could change them could send everyone to a page or a
// program that collects their passwords.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import { Client, ConstraintViolationError, InvalidCredentialsError, UnwillingToPerformError } from "ldapts";
import { type LdapTarget, VERSION, config, onOwnServer, setting } from "./config.ts";
import type { AccountInfo } from "./imap/runtime.ts";
import { log } from "./log.ts";

export type PasswordChange = { method: "link"; url: string } | { method: "form" };

/** What a backend can be asked to do with a mailbox. */
export type MailboxAction = "changePassword" | "setPassword";

/** A change: the person gave their current password, which Viauna has checked. */
export interface PasswordRequest {
  login: string;
  email: string;
  currentPassword: string;
  newPassword: string;
}

/** A reset: no current password. `by` is the admin's login, or "recovery". */
export interface ResetRequest {
  login: string;
  email: string;
  newPassword: string;
  reason: "reset" | "admin";
  by: string;
}

export type AdminRequest = ({ action: "changePassword" } & PasswordRequest) | ({ action: "setPassword" } & ResetRequest) | { action: "capabilities" };

export type PasswordResult = { ok: true } | { ok: false; error: string };

/** A command's or webhook's answer: what it printed or returned, or why it failed. */
export type AdminAnswer = { ok: true; output: string } | { ok: false; error: string };

const FAILED = "Your password couldn't be changed. Try again later, or ask whoever runs this server.";
const COMMAND_MS = 30_000;
const WEBHOOK_MS = 15_000;

/**
 * How this account can change its password, or null if it can't here. Only accounts on
 * this server's own mail server: the operator's command or page knows nothing of a
 * server someone typed in at sign-in.
 */
export async function passwordChangeFor(account: AccountInfo): Promise<PasswordChange | null> {
  if (!onOwnServer(account)) return null;
  if (setting("mailboxAdmin") === "link") {
    const url = config.mailboxAdminUrl;
    return url ? { method: "link", url: fillTemplate(url.replaceAll("{email}", encodeURIComponent(account.email)), account.login, encodeURIComponent) } : null;
  }
  return (await capabilities()).has("changePassword") ? { method: "form" } : null;
}

/** Whether a forgotten password can be reset here: by recovery, or an admin's link. */
export async function canReset(): Promise<boolean> {
  return (await capabilities()).has("setPassword");
}

/** A short reason from the command or webhook, if it gave one, for showing to the person. */
function reason(text: string): string | null {
  const line = text.trim().split("\n").filter(Boolean).pop()?.trim();
  return line ? line.slice(0, 200) : null;
}

/**
 * Runs the command with the request on stdin. Its environment is PATH, HOME, LANG and
 * any MAILBOX_ADMIN_* (or PASSWORD_CHANGE_*) variable, never the rest of Viauna's
 * (SECRET_KEY, DATABASE_URL). Exit 0 means done, and its stdout is the answer; otherwise
 * the last line of its stdout, if any, is shown.
 */
export function runAdminCommand(command: string, request: AdminRequest, timeoutMs = COMMAND_MS): Promise<AdminAnswer> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "PATH" || k === "HOME" || k === "LANG" || k.startsWith("MAILBOX_ADMIN_") || k.startsWith("PASSWORD_CHANGE_")) env[k] = v;
  }
  return new Promise((resolve) => {
    // Its own process group, so a timeout ends whatever the shell started too.
    const child = spawn("/bin/sh", ["-c", command], { env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: AdminAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      log.warn("mailbox admin command timed out", { action: request.action, after: timeoutMs });
      finish({ ok: false, error: FAILED });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout = (stdout + d).slice(-4000)));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    child.on("error", (err) => {
      log.warn("mailbox admin command couldn't start", { error: err.message });
      finish({ ok: false, error: FAILED });
    });
    child.on("close", (code) => {
      if (code === 0) return finish({ ok: true, output: stdout });
      if (!settled) log.warn("mailbox admin command failed", { action: request.action, exit: code, stderr: stderr.trim().slice(-1000) || undefined });
      finish({ ok: false, error: reason(stdout) ?? FAILED });
    });
    child.stdin.on("error", () => {}); // a command that exits without reading its input
    child.stdin.end(JSON.stringify(request) + "\n");
  });
}

/** The signature a webhook checks: HMAC-SHA256 of "<timestamp>.<body>" with the shared secret. */
export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * POSTs the request. A 2xx answer means done, and its body is the answer; otherwise an
 * `error` in a JSON answer, if any, is shown. Redirects aren't followed: the body holds
 * passwords.
 */
export async function callAdminWebhook(url: string, secret: string, request: AdminRequest, timeoutMs = WEBHOOK_MS): Promise<AdminAnswer> {
  const body = JSON.stringify(request);
  const timestamp = String(Math.floor(Date.now() / 1000));
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `Viauna/${VERSION}`,
        "X-Viauna-Timestamp": timestamp,
        "X-Viauna-Signature": webhookSignature(secret, timestamp, body),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    log.warn("mailbox admin webhook unreachable", { action: request.action, error: (err as Error).message });
    return { ok: false, error: FAILED };
  }
  const text = await res.text().catch(() => "");
  if (res.ok) return { ok: true, output: text };
  let message: string | null = null;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed?.error === "string") message = reason(parsed.error);
  } catch {
    message = null;
  }
  log.warn("mailbox admin webhook refused", { action: request.action, status: res.status });
  return { ok: false, error: message ?? FAILED };
}

// ------------------------------------------------------------ capabilities

const KNOWN_MS = 3_600_000;
const RETRY_MS = 60_000;
let known: { key: string; actions: MailboxAction[]; until: number } | null = null;
let asking: { key: string; answer: Promise<MailboxAction[]> } | null = null;

/**
 * Which actions this server's backend does. A link or a directory is known from the
 * environment; a command or webhook is asked, hourly, and taken to change passwords only
 * if it doesn't answer (it may be a 0.6 script, or briefly down: asked again a minute on).
 */
export async function capabilities(): Promise<Set<MailboxAction>> {
  const method = setting("mailboxAdmin");
  if (method === "link") return new Set(config.mailboxAdminUrl ? ["changePassword"] : []);
  if (method === "ldap") {
    const ldap = config.mailboxAdminLdap;
    return new Set(!ldap ? [] : ldap.reset ? ["changePassword", "setPassword"] : ["changePassword"]);
  }
  if (method === "command" && config.mailboxAdminCommand) {
    if (config.mailboxAdminLegacy.command) return new Set(["changePassword"]);
    const command = config.mailboxAdminCommand;
    return asked(`command:${command}`, () => runAdminCommand(command, { action: "capabilities" }));
  }
  if (method === "webhook" && config.mailboxAdminWebhook && config.mailboxAdminWebhookSecret) {
    if (config.mailboxAdminLegacy.webhook) return new Set(["changePassword"]);
    const [url, secret] = [config.mailboxAdminWebhook, config.mailboxAdminWebhookSecret];
    return asked(`webhook:${url}`, () => callAdminWebhook(url, secret, { action: "capabilities" }));
  }
  return new Set();
}

async function asked(key: string, ask: () => Promise<AdminAnswer>): Promise<Set<MailboxAction>> {
  const now = Date.now();
  if (known?.key === key && known.until > now) return new Set(known.actions);
  if (asking?.key !== key) {
    const answer = ask().then((a) => {
      let actions: MailboxAction[] | null = null;
      if (a.ok) {
        try {
          const parsed = JSON.parse(a.output) as { actions?: unknown };
          if (Array.isArray(parsed?.actions)) actions = parsed.actions.filter((x): x is MailboxAction => x === "changePassword" || x === "setPassword");
        } catch {
          actions = null;
        }
      }
      if (!actions) log.warn("mailbox admin: no capabilities answer, so offering password changes only", { backend: key.split(":")[0] });
      known = { key, actions: actions ?? ["changePassword"], until: Date.now() + (actions ? KNOWN_MS : RETRY_MS) };
      asking = null;
      return known.actions;
    });
    asking = { key, answer };
  }
  return new Set(await asking!.answer);
}

/** Forgets what the backend said, so it's asked again (tests, and a changed setting). */
export function forgetCapabilities() {
  known = null;
  asking = null;
}

// ------------------------------------------------------------ LDAP

const PASSWORD_MODIFY = "1.3.6.1.4.1.4203.1.11.1";
const LDAP_MS = 15_000;

/** A value placed in a DN, escaped as RFC 4514 says, so a login can't add to the DN. */
export function escapeDnValue(value: string): string {
  return value
    .replace(/[\\,+"<>;=]/g, "\\$&")
    .replace(/\0/g, "\\00")
    .replace(/^#/, "\\#")
    .replace(/^ | $/g, "\\ ");
}

/** A value placed in a search filter, escaped as RFC 4515 says. */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => "\\" + c.charCodeAt(0).toString(16).padStart(2, "0"));
}

/** Fills {login}, {user} (before the @) and {domain} (after it), each escaped. */
export function fillTemplate(template: string, login: string, escape: (v: string) => string): string {
  const at = login.lastIndexOf("@");
  const parts = { login, user: at < 0 ? login : login.slice(0, at), domain: at < 0 ? "" : login.slice(at + 1) };
  return template.replace(/\{(login|user|domain)\}/g, (_, k: keyof typeof parts) => escape(parts[k]));
}

function tlv(tag: number, value: Buffer): Buffer {
  const n = value.length;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), value]);
}

/**
 * RFC 3062's PasswdModifyRequestValue, BER-encoded: [0] whose password (left out: the
 * user who is bound), [1] the old password (left out for a reset) and [2] the new one.
 */
export function passwordModifyRequest(oldPassword: string | null, newPassword: string, userDn?: string): Buffer {
  return tlv(
    0x30,
    Buffer.concat([
      ...(userDn !== undefined ? [tlv(0x80, Buffer.from(userDn, "utf8"))] : []),
      ...(oldPassword !== null ? [tlv(0x81, Buffer.from(oldPassword, "utf8"))] : []),
      tlv(0x82, Buffer.from(newPassword, "utf8")),
    ]),
  );
}

/** A connection to the directory, encrypted as the operator set it up. */
async function connect(target: LdapTarget, timeoutMs: number): Promise<Client> {
  const host = new URL(target.url).hostname.replace(/^\[|\]$/g, "");
  // Node checks the certificate against the name it's given; an address can't be one.
  const tlsOptions = { rejectUnauthorized: target.verify, ...(net.isIP(host) ? {} : { servername: host }) };
  // ldapts makes any connection given tlsOptions a TLS one, so only ldaps:// gets them;
  // ldap:// is upgraded with StartTLS (or, if the operator said so, left in the clear).
  const secure = target.url.toLowerCase().startsWith("ldaps:");
  const client = new Client({ url: target.url, timeout: timeoutMs, connectTimeout: timeoutMs, ...(secure ? { tlsOptions } : {}) });
  if (target.startTls) await client.startTLS(tlsOptions);
  return client;
}

/** The user's entry: from the DN template, or found by the search (as the service account, if any). */
async function findDn(client: Client, target: LdapTarget, login: string): Promise<{ dn: string } | { error: string }> {
  if (target.userDn) return { dn: fillTemplate(target.userDn, login, escapeDnValue) };
  const { base, filter, bindDn, bindPassword } = target.search!;
  if (bindDn) await client.bind(bindDn, bindPassword);
  const { searchEntries } = await client.search(base, {
    scope: "sub",
    filter: fillTemplate(filter, login, escapeFilterValue),
    attributes: ["1.1"],
    sizeLimit: 2,
  });
  if (searchEntries.length !== 1) {
    log.warn("mailbox admin: the directory search didn't find exactly one entry", { found: searchEntries.length });
    return { error: searchEntries.length ? FAILED : "Your account wasn't found in the directory." };
  }
  return { dn: searchEntries[0].dn };
}

function ldapError(err: unknown, what: string): PasswordResult {
  if (err instanceof ConstraintViolationError || err instanceof UnwillingToPerformError) {
    return { ok: false, error: reason(`The directory refused the new password: ${(err as Error).message}`) ?? FAILED };
  }
  log.warn(`${what} over LDAP failed`, { error: (err as Error).message, code: (err as { code?: unknown }).code });
  return { ok: false, error: FAILED };
}

/**
 * Finds the user (a DN template, or a search), binds as them with the current password,
 * and asks the directory to change it. A policy refusal says why, so that's shown.
 */
export async function changeViaLdap(target: LdapTarget, request: PasswordRequest, timeoutMs = LDAP_MS): Promise<PasswordResult> {
  let client: Client | null = null;
  try {
    client = await connect(target, timeoutMs);
    const found = await findDn(client, target, request.login);
    if ("error" in found) return { ok: false, error: found.error };
    await client.bind(found.dn, request.currentPassword);
    await client.exop(PASSWORD_MODIFY, passwordModifyRequest(request.currentPassword, request.newPassword));
    return { ok: true };
  } catch (err) {
    if (err instanceof InvalidCredentialsError) return { ok: false, error: "The directory didn't accept your current password." };
    return ldapError(err, "password change");
  } finally {
    await client?.unbind().catch(() => {});
  }
}

/**
 * Resets the password with no current one: bound as the service account allowed to
 * (MAILBOX_ADMIN_LDAP_RESET), the Password Modify operation names the user's entry.
 */
export async function resetViaLdap(target: LdapTarget, request: ResetRequest, timeoutMs = LDAP_MS): Promise<PasswordResult> {
  if (!target.reset) return { ok: false, error: "Passwords can't be reset here." };
  let client: Client | null = null;
  try {
    client = await connect(target, timeoutMs);
    const found = await findDn(client, target, request.login);
    if ("error" in found) return { ok: false, error: found.error };
    await client.bind(target.reset.dn, target.reset.password);
    await client.exop(PASSWORD_MODIFY, passwordModifyRequest(null, request.newPassword, found.dn));
    return { ok: true };
  } catch (err) {
    return ldapError(err, "password reset");
  } finally {
    await client?.unbind().catch(() => {});
  }
}

// ------------------------------------------------------------ running them

const unavailable = (what: string): PasswordResult => ({ ok: false, error: `${what} aren't available here.` });

function settle(answer: AdminAnswer): PasswordResult {
  return answer.ok ? { ok: true } : { ok: false, error: answer.error };
}

export async function runPasswordChange(request: PasswordRequest): Promise<PasswordResult> {
  const method = setting("mailboxAdmin");
  const asked = { action: "changePassword" as const, ...request };
  if (method === "command" && config.mailboxAdminCommand) return settle(await runAdminCommand(config.mailboxAdminCommand, asked));
  if (method === "webhook" && config.mailboxAdminWebhook && config.mailboxAdminWebhookSecret) {
    return settle(await callAdminWebhook(config.mailboxAdminWebhook, config.mailboxAdminWebhookSecret, asked));
  }
  if (method === "ldap" && config.mailboxAdminLdap) return changeViaLdap(config.mailboxAdminLdap, request);
  return unavailable("Password changes");
}

/** Sets a new password with no current one: a recovery, or an admin's reset link. */
export async function runPasswordReset(request: ResetRequest): Promise<PasswordResult> {
  if (!(await canReset())) return unavailable("Password resets");
  const method = setting("mailboxAdmin");
  const asked = { action: "setPassword" as const, ...request };
  if (method === "command" && config.mailboxAdminCommand) return settle(await runAdminCommand(config.mailboxAdminCommand, asked));
  if (method === "webhook" && config.mailboxAdminWebhook && config.mailboxAdminWebhookSecret) {
    return settle(await callAdminWebhook(config.mailboxAdminWebhook, config.mailboxAdminWebhookSecret, asked));
  }
  if (method === "ldap" && config.mailboxAdminLdap) return resetViaLdap(config.mailboxAdminLdap, request);
  return unavailable("Password resets");
}
