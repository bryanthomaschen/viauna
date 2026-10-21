// Events as iCalendar (RFC 5545), read and written through ical.js without losing
// anything. An event is the iCalendar object for its UID, kept as it came; Viauna edits
// only the fields it shows (title, times, place, description, busy or free, colour, video
// link, how it repeats) and leaves the rest (another app's own properties, guests,
// alarms) as they were. Times stay the iCalendar way, a wall-clock time and the time zone
// it's in, and Temporal works out the instant. How an event repeats is recurrence.ts.
//
// A time zone is written as its IANA name (TZID=Europe/London) with no VTIMEZONE, as
// Google's and Apple's servers accept; one Outlook sent with its own VTIMEZONE is read
// through that definition.
import ICAL from "ical.js";
import { Temporal } from "temporal-polyfill";

export type Component = InstanceType<typeof ICAL.Component>;
export type Property = InstanceType<typeof ICAL.Property>;
export type Time = InstanceType<typeof ICAL.Time>;

/** Colours for calendars and events: CSS names, as RFC 7986's COLOR property takes them. */
export const COLORS = [
  "tomato", "palevioletred", "darkorange", "gold", "mediumseagreen", "seagreen",
  "dodgerblue", "royalblue", "slateblue", "darkorchid", "sienna", "dimgray",
] as const;

/** The fields Viauna shows and edits, but for how it repeats (recurrence.ts). */
export interface EventFields {
  title: string;
  allDay: boolean;
  /** A wall-clock time, "2026-10-21T09:00", in `zone`; or for an all-day event, a date. */
  start: string;
  /** In `endZone`, or `zone` if that's null. Exclusive: an all-day event's is the day after its last. */
  end: string;
  /** The time zone a timed event's start is given in. */
  zone: string | null;
  /** The zone its end is given in, when that's another (a flight). */
  endZone: string | null;
  location: string;
  description: string;
  busy: boolean;
  color: string | null;
  video: string | null;
}

/** When something happens, as the event says it. */
export type Moment =
  | { kind: "date"; date: string }
  | { kind: "instant"; ms: number; zone: string | null }
  | { kind: "floating"; wall: string };

export interface EventTimes {
  start: Moment;
  end: Moment;
}

const DAY = 86_400_000;
export const WALL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A named time zone Temporal knows ("Europe/London", "UTC"), not an offset like "+08:00". */
export function isZone(name: unknown): name is string {
  if (typeof name !== "string" || !/^[A-Za-z]/.test(name) || name.length > 64) return false;
  try {
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(name);
    return true;
  } catch {
    return false;
  }
}

export const isUtc = (zone: string) => /^(Etc\/)?(UTC|GMT|Zulu|UCT)$/i.test(zone);

/** A wall-clock time in a zone, as an instant (a time skipped by a clock change moves forward). */
export function wallToMs(wall: string, zone: string): number {
  return Temporal.PlainDateTime.from(wall, { overflow: "reject" }).toZonedDateTime(zone, { disambiguation: "compatible" }).epochMilliseconds;
}

/** An instant as the wall-clock time in a zone, to the minute: "2026-10-21T09:00". */
export function msToWall(ms: number, zone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).toPlainDateTime().toString({ smallestUnit: "minute" });
}

/** A date read as UTC midnight: how all-day and floating times are indexed. */
const dateAsUtc = (date: string) => Temporal.PlainDate.from(date, { overflow: "reject" }).toZonedDateTime("UTC").epochMilliseconds;
const wallAsUtc = (wall: string) => wallToMs(wall, "UTC");

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const timeWall = (t: Time) => `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;
export const timeDate = (t: Time) => `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;

/** Parses one iCalendar object; throws on something that isn't one. */
export function parseCalendar(text: string): Component {
  const root = new ICAL.Component(ICAL.parse(text));
  if (root.name !== "vcalendar") throw new Error("Not an iCalendar object.");
  return root;
}

