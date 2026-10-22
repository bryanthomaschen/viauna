// Each mailbox's calendars and their events, kept in the state store. An event is kept
// whole, as its iCalendar object (icalendar.ts), with its title, a lower-cased text to
// search and when it starts and ends alongside, to find what falls in a week or a month.
// The first visit to the calendar makes the mailbox's own one, named after it, and its
// Birthdays calendar, whose events are made from its contacts (birthdays.ts). A calendar
// from the web is fetched from its address (feeds.ts) and kept like the rest, read-only,
// and fetched again every few hours. Any calendar can have a secret address, for another
// app to show it read-only.
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { sql } from "kysely";
import { birthdayObjects, birthdaysBetween } from "./birthdays.ts";
import { VERSION, setting } from "./config.ts";
import { type ParsedFile, buildFile, busyOnly, parseFile } from "./calendar-file.ts";
import { FEED_LIMITS, FeedError, feedUrl, fetchFeed } from "./feeds.ts";
import { log } from "./log.ts";
import { cleanReminders, getSettings } from "./settings.ts";
import { contains, fold } from "./text.ts";
import { randomToken, sha256 } from "./crypto.ts";
import {
  COLORS,
  DATE,
  type EventFields,
  WALL,
  eventTimes,
  eventUid,
  fieldsOf,
  hasReminders,
  instantIn,
  isZone,
  masterEvent,
  newEvent,
  ownZones,
  parseCalendar,
  serialize,
  wallToMs,
} from "./icalendar.ts";
import {
  LIMITS as RULE_LIMITS,
  type Occurrence,
  type RepeatRule,
  type Scope,
  WEEKDAYS,
  type Weekday,
  deleteFrom,
  editEvent,
  isRecurring,
  occurrenceAt,
  occurrences,
  readRule,
  representative,
  sameRule,
  seriesSpan,
  writeRule,
} from "./recurrence.ts";
import { type CalendarKind, type EventTable, isUniqueViolation, orIgnore, state } from "./state/db.ts";

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
  /** One import: the file, its events, and one event as iCalendar. */
  importBytes: 20 * 1024 * 1024,
  importEvents: 10_000,
  eventBytes: 1024 * 1024,
};

export interface CalendarInfo {
  id: number;
  name: string;
  color: string;
  visible: boolean;
  primary: boolean;
  kind: CalendarKind;
  /** Its events can't be added, changed or deleted here: they come from elsewhere. */
  readOnly: boolean;
  /** A calendar from the web: its address, when it last came back and was last tried, and what went wrong. */
  feed: { url: string; fetchedAt: number | null; checkedAt: number | null; error: string | null } | null;
  /** Its secret address, if it has one: what it shows, when it was made, when an app last fetched it. Never the address. */
  secret: { mode: SecretMode; createdAt: number; fetchedAt: number | null } | null;
}

/** What a secret address shows: the whole calendar, or only when you're busy. */
export type SecretMode = "all" | "busy";

/** What the calendar grid shows of an event, or one occurrence of it. Timed: ISO instants. All-day: dates, end exclusive. */
export interface EventSummary {
  id: number;
  calendarId: number;
  /** For an event that repeats: which occurrence (its RECURRENCE-ID as written). */
  occurrence: string | null;
  recurring: boolean;
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  color: string | null;
  busy: boolean;
  location: string;
  video: boolean;
  /** In a calendar whose events come from elsewhere. */
  readOnly: boolean;
  /** On the Birthdays calendar: whose date it is. */
  contactId: number | null;
}

export interface EventDetail extends EventFields {
  id: number;
  calendarId: number;
  /** In a calendar whose events come from elsewhere. */
  readOnly: boolean;
  occurrence: string | null;
  recurring: boolean;
  /** How the series repeats; null if it doesn't. */
  repeat: RepeatRule | null;
  /** The zone the event was made in, when it isn't the reader's. */
  eventZone: string | null;
  /** The zone its end was made in, when that's another. */
  eventEndZone: string | null;
  created: number;
  updated: number;
}

type EventRow = Omit<EventTable, "id"> & { id: number };

type CalendarRow = {
  id: number; name: string; color: string; visible: number; primary_of: number | null; kind: CalendarKind;
  source_url: string | null; fetched_at: number | null; checked_at: number | null; fetch_error: string | null;
  secret_mode: SecretMode | null; secret_created_at: number | null; secret_fetched_at: number | null;
};
const CALENDAR_COLUMNS = [
  "id", "name", "color", "visible", "primary_of", "kind", "source_url", "fetched_at", "checked_at", "fetch_error",
  "secret_mode", "secret_created_at", "secret_fetched_at",
] as const;

const calendarJson = (r: CalendarRow): CalendarInfo => ({
  id: r.id,
  name: r.name,
  color: r.color,
  visible: !!r.visible,
  primary: r.primary_of !== null,
  kind: r.kind,
  readOnly: r.kind !== "events",
  feed: r.kind === "feed" ? { url: r.source_url ?? "", fetchedAt: r.fetched_at, checkedAt: r.checked_at, error: r.fetch_error } : null,
  secret: r.secret_mode && r.secret_created_at ? { mode: r.secret_mode, createdAt: r.secret_created_at, fetchedAt: r.secret_fetched_at } : null,
});

