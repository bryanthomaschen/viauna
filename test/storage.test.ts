// The state store on each engine, copying between stores, the upgrade from 0.1's
// single viauna.db, and keeping the index's accounts in step with the store's.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptCredentials, encryptCredentials, sha256 } from "../server/crypto.ts";
import { Database, INDEX_MIGRATIONS, db, setDatabase } from "../server/db.ts";
import { ensureIndexAccount } from "../server/imap/store.ts";
import { copyState } from "../server/state/copy.ts";
import { type StateStore, isUniqueViolation, openState, orIgnore, setState, state } from "../server/state/db.ts";
import { closeStorage, initStorage } from "../server/storage.ts";
import { ENGINES, emptyDatabase } from "./databases.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "viauna-test-"));
const imap = JSON.stringify({ host: "imap.example.test", port: 993, security: "tls", servername: null, verify: true });
const account = (id: number, login: string) => ({
  id, login, email: login, imap, imap_hash: sha256(imap), smtp: "{}", settings: "{}", created_at: 1_760_000_000_123,
});

describe.each(ENGINES)("state store on $name", ({ url }) => {
  let store: StateStore;
  let dir: string;

  beforeEach(async () => {
    dir = tmp();
    if (url) await emptyDatabase(url);
    store = await openState(url, path.join(dir, "state.db"));
    setState(store);
  });

  afterEach(async () => {
    await store.db.destroy();
    setState(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("migrates once and again without effect", async () => {
    const again = await openState(url, path.join(dir, "state.db"));
    await again.db.destroy();
    expect(await state().selectFrom("accounts").selectAll().execute()).toEqual([]);
  });

  it("keeps 64-bit times, binary credentials and exact text", async () => {
    const credential = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37) % 256));
    await state().insertInto("accounts").values([account(1, "Bob@example.test"), account(2, "bob@example.test")]).execute();
    await state().insertInto("sessions").values({ id: "s".repeat(64), created_at: 1, seen_at: 2, expires_at: 9_000_000_000_000, user_agent: null, ip: "::1" }).execute();
    await state().insertInto("session_accounts").values({ session_id: "s".repeat(64), account_id: 1, position: 0, credential }).execute();

    const rows = await state().selectFrom("accounts").select(["id", "login", "created_at"]).orderBy("id").execute();
    expect(rows).toEqual([
      { id: 1, login: "Bob@example.test", created_at: 1_760_000_000_123 },
      { id: 2, login: "bob@example.test", created_at: 1_760_000_000_123 },
    ]);
    const s = await state().selectFrom("sessions").select("expires_at").executeTakeFirstOrThrow();
    expect(s.expires_at).toBe(9_000_000_000_000);
    const sa = await state().selectFrom("session_accounts").select("credential").executeTakeFirstOrThrow();
    expect(Buffer.from(sa.credential).equals(credential)).toBe(true);
  });

  it("reports duplicates, and can skip them", async () => {
    await state().insertInto("accounts").values(account(1, "a@example.test")).execute();
    const sender = { account_id: 1, address: "news@example.test" };
    await state().insertInto("trusted_senders").values(sender).execute();
    const err = await state().insertInto("trusted_senders").values(sender).execute().catch((e) => e);
    expect(isUniqueViolation(err)).toBe(true);
    await orIgnore(state().insertInto("trusted_senders").values(sender)).execute();
    expect(await state().selectFrom("trusted_senders").selectAll().execute()).toHaveLength(1);
  });

  it("cascades deletes from sessions and accounts", async () => {
    await state().insertInto("accounts").values(account(1, "a@example.test")).execute();
    await state().insertInto("sessions").values({ id: "x", created_at: 1, seen_at: 1, expires_at: 2, user_agent: null, ip: null }).execute();
    await state().insertInto("session_accounts").values({ session_id: "x", account_id: 1, position: 0, credential: Buffer.from([1]) }).execute();
    await state().insertInto("labels").values({ account_id: 1, keyword: "food", name: "Food", color: "#16a766", created_at: 1 }).execute();
    await state().deleteFrom("sessions").where("id", "=", "x").execute();
    expect(await state().selectFrom("session_accounts").selectAll().execute()).toEqual([]);
    await state().deleteFrom("accounts").where("id", "=", 1).execute();
    expect(await state().selectFrom("labels").selectAll().execute()).toEqual([]);
  });

  it("copies another store in, keeping ids, and numbers new accounts after them", async () => {
    const source = await openState(undefined, ":memory:");
    await source.db.insertInto("accounts").values([account(5, "a@example.test"), account(9, "b@example.test")]).execute();
    await source.db.insertInto("labels").values({ account_id: 9, keyword: "food", name: "Food", color: null, created_at: 1 }).execute();
    const counts = await copyState(source.db, store);
    await source.db.destroy();
    expect(counts).toMatchObject({ accounts: 2, labels: 1 });

    const { id: _id, ...fresh } = account(0, "c@example.test");
    await state().insertInto("accounts").values(fresh).execute();
    const ids = (await state().selectFrom("accounts").select("id").orderBy("id").execute()).map((r) => r.id);
    expect(ids).toEqual([5, 9, 10]);
  });
});

