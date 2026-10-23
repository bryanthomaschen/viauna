// Mailbox passwords are stored encrypted with a key that exists only in the user's
// cookie. The database (and a backup of it) therefore holds nothing that opens a
// mailbox: an attacker needs the cookie too, which is exactly what they would need
// to use the session anyway. The server secret is mixed in so that a stolen database
// plus a guessed cookie format still yields nothing.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

let serverSecret: Buffer | null = null;

/**
 * SECRET_KEY from the environment, or one generated on first start and kept in the
 * data directory (mode 600), so `docker run` works without any setup.
 */
export function getServerSecret(): Buffer {
  if (serverSecret) return serverSecret;
  const fromEnv = process.env.SECRET_KEY;
  if (fromEnv) {
    serverSecret = crypto.createHash("sha256").update(fromEnv).digest();
    return serverSecret;
  }
  const file = path.join(config.dataDir, "secret.key");
  try {
    serverSecret = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64url");
  } catch {
    fs.mkdirSync(config.dataDir, { recursive: true });
    serverSecret = crypto.randomBytes(32);
    fs.writeFileSync(file, serverSecret.toString("base64url") + "\n", { mode: 0o600 });
  }
  return serverSecret;
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Cookie value: "<session id>.<credential key>", both random. */
export function newSessionCookie(): { sid: string; key: string; value: string } {
  const sid = randomToken();
  const key = randomToken();
  return { sid, key, value: `${sid}.${key}` };
}

export function parseSessionCookie(value: string | undefined): { sid: string; key: string } | null {
  if (!value) return null;
  const [sid, key] = value.split(".");
  if (!sid || !key || sid.length < 40 || key.length < 40) return null;
  return { sid, key };
}

function credentialKey(cookieKey: string, sessionHash: string, accountId: number): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(cookieKey, "base64url"), getServerSecret(), `viauna:credential:v1:${sessionHash}:${accountId}`, 32),
  );
}

export interface Credentials {
  user: string;
  pass: string;
  /** Sign-ins for the own mail servers of the addresses the mailbox sends as, by identity id (identities.ts). */
  servers?: Record<string, { user: string; pass: string }>;
}

export function encryptCredentials(creds: Credentials, cookieKey: string, sessionHash: string, accountId: number): Buffer {
  const key = credentialKey(cookieKey, sessionHash, accountId);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(creds), "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), body]);
}

export function decryptCredentials(blob: Uint8Array, cookieKey: string, sessionHash: string, accountId: number): Credentials | null {
  const buf = Buffer.from(blob);
  if (buf.length < 30 || buf[0] !== 1) return null;
  try {
    const key = credentialKey(cookieKey, sessionHash, accountId);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(1, 13));
    decipher.setAuthTag(buf.subarray(13, 29));
    const plain = Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plain);
    return typeof parsed?.user === "string" && typeof parsed?.pass === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Constant-time fingerprint of a credential pair, to compare without keeping a copy. */
export function credentialFingerprint(creds: Credentials): string {
  return crypto.createHmac("sha256", getServerSecret()).update(`${creds.user}\0${creds.pass}`).digest("hex");
}
