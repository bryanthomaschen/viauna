// The address book (server/contacts.ts) on each state-store engine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Kysely, SqliteDialect } from "kysely";
import { Migrator } from "kysely/migration";
import { DatabaseSync } from "node:sqlite";
import {
  ContactError,
  contactLabels,
  contactsToTidy,
  createContact,
  deleteContacts,
  exportVCards,
  getContact,
  importVCards,
  listContacts,
  removeLabel,
  renameLabel,
  suggest,
  tidyContacts,
  updateContact,
} from "../server/contacts.ts";
import { sha256 } from "../server/crypto.ts";
import { Database, db, setDatabase } from "../server/db.ts";
import { ensureIndexAccount } from "../server/imap/store.ts";
import { migrations } from "../server/state/migrations.ts";
import { nodeSqlite } from "../server/state/node-sqlite.ts";
import { type StateStore, openState, setState, state } from "../server/state/db.ts";
import { parseVCards, readFields } from "../server/vcard.ts";
import { ENGINES, emptyDatabase } from "./databases.ts";

const imap = JSON.stringify({ host: "imap.example.test", port: 993, security: "tls", servername: null, verify: true });
const account = { id: 7, login: "me@example.test", email: "me@example.test", imap, smtp: "{}" };

const GOOGLE_EXPORT = [
  "BEGIN:VCARD", "VERSION:3.0", "FN:Ann Lee", "N:Lee;Ann;;;", "EMAIL;TYPE=INTERNET;TYPE=HOME:ann@example.com",
  "PHOTO:https://example.com/ann.jpg", "END:VCARD",
  "BEGIN:VCARD", "VERSION:3.0", "FN:Élodie Martin", "N:Martin;Élodie;;;", "EMAIL;TYPE=INTERNET:elodie@example.fr",
  "TEL;TYPE=CELL:+33 6 12 34 56 78", "ORG:Atelier", "END:VCARD",
  "BEGIN:VCARD", "VERSION:3.0", "N:;;;;", "END:VCARD", // names nobody: skipped
].join("\r\n");

const fields = (over: Record<string, unknown> = {}) => ({
  firstName: "Bob", lastName: "Tan", nickname: "", emails: [{ address: "bob@work.example", label: "work" }], phones: [],
  organization: "", title: "", birthday: "", dates: [], labels: [], notes: "", ...over,
});

