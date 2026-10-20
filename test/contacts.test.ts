// The address book (server/contacts.ts) on each state-store engine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ContactError,
  createContact,
  deleteContacts,
  exportVCards,
  getContact,
  importVCards,
  listContacts,
  suggest,
  updateContact,
} from "../server/contacts.ts";
import { sha256 } from "../server/crypto.ts";
import { Database, db, setDatabase } from "../server/db.ts";
import { ensureIndexAccount } from "../server/imap/store.ts";
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
  firstName: "Bob", lastName: "Tan", emails: [{ address: "bob@work.example", label: "work" }], phones: [],
  organization: "", title: "", birthday: "", notes: "", ...over,
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
      { address: "bob@work.example", name: "Bob Tan" },
      { address: "bob.personal@example.com", name: "Bobby" },
    ]);
    // With contacts turned off, only the index suggests.
    expect((await suggest(7, "bob", false)).map((x) => x.name)).toEqual(["Bobby", "B. Tan"]);
  });
});
