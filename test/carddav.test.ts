// Contacts sync with a real CardDAV server (Radicale, from dev/databases.yml), when
// VIAUNA_TEST_CARDDAV names it: the client (server/carddav.ts), then the sync itself
// (server/contacts-sync.ts) on each state-store engine. Radicale accepts any login, and
// each test uses a fresh one, so they never see each other's address books.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DavClient, DavError } from "../server/carddav.ts";
import { createContact, deleteContacts, importVCards, listContacts, updateContact } from "../server/contacts.ts";
import { merge, startUrl, syncAccount } from "../server/contacts-sync.ts";
import { sha256 } from "../server/crypto.ts";
import { Database, setDatabase } from "../server/db.ts";
import type { AccountInfo } from "../server/imap/runtime.ts";
import { type StateStore, openState, setState, state } from "../server/state/db.ts";
import { applyFields, parseVCards, readFields, serializeVCard } from "../server/vcard.ts";
import { ENGINES, emptyDatabase } from "./databases.ts";

const SERVER = process.env.VIAUNA_TEST_CARDDAV;
const freshLogin = () => `t-${crypto.randomBytes(4).toString("hex")}@example.test`;
const card = (uid: string, fn: string, extra = "") => `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:${fn}\r\nN:;${fn};;;\r\n${extra}END:VCARD\r\n`;

describe("merging a card changed on both sides", () => {
  const base = parseVCards(card("m", "Ann", "EMAIL:ann@example.com\r\nTITLE:Analyst\r\nNOTE:old\r\n"))[0];
  const edit = (c: typeof base, over: Partial<ReturnType<typeof readFields>>) => applyFields(c, { ...readFields(c), ...over });

  it("takes each side's own changes", () => {
    const theirs = edit(base, { title: "Engineer", notes: "from the phone" });
    const mine = edit(base, { lastName: "Lee", emails: [{ address: "ann@new.example", label: "work" }] });
    expect(readFields(merge(theirs, mine, base))).toMatchObject({
      firstName: "Ann", lastName: "Lee", title: "Engineer", notes: "from the phone", emails: [{ address: "ann@new.example", label: "work" }],
    });
  });

  it("lets this side win a field both changed, and every field without a base", () => {
    const theirs = edit(base, { title: "Engineer" });
    const mine = edit(base, { title: "Manager" });
    expect(readFields(merge(theirs, mine, base)).title).toBe("Manager");
    expect(readFields(merge(edit(base, { notes: "theirs" }), mine, null))).toMatchObject({ title: "Manager", notes: "old" });
  });
});

describe.skipIf(!SERVER)("the CardDAV client", () => {
  const login = freshLogin();
  const client = new DavClient({ username: login, password: "any" });

  it("finds the home, makes an address book, and finds it", async () => {
    const first = await client.discover(`${SERVER}/`);
    expect(first.home).toBe(`${SERVER}/${encodeURIComponent(login)}/`);
    expect(first.books).toEqual([]);
    const url = await client.createBook(first.home, "Contacts");
    const again = await client.discover(`${SERVER}/`);
    expect(again.books).toEqual([{ url, name: "Contacts", syncToken: expect.any(String) }]);
    // The address of a book works as the starting point too.
    expect((await client.discover(url)).books.map((b) => b.url)).toEqual([url]);
  });

  it("writes only what hasn't changed since it was read, and lists changes since a token", async () => {
    const { books } = await client.discover(`${SERVER}/`);
    const book = books[0].url;
    const a = new URL("a.vcf", book).toString();
    const { etag } = await client.putCard(a, card("a", "Ann"), null);
    expect(etag).toBeTruthy();
    await expect(client.putCard(a, card("a", "Ann again"), null)).rejects.toMatchObject({ status: 412 });
    await expect(client.putCard(a, card("a", "Ann again"), '"stale"')).rejects.toBeInstanceOf(DavError);

    const all = await client.changes(book, null);
    expect(all.full).toBe(true);
    expect(all.changed).toEqual([{ href: a, etag }]);
    const b = new URL("b.vcf", book).toString();
    const { etag: etagB } = await client.putCard(b, card("b", "Bob"), null);
    await client.putCard(a, card("a", "Ann Lee"), etag);
    await client.deleteCard(b, etagB);
    const since = await client.changes(book, all.token);
    expect(since.full).toBe(false);
    expect(since.changed.map((c) => c.href)).toEqual([a]);
    expect(since.removed).toEqual([b]);
    const [fetched] = await client.fetchCards(book, [a]);
    expect(parseVCards(fetched.data)[0].props.find((p) => p.name === "FN")?.value).toBe("Ann Lee");
  });

  it("says when the server isn't reachable", async () => {
    const nowhere = new DavClient({ username: "x", password: "y" }, 2000);
    await expect(nowhere.discover("http://127.0.0.1:1/")).rejects.toMatchObject({ status: 0 });
  });
});

