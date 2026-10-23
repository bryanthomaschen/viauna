// Sending as other addresses (server/identities.ts): an address is added only if the mail
// server would send as it, then confirmed by a code emailed to it (or, with SEND_AS=server,
// by the server's yes) before mail goes out from it; the tries and codes are limited; an
// address can go through its provider's own server; and 0.5's aliases arrive unconfirmed.
// Local SMTP servers stand in for the mailbox's (refusing senders a login doesn't own, as
// Mailu's does) and for another provider's.
import fs from "node:fs";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Kysely, SqliteDialect } from "kysely";
import { Migrator } from "kysely/migration";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Endpoint, type SettingKey, type SettingValue, config, endpointKey, setOverrides } from "../server/config.ts";
import { type Credentials, sha256 } from "../server/crypto.ts";
import {
  IDENTITY_LIMITS,
  IdentityError,
  addIdentity,
  checkAgain,
  codeEmail,
  confirmCode,
  listIdentities,
  myAddresses,
  removeIdentity,
  routeOf,
  sendCode,
  sendingAddresses,
} from "../server/identities.ts";
import type { AccountInfo, AccountRuntime } from "../server/imap/runtime.ts";
import { ComposeError, sendCalendarMail } from "../server/mail/compose.ts";
import { ProbeError, probeSender } from "../server/mail/smtp-probe.ts";
import { getSettings } from "../server/settings.ts";
import { nodeSqlite } from "../server/state/node-sqlite.ts";
import { migrations } from "../server/state/migrations.ts";
import { type StateStore, openState, setState, state } from "../server/state/db.ts";
import { ENGINES, emptyDatabase } from "./databases.ts";

type Received = { from: string; to: string[]; raw: string; user: string };

/** An SMTP server that takes `passwords` and lets each login send only as the addresses it owns. */
function server(passwords: Record<string, string>, owns: Record<string, string[]>) {
  const received: Received[] = [];
  const smtp = new SMTPServer({
    secure: false, allowInsecureAuth: true, disabledCommands: ["STARTTLS"],
    onAuth: (auth, _s, cb) => (passwords[auth.username ?? ""] === auth.password ? cb(null, { user: auth.username }) : cb(new Error("Invalid credentials"))),
    onMailFrom: (address, session, cb) => {
      if (address.address === "later@example.test") return cb(Object.assign(new Error("Try again later"), { responseCode: 451 }));
      if (!(owns[session.user as string] ?? []).includes(address.address)) {
        return cb(Object.assign(new Error(`Sender address rejected: not owned by user ${session.user}`), { responseCode: 553 }));
      }
      cb();
    },
    onData: (stream, session, cb) => {
      let raw = "";
      stream.on("data", (c: Buffer) => (raw += c.toString()));
      stream.on("end", () => {
        received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address), raw, user: session.user as string });
        cb();
      });
    },
  });
  let port = 0;
  return {
    received,
    smtp,
    endpoint: (): Endpoint => ({ host: "127.0.0.1", port, security: "none", verify: false }),
    listen: () => new Promise<void>((r) => smtp.listen(0, "127.0.0.1", () => ((port = (smtp.server.address() as net.AddressInfo).port), r()))),
  };
}

const mine = server(
  { "me@example.test": "s3cret", sam: "s3cret" },
  { "me@example.test": ["me@example.test", "alias@example.test", "later@example.test"], sam: ["sam@example.test"] },
);
const theirs = server({ "me@elsewhere.test": "other" }, { "me@elsewhere.test": ["me@elsewhere.test"] });
const creds: Credentials = { user: "me@example.test", pass: "s3cret" };
const codeOf = (r: Received) => /^Subject: (\d{4}) (\d{4}) /m.exec(r.raw)!.slice(1).join("");

const policy = (values: Partial<Record<SettingKey, SettingValue>>) => setOverrides(new Map(Object.entries(values) as [SettingKey, SettingValue][]));

beforeAll(async () => {
  await mine.listen();
  await theirs.listen();
});
afterAll(() => {
  mine.smtp.close();
  theirs.smtp.close();
});

describe("asking a mail server about a sender", () => {
  const allowed = config.allowPrivateServers;
  beforeAll(() => {
    config.allowPrivateServers = true;
  });
  afterAll(() => {
    config.allowPrivateServers = allowed;
  });

  it("takes its yes, its no for good and its no for now, and says when it can't sign in", async () => {
    expect(await probeSender(mine.endpoint(), creds, "alias@example.test", "me@example.test")).toEqual({ accepted: true });
    expect(await probeSender(mine.endpoint(), creds, "boss@example.test", "me@example.test")).toMatchObject({ accepted: false, permanent: true, reply: expect.stringMatching(/^553 .*not owned/) });
    expect(await probeSender(mine.endpoint(), creds, "later@example.test", "me@example.test")).toMatchObject({ accepted: false, permanent: false });
    await expect(probeSender(mine.endpoint(), { user: "me@example.test", pass: "wrong" }, "me@example.test", "me@example.test")).rejects.toMatchObject({ auth: true });
    await expect(probeSender({ ...mine.endpoint(), security: "starttls" }, creds, "me@example.test", "me@example.test")).rejects.toThrow(ProbeError);
  });

  it("sends nothing", () => {
    expect(mine.received).toHaveLength(0);
  });
});

