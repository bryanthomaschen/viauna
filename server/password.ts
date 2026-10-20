// Changing a mailbox password from Settings. Viauna keeps no passwords of its own, so
// it hands the change to whatever the operator chose with PASSWORD_CHANGE:
//
//   link     the mail server's own page (PASSWORD_CHANGE_URL); Viauna only links to it
//   command  PASSWORD_CHANGE_COMMAND, run with the request as JSON on its stdin
//   webhook  PASSWORD_CHANGE_WEBHOOK, POSTed the request as JSON, signed with
//            PASSWORD_CHANGE_WEBHOOK_SECRET
//   ldap     PASSWORD_CHANGE_LDAP_URL: bind as the user with the current password, then
//            the standard Password Modify operation (RFC 3062), so the directory applies
//            its own password policy and hashing
//
// The admin page can choose among these, but where each goes is set only in the
// environment: a page that could change them could send everyone to a page or a
// program that collects their passwords.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import { Client, ConstraintViolationError, InvalidCredentialsError, UnwillingToPerformError } from "ldapts";
import { type LdapTarget, VERSION, config, endpointKey, setting } from "./config.ts";
import type { AccountInfo } from "./imap/runtime.ts";
import { log } from "./log.ts";

export type PasswordChange = { method: "link"; url: string } | { method: "form" };

export interface PasswordRequest {
  login: string;
  email: string;
  currentPassword: string;
  newPassword: string;
}

export type PasswordResult = { ok: true } | { ok: false; error: string };

const FAILED = "Your password couldn't be changed. Try again later, or ask whoever runs this server.";
const COMMAND_MS = 30_000;
const WEBHOOK_MS = 15_000;

/**
 * How this account can change its password, or null if it can't here. Only accounts on
 * this server's own mail server: the operator's command or page knows nothing of a
 * server someone typed in at sign-in.
 */
export function passwordChangeFor(account: AccountInfo): PasswordChange | null {
  if (!config.imap || account.imap.custom || endpointKey(account.imap) !== endpointKey(config.imap)) return null;
  const method = setting("passwordChange");
  if (method === "link") {
    const url = config.passwordChangeUrl;
    return url ? { method: "link", url: url.replaceAll("{email}", encodeURIComponent(account.email)) } : null;
  }
  if (method === "command") return config.passwordCommand ? { method: "form" } : null;
  if (method === "webhook") return config.passwordWebhook ? { method: "form" } : null;
  if (method === "ldap") return config.passwordLdap ? { method: "form" } : null;
  return null;
}

/** A short reason from the command or webhook, if it gave one, for showing to the person. */
function reason(text: string): string | null {
  const line = text.trim().split("\n").filter(Boolean).pop()?.trim();
  return line ? line.slice(0, 200) : null;
}

/**
 * Runs the command with the request on stdin. Its environment is PATH, HOME, LANG and
 * any PASSWORD_CHANGE_* variable, never the rest of Viauna's (SECRET_KEY, DATABASE_URL).
 * Exit 0 means changed; otherwise the last line of its stdout, if any, is shown.
 */
