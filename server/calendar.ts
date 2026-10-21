// Each mailbox's calendars and their events, kept in the state store. An event is kept
// whole, as its iCalendar object (icalendar.ts), with its title, a lower-cased text to
// search and when it starts and ends alongside, to find what falls in a week or a month.
// The first visit to the calendar makes the mailbox's own one, named after it.
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { sql } from "kysely";
import { VERSION } from "./config.ts";
import { contains, fold } from "./contacts.ts";
import { randomToken } from "./crypto.ts";
import {
  COLORS,
  DATE,
  type EventFields,
  WALL,
  applyFields,
  eventTimes,
  eventUid,
  instantIn,
  isZone,
  masterEvent,
  msOf,
  newEvent,
  ownZone,
  parseCalendar,
  readFields,
  serialize,
  wallToMs,
} from "./icalendar.ts";
import { type EventTable, isUniqueViolation, orIgnore, state } from "./state/db.ts";

export class CalendarError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** "changed" with the account id, when its calendars or events change: other open pages refetch. */
export const calendarEvents = new EventEmitter();
calendarEvents.setMaxListeners(1000);

const PRODID = `-//Viauna//Viauna ${VERSION}//EN`;
const DAY = 86_400_000;

/** Fixed limits (docs/how-it-works/limits.md). */
export const LIMITS = {
  calendars: 50,
  name: 100,
  title: 500,
  location: 1000,
  description: 20_000,
  video: 2000,
  /** The longest range one request lists, in days. */
  rangeDays: 400,
  /** Search results, newest first. */
  results: 200,
};

export interface CalendarInfo {
  id: number;
  name: string;
  color: string;
  visible: boolean;
  primary: boolean;
}

/** What the calendar grid shows of an event. Timed: ISO instants. All-day: dates, end exclusive. */
export interface EventSummary {
  id: number;
  calendarId: number;
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  color: string | null;
  busy: boolean;
  location: string;
  video: boolean;
}

export interface EventDetail extends EventFields {
  id: number;
  calendarId: number;
  /** The zone the event was written in, when it isn't the reader's. */
  eventZone: string | null;
  created: number;
  updated: number;
}

type EventRow = Omit<EventTable, "id"> & { id: number };

const calendarJson = (r: { id: number; name: string; color: string; visible: number; primary_of: number | null }): CalendarInfo => ({
  id: r.id,
  name: r.name,
  color: r.color,
  visible: !!r.visible,
  primary: r.primary_of !== null,
});

const changed = (accountId: number) => calendarEvents.emit("changed", accountId);

function cleanName(input: unknown): string {
  const name = typeof input === "string" ? input.trim() : "";
  if (!name) throw new CalendarError("Give the calendar a name.");
  if (name.length > LIMITS.name || /[\x00-\x1f]/.test(name)) throw new CalendarError(`A calendar's name can be at most ${LIMITS.name} characters, on one line.`);
  return name;
}

function cleanColor(input: unknown): string {
  if (typeof input === "string" && (COLORS as readonly string[]).includes(input)) return input;
  throw new CalendarError("Pick one of the colours offered.");
}

/** The mailbox's calendars, making its own one first if this is the first visit. */
export async function listCalendars(accountId: number, ownerName: string): Promise<CalendarInfo[]> {
  const read = () =>
    state()
      .selectFrom("calendars")
      .select(["id", "name", "color", "visible", "primary_of"])
      .where("account_id", "=", accountId)
      .orderBy("position")
      .orderBy("id")
      .execute();
  let rows = await read();
  if (!rows.some((r) => r.primary_of !== null)) {
    const now = Date.now();
    await orIgnore(
      state()
        .insertInto("calendars")
        .values({ account_id: accountId, name: ownerName.slice(0, LIMITS.name) || "Calendar", color: "dodgerblue", position: 0, primary_of: accountId, created_at: now, updated_at: now }),
    ).execute();
    rows = await read();
  }
  return rows.map(calendarJson);
}

async function ownCalendar(accountId: number, id: number) {
  const row = await state()
    .selectFrom("calendars")
    .select(["id", "name", "color", "visible", "primary_of"])
    .where("account_id", "=", accountId)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new CalendarError("This calendar no longer exists.", 404);
  return row;
}