/** The event itself, not a changed occurrence of it (which has a RECURRENCE-ID). */
export function masterEvent(root: Component): Component | null {
  const events = root.getAllSubcomponents("vevent");
  return events.find((e) => !e.hasProperty("recurrence-id")) ?? events[0] ?? null;
}

// ---------------------------------------------------------------- frames

/**
 * How one time property's wall-clock times become instants, and back: a date; UTC; a
 * named zone (IANA, or one the object defines with a VTIMEZONE); or floating, which is
 * that time wherever the reader is.
 */
export interface Frame {
  kind: "date" | "utc" | "zoned" | "floating";
  /** For zoned: the TZID as written. */
  tzid?: string;
  /** For zoned with an IANA name. */
  zone?: string;
  toMs(wall: string, readerZone: string): number;
  /** "2026-10-21T09:00:00" */
  toWall(ms: number, readerZone: string): string;
}

const wallSeconds = (ms: number, zone: string) =>
  Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).toPlainDateTime().toString({ smallestUnit: "second" });

const fromWall = (wall: string) => {
  const t = Temporal.PlainDateTime.from(wall);
  return { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second, isDate: false };
};

const DATE_FRAME: Frame = {
  kind: "date",
  toMs: (wall) => dateAsUtc(wall.slice(0, 10)),
  toWall: (ms) => `${wallSeconds(ms, "UTC").slice(0, 10)}T00:00:00`,
};
const UTC_FRAME: Frame = { kind: "utc", toMs: (wall) => wallAsUtc(wall), toWall: (ms) => wallSeconds(ms, "UTC") };
const FLOATING_FRAME: Frame = { kind: "floating", toMs: (wall, reader) => wallToMs(wall, reader), toWall: (ms, reader) => wallSeconds(ms, reader) };

/** The frame of a named zone: IANA through Temporal, or the object's own VTIMEZONE. */
export function zoneFrame(tzid: string, root: Component | null): Frame {
  if (isZone(tzid)) {
    if (isUtc(tzid)) return UTC_FRAME;
    return { kind: "zoned", tzid, zone: tzid, toMs: (wall) => wallToMs(wall, tzid), toWall: (ms) => wallSeconds(ms, tzid) };
  }
  // Not a name Temporal knows (Outlook's "W. Europe Standard Time"): the object's own
  // definition of it, and failing that, floating.
  const vtz = root?.getAllSubcomponents("vtimezone").find((c) => c.getFirstPropertyValue("tzid") === tzid);
  if (!vtz) return FLOATING_FRAME;
  const tz = new ICAL.Timezone(vtz);
  return {
    kind: "zoned",
    tzid,
    toMs: (wall) => ICAL.Time.fromData(fromWall(wall), tz).toUnixTime() * 1000,
    toWall: (ms) => timeWall(ICAL.Time.fromJSDate(new Date(ms), true).convertToZone(tz)),
  };
}

/** The frame a time property is written in. */
export function frameOf(prop: Property, root: Component | null): Frame {
  const t = prop.getFirstValue() as Time | null;
  if (t && typeof t === "object" && "isDate" in t) {
    if (t.isDate) return DATE_FRAME;
    if (t.zone === ICAL.Timezone.utcTimezone) return UTC_FRAME;
  }
  const tzid = prop.getParameter("tzid");
  return typeof tzid === "string" && tzid ? zoneFrame(tzid, root) : FLOATING_FRAME;
}

/** A time property's value as a Moment. */
export function momentOf(prop: Property, root: Component | null): Moment | null {
  const t = prop.getFirstValue() as Time | null;
  if (!t || typeof t !== "object" || !("isDate" in t)) return null;
  return momentIn(t, frameOf(prop, root));
}

/** A time, read in a frame. */
export function momentIn(t: Time, frame: Frame): Moment {
  if (t.isDate || frame.kind === "date") return { kind: "date", date: timeDate(t) };
  const wall = timeWall(t);
  if (frame.kind === "floating") return { kind: "floating", wall };
  if (frame.kind === "utc") return { kind: "instant", ms: wallAsUtc(wall), zone: null };
  return { kind: "instant", ms: frame.toMs(wall, "UTC"), zone: frame.zone ?? null };
}