describe.skipIf(!SERVER).each(ENGINES)("contacts sync on $name", ({ url }) => {
  let store: StateStore;
  let dir: string;
  let account: AccountInfo;
  let other: DavClient;
  const creds = () => ({ user: account.login, pass: "any" });
  const sync = () => syncAccount(account, creds(), startUrl(`${SERVER}/{login}/`, account.login));
  const names = async () => (await listContacts(account.id, "")).contacts.map((c) => c.name);
  const book = async () => (await other.discover(`${SERVER}/`)).books[0].url;
  const onServer = async () => {
    const b = await book();
    const { changed } = await other.changes(b, null);
    const cards = await other.fetchCards(b, changed.map((c) => c.href));
    return cards.map((c) => parseVCards(c.data)[0]).map((c) => c.props.find((p) => p.name === "FN")!.value).sort();
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "viauna-carddav-"));
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
    const login = freshLogin();
    const imap = JSON.stringify({ host: "imap.internal.test", port: 993, security: "tls", servername: null, verify: true });
    await state().deleteFrom("accounts").execute();
    await state().insertInto("accounts").values({ id: 7, login, email: login, imap, imap_hash: sha256(imap), smtp: "{}", settings: "{}", created_at: 1 }).execute();
    account = { id: 7, login, email: login, imap: JSON.parse(imap), smtp: JSON.parse("{}") } as AccountInfo;
    other = new DavClient({ username: login, password: "any" });
  });

  afterEach(() => setState(null));

  it("sends the contacts made here to a new address book on the first sync", async () => {
    await createContact(7, { firstName: "Ann", lastName: "Lee", emails: [{ address: "ann@example.com" }] });
    await createContact(7, { firstName: "Bob", emails: [{ address: "bob@example.com" }] });
    await sync();
    expect(await onServer()).toEqual(["Ann Lee", "Bob"]);
    const rows = await state().selectFrom("contacts").select(["book_id", "href", "etag", "dirty"]).execute();
    expect(rows.every((r) => r.book_id && r.href && r.etag && r.dirty === 0)).toBe(true);
    await sync();
    expect(await names()).toEqual(["Ann Lee", "Bob"]);
  });

  it("brings in what another app added, changed and deleted", async () => {
    await createContact(7, { firstName: "Ann", emails: [{ address: "ann@example.com" }] });
    await createContact(7, { firstName: "Bob", emails: [{ address: "bob@example.com" }] });
    await sync();
    const b = await book();
    const { changed } = await other.changes(b, null);
    const cards = await other.fetchCards(b, changed.map((c) => c.href));
    const ann = cards.find((c) => c.data.includes("FN:Ann"))!;
    const bob = cards.find((c) => c.data.includes("FN:Bob"))!;
    const annCard = parseVCards(ann.data)[0];
    await other.putCard(ann.href, serializeVCard(applyFields(annCard, { ...readFields(annCard), notes: "From the phone" })), ann.etag);
    await other.deleteCard(bob.href, bob.etag);
    await other.putCard(new URL("cara.vcf", b).toString(), card("cara-1", "Cara", "EMAIL:cara@example.com\r\nPHOTO:https://example.com/c.jpg\r\n"), null);

    await sync();
    expect(await names()).toEqual(["Ann", "Cara"]);
    const annHere = (await listContacts(7, "ann")).contacts[0];
    const { contact } = { contact: await (await import("../server/contacts.ts")).getContact(7, annHere.id) };
    expect(contact?.fields.notes).toBe("From the phone");
  });

  it("keeps both sides' changes when an edit here crosses one made elsewhere", async () => {
    const created = await createContact(7, { firstName: "Ann", emails: [{ address: "ann@example.com" }] });
    await sync();
    // Elsewhere: a job title. Here, at the same time: a new last name.
    const b = await book();
    const { changed } = await other.changes(b, null);
    const [theirs] = await other.fetchCards(b, [changed[0].href]);
    const theirCard = parseVCards(theirs.data)[0];
    await other.putCard(theirs.href, serializeVCard(applyFields(theirCard, { ...readFields(theirCard), title: "Engineer" })), theirs.etag);
    await updateContact(7, created!.id, { firstName: "Ann", lastName: "Lee", emails: [{ address: "ann@example.com" }] });

    await sync();
    const [merged] = await other.fetchCards(b, [changed[0].href]);
    expect(readFields(parseVCards(merged.data)[0])).toMatchObject({ firstName: "Ann", lastName: "Lee", title: "Engineer" });
    const row = await state().selectFrom("contacts").select(["dirty", "etag"]).executeTakeFirstOrThrow();
    expect(row).toEqual({ dirty: 0, etag: merged.etag });
  });

  it("deletes on the server what's deleted here, and sends imports", async () => {
    const created = await createContact(7, { firstName: "Gone", emails: [{ address: "gone@example.com" }] });
    await sync();
    await deleteContacts(7, [created!.id]);
    await importVCards(7, card("imp-1", "Imported"));
    await sync();
    expect(await onServer()).toEqual(["Imported"]);
    expect(await state().selectFrom("contact_deletions").selectAll().execute()).toEqual([]);
  });

  it("matches a card already on the server to the same contact here, by UID", async () => {
    await importVCards(7, card("shared-1", "Dee"));
    const b = await other.createBook((await other.discover(`${SERVER}/`)).home, "Contacts");
    await other.putCard(new URL("shared-1.vcf", b).toString(), card("shared-1", "Dee Ng"), null);
    await sync();
    expect(await names()).toEqual(["Dee Ng"]);
    expect(await onServer()).toEqual(["Dee Ng"]);
  });
});