describe("upgrading from 0.1's single viauna.db", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmp();
  });

  afterEach(async () => {
    await closeStorage().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** viauna.db as 0.1 left it: index migrations 1–2, with an account, a session and a mailbox. */
  function legacyDatabase(creds: { user: string; pass: string }) {
    const raw = new DatabaseSync(path.join(dir, "viauna.db"));
    raw.exec("PRAGMA journal_mode = WAL;");
    for (const m of INDEX_MIGRATIONS.slice(0, 2)) raw.exec(m);
    raw.exec("PRAGMA user_version = 2");
    raw.prepare("INSERT INTO accounts (id, login, email, imap, smtp, settings, created_at) VALUES (7, ?, ?, ?, '{}', ?, 1)")
      .run(creds.user, creds.user, imap, JSON.stringify({ name: "Ann" }));
    raw.prepare("INSERT INTO sessions (id, created_at, seen_at, expires_at, user_agent, ip) VALUES ('h', 1, 1, 9000000000000, 'UA', '::1')").run();
    raw.prepare("INSERT INTO session_accounts (session_id, account_id, position, credential) VALUES ('h', 7, 0, ?)")
      .run(encryptCredentials(creds, "cookie-key", "h", 7));
    raw.prepare("INSERT INTO labels (account_id, keyword, name, color, created_at) VALUES (7, 'travel', 'Travel', '#4a86e8', 1)").run();
    raw.prepare("INSERT INTO trusted_senders (account_id, address) VALUES (7, 'news@example.test')").run();
    raw.prepare("INSERT INTO mailboxes (id, account_id, path, name) VALUES (1, 7, 'INBOX', 'INBOX')").run();
    raw.close();
    fs.mkdirSync(path.join(dir, "cache", "7"), { recursive: true });
    fs.writeFileSync(path.join(dir, "cache", "7", "1-1-1.eml"), "old layout");
  }

  for (const { name, url } of ENGINES) {
    it(`moves state into ${name} and keeps the rest as index.db`, async () => {
      if (url) await emptyDatabase(url);
      const creds = { user: "ann@example.test", pass: "secret" };
      legacyDatabase(creds);
      await initStorage({ dataDir: dir, databaseUrl: url });

      const acct = await state().selectFrom("accounts").selectAll().executeTakeFirstOrThrow();
      expect(acct).toMatchObject({ id: 7, login: creds.user, imap_hash: sha256(imap), settings: JSON.stringify({ name: "Ann" }) });
      const sa = await state().selectFrom("session_accounts").selectAll().executeTakeFirstOrThrow();
      expect(decryptCredentials(sa.credential, "cookie-key", "h", 7)).toEqual(creds);
      expect(await state().selectFrom("labels").select(["keyword", "color"]).execute()).toEqual([{ keyword: "travel", color: "#4a86e8" }]);
      expect(await state().selectFrom("trusted_senders").select("address").execute()).toEqual([{ address: "news@example.test" }]);

      expect(fs.existsSync(path.join(dir, "viauna.db"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "index.db"))).toBe(true);
      expect(db().get("SELECT name FROM sqlite_master WHERE name = 'sessions'")).toBeUndefined();
      expect(db().all("SELECT keyword FROM label_keywords")).toEqual([{ keyword: "travel" }]);
      expect(db().get("SELECT path FROM mailboxes WHERE account_id = 7")).toEqual({ path: "INBOX" });
      expect(fs.existsSync(path.join(dir, "cache", "7"))).toBe(false);
    });
  }

  it("fills an empty server database from state.db when DATABASE_URL is set later", async () => {
    const external = ENGINES.find((e) => e.url);
    if (!external) return;
    await emptyDatabase(external.url!);
    await initStorage({ dataDir: dir, databaseUrl: undefined });
    await state().insertInto("accounts").values(account(3, "c@example.test")).execute();
    await closeStorage();

    await initStorage({ dataDir: dir, databaseUrl: external.url });
    expect((await state().selectFrom("accounts").select("id").execute()).map((r) => r.id)).toEqual([3]);
  });
});

describe("the index's accounts", () => {
  beforeEach(() => {
    setDatabase(new Database(":memory:"));
    db().run("INSERT INTO accounts (id, login, email, imap, smtp, created_at) VALUES (1, 'a@x', 'a@x', '{}', '{}', 0)");
    db().run("INSERT INTO mailboxes (id, account_id, path, name) VALUES (1, 1, 'INBOX', 'INBOX')");
    db().run("INSERT INTO thread_refs (account_id, message_id, thread_id) VALUES (1, '<m@x>', 1)");
  });

  it("are left alone when they match the state store", () => {
    ensureIndexAccount({ id: 1, login: "a@x", email: "a@x", imap: "{}", smtp: "{}" });
    expect(db().get("SELECT COUNT(*) AS n FROM mailboxes")).toEqual({ n: 1 });
  });

  it("drop another account's index rather than show it under a reused id", () => {
    ensureIndexAccount({ id: 1, login: "b@x", email: "b@x", imap: "{}", smtp: "{}" });
    expect(db().get("SELECT login FROM accounts WHERE id = 1")).toEqual({ login: "b@x" });
    expect(db().get("SELECT COUNT(*) AS n FROM mailboxes")).toEqual({ n: 0 });
    expect(db().get("SELECT COUNT(*) AS n FROM thread_refs")).toEqual({ n: 0 });
  });

  it("move a mailbox's index to its new id", () => {
    ensureIndexAccount({ id: 2, login: "a@x", email: "a@x", imap: "{}", smtp: "{}" });
    expect(db().all("SELECT id FROM accounts")).toEqual([{ id: 2 }]);
  });
});
