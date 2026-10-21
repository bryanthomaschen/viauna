// Keeping each mailbox's contacts in step with the CardDAV server (CARDDAV_URL), signed
// in as the mailbox with its own password. Once sync is on, the server holds the
// contacts and the state store keeps a synced copy, for listing, search and suggestions.
//
// A sync first sends what changed here: deletions, contacts made here (into the first
// address book), then edits, each with If-Match. An edit that crossed one made
// elsewhere is re-applied to the newer card, so neither side's other changes are lost.
// Then it fetches what changed on the server (sync-collection, or ETags). It runs when a
// mailbox's runtime starts, every ten minutes while it runs, soon after a change here,
// and on "Sync now". One sync per mailbox at a time.
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { DavClient, DavError } from "./carddav.ts";
import { config, onOwnServer, setting } from "./config.ts";
import { type SyncFields, writeCard } from "./contacts.ts";
import type { Credentials } from "./crypto.ts";
import type { AccountInfo, AccountRuntime } from "./imap/runtime.ts";
import { log } from "./log.ts";
import { state } from "./state/db.ts";
import { type ContactFields, type VCard, applyFields, cardUid, checkCard, parseVCards, readFields, serializeVCard } from "./vcard.ts";

const PERIOD_MS = 10 * 60_000;
const SOON_MS = 1500;
const REDISCOVER_MS = 24 * 3600_000;

/** Heard by the live-updates stream: an account's contacts changed. */
export const contactEvents = new EventEmitter();
contactEvents.setMaxListeners(1000);

interface Memory {
  running: Promise<void> | null;
  /** The one sync queued behind the running one, and whether it should look for books again. */
  again: Promise<void> | null;
  againRediscover: boolean;
  at: number | null;
  error: string | null;
  discoveredAt: number;
  soon: NodeJS.Timeout | null;
}
const memory = new Map<number, Memory>();
const mem = (id: number): Memory => {
  let m = memory.get(id);
  if (!m) memory.set(id, (m = { running: null, again: null, againRediscover: false, at: null, error: null, discoveredAt: 0, soon: null }));
  return m;
};

/** Whether this account's contacts sync: the server is set, both switches are on, and it's our mail server. */
export function syncsContacts(account: AccountInfo): boolean {
  return !!config.carddavUrl && setting("contacts") && setting("contactsSync") && onOwnServer(account);
}

/** CARDDAV_URL for this account: {login}, {user} (before the @) and {domain} filled in. */
export function startUrl(template: string, login: string): string {
  const at = login.lastIndexOf("@");
  const parts = { login, user: at < 0 ? login : login.slice(0, at), domain: at < 0 ? "" : login.slice(at + 1) };
  return template.replace(/\{(login|user|domain|email)\}/g, (_, k: string) =>
    encodeURIComponent(parts[k === "email" ? "login" : (k as keyof typeof parts)]).replace(/%40/g, "@"),
  );
}

/** A file name for a new card on the server, from its UID. */
function cardName(uid: string): string {
  const safe = uid.replace(/^urn:(uuid|sha256):/, "").replace(/[^A-Za-z0-9._-]/g, "");
  return `${safe.slice(0, 120) || crypto.randomUUID()}.vcf`;
}

export interface SyncStatus {
  /** CARDDAV_URL's host, when this account syncs. */
  server: string | null;
  syncing: boolean;
  /** The end of the last sync that worked. */
  at: number | null;
  error: string | null;
  books: { name: string; count: number }[];
}

export async function syncStatus(account: AccountInfo): Promise<SyncStatus> {
  const m = mem(account.id);
  if (!syncsContacts(account)) return { server: null, syncing: false, at: null, error: null, books: [] };
  const books = await state()
    .selectFrom("contact_books as b")
    .leftJoin("contacts as c", "c.book_id", "b.id")
    .select(["b.name", (eb) => eb.fn.count<number>("c.id").as("count")])
    .where("b.account_id", "=", account.id)
    .groupBy(["b.id", "b.name"])
    .orderBy("b.id")
    .execute();
  return {
    server: new URL(config.carddavUrl!.replace(/\{(login|user|domain|email)\}/g, "x")).host,
    syncing: !!m.running,
    at: m.at,
    error: m.error,
    books: books.map((b) => ({ name: b.name, count: Number(b.count) })),
  };
}

