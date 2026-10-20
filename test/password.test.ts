// Password changes through the operator's command or webhook (server/password.ts).
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
  callPasswordWebhook,
  changeViaLdap,
  escapeDnValue,
  escapeFilterValue,
  fillTemplate,
  passwordChangeFor,
  passwordModifyRequest,
  runPasswordCommand,
  webhookSignature,
} from "../server/password.ts";

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

  it("is nobody by default", () => {
    expect(passwordChangeFor(account())).toBeNull();
  });

  it("links to the mail server's page, with the address filled in", async () => {
    const pw = await loadWith({ PASSWORD_CHANGE: "link", PASSWORD_CHANGE_URL: "https://mail.example.test/password?for={email}" });
    expect(pw.passwordChangeFor(account())).toEqual({ method: "link", url: "https://mail.example.test/password?for=ann%2Bx%40example.test" });
    // An account on a server typed in at sign-in isn't the operator's to change.
    expect(pw.passwordChangeFor(account({ ...configured, custom: true }))).toBeNull();
  });

  it("fills in the login, its parts and the address, as the setting promises", async () => {
    const pw = await loadWith({ PASSWORD_CHANGE: "link", PASSWORD_CHANGE_URL: "https://mail.example.test/{domain}/{user}?login={login}&to={email}" });
    expect(pw.passwordChangeFor(account())).toEqual({
      method: "link",
      url: "https://mail.example.test/example.test/ann?login=ann%40example.test&to=ann%2Bx%40example.test",
    });
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

  it("offers LDAP once the directory is set up, and checks how it is", async () => {
    const dn = { PASSWORD_CHANGE: "ldap", PASSWORD_CHANGE_LDAP_URL: "ldaps://ldap.example.test", PASSWORD_CHANGE_LDAP_USER_DN: "uid={user},ou=people,dc=example,dc=test" };
    expect((await loadWith(dn)).passwordChangeFor(account())).toEqual({ method: "form" });
    const { config: c } = await import("../server/config.ts");
    expect(c.passwordLdap).toEqual({ url: "ldaps://ldap.example.test", startTls: false, verify: true, userDn: "uid={user},ou=people,dc=example,dc=test" });

    await loadWith({ PASSWORD_CHANGE_LDAP_URL: "ldap://ldap.example.test:389", PASSWORD_CHANGE_LDAP_SEARCH_BASE: "ou=people,dc=example,dc=test" });
    expect((await import("../server/config.ts")).config.passwordLdap).toMatchObject({ startTls: true, search: { filter: "(mail={login})" } });

    const bad: [Record<string, string>, RegExp][] = [
      [{ PASSWORD_CHANGE_LDAP_URL: "https://ldap.example.test" }, /must be an ldap:\/\/ or ldaps:\/\//],
      [{ PASSWORD_CHANGE_LDAP_URL: "ldap://ldap.example.test/dc=x" }, /with no path/],
      [{ PASSWORD_CHANGE_LDAP_URL: "ldaps://x.test" }, /either PASSWORD_CHANGE_LDAP_USER_DN or PASSWORD_CHANGE_LDAP_SEARCH_BASE/],
      [{ PASSWORD_CHANGE_LDAP_URL: "ldaps://x.test", PASSWORD_CHANGE_LDAP_USER_DN: "cn=everyone" }, /must contain \{user\} or \{login\}/],
      [{ PASSWORD_CHANGE_LDAP_URL: "ldaps://x.test", PASSWORD_CHANGE_LDAP_SEARCH_BASE: "dc=x", PASSWORD_CHANGE_LDAP_SEARCH_FILTER: "(objectClass=*)" }, /SEARCH_FILTER must contain/],
      [{ PASSWORD_CHANGE_LDAP_URL: "ldaps://x.test", PASSWORD_CHANGE_LDAP_SEARCH_BASE: "dc=x", PASSWORD_CHANGE_LDAP_BIND_DN: "cn=svc" }, /go together/],
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
});

// Against a real directory (dev/databases.yml), when VIAUNA_TEST_LDAP names it.
const LDAP = process.env.VIAUNA_TEST_LDAP;
describe.skipIf(!LDAP)("password changes over LDAP", { timeout: 20_000 }, () => {
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
});