describe("the email with a code", () => {
  it("says who asked, the code, and that nothing happens without it", () => {
    const mail = codeEmail({ from: "me@example.test", fromName: "Me", address: "alias@example.test", code: "12345678" });
    expect(mail.subject).toBe("1234 5678 is your code to send as alias@example.test");
    expect(mail.text).toContain("Me (me@example.test) asked to send mail as alias@example.test");
    expect(mail.text).toContain("nothing is sent as alias@example.test without the code");
    expect(codeEmail({ from: "a@x.test", fromName: "", address: "a@x.test", code: "12345678" }).text).toMatch(/^You asked to send mail as a@x\.test/);
  });
});

describe.each(ENGINES)("addresses to send as, on $name", ({ url }) => {
  let store: StateStore;
  let dir: string;
  const saved = { allowPrivateServers: config.allowPrivateServers };
  const account = (id: number): AccountInfo => {
    const [login, email] = id === 7 ? ["me@example.test", "me@example.test"] : ["sam", "sam@example.test"];
    return { id, login, email, imap: { host: "imap.example.test", port: 993, security: "tls", verify: true }, smtp: mine.endpoint() };
  };
  const me = () => account(7);

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "viauna-identities-"));
    if (url) await emptyDatabase(url);
    store = await openState(url, path.join(dir, "state.db"));
  });

  afterAll(async () => {
    await store.db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    setState(store);
    config.allowPrivateServers = true;
    policy({});
    mine.received.length = 0;
    theirs.received.length = 0;
    await state().deleteFrom("identities").execute();
    await state().deleteFrom("accounts").execute();
    for (const a of [account(7), account(8)]) {
      const json = endpointKey(a.imap);
      await state().insertInto("accounts").values({ id: a.id, login: a.login, email: a.email, imap: json, imap_hash: sha256(json), smtp: JSON.stringify(a.smtp), settings: JSON.stringify({ name: "Me" }), created_at: 1 }).execute();
    }
  });

  afterEach(() => {
    Object.assign(config, saved);
    policy({});
    setState(null);
  });

  it("has the mailbox's own address, confirmed by signing in with it", async () => {
    expect(await listIdentities(me(), creds)).toEqual([
      expect.objectContaining({ id: null, address: "me@example.test", name: "Me", own: true, confirmed: true, confirmedBy: "login", usable: true }),
    ]);
    expect(await sendingAddresses(me())).toEqual(new Set(["me@example.test"]));
  });

  it("turns down an address the mail server won't send as, keeping nothing", async () => {
    await expect(addIdentity(me(), creds, { address: "boss@example.test" })).rejects.toThrow(/won't send as boss@example\.test: 553/);
    await expect(addIdentity(me(), creds, { address: "later@example.test" })).rejects.toThrow(/try again later/);
    await expect(addIdentity(me(), creds, { address: "not an address" })).rejects.toThrow(IdentityError);
    await expect(addIdentity(me(), creds, { address: "me@example.test" })).rejects.toThrow(/own address/);
    expect(await listIdentities(me(), creds)).toHaveLength(1);
    expect(mine.received).toHaveLength(0);
  });

  it("emails a code to a new address, and sends as it only once the code is entered", async () => {
    const { identity, warning } = await addIdentity(me(), creds, { name: "Alias", address: "Alias@Example.test" });
    expect(warning).toBeNull();
    expect(identity).toMatchObject({ address: "alias@example.test", name: "Alias", confirmed: false, usable: false, codeSentAt: expect.any(Number) });
    expect(mine.received).toHaveLength(1);
    const mail = mine.received[0];
    // From the mailbox, signed in as it, to the address.
    expect(mail).toMatchObject({ from: "me@example.test", to: ["alias@example.test"], user: "me@example.test" });
    expect((await simpleParser(mail.raw)).headers.get("auto-submitted")).toBe("auto-generated");
    expect(await sendingAddresses(me())).toEqual(new Set(["me@example.test"]));
    expect(await myAddresses(7, "me@example.test")).toEqual(new Set(["me@example.test"]));

    const code = codeOf(mail);
    const wrong = code === "00000000" ? "11111111" : "00000000";
    await expect(confirmCode(me(), identity.id!, wrong)).rejects.toThrow(/isn't right. 4 more tries/);
    await confirmCode(me(), identity.id!, `${code.slice(0, 4)} ${code.slice(4)}`);
    expect((await listIdentities(me(), creds))[1]).toMatchObject({ confirmed: true, confirmedBy: "code", usable: true, codeSentAt: null });
    expect(await sendingAddresses(me())).toEqual(new Set(["me@example.test", "alias@example.test"]));
    expect(await myAddresses(7, "me@example.test")).toEqual(new Set(["me@example.test", "alias@example.test"]));
  });

  it("takes five tries at a code, then wants a new one", async () => {
    const { identity } = await addIdentity(me(), creds, { address: "alias@example.test" });
    const code = codeOf(mine.received[0]);
    const wrong = code === "00000000" ? "11111111" : "00000000";
    for (let i = 0; i < IDENTITY_LIMITS.tries; i++) await expect(confirmCode(me(), identity.id!, wrong)).rejects.toThrow(/isn't right/);
    await expect(confirmCode(me(), identity.id!, code)).rejects.toThrow(/Too many wrong codes/);
    expect((await listIdentities(me(), creds))[1]).toMatchObject({ confirmed: false, codeSentAt: null });
  });

  it("sends a code at most once a minute and five times a day to an address", async () => {
    const { identity } = await addIdentity(me(), creds, { address: "alias@example.test" });
    await expect(sendCode(me(), creds, identity.id!)).rejects.toThrow(/less than a minute ago/);
    await state().updateTable("identities").set({ code_sent_at: 1, codes_sent: IDENTITY_LIMITS.codesPerDay }).execute();
    await expect(sendCode(me(), creds, identity.id!)).rejects.toThrow(/Try again tomorrow/);
    // A new day starts the count again; the earlier code stops working once a new one is sent.
    await state().updateTable("identities").set({ codes_day: 0 }).execute();
    const before = codeOf(mine.received[0]);
    await sendCode(me(), creds, identity.id!);
    const after = codeOf(mine.received[1]);
    if (before !== after) await expect(confirmCode(me(), identity.id!, before)).rejects.toThrow(/isn't right/);
    await confirmCode(me(), identity.id!, after);
  });

  it("with SEND_AS=server, takes the server's yes; back with codes, wants one", async () => {
    policy({ sendAs: "server" });
    const { identity } = await addIdentity(me(), creds, { address: "alias@example.test" });
    expect(identity).toMatchObject({ confirmed: true, confirmedBy: "server", usable: true });
    expect(mine.received).toHaveLength(0);
    expect(await checkAgain(me(), creds, identity.id!)).toBe(true);
    policy({});
    expect((await listIdentities(me(), creds))[1]).toMatchObject({ confirmed: false, usable: false });
    expect(await checkAgain(me(), creds, identity.id!)).toBe(false);
    await sendCode(me(), creds, identity.id!);
    await confirmCode(me(), identity.id!, codeOf(mine.received[0]));
    expect(await sendingAddresses(me())).toContain("alias@example.test");
  });

  it("with SEND_AS=off, adds none and sends only from the mailbox's own address", async () => {
    const { identity } = await addIdentity(me(), creds, { address: "alias@example.test" });
    await confirmCode(me(), identity.id!, codeOf(mine.received[0]));
    policy({ sendAs: "off" });
    await expect(addIdentity(me(), creds, { address: "alias2@example.test" })).rejects.toThrow(/only from each mailbox's own address/);
    expect((await listIdentities(me(), creds))[1]).toMatchObject({ confirmed: true, usable: false });
    expect(await sendingAddresses(me())).toEqual(new Set(["me@example.test"]));
    await removeIdentity(me(), identity.id!);
    expect(await listIdentities(me(), creds)).toHaveLength(1);
  });

  it("confirms the address typed beside a separate username like any other, by a code to itself", async () => {
    const sam = account(8);
    const samCreds = { user: "sam", pass: "s3cret" };
    expect((await listIdentities(sam, samCreds))[0]).toMatchObject({ own: true, confirmed: false, usable: false });
    expect(await sendingAddresses(sam)).toEqual(new Set());
    await sendCode(sam, samCreds, "own");
    expect(mine.received[0]).toMatchObject({ from: "sam@example.test", to: ["sam@example.test"], user: "sam" });
    expect(mine.received[0].raw).toMatch(/You asked to send mail as sam@example\.test/);
    await confirmCode(sam, "own", codeOf(mine.received[0]));
    expect((await listIdentities(sam, samCreds))[0]).toMatchObject({ own: true, confirmed: true, confirmedBy: "code", usable: true });
    await expect(sendCode(me(), creds, "own")).rejects.toThrow(/confirmed already/);
  });

  it("sends an address through its provider's server, with the password only the session holds", async () => {
    const server = { host: "127.0.0.1", port: theirs.endpoint().port, security: "none", login: "me@elsewhere.test", password: "other" };
    await expect(addIdentity(me(), creds, { address: "me@elsewhere.test", server })).rejects.toThrow(/doesn't send through other providers/);
    policy({ sendAsServers: true });
    await expect(addIdentity(me(), creds, { address: "me@elsewhere.test", server: { ...server, password: "wrong" } })).rejects.toThrow(/didn't accept that username and password/);
    await expect(addIdentity(me(), creds, { address: "boss@elsewhere.test", server: { ...server } })).rejects.toThrow(/That mail server won't send as/);
    const added = await addIdentity(me(), creds, { address: "me@elsewhere.test", server });
    expect(added.server).toEqual({ user: "me@elsewhere.test", pass: "other" });
    expect(added.identity).toMatchObject({ server: { host: "127.0.0.1", login: "me@elsewhere.test" }, password: true, confirmed: false });
    // The code went from the address to itself through its own server.
    expect(mine.received).toHaveLength(0);
    expect(theirs.received[0]).toMatchObject({ from: "me@elsewhere.test", to: ["me@elsewhere.test"], user: "me@elsewhere.test" });
    await confirmCode(me(), added.identity.id!, codeOf(theirs.received[0]));
    // Nothing of the password is kept at rest.
    const row = await state().selectFrom("identities").selectAll().where("id", "=", added.identity.id!).executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain("other");
    // A session without the password can't send from it; one with it goes through that server.
    await expect(routeOf(me(), creds, "me@elsewhere.test")).rejects.toThrow(/Enter the password/);
    const withIt = { ...creds, servers: { [added.identity.id!]: added.server! } };
    expect(await routeOf(me(), withIt, "me@elsewhere.test")).toMatchObject({ endpoint: { port: theirs.endpoint().port, custom: true }, creds: added.server });
    expect(await routeOf(me(), withIt, "me@example.test")).toMatchObject({ endpoint: me().smtp, creds: withIt });
    policy({});
    expect((await listIdentities(me(), withIt))[1]).toMatchObject({ confirmed: true, usable: false });
  });

  it("answers invitations only from a confirmed address, and as it", async () => {
    const rt = { account: me() } as AccountRuntime;
    const invite = { to: [{ address: "pat@example.test" }], subject: "Accepted: Review", text: "Yes.", html: "<p>Yes.</p>", method: "REPLY" as const, ics: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n" };
    const { identity } = await addIdentity(me(), creds, { name: "Alias", address: "alias@example.test" });
    await expect(sendCalendarMail(rt, creds, invite, "alias@example.test")).rejects.toThrow(ComposeError);
    await confirmCode(me(), identity.id!, codeOf(mine.received[0]));
    await sendCalendarMail(rt, creds, invite, "alias@example.test");
    expect(mine.received[1]).toMatchObject({ from: "alias@example.test", to: ["pat@example.test"] });
    expect((await simpleParser(mine.received[1].raw)).from?.value[0]).toEqual({ name: "Alias", address: "alias@example.test" });
  });
});

describe("upgrading to confirmed addresses", () => {
  it("moves the aliases kept in settings into the list, not confirmed", async () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec("PRAGMA foreign_keys = ON;");
    const old = new Kysely<any>({ dialect: new SqliteDialect({ database: nodeSqlite(raw) }) });
    const migrator = new Migrator({ db: old, provider: migrations("sqlite"), migrationTableName: "viauna_migrations", migrationLockTableName: "viauna_migration_lock" });
    expect((await migrator.migrateTo("0011_push_subscriptions")).error).toBeUndefined();
    const settings = { name: "Me", aliases: [{ name: "Work", address: "Work@Example.test" }, { name: "", address: "me@example.test" }, { name: "x", address: "broken" }] };
    await old.insertInto("accounts").values({ id: 7, login: "me@example.test", email: "me@example.test", imap: "{}", imap_hash: "h", smtp: "{}", settings: JSON.stringify(settings), created_at: 1 }).execute();
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    expect(await old.selectFrom("identities").select(["account_id", "address", "name", "confirmed_at"]).execute()).toEqual([
      { account_id: 7, address: "work@example.test", name: "Work", confirmed_at: null },
    ]);
    expect(JSON.parse((await old.selectFrom("accounts").select("settings").executeTakeFirstOrThrow()).settings)).toEqual({ name: "Me" });
    await old.destroy();
  });

  it("reads settings without the old list", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viauna-identities-"));
    const store = await openState(undefined, path.join(dir, "state.db"));
    setState(store);
    await state().insertInto("accounts").values({ id: 9, login: "a", email: "a", imap: "{}", imap_hash: "h", smtp: "{}", settings: JSON.stringify({ name: "A", aliases: [] }), created_at: 1 }).execute();
    expect(await getSettings(9)).not.toHaveProperty("aliases");
    setState(null);
    await store.db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
