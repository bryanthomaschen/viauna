// Password changes through the operator's command or webhook (server/password.ts).
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config, endpointKey, readEnvironment } from "../server/config.ts";
import type { AccountInfo } from "../server/imap/runtime.ts";
import { callPasswordWebhook, passwordChangeFor, runPasswordCommand, webhookSignature } from "../server/password.ts";

const request = { login: "ann@example.test", email: "ann@example.test", currentPassword: "old secret", newPassword: "new secret 123" };

describe("the password command", () => {
  let dir: string;
  const script = (body: string) => {
    const file = path.join(dir, `cmd-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(file, body);
    return `"${process.execPath}" "${file}"`;
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "viauna-pw-"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("gets the request on stdin, and only a few safe variables", async () => {
    const out = path.join(dir, "seen.json");
    process.env.PASSWORD_CHANGE_TOKEN = "for the command";
    try {
      const cmd = script(`
        import fs from "node:fs";
        let input = "";
        process.stdin.on("data", (d) => (input += d)).on("end", () => {
          fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ input: JSON.parse(input), env: process.env }));
        });
      `);
      expect(await runPasswordCommand(cmd, request)).toEqual({ ok: true });
    } finally {
      delete process.env.PASSWORD_CHANGE_TOKEN;
    }
    const seen = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(seen.input).toEqual(request);
    expect(seen.env.PASSWORD_CHANGE_TOKEN).toBe("for the command");
    // vitest.config.ts sets these for Viauna; the command must not see them.
    expect(seen.env.SECRET_KEY).toBeUndefined();
    expect(seen.env.IMAP_HOST).toBeUndefined();
  });

  it("shows the reason a command gives when it refuses", async () => {
    const cmd = script(`process.stdin.resume(); process.stdin.on("end", () => { console.log("checking..."); console.log("Too weak: use 12 or more characters."); process.exit(3); });`);
    expect(await runPasswordCommand(cmd, request)).toEqual({ ok: false, error: "Too weak: use 12 or more characters." });
  });

  it("falls back to a general message, and gives up on a command that hangs", async () => {
    expect(await runPasswordCommand("exit 1", request)).toMatchObject({ ok: false, error: expect.stringMatching(/^Your password couldn't be changed/) });
    expect(await runPasswordCommand("/nonexistent/command", request)).toMatchObject({ ok: false });
    const start = Date.now();
    expect(await runPasswordCommand("sleep 5", request, 200)).toMatchObject({ ok: false, error: expect.stringMatching(/^Your password couldn't/) });
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

describe("the password webhook", () => {
  let server: http.Server;
  let url: string;
  let seen: { headers: http.IncomingHttpHeaders; body: string; path: string }[];
  let reply: (res: http.ServerResponse) => void;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d)).on("end", () => {
        seen.push({ headers: req.headers, body, path: req.url ?? "" });
        reply(res);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/change`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  afterEach(() => (seen = []));
  seen = [];

  it("posts the request, signed with the shared secret over the timestamp and body", async () => {
    reply = (res) => res.writeHead(204).end();
    expect(await callPasswordWebhook(url, "s3cret", request)).toEqual({ ok: true });
    const [{ headers, body }] = seen;
    expect(JSON.parse(body)).toEqual(request);
    const ts = headers["x-viauna-timestamp"] as string;
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(10);
    expect(headers["x-viauna-signature"]).toBe(webhookSignature("s3cret", ts, body));
    expect(headers["x-viauna-signature"]).not.toBe(webhookSignature("other", ts, body));
  });

  it("shows the error a webhook returns, and doesn't follow redirects", async () => {
    reply = (res) => res.writeHead(422, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "That password was in a breach." }));
    expect(await callPasswordWebhook(url, "s3cret", request)).toEqual({ ok: false, error: "That password was in a breach." });

    reply = (res) => res.writeHead(307, { Location: `${url}/elsewhere` }).end();
    expect(await callPasswordWebhook(url, "s3cret", request)).toMatchObject({ ok: false });
    expect(seen.map((s) => s.path)).toEqual(["/change", "/change"]);

    expect(await callPasswordWebhook("http://127.0.0.1:1/", "s3cret", request)).toMatchObject({ ok: false });
  });
});

describe("who can change a password here", () => {
  const configured = JSON.parse(endpointKey(config.imap!));
  const account = (imap: AccountInfo["imap"] = configured) => ({ id: 1, login: "ann@example.test", email: "ann+x@example.test", imap, smtp: configured }) as AccountInfo;
  /** password.ts as it would load with these variables set. */
  const loadWith = async (env: Record<string, string>) => {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return import("../server/password.ts");
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    readEnvironment();
  });

  it("is nobody by default", () => {
    expect(passwordChangeFor(account())).toBeNull();
  });

  it("links to the mail server's page, with the address filled in", async () => {
    const pw = await loadWith({ PASSWORD_CHANGE: "link", PASSWORD_CHANGE_URL: "https://mail.example.test/password?for={email}" });
    expect(pw.passwordChangeFor(account())).toEqual({ method: "link", url: "https://mail.example.test/password?for=ann%2Bx%40example.test" });
    // An account on a server typed in at sign-in isn't the operator's to change.
    expect(pw.passwordChangeFor(account({ ...configured, custom: true }))).toBeNull();
  });

  it("refuses to start with a password page that isn't a web address", async () => {
    for (const url of ["javascript:alert(1)", "mail.example.com", "ftp://x.test"]) {
      await expect(loadWith({ PASSWORD_CHANGE_URL: url })).rejects.toThrow(/PASSWORD_CHANGE_URL must be an http/);
    }
  });

  it("needs the page, command or webhook set in the environment to offer it", async () => {
    for (const method of ["link", "command", "webhook"]) {
      expect((await loadWith({ PASSWORD_CHANGE: method })).passwordChangeFor(account())).toBeNull();
    }
    expect((await loadWith({ PASSWORD_CHANGE: "command", PASSWORD_CHANGE_COMMAND: "true" })).passwordChangeFor(account())).toEqual({ method: "form" });
    await expect(loadWith({ PASSWORD_CHANGE_WEBHOOK: "https://x.test/" })).rejects.toThrow(/needs PASSWORD_CHANGE_WEBHOOK_SECRET/);
  });
});