type BookRow = { id: number; url: string; name: string; sync_token: string | null };

/** Brings the account's books in line with the server's; never forgets books on an empty answer. */
async function refreshBooks(client: DavClient, accountId: number, start: string, books: BookRow[]): Promise<BookRow[]> {
  const found = await client.discover(start);
  if (!found.books.length) {
    if (books.length) throw new DavError("The contacts server lists no address books for this mailbox.", 404);
    const url = await client.createBook(found.home, "Contacts");
    found.books.push({ url, name: "Contacts", syncToken: null });
    log.info("made an address book on the contacts server", { account: accountId });
  }
  const urls = new Set(found.books.map((b) => b.url));
  await state().transaction().execute(async (trx) => {
    for (const b of found.books) {
      const hash = crypto.createHash("sha256").update(b.url).digest("hex");
      const row = await trx.selectFrom("contact_books").select("id").where("account_id", "=", accountId).where("url_hash", "=", hash).executeTakeFirst();
      if (row) await trx.updateTable("contact_books").set({ name: b.name.slice(0, 255) }).where("id", "=", row.id).execute();
      else await trx.insertInto("contact_books").values({ account_id: accountId, url: b.url, url_hash: hash, name: b.name.slice(0, 255), created_at: Date.now() }).execute();
    }
    // A book gone from the server takes its contacts with it here.
    for (const gone of books.filter((b) => !urls.has(b.url))) {
      await trx.deleteFrom("contacts").where("account_id", "=", accountId).where("book_id", "=", gone.id).execute();
      await trx.deleteFrom("contact_deletions").where("book_id", "=", gone.id).execute();
      await trx.deleteFrom("contact_books").where("id", "=", gone.id).execute();
    }
  });
  return state().selectFrom("contact_books").select(["id", "url", "name", "sync_token"]).where("account_id", "=", accountId).orderBy("id").execute();
}

const parseOne = (data: string): VCard | null => {
  const [card] = parseVCards(data);
  return card && !checkCard(card) ? card : null;
};

/**
 * A three-way merge of a card changed on both sides: each field changed here (against
 * the card as last synced) takes this side's value, the rest the server's. Without the
 * base, every field shown here wins.
 */
export function merge(theirs: VCard, mine: VCard, base: VCard | null): VCard {
  const m = readFields(mine);
  const t = readFields(theirs);
  const b = base ? readFields(base) : null;
  const pick = <K extends keyof ContactFields>(k: K): ContactFields[K] => (b && JSON.stringify(m[k]) === JSON.stringify(b[k]) ? t[k] : m[k]);
  const fields = Object.fromEntries((Object.keys(m) as (keyof ContactFields)[]).map((k) => [k, pick(k)])) as unknown as ContactFields;
  return applyFields(theirs, fields);
}

