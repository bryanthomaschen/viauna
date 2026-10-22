// The address book: each mailbox's contacts, kept in the state store as whole vCards
// (vcard.ts), with what's needed to list, search and suggest them alongside. Contacts
// are what a person chose to keep, unlike the index's "people you write to", which is
// rebuilt from mail; suggestions while writing draw on both, saved contacts first.
import crypto from "node:crypto";
import { type Transaction, sql } from "kysely";
import { VERSION } from "./config.ts";
import { searchContacts as searchCorrespondents } from "./mail/labels.ts";
import { type StateSchema, state } from "./state/db.ts";
import { contains, fold } from "./text.ts";
import {
  type ContactFields,
  type VCard,
  applyFields,
  cardDateText,
  cardIndex,
  cardUid,
  checkCard,
  cleanDateLabel,
  displayName,
  newCard,
  parseCardDate,
  parseVCards,
  readFields,
  serializeVCard,
  uniqueLabels,
} from "./vcard.ts";

export class ContactError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface ContactSummary {
  id: number;
  name: string;
  emails: string[];
  phone: string | null;
  organization: string;
  labels: string[];
}

const PRODID = `-//Viauna//Viauna ${VERSION}//EN`;
const ADDRESS = /^[^\s@]+@[^\s@]+$/;
const MAX_IMPORT = 10_000;

/** Fixed limits (docs/how-it-works/limits.md). */
export const LIMITS = {
  labels: 30,
  label: 60,
  dates: 20,
  nickname: 200,
};

/** A date the page sent: "1990-05-12" or "--05-12", or the wording another app gave it, unchanged. */
function cleanDate(input: unknown, kept: string[], what: string): string {
  const s = typeof input === "string" ? input.trim() : "";
  if (!s || kept.includes(s)) return s;
  const d = /^(\d{4}-\d{2}-\d{2}|--\d{2}-\d{2})$/.test(s) ? parseCardDate(s) : null;
  if (!d || (d.year !== null && d.year < 1000)) throw new ContactError(`Give ${what} as a day and a month, with the year if you know it.`);
  return cardDateText(d);
}

/** A label as it's kept: trimmed, on one line, not too long. */
export function cleanLabel(input: unknown): string {
  const label = typeof input === "string" ? input.replace(/\s+/g, " ").trim() : "";
  if (!label) throw new ContactError("Give the label a name.");
  if (label.length > LIMITS.label || /[\x00-\x1f]/.test(label)) throw new ContactError(`A label can be at most ${LIMITS.label} characters.`);
  return label;
}

/**
 * Checks what the page sent, and puts it in shape. `current` is the contact as it is:
 * a date in another app's own wording, which Viauna can't edit, may come back unchanged.
 */
export function cleanFields(input: unknown, current?: ContactFields): ContactFields {
  const o = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number, what: string) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (s.length > max) throw new ContactError(`${what} is too long.`);
    return s;
  };
  const label = (v: unknown) => str(v, 40, "A label").toLowerCase();
  const list = <T>(v: unknown, what: string, map: (x: Record<string, unknown>) => T | null): T[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > 50) throw new ContactError(`Too many ${what}.`);
    return v.map((x) => map((x ?? {}) as Record<string, unknown>)).filter((x): x is T => x !== null);
  };
  const kept = current ? [current.birthday, ...current.dates.map((d) => d.date)].filter(Boolean) : [];
  const fields: ContactFields = {
    firstName: str(o.firstName, 200, "The first name"),
    lastName: str(o.lastName, 200, "The last name"),
    nickname: str(o.nickname, LIMITS.nickname, "The nickname"),
    organization: str(o.organization, 200, "The company"),
    title: str(o.title, 200, "The job title"),
    birthday: cleanDate(o.birthday, kept, "the birthday"),
    dates: list(o.dates, "dates", (d) => {
      const date = cleanDate(d.date, kept, "each date");
      return date ? { date, label: cleanDateLabel(str(d.label, LIMITS.label, "A date's label")) } : null;
    }),
    labels: (() => {
      if (o.labels === undefined || o.labels === null) return [];
      if (!Array.isArray(o.labels) || o.labels.length > LIMITS.labels) throw new ContactError(`A contact can have at most ${LIMITS.labels} labels.`);
      return uniqueLabels(o.labels.map(cleanLabel));
    })(),
    notes: str(o.notes, 10_000, "The notes"),
    emails: list(o.emails, "email addresses", (e) => {
      const address = str(e.address, 320, "An email address");
      if (!address) return null;
      if (!ADDRESS.test(address)) throw new ContactError(`"${address}" isn't an email address.`);
      return { address, label: label(e.label) };
    }),
    phones: list(o.phones, "phone numbers", (p) => {
      const number = str(p.number, 60, "A phone number");
      return number ? { number, label: label(p.label) } : null;
    }),
  };
  if (!fields.firstName && !fields.lastName && !fields.organization && !fields.emails.length && !fields.phones.length) {
    throw new ContactError("Give the contact a name, a company, an email address or a phone number.");
  }
  if (fields.dates.length > LIMITS.dates) throw new ContactError(`A contact can have at most ${LIMITS.dates} dates besides the birthday.`);
  return fields;
}