export function runPasswordCommand(command: string, request: PasswordRequest, timeoutMs = COMMAND_MS): Promise<PasswordResult> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "PATH" || k === "HOME" || k === "LANG" || k.startsWith("PASSWORD_CHANGE_")) env[k] = v;
  }
  return new Promise((resolve) => {
    // Its own process group, so a timeout ends whatever the shell started too.
    const child = spawn("/bin/sh", ["-c", command], { env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: PasswordResult) => {
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
      log.warn("password command timed out", { after: timeoutMs });
      finish({ ok: false, error: FAILED });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout = (stdout + d).slice(-4000)));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    child.on("error", (err) => {
      log.warn("password command couldn't start", { error: err.message });
      finish({ ok: false, error: FAILED });
    });
    child.on("close", (code) => {
      if (code === 0) return finish({ ok: true });
      if (!settled) log.warn("password command failed", { exit: code, stderr: stderr.trim().slice(-1000) || undefined });
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
 * POSTs the request. A 2xx answer means changed; otherwise an `error` in a JSON answer,
 * if any, is shown. Redirects aren't followed: the body holds passwords.
 */
export async function callPasswordWebhook(url: string, secret: string, request: PasswordRequest, timeoutMs = WEBHOOK_MS): Promise<PasswordResult> {
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
    log.warn("password webhook unreachable", { error: (err as Error).message });
    return { ok: false, error: FAILED };
  }
  if (res.ok) return { ok: true };
  const text = await res.text().catch(() => "");
  let message: string | null = null;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed?.error === "string") message = reason(parsed.error);
  } catch {
    message = null;
  }
  log.warn("password webhook refused", { status: res.status });
  return { ok: false, error: message ?? FAILED };
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
 * RFC 3062's PasswdModifyRequestValue, BER-encoded: [1] the old password and [2] the
 * new one. With no userIdentity, it changes the password of the user who is bound.
 */
export function passwordModifyRequest(oldPassword: string, newPassword: string): Buffer {
  return tlv(0x30, Buffer.concat([tlv(0x81, Buffer.from(oldPassword, "utf8")), tlv(0x82, Buffer.from(newPassword, "utf8"))]));
}

/**
 * Finds the user (a DN template, or a search), binds as them with the current password,
 * and asks the directory to change it. A policy refusal says why, so that's shown.
 */
export async function changeViaLdap(target: LdapTarget, request: PasswordRequest, timeoutMs = LDAP_MS): Promise<PasswordResult> {
  const host = new URL(target.url).hostname.replace(/^\[|\]$/g, "");
  // Node checks the certificate against the name it's given; an address can't be one.
  const tlsOptions = { rejectUnauthorized: target.verify, ...(net.isIP(host) ? {} : { servername: host }) };
  // ldapts makes any connection given tlsOptions a TLS one, so only ldaps:// gets them;
  // ldap:// is upgraded with StartTLS (or, if the operator said so, left in the clear).
  const secure = target.url.toLowerCase().startsWith("ldaps:");
  const client = new Client({ url: target.url, timeout: timeoutMs, connectTimeout: timeoutMs, ...(secure ? { tlsOptions } : {}) });
  try {
    if (target.startTls) await client.startTLS(tlsOptions);
    let dn: string;
    if (target.userDn) {
      dn = fillTemplate(target.userDn, request.login, escapeDnValue);
    } else {
      const { base, filter, bindDn, bindPassword } = target.search!;
      if (bindDn) await client.bind(bindDn, bindPassword);
      const { searchEntries } = await client.search(base, {
        scope: "sub",
        filter: fillTemplate(filter, request.login, escapeFilterValue),
        attributes: ["1.1"],
        sizeLimit: 2,
      });
      if (searchEntries.length !== 1) {
        log.warn("password change: the directory search didn't find exactly one entry", { found: searchEntries.length });
        return { ok: false, error: searchEntries.length ? FAILED : "Your account wasn't found in the directory." };
      }
      dn = searchEntries[0].dn;
    }
    await client.bind(dn, request.currentPassword);
    await client.exop(PASSWORD_MODIFY, passwordModifyRequest(request.currentPassword, request.newPassword));
    return { ok: true };
  } catch (err) {
    if (err instanceof InvalidCredentialsError) return { ok: false, error: "The directory didn't accept your current password." };
    if (err instanceof ConstraintViolationError || err instanceof UnwillingToPerformError) {
      return { ok: false, error: reason(`The directory refused the new password: ${(err as Error).message}`) ?? FAILED };
    }
    log.warn("password change over LDAP failed", { error: (err as Error).message, code: (err as { code?: unknown }).code });
    return { ok: false, error: FAILED };
  } finally {
    await client.unbind().catch(() => {});
  }
}

export function runPasswordChange(request: PasswordRequest): Promise<PasswordResult> {
  const method = setting("passwordChange");
  if (method === "command" && config.passwordCommand) return runPasswordCommand(config.passwordCommand, request);
  if (method === "webhook" && config.passwordWebhook && config.passwordWebhookSecret) {
    return callPasswordWebhook(config.passwordWebhook, config.passwordWebhookSecret, request);
  }
  if (method === "ldap" && config.passwordLdap) return changeViaLdap(config.passwordLdap, request);
  return Promise.resolve({ ok: false, error: "Password changes aren't available here." });
}
