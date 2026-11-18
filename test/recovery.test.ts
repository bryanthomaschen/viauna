// Getting back in (server/recovery.ts): a recovery address and backup codes, "Forgot
// password?", an admin's reset link, and the breached-password check (server/breach.ts).
// The mail server's login is mocked (the password is "pass"); the operator's backend is a
// command that records each request; Viauna's sender is a local SMTP server that keeps
// what it's sent; Have I Been Pwned is a stand-in.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { SMTPServer } from "smtp-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/imap/connection.ts", () => ({
  verifyLogin: vi.fn(async (_e: unknown, creds: { pass: string }) =>
    creds.pass === "pass" ? { ok: true } : { ok: false, reason: "auth", message: "Wrong email or password." }),
}));
vi.mock("../server/imap/pool.ts", () => ({ stopRuntime: vi.fn(async () => {}), markProven: vi.fn() }));

const { config, endpointKey, readEnvironment, setOverrides } = await import("../server/config.ts");
const { sha256 } = await import("../server/crypto.ts");
const { forgetCapabilities } = await import("../server/password.ts");
const { BREACHED, newPasswordProblem, setBreachApi } = await import("../server/breach.ts");
const recovery = await import("../server/recovery.ts");
const { openState, setState, state } = await import("../server/state/db.ts");
type AccountInfo = import("../server/imap/runtime.ts").AccountInfo;

const ip = "203.0.113.9";
let dir: string;
let requestsFile: string;
let received: { to: string[]; subject: string; raw: string }[] = [];
let smtp: SMTPServer;