/** Where a contact sits on the CardDAV server, set by sync (contacts-sync.ts). */
export interface SyncFields {
  book_id?: number | null;
  href?: string | null;
  etag?: string | null;
  dirty?: number;
  base?: string | null;
}

/**
 * Inserts or replaces a contact's row and addresses, inside a transaction. A change made
 * here to a contact on the CardDAV server is marked dirty, for sync to send; sync itself
 * passes `sync` to record what the server has.
 */
export async function writeCard(trx: Transaction<StateSchema>, accountId: number, card: VCard, id: number | null, sync?: SyncFields): Promise<number> {
  const problem = checkCard(card);
  if (problem) throw new ContactError(problem);
  const { name, sortKey, search, emails, labels, dates } = cardIndex(card);
  const now = Date.now();
  const vcard = serializeVCard(card);
  let contactId = id;
  if (contactId === null) {
    const uid = cardUid(card)!;
    await trx
      .insertInto("contacts")
      .values({ account_id: accountId, uid, name, sort_key: sortKey, search, vcard, created_at: now, updated_at: now, ...sync })
      .execute();
    // Read back by the UID, which is unique per mailbox (MySQL has no RETURNING).
    const row = await trx.selectFrom("contacts").select("id").where("account_id", "=", accountId).where("uid", "=", uid).executeTakeFirstOrThrow();
    contactId = row.id;
  } else {
    // Edited here: if it's on the server, it now needs sending, and the card as last
    // synced is kept for merging. (base and dirty come first: MySQL assigns in order,
    // and they must see the row as it was.)
    const changes = sync
      ? { base: null, ...sync }
      : {
          base: sql<string | null>`case when dirty = 0 and book_id is not null then vcard else base end`,
          dirty: sql<number>`case when book_id is null then 0 else 1 end`,
        };
    await trx
      .updateTable("contacts")
      .set({ ...changes, name, sort_key: sortKey, search, vcard, updated_at: now })
      .where("id", "=", contactId)
      .where("account_id", "=", accountId)
      .execute();
    await trx.deleteFrom("contact_emails").where("contact_id", "=", contactId).execute();
    await trx.deleteFrom("contact_labels").where("contact_id", "=", contactId).execute();
    await trx.deleteFrom("contact_dates").where("contact_id", "=", contactId).execute();
  }
  if (emails.length) {
    await trx
      .insertInto("contact_emails")
      .values(emails.map((address, position) => ({ contact_id: contactId, account_id: accountId, position, address })))
      .execute();
  }
  if (labels.length) {
    await trx
      .insertInto("contact_labels")
      .values(labels.map((l, position) => ({ contact_id: contactId, account_id: accountId, position, label: l.label, label_key: l.key })))
      .execute();
  }
  if (dates.length) {
    await trx
      .insertInto("contact_dates")
      .values(dates.map((d, position) => ({ contact_id: contactId, account_id: accountId, position, ...d })))
      .execute();
  }
  return contactId;
}

async function load(accountId: number, id: number): Promise<{ id: number; card: VCard } | null> {
  const row = await state().selectFrom("contacts").select(["id", "vcard"]).where("account_id", "=", accountId).where("id", "=", id).executeTakeFirst();
  const card = row ? parseVCards(row.vcard)[0] : undefined;
  return row && card ? { id: row.id, card } : null;
}

function summary(row: { id: number; name: string; vcard: string }): ContactSummary {
  const card = parseVCards(row.vcard)[0];
  const f = card ? readFields(card) : null;
  return {
    id: row.id, name: row.name, emails: f?.emails.map((e) => e.address) ?? [], phone: f?.phones[0]?.number ?? null,
    organization: f?.organization ?? "", labels: f?.labels ?? [],
  };
}