describe.each(ENGINES)("the address book on $name", ({ url }) => {
  let store: StateStore;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "viauna-contacts-"));
    if (url) await emptyDatabase(url);
    store = await openState(url, path.join(dir, "state.db"));
    setDatabase(new Database(path.join(dir, "index.db")));
  });

  afterAll(async () => {
    await store.db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    setState(store);
    await state().deleteFrom("contacts").execute();
    await state().deleteFrom("accounts").execute();
    await state()
      .insertInto("accounts")
      .values({ ...account, imap_hash: sha256(imap), settings: "{}", created_at: 1 })
      .execute();
    ensureIndexAccount(account);
    db().run("DELETE FROM contacts");
  });

  afterEach(() => setState(null));

  it("creates, finds and sorts contacts, accents and case aside", async () => {
    const bob = await createContact(7, fields());
    await createContact(7, fields({ firstName: "élise", lastName: "", emails: [] , organization: "Atelier" }));
    await createContact(7, fields({ firstName: "Adam", lastName: "Zed", emails: [{ address: "adam@example.com", label: "" }] }));
    expect(bob).toMatchObject({ name: "Bob Tan", fields: { emails: [{ address: "bob@work.example", label: "work" }] } });

    const all = await listContacts(7, "");
    expect(all.total).toBe(3);
    expect(all.contacts.map((c) => c.name)).toEqual(["Adam Zed", "Bob Tan", "élise"]);
    expect((await listContacts(7, "ELISE")).contacts.map((c) => c.name)).toEqual(["élise"]);
    expect((await listContacts(7, "work.example")).contacts.map((c) => c.name)).toEqual(["Bob Tan"]);
    expect((await listContacts(7, "50%_off!")).total).toBe(0);
    expect((await listContacts(8, "")).total).toBe(0);
  });

  it("edits only what the page shows, and keeps the rest of the card", async () => {
    await importVCards(7, GOOGLE_EXPORT);
    const ann = (await listContacts(7, "ann")).contacts[0];
    const updated = await updateContact(7, ann.id, fields({ firstName: "Annie", lastName: "Lee", emails: [{ address: "annie@example.com", label: "home" }] }));
    expect(updated?.name).toBe("Annie Lee");
    const [card] = parseVCards(await exportVCards(7, [ann.id]));
    expect(card.props.find((p) => p.name === "PHOTO")?.value).toBe("https://example.com/ann.jpg");
    expect(readFields(card).emails).toEqual([{ address: "annie@example.com", label: "home" }]);
    // Its addresses follow the edit, for suggestions.
    expect((await suggest(7, "ann@", true)).map((s) => s.address)).toEqual([]);
    expect((await suggest(7, "annie", true)).map((s) => s.address)).toEqual(["annie@example.com"]);
  });

  it("refuses a contact that names nobody, or an address that isn't one", async () => {
    await expect(createContact(7, fields({ firstName: "", lastName: "", emails: [] }))).rejects.toBeInstanceOf(ContactError);
    await expect(createContact(7, fields({ emails: [{ address: "not an address" }] }))).rejects.toThrow(/isn't an email address/);
    await expect(updateContact(7, 99999, fields())).rejects.toThrow(/no longer exists/);
  });

  it("imports a Google export, and importing it again changes nothing", async () => {
    expect(await importVCards(7, GOOGLE_EXPORT)).toEqual({ added: 2, updated: 0, unchanged: 0, skipped: 1 });
    expect(await importVCards(7, GOOGLE_EXPORT)).toEqual({ added: 0, updated: 0, unchanged: 2, skipped: 1 });
    expect((await listContacts(7, "")).contacts.map((c) => c.name)).toEqual(["Ann Lee", "Élodie Martin"]);
    const withUid = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:abc-1\r\nFN:Chen\r\nEND:VCARD\r\n";
    expect(await importVCards(7, withUid)).toMatchObject({ added: 1 });
    expect(await importVCards(7, withUid.replace("FN:Chen", "FN:Chen Wei"))).toMatchObject({ updated: 1 });
    expect((await listContacts(7, "chen")).contacts.map((c) => c.name)).toEqual(["Chen Wei"]);
    await expect(importVCards(7, "hello")).rejects.toThrow(/no contacts/);
  });

  it("exports every contact as one file that imports back", async () => {
    await importVCards(7, GOOGLE_EXPORT);
    await createContact(7, fields());
    const file = await exportVCards(7);
    expect(parseVCards(file)).toHaveLength(3);
    await state().deleteFrom("contacts").execute();
    expect(await importVCards(7, file)).toMatchObject({ added: 3 });
  });

  it("deletes contacts with their addresses", async () => {
    const bob = await createContact(7, fields());
    expect(await deleteContacts(7, [bob!.id])).toBe(1);
    expect(await getContact(7, bob!.id)).toBeNull();
    expect(await state().selectFrom("contact_emails").selectAll().execute()).toEqual([]);
    expect(await deleteContacts(8, [1])).toBe(0);
  });

  it("suggests saved contacts first, then the people this mailbox writes to", async () => {
    db().run("INSERT INTO contacts (account_id, address, name, sent, received, last_at) VALUES (7, 'bob.personal@example.com', 'Bobby', 5, 5, 1)");
    db().run("INSERT INTO contacts (account_id, address, name, sent, received, last_at) VALUES (7, 'bob@work.example', 'B. Tan', 1, 0, 1)");
    await createContact(7, fields());
    const s = await suggest(7, "bob", true);
    expect(s).toEqual([
      { address: "bob@work.example", name: "Bob Tan", labels: [] },
      { address: "bob.personal@example.com", name: "Bobby", labels: [] },
    ]);
    // With contacts turned off, only the index suggests.
    expect((await suggest(7, "bob", false)).map((x) => x.name)).toEqual(["Bobby", "B. Tan"]);
  });
  it("labels contacts, lists by label, and renames or removes a label everywhere", async () => {
    const bob = await createContact(7, fields({ labels: ["Church", "Work"] }));
    const ann = await createContact(7, fields({ firstName: "Ann", lastName: "Lee", emails: [{ address: "ann@example.com", label: "" }], labels: ["church"] }));
    await createContact(7, fields({ firstName: "Cy", lastName: "", emails: [] }));
    expect(bob?.fields.labels).toEqual(["Church", "Work"]);
    expect(await contactLabels(7)).toEqual([{ label: "Church", count: 2 }, { label: "Work", count: 1 }]);
    expect((await listContacts(7, "", 0, 200, "CHURCH")).contacts.map((c) => [c.name, c.labels])).toEqual([["Ann Lee", ["church"]], ["Bob Tan", ["Church", "Work"]]]);
    expect((await listContacts(7, "ann", 0, 200, "church")).total).toBe(1);
    await expect(createContact(7, fields({ labels: ["x".repeat(61)] }))).rejects.toThrow(/at most 60/);

    // Renaming into a label the contact has already leaves it once.
    expect(await renameLabel(7, "church", "Work")).toBe(2);
    expect((await getContact(7, bob!.id))?.fields.labels).toEqual(["Work"]);
    expect((await getContact(7, ann!.id))?.fields.labels).toEqual(["Work"]);
    expect(await removeLabel(7, "work")).toBe(2);
    expect(await contactLabels(7)).toEqual([]);
    expect((await listContacts(7, "")).total).toBe(3);
  });

  it("keeps birthdays and other dates, and refuses ones that aren't dates", async () => {
    const kai = await createContact(7, fields({ firstName: "Kai", birthday: "--02-29", dates: [{ date: "2015-06-20", label: "Anniversary" }, { date: "2020-01-06", label: "First day" }] }));
    expect(kai?.fields).toMatchObject({ birthday: "--02-29", dates: [{ date: "2015-06-20", label: "anniversary" }, { date: "2020-01-06", label: "First day" }] });
    const rows = await state().selectFrom("contact_dates").select(["kind", "label", "year", "month", "day"]).where("contact_id", "=", kai!.id).orderBy("position").execute();
    expect(rows).toEqual([
      { kind: "birthday", label: "", year: null, month: 2, day: 29 },
      { kind: "anniversary", label: "", year: 2015, month: 6, day: 20 },
      { kind: "other", label: "First day", year: 2020, month: 1, day: 6 },
    ]);
    await expect(createContact(7, fields({ birthday: "12 May" }))).rejects.toThrow(/day and a month/);
    await expect(createContact(7, fields({ birthday: "1990-02-29" }))).rejects.toThrow(/day and a month/);
    // Another app's own wording can stay as it is, but not be typed in.
    await importVCards(7, "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:old-1\r\nFN:Old Friend\r\nN:Friend;Old;;;\r\nBDAY;VALUE=text:circa 1950\r\nEND:VCARD\r\n");
    const old = (await listContacts(7, "old friend")).contacts[0];
    const got = await getContact(7, old.id);
    expect(got?.fields.birthday).toBe("circa 1950");
    expect((await updateContact(7, old.id, { ...got!.fields, title: "Neighbour" }))?.fields.birthday).toBe("circa 1950");
    await expect(updateContact(7, old.id, { ...got!.fields, birthday: "circa 1951" })).rejects.toThrow(/day and a month/);
  });

  it("matches nicknames while writing, and brings the labels along, but not into the name", async () => {
    await createContact(7, fields({ nickname: "Bobby, Rob", labels: ["Church"] }));
    expect(await suggest(7, "rob", true)).toEqual([{ address: "bob@work.example", name: "Bob Tan", labels: ["Church"] }]);
    expect((await listContacts(7, "bobby")).total).toBe(1);
  });

  it("finds names with context after them, and moves it into a label when asked", async () => {
    const bryan = await createContact(7, fields({ firstName: "Bryan", lastName: "- church", emails: [{ address: "bryan@example.com", label: "" }] }));
    const mei = await createContact(7, fields({ firstName: "Mei", lastName: "Ling (Work)", emails: [{ address: "mei@example.com", label: "" }] }));
    await createContact(7, fields({ firstName: "Jo", lastName: "Smith (Jr.)", emails: [] }));
    await createContact(7, fields({ firstName: "Mary-Jane", lastName: "Watson", emails: [] }));
    await createContact(7, fields({ firstName: "Old", lastName: "Mate", labels: ["Church"], emails: [] }));
    expect(await contactsToTidy(7)).toEqual([
      { id: bryan!.id, name: "Bryan - church", firstName: "Bryan", lastName: "", label: "Church" },
      { id: mei!.id, name: "Mei Ling (Work)", firstName: "Mei", lastName: "Ling", label: "Work" },
    ]);
    expect(await tidyContacts(7, [{ id: bryan!.id, label: "Church" }, { id: 99999, label: "X" }])).toBe(1);
    expect(await getContact(7, bryan!.id)).toMatchObject({ name: "Bryan", fields: { firstName: "Bryan", lastName: "", labels: ["Church"] } });
    // A second time, it's done.
    expect(await tidyContacts(7, [{ id: bryan!.id, label: "Church" }])).toBe(0);
    expect((await suggest(7, "bryan", true))[0]).toMatchObject({ name: "Bryan", labels: ["Church"] });
  });
});