export async function createCalendar(accountId: number, input: Record<string, unknown>): Promise<CalendarInfo> {
  const name = cleanName(input.name);
  const existing = await state().selectFrom("calendars").select(["color", "position"]).where("account_id", "=", accountId).execute();
  if (existing.length >= LIMITS.calendars) throw new CalendarError(`A mailbox can have at most ${LIMITS.calendars} calendars.`);
  const color = input.color === undefined ? (COLORS.find((c) => !existing.some((e) => e.color === c)) ?? COLORS[0]) : cleanColor(input.color);
  const now = Date.now();
  const position = Math.max(0, ...existing.map((e) => e.position)) + 1;
  await state().insertInto("calendars").values({ account_id: accountId, name, color, position, primary_of: null, created_at: now, updated_at: now }).execute();
  // MySQL has no RETURNING: the newest of this mailbox's calendars is the one just made.
  const row = await state()
    .selectFrom("calendars")
    .select(["id", "name", "color", "visible", "primary_of"])
    .where("account_id", "=", accountId)
    .orderBy("id", "desc")
    .executeTakeFirstOrThrow();
  changed(accountId);
  return calendarJson(row);
}

export async function updateCalendar(accountId: number, id: number, input: Record<string, unknown>): Promise<CalendarInfo> {
  await ownCalendar(accountId, id);
  const set: { name?: string; color?: string; visible?: number; updated_at: number } = { updated_at: Date.now() };
  if ("name" in input) set.name = cleanName(input.name);
  if ("color" in input) set.color = cleanColor(input.color);
  if ("visible" in input) set.visible = input.visible ? 1 : 0;
  await state().updateTable("calendars").set(set).where("account_id", "=", accountId).where("id", "=", id).execute();
  changed(accountId);
  return calendarJson(await ownCalendar(accountId, id));
}

/** Deletes a calendar and its events. The mailbox's own calendar stays. */
export async function deleteCalendar(accountId: number, id: number): Promise<void> {
  const row = await ownCalendar(accountId, id);
  if (row.primary_of !== null) throw new CalendarError("Your own calendar can't be deleted. Rename it, or delete its events.");
  await state().transaction().execute(async (trx) => {
    await trx.deleteFrom("events").where("account_id", "=", accountId).where("calendar_id", "=", id).execute();
    await trx.deleteFrom("calendars").where("account_id", "=", accountId).where("id", "=", id).execute();
  });
  changed(accountId);
}

// ---------------------------------------------------------------- events

function str(v: unknown, max: number, what: string): string {
  const s = typeof v === "string" ? v.replace(/\r\n?/g, "\n") : "";
  if (s.length > max) throw new CalendarError(`${what} can be at most ${max.toLocaleString("en")} characters.`);
  return s;
}

/** Checks what the page sent, and puts it in shape. */
export function cleanFields(input: unknown): EventFields {
  const o = (input ?? {}) as Record<string, unknown>;
  const allDay = o.allDay === true;
  const start = typeof o.start === "string" ? o.start : "";
  const end = typeof o.end === "string" ? o.end : "";
  const zone = allDay ? null : o.zone;
  if (allDay) {
    if (!DATE.test(start) || !DATE.test(end) || !validDate(start) || !validDate(end)) throw new CalendarError("Give the event a start and an end date.");
    if (end <= start) throw new CalendarError("An event can't end before it starts.");
  } else {
    if (!isZone(zone)) throw new CalendarError("Unknown time zone.");
    if (!WALL.test(start) || !WALL.test(end) || !validWall(start) || !validWall(end)) throw new CalendarError("Give the event a start and an end time.");
    if (wallToMs(end, zone) < wallToMs(start, zone)) throw new CalendarError("An event can't end before it starts.");
  }
  const video = str(o.video, LIMITS.video, "A video call link").trim();
  if (video && !/^https?:\/\/[^\s]+$/i.test(video)) throw new CalendarError("A video call link must start with https://.");
  const color = o.color === null || o.color === undefined || o.color === "" ? null : cleanColor(o.color);
  return {
    title: str(o.title, LIMITS.title, "The title").replace(/\n/g, " ").trim(),
    allDay,
    start,
    end,
    zone: allDay ? null : (zone as string),
    location: str(o.location, LIMITS.location, "The location").trim(),
    description: str(o.description, LIMITS.description, "The description").trim(),
    busy: o.busy !== false,
    color,
    video: video || null,
  };
}

function validDate(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(date);
}

function validWall(wall: string): boolean {
  return validDate(wall.slice(0, 10)) && Number(wall.slice(11, 13)) < 24 && Number(wall.slice(14, 16)) < 60;
}

