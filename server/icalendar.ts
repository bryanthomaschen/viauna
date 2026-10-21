// Events as iCalendar (RFC 5545), read and written through ical.js without losing
// anything. An event is the iCalendar object for its UID, kept as it came; Viauna edits
// only the fields it shows (title, times, place, description, busy or free, colour, video
// link) and leaves the rest (another app's own properties, guests, alarms) as they were.
// Times stay the iCalendar way, a wall-clock time and the time zone it's in, and Temporal
// works out the instant.
//
// A time zone is written as its IANA name (TZID=Europe/London) with no VTIMEZONE, as
// Google's and Apple's servers accept; one Outlook sent with its own VTIMEZONE is read
// through that definition.
import ICAL from "ical.js";
import { Temporal } from "temporal-polyfill";

type Component = InstanceType<typeof ICAL.Component>;
type Property = InstanceType<typeof ICAL.Property>;
type Time = InstanceType<typeof ICAL.Time>;

/** Colours for calendars and events: CSS names, as RFC 7986's COLOR property takes them. */
export const COLORS = [
  "tomato", "palevioletred", "darkorange", "gold", "mediumseagreen", "seagreen",
  "dodgerblue", "royalblue", "slateblue", "darkorchid", "sienna", "dimgray",
] as const;

/** The fields Viauna shows and edits. */
export interface EventFields {
  title: string;
  allDay: boolean;
  /** A wall-clock time, "2026-10-21T09:00", in `zone`; or for an all-day event, a date. */
  start: string;
  /** Exclusive: an all-day event's is the day after its last. */
  end: string;
  /** The time zone a timed event's times are given in. */
  zone: string | null;
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

const isUtc = (zone: string) => /^(Etc\/)?(UTC|GMT|Zulu|UCT)$/i.test(zone);

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
const timeWall = (t: Time) => `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;
const timeDate = (t: Time) => `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;

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

/** Reads DTSTART or DTEND as a Moment: in its TZID's zone, UTC, a date, or floating. */
function momentOf(prop: Property, root: Component): Moment | null {
  const t = prop.getFirstValue() as Time | null;
  if (!t || typeof t !== "object" || !("isDate" in t)) return null;
  if (t.isDate) return { kind: "date", date: timeDate(t) };
  const wall = timeWall(t);
  if (t.zone === ICAL.Timezone.utcTimezone) return { kind: "instant", ms: wallAsUtc(wall), zone: null };
  const tzid = prop.getParameter("tzid");
  const zone = typeof tzid === "string" ? tzid : null;
  if (!zone) return { kind: "floating", wall };
  if (isZone(zone)) return { kind: "instant", ms: wallToMs(wall, zone), zone: isUtc(zone) ? null : zone };
  // Not a name Temporal knows (Outlook's "W. Europe Standard Time"): use the object's own
  // VTIMEZONE for it, and failing that, read the time as floating.
  const vtz = root.getAllSubcomponents("vtimezone").find((c) => c.getFirstPropertyValue("tzid") === zone);
  if (!vtz) return { kind: "floating", wall };
  const local = ICAL.Time.fromData({ year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second, isDate: false }, new ICAL.Timezone(vtz));
  return { kind: "instant", ms: local.toUnixTime() * 1000, zone: null };
}

/** The moment `ms` after another, in the same terms. */
function after(m: Moment, ms: number): Moment {
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

/** What Viauna shows of an event, with times in `zone`. */
export function readFields(root: Component, zone: string): EventFields | null {
  const event = masterEvent(root);
  const times = event && eventTimes(event, root);
  if (!event || !times) return null;
  const allDay = times.start.kind === "date";
  const color = text(event, "color").toLowerCase();
  return {
    title: text(event, "summary"),
    allDay,
    start: wallIn(times.start, zone),
    end: wallIn(times.end, zone),
    zone: allDay ? null : zone,
    location: text(event, "location"),
    description: text(event, "description"),
    busy: text(event, "transp").toUpperCase() !== "TRANSPARENT",
    color: color || null,
    video: (videoProperty(event)?.getFirstValue() as string | undefined) ?? null,
  };
}

/** The zone a timed event was written in, if it names one; null for all-day, UTC or floating. */
export function ownZone(root: Component): string | null {
  const event = masterEvent(root);
  const times = event && eventTimes(event, root);
  return times?.start.kind === "instant" ? times.start.zone : null;
}

const utcNow = () => ICAL.Time.fromJSDate(new Date(), true);

function setText(event: Component, name: string, value: string) {
  if (value) event.updatePropertyWithValue(name, value);
  else event.removeAllProperties(name);
}

function setTime(event: Component, name: "dtstart" | "dtend", value: string, allDay: boolean, zone: string) {
  if (allDay) {
    const p = event.updatePropertyWithValue(name, ICAL.Time.fromDateString(value));
    p.removeParameter("tzid");
    return;
  }
  const t = Temporal.PlainDateTime.from(value);
  const data = { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second, isDate: false };
  if (isUtc(zone)) {
    const p = event.updatePropertyWithValue(name, ICAL.Time.fromData(data, ICAL.Timezone.utcTimezone));
    p.removeParameter("tzid");
  } else {
    const p = event.updatePropertyWithValue(name, ICAL.Time.fromData(data));
    p.setParameter("tzid", zone);
  }
}

/**
 * Puts the times an event was given into it. A timed event keeps the zone it was written
 * in, if it has one: the page sends times in the reader's zone, and an event made for a
 * meeting in London should stay in London's time when someone in Singapore moves it.
 * Returns whether they changed.
 */
function applyTimes(event: Component, root: Component, fields: Pick<EventFields, "allDay" | "start" | "end" | "zone">): boolean {
  const before = eventTimes(event, root);
  const own = before?.start.kind === "instant" ? before.start.zone : null;
  let { start, end } = fields;
  let zone = fields.zone ?? "UTC";
  if (!fields.allDay && own && own !== zone) {
    start = msToWall(wallToMs(start, zone), own);
    end = msToWall(wallToMs(end, zone), own);
    zone = own;
  }
  if (before) {
    const same = (m: Moment, value: string) =>
      fields.allDay ? m.kind === "date" && m.date === value : m.kind !== "date" && instantIn(m, zone) === wallToMs(value, zone);
    if (same(before.start, start) && same(before.end, end)) return false;
  }
  setTime(event, "dtstart", start, fields.allDay, zone);
  setTime(event, "dtend", end, fields.allDay, zone);
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

/** Puts what the page sent into the event, leaving everything else as it was. */
export function applyFields(root: Component, fields: EventFields): Component {
  const event = masterEvent(root);
  if (!event) throw new Error("No event in this object.");
  const moved = applyTimes(event, root, fields);
  setText(event, "summary", fields.title);
  setText(event, "location", fields.location);
  setText(event, "description", fields.description);
  event.updatePropertyWithValue("transp", fields.busy ? "OPAQUE" : "TRANSPARENT");
  setText(event, "color", fields.color ?? "");
  applyVideo(event, fields.video);
  // A changed time is a new version of the event for anyone it was sent to (RFC 5546).
  if (moved && event.hasProperty("sequence")) event.updatePropertyWithValue("sequence", Number(event.getFirstPropertyValue("sequence") ?? 0) + 1);
  event.updatePropertyWithValue("dtstamp", utcNow());
  event.updatePropertyWithValue("last-modified", utcNow());
  return root;
}

/** A new event, as a whole iCalendar object. */
export function newEvent(fields: EventFields, uid: string, prodid: string): Component {
  const root = new ICAL.Component(["vcalendar", [], []]);
  root.updatePropertyWithValue("version", "2.0");
  root.updatePropertyWithValue("prodid", prodid);
  const event = new ICAL.Component("vevent", root);
  root.addSubcomponent(event);
  event.updatePropertyWithValue("uid", uid);
  event.updatePropertyWithValue("dtstamp", utcNow());
  event.updatePropertyWithValue("created", utcNow());
  applyFields(root, fields);
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