/** The moment `ms` after another, in the same terms. */
export function after(m: Moment, ms: number): Moment {
  if (m.kind === "instant") return { ...m, ms: m.ms + ms };
  if (m.kind === "date") return { kind: "date", date: Temporal.PlainDate.from(m.date).add({ days: Math.max(1, Math.round(ms / DAY)) }).toString() };
  return { kind: "floating", wall: Temporal.PlainDateTime.from(m.wall).add({ milliseconds: ms }).toString({ smallestUnit: "second" }) };
}

/**
 * When an event starts and ends. DTEND, or DTSTART plus DURATION; with neither, an
 * all-day event lasts its day and a timed one is a moment (RFC 5545 3.6.1).
 */
export function eventTimes(event: Component, root: Component): EventTimes | null {
  const startProp = event.getFirstProperty("dtstart");
  const start = startProp ? momentOf(startProp, root) : null;
  if (!start) return null;
  const endProp = event.getFirstProperty("dtend");
  let end = endProp ? momentOf(endProp, root) : null;
  if (!end) {
    const duration = event.getFirstPropertyValue("duration") as InstanceType<typeof ICAL.Duration> | null;
    const ms = duration && typeof duration === "object" && "toSeconds" in duration ? duration.toSeconds() * 1000 : start.kind === "date" ? DAY : 0;
    end = after(start, Math.max(0, ms));
  }
  // An end before the start (or of another kind) is read as no end at all.
  if (end.kind !== start.kind || msOf(end) < msOf(start)) end = after(start, start.kind === "date" ? DAY : 0);
  return { start, end };
}

/** For indexing: UTC milliseconds, with all-day and floating times read as UTC. */
export function msOf(m: Moment): number {
  if (m.kind === "instant") return m.ms;
  return m.kind === "date" ? dateAsUtc(m.date) : wallAsUtc(m.wall);
}

/** An instant for a timed Moment, with floating times taken in `zone`. */
export function instantIn(m: Moment, zone: string): number {
  if (m.kind === "instant") return m.ms;
  if (m.kind === "floating") return wallToMs(m.wall, zone);
  return wallToMs(`${m.date}T00:00`, zone);
}

/** A Moment as the page edits it: a date, or the wall-clock time in `zone`. */
export function wallIn(m: Moment, zone: string): string {
  if (m.kind === "date") return m.date;
  if (m.kind === "floating") return m.wall.slice(0, 16);
  return msToWall(m.ms, zone);
}

// ---------------------------------------------------------------- reading fields

const text = (event: Component, name: string): string => {
  const v = event.getFirstPropertyValue(name);
  return typeof v === "string" ? v : "";
};

// The video link: RFC 7986's CONFERENCE first, then what Google and Teams write instead.
const VIDEO_PROPS = ["conference", "x-google-conference", "x-microsoft-skypeteamsmeetingurl", "x-microsoft-onlinemeetingconflink"];