type Root = ReturnType<typeof parseCalendar>;

/** The columns kept beside the iCalendar object. */
function indexed(root: Root) {
  const event = masterEvent(root);
  const times = event && eventTimes(event, root);
  if (!event || !times) throw new CalendarError("That isn't an event Viauna can read.");
  const title = String(event.getFirstPropertyValue("summary") ?? "").slice(0, LIMITS.title);
  const location = String(event.getFirstPropertyValue("location") ?? "");
  const description = String(event.getFirstPropertyValue("description") ?? "");
  return {
    title,
    search: fold([title, location, description].join(" ")),
    start_at: msOf(times.start),
    end_at: msOf(times.end),
    all_day: times.start.kind === "date" ? 1 : 0,
  };
}

function summary(row: { id: number; calendar_id: number; ics: string }, zone: string, from?: number, to?: number): EventSummary | null {
  let root: Root;
  try {
    root = parseCalendar(row.ics);
  } catch {
    return null;
  }
  const event = masterEvent(root);
  const times = event && eventTimes(event, root);
  const f = readFields(root, zone);
  if (!event || !times || !f) return null;
  let start: string;
  let end: string;
  if (f.allDay) {
    start = f.start;
    end = f.end;
    if (from !== undefined && to !== undefined && !(msOf(times.start) < to && msOf(times.end) > from)) return null;
  } else {
    const s = instantIn(times.start, zone);
    const e = instantIn(times.end, zone);
    if (from !== undefined && to !== undefined && !(s < to && (e > from || (e === s && s >= from)))) return null;
    start = new Date(s).toISOString();
    end = new Date(e).toISOString();
  }
  return { id: row.id, calendarId: row.calendar_id, title: f.title, allDay: f.allDay, start, end, color: f.color, busy: f.busy, location: f.location, video: !!f.video };
}

function checkZone(zone: unknown): string {
  if (!isZone(zone)) throw new CalendarError("Unknown time zone.");
  return zone;
}

/**
 * The events from one date up to (not including) another, as the calendar shows them
 * in `zone`. An all-day event is on its dates wherever you are.
 */
export async function eventsBetween(accountId: number, from: string, to: string, zone: string): Promise<EventSummary[]> {
  checkZone(zone);
  if (!DATE.test(from) || !DATE.test(to) || !validDate(from) || !validDate(to) || to <= from) throw new CalendarError("Ask for a range of dates.");
  const fromMs = wallToMs(`${from}T00:00`, zone);
  const toMs = wallToMs(`${to}T00:00`, zone);
  if (toMs - fromMs > LIMITS.rangeDays * DAY) throw new CalendarError(`Ask for at most ${LIMITS.rangeDays} days at a time.`);
  const rows = await state()
    .selectFrom("events")
    .select(["id", "calendar_id", "ics", "all_day"])
    .where("account_id", "=", accountId)
    .where("start_at", "<", toMs + DAY)
    .where("end_at", ">", fromMs - DAY)
    .execute();
  const utcFrom = Date.parse(`${from}T00:00:00Z`);
  const utcTo = Date.parse(`${to}T00:00:00Z`);
  return rows
    .map((r) => (r.all_day ? summary(r, zone, utcFrom, utcTo) : summary(r, zone, fromMs, toMs)))
    .filter((e): e is EventSummary => e !== null)
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** Events whose title, place or description has `q` in it, newest first. */
export async function searchEvents(accountId: number, q: string, zone: string): Promise<EventSummary[]> {
  checkZone(zone);
  const term = fold(q.trim()).slice(0, 200);
  if (!term) return [];
  const rows = await state()
    .selectFrom("events")
    .select(["id", "calendar_id", "ics"])
    .where("account_id", "=", accountId)
    .where(sql<boolean>`search like ${contains(term)} escape '!'`)
    .orderBy("start_at", "desc")
    .limit(LIMITS.results)
    .execute();
  return rows.map((r) => summary(r, zone)).filter((e): e is EventSummary => e !== null);
}

async function loadEvent(accountId: number, id: number): Promise<EventRow> {
  const row = await state().selectFrom("events").selectAll().where("account_id", "=", accountId).where("id", "=", id).executeTakeFirst();
  if (!row) throw new CalendarError("This event no longer exists.", 404);
  return row;
}

function detail(row: EventRow, zone: string): EventDetail {
  const root = parseCalendar(row.ics);
  const f = readFields(root, zone);
  if (!f) throw new CalendarError("That isn't an event Viauna can read.");
  const own = ownZone(root);
  return { ...f, id: row.id, calendarId: row.calendar_id, eventZone: own && own !== zone ? own : null, created: row.created_at, updated: row.updated_at };
}

export async function getEvent(accountId: number, id: number, zone: string): Promise<EventDetail> {
  return detail(await loadEvent(accountId, id), checkZone(zone));
}

export async function createEvent(accountId: number, calendarId: number, input: unknown, zone: string): Promise<EventDetail> {
  checkZone(zone);
  await ownCalendar(accountId, calendarId);
  const root = newEvent(cleanFields(input), crypto.randomUUID(), PRODID);
  const now = Date.now();
  const uid = eventUid(root)!;
  await state()
    .insertInto("events")
    .values({ account_id: accountId, calendar_id: calendarId, uid, ics: serialize(root), created_at: now, updated_at: now, ...indexed(root) })
    .execute();
  const row = await state().selectFrom("events").selectAll().where("calendar_id", "=", calendarId).where("uid", "=", uid).executeTakeFirstOrThrow();
  changed(accountId);
  return detail(row, zone);
}

// ---------------------------------------------------------------- undo

interface UndoEntry {
  accountId: number;
  /** The event as it was before; for a deletion, the whole row to put back. */
  row: EventRow;
  deleted: boolean;
  expires: number;
}

const undoLog = new Map<string, UndoEntry>();

function remember(row: EventRow, deleted: boolean): string {
  const token = randomToken(16);
  undoLog.set(token, { accountId: row.account_id, row, deleted, expires: Date.now() + 10 * 60_000 });
  return token;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of undoLog) if (v.expires < now) undoLog.delete(k);
}, 60_000).unref();