/** Sends deletions, new contacts and edits made here. */
async function push(client: DavClient, accountId: number, target: BookRow, books: BookRow[]): Promise<void> {
  const bookById = new Map(books.map((b) => [b.id, b]));
  for (const d of await state().selectFrom("contact_deletions").selectAll().where("account_id", "=", accountId).execute()) {
    try {
      await client.deleteCard(d.href, d.etag);
    } catch (err) {
      // Changed elsewhere since: it was still meant to go.
      if (!(err instanceof DavError) || err.status !== 412) throw err;
      await client.deleteCard(d.href, null);
    }
    await state().deleteFrom("contact_deletions").where("id", "=", d.id).execute();
  }

  const pending = await state()
    .selectFrom("contacts")
    .select(["id", "uid", "vcard", "base", "book_id", "href", "etag"])
    .where("account_id", "=", accountId)
    .where((eb) => eb.or([eb("book_id", "is", null), eb("dirty", "=", 1)]))
    .execute();
  for (const row of pending) {
    const book = row.book_id === null ? target : bookById.get(row.book_id);
    if (!book) continue;
    const href = row.href ?? new URL(cardName(row.uid), book.url).toString();
    const save = (sync: SyncFields) => state().updateTable("contacts").set(sync).where("id", "=", row.id).execute();
    try {
      const { etag } = await client.putCard(href, row.vcard, row.book_id === null ? null : row.etag);
      await save({ book_id: book.id, href, etag, dirty: 0 });
    } catch (err) {
      if (!(err instanceof DavError)) throw err;
      if (err.status === 412) {
        // Changed (or made) on the server meanwhile: put this side's edits on its card.
        const [theirs] = await client.fetchCards(book.url, [href]);
        const card = theirs && parseOne(theirs.data);
        const mine = parseOne(row.vcard);
        if (card && mine) {
          const merged = row.book_id === null ? card : merge(card, mine, row.base ? parseOne(row.base) : null);
          const { etag } = row.book_id === null ? { etag: theirs.etag } : await client.putCard(href, serializeVCard(merged), theirs.etag);
          await state().transaction().execute((trx) => writeCard(trx, accountId, merged, row.id, { book_id: book.id, href, etag, dirty: 0 }));
        } else {
          // Deleted there meanwhile, an edit here brings it back; unreadable there, it's replaced.
          const { etag } = await client.putCard(href, row.vcard, theirs ? theirs.etag : null);
          await save({ book_id: book.id, href, etag, dirty: 0 });
        }
      } else if (err.status === 403 || err.status === 405) {
        // A book this mailbox can't write to: the server's copy stands.
        log.warn("contacts server refused a change (read-only?)", { account: accountId, status: err.status });
        await save({ dirty: 0, etag: null });
      } else {
        throw err;
      }
    }
  }
}

/** Fetches what changed in each book, and drops what the server no longer has. */
async function pull(client: DavClient, accountId: number, books: BookRow[]): Promise<boolean> {
  let changedAny = false;
  for (const book of books) {
    const ch = await client.changes(book.url, book.sync_token);
    const local = new Map(
      (await state().selectFrom("contacts").select(["id", "href", "etag", "dirty", "uid"]).where("account_id", "=", accountId).where("book_id", "=", book.id).execute()).map((r) => [r.href!, r]),
    );
    const wanted = ch.changed.filter((c) => {
      const l = local.get(c.href);
      return !l || (!l.dirty && (c.etag === null || l.etag !== c.etag));
    });
    const cards = wanted.length ? await client.fetchCards(book.url, wanted.map((c) => c.href)) : [];
    const present = new Set(ch.changed.map((c) => c.href));
    await state().transaction().execute(async (trx) => {
      for (const { href, etag, data } of cards) {
        const card = parseOne(data);
        if (!card) continue;
        const sync: SyncFields = { book_id: book.id, href, etag, dirty: 0 };
        const existing = local.get(href);
        if (existing) {
          await writeCard(trx, accountId, card, existing.id, sync);
        } else {
          // A card the server has that's here only locally (same UID): it's the same one.
          let uid = cardUid(card) ?? `urn:sha256:${crypto.createHash("sha256").update(data).digest("hex")}`;
          const same = await trx.selectFrom("contacts").select(["id", "book_id"]).where("account_id", "=", accountId).where("uid", "=", uid).executeTakeFirst();
          if (same && same.book_id === null) {
            await writeCard(trx, accountId, card, same.id, sync);
            continue;
          }
          // The same card in two books: keep both.
          if (same) uid = `${uid}#${book.id}`;
          const withUid: VCard = cardUid(card) === uid ? card : { ...card, props: [...card.props.filter((p) => p.name !== "UID"), { group: null, name: "UID", params: [], value: uid }] };
          const again = await trx.selectFrom("contacts").select("id").where("account_id", "=", accountId).where("uid", "=", uid).executeTakeFirst();
          await writeCard(trx, accountId, withUid, again?.id ?? null, sync);
        }
        changedAny = true;
      }
      const gone = [
        ...ch.removed,
        // A full listing names every member: the rest are gone.
        ...(ch.full ? [...local.keys()].filter((href) => !present.has(href)) : []),
      ];
      for (const href of gone) {
        const l = local.get(href);
        if (!l || l.dirty) continue;
        await trx.deleteFrom("contacts").where("id", "=", l.id).execute();
        changedAny = true;
      }
      await trx.updateTable("contact_books").set({ sync_token: ch.token, synced_at: Date.now() }).where("id", "=", book.id).execute();
    });
  }
  return changedAny;
}