function videoProperty(event: Component): Property | null {
  for (const name of VIDEO_PROPS) {
    const found = event.getAllProperties(name).find((p) => /^https?:\/\//i.test(String(p.getFirstValue() ?? "")));
    if (found) return found;
  }
  return null;
}

/** What Viauna shows of one event (the series, or one occurrence of it) at the given times, in `zone`. */
export function fieldsOf(event: Component, times: EventTimes, zone: string): EventFields {
  const allDay = times.start.kind === "date";
  const color = text(event, "color").toLowerCase();
  return {
    title: text(event, "summary"),
    allDay,
    start: wallIn(times.start, zone),
    end: wallIn(times.end, zone),
    zone: allDay ? null : zone,
    endZone: null,
    location: text(event, "location"),
    description: text(event, "description"),
    busy: text(event, "transp").toUpperCase() !== "TRANSPARENT",
    color: color || null,
    video: (videoProperty(event)?.getFirstValue() as string | undefined) ?? null,
  };
}

/** What Viauna shows of an event, with times in `zone`. */
export function readFields(root: Component, zone: string): EventFields | null {
  const event = masterEvent(root);
  const times = event && eventTimes(event, root);
  return event && times ? fieldsOf(event, times, zone) : null;
}

/** The zones an event's start and end were written in, if they name ones; null for all-day, UTC or floating. */
export function ownZones(event: Component, root: Component): { start: string | null; end: string | null } {
  const times = eventTimes(event, root);
  const start = times?.start.kind === "instant" ? times.start.zone : null;
  const end = times?.end.kind === "instant" ? times.end.zone : null;
  return { start, end: end ?? start };
}

/** The zone a timed event was written in, if it names one. */
export function ownZone(root: Component): string | null {
  const event = masterEvent(root);
  return event ? ownZones(event, root).start : null;
}

// ---------------------------------------------------------------- writing fields

const utcNow = () => ICAL.Time.fromJSDate(new Date(), true);

function setText(event: Component, name: string, value: string) {
  if (value) event.updatePropertyWithValue(name, value);
  else event.removeAllProperties(name);
}

/**
 * Writes a time into a property: a date, a UTC time, or a wall-clock time in a zone or
 * floating. Replaces the property's value, keeps its other parameters.
 */
export function writeTime(prop: Property, value: string, frame: Pick<Frame, "kind" | "tzid">) {
  prop.removeParameter("tzid");
  if (frame.kind === "date") {
    prop.setValue(ICAL.Time.fromDateString(value.slice(0, 10)));
  } else if (frame.kind === "utc") {
    prop.setValue(ICAL.Time.fromData(fromWall(value), ICAL.Timezone.utcTimezone));
  } else {
    prop.setValue(ICAL.Time.fromData(fromWall(value)));
    if (frame.kind === "zoned" && frame.tzid) prop.setParameter("tzid", frame.tzid);
  }
}

/** The frame for a time Viauna writes in a zone: UTC as UTC, any other as its TZID. */
export const frameForZone = (zone: string): Pick<Frame, "kind" | "tzid"> => (isUtc(zone) ? { kind: "utc" } : { kind: "zoned", tzid: zone });

function setTime(event: Component, name: "dtstart" | "dtend", value: string, frame: Pick<Frame, "kind" | "tzid">) {
  const prop = event.getFirstProperty(name) ?? event.addPropertyWithValue(name, ICAL.Time.fromDateString("1970-01-01"));
  writeTime(prop, value, frame);
}

export interface ApplyOptions {
  /** The fields name the zones to write the times in (the editor's zone choice). Otherwise a timed event keeps the zones it has. */
  setZones?: boolean;
}

/**
 * Puts the times an event was given into it. Unless told to set its zones, a timed event
 * keeps the zones it was written in: the page sends times in the reader's zone, and an
 * event made for a meeting in London should stay in London's time when someone in
 * Singapore moves it. Returns whether they changed.
 */
function applyTimes(event: Component, root: Component, fields: EventFields, opts: ApplyOptions): boolean {
  const before = eventTimes(event, root);
  if (fields.allDay) {
    if (before?.start.kind === "date" && before.start.date === fields.start && before.end.kind === "date" && before.end.date === fields.end) return false;
    setTime(event, "dtstart", fields.start, { kind: "date" });
    setTime(event, "dtend", fields.end, { kind: "date" });
    event.removeAllProperties("duration");
    return true;
  }
  const given = { start: fields.zone ?? "UTC", end: fields.endZone ?? fields.zone ?? "UTC" };
  const startMs = wallToMs(fields.start, given.start);
  const endMs = wallToMs(fields.end, given.end);
  const own = ownZones(event, root);
  const target = opts.setZones ? given : { start: own.start ?? given.start, end: own.end ?? own.start ?? given.end };
  if (before && before.start.kind !== "date" && instantIn(before.start, given.start) === startMs && instantIn(before.end, given.end) === endMs) {
    const sameZones = !opts.setZones || (own.start === (isUtc(given.start) ? null : given.start) && own.end === (isUtc(given.end) ? null : given.end));
    if (sameZones) return false;
  }
  setTime(event, "dtstart", msToWall(startMs, target.start), frameForZone(target.start));
  setTime(event, "dtend", msToWall(endMs, target.end), frameForZone(target.end));
  event.removeAllProperties("duration");
  return true;
}

function applyVideo(event: Component, url: string | null) {
  const current = videoProperty(event);
  if ((current?.getFirstValue() ?? null) === url) return;
  if (current) event.removeProperty(current);
  if (!url) return;
  const p = new ICAL.Property("conference", event);
  p.resetType("uri");
  p.setValue(url);
  p.setParameter("feature", "VIDEO");
  p.setParameter("label", "Video call");
  event.addProperty(p);
}

/** The fields other than times, as they are in an event. */
export function plainFields(event: Component) {
  return {
    title: text(event, "summary"),
    location: text(event, "location"),
    description: text(event, "description"),
    busy: text(event, "transp").toUpperCase() !== "TRANSPARENT",
    color: text(event, "color").toLowerCase() || null,
    video: (videoProperty(event)?.getFirstValue() as string | undefined) ?? null,
  };
}

/** Puts the fields other than times into an event. */
export function applyPlain(event: Component, fields: Partial<ReturnType<typeof plainFields>>) {
  if (fields.title !== undefined) setText(event, "summary", fields.title);
  if (fields.location !== undefined) setText(event, "location", fields.location);
  if (fields.description !== undefined) setText(event, "description", fields.description);
  if (fields.busy !== undefined) event.updatePropertyWithValue("transp", fields.busy ? "OPAQUE" : "TRANSPARENT");
  if (fields.color !== undefined) setText(event, "color", fields.color ?? "");
  if (fields.video !== undefined) applyVideo(event, fields.video);
}

/** Marks an event as changed now, and as a new version if its time changed (RFC 5546). */
export function touch(event: Component, moved: boolean) {
  if (moved && event.hasProperty("sequence")) event.updatePropertyWithValue("sequence", Number(event.getFirstPropertyValue("sequence") ?? 0) + 1);
  event.updatePropertyWithValue("dtstamp", utcNow());
  event.updatePropertyWithValue("last-modified", utcNow());
}

/** Puts what the page sent into one event (the series, or one occurrence), leaving everything else as it was. */
export function applyFieldsTo(event: Component, root: Component, fields: EventFields, opts: ApplyOptions = {}): Component {
  const moved = applyTimes(event, root, fields, opts);
  applyPlain(event, fields);
  touch(event, moved);
  return event;
}

/** Puts what the page sent into the event, leaving everything else as it was. */
export function applyFields(root: Component, fields: EventFields, opts: ApplyOptions = {}): Component {
  const event = masterEvent(root);
  if (!event) throw new Error("No event in this object.");
  applyFieldsTo(event, root, fields, opts);
  return root;
}

/** A new event, as a whole iCalendar object, with its times in the zones the fields name. */
export function newEvent(fields: EventFields, uid: string, prodid: string): Component {
  const root = new ICAL.Component(["vcalendar", [], []]);
  root.updatePropertyWithValue("version", "2.0");
  root.updatePropertyWithValue("prodid", prodid);
  const event = new ICAL.Component("vevent", root);
  root.addSubcomponent(event);
  event.updatePropertyWithValue("uid", uid);
  event.updatePropertyWithValue("dtstamp", utcNow());
  event.updatePropertyWithValue("created", utcNow());
  applyFieldsTo(event, root, fields, { setZones: true });
  // After its first times, which aren't a change.
  event.updatePropertyWithValue("sequence", 0);
  return root;
}

export function eventUid(root: Component): string | null {
  const uid = masterEvent(root)?.getFirstPropertyValue("uid");
  return typeof uid === "string" && uid ? uid : null;
}

export function serialize(root: Component): string {
  return root.toString() + "\r\n";
}