/** The contacts, by name: those matching `q`, with `label` if one is given. */
export async function listContacts(accountId: number, q: string, offset = 0, limit = 200, label = ""): Promise<{ contacts: ContactSummary[]; total: number }> {
  const term = fold(q.trim());
  let base = state().selectFrom("contacts").where("account_id", "=", accountId);
  if (term) base = base.where(sql<boolean>`search like ${contains(term)} escape '!'`);
  if (label.trim()) {
    const key = fold(label.trim());
    base = base.where(({ exists, selectFrom }) =>
      exists(selectFrom("contact_labels as l").select("l.contact_id").whereRef("l.contact_id", "=", "contacts.id").where("l.label_key", "=", key)),
    );
  }
  const [rows, count] = await Promise.all([
    base.select(["id", "name", "vcard"]).orderBy("sort_key").orderBy("id").offset(offset).limit(limit).execute(),
    base.select((eb) => eb.fn.countAll().as("n")).executeTakeFirst(),
  ]);
  return { contacts: rows.map(summary), total: Number(count?.n ?? 0) };
}

export async function getContact(accountId: number, id: number) {
  const found = await load(accountId, id);
  if (!found) return null;
  return { id, name: displayName(found.card), fields: readFields(found.card) };
}

export async function createContact(accountId: number, input: unknown) {
  const card = newCard(cleanFields(input), `urn:uuid:${crypto.randomUUID()}`, PRODID);
  const id = await state().transaction().execute((trx) => writeCard(trx, accountId, card, null));
  return getContact(accountId, id);
}

export async function updateContact(accountId: number, id: number, input: unknown) {
  const found = await load(accountId, id);
  if (!found) throw new ContactError("This contact no longer exists.", 404);
  const fields = cleanFields(input, readFields(found.card));
  await state().transaction().execute((trx) => writeCard(trx, accountId, applyFields(found.card, fields), id));
  return getContact(accountId, id);
}

/** Deletes contacts here, and queues their deletion on the CardDAV server for sync. */
export async function deleteContacts(accountId: number, ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  return state().transaction().execute(async (trx) => {
    const synced = await trx
      .selectFrom("contacts")
      .select(["book_id", "href", "etag"])
      .where("account_id", "=", accountId)
      .where("id", "in", ids)
      .where("book_id", "is not", null)
      .where("href", "is not", null)
      .execute();
    if (synced.length) {
      await trx
        .insertInto("contact_deletions")
        .values(synced.map((r) => ({ account_id: accountId, book_id: r.book_id!, href: r.href!, etag: r.etag })))
        .execute();
    }
    const result = await trx.deleteFrom("contacts").where("account_id", "=", accountId).where("id", "in", ids).executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  });
}

/** The contact with this address, if there is one. */
export async function contactWithAddress(accountId: number, address: string): Promise<number | null> {
  const row = await state()
    .selectFrom("contact_emails")
    .select("contact_id")
    .where("account_id", "=", accountId)
    .where("address", "=", address.trim().toLowerCase())
    .orderBy("contact_id")
    .executeTakeFirst();
  return row?.contact_id ?? null;
}