/** Kinds whose calendars are shown: the Birthdays calendar while there are contacts, the web's while they're allowed. */
const shown = (kind: CalendarKind) => (kind === "birthdays" ? setting("contacts") : kind === "feed" ? setting("calendarFeeds") : true);

/** The kind of each of the mailbox's calendars that's shown. */
async function shownKinds(accountId: number): Promise<Map<number, CalendarKind>> {
  const rows = await state().selectFrom("calendars").select(["id", "kind"]).where("account_id", "=", accountId).execute();
  return new Map(rows.filter((r) => shown(r.kind)).map((r) => [r.id, r.kind]));
}

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

/**
 * The mailbox's calendars, making its own one first if this is the first visit, and its
 * Birthdays calendar the first time contacts are on.
 */
export async function listCalendars(accountId: number, ownerName: string): Promise<CalendarInfo[]> {
  const read = () =>
    state()
      .selectFrom("calendars")
      .select([...CALENDAR_COLUMNS, "birthdays_of", "position"])
      .where("account_id", "=", accountId)
      .orderBy("position")
      .orderBy("id")
      .execute();
  let rows = await read();
  const now = Date.now();
  if (!rows.some((r) => r.primary_of !== null)) {
    await orIgnore(
      state()
        .insertInto("calendars")
        .values({ account_id: accountId, name: ownerName.slice(0, LIMITS.name) || "Calendar", color: "dodgerblue", position: 0, primary_of: accountId, created_at: now, updated_at: now }),
    ).execute();
    rows = await read();
  }
  if (setting("contacts") && !rows.some((r) => r.birthdays_of !== null)) {
    await orIgnore(
      state()
        .insertInto("calendars")
        .values({
          account_id: accountId, name: "Birthdays", color: "mediumseagreen", position: Math.max(0, ...rows.map((r) => r.position)) + 1, primary_of: null,
          kind: "birthdays", birthdays_of: accountId, created_at: now, updated_at: now,
        }),
    ).execute();
    rows = await read();
  }
  return rows.filter((r) => shown(r.kind)).map(calendarJson);
}

async function ownCalendar(accountId: number, id: number) {
  const row = await state()
    .selectFrom("calendars")
    .select([...CALENDAR_COLUMNS])
    .where("account_id", "=", accountId)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row || !shown(row.kind)) throw new CalendarError("This calendar no longer exists.", 404);
  return row;
}