/** The backend: records each request, and says it can change and reset passwords. */
function backend(actions = ["changePassword", "setPassword"]) {
  const script = path.join(dir, `backend-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(script, `
    import fs from "node:fs";
    let input = "";
    process.stdin.on("data", (d) => (input += d)).on("end", () => {
      const req = JSON.parse(input);
      fs.appendFileSync(${JSON.stringify(requestsFile)}, input);
      if (req.action === "capabilities") console.log(JSON.stringify({ actions: ${JSON.stringify(actions)} }));
    });
  `);
  config.mailboxAdminCommand = `"${process.execPath}" "${script}"`;
  setOverrides(new Map([["mailboxAdmin", "command"]]));
  forgetCapabilities();
}
const requests = () => (fs.existsSync(requestsFile) ? fs.readFileSync(requestsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const resets = () => requests().filter((r) => r.action === "setPassword");

const until = async <T>(fn: () => T | undefined, what: string, ms = 4000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const mailTo = (address: string, subject: RegExp) => until(() => received.find((m) => m.to.includes(address) && subject.test(m.subject)), `mail to ${address} (${subject})`);
const codeIn = (m: { subject: string }) => /^(\d{4}) (\d{4}) /.exec(m.subject)!.slice(1).join("");

let ann: AccountInfo;
let bob: AccountInfo;

async function addAccount(login: string): Promise<AccountInfo> {
  const imap = endpointKey(config.imap!);
  await state().insertInto("accounts").values({ login, email: login, imap, imap_hash: sha256(imap), smtp: "{}", settings: "{}", created_at: Date.now() }).execute();
  const row = await state().selectFrom("accounts").select("id").where("login", "=", login).executeTakeFirstOrThrow();
  return { id: row.id, login, email: login, imap: config.imap!, smtp: config.smtp! };
}

async function signedInTo(sessionId: string, ...accounts: AccountInfo[]) {
  await state().insertInto("sessions").values({ id: sessionId, created_at: 1, seen_at: Date.now(), expires_at: Date.now() + 86_400_000, user_agent: null, ip: null }).execute();
  for (const [position, a] of accounts.entries()) {
    await state().insertInto("session_accounts").values({ session_id: sessionId, account_id: a.id, position, credential: Buffer.from("x") }).execute();
  }
}
const sessionsOf = async (a: AccountInfo) => (await state().selectFrom("session_accounts").select("session_id").where("account_id", "=", a.id).execute()).map((r) => r.session_id).sort();

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "viauna-recovery-"));
  smtp = new SMTPServer({
    secure: false, authOptional: true, disabledCommands: ["STARTTLS", "AUTH"],
    onData: (stream, session, cb) => {
      let raw = "";
      stream.on("data", (c: Buffer) => (raw += c.toString()));
      stream.on("end", () => {
        received.push({ to: session.envelope.rcptTo.map((r) => r.address), subject: /^Subject: (.*)$/m.exec(raw)?.[1] ?? "", raw });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  config.sender = { address: "viauna@example.test", name: "Viauna", login: "viauna@example.test", password: undefined, smtp: { host: "127.0.0.1", port: (smtp.server.address() as net.AddressInfo).port, security: "none", verify: false } };
});

afterAll(() => {
  smtp.close();
  config.sender = null;
  config.mailboxAdminCommand = undefined;
  setOverrides(new Map());
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  setState(await openState(undefined, ":memory:"));
  requestsFile = path.join(dir, `requests-${Math.random().toString(36).slice(2)}.jsonl`);
  received = [];
  backend();
  ann = await addAccount("ann@example.test");
  bob = await addAccount("bob@example.test");
});

afterEach(() => setState(null));

/** Through "Forgot password?" to a new password, with whatever code `code` gives. */
async function recoverWith(code: string, password = "a brand new one") {
  const { token } = await recovery.verifyRecovery({ email: "ann@example.test", code }, { ip });
  return recovery.finishReset({ token, password }, { ip });
}

describe("recovery is offered", () => {
  it("only when the backend can reset, and by email only with a sender", async () => {
    expect(await recovery.recoveryOffered()).toEqual({ offered: true, email: true, codes: true });
    backend(["changePassword"]);
    expect(await recovery.recoveryOffered()).toEqual({ offered: false, email: false, codes: false });
    backend();
    const sender = config.sender;
    config.sender = null;
    try {
      expect(await recovery.recoveryOffered()).toEqual({ offered: true, email: false, codes: true });
    } finally {
      config.sender = sender;
    }
  });

  it("with each method the admin leaves on, keeping what people set up for one turned off", async () => {
    const methods = (email: boolean, codes: boolean) => setOverrides(new Map<any, any>([["mailboxAdmin", "command"], ["recoveryEmail", email], ["recoveryCodes", codes]]));
    await recovery.setRecoveryAddress(ann, { password: "pass", address: "ann@home.test" }, { ip });
    await recovery.confirmRecoveryAddress(ann, { code: codeIn(await mailTo("ann@home.test", /code to confirm/)) });
    const { codes } = await recovery.newBackupCodes(ann, { password: "pass" }, { ip });
    await mailTo("ann@example.test", /can now reset your password/);
    await mailTo("ann@example.test", /^Backup codes were made$/);

    methods(false, true);
    expect(await recovery.recoveryOffered()).toEqual({ offered: true, email: false, codes: true });
    expect(await recovery.recoveryStatus(ann)).toMatchObject({ offered: true, emailOffered: false, codesOffered: true, address: "ann@home.test", confirmed: true });
    await expect(recovery.setRecoveryAddress(ann, { password: "pass", address: "ann@work.test" }, { ip })).rejects.toThrow("Recovery by email isn't available here.");
    received = [];
    await recovery.startRecovery({ email: "ann@example.test" }, { ip });
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toEqual([]); // no code emailed with the method off
    expect(await recoverWith(codes[0])).toEqual({ email: "ann@example.test" });

    methods(true, false);
    await expect(recoverWith(codes[1])).rejects.toThrow(/isn't right/);
    await expect(recovery.newBackupCodes(ann, { password: "pass" }, { ip })).rejects.toThrow("Backup codes aren't available here.");

    methods(false, false);
    expect(await recovery.recoveryOffered()).toEqual({ offered: false, email: false, codes: false });
    await expect(recovery.startRecovery({ email: "ann@example.test" }, { ip })).rejects.toMatchObject({ status: 404 });
    // A way in can always be taken away.
    expect(await recovery.removeRecoveryAddress(ann, { password: "pass" }, { ip })).toMatchObject({ address: null });

    methods(true, true);
    expect((await recovery.recoveryStatus(ann)).backupCodes).toMatchObject({ left: 9 }); // kept while it was off
  });
});

describe("a recovery address", () => {
  it("needs the password, isn't the mailbox's own, and is used only once a code sent to it is entered", async () => {
    await expect(recovery.setRecoveryAddress(ann, { password: "wrong", address: "ann@home.test" }, { ip })).rejects.toThrow("Your password isn't right.");
    await expect(recovery.setRecoveryAddress(ann, { password: "pass", address: "ANN@example.test" }, { ip })).rejects.toThrow(/other than this mailbox/);
    const status = await recovery.setRecoveryAddress(ann, { password: "pass", address: "Ann@Home.test" }, { ip });
    expect(status).toMatchObject({ offered: true, emailOffered: true, address: "ann@home.test", confirmed: false, codeSentAt: expect.any(Number) });
    const sent = await mailTo("ann@home.test", /is your code to confirm ann@home\.test$/);
    expect(sent.raw).toMatch(/From: Viauna <viauna@example\.test>/);

    // Not usable until confirmed: "Forgot password?" sends it nothing.
    await recovery.startRecovery({ email: "ann@example.test" }, { ip });
    await new Promise((r) => setTimeout(r, 300));
    expect(received.filter((m) => /reset the password/.test(m.subject))).toEqual([]);

    await expect(recovery.confirmRecoveryAddress(ann, { code: "00000000" })).rejects.toThrow(/isn't right.*4 more tries/);
    expect(await recovery.confirmRecoveryAddress(ann, { code: codeIn(sent) })).toMatchObject({ confirmed: true, codeSentAt: null });
    // The mailbox is told, in case it wasn't its owner who added it.
    await mailTo("ann@example.test", /ann@home\.test can now reset your password/);
    // A code works once.
    await expect(recovery.confirmRecoveryAddress(ann, { code: codeIn(sent) })).rejects.toThrow(/isn't right/);
  });

  it("stops taking guesses at a code after five", async () => {
    await recovery.setRecoveryAddress(ann, { password: "pass", address: "ann@home.test" }, { ip });
    const sent = await mailTo("ann@home.test", /code to confirm/);
    for (let i = 0; i < 5; i++) await expect(recovery.confirmRecoveryAddress(ann, { code: "12345678" })).rejects.toThrow();
    await expect(recovery.confirmRecoveryAddress(ann, { code: codeIn(sent) })).rejects.toThrow(/isn't right/);
  });

  it("is removed only with the password, and the mailbox is told", async () => {
    await recovery.setRecoveryAddress(ann, { password: "pass", address: "ann@home.test" }, { ip });
    await recovery.confirmRecoveryAddress(ann, { code: codeIn(await mailTo("ann@home.test", /code to confirm/)) });
    await expect(recovery.removeRecoveryAddress(ann, { password: "nope" }, { ip })).rejects.toThrow("Your password isn't right.");
    expect(await recovery.removeRecoveryAddress(ann, { password: "pass" }, { ip })).toMatchObject({ address: null, confirmed: false });
    await mailTo("ann@example.test", /Your recovery address was removed/);
  });
});

describe("Forgot password?", () => {
  beforeEach(async () => {
    await recovery.setRecoveryAddress(ann, { password: "pass", address: "ann@home.test" }, { ip });
    await recovery.confirmRecoveryAddress(ann, { code: codeIn(await mailTo("ann@home.test", /code to confirm/)) });
    await mailTo("ann@example.test", /can now reset your password/); // sent after the answer
    received = [];
  });

  it("answers the same for any address, and emails a code only to a confirmed recovery address", async () => {
    for (const email of ["ann@example.test", "nobody@example.test", "bob@example.test"]) {
      await expect(recovery.startRecovery({ email }, { ip })).resolves.toBeUndefined();
    }
    const sent = await mailTo("ann@home.test", /is your code to reset the password for ann@example\.test$/);
    await new Promise((r) => setTimeout(r, 300));
    expect(received.map((m) => m.to)).toEqual([["ann@home.test"]]);
    expect(sent.raw).toMatch(/the password stays as it is/);
  });

  it("resets with that code: the backend sets it, every session ends, and both addresses are told", async () => {
    await signedInTo("s1", ann);
    await signedInTo("s2", ann, bob);
    await recovery.startRecovery({ email: "ann@example.test" }, { ip });
    const code = codeIn(await mailTo("ann@home.test", /code to reset/));

    await expect(recovery.verifyRecovery({ email: "ann@example.test", code: "11112222" }, { ip })).rejects.toThrow("That code isn't right, or it has expired.");
    expect(await recoverWith(code)).toEqual({ email: "ann@example.test" });
    expect(resets()).toEqual([{ action: "setPassword", login: "ann@example.test", email: "ann@example.test", newPassword: "a brand new one", reason: "reset", by: "recovery" }]);
    expect(await sessionsOf(ann)).toEqual([]);
    expect(await sessionsOf(bob)).toEqual(["s2"]); // bob is still signed in beside her
    expect((await state().selectFrom("sessions").select("id").execute()).map((s) => s.id)).toEqual(["s2"]);
    for (const to of ["ann@example.test", "ann@home.test"]) {
      expect((await mailTo(to, /^Your password was reset$/)).raw).toMatch(/using a code sent to your recovery address/);
    }
    // The code was used up.
    await expect(recovery.verifyRecovery({ email: "ann@example.test", code }, { ip })).rejects.toThrow(/isn't right/);
  });

  it("finishes with a token only once, and only before it lapses", async () => {
    await recovery.startRecovery({ email: "ann@example.test" }, { ip });
    const { token } = await recovery.verifyRecovery({ email: "ann@example.test", code: codeIn(await mailTo("ann@home.test", /code to reset/)) }, { ip });
    expect(await recovery.resetTokenInfo(token)).toMatchObject({ email: "ann@example.test", reason: "reset" });
    await expect(recovery.finishReset({ token, password: "short" }, { ip })).rejects.toThrow("Use at least 8 characters.");
    await recovery.finishReset({ token, password: "long enough now" }, { ip });
    await expect(recovery.finishReset({ token, password: "long enough again" }, { ip })).rejects.toMatchObject({ status: 410 });
    await expect(recovery.resetTokenInfo("x".repeat(43))).rejects.toMatchObject({ status: 410 });
    expect(resets()).toHaveLength(1);
  });

  it("says why, and resets nothing, when the backend refuses", async () => {
    const script = path.join(dir, "refuses.mjs");
    fs.writeFileSync(script, `let i = ""; process.stdin.on("data", (d) => (i += d)).on("end", () => { if (JSON.parse(i).action === "capabilities") { console.log('{"actions":["setPassword"]}'); } else { console.log("The mail server is busy."); process.exit(2); } });`);
    config.mailboxAdminCommand = `"${process.execPath}" "${script}"`;
    forgetCapabilities();
    await signedInTo("s1", ann);
    await recovery.startRecovery({ email: "ann@example.test" }, { ip });
    const { token } = await recovery.verifyRecovery({ email: "ann@example.test", code: codeIn(await mailTo("ann@home.test", /code to reset/)) }, { ip });
    await expect(recovery.finishReset({ token, password: "a brand new one" }, { ip })).rejects.toThrow("The mail server is busy.");
    expect(await sessionsOf(ann)).toEqual(["s1"]);
    // The token is still good, to try again.
    expect(await recovery.resetTokenInfo(token)).toMatchObject({ email: "ann@example.test" });
  });
});

describe("backup codes", () => {
  it("are shown once, each works once, and new ones void the old", async () => {
    await expect(recovery.newBackupCodes(ann, { password: "wrong" }, { ip })).rejects.toThrow("Your password isn't right.");
    const { codes, status } = await recovery.newBackupCodes(ann, { password: "pass" }, { ip });
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(status.backupCodes).toMatchObject({ left: 10, total: 10 });
    // Only keyed hashes are kept.
    const kept = await state().selectFrom("backup_codes").select("code_hash").execute();
    expect(kept.map((k) => k.code_hash)).not.toContain(codes[0]);
    await mailTo("ann@example.test", /^Backup codes were made$/);

    // As typed: lower case, spaces, an O for a 0.
    const typed = ` ${codes[0].toLowerCase().replace("-", " ").replace(/0/g, "o")} `;
    expect(await recoverWith(typed)).toEqual({ email: "ann@example.test" });
    expect((await mailTo("ann@example.test", /^Your password was reset$/)).raw).toMatch(/one of your backup codes/);
    expect((await recovery.recoveryStatus(ann)).backupCodes).toMatchObject({ left: 9, total: 10 });
    await expect(recoverWith(codes[0])).rejects.toThrow("That code isn't right, or it has expired.");

    await recovery.newBackupCodes(ann, { password: "pass" }, { ip });
    await mailTo("ann@example.test", /^New backup codes were made$/);
    await expect(recoverWith(codes[1])).rejects.toThrow(/isn't right/);
  });

  it("aren't anyone else's", async () => {
    const { codes } = await recovery.newBackupCodes(bob, { password: "pass" }, { ip });
    await expect(recoverWith(codes[0])).rejects.toThrow(/isn't right/);
  });
});

describe("an admin's reset link", () => {
  it("works once, for a mailbox that never signed in here too, and is recorded", async () => {
    const link = await recovery.createResetLink(ann, { address: "Carol@Example.test" });
    expect(link).toMatchObject({ path: expect.stringMatching(/^\/reset#[A-Za-z0-9_-]{43}$/), email: "carol@example.test" });
    expect(link.expiresAt - Date.now()).toBeGreaterThan(23 * 3_600_000);
    const token = link.path.slice("/reset#".length);
    expect(await recovery.resetTokenInfo(token)).toMatchObject({ email: "carol@example.test", reason: "admin" });
    await recovery.finishReset({ token, password: "carol picks this" }, { ip });
    expect(resets()).toEqual([{ action: "setPassword", login: "carol@example.test", email: "carol@example.test", newPassword: "carol picks this", reason: "admin", by: "ann@example.test" }]);
    expect((await mailTo("carol@example.test", /^Your password was reset$/)).raw).toMatch(/a reset link from ann@example\.test/);
    await expect(recovery.finishReset({ token, password: "and again later" }, { ip })).rejects.toMatchObject({ status: 410 });
    expect(await state().selectFrom("admin_log").select(["actor", "setting", "new_value"]).execute()).toEqual([
      { actor: "ann@example.test", setting: "Password reset link", new_value: '"carol@example.test"' },
    ]);
  });

  it("isn't made where passwords can't be reset", async () => {
    backend(["changePassword"]);
    await expect(recovery.createResetLink(ann, { address: "carol@example.test" })).rejects.toThrow(/can't be reset here/);
  });

  it("voids any other link or recovery waiting for that mailbox once used", async () => {
    const first = (await recovery.createResetLink(ann, { address: "bob@example.test" })).path.slice(7);
    const second = (await recovery.createResetLink(ann, { address: "bob@example.test" })).path.slice(7);
    await recovery.finishReset({ token: second, password: "bob chose this" }, { ip });
    await expect(recovery.finishReset({ token: first, password: "something else" }, { ip })).rejects.toMatchObject({ status: 410 });
  });
});

describe("breached passwords", () => {
  let api: http.Server;
  let asked: string[];
  const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex").toUpperCase();

  beforeAll(async () => {
    api = http.createServer((req, res) => {
      asked.push(`${req.url} ${req.headers["add-padding"]}`);
      const known = sha1("password123");
      const prefix = (req.url ?? "").split("/").pop()!;
      // Padding answers count 0; a real suffix, its count.
      const lines = [`${"0".repeat(35)}:0`, ...(prefix === known.slice(0, 5) ? [`${known.slice(5)}:246875`] : [])];
      res.writeHead(200, { "Content-Type": "text/plain" }).end(lines.join("\r\n"));
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    setBreachApi(`http://127.0.0.1:${(api.address() as net.AddressInfo).port}/range/`);
    readEnvironment({ ...process.env, PASSWORD_BREACH_CHECK: "true" });
  });
  afterAll(() => {
    setBreachApi(null);
    readEnvironment();
    api.close();
  });
  beforeEach(() => (asked = []));

  it("refuses one in a breach, sending only the first five characters of its hash", async () => {
    expect(await newPasswordProblem("password123")).toBe(BREACHED);
    expect(asked).toEqual([`/range/${sha1("password123").slice(0, 5)} true`]);
    expect(await newPasswordProblem("a long and unusual one")).toBeNull();
  });

  it("allows one when the list can't be reached, rather than lock people out", async () => {
    setBreachApi("http://127.0.0.1:1/range/");
    try {
      expect(await newPasswordProblem("password123")).toBeNull();
    } finally {
      setBreachApi(`http://127.0.0.1:${(api.address() as net.AddressInfo).port}/range/`);
    }
  });

  it("applies to a reset", async () => {
    const token = (await recovery.createResetLink(ann, { address: "bob@example.test" })).path.slice(7);
    await expect(recovery.finishReset({ token, password: "password123" }, { ip })).rejects.toThrow(BREACHED);
    expect(resets()).toEqual([]);
  });
});
