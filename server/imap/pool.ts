import { type Credentials, credentialFingerprint } from "../crypto.ts";
import { log } from "../log.ts";
import { verifyLogin } from "./connection.ts";
import { type AccountInfo, AccountRuntime } from "./runtime.ts";

const IDLE_STOP_MS = 10 * 60_000;
/** How long a proven password is trusted before it must log in again. */
const PROOF_MS = 10 * 60_000;
const runtimes = new Map<number, AccountRuntime>();
/** "<account>:<fingerprint>" -> until when that password is known to work. */
const verified = new Map<string, number>();
/** One runtime decision at a time per account, so parallel requests can't race. */
const queues = new Map<number, Promise<unknown>>();

export class MailboxAuthError extends Error {
  constructor(message = "The mail server rejected the saved password. Sign in again.") {
    super(message);
  }
}

function serialize<T>(accountId: number, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(accountId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(accountId, next);
  // Both outcomes handled here: `finally` would return a second promise that
  // rejects unobserved whenever fn throws.
  const done = () => {
    if (queues.get(accountId) === next) queues.delete(accountId);
  };
  next.then(done, done);
  return next;
}

/** True if the password logs in now (or did within PROOF_MS); throws on a connection problem. */
async function proven(account: AccountInfo, creds: Credentials, fp: string, maxAge = PROOF_MS): Promise<boolean> {
  const key = `${account.id}:${fp}`;
  if ((verified.get(key) ?? 0) > Date.now() + PROOF_MS - maxAge) return true;
  const result = await verifyLogin(account.imap, creds);
  if (result.ok) {
    verified.set(key, Date.now() + PROOF_MS);
    return true;
  }
  verified.delete(key);
  if (result.reason === "auth") return false;
  throw new Error(result.message);
}

async function retire(rt: AccountRuntime, forget = true) {
  if (runtimes.get(rt.account.id) === rt) runtimes.delete(rt.account.id);
  if (forget) verified.delete(`${rt.account.id}:${rt.fingerprint}`);
  await rt.stop();
}

/** Sign-in has just proven this password; don't log in a second time to check it. */
export function markProven(accountId: number, creds: Credentials) {
  verified.set(`${accountId}:${credentialFingerprint(creds)}`, Date.now() + PROOF_MS);
}

/**
 * The shared runtime for an account. Every session proves its own password: a
 * session whose password differs from the runtime's logs in fresh (cached for ten
 * minutes), and the runtime's own password is re-proven on the same schedule, so
 * after a password change neither an old session nor the old runtime outlives it.
 */
export function runtimeFor(account: AccountInfo, creds: Credentials): Promise<AccountRuntime> {
  return serialize(account.id, async () => {
    const fp = credentialFingerprint(creds);
    let rt = runtimes.get(account.id);

    if (rt && rt.fingerprint !== fp) {
      if (!(await proven(account, creds, fp))) throw new MailboxAuthError();
      // A different password works: the runtime's may be the stale one. Check it now
      // (at most once a minute) rather than on its ten-minute schedule.
      if (!(await proven(account, rt.credentials, rt.fingerprint, 60_000))) {
        log.info("account runtime retired (password changed)", { account: account.id });
        await retire(rt);
        rt = undefined;
      }
    } else if (rt && (rt.authFailed || Date.now() - rt.verifiedAt > PROOF_MS)) {
      if (!(await proven(account, rt.credentials, rt.fingerprint, rt.authFailed ? 0 : PROOF_MS))) {
        await retire(rt);
        throw new MailboxAuthError();
      }
      rt.verifiedAt = Date.now();
      if (rt.authFailed) {
        // The refusal was transient; start afresh with the same, working password.
        await retire(rt, false);
        rt = undefined;
      }
    }

    if (!rt) {
      if (!(await proven(account, creds, fp))) throw new MailboxAuthError();
      rt = new AccountRuntime(account, creds);
      runtimes.set(account.id, rt);
      rt.start();
      log.info("account runtime started", { account: account.id });
    }
    rt.touch();
    return rt;
  });
}

export function existingRuntime(accountId: number): AccountRuntime | undefined {
  return runtimes.get(accountId);
}

export async function stopRuntime(accountId: number) {
  const rt = runtimes.get(accountId);
  if (rt) await retire(rt);
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