/** A calendar whose events are kept here, to add, change or import events in. */
async function eventsCalendar(accountId: number, id: number) {
  const row = await ownCalendar(accountId, id);
  if (row.kind === "birthdays") throw new CalendarError("The Birthdays calendar shows your contacts' dates. Change them in Contacts.");
  if (row.kind === "feed") throw new CalendarError("This calendar comes from the web, so it can't be changed here. Duplicate an event into one of your calendars to change it.");
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
    .select([...CALENDAR_COLUMNS])
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
  if (row.kind === "birthdays") throw new CalendarError("The Birthdays calendar comes from your contacts, so it can't be deleted. Hide it instead.");
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

/** Checks a repeat rule the page sent, and puts it in shape. */
export function cleanRule(input: unknown, startDate: string): RepeatRule | null {
  if (input === null || input === undefined || input === false) return null;
  const o = input as Record<string, unknown>;
  if (typeof o.custom === "string") {
    if (o.custom.length > RULE_LIMITS.ruleText) throw new CalendarError("That repeat rule is too long.");
    return { freq: "daily", interval: 1, custom: o.custom };
  }
  const freq = o.freq;
  if (freq !== "daily" && freq !== "weekly" && freq !== "monthly" && freq !== "yearly") throw new CalendarError("Say how often the event repeats.");
  const interval = o.interval === undefined ? 1 : Number(o.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > RULE_LIMITS.interval) throw new CalendarError(`Repeat every 1 to ${RULE_LIMITS.interval}.`);
  const rule: RepeatRule = { freq, interval };
  if (freq === "weekly" && Array.isArray(o.days) && o.days.length) {
    if (o.days.some((d) => !WEEKDAYS.includes(d as Weekday))) throw new CalendarError("Pick the days of the week it repeats on.");
    rule.days = WEEKDAYS.filter((d) => (o.days as string[]).includes(d));
  }
  if (freq === "monthly" && o.nth) {
    const n = o.nth as Record<string, unknown>;
    const week = Number(n.week);
    if (!(week === -1 || (Number.isInteger(week) && week >= 1 && week <= 4)) || !WEEKDAYS.includes(n.day as Weekday)) {
      throw new CalendarError("Pick which weekday of the month it repeats on.");
    }
    rule.nth = { week, day: n.day as Weekday };
  }
  if (o.count !== undefined && o.count !== null) {
    const count = Number(o.count);
    if (!Number.isInteger(count) || count < 1 || count > RULE_LIMITS.count) throw new CalendarError(`Repeat 1 to ${RULE_LIMITS.count.toLocaleString("en")} times.`);
    rule.count = count;
  } else if (o.until !== undefined && o.until !== null) {
    if (typeof o.until !== "string" || !DATE.test(o.until) || !validDate(o.until)) throw new CalendarError("Give the date the event stops repeating.");
    if (o.until < startDate) throw new CalendarError("An event can't stop repeating before it starts.");
    rule.until = o.until;
  }
  return rule;
}

/** Checks what the page sent, and puts it in shape. */
export function cleanFields(input: unknown): EventFields {
  const o = (input ?? {}) as Record<string, unknown>;
  const allDay = o.allDay === true;
  const start = typeof o.start === "string" ? o.start : "";
  const end = typeof o.end === "string" ? o.end : "";
  const zone = allDay ? null : o.zone;
  const endZone = allDay || o.endZone === null || o.endZone === undefined || o.endZone === o.zone ? null : o.endZone;
  if (allDay) {
    if (!DATE.test(start) || !DATE.test(end) || !validDate(start) || !validDate(end)) throw new CalendarError("Give the event a start and an end date.");
    if (end <= start) throw new CalendarError("An event can't end before it starts.");
  } else {
    if (!isZone(zone) || (endZone !== null && !isZone(endZone))) throw new CalendarError("Unknown time zone.");
    if (!WALL.test(start) || !WALL.test(end) || !validWall(start) || !validWall(end)) throw new CalendarError("Give the event a start and an end time.");
    if (wallToMs(end, (endZone as string | null) ?? zone) < wallToMs(start, zone)) throw new CalendarError("An event can't end before it starts.");
  }
  const video = str(o.video, LIMITS.video, "A video call link").trim();
  if (video && !/^https?:\/\/[^\s]+$/i.test(video)) throw new CalendarError("A video call link must start with https://.");
  const color = o.color === null || o.color === undefined || o.color === "" ? null : cleanColor(o.color);
  const reminders = cleanReminders(o.reminders);
  if ("error" in reminders) throw new CalendarError(reminders.error);
  return {
    title: str(o.title, LIMITS.title, "The title").replace(/\n/g, " ").trim(),
    allDay,
    start,
    end,
    zone: allDay ? null : (zone as string),
    endZone: endZone as string | null,
    location: str(o.location, LIMITS.location, "The location").trim(),
    description: str(o.description, LIMITS.description, "The description").trim(),
    busy: o.busy !== false,
    color,
    video: video || null,
    reminders,
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

/** The columns kept beside the iCalendar object. A series that never ends ends at NEVER. */
function indexed(root: Root) {
  const event = masterEvent(root);
  const times = event && eventTimes(event, root);
  if (!event || !times) throw new CalendarError("That isn't an event Viauna can read.");
  const title = String(event.getFirstPropertyValue("summary") ?? "").slice(0, LIMITS.title);
  const location = String(event.getFirstPropertyValue("location") ?? "");
  const description = String(event.getFirstPropertyValue("description") ?? "");
  const span = seriesSpan(root);
  return {
    title,
    search: fold([title, location, description].join(" ")),
    start_at: span.start,
    end_at: span.end,
    all_day: times.start.kind === "date" ? 1 : 0,
    // Due at once, for the scheduler to work out when (reminders.ts), from now on.
    alarm_at: hasReminders(root) ? 0 : null,
    alarm_checked_at: Date.now(),
  };
}

/** An email reminder goes to the mailbox's own address, which RFC 5545 has it name (ATTENDEE). */
async function addressEmailReminders(accountId: number, root: Root): Promise<void> {
  const alarms = root.getAllSubcomponents("vevent").flatMap((e) => e.getAllSubcomponents("valarm"))
    .filter((a) => String(a.getFirstPropertyValue("action") ?? "").toUpperCase() === "EMAIL" && !a.hasProperty("attendee"));
  if (!alarms.length) return;
  const account = await state().selectFrom("accounts").select("email").where("id", "=", accountId).executeTakeFirst();
  if (account) for (const a of alarms) a.addPropertyWithValue("attendee", `mailto:${account.email}`);
}

function parsed(ics: string): Root | null {
  try {
    return parseCalendar(ics);
  } catch {
    return null;
  }
}

/** One occurrence as the grid shows it, in `zone`. */
function summaryOf(row: { id: number; calendar_id: number }, root: Root, occ: Occurrence, zone: string, readOnly: boolean): EventSummary {
  const f = fieldsOf(occ.event, occ, zone);
  const start = occ.start.kind === "date" ? occ.start.date : new Date(instantIn(occ.start, zone)).toISOString();
  const end = occ.end.kind === "date" ? occ.end.date : new Date(instantIn(occ.end, zone)).toISOString();
  return {
    id: row.id, calendarId: row.calendar_id, occurrence: occ.key, recurring: isRecurring(masterEvent(root)!),
    title: f.title, allDay: f.allDay, start, end, color: f.color, busy: f.busy, location: f.location, video: !!f.video,
    readOnly, contactId: null,
  };
}

function checkZone(zone: unknown): string {
  if (!isZone(zone)) throw new CalendarError("Unknown time zone.");
  return zone;
}

/**
 * The events from one date up to (not including) another, as the calendar shows them
 * in `zone`: each occurrence of those that repeat. An all-day event is on its dates
 * wherever you are.
 */
export async function eventsBetween(accountId: number, from: string, to: string, zone: string): Promise<EventSummary[]> {
  checkZone(zone);
  if (!DATE.test(from) || !DATE.test(to) || !validDate(from) || !validDate(to) || to <= from) throw new CalendarError("Ask for a range of dates.");
  const fromMs = wallToMs(`${from}T00:00`, zone);
  const toMs = wallToMs(`${to}T00:00`, zone);
  if (toMs - fromMs > LIMITS.rangeDays * DAY) throw new CalendarError(`Ask for at most ${LIMITS.rangeDays} days at a time.`);
  const rows = await state()
    .selectFrom("events")
    .select(["id", "calendar_id", "ics"])
    .where("account_id", "=", accountId)
    .where("start_at", "<", toMs + DAY)
    .where("end_at", ">", fromMs - DAY)
    .execute();
  const window = { fromMs, toMs, fromDate: from, toDate: to };
  const kinds = await shownKinds(accountId);
  const out: EventSummary[] = [];
  for (const row of rows) {
    const kind = kinds.get(row.calendar_id);
    const root = kind && parsed(row.ics);
    if (!root) continue;
    for (const occ of occurrences(root, zone, window)) out.push(summaryOf(row, root, occ, zone, kind !== "events"));
  }
  if (setting("contacts")) {
    const birthdays = await state().selectFrom("calendars").select("id").where("birthdays_of", "=", accountId).executeTakeFirst();
    if (birthdays) out.push(...(await birthdaysBetween(accountId, birthdays.id, from, to)));
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** Events whose title, place or description has `q` in it, newest first; one that repeats, at its next occurrence. */
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
  const now = Date.now();
  const kinds = await shownKinds(accountId);
  const out: EventSummary[] = [];
  for (const row of rows) {
    const kind = kinds.get(row.calendar_id);
    const root = kind && parsed(row.ics);
    const occ = root && representative(root, now, zone);
    if (root && occ) out.push(summaryOf(row, root, occ, zone, kind !== "events"));
  }
  return out.sort((a, b) => b.start.localeCompare(a.start));
}

async function loadEvent(accountId: number, id: number): Promise<EventRow> {
  const row = await state().selectFrom("events").selectAll().where("account_id", "=", accountId).where("id", "=", id).executeTakeFirst();
  if (!row) throw new CalendarError("This event no longer exists.", 404);
  return row;
}

function cleanKey(input: unknown): string | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input !== "string" || !/^\d{8}(T\d{6}Z?)?$/.test(input)) throw new CalendarError("Unknown occurrence.");
  return input;
}

function cleanScope(input: unknown): Scope {
  if (input === undefined) return "all";
  if (input === "this" || input === "following" || input === "all") return input;
  throw new CalendarError("Say whether to change this event, this and following events, or all events.");
}

/** An event, or one occurrence of it, as the editor shows it, with its times in `zone`. */
function detail(row: EventRow, zone: string, key: string | null = null, readOnly = false): EventDetail {
  const root = parseCalendar(row.ics);
  const master = masterEvent(root);
  const occ = occurrenceAt(root, key, zone);
  if (!master || !occ) throw new CalendarError(key ? "That occurrence isn't part of this event." : "That isn't an event Viauna can read.", 404);
  const f = fieldsOf(occ.event, occ, zone);
  const own = ownZones(occ.event, root);
  const recurring = isRecurring(master);
  return {
    ...f,
    id: row.id,
    calendarId: row.calendar_id,
    readOnly,
    occurrence: recurring ? occ.key : null,
    recurring,
    repeat: readRule(master, root, zone),
    eventZone: own.start && own.start !== zone ? own.start : null,
    eventEndZone: own.end && own.end !== (own.start ?? zone) ? own.end : null,
    created: row.created_at,
    updated: row.updated_at,
  };
}

export async function getEvent(accountId: number, id: number, zone: string, occurrence?: string): Promise<EventDetail> {
  const row = await loadEvent(accountId, id);
  const calendar = await ownCalendar(accountId, row.calendar_id);
  return detail(row, checkZone(zone), cleanKey(occurrence), calendar.kind !== "events");
}

export async function createEvent(accountId: number, calendarId: number, input: unknown, zone: string): Promise<EventDetail> {
  checkZone(zone);
  await eventsCalendar(accountId, calendarId);
  const given = (input ?? {}) as Record<string, unknown>;
  // Without reminders of its own, an event gets the mailbox's usual ones.
  if (given.reminders === undefined) {
    const s = await getSettings(accountId);
    input = { ...given, reminders: given.allDay === true ? s.allDayReminders : s.reminders };
  }
  const fields = cleanFields(input);
  const repeat = cleanRule((input as Record<string, unknown> | null)?.repeat, fields.start.slice(0, 10));
  const root = newEvent(fields, crypto.randomUUID(), PRODID);
  if (repeat) writeRule(masterEvent(root)!, root, repeat);
  await addressEmailReminders(accountId, root);
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
  /** Rows to put back as they were (changed or deleted). */
  restore: EventRow[];
  /** Rows a change added (the second half of a split series), to remove. */
  remove: number[];
  expires: number;
}

const undoLog = new Map<string, UndoEntry>();

function remember(accountId: number, restore: EventRow[], remove: number[] = []): string {
  const token = randomToken(16);
  undoLog.set(token, { accountId, restore, remove, expires: Date.now() + 10 * 60_000 });
  return token;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of undoLog) if (v.expires < now) undoLog.delete(k);
}, 60_000).unref();