/** One full sync of this account against `start` (CARDDAV_URL, filled in). */
export async function syncAccount(account: AccountInfo, creds: Credentials, start: string, opts: { rediscover?: boolean } = {}): Promise<void> {
  const client = new DavClient({ username: creds.user, password: creds.pass });
  const m = mem(account.id);
  let books = await state().selectFrom("contact_books").select(["id", "url", "name", "sync_token"]).where("account_id", "=", account.id).orderBy("id").execute();
  if (!books.length || opts.rediscover || Date.now() - m.discoveredAt > REDISCOVER_MS) {
    books = await refreshBooks(client, account.id, start, books);
    m.discoveredAt = Date.now();
  }
  const before = await state().selectFrom("contacts").select((eb) => eb.fn.countAll().as("n")).where("account_id", "=", account.id).where((eb) => eb.or([eb("book_id", "is", null), eb("dirty", "=", 1)])).executeTakeFirst();
  await push(client, account.id, books[0], books);
  const pulled = await pull(client, account.id, books);
  if (pulled || Number(before?.n ?? 0) > 0) contactEvents.emit("changed", account.id);
}

/**
 * Syncs now; resolves once a sync that started after this call has finished. One already
 * running may have read the contacts before the change this call is for, so it's
 * followed by one more, shared by everyone who asks in the meantime. With `join`, for
 * syncs that only keep things fresh (the periodic one, opening Contacts), the one
 * running will do.
 */
export function syncContacts(account: AccountInfo, creds: Credentials, opts: { rediscover?: boolean; join?: boolean } = {}): Promise<void> {
  const m = mem(account.id);
  if (!syncsContacts(account)) return Promise.resolve();
  if (!m.running) return startSync(account, creds, opts);
  if (opts.join) return m.running;
  m.againRediscover ||= !!opts.rediscover;
  m.again ??= m.running.then(() => {
    const rediscover = m.againRediscover;
    m.again = null;
    m.againRediscover = false;
    return startSync(account, creds, { rediscover });
  });
  return m.again;
}

/** One sync, recording how it went. */
function startSync(account: AccountInfo, creds: Credentials, opts: { rediscover?: boolean }): Promise<void> {
  const m = mem(account.id);
  if (!syncsContacts(account)) return Promise.resolve();
  // This sync sends the changes a pending syncSoon was waiting to: it reads the contacts
  // after them. Left set, it would sync again for nothing, as soon as this one ended.
  if (m.soon) {
    clearTimeout(m.soon);
    m.soon = null;
  }
  contactEvents.emit("changed", account.id);
  m.running = syncAccount(account, creds, startUrl(config.carddavUrl!, account.login), opts)
    .then(
      () => {
        m.at = Date.now();
        m.error = null;
      },
      (err: Error) => {
        m.error = err.message;
        // A book that vanished (404) or a server that moved: find them again next time.
        m.discoveredAt = 0;
        log.warn("contacts sync failed", { account: account.id, error: err.message, status: (err as DavError).status });
      },
    )
    .finally(() => {
      m.running = null;
      contactEvents.emit("changed", account.id);
    });
  return m.running;
}

/** A sync shortly after a change here, so a burst of edits sends once. */
export function syncSoon(account: AccountInfo, creds: Credentials) {
  if (!syncsContacts(account)) return;
  const m = mem(account.id);
  if (m.soon) clearTimeout(m.soon);
  m.soon = setTimeout(() => {
    m.soon = null;
    void syncContacts(account, creds);
  }, SOON_MS);
  m.soon.unref();
}

/** Keeps a running account's contacts in sync while its runtime lives. */
export function attachContactsSync(rt: AccountRuntime) {
  const run = () => void syncContacts(rt.account, rt.credentials, { join: true });
  const first = setTimeout(run, 2000);
  const every = setInterval(run, PERIOD_MS);
  first.unref();
  every.unref();
  rt.once("stopped", () => {
    clearTimeout(first);
    clearInterval(every);
  });
}
