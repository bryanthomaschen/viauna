// Browser notifications with Viauna closed (Web Push). A browser that allows them gives
// the address of its push service and its keys, kept per mailbox; a reminder is encrypted
// for that browser (RFC 8291, aes128gcm) and posted to its push service, signed with this
// server's key (VAPID, RFC 8292); the browser's service worker (web/public/sw.js) shows
// it. The push service (Google's for Chrome, Mozilla's for Firefox, Apple's for Safari)
// sees that a message went to that browser, not what it says.
//
// The key pair comes from the server's secret, so instances sharing the secret sign alike
// and a restart changes nothing; a new secret means each browser turning them on again.
// The push service's address is the browser's to give, so it's reached like any address
// someone else gave (netpolicy.ts): public addresses only, https, within limits.
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { VERSION, config, setting } from "./config.ts";
import { getServerSecret, sha256 } from "./crypto.ts";
import { log } from "./log.ts";
import { BLOCKED, blockedIp, publicLookup } from "./netpolicy.ts";
import { type Notice, addReminderChannel } from "./reminders.ts";
import { state } from "./state/db.ts";

export class PushError extends Error {}

/** Fixed limits (docs/how-it-works/limits.md). */
export const PUSH_LIMITS = {
  /** Browsers per mailbox: the oldest goes when another is added. */
  perAccount: 20,
  endpoint: 2000,
  /** A message, before encrypting: well inside one 4096-byte record. */
  payload: 3000,
  timeoutMs: 15_000,
  /** Failed sends in a row before a browser is dropped. */
  failures: 10,
};

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

// ---------------------------------------------------------------- keys and encryption

/** P-256's order: a private key is from 1 to one below it. */
const ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

let vapid: { publicKey: Buffer; privateKey: crypto.KeyObject } | null = null;

/** This server's VAPID key pair, derived from its secret. */
export function vapidKeys() {
  if (vapid) return vapid;
  const seed = Buffer.from(crypto.hkdfSync("sha256", getServerSecret(), Buffer.alloc(0), "viauna web push vapid key", 48));
  const d = Buffer.from(((BigInt(`0x${seed.toString("hex")}`) % (ORDER - 1n)) + 1n).toString(16).padStart(64, "0"), "hex");
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const publicKey = ecdh.getPublicKey();
  const privateKey = crypto.createPrivateKey({
    format: "jwk",
    key: { kty: "EC", crv: "P-256", d: b64u(d), x: b64u(publicKey.subarray(1, 33)), y: b64u(publicKey.subarray(33)) },
  });
  vapid = { publicKey, privateKey };
  return vapid;
}

/** The public key, as a page gives it to the browser (applicationServerKey). */
export const vapidPublicKey = () => b64u(vapidKeys().publicKey);

/** Who a push service can ask about this server's messages: its address, or the project's. */
const contact = () => (config.publicUrl?.startsWith("https://") ? config.publicUrl : "https://github.com/bryanthomaschen/viauna");

/** The Authorization a push service wants: a JWT for its origin, signed ES256, and the public key. */
export function vapidAuthorization(endpoint: string, now = Date.now()): string {
  const { publicKey, privateKey } = vapidKeys();
  const part = (o: object) => b64u(Buffer.from(JSON.stringify(o)));
  const signed = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: contact() })}`;
  const signature = crypto.sign("sha256", Buffer.from(signed), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${signed}.${b64u(signature)}, k=${b64u(publicKey)}`;
}

/**
 * A message encrypted for one browser: a key pair made for it, agreed with the browser's
 * key, its auth secret mixed in, as one aes128gcm record. `fixed` gives the salt and key
 * pair, for RFC 8291's own example.
 */
export function encryptPush(plaintext: Buffer, p256dh: string, auth: string, fixed?: { salt: Buffer; privateKey: Buffer }): Buffer {
  const browserKey = Buffer.from(p256dh, "base64url");
  const secret = Buffer.from(auth, "base64url");
  if (browserKey.length !== 65 || browserKey[0] !== 4 || secret.length !== 16) throw new PushError("Those aren't a browser's push keys.");
  const ecdh = crypto.createECDH("prime256v1");
  if (fixed) ecdh.setPrivateKey(fixed.privateKey);
  else ecdh.generateKeys();
  const serverKey = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(browserKey);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, secret, Buffer.concat([Buffer.from("WebPush: info\0"), browserKey, serverKey]), 32));
  const salt = fixed?.salt ?? crypto.randomBytes(16);
  const key = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = crypto.createCipheriv("aes-128-gcm", key, nonce);
  // The record's padding delimiter: 2, the last record.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(serverKey.length, 20);
  return Buffer.concat([header, serverKey, sealed]);
}

// ---------------------------------------------------------------- sending

export interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Posts one message to a browser's push service, and gives its answer's status. */
export function sendPush(sub: Subscription, message: object, ttlSeconds: number): Promise<number> {
  const url = new URL(sub.endpoint);
  // A push service is on https; plain http only where private servers are allowed (a test's own).
  if (url.protocol !== "https:" && !(url.protocol === "http:" && config.allowPrivateServers)) return Promise.reject(new PushError("A push service's address starts with https://."));
  if (blockedIp(url)) return Promise.reject(new PushError(BLOCKED));
  const plaintext = Buffer.from(JSON.stringify(message));
  if (plaintext.length > PUSH_LIMITS.payload) return Promise.reject(new PushError("That message is too long to push."));
  const body = encryptPush(plaintext, sub.p256dh, sub.auth);
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "POST",
        lookup: publicLookup,
        signal: AbortSignal.timeout(PUSH_LIMITS.timeoutMs),
        headers: {
          TTL: String(Math.max(0, Math.round(ttlSeconds))),
          Urgency: "high",
          "Content-Encoding": "aes128gcm",
          "Content-Type": "application/octet-stream",
          "Content-Length": String(body.length),
          Authorization: vapidAuthorization(sub.endpoint),
          "User-Agent": `Viauna/${VERSION}`,
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------- browsers per mailbox

const KEY = /^[A-Za-z0-9_-]+=*$/;

/** Keeps a browser's push subscription for a mailbox (again, if it's there already). */
export async function addSubscription(accountId: number, input: unknown, userAgent: string): Promise<void> {
  if (!setting("browserNotifications")) throw new PushError("Notifications with Viauna closed are turned off on this server.");
  const o = (input ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof o.endpoint === "string" ? o.endpoint : "";
  const p256dh = typeof o.keys?.p256dh === "string" ? o.keys.p256dh : "";
  const auth = typeof o.keys?.auth === "string" ? o.keys.auth : "";
  let url: URL | null = null;
  try {
    url = new URL(endpoint);
  } catch {
    url = null;
  }
  if (!url || endpoint.length > PUSH_LIMITS.endpoint || (url.protocol !== "https:" && !config.allowPrivateServers)) throw new PushError("That isn't a push service's address.");
  if (!KEY.test(p256dh) || !KEY.test(auth) || p256dh.length > 128 || auth.length > 64) throw new PushError("Those aren't a browser's push keys.");
  // Encrypting checks the keys are a point on the curve and a 16-byte secret.
  encryptPush(Buffer.from("{}"), p256dh, auth);
  const hash = sha256(endpoint);
  await state().transaction().execute(async (trx) => {
    await trx.deleteFrom("push_subscriptions").where("account_id", "=", accountId).where("endpoint_hash", "=", hash).execute();
    await trx
      .insertInto("push_subscriptions")
      .values({ account_id: accountId, endpoint, endpoint_hash: hash, p256dh, auth, user_agent: userAgent.slice(0, 300) || null, created_at: Date.now(), failures: 0 })
      .execute();
    const all = await trx.selectFrom("push_subscriptions").select("id").where("account_id", "=", accountId).orderBy("created_at", "desc").orderBy("id", "desc").execute();
    const extra = all.slice(PUSH_LIMITS.perAccount).map((r) => r.id);
    if (extra.length) await trx.deleteFrom("push_subscriptions").where("id", "in", extra).execute();
  });
}

export async function removeSubscription(accountId: number, endpoint: unknown): Promise<void> {
  if (typeof endpoint !== "string") return;
  await state().deleteFrom("push_subscriptions").where("account_id", "=", accountId).where("endpoint_hash", "=", sha256(endpoint)).execute();
}

/**
 * Pushes a message to a mailbox's browsers (or the one given), and gives how many took it.
 * One whose push service says it's gone (404, 410), or that failed 10 times in a row, is
 * dropped.
 */
export async function pushTo(accountId: number, message: object, ttlSeconds: number, only?: string): Promise<number> {
  let q = state().selectFrom("push_subscriptions").select(["id", "endpoint", "p256dh", "auth", "failures"]).where("account_id", "=", accountId);
  if (only !== undefined) q = q.where("endpoint_hash", "=", sha256(only));
  let delivered = 0;
  for (const sub of await q.execute()) {
    let status = 0;
    let error = "";
    try {
      status = await sendPush(sub, message, ttlSeconds);
    } catch (err) {
      error = (err as Error).message;
    }
    if (status >= 200 && status < 300) {
      delivered++;
      await state().updateTable("push_subscriptions").set({ last_ok_at: Date.now(), failures: 0 }).where("id", "=", sub.id).execute();
    } else if (status === 404 || status === 410 || sub.failures + 1 >= PUSH_LIMITS.failures) {
      await state().deleteFrom("push_subscriptions").where("id", "=", sub.id).execute();
    } else {
      log.warn("a push service didn't take a message", { account: accountId, host: new URL(sub.endpoint).host, status, error });
      await state().updateTable("push_subscriptions").set({ failures: sub.failures + 1 }).where("id", "=", sub.id).execute();
    }
  }
  return delivered;
}

/** Where a click on a reminder goes: the mailbox (by its address, which the page finds), on the event's day. */
export const reminderPath = (email: string, notice: Pick<Notice, "start">) => `/mailbox/${encodeURIComponent(email)}/calendar/day/${notice.start.slice(0, 10)}`;

// A due reminder shown as a notification goes to the mailbox's browsers too, kept until
// the event starts (and 5 minutes more), for a browser that's offline meanwhile.
addReminderChannel(async (notice) => {
  if (notice.method !== "notification" || !setting("browserNotifications")) return;
  const account = await state().selectFrom("accounts").select("email").where("id", "=", notice.accountId).executeTakeFirst();
  if (!account) return;
  await pushTo(
    notice.accountId,
    {
      type: "reminder", title: notice.title, allDay: notice.allDay, start: notice.start, end: notice.end, zone: notice.zone,
      location: notice.location, tag: `reminder-${notice.eventId}-${notice.occurrence ?? ""}-${notice.at}`, url: reminderPath(account.email, notice),
    },
    Math.min(86_400, Math.max(300, notice.minutes * 60 + 300)),
  );
});
