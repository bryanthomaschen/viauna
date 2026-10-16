import { type Credentials, credentialFingerprint } from "../crypto.ts";
import { log } from "../log.ts";
import { verifyLogin } from "./connection.ts";
import { type AccountInfo, AccountRuntime } from "./runtime.ts";

const IDLE_STOP_MS = 10 * 60_000;
const runtimes = new Map<number, AccountRuntime>();
/** "<account>:<fingerprint>" -> until when that password is known to work. */
const verified = new Map<string, number>();

export class MailboxAuthError extends Error {
  constructor(message = "The mail server rejected the saved password. Sign in again.") {
    super(message);
  }
}

/**
 * The shared runtime for an account. A session whose saved password differs from the
 * one the runtime was opened with must prove its own password still works — otherwise
 * a session from before a password change could ride on a newer session's connection.
 */
export async function runtimeFor(account: AccountInfo, creds: Credentials): Promise<AccountRuntime> {
  let rt = runtimes.get(account.id);
  const fp = credentialFingerprint(creds);
  if (rt?.authFailed && rt.fingerprint !== fp) {
    await rt.stop();
    runtimes.delete(account.id);
    rt = undefined;
  }
  if (rt?.authFailed) throw new MailboxAuthError();
  if (rt && rt.fingerprint !== fp) {
    const key = `${account.id}:${fp}`;
    if (!((verified.get(key) ?? 0) > Date.now())) {
      const result = await verifyLogin(account.imap, creds);
      if (!result.ok) {
        if (result.reason === "auth") throw new MailboxAuthError();
        throw new Error(result.message);
      }
      verified.set(key, Date.now() + 10 * 60_000);
    }
  }
  if (!rt) {
    rt = new AccountRuntime(account, creds);
    runtimes.set(account.id, rt);
    rt.start();
    log.info("account runtime started", { account: account.id });
  }
  rt.touch();
  return rt;
}

export function existingRuntime(accountId: number): AccountRuntime | undefined {
  return runtimes.get(accountId);
}

export async function stopRuntime(accountId: number) {
  const rt = runtimes.get(accountId);
  if (!rt) return;
  runtimes.delete(accountId);
  await rt.stop();
}

export async function stopAll() {
  await Promise.all([...runtimes.keys()].map(stopRuntime));
}

setInterval(() => {
  const now = Date.now();
  for (const [id, rt] of runtimes) {
    if (rt.subscribers === 0 && now - rt.lastUsed > IDLE_STOP_MS) {
      runtimes.delete(id);
      void rt.stop();
      log.info("account runtime stopped (idle)", { account: id });
    }
  }
  for (const [key, until] of verified) if (until < now) verified.delete(key);
}, 60_000).unref();