export interface ImportResult {
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

/**
 * Adds the cards in a .vcf file. A card whose UID is already here replaces that
 * contact; one without a UID gets one from its content, so importing the same file
 * twice changes nothing.
 */
export async function importVCards(accountId: number, text: string): Promise<ImportResult> {
  const cards = parseVCards(text);
  if (!cards.length) throw new ContactError("That file has no contacts in it. Choose a .vcf file.");
  if (cards.length > MAX_IMPORT) throw new ContactError(`Import at most ${MAX_IMPORT.toLocaleString("en")} contacts at a time.`);
  const result: ImportResult = { added: 0, updated: 0, unchanged: 0, skipped: 0 };
  await state().transaction().execute(async (trx) => {
    for (const card of cards) {
      if (checkCard(card)) {
        result.skipped++;
        continue;
      }
      let uid = cardUid(card);
      if (!uid || uid.length > 255) {
        uid = `urn:sha256:${crypto.createHash("sha256").update(serializeVCard(card)).digest("hex")}`;
        card.props = [...card.props.filter((p) => p.name !== "UID"), { group: null, name: "UID", params: [], value: uid }];
      }
      const existing = await trx.selectFrom("contacts").select(["id", "vcard"]).where("account_id", "=", accountId).where("uid", "=", uid).executeTakeFirst();
      if (existing && existing.vcard === serializeVCard(card)) {
        result.unchanged++;
        continue;
      }
      await writeCard(trx, accountId, card, existing?.id ?? null);
      if (existing) result.updated++;
      else result.added++;
    }
  });
  return result;
}

/** Every contact (or the ones asked for) as one .vcf file. */
export async function exportVCards(accountId: number, ids?: number[]): Promise<string> {
  let q = state().selectFrom("contacts").select("vcard").where("account_id", "=", accountId);
  if (ids?.length) q = q.where("id", "in", ids);
  const rows = await q.orderBy("sort_key").execute();
  return rows.map((r) => r.vcard).join("");
}

/**
 * Suggestions while writing: saved contacts that match first, then the people this
 * mailbox writes to and hears from (the index), without repeats. A contact's labels
 * come along to show beside it, and are never sent.
 */
export async function suggest(accountId: number, q: string, withContacts: boolean, limit = 8): Promise<{ address: string; name: string | null; labels: string[] }[]> {
  const term = fold(q.trim());
  if (!term) return [];
  const saved = withContacts
    ? await state()
        .selectFrom("contact_emails as e")
        .innerJoin("contacts as c", "c.id", "e.contact_id")
        .select(["e.address", "c.name", "c.id"])
        .where("e.account_id", "=", accountId)
        .where(sql<boolean>`(e.address like ${contains(term)} escape '!' or c.search like ${contains(term)} escape '!')`)
        .orderBy(sql`case when e.address like ${`${term.replace(/[!%_]/g, (c) => `!${c}`)}%`} escape '!' then 0 else 1 end`)
        .orderBy("c.sort_key")
        .orderBy("e.position")
        .limit(limit)
        .execute()
    : [];
  const labels = new Map<number, string[]>();
  if (saved.length) {
    const rows = await state()
      .selectFrom("contact_labels")
      .select(["contact_id", "label"])
      .where("contact_id", "in", [...new Set(saved.map((s) => s.id))])
      .orderBy("contact_id")
      .orderBy("position")
      .execute();
    for (const r of rows) labels.set(r.contact_id, [...(labels.get(r.contact_id) ?? []), r.label]);
  }
  const seen = new Set(saved.map((s) => s.address));
  const others = searchCorrespondents(accountId, q, limit).filter((c) => !seen.has(c.address));
  return [
    ...saved.map((s) => ({ address: s.address, name: s.name || null, labels: labels.get(s.id) ?? [] })),
    ...others.map((c) => ({ ...c, labels: [] })),
  ].slice(0, limit);
}

// ---------------------------------------------------------------- labels

/**
 * The mailbox's labels, each with how many contacts have it, by name. A label spelled
 * more than one way ("Church", "church") is one, shown as most of its contacts spell it.
 */
export async function contactLabels(accountId: number): Promise<{ label: string; count: number }[]> {
  const rows = await state()
    .selectFrom("contact_labels")
    .select((eb) => ["label_key", "label", eb.fn.countAll().as("n")])
    .where("account_id", "=", accountId)
    .groupBy(["label_key", "label"])
    .execute();
  const byKey = new Map<string, { label: string; count: number; most: number }>();
  for (const r of rows) {
    const n = Number(r.n);
    const seen = byKey.get(r.label_key);
    if (!seen) byKey.set(r.label_key, { label: r.label, count: n, most: n });
    else {
      seen.count += n;
      if (n > seen.most || (n === seen.most && r.label < seen.label)) Object.assign(seen, { label: r.label, most: n });
    }
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => ({ label: v.label, count: v.count }));
}

/** Changes the labels of every contact that has `label`, as `change` says; returns how many changed. */
async function relabel(accountId: number, label: string, change: (labels: string[], key: string) => string[]): Promise<number> {
  const key = fold(label.trim());
  if (!key) throw new ContactError("Say which label.");
  return state().transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom("contacts as c")
      .select(["c.id", "c.vcard"])
      .where("c.account_id", "=", accountId)
      .where(({ exists, selectFrom }) =>
        exists(selectFrom("contact_labels as l").select("l.contact_id").whereRef("l.contact_id", "=", "c.id").where("l.label_key", "=", key)),
      )
      .execute();
    for (const row of rows) {
      const card = parseVCards(row.vcard)[0];
      if (!card) continue;
      const fields = readFields(card);
      await writeCard(trx, accountId, applyFields(card, { ...fields, labels: uniqueLabels(change(fields.labels, key)) }), row.id);
    }
    return rows.length;
  });
}

/** Renames a label on every contact that has it (into another label, if that's its new name). */
export function renameLabel(accountId: number, label: string, to: unknown): Promise<number> {
  const name = cleanLabel(to);
  return relabel(accountId, label, (labels, key) => labels.map((l) => (fold(l) === key ? name : l)));
}

