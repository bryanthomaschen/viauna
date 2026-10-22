// Web Push (server/push.ts): encryption as RFC 8291's own example has it, VAPID's signed
// token, posting to a push service and what its answers do to a browser's subscription.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../server/config.ts";
import { sha256 } from "../server/crypto.ts";
import { addSubscription, encryptPush, pushTo, removeSubscription, vapidAuthorization, vapidKeys, vapidPublicKey } from "../server/push.ts";
import { type StateStore, openState, setState, state } from "../server/state/db.ts";
import { ENGINES, emptyDatabase } from "./databases.ts";

const u = (s: string) => Buffer.from(s, "base64url");

/** Decrypts as a browser does (RFC 8291 section 3.4), to check what was sent. */
function decrypt(body: Buffer, browserPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const serverKey = body.subarray(21, 21 + idlen);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(browserPrivate);
  const browserKey = ecdh.getPublicKey();
  const ikm = Buffer.from(crypto.hkdfSync("sha256", ecdh.computeSecret(serverKey), auth, Buffer.concat([Buffer.from("WebPush: info\0"), browserKey, serverKey]), 32));
  const key = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const sealed = body.subarray(21 + idlen);
  const decipher = crypto.createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  expect(plain.at(-1)).toBe(2);
  return plain.subarray(0, -1).toString();
}

describe("Web Push encryption and signing", () => {
  it("encrypts RFC 8291's example message exactly as the RFC does", () => {
    const body = encryptPush(
      Buffer.from("When I grow up, I want to be a watermelon"),
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      "BTBZMqHH6r4Tts7J_aSIgg",
      { salt: u("DGv6ra1nlYgDCS1FRnbzlw"), privateKey: u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw") },
    );
    expect(decrypt(body, u("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"), u("BTBZMqHH6r4Tts7J_aSIgg"))).toBe("When I grow up, I want to be a watermelon");
    expect(body.toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("signs a token for the push service's origin with the server's key", () => {
    const header = vapidAuthorization("https://push.example.com/send/abc", Date.UTC(2026, 9, 22) );
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(key).toBe(vapidPublicKey());
    const [h, c, sig] = token.split(".");
    expect(JSON.parse(u(h).toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(u(c).toString())).toMatchObject({ aud: "https://push.example.com", exp: Date.UTC(2026, 9, 22) / 1000 + 43_200 });
    const publicKey = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: u(key).subarray(1, 33).toString("base64url"), y: u(key).subarray(33).toString("base64url") }, format: "jwk" });
    expect(crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, u(sig))).toBe(true);
    // The same key every time: it comes from the server's secret.
    expect(vapidKeys().publicKey.equals(u(vapidPublicKey()))).toBe(true);
  });
});

describe.each(ENGINES)("pushing to browsers on $name", ({ url }) => {
  let store: StateStore;
  let dir: string;
  let base = "";
  let answer = 201;
  const got: { path: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      got.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(answer).end();
    });
  });
  const allowed = config.allowPrivateServers;
  const imap = JSON.stringify({ host: "imap.example.test", port: 993, security: "tls", servername: null, verify: true });
  // A browser's keys.
  const browser = crypto.createECDH("prime256v1");
  browser.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = (p: string) => ({ endpoint: `${base}${p}`, keys: { p256dh: browser.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } });

  beforeAll(async () => {
    base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`)));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "viauna-push-"));
    if (url) await emptyDatabase(url);
    store = await openState(url, path.join(dir, "state.db"));
  });

  afterAll(async () => {
    server.close();
    await store.db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    setState(store);
    config.allowPrivateServers = true;
    got.length = 0;
    answer = 201;
    await state().deleteFrom("push_subscriptions").execute();
    await state().deleteFrom("accounts").execute();
    await state().insertInto("accounts").values({ id: 7, login: "me@example.test", email: "me@example.test", imap, imap_hash: sha256(imap), smtp: "{}", settings: "{}", created_at: 1 }).execute();
  });

  afterEach(() => {
    config.allowPrivateServers = allowed;
    setState(null);
  });

  it("keeps a browser's subscription, and sends it a message only it can read", async () => {
    await addSubscription(7, sub("/a"), "Test browser");
    await addSubscription(7, sub("/a"), "Test browser"); // again: still one
    expect(await state().selectFrom("push_subscriptions").select("endpoint").execute()).toEqual([{ endpoint: `${base}/a` }]);
    expect(await pushTo(7, { type: "test", title: "Hello" }, 600)).toBe(1);
    expect(got[0].headers).toMatchObject({ ttl: "600", urgency: "high", "content-encoding": "aes128gcm" });
    expect(got[0].headers.authorization).toMatch(/^vapid t=.+, k=/);
    expect(JSON.parse(decrypt(got[0].body, browser.getPrivateKey(), auth))).toEqual({ type: "test", title: "Hello" });
  });

  it("drops a browser its push service says is gone, and refuses keys and addresses that aren't", async () => {
    await addSubscription(7, sub("/gone"), "");
    answer = 410;
    expect(await pushTo(7, { title: "x" }, 60)).toBe(0);
    expect(await state().selectFrom("push_subscriptions").select("id").execute()).toEqual([]);
    await expect(addSubscription(7, { endpoint: `${base}/x`, keys: { p256dh: "AAAA", auth: "BBBB" } }, "")).rejects.toThrow(/push keys/);
    await expect(addSubscription(7, { endpoint: "not a url", keys: sub("/x").keys }, "")).rejects.toThrow(/push service/);
    config.allowPrivateServers = false;
    await expect(addSubscription(7, sub("/x"), "")).rejects.toThrow(/push service/);
    await state().insertInto("push_subscriptions").values({ account_id: 7, endpoint: "https://127.0.0.1/x", endpoint_hash: sha256("https://127.0.0.1/x"), p256dh: sub("").keys.p256dh, auth: sub("").keys.auth, created_at: 1, failures: 9 }).execute();
    // A private address is never posted to; ten failures in a row and it's gone.
    expect(await pushTo(7, { title: "x" }, 60)).toBe(0);
    expect(await state().selectFrom("push_subscriptions").select("id").execute()).toEqual([]);
  });

  it("forgets a browser that turns them off, and keeps 20 at most", async () => {
    for (let i = 0; i < 22; i++) await addSubscription(7, sub(`/b${i}`), "");
    const kept = await state().selectFrom("push_subscriptions").select("endpoint").execute();
    expect(kept).toHaveLength(20);
    expect(kept.some((k) => k.endpoint.endsWith("/b0"))).toBe(false);
    await removeSubscription(7, `${base}/b21`);
    expect(await state().selectFrom("push_subscriptions").select("id").execute()).toHaveLength(19);
  });
});
