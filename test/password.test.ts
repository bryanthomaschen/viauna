// Password changes and resets through the operator's command, webhook or directory
// (server/password.ts).
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config, endpointKey, readEnvironment } from "../server/config.ts";
import type { AccountInfo } from "../server/imap/runtime.ts";
import { AlreadyExistsError, Client } from "ldapts";
import {
  callAdminWebhook,
  changeViaLdap,
  escapeDnValue,
  escapeFilterValue,
  fillTemplate,
  passwordChangeFor,
  passwordModifyRequest,
  resetViaLdap,
  runAdminCommand,
  webhookSignature,
} from "../server/password.ts";

const request = { login: "ann@example.test", email: "ann@example.test", currentPassword: "old secret", newPassword: "new secret 123" };
const change = { action: "changePassword" as const, ...request };
const reset = { login: "ann@example.test", email: "ann@example.test", newPassword: "chosen anew 456", reason: "reset" as const, by: "recovery" };

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "viauna-pw-"));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A command that runs this script with Node. */
const script = (body: string) => {
  const file = path.join(dir, `cmd-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, body);
  return `"${process.execPath}" "${file}"`;
};

/** A command that appends each request to a file and answers capabilities with `actions`. */
const recorder = (actions: string[] | null) => {
  const log = path.join(dir, `log-${Math.random().toString(36).slice(2)}.jsonl`);
  const cmd = script(`
    import fs from "node:fs";
    let input = "";
    process.stdin.on("data", (d) => (input += d)).on("end", () => {
      fs.appendFileSync(${JSON.stringify(log)}, input);
      const req = JSON.parse(input);
      if (req.action === "capabilities" && ${JSON.stringify(actions)}) console.log(JSON.stringify({ actions: ${JSON.stringify(actions)} }));
    });
  `);
  const requests = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { cmd, requests };
};

describe("the command", () => {
  it("gets the request on stdin, and only a few safe variables", async () => {
    const out = path.join(dir, "seen.json");
    process.env.MAILBOX_ADMIN_TOKEN = "for the command";
    process.env.PASSWORD_CHANGE_TOKEN = "named before 0.7";
    try {
      const cmd = script(`
        import fs from "node:fs";
        let input = "";
        process.stdin.on("data", (d) => (input += d)).on("end", () => {
          fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ input: JSON.parse(input), env: process.env }));
          console.log("done");
        });
      `);
      expect(await runAdminCommand(cmd, change)).toEqual({ ok: true, output: "done\n" });
    } finally {
      delete process.env.MAILBOX_ADMIN_TOKEN;
      delete process.env.PASSWORD_CHANGE_TOKEN;
    }
    const seen = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(seen.input).toEqual(change);
    expect(seen.env.MAILBOX_ADMIN_TOKEN).toBe("for the command");
    expect(seen.env.PASSWORD_CHANGE_TOKEN).toBe("named before 0.7");
    // vitest.config.ts sets these for Viauna; the command must not see them.
    expect(seen.env.SECRET_KEY).toBeUndefined();
    expect(seen.env.IMAP_HOST).toBeUndefined();
  });

  it("shows the reason a command gives when it refuses", async () => {
    const cmd = script(`process.stdin.resume(); process.stdin.on("end", () => { console.log("checking..."); console.log("Too weak: use 12 or more characters."); process.exit(3); });`);
    expect(await runAdminCommand(cmd, change)).toEqual({ ok: false, error: "Too weak: use 12 or more characters." });
  });

  it("falls back to a general message, and gives up on a command that hangs", async () => {
    expect(await runAdminCommand("exit 1", change)).toMatchObject({ ok: false, error: expect.stringMatching(/^Your password couldn't be changed/) });
    expect(await runAdminCommand("/nonexistent/command", change)).toMatchObject({ ok: false });
    const start = Date.now();
    expect(await runAdminCommand("sleep 5", change, 200)).toMatchObject({ ok: false, error: expect.stringMatching(/^Your password couldn't/) });
    expect(Date.now() - start).toBeLessThan(3000);
  });
});

describe("the webhook", () => {
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
    expect(await callAdminWebhook(url, "s3cret", change)).toEqual({ ok: true, output: "" });
    const [{ headers, body }] = seen;
    expect(JSON.parse(body)).toEqual(change);
    const ts = headers["x-viauna-timestamp"] as string;
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(10);
    expect(headers["x-viauna-signature"]).toBe(webhookSignature("s3cret", ts, body));
    expect(headers["x-viauna-signature"]).not.toBe(webhookSignature("other", ts, body));
  });

  it("shows the error a webhook returns, and doesn't follow redirects", async () => {
    reply = (res) => res.writeHead(422, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "That password was in a breach." }));
    expect(await callAdminWebhook(url, "s3cret", change)).toEqual({ ok: false, error: "That password was in a breach." });

    reply = (res) => res.writeHead(307, { Location: `${url}/elsewhere` }).end();
    expect(await callAdminWebhook(url, "s3cret", change)).toMatchObject({ ok: false });
    expect(seen.map((s) => s.path)).toEqual(["/change", "/change"]);

    expect(await callAdminWebhook("http://127.0.0.1:1/", "s3cret", change)).toMatchObject({ ok: false });
  });
});

describe("who can change or reset a password here", () => {
  const configured = JSON.parse(endpointKey(config.imap!));
  const account = (imap: AccountInfo["imap"] = configured) => ({ id: 1, login: "ann@example.test", email: "ann+x@example.test", imap, smtp: configured }) as AccountInfo;
  /** password.ts as it would load with these variables set. */
  const loadWith = async (env: Record<string, string>) => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return import("../server/password.ts");
  };
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    readEnvironment();
  });

  it("is nobody by default", async () => {
    expect(await passwordChangeFor(account())).toBeNull();
  });

  it("links to the mail server's page, with the address filled in, under either name", async () => {
    const both: Record<string, string>[] = [
      { MAILBOX_ADMIN: "link", MAILBOX_ADMIN_URL: "https://mail.example.test/password?for={email}" },
      { PASSWORD_CHANGE: "link", PASSWORD_CHANGE_URL: "https://mail.example.test/password?for={email}" },
    ];
    for (const env of both) {
      const pw = await loadWith(env);
      expect(await pw.passwordChangeFor(account())).toEqual({ method: "link", url: "https://mail.example.test/password?for=ann%2Bx%40example.test" });
      // An account on a server typed in at sign-in isn't the operator's to change.
      expect(await pw.passwordChangeFor(account({ ...configured, custom: true }))).toBeNull();
      // A page can change a password, never reset one.
      expect(await pw.canReset()).toBe(false);
    }
    const { renamedEnv } = await import("../server/config.ts");
    expect(renamedEnv).toEqual([{ old: "PASSWORD_CHANGE", now: "MAILBOX_ADMIN" }, { old: "PASSWORD_CHANGE_URL", now: "MAILBOX_ADMIN_URL" }]);
  });

  it("fills in the login, its parts and the address, as the setting promises", async () => {
    const pw = await loadWith({ MAILBOX_ADMIN: "link", MAILBOX_ADMIN_URL: "https://mail.example.test/{domain}/{user}?login={login}&to={email}" });
    expect(await pw.passwordChangeFor(account())).toEqual({
      method: "link",
      url: "https://mail.example.test/example.test/ann?login=ann%40example.test&to=ann%2Bx%40example.test",
    });
  });

  it("refuses to start with a password page that isn't a web address, naming the variable that was set", async () => {
    for (const url of ["javascript:alert(1)", "mail.example.com", "ftp://x.test"]) {
      await expect(loadWith({ MAILBOX_ADMIN_URL: url })).rejects.toThrow(/MAILBOX_ADMIN_URL must be an http/);
      await expect(loadWith({ PASSWORD_CHANGE_URL: url })).rejects.toThrow(/PASSWORD_CHANGE_URL must be an http/);
    }
  });

  it("needs the page, command or webhook set in the environment to offer it", async () => {
    for (const method of ["link", "command", "webhook"]) {
      expect(await (await loadWith({ MAILBOX_ADMIN: method })).passwordChangeFor(account())).toBeNull();
    }
    // `true` says nothing when asked what it can do: password changes only.
    const pw = await loadWith({ MAILBOX_ADMIN: "command", MAILBOX_ADMIN_COMMAND: "true" });
    expect(await pw.passwordChangeFor(account())).toEqual({ method: "form" });
    expect(await pw.canReset()).toBe(false);
    await expect(loadWith({ MAILBOX_ADMIN_WEBHOOK: "https://x.test/" })).rejects.toThrow(/MAILBOX_ADMIN_WEBHOOK needs MAILBOX_ADMIN_WEBHOOK_SECRET/);
    await expect(loadWith({ PASSWORD_CHANGE_WEBHOOK: "https://x.test/" })).rejects.toThrow(/PASSWORD_CHANGE_WEBHOOK needs PASSWORD_CHANGE_WEBHOOK_SECRET/);
  });

  it("asks a command what it can do, once, and resets only if it says it can", async () => {
    const both = recorder(["changePassword", "setPassword"]);
    let pw = await loadWith({ MAILBOX_ADMIN: "command", MAILBOX_ADMIN_COMMAND: both.cmd });
    expect(await pw.passwordChangeFor(account())).toEqual({ method: "form" });
    expect(await pw.canReset()).toBe(true);
    expect(await pw.runPasswordReset(reset)).toEqual({ ok: true });
    expect(both.requests()).toEqual([{ action: "capabilities" }, { action: "setPassword", ...reset }]);

    // One that only resets: no change form in Settings, but resets go to it.
    const resets = recorder(["setPassword"]);
    pw = await loadWith({ MAILBOX_ADMIN: "command", MAILBOX_ADMIN_COMMAND: resets.cmd });
    expect(await pw.passwordChangeFor(account())).toBeNull();
    expect(await pw.canReset()).toBe(true);
  });

  it("never sends a reset to a command set up under its 0.6 name, or asks it anything", async () => {
    const old = recorder(["changePassword", "setPassword"]);
    const pw = await loadWith({ PASSWORD_CHANGE: "command", PASSWORD_CHANGE_COMMAND: old.cmd });
    expect(await pw.passwordChangeFor(account())).toEqual({ method: "form" });
    expect(await pw.canReset()).toBe(false);
    expect(await pw.runPasswordReset(reset)).toEqual({ ok: false, error: "Password resets aren't available here." });
    expect(await pw.runPasswordChange(request)).toEqual({ ok: true });
    expect(old.requests()).toEqual([change]);
  });

  it("asks a webhook what it can do, signed like any other request", async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d)).on("end", () => {
        seen.push(body);
        const { action } = JSON.parse(body);
        if (action === "capabilities") res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ actions: ["changePassword", "setPassword", "close"] }));
        else res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const pw = await loadWith({ MAILBOX_ADMIN: "webhook", MAILBOX_ADMIN_WEBHOOK: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, MAILBOX_ADMIN_WEBHOOK_SECRET: "s3cret" });
      // Actions it doesn't know yet (close) are ignored.
      expect([...(await pw.capabilities())]).toEqual(["changePassword", "setPassword"]);
      expect(await pw.runPasswordReset({ ...reset, reason: "admin", by: "boss@example.test" })).toEqual({ ok: true });
      expect(seen.map((b) => JSON.parse(b).action)).toEqual(["capabilities", "setPassword"]);
      expect(JSON.parse(seen[1])).toMatchObject({ reason: "admin", by: "boss@example.test" });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("offers LDAP once the directory is set up, and checks how it is", async () => {
    const dn = { MAILBOX_ADMIN: "ldap", MAILBOX_ADMIN_LDAP_URL: "ldaps://ldap.example.test", MAILBOX_ADMIN_LDAP_USER_DN: "uid={user},ou=people,dc=example,dc=test" };
    const pw = await loadWith(dn);
    expect(await pw.passwordChangeFor(account())).toEqual({ method: "form" });
    expect(await pw.canReset()).toBe(false);
    const { config: c } = await import("../server/config.ts");
    expect(c.mailboxAdminLdap).toEqual({ url: "ldaps://ldap.example.test", startTls: false, verify: true, userDn: "uid={user},ou=people,dc=example,dc=test" });

    await loadWith({ MAILBOX_ADMIN_LDAP_URL: "ldap://ldap.example.test:389", MAILBOX_ADMIN_LDAP_SEARCH_BASE: "ou=people,dc=example,dc=test" });
    expect((await import("../server/config.ts")).config.mailboxAdminLdap).toMatchObject({ startTls: true, search: { filter: "(mail={login})" } });

    // Resets, only when asked for, as the service account.
    const resets = await loadWith({ ...dn, MAILBOX_ADMIN_LDAP_BIND_DN: "cn=svc", MAILBOX_ADMIN_LDAP_BIND_PASSWORD: "p", MAILBOX_ADMIN_LDAP_RESET: "true" });
    expect(await resets.canReset()).toBe(true);
    expect((await import("../server/config.ts")).config.mailboxAdminLdap).toMatchObject({ reset: { dn: "cn=svc", password: "p" } });

    const bad: [Record<string, string>, RegExp][] = [
      [{ MAILBOX_ADMIN_LDAP_URL: "https://ldap.example.test" }, /must be an ldap:\/\/ or ldaps:\/\//],
      [{ MAILBOX_ADMIN_LDAP_URL: "ldap://ldap.example.test/dc=x" }, /with no path/],
      [{ MAILBOX_ADMIN_LDAP_URL: "ldaps://x.test" }, /either MAILBOX_ADMIN_LDAP_USER_DN or MAILBOX_ADMIN_LDAP_SEARCH_BASE/],
      [{ PASSWORD_CHANGE_LDAP_URL: "ldaps://x.test" }, /either PASSWORD_CHANGE_LDAP_USER_DN or PASSWORD_CHANGE_LDAP_SEARCH_BASE/],
      [{ MAILBOX_ADMIN_LDAP_URL: "ldaps://x.test", MAILBOX_ADMIN_LDAP_USER_DN: "cn=everyone" }, /must contain \{user\} or \{login\}/],
      [{ MAILBOX_ADMIN_LDAP_URL: "ldaps://x.test", MAILBOX_ADMIN_LDAP_SEARCH_BASE: "dc=x", MAILBOX_ADMIN_LDAP_SEARCH_FILTER: "(objectClass=*)" }, /SEARCH_FILTER must contain/],
      [{ MAILBOX_ADMIN_LDAP_URL: "ldaps://x.test", MAILBOX_ADMIN_LDAP_SEARCH_BASE: "dc=x", MAILBOX_ADMIN_LDAP_BIND_DN: "cn=svc" }, /go together/],
      [{ ...dn, MAILBOX_ADMIN_LDAP_RESET: "true" }, /MAILBOX_ADMIN_LDAP_RESET needs MAILBOX_ADMIN_LDAP_BIND_DN/],
    ];
    for (const [env, error] of bad) await expect(loadWith(env)).rejects.toThrow(error);
  });
});

describe("LDAP values and requests", () => {
  it("escapes what would change a DN or a filter", () => {
    expect(escapeDnValue('a,b+c"d\\e<f>g;h=i')).toBe('a\\,b\\+c\\"d\\\\e\\<f\\>g\\;h\\=i');
    expect(escapeDnValue("#lead and trail ")).toBe("\\#lead and trail\\ ");
    expect(escapeDnValue(" ")).toBe("\\ ");
    expect(escapeFilterValue("x)(uid=*")).toBe("x\\29\\28uid=\\2a");
    expect(escapeFilterValue("a\\b\0")).toBe("a\\5cb\\00");
    expect(fillTemplate("uid={user},ou={domain},dc=x", "ann,ou=admins@example.test", escapeDnValue)).toBe("uid=ann\\,ou\\=admins,ou=example.test,dc=x");
    expect(fillTemplate("(&(mail={login})(uid={user}))", "ann@example.test", escapeFilterValue)).toBe("(&(mail=ann@example.test)(uid=ann))");
  });

  it("encodes RFC 3062's request, long passwords included", () => {
    expect(passwordModifyRequest("a", "b").toString("hex")).toBe("3006810161820162");
    const long = passwordModifyRequest("x".repeat(200), "y".repeat(300));
    // [1]: tag, 2 length bytes, 200; [2]: tag, 3 length bytes, 300. 203 + 304 = 507.
    expect(long.subarray(0, 4).toString("hex")).toBe("308201fb");
    expect(long.subarray(4, 7).toString("hex")).toBe("8181c8");
    expect(long.subarray(4 + 3 + 200, 4 + 3 + 200 + 4).toString("hex")).toBe("8282012c");
    expect(long.length).toBe(4 + 507);
  });

  it("encodes a reset: whose password, no old one, and the new one", () => {
    // [0] "uid=a", then [2] "b".
    expect(passwordModifyRequest(null, "b", "uid=a").toString("hex")).toBe("300a8005" + Buffer.from("uid=a").toString("hex") + "820162");
  });
});

// Against a real directory (dev/databases.yml), when VIAUNA_TEST_LDAP names it.
const LDAP = process.env.VIAUNA_TEST_LDAP;
describe.skipIf(!LDAP)("password changes and resets over LDAP", { timeout: 20_000 }, () => {
  const ADMIN = { dn: "cn=admin,dc=example,dc=test", password: "admin" };
  const people = "ou=people,dc=example,dc=test";
  let uid = "";
  let login = "";
  const template = () => ({ url: LDAP!, startTls: false, verify: true, userDn: `uid={user},${people}` });
  const binds = async (dn: string, password: string) => {
    const c = new Client({ url: LDAP! });
    try {
      await c.bind(dn, password);
      return true;
    } catch {
      return false;
    } finally {
      await c.unbind().catch(() => {});
    }
  };

  beforeAll(async () => {
    const admin = new Client({ url: LDAP! });
    await admin.bind(ADMIN.dn, ADMIN.password);
    await admin.add(people, { objectClass: "organizationalUnit", ou: "people" }).catch((err) => {
      if (!(err instanceof AlreadyExistsError)) throw err;
    });
    uid = `ann-${Math.random().toString(36).slice(2, 8)}`;
    login = `${uid}@example.test`;
    await admin.add(`uid=${uid},${people}`, { objectClass: "inetOrgPerson", uid, cn: "Ann", sn: "Tester", mail: login, userPassword: "old secret 1" });
    await admin.unbind();
  });

  afterAll(async () => {
    const admin = new Client({ url: LDAP! });
    await admin.bind(ADMIN.dn, ADMIN.password);
    await admin.del(`uid=${uid},${people}`).catch(() => {});
    await admin.unbind();
  });

  it("changes the password as the user, from a DN template", async () => {
    const result = await changeViaLdap(template(), { login, email: login, currentPassword: "old secret 1", newPassword: "new secret 2" });
    expect(result).toEqual({ ok: true });
    expect(await binds(`uid=${uid},${people}`, "new secret 2")).toBe(true);
    expect(await binds(`uid=${uid},${people}`, "old secret 1")).toBe(false);
  });

  it("says when the directory doesn't take the current password", async () => {
    expect(await changeViaLdap(template(), { login, email: login, currentPassword: "wrong", newPassword: "whatever 3" })).toEqual({
      ok: false,
      error: "The directory didn't accept your current password.",
    });
  });

  it("finds the user with a search, as a service account, and over StartTLS", async () => {
    const search = { base: people, filter: "(mail={login})", bindDn: ADMIN.dn, bindPassword: ADMIN.password };
    // The test directory's certificate is self-signed: checked, it's refused.
    const checked = await changeViaLdap({ url: LDAP!, startTls: true, verify: true, search }, { login, email: login, currentPassword: "new secret 2", newPassword: "third one 4" });
    expect(checked).toMatchObject({ ok: false });
    const result = await changeViaLdap({ url: LDAP!, startTls: true, verify: false, search }, { login, email: login, currentPassword: "new secret 2", newPassword: "third one 4" });
    expect(result).toEqual({ ok: true });
    expect(await binds(`uid=${uid},${people}`, "third one 4")).toBe(true);
  });

  it("finds nobody for a login that tries to widen the filter", async () => {
    const search = { base: people, filter: "(mail={login})", bindDn: ADMIN.dn, bindPassword: ADMIN.password };
    const sneaky = "*)(uid=*";
    expect(await changeViaLdap({ url: LDAP!, startTls: false, verify: true, search }, { login: sneaky, email: sneaky, currentPassword: "x", newPassword: "y long enough" })).toEqual({
      ok: false,
      error: "Your account wasn't found in the directory.",
    });
  });

  it("resets a password without the current one, as the service account, and only if allowed", async () => {
    expect(await resetViaLdap(template(), { login, email: login, newPassword: "reset five 5", reason: "reset", by: "recovery" })).toMatchObject({ ok: false });
    const allowed = { ...template(), reset: { dn: ADMIN.dn, password: ADMIN.password } };
    expect(await resetViaLdap(allowed, { login, email: login, newPassword: "reset five 5", reason: "reset", by: "recovery" })).toEqual({ ok: true });
    expect(await binds(`uid=${uid},${people}`, "reset five 5")).toBe(true);
    expect(await binds(`uid=${uid},${people}`, "third one 4")).toBe(false);
    // A service account that may not change passwords: the user's own.
    const notAllowed = { ...template(), reset: { dn: `uid=${uid},${people}`, password: "reset five 5" } };
    const other = `uid=nobody-${uid},${people}`;
    expect(await resetViaLdap({ ...notAllowed, userDn: other }, { login, email: login, newPassword: "never 6 set", reason: "admin", by: "x" })).toMatchObject({ ok: false });
  });
});