/** Takes a label off every contact; the contacts stay. */
export function removeLabel(accountId: number, label: string): Promise<number> {
  return relabel(accountId, label, (labels, key) => labels.filter((l) => fold(l) !== key));
}

// ---------------------------------------------------------------- tidying names

/** "Bryan - church", "Bryan (church)": a name with what the person is to you after it. */
const CONTEXT = [/^(.*?\S)\s+[-–—]\s+(\S.*)$/, /^(.*\S)\s*\(([^()]*\S[^()]*)\)$/];
/** What follows a name in brackets without being context. */
const SUFFIX = /^(jr|sr|ii|iii|iv|phd|md|esq|mba)\.?$/i;

function splitContext(name: string): { base: string; context: string } | null {
  for (const re of CONTEXT) {
    const m = re.exec(name.trim());
    if (m && !SUFFIX.test(m[2].trim())) return { base: m[1], context: m[2].trim() };
  }
  return null;
}

export interface TidyProposal {
  id: number;
  /** The name as it is. */
  name: string;
  /** The names it would have. */
  firstName: string;
  lastName: string;
  /** The label the context would become. */
  label: string;
}

/**
 * The names and label a contact would have with the context after its name moved into a
 * label, or null if its name has none. When the context is inside the first name and a
 * last name follows ("Bob - church Tan"), which part is the context isn't clear: left alone.
 */
export function tidyCard(card: VCard): Omit<TidyProposal, "id" | "name"> | null {
  const split = splitContext(displayName(card));
  if (!split) return null;
  let { firstName, lastName } = readFields(card);
  const full = [firstName, lastName].filter(Boolean).join(" ");
  const own = splitContext(full);
  if (own && own.context === split.context) {
    const cut = own.base.length;
    if (!lastName) firstName = own.base.trim();
    else if (!firstName) lastName = own.base.trim();
    else if (cut >= firstName.length) lastName = full.slice(firstName.length + 1, Math.max(cut, firstName.length + 1)).trim();
    else return null;
  }
  // "church" becomes "Church"; a label already in use keeps its spelling (contactsToTidy).
  const label = split.context === split.context.toLowerCase() ? split.context[0].toUpperCase() + split.context.slice(1) : split.context;
  if (label.length > LIMITS.label) return null;
  return { firstName, lastName, label };
}

/** The contacts whose names have context after them, with what tidying would make of each. */
export async function contactsToTidy(accountId: number): Promise<TidyProposal[]> {
  const rows = await state().selectFrom("contacts").select(["id", "name", "vcard"]).where("account_id", "=", accountId).orderBy("sort_key").execute();
  const existing = new Map((await contactLabels(accountId)).map((l) => [fold(l.label), l.label]));
  const out: TidyProposal[] = [];
  for (const row of rows) {
    const card = parseVCards(row.vcard)[0];
    const tidy = card && tidyCard(card);
    if (!tidy) continue;
    const label = existing.get(fold(tidy.label)) ?? tidy.label;
    existing.set(fold(label), label);
    out.push({ id: row.id, name: row.name, ...tidy, label });
  }
  return out;
}

/**
 * Tidies the contacts asked for: each one's context, if its name still has the same,
 * leaves its name for the label given (the one proposed, or another the person chose).
 */
export async function tidyContacts(accountId: number, items: unknown): Promise<number> {
  if (!Array.isArray(items) || items.length > MAX_IMPORT) throw new ContactError("Say which contacts to tidy.");
  const wanted = new Map<number, string>();
  for (const item of items as { id?: unknown; label?: unknown }[]) {
    if (Number.isInteger(item?.id)) wanted.set(item.id as number, cleanLabel(item.label));
  }
  if (!wanted.size) return 0;
  return state().transaction().execute(async (trx) => {
    const rows = await trx.selectFrom("contacts").select(["id", "vcard"]).where("account_id", "=", accountId).where("id", "in", [...wanted.keys()]).execute();
    let changed = 0;
    for (const row of rows) {
      const card = parseVCards(row.vcard)[0];
      const tidy = card && tidyCard(card);
      if (!card || !tidy) continue;
      const fields = readFields(card);
      const labels = uniqueLabels([...fields.labels, wanted.get(row.id)!]);
      await writeCard(trx, accountId, applyFields(card, { ...fields, firstName: tidy.firstName, lastName: tidy.lastName, labels }), row.id);
      changed++;
    }
    return changed;
  });
}