/** Puts events back as they were before a change or a deletion. */
export async function undoChange(accountId: number, token: string): Promise<boolean> {
  const entry = undoLog.get(token);
  if (!entry || entry.accountId !== accountId || entry.expires < Date.now()) return false;
  undoLog.delete(token);
  try {
    await state().transaction().execute(async (trx) => {
      if (entry.remove.length) await trx.deleteFrom("events").where("account_id", "=", accountId).where("id", "in", entry.remove).execute();
      for (const row of entry.restore) {
        // Its reminders are worked out again from now, so none is sent twice.
        const { id, account_id, ...was } = row;
        const rest = { ...was, alarm_at: was.alarm_at === null ? null : 0, alarm_checked_at: Date.now() };
        const done = await trx.updateTable("events").set(rest).where("account_id", "=", account_id).where("id", "=", id).executeTakeFirst();
        if (!Number(done.numUpdatedRows)) await trx.insertInto("events").values({ ...row, ...rest }).execute();
      }
    });
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
 * is. For one that repeats, `occurrence` names the occurrence it was changed from and
 * `scope` what changes: this event, this and following events, or all events. Times
 * come in `zone`, and a timed event keeps the zones it was written in, unless `setZones`
 * says the fields name the zones to put it in (the editor's choice).
 */
export async function updateEvent(accountId: number, id: number, input: Record<string, unknown>, zone: string): Promise<{ event: EventDetail; undo: string }> {
  checkZone(zone);
  const row = await loadEvent(accountId, id);
  await eventsCalendar(accountId, row.calendar_id);
  const root = parseCalendar(row.ics);
  const key = cleanKey(input.occurrence);
  const scope = cleanScope(input.scope);
  const current = detail(row, zone, key);
  const setZones = input.setZones === true;
  const merged: Record<string, unknown> = { ...current, ...input };
  if (!setZones) {
    merged.zone = merged.allDay ? null : zone;
    merged.endZone = null;
  }
  const fields = cleanFields(merged);
  const repeat = "repeat" in input ? cleanRule(input.repeat, fields.start.slice(0, 10)) : current.repeat;
  if (current.recurring && scope === "this" && !sameRule(repeat, current.repeat)) {
    throw new CalendarError("How an event repeats changes for this and following events, or all of them.");
  }
  if (repeat?.custom && repeat.custom !== current.repeat?.custom) throw new CalendarError("A repeat set in another app can be kept or replaced here, not edited.");
  let calendarId = row.calendar_id;
  if (input.calendarId !== undefined && input.calendarId !== row.calendar_id) {
    if (current.recurring && scope === "this") throw new CalendarError("One occurrence can't move to another calendar. Move this and following events, or all of them.");
    calendarId = (await eventsCalendar(accountId, Number(input.calendarId))).id;
  }
  let edited: ReturnType<typeof editEvent>;
  try {
    edited = editEvent(root, key, scope, fields, repeat, zone, { setZones });
  } catch (err) {
    if (err instanceof CalendarError) throw err;
    throw new CalendarError((err as Error).message);
  }
  await addressEmailReminders(accountId, edited.root);
  if (edited.split) await addressEmailReminders(accountId, edited.split);
  const now = Date.now();
  // A split leaves the event before the occurrence where it was; what follows is new,
  // and goes to the calendar asked for.
  const values = { calendar_id: edited.split ? row.calendar_id : calendarId, ics: serialize(edited.root), updated_at: now, ...indexed(edited.root) };
  let splitId: number | null = null;
  try {
    await state().transaction().execute(async (trx) => {
      await trx.updateTable("events").set(values).where("account_id", "=", accountId).where("id", "=", id).execute();
      if (edited.split) {
        const uid = eventUid(edited.split)!;
        await trx
          .insertInto("events")
          .values({ account_id: accountId, calendar_id: calendarId, uid, ics: serialize(edited.split), created_at: now, updated_at: now, ...indexed(edited.split) })
          .execute();
        splitId = (await trx.selectFrom("events").select("id").where("calendar_id", "=", calendarId).where("uid", "=", uid).executeTakeFirstOrThrow()).id;
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new CalendarError("That calendar already has this event.");
    throw err;
  }
  const undo = remember(accountId, [row], splitId === null ? [] : [splitId]);
  changed(accountId);
  // The changed occurrence: in the new series after a split, else where it now is.
  const shown = splitId !== null
    ? detail(await loadEvent(accountId, splitId), zone)
    : detail({ ...row, ...values }, zone, scope === "this" ? key : null);
  return { event: shown, undo };
}

/**
 * Deletes an event; for one that repeats, the occurrence `occurrence` alone, it and the
 * ones after, or all of them, as `scope` says.
 */
export async function deleteEvent(accountId: number, id: number, occurrence?: string, scope?: string): Promise<string> {
  const row = await loadEvent(accountId, id);
  await eventsCalendar(accountId, row.calendar_id);
  const key = cleanKey(occurrence);
  let left: Root | null = null;
  if (key !== null) {
    try {
      left = deleteFrom(parseCalendar(row.ics), key, cleanScope(scope), "UTC");
    } catch (err) {
      throw new CalendarError((err as Error).message, 404);
    }
  }
  if (left) {
    await state()
      .updateTable("events")
      .set({ ics: serialize(left), updated_at: Date.now(), ...indexed(left) })
      .where("account_id", "=", accountId)
      .where("id", "=", id)
      .execute();
  } else {
    await state().deleteFrom("events").where("account_id", "=", accountId).where("id", "=", id).execute();
  }
  changed(accountId);
  return remember(accountId, [row]);
}

// ---------------------------------------------------------------- import and export

export interface ImportResult {
  calendarId: number;
  added: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

/**
 * Adds the events in a calendar file (.ics) to a calendar, or to a new one named as the
 * file names its calendar. An event already there (the same UID) is replaced by the
 * file's, so importing the same file twice changes nothing.
 */
export async function importEvents(accountId: number, target: number | "new", text: string): Promise<ImportResult> {
  if (text.length > LIMITS.importBytes) throw new CalendarError("That file is too large: import at most 20 MB at a time.", 413);
  let file: ReturnType<typeof parseFile>;
  try {
    file = parseFile(text, PRODID);
  } catch (err) {
    throw new CalendarError(err instanceof CalendarError ? err.message : `That isn't a calendar file Viauna can read (${(err as Error).message}). Choose an .ics file.`);
  }
  if (!file.events.length) throw new CalendarError(file.skipped ? "That file has no events in it, only tasks or other entries." : "That file has no events in it.");
  if (file.events.length > LIMITS.importEvents) throw new CalendarError(`Import at most ${LIMITS.importEvents.toLocaleString("en")} events at a time.`);
  const calendarId = target === "new" ? (await createCalendar(accountId, { name: (file.name ?? "Imported").slice(0, LIMITS.name) || "Imported" })).id : (await eventsCalendar(accountId, target)).id;
  const result: ImportResult = { calendarId, added: 0, updated: 0, unchanged: 0, skipped: file.skipped };
  const now = Date.now();
  await state().transaction().execute(async (trx) => {
    for (const { uid, root } of file.events) {
      // A file's METHOD says how it was sent (an invitation, a published calendar); a
      // stored event has none (RFC 4791).
      root.removeAllProperties("method");
      const ics = serialize(root);
      let columns: ReturnType<typeof indexed>;
      try {
        if (ics.length > LIMITS.eventBytes) throw new Error("too large");
        columns = indexed(root);
      } catch {
        result.skipped++;
        continue;
      }
      const existing = await trx.selectFrom("events").select(["id", "ics"]).where("calendar_id", "=", calendarId).where("uid", "=", uid).executeTakeFirst();
      if (existing?.ics === ics) {
        result.unchanged++;
      } else if (existing) {
        await trx.updateTable("events").set({ ics, updated_at: now, ...columns }).where("id", "=", existing.id).execute();
        result.updated++;
      } else {
        await trx.insertInto("events").values({ account_id: accountId, calendar_id: calendarId, uid, ics, created_at: now, updated_at: now, ...columns }).execute();
        result.added++;
      }
    }
  });
  changed(accountId);
  return result;
}

/** A calendar's events as iCalendar objects: those kept, or for the Birthdays calendar, made from the contacts. */
async function calendarObjects(accountId: number, cal: { id: number; kind: CalendarKind }): Promise<Root[]> {
  if (cal.kind === "birthdays") return birthdayObjects(accountId, PRODID);
  const rows = await state().selectFrom("events").select("ics").where("account_id", "=", accountId).where("calendar_id", "=", cal.id).orderBy("start_at").execute();
  return rows.map((r) => parsed(r.ics)).filter((r): r is Root => r !== null);
}

/** A calendar as one file (.ics), for any calendar app, with the zones its events use. */
export async function exportCalendar(accountId: number, calendarId: number, zone: string): Promise<{ name: string; text: string }> {
  checkZone(zone);
  const cal = await ownCalendar(accountId, calendarId);
  return { name: cal.name, text: buildFile(cal.name, await calendarObjects(accountId, cal), PRODID, zone) };
}

// ---------------------------------------------------------------- secret addresses

const secretsOn = () => setting("calendar") && setting("calendarSecrets");

function cleanMode(input: unknown): SecretMode {
  if (input === "all" || input === "busy") return input;
  throw new CalendarError("Say whether the address shows the whole calendar or only when you're busy.");
}

/**
 * Gives a calendar a secret address, or a new one in place of the old, which stops working
 * at once. The token is returned this once: only its hash is kept, so it can't be shown
 * again, nor read from a copy of the database.
 */
export async function makeSecret(accountId: number, id: number, mode: unknown): Promise<{ token: string; calendar: CalendarInfo }> {
  if (!secretsOn()) throw new CalendarError("Secret addresses are turned off on this server.", 404);
  const m = cleanMode(mode);
  await ownCalendar(accountId, id);
  const token = randomToken(32);
  await state()
    .updateTable("calendars")
    .set({ secret_hash: sha256(token), secret_mode: m, secret_created_at: Date.now(), secret_fetched_at: null })
    .where("account_id", "=", accountId)
    .where("id", "=", id)
    .execute();
  changed(accountId);
  return { token, calendar: calendarJson(await ownCalendar(accountId, id)) };
}

/** Changes what a calendar's secret address shows; the address stays the same. */
export async function setSecretMode(accountId: number, id: number, mode: unknown): Promise<CalendarInfo> {
  if (!secretsOn()) throw new CalendarError("Secret addresses are turned off on this server.", 404);
  const m = cleanMode(mode);
  const cal = await ownCalendar(accountId, id);
  if (!cal.secret_mode) throw new CalendarError("This calendar has no secret address.");
  await state().updateTable("calendars").set({ secret_mode: m }).where("account_id", "=", accountId).where("id", "=", id).execute();
  changed(accountId);
  return calendarJson(await ownCalendar(accountId, id));
}

/** Turns a calendar's secret address off: it stops working at once. */
export async function dropSecret(accountId: number, id: number): Promise<CalendarInfo> {
  await ownCalendar(accountId, id);
  await state()
    .updateTable("calendars")
    .set({ secret_hash: null, secret_mode: null, secret_created_at: null, secret_fetched_at: null })
    .where("account_id", "=", accountId)
    .where("id", "=", id)
    .execute();
  changed(accountId);
  return calendarJson(await ownCalendar(accountId, id));
}

/**
 * The calendar a secret address names, as a file: everything, or "Busy" at the times of
 * the busy events. Null when it names none, the calendar is hidden, or secret addresses
 * (or the calendar) are off. Notes when it was fetched, at most once a minute.
 */
export async function secretCalendar(token: string): Promise<{ name: string; text: string } | null> {
  if (!secretsOn() || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const cal = await state()
    .selectFrom("calendars")
    .select(["id", "account_id", "name", "kind", "secret_mode", "secret_fetched_at"])
    .where("secret_hash", "=", sha256(token))
    .executeTakeFirst();
  if (!cal || !cal.secret_mode || !shown(cal.kind)) return null;
  const now = Date.now();
  if (!cal.secret_fetched_at || now - cal.secret_fetched_at > 60_000) {
    await state().updateTable("calendars").set({ secret_fetched_at: now }).where("id", "=", cal.id).execute();
  }
  const zone = (await getSettings(cal.account_id)).timeZone || "UTC";
  let roots = await calendarObjects(cal.account_id, cal);
  if (cal.secret_mode === "busy") roots = roots.map(busyOnly).filter((r): r is Root => r !== null);
  return { name: cal.name, text: buildFile(cal.name, roots, PRODID, zone) };
}

// ---------------------------------------------------------------- calendars from the web

/** A feed's file read, or why it can't be. */
function readFeed(text: string): ParsedFile {
  try {
    return parseFile(text, PRODID);
  } catch (err) {
    throw new FeedError(`That address doesn't give a calendar Viauna can read (${(err as Error).message}).`);
  }
}

/** A feed's events put in its calendar: the new added, the changed replaced, and those it no longer has deleted. */
async function storeFeed(accountId: number, calendarId: number, file: ParsedFile): Promise<boolean> {
  if (file.events.length > LIMITS.importEvents) throw new FeedError(`That calendar has over ${LIMITS.importEvents.toLocaleString("en")} events, more than Viauna keeps.`);
  const now = Date.now();
  let changes = 0;
  await state().transaction().execute(async (trx) => {
    const existing = new Map((await trx.selectFrom("events").select(["id", "uid", "ics"]).where("calendar_id", "=", calendarId).execute()).map((r) => [r.uid, r]));
    const kept = new Set<string>();
    for (const { uid, root } of file.events) {
      root.removeAllProperties("method");
      const ics = serialize(root);
      let columns: ReturnType<typeof indexed>;
      try {
        if (ics.length > LIMITS.eventBytes) continue;
        columns = indexed(root);
      } catch {
        continue;
      }
      kept.add(uid);
      // A calendar from the web sends no reminders: they're its owner's, not yours.
      Object.assign(columns, { alarm_at: null });
      const old = existing.get(uid);
      if (old?.ics === ics) continue;
      changes++;
      if (old) await trx.updateTable("events").set({ ics, updated_at: now, ...columns }).where("id", "=", old.id).execute();
      else await trx.insertInto("events").values({ account_id: accountId, calendar_id: calendarId, uid, ics, created_at: now, updated_at: now, ...columns }).execute();
    }
    const gone = [...existing.values()].filter((r) => !kept.has(r.uid)).map((r) => r.id);
    for (let i = 0; i < gone.length; i += 500) await trx.deleteFrom("events").where("id", "in", gone.slice(i, i + 500)).execute();
    changes += gone.length;
  });
  return changes > 0;
}

type FeedRow = { id: number; account_id: number; source_url: string | null; etag: string | null; last_modified: string | null };

/**
 * Fetches a feed calendar's address and keeps what comes back. On failure its events stay
 * as they were, and what went wrong is kept to show, to try again in an hour.
 */
async function fetchAndStore(row: FeedRow): Promise<{ changed: boolean; error: string | null }> {
  const now = Date.now();
  try {
    const got = await fetchFeed(row.source_url ?? "", { etag: row.etag, lastModified: row.last_modified });
    const changed = got.notModified ? false : await storeFeed(row.account_id, row.id, readFeed(got.text));
    await state()
      .updateTable("calendars")
      .set({ etag: got.etag, last_modified: got.lastModified, checked_at: now, fetched_at: now, fetch_error: null, next_fetch_at: now + FEED_LIMITS.refreshMs })
      .where("id", "=", row.id)
      .execute();
    return { changed, error: null };
  } catch (err) {
    const error = err instanceof FeedError || err instanceof CalendarError ? err.message : `Couldn't read the calendar (${(err as Error).message}).`;
    await state().updateTable("calendars").set({ checked_at: now, fetch_error: error, next_fetch_at: now + FEED_LIMITS.retryMs }).where("id", "=", row.id).execute();
    return { changed: false, error };
  }
}

/**
 * Adds a calendar from the web by its address: fetched at once, so a wrong address says
 * so now, and named as the file names itself unless a name is given.
 */
export async function subscribe(accountId: number, input: Record<string, unknown>): Promise<CalendarInfo> {
  const given = typeof input.url === "string" ? input.url.trim() : "";
  const url = feedUrl(given);
  const existing = await state().selectFrom("calendars").select(["name", "color", "position", "kind", "source_url"]).where("account_id", "=", accountId).execute();
  if (existing.length >= LIMITS.calendars) throw new CalendarError(`A mailbox can have at most ${LIMITS.calendars} calendars.`);
  const same = existing.find((c) => c.kind === "feed" && c.source_url && feedUrl(c.source_url) === url);
  if (same) throw new CalendarError(`That calendar is already here, as "${same.name}".`);
  const got = await fetchFeed(given);
  const file = readFeed(got.text);
  const name = cleanName(typeof input.name === "string" && input.name.trim() ? input.name : (file.name ?? new URL(url).hostname).slice(0, LIMITS.name));
  const color = input.color === undefined ? (COLORS.find((c) => !existing.some((e) => e.color === c)) ?? COLORS[0]) : cleanColor(input.color);
  const now = Date.now();
  await state()
    .insertInto("calendars")
    .values({
      account_id: accountId, name, color, position: Math.max(0, ...existing.map((e) => e.position)) + 1, primary_of: null, kind: "feed",
      source_url: given, etag: got.etag, last_modified: got.lastModified, checked_at: now, fetched_at: now, next_fetch_at: now + FEED_LIMITS.refreshMs,
      created_at: now, updated_at: now,
    })
    .execute();
  // MySQL has no RETURNING: the newest of this mailbox's calendars is the one just made.
  const row = await state().selectFrom("calendars").select([...CALENDAR_COLUMNS]).where("account_id", "=", accountId).orderBy("id", "desc").executeTakeFirstOrThrow();
  try {
    await storeFeed(accountId, row.id, file);
  } catch (err) {
    await state().deleteFrom("calendars").where("id", "=", row.id).execute();
    throw err;
  }
  changed(accountId);
  return calendarJson(row);
}

/** Refresh now: fetches a calendar from the web again, at most once a minute. */
export async function refreshFeed(accountId: number, id: number): Promise<CalendarInfo> {
  const row = await ownCalendar(accountId, id);
  if (row.kind !== "feed") throw new CalendarError("Only a calendar from the web can be fetched again.");
  if (row.checked_at && Date.now() - row.checked_at < FEED_LIMITS.manualMs) throw new CalendarError("It was fetched less than a minute ago. Try again in a moment.", 429);
  const full = await state().selectFrom("calendars").select(["id", "account_id", "source_url", "etag", "last_modified"]).where("id", "=", id).executeTakeFirstOrThrow();
  const result = await fetchAndStore(full);
  changed(accountId);
  if (result.error) throw new CalendarError(result.error);
  return calendarJson(await ownCalendar(accountId, id));
}

/**
 * Fetches the calendars from the web that are due, a few at a time. Each is claimed first
 * (its next fetch moved on, only if no one else has), so instances sharing a database
 * don't both fetch it.
 */
export async function refreshDueFeeds(limit = 10): Promise<number> {
  if (!setting("calendar") || !setting("calendarFeeds")) return 0;
  const now = Date.now();
  const due = await state()
    .selectFrom("calendars")
    .select(["id", "account_id", "source_url", "etag", "last_modified", "next_fetch_at"])
    .where("kind", "=", "feed")
    .where((eb) => eb.or([eb("next_fetch_at", "<=", now), eb("next_fetch_at", "is", null)]))
    .orderBy("next_fetch_at")
    .limit(limit)
    .execute();
  let fetched = 0;
  for (const row of due) {
    const claim = await state()
      .updateTable("calendars")
      .set({ next_fetch_at: now + FEED_LIMITS.retryMs })
      .where("id", "=", row.id)
      .where((eb) => (row.next_fetch_at === null ? eb("next_fetch_at", "is", null) : eb("next_fetch_at", "=", row.next_fetch_at)))
      .executeTakeFirst();
    if (!Number(claim.numUpdatedRows)) continue;
    const result = await fetchAndStore(row);
    if (result.changed) changed(row.account_id);
    fetched++;
  }
  return fetched;
}

/** Looks for calendars from the web to fetch every 5 minutes, while Viauna runs. */
export function startFeedRefresher(): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    refreshDueFeeds()
      .catch((err) => log.warn("fetching calendars from the web failed", { error: (err as Error).message }))
      .finally(() => (running = false));
  };
  const first = setTimeout(tick, 30_000);
  const timer = setInterval(tick, 5 * 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