describe("upgrading to labels and dates", () => {
  it("fills them in from the contacts already kept", async () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec("PRAGMA foreign_keys = ON;");
    const old = new Kysely<any>({ dialect: new SqliteDialect({ database: nodeSqlite(raw) }) });
    const migrator = new Migrator({ db: old, provider: migrations("sqlite"), migrationTableName: "viauna_migrations", migrationLockTableName: "viauna_migration_lock" });
    expect((await migrator.migrateTo("0005_calendars")).error).toBeUndefined();
    await old.insertInto("accounts").values({ id: 7, login: "a", email: "a", imap: "{}", imap_hash: "h", smtp: "{}", settings: "{}", created_at: 1 }).execute();
    const vcard = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Kai Lim\r\nNICKNAME:KL\r\nBDAY:--05-12\r\nCATEGORIES:Family\r\nEND:VCARD\r\n";
    await old.insertInto("contacts").values({ id: 3, account_id: 7, uid: "u", name: "Kai Lim", sort_key: "kai lim", search: "kai lim", vcard, created_at: 1, updated_at: 1 }).execute();
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    expect(await old.selectFrom("contact_labels").select(["contact_id", "label", "label_key"]).execute()).toEqual([{ contact_id: 3, label: "Family", label_key: "family" }]);
    expect(await old.selectFrom("contact_dates").select(["kind", "year", "month", "day"]).execute()).toEqual([{ kind: "birthday", year: null, month: 5, day: 12 }]);
    expect((await old.selectFrom("contacts").select("search").executeTakeFirstOrThrow()).search).toContain("kl");
    await old.destroy();
  });
});