/** Puts an event back as it was before a change or a deletion. */
export async function undoChange(accountId: number, token: string): Promise<boolean> {
  const entry = undoLog.get(token);
  if (!entry || entry.accountId !== accountId || entry.expires < Date.now()) return false;
  undoLog.delete(token);
  const { row } = entry;
  try {
    if (entry.deleted) {
      await state().insertInto("events").values(row).execute();
    } else {
      const { id, account_id, ...rest } = row;
      const done = await state().updateTable("events").set(rest).where("account_id", "=", account_id).where("id", "=", id).executeTakeFirst();
      if (!Number(done.numUpdatedRows)) return false;
    }
  } catch (err) {
    // Its calendar was deleted since, or the same event was added there again.
    if (isUniqueViolation(err) || /foreign key/i.test((err as Error).message)) return false;
    throw err;
  }
  changed(accountId);
  return true;
}

// ---------------------------------------------------------------- changing events

/**
 * Changes an event: the fields given (the rest stay), and its calendar if `calendarId`
 * is. Times come in `zone`; a timed event keeps the zone it was written in.
 */
export async function updateEvent(accountId: number, id: number, input: Record<string, unknown>, zone: string): Promise<{ event: EventDetail; undo: string }> {
  checkZone(zone);
  const row = await loadEvent(accountId, id);
  const root = parseCalendar(row.ics);
  const current = readFields(root, zone);
  if (!current) throw new CalendarError("That isn't an event Viauna can read.");
  // Times come and go in the reader's zone (applyFields keeps the event's own).
  const merged = { ...current, ...input };
  merged.zone = merged.allDay ? null : zone;
  const fields = cleanFields(merged);
  let calendarId = row.calendar_id;
  if (input.calendarId !== undefined && input.calendarId !== row.calendar_id) {
    calendarId = (await ownCalendar(accountId, Number(input.calendarId))).id;
  }
  applyFields(root, fields);
  const values = { calendar_id: calendarId, ics: serialize(root), updated_at: Date.now(), ...indexed(root) };
  try {
    await state().updateTable("events").set(values).where("account_id", "=", accountId).where("id", "=", id).execute();
  } catch (err) {
    if (isUniqueViolation(err)) throw new CalendarError("That calendar already has this event.");
    throw err;
  }
  const undo = remember(row, false);
  changed(accountId);
  return { event: detail({ ...row, ...values }, zone), undo };
}

export async function deleteEvent(accountId: number, id: number): Promise<string> {
  const row = await loadEvent(accountId, id);
  await state().deleteFrom("events").where("account_id", "=", accountId).where("id", "=", id).execute();
  changed(accountId);
  return remember(row, true);
}
