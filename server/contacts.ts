// The address book: each mailbox's contacts, kept in the state store as whole vCards
// (vcard.ts), with what's needed to list, search and suggest them alongside. Contacts
// are what a person chose to keep, unlike the index's "people you write to", which is
// rebuilt from mail; suggestions while writing draw on both, saved contacts first.
import crypto from "node:crypto";
import { type Transaction, sql } from "kysely";
import { VERSION } from "./config.ts";
import { searchContacts as searchCorrespondents } from "./mail/labels.ts";
import { type StateSchema, state } from "./state/db.ts";
import {
  type ContactFields,
  type VCard,
  applyFields,
  cardUid,
  checkCard,
  displayName,
  newCard,
  parseVCards,
  readFields,
  serializeVCard,
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
}

const PRODID = `-//Viauna//Viauna ${VERSION}//EN`;
const ADDRESS = /^[^\s@]+@[^\s@]+$/;
const MAX_IMPORT = 10_000;

/** A LIKE pattern for `text` anywhere, with "!" as the escape (the same on every engine). */
function contains(text: string): string {
  return `%${text.replace(/[!%_]/g, (c) => `!${c}`)}%`;
}

/** Lower-cased, and with accents gone, so "Élodie" sorts with "elodie". */
function fold(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function indexed(card: VCard) {
  const name = displayName(card).slice(0, 500);
  const f = readFields(card);
  const emails = [...new Set(f.emails.map((e) => e.address.toLowerCase()).filter((a) => ADDRESS.test(a) && a.length <= 320))];
  const search = fold([name, f.organization, ...emails, ...f.phones.map((p) => p.number.replace(/[^\d+]/g, ""))].join(" "));
  return { name, sortKey: fold(name).slice(0, 500), search, emails, fields: f };
}

/** Checks what the page sent, and puts it in shape. */
export function cleanFields(input: unknown): ContactFields {
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
  const fields: ContactFields = {
    firstName: str(o.firstName, 200, "The first name"),
    lastName: str(o.lastName, 200, "The last name"),
    organization: str(o.organization, 200, "The company"),
    title: str(o.title, 200, "The job title"),
    birthday: str(o.birthday, 30, "The birthday"),
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
  if (!fields.firstName && !fields.lastName && !fields.organization && !fields.emails.length) {
    throw new ContactError("Give the contact a name, a company or an email address.");
  }
  return fields;
}

/** Inserts or replaces a contact's row and addresses, inside a transaction. */
async function write(trx: Transaction<StateSchema>, accountId: number, card: VCard, id: number | null): Promise<number> {
  const problem = checkCard(card);
  if (problem) throw new ContactError(problem);
  const { name, sortKey, search, emails } = indexed(card);
  const now = Date.now();
  const vcard = serializeVCard(card);
  let contactId = id;
  if (contactId === null) {
    const uid = cardUid(card)!;
    await trx
      .insertInto("contacts")
      .values({ account_id: accountId, uid, name, sort_key: sortKey, search, vcard, created_at: now, updated_at: now })
      .execute();
    // Read back by the UID, which is unique per mailbox (MySQL has no RETURNING).
    const row = await trx.selectFrom("contacts").select("id").where("account_id", "=", accountId).where("uid", "=", uid).executeTakeFirstOrThrow();
    contactId = row.id;
  } else {
    await trx.updateTable("contacts").set({ name, sort_key: sortKey, search, vcard, updated_at: now }).where("id", "=", contactId).where("account_id", "=", accountId).execute();
    await trx.deleteFrom("contact_emails").where("contact_id", "=", contactId).execute();
  }
  if (emails.length) {
    await trx
      .insertInto("contact_emails")
      .values(emails.map((address, position) => ({ contact_id: contactId, account_id: accountId, position, address })))
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
  return { id: row.id, name: row.name, emails: f?.emails.map((e) => e.address) ?? [], phone: f?.phones[0]?.number ?? null, organization: f?.organization ?? "" };
}

export async function listContacts(accountId: number, q: string, offset = 0, limit = 200): Promise<{ contacts: ContactSummary[]; total: number }> {
  const term = fold(q.trim());
  let base = state().selectFrom("contacts").where("account_id", "=", accountId);
  if (term) base = base.where(sql<boolean>`search like ${contains(term)} escape '!'`);
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
  const id = await state().transaction().execute((trx) => write(trx, accountId, card, null));
  return getContact(accountId, id);
}

export async function updateContact(accountId: number, id: number, input: unknown) {
  const fields = cleanFields(input);
  const found = await load(accountId, id);
  if (!found) throw new ContactError("This contact no longer exists.", 404);
  await state().transaction().execute((trx) => write(trx, accountId, applyFields(found.card, fields), id));
  return getContact(accountId, id);
}

export async function deleteContacts(accountId: number, ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const result = await state().deleteFrom("contacts").where("account_id", "=", accountId).where("id", "in", ids).executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
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
      await write(trx, accountId, card, existing?.id ?? null);
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
 * mailbox writes to and hears from (the index), without repeats.
 */
export async function suggest(accountId: number, q: string, withContacts: boolean, limit = 8): Promise<{ address: string; name: string | null }[]> {
  const term = fold(q.trim());
  if (!term) return [];
  const saved = withContacts
    ? await state()
        .selectFrom("contact_emails as e")
        .innerJoin("contacts as c", "c.id", "e.contact_id")
        .select(["e.address", "c.name"])
        .where("e.account_id", "=", accountId)
        .where(sql<boolean>`(e.address like ${contains(term)} escape '!' or c.search like ${contains(term)} escape '!')`)
        .orderBy(sql`case when e.address like ${`${term.replace(/[!%_]/g, (c) => `!${c}`)}%`} escape '!' then 0 else 1 end`)
        .orderBy("c.sort_key")
        .orderBy("e.position")
        .limit(limit)
        .execute()
    : [];
  const seen = new Set(saved.map((s) => s.address));
  const others = searchCorrespondents(accountId, q, limit).filter((c) => !seen.has(c.address));
  return [...saved.map((s) => ({ address: s.address, name: s.name || null })), ...others].slice(0, limit);
}
