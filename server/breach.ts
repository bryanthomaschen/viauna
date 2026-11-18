// Whether a new password has appeared in known data breaches, so is among the first that
// attackers try (PASSWORD_BREACH_CHECK). Asked of Have I Been Pwned's Pwned Passwords range
// API by k-anonymity: only the first 5 hex characters of the password's SHA-1 leave this
// server. The API answers with every hash suffix it knows under that prefix, padded with
// fakes (counted 0) so the answer's size gives nothing away either, and the match is made
// here. Nothing identifies who the password is for.
//
// If the API can't be reached, the password is allowed and that's logged: a breach list
// being down shouldn't lock people out of choosing a password.
import crypto from "node:crypto";
import { VERSION, setting } from "./config.ts";
import { log } from "./log.ts";

const API = "https://api.pwnedpasswords.com/range/";
const TIMEOUT_MS = 5_000;
let api = API;

/** Tests point it at a stand-in; null puts the real one back. */
export function setBreachApi(url: string | null) {
  api = url ?? API;
}

export const BREACHED =
  "That password has appeared in a data breach, so it's among the first that attackers try. Choose another.";

/** True if breached, false if not (or the check is off), null if it couldn't be checked. */
export async function breached(password: string): Promise<boolean | null> {
  if (!setting("passwordBreachCheck")) return false;
  const hash = crypto.createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  try {
    const res = await fetch(api + prefix, {
      headers: { "Add-Padding": "true", "User-Agent": `Viauna/${VERSION}` },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    for (const line of (await res.text()).split("\n")) {
      const [s, count] = line.trim().split(":");
      if (s === suffix && Number(count) > 0) return true;
    }
    return false;
  } catch (err) {
    log.warn("breached-password check unavailable, so the password is allowed", { error: (err as Error).message });
    return null;
  }
}

export const MIN_PASSWORD = 8;
const MAX_PASSWORD = 1024;

/** Why a new password won't do, or null if it will: the rules every new one meets. */
export async function newPasswordProblem(next: string): Promise<string | null> {
  if (next.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (next.length > MAX_PASSWORD) return "That password is too long.";
  if (await breached(next)) return BREACHED;
  return null;
}
