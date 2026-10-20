// Changing a mailbox password from Settings. Viauna keeps no passwords of its own, so
// it hands the change to whatever the operator chose with PASSWORD_CHANGE:
//
//   link     the mail server's own page (PASSWORD_CHANGE_URL); Viauna only links to it
//   command  PASSWORD_CHANGE_COMMAND, run with the request as JSON on its stdin
//   webhook  PASSWORD_CHANGE_WEBHOOK, POSTed the request as JSON, signed with
//            PASSWORD_CHANGE_WEBHOOK_SECRET
//
// The admin page can choose among these, but where each goes is set only in the
// environment: a page that could change them could send everyone to a page or a
// program that collects their passwords.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { VERSION, config, endpointKey, setting } from "./config.ts";
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

export function runPasswordChange(request: PasswordRequest): Promise<PasswordResult> {
  const method = setting("passwordChange");
  if (method === "command" && config.passwordCommand) return runPasswordCommand(config.passwordCommand, request);
  if (method === "webhook" && config.passwordWebhook && config.passwordWebhookSecret) {
    return callPasswordWebhook(config.passwordWebhook, config.passwordWebhookSecret, request);
  }
  return Promise.resolve({ ok: false, error: "Password changes aren't available here." });
}
