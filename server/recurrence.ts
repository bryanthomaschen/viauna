// How events repeat (RFC 5545: RRULE, RDATE, EXDATE, and occurrences changed on their
// own, each a VEVENT with a RECURRENCE-ID), and the changes Google Calendar offers on one
// occurrence: this event, this and following events, all events.
//
// Occurrences are worked out by ical.js as wall-clock times in the event's own zone, so a
// weekly 09:00 London meeting stays at 09:00 through the clock changes; each is then made
// an instant in that zone (icalendar.ts). ical.js knows no zones itself, so first the
// rule's end and the dates left out, written in UTC as RFC 5545 asks, are brought into the
// event's zone, or it would compare London's 09:00 with UTC's 08:00. An occurrence is
// named by its RECURRENCE-ID as written: "20261021T090000", "20261021", "20261021T010000Z".
import ICAL from "ical.js";
import { Temporal } from "temporal-polyfill";
import {
  type ApplyOptions,
  type Component,
  type EventFields,
  type Frame,
  type Moment,
  type Property,
  type Time,
  after,
  applyFieldsTo,
  applyPlain,
  eventTimes,
  frameOf,
  instantIn,
  isUtc,
  masterEvent,
  momentIn,
  msOf,
  msToWall,
  plainFields,
  timeWall,
  touch,
  wallToMs,
  writeTime,
  zoneFrame,
} from "./icalendar.ts";

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";
export const WEEKDAYS: Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** How an event repeats, as the editor offers it. */
export interface RepeatRule {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  /** Weekly: on these days, rather than the start's. */
  days?: Weekday[];
  /** Monthly: on the nth weekday (1 to 4, or -1 for the last), rather than the start's date. */
  nth?: { week: number; day: Weekday };
  /** The last date it can fall on, in the event's zone. */
  until?: string;
  /** How many times, in all. */
  count?: number;
  /** A rule another app wrote with parts Viauna doesn't edit, as written: kept unless replaced. */
  custom?: string;
}

export type Scope = "this" | "following" | "all";

export const LIMITS = { interval: 999, count: 9999, ruleText: 2000 };
/** Occurrences worked out at most, from the first: a daily event for 130 years. */
const MAX_OCCURRENCES = 50_000;
/** The end of a series that never ends, for indexing: the last time a JavaScript Date can hold. */
export const NEVER = 8_640_000_000_000_000;
const DAY = 86_400_000;

type Recur = InstanceType<typeof ICAL.Recur>;

const clone = (c: Component) => new ICAL.Component(JSON.parse(JSON.stringify(c.toJSON())));

export const isRecurring = (event: Component) => event.hasProperty("rrule") || event.hasProperty("rdate");

/** An occurrence's name: its RECURRENCE-ID as written. */
export const keyOf = (t: Time) => t.toICALString();

/** "20261021T090000" as the wall-clock time "2026-10-21T09:00:00", or "20261021" as a date. */
export function keyWall(key: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(key);
  if (!m) throw new Error(`Not an occurrence: ${key}`);
  return m[4] === undefined ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

/** The frame the series' own start is written in, which its occurrences are named in. */
const startFrame = (master: Component, root: Component): Frame => frameOf(master.getFirstProperty("dtstart")!, root);

const toTime = (wall: string, frame: Pick<Frame, "kind">): Time =>
  frame.kind === "date"
    ? ICAL.Time.fromDateString(wall.slice(0, 10))
    : ICAL.Time.fromData(
        (() => {
          const t = Temporal.PlainDateTime.from(wall);
          return { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second, isDate: false };
        })(),
        frame.kind === "utc" ? ICAL.Timezone.utcTimezone : undefined,
      );

/** A time written in one frame, as the same instant in another. */
function intoFrame(t: Time, from: Frame, to: Frame, reader: string): Time {
  if (to.kind === "date") return ICAL.Time.fromDateString(timeWall(t).slice(0, 10));
  if (t.isDate) return toTime(`${timeWall(t).slice(0, 10)}T00:00:00`, to);
  if (from.kind === to.kind && from.tzid === to.tzid) return t;
  const ms = from.kind === "floating" ? from.toMs(timeWall(t), reader) : momentToMs(momentIn(t, from), reader);
  return toTime(to.toWall(ms, reader), to);
}

const momentToMs = (m: Moment, reader: string) => (m.kind === "date" ? msOf(m) : instantIn(m, reader));

/** The changed occurrences of a series, by name. A RECURRENCE-ID in another zone is named in the series'. */
function overridesOf(root: Component, frame: Frame, reader: string): Map<string, Component> {
  const out = new Map<string, Component>();
  for (const e of root.getAllSubcomponents("vevent")) {
    const prop = e.getFirstProperty("recurrence-id");
    if (!prop) continue;
    const t = prop.getFirstValue() as Time;
    out.set(keyOf(intoFrame(t, frameOf(prop, root), frame, reader)), e);
  }
  return out;
}

/**
 * A copy of the series for ical.js to expand: the rule's end, and the dates left out or
 * added, written in the series' own frame, so that it compares like with like.
 */
function expansionCopy(master: Component, root: Component, frame: Frame, reader: string): Component {
  const copy = clone(master);
  for (const name of ["exdate", "rdate"]) {
    for (const prop of copy.getAllProperties(name)) {
      const from = frameOf(prop, root);
      const values = prop.getValues().filter((v): v is Time => !!v && typeof v === "object" && "isDate" in v);
      if (!values.length) continue;
      prop.removeParameter("tzid");
      prop.setValues(values.map((v) => intoFrame(v, from, frame, reader)));
    }
  }
  for (const prop of copy.getAllProperties("rrule")) {
    const recur = prop.getFirstValue() as Recur;
    if (recur.until) {
      const utc = recur.until.zone === ICAL.Timezone.utcTimezone;
      const fromFrame: Frame = recur.until.isDate ? frameOfKind("date") : utc ? frameOfKind("utc") : frame;
      recur.until = intoFrame(recur.until, fromFrame, frame, reader);
    }
  }
  return copy;
}

function frameOfKind(kind: "date" | "utc"): Frame {
  return kind === "utc" ? zoneFrame("UTC", null) : { kind: "date", toMs: (w) => msOf({ kind: "date", date: w.slice(0, 10) }), toWall: (ms) => `${new Date(ms).toISOString().slice(0, 10)}T00:00:00` };
}

export interface Occurrence {
  /** Null for an event that doesn't repeat. */
  key: string | null;
  /** The series, or the occurrence's own VEVENT if it was changed on its own. */
  event: Component;
  start: Moment;
  end: Moment;
}

/** What to look in: instants for timed events, and dates for all-day ones. */
export interface Window {
  fromMs: number;
  toMs: number;
  fromDate: string;
  toDate: string;
}

const EVERYTHING: Window = { fromMs: -NEVER, toMs: NEVER, fromDate: "0001-01-01", toDate: "9999-12-31" };

function overlaps(start: Moment, end: Moment, w: Window, reader: string): boolean {
  if (start.kind === "date") return start.date < w.toDate && (end.kind === "date" ? end.date : start.date) > w.fromDate;
  const s = instantIn(start, reader);
  const e = instantIn(end, reader);
  return s < w.toMs && (e > w.fromMs || (e === s && s >= w.fromMs));
}

function startsAfter(start: Moment, w: Window, reader: string): boolean {
  return start.kind === "date" ? start.date >= w.toDate : instantIn(start, reader) >= w.toMs;
}

/** How long each occurrence lasts: whole days for all-day events, else milliseconds. */
function lengthOf(times: { start: Moment; end: Moment }, reader: string): number {
  if (times.start.kind === "date" && times.end.kind === "date") return Temporal.PlainDate.from(times.start.date).until(times.end.date).days * DAY;
  return Math.max(0, instantIn(times.end, reader) - instantIn(times.start, reader));
}

/**
 * Walks a series' occurrences in order (changed ones as the rule has them), calling
 * `each` until it says stop. With `ruleOnly`, the dates left out are walked too: a rule's
 * COUNT counts them (RFC 5545 3.8.5.3).
 */
function walk(root: Component, reader: string, each: (key: string, start: Moment, end: Moment) => boolean | void, ruleOnly = false) {
  const master = masterEvent(root)!;
  const times = eventTimes(master, root)!;
  const frame = startFrame(master, root);
  const length = lengthOf(times, reader);
  const copy = expansionCopy(master, root, frame, reader);
  if (ruleOnly) copy.removeAllProperties("exdate");
  // A plain yearly rule falls on its start's day and month, and not at all in a year
  // without it (29 February), as RFC 5545 has it; ical.js would move it to 1 March.
  const rules = master.getAllProperties("rrule").map((p) => p.getFirstValue() as Recur);
  const first = master.getFirstPropertyValue("dtstart") as Time;
  const onlyOn = rules.length === 1 && rules[0].freq === "YEARLY" && !Object.values(rules[0].parts as Record<string, unknown[]>).some((v) => v?.length)
    ? `${String(first.month).padStart(2, "0")}-${String(first.day).padStart(2, "0")}`
    : null;
  const it = new ICAL.Event(copy).iterator();
  for (let n = 0, t: Time | undefined; n < MAX_OCCURRENCES && (t = it.next()); n++) {
    if (onlyOn && timeWall(t).slice(5, 10) !== onlyOn) continue;
    const start = momentIn(t, frame);
    if (each(keyOf(t), start, after(start, length)) === false) return;
  }
}

/** The occurrences of an event in a window, each with the VEVENT that describes it, in order. */
export function occurrences(root: Component, reader: string, w: Window = EVERYTHING): Occurrence[] {
  const master = masterEvent(root);
  const times = master && eventTimes(master, root);
  if (!master || !times) return [];
  if (!isRecurring(master)) return overlaps(times.start, times.end, w, reader) ? [{ key: null, event: master, ...times }] : [];
  const overrides = overridesOf(root, startFrame(master, root), reader);
  const out: Occurrence[] = [];
  walk(root, reader, (key, start, end) => {
    if (startsAfter(start, w, reader)) return false;
    if (!overrides.has(key) && overlaps(start, end, w, reader)) out.push({ key, event: master, start, end });
  });
  // Changed occurrences are where they now are, which may be outside the rule's own span.
  for (const [key, event] of overrides) {
    if (String(event.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") continue;
    const own = eventTimes(event, root);
    if (own && overlaps(own.start, own.end, w, reader)) out.push({ key, event, ...own });
  }
  return out.sort((a, b) => momentToMs(a.start, reader) - momentToMs(b.start, reader));
}

/** One occurrence by name, if the series has it; the series itself for null. */
export function occurrenceAt(root: Component, key: string | null, reader: string): Occurrence | null {
  const master = masterEvent(root);
  const times = master && eventTimes(master, root);
  if (!master || !times) return null;
  if (key === null || !isRecurring(master)) return { key: null, event: master, ...times };
  const override = overridesOf(root, startFrame(master, root), reader).get(key);
  if (override) {
    const own = eventTimes(override, root);
    return own ? { key, event: override, ...own } : null;
  }
  let found: Occurrence | null = null;
  const target = keyWall(key);
  walk(root, reader, (k, start, end) => {
    if (k === key) {
      found = { key, event: master, start, end };
      return false;
    }
    if (keyWall(k) > target) return false;
  });
  return found;
}

/** How many occurrences come before one (with `ruleOnly`, as the rule's COUNT counts them). */
function countBefore(root: Component, key: string, reader: string, ruleOnly = false): number {
  let n = 0;
  const target = keyWall(key);
  walk(
    root,
    reader,
    (k) => {
      if (keyWall(k) >= target) return false;
      n++;
    },
    ruleOnly,
  );
  return n;
}

/** The series' first occurrence, as the rule has it. */
function firstKey(root: Component, reader: string): string | null {
  let first: string | null = null;
  walk(root, reader, (k) => {
    first = k;
    return false;
  });
  return first;
}

/** The first and last moments of a series, for finding it by range: NEVER if it doesn't end. */
export function seriesSpan(root: Component, reader = "UTC"): { start: number; end: number } {
  const master = masterEvent(root)!;
  const times = eventTimes(master, root)!;
  let start = msOf(times.start);
  let end = msOf(times.end);
  if (isRecurring(master)) {
    const rules = master.getAllProperties("rrule").map((p) => p.getFirstValue() as Recur);
    if (rules.some((r) => !r.isFinite())) end = NEVER;
    else {
      let n = 0;
      walk(root, reader, (_k, s, e) => {
        end = Math.max(end, msOf(e));
        start = Math.min(start, msOf(s));
        n++;
      });
      if (n >= MAX_OCCURRENCES) end = NEVER;
    }
    for (const e of root.getAllSubcomponents("vevent")) {
      const own = e.hasProperty("recurrence-id") ? eventTimes(e, root) : null;
      if (own) {
        start = Math.min(start, msOf(own.start));
        end = Math.max(end, msOf(own.end));
      }
    }
  }
  return { start, end };
}

/** The occurrence to show for a series found by a search: the next one, or else the last. */
export function representative(root: Component, nowMs: number, reader: string): Occurrence | null {
  const master = masterEvent(root);
  const times = master && eventTimes(master, root);
  if (!master || !times) return null;
  if (!isRecurring(master)) return { key: null, event: master, ...times };
  let last: string | null = null;
  let next: string | null = null;
  walk(root, reader, (k, start) => {
    if (momentToMs(start, reader) >= nowMs) {
      next = k;
      return false;
    }
    last = k;
  });
  const key = next ?? last;
  return key ? occurrenceAt(root, key, reader) : null;
}

// ---------------------------------------------------------------- rules

const SUPPORTED: Record<RepeatRule["freq"], string> = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" };

/** How a series repeats, as the editor offers it; a rule beyond that comes back as `custom`. */
export function readRule(master: Component, root: Component, reader = "UTC"): RepeatRule | null {
  const rules = master.getAllProperties("rrule");
  if (!rules.length && !master.hasProperty("rdate")) return null;
  const text = rules.map((p) => (p.getFirstValue() as Recur).toString()).join("\n") || "RDATE";
  const custom = { freq: "daily" as const, interval: 1, custom: text };
  if (rules.length !== 1 || master.hasProperty("rdate") || master.hasProperty("exrule")) return custom;
  const r = rules[0].getFirstValue() as Recur;
  const freq = (Object.keys(SUPPORTED) as RepeatRule["freq"][]).find((f) => SUPPORTED[f] === r.freq);
  if (!freq) return custom;
  const start = eventTimes(master, root)!.start;
  const startWall = start.kind === "date" ? start.date : start.kind === "floating" ? start.wall : msToWall(start.ms, start.zone ?? "UTC");
  const startDate = Temporal.PlainDate.from(startWall.slice(0, 10));
  const parts = r.parts as Record<string, (string | number)[]>;
  const names = Object.keys(parts).filter((k) => parts[k]?.length);
  const rule: RepeatRule = { freq, interval: r.interval || 1 };
  const only = (...allowed: string[]) => names.every((n) => allowed.includes(n));
  if (freq === "daily" && !only()) return custom;
  if (freq === "weekly") {
    if (!only("BYDAY")) return custom;
    const days = (parts.BYDAY ?? []) as string[];
    if (days.some((d) => !WEEKDAYS.includes(d as Weekday))) return custom;
    if (days.length) rule.days = WEEKDAYS.filter((d) => days.includes(d));
  }
  if (freq === "monthly") {
    if (!only("BYDAY", "BYMONTHDAY")) return custom;
    const byDay = (parts.BYDAY ?? []) as string[];
    const byMonthDay = (parts.BYMONTHDAY ?? []) as number[];
    if (byDay.length && byMonthDay.length) return custom;
    if (byMonthDay.length && (byMonthDay.length > 1 || Number(byMonthDay[0]) !== startDate.day)) return custom;
    if (byDay.length) {
      const m = /^([+-]?\d)(MO|TU|WE|TH|FR|SA|SU)$/.exec(byDay.length === 1 ? byDay[0] : "");
      const week = m ? Number(m[1]) : 0;
      if (!m || !(week === -1 || (week >= 1 && week <= 4))) return custom;
      rule.nth = { week, day: m[2] as Weekday };
    }
  }
  if (freq === "yearly") {
    if (!only("BYMONTH", "BYMONTHDAY")) return custom;
    const months = (parts.BYMONTH ?? []) as number[];
    const days = (parts.BYMONTHDAY ?? []) as number[];
    if ((months.length && (months.length > 1 || Number(months[0]) !== startDate.month)) || (days.length && (days.length > 1 || Number(days[0]) !== startDate.day))) {
      return custom;
    }
  }
  if (r.count) rule.count = r.count;
  else if (r.until) {
    const frame = startFrame(master, root);
    const utc = r.until.zone === ICAL.Timezone.utcTimezone;
    const t = intoFrame(r.until, r.until.isDate ? frameOfKind("date") : utc ? frameOfKind("utc") : frame, frame, reader);
    rule.until = timeWall(t).slice(0, 10);
  }
  return rule;
}

/** Whether two rules say the same. */
export function sameRule(a: RepeatRule | null, b: RepeatRule | null): boolean {
  const norm = (r: RepeatRule | null) =>
    r && JSON.stringify([r.freq, r.interval || 1, r.days ?? [], r.nth ?? null, r.until ?? null, r.count ?? null, r.custom ?? null]);
  return norm(a) === norm(b);
}

/** The rule's end, as RFC 5545 has it: a date for all-day events, else the end of that day in UTC (or floating). */
function untilTime(date: string, frame: Frame): Time {
  if (frame.kind === "date") return ICAL.Time.fromDateString(date);
  const last = `${date}T23:59:59`;
  if (frame.kind === "floating") return toTime(last, frame);
  return ICAL.Time.fromJSDate(new Date(frame.toMs(last, "UTC")), true);
}

/** Replaces how a series repeats. A rule kept as `custom` is left as it was. */
export function writeRule(master: Component, root: Component, rule: RepeatRule | null) {
  const current = readRule(master, root);
  if (rule?.custom && current?.custom === rule.custom) return;
  for (const name of ["rrule", "rdate", "exrule"]) master.removeAllProperties(name);
  if (!rule) {
    master.removeAllProperties("exdate");
    return;
  }
  const frame = startFrame(master, root);
  const recur = ICAL.Recur.fromData({
    freq: SUPPORTED[rule.freq] as never,
    ...(rule.interval > 1 ? { interval: rule.interval } : {}),
    ...(rule.count ? { count: rule.count } : rule.until ? { until: untilTime(rule.until, frame) } : {}),
  });
  if (rule.freq === "weekly" && rule.days?.length) recur.setComponent("BYDAY", WEEKDAYS.filter((d) => rule.days!.includes(d)));
  if (rule.freq === "monthly" && rule.nth) recur.setComponent("BYDAY", [`${rule.nth.week}${rule.nth.day}`]);
  master.addPropertyWithValue("rrule", recur);
}

// ---------------------------------------------------------------- changing occurrences

/** Every VEVENT of the series but the master: the occurrences changed on their own. */
const overrideComponents = (root: Component) => root.getAllSubcomponents("vevent").filter((e) => e.hasProperty("recurrence-id"));

/** A changed occurrence of its own, made from the series for the occurrence `key`. */
function makeOverride(root: Component, master: Component, occ: Occurrence, frame: Frame): Component {
  const ov = clone(master);
  for (const name of ["rrule", "rdate", "exdate", "exrule", "recurrence-id"]) ov.removeAllProperties(name);
  const rid = ov.addPropertyWithValue("recurrence-id", ICAL.Time.fromDateString("1970-01-01"));
  writeTime(rid, keyWall(occ.key!), frame);
  const endFrame = frameOf(master.getFirstProperty("dtend") ?? master.getFirstProperty("dtstart")!, root);
  writeTime(ov.getFirstProperty("dtstart")!, keyWall(occ.key!), frame);
  const endWall = occ.end.kind === "date" ? occ.end.date : occ.end.kind === "floating" ? occ.end.wall : endFrame.toWall(occ.end.ms, "UTC");
  writeTime(ov.getFirstProperty("dtend") ?? ov.addPropertyWithValue("dtend", ICAL.Time.fromDateString("1970-01-01")), endWall, endFrame);
  ov.removeAllProperties("duration");
  root.addSubcomponent(ov);
  return ov;
}

/**
 * Moves a whole series the way one of its occurrences was moved: by as many days as its
 * date moved, to its new time of day, in its new zone (or all-day). The series' start, the
 * dates left out and the names of changed occurrences all move the same way, so they keep
 * matching; and a weekly or monthly rule's weekdays and dates move with them.
 */
function moveSeries(root: Component, master: Component, occ: Occurrence, fields: EventFields, opts: ApplyOptions, reader: string, keepRule: boolean) {
  const oldFrame = startFrame(master, root);
  // How long its occurrences were, before they're moved.
  const seriesLength = lengthOf(eventTimes(master, root)!, reader);
  const own = master.getFirstProperty("dtstart")!.getParameter("tzid");
  const ownZone = typeof own === "string" && oldFrame.zone ? own : null;
  const zone = fields.allDay ? null : opts.setZones || !ownZone || oldFrame.kind === "date" ? (fields.zone ?? reader) : ownZone;
  const newFrame: Frame = zone ? (isUtc(zone) ? zoneFrame("UTC", null) : zoneFrame(zone, root)) : frameOfKind("date");
  // The occurrence's new start, in the series' new frame.
  const startMs = fields.allDay ? 0 : wallToMs(fields.start, fields.zone ?? reader);
  const newWall = fields.allDay ? fields.start : newFrame.toWall(startMs, reader);
  const oldWall = keyWall(occ.key!);
  const days = Temporal.PlainDate.from(oldWall.slice(0, 10)).until(newWall.slice(0, 10)).days;
  const timeOfDay = fields.allDay ? "" : newWall.slice(10, 19);
  const move = (wall: string) => `${Temporal.PlainDate.from(wall.slice(0, 10)).add({ days })}${timeOfDay}`;

  // The series' start, and its end at the occurrence's new length.
  const startProp = master.getFirstProperty("dtstart")!;
  const masterStart = timeWall(intoFrame(startProp.getFirstValue() as Time, oldFrame, oldFrame, reader));
  const seriesStart = move(fields.allDay ? masterStart.slice(0, 10) : masterStart);
  writeTime(startProp, seriesStart, newFrame);
  const endZone = fields.allDay ? null : opts.setZones ? (fields.endZone ?? zone) : zone;
  if (fields.allDay) {
    const days2 = Temporal.PlainDate.from(fields.start).until(fields.end).days;
    const endProp = master.getFirstProperty("dtend") ?? master.addPropertyWithValue("dtend", ICAL.Time.fromDateString("1970-01-01"));
    writeTime(endProp, Temporal.PlainDate.from(seriesStart).add({ days: Math.max(1, days2) }).toString(), newFrame);
  } else {
    const length = wallToMs(fields.end, fields.endZone ?? fields.zone ?? reader) - startMs;
    const endFrame = isUtc(endZone!) ? zoneFrame("UTC", null) : zoneFrame(endZone!, root);
    const endMs = newFrame.toMs(seriesStart, reader) + length;
    const endProp = master.getFirstProperty("dtend") ?? master.addPropertyWithValue("dtend", ICAL.Time.fromDateString("1970-01-01"));
    writeTime(endProp, endFrame.toWall(endMs, reader), endFrame);
  }
  master.removeAllProperties("duration");

  // Dates left out, and the names of occurrences changed on their own.
  const moveProp = (prop: Property) => {
    const from = frameOf(prop, root);
    const values = prop.getValues().filter((v): v is Time => !!v && typeof v === "object" && "isDate" in v);
    prop.removeParameter("tzid");
    const moved = values.map((v) => toTime(move(timeWall(intoFrame(v, from, oldFrame, reader))), newFrame));
    if (prop.name === "recurrence-id") prop.setValue(moved[0]);
    else prop.setValues(moved);
    if (newFrame.kind === "zoned" && newFrame.tzid) prop.setParameter("tzid", newFrame.tzid);
  };
  master.getAllProperties("exdate").forEach(moveProp);
  for (const ov of overrideComponents(root)) {
    const rid = ov.getFirstProperty("recurrence-id")!;
    // An occurrence changed only in other ways (its title, say) is still at the series'
    // time, so it moves with the series; one moved on its own stays where it was put.
    const ridMs = momentToMs(momentIn(intoFrame(rid.getFirstValue() as Time, frameOf(rid, root), oldFrame, reader), oldFrame), reader);
    const own = eventTimes(ov, root);
    const atSeriesTime = own && momentToMs(own.start, reader) === ridMs && lengthOf(own, reader) === seriesLength;
    moveProp(rid);
    if (atSeriesTime) {
      const newStart = timeWall(rid.getFirstValue() as Time);
      writeTime(ov.getFirstProperty("dtstart")!, newStart, newFrame);
      const endProp = ov.getFirstProperty("dtend") ?? ov.addPropertyWithValue("dtend", ICAL.Time.fromDateString("1970-01-01"));
      if (fields.allDay) writeTime(endProp, Temporal.PlainDate.from(newStart.slice(0, 10)).add({ days: Math.max(1, Temporal.PlainDate.from(fields.start).until(fields.end).days) }).toString(), newFrame);
      else {
        const endFrame = isUtc(endZone!) ? zoneFrame("UTC", null) : zoneFrame(endZone!, root);
        writeTime(endProp, endFrame.toWall(newFrame.toMs(newStart, reader) + wallToMs(fields.end, fields.endZone ?? fields.zone ?? reader) - startMs, reader), endFrame);
      }
      ov.removeAllProperties("duration");
    }
  }

  if (!keepRule) return;
  // The same rule, moved: its weekdays by as many days, its date of the month, its end.
  for (const prop of master.getAllProperties("rrule")) {
    const r = prop.getFirstValue() as Recur;
    const shiftDay = (d: string) => {
      const m = /^([+-]?\d*)(MO|TU|WE|TH|FR|SA|SU)$/.exec(d);
      if (!m) return d;
      return `${m[1]}${WEEKDAYS[(WEEKDAYS.indexOf(m[2] as Weekday) + (days % 7) + 7) % 7]}`;
    };
    const parts = r.parts as Record<string, (string | number)[]>;
    if (parts.BYDAY?.length) r.setComponent("BYDAY", parts.BYDAY.map((d) => shiftDay(String(d))));
    if (parts.BYMONTHDAY?.length) r.setComponent("BYMONTHDAY", parts.BYMONTHDAY.map((d) => Number(d) + days).filter((d) => d >= 1 && d <= 31));
    if (r.until) {
      const until = timeWall(intoFrame(r.until, r.until.isDate ? frameOfKind("date") : r.until.zone === ICAL.Timezone.utcTimezone ? frameOfKind("utc") : oldFrame, oldFrame, reader));
      r.until = untilTime(Temporal.PlainDate.from(until.slice(0, 10)).add({ days }).toString(), newFrame);
    }
    prop.setValue(r);
  }
}

/** The plain fields changed on a series reach the occurrences that had the series' old value. */
function propagate(root: Component, before: ReturnType<typeof plainFields>, fields: EventFields) {
  for (const ov of overrideComponents(root)) {
    const theirs = plainFields(ov);
    const patch: Partial<ReturnType<typeof plainFields>> = {};
    for (const k of Object.keys(before) as (keyof typeof before)[]) {
      if (theirs[k] === before[k] && fields[k] !== before[k]) (patch as Record<string, unknown>)[k] = fields[k];
    }
    if (Object.keys(patch).length) {
      applyPlain(ov, patch);
      touch(ov, false);
    }
  }
}

/**
 * Ends a series before the occurrence `key`: its rule's end set to just before it (or its
 * count to those before it), and the dates left out and occurrences changed from it on,
 * removed. Returns how many occurrences were before it.
 */
function endBefore(root: Component, master: Component, key: string, reader: string): number {
  const frame = startFrame(master, root);
  const before = countBefore(root, key, reader, true);
  const cut = keyWall(key);
  const lastMoment = frame.kind === "date" ? Temporal.PlainDate.from(cut).subtract({ days: 1 }).toString() : null;
  for (const prop of master.getAllProperties("rrule")) {
    const r = prop.getFirstValue() as Recur;
    if (r.count) r.count = before;
    else if (lastMoment) r.until = ICAL.Time.fromDateString(lastMoment);
    else {
      const ms = frame.toMs(cut, reader) - 1000;
      r.until = frame.kind === "floating" ? toTime(frame.toWall(ms, reader), frame) : ICAL.Time.fromJSDate(new Date(ms), true);
    }
    prop.setValue(r);
  }
  const from = (prop: Property) => keyWall(keyOf(intoFrame(prop.getFirstValue() as Time, frameOf(prop, root), frame, reader))) >= cut;
  for (const prop of master.getAllProperties("exdate")) {
    const keep = prop.getValues().filter((v) => keyWall(keyOf(intoFrame(v as Time, frameOf(prop, root), frame, reader))) < cut);
    if (keep.length) prop.setValues(keep);
    else master.removeProperty(prop);
  }
  for (const ov of overrideComponents(root)) if (from(ov.getFirstProperty("recurrence-id")!)) root.removeSubcomponent(ov);
  return before;
}

/** The series from occurrence `key` on, as a new event of its own (named after the original, as Google does). */
function seriesFrom(original: Component, key: string, countBefore: number, reader: string): Component {
  const next = clone(original);
  const master = masterEvent(next)!;
  const frame = startFrame(master, next);
  const uid = `${String(master.getFirstPropertyValue("uid"))}_R${key.replace(/Z$/, "")}`;
  // Starts at the occurrence, as long as the series' occurrences.
  const length = lengthOf(eventTimes(master, next)!, reader);
  writeTime(master.getFirstProperty("dtstart")!, keyWall(key), frame);
  const endFrame = frameOf(master.getFirstProperty("dtend") ?? master.getFirstProperty("dtstart")!, next);
  const start = momentIn(toTime(keyWall(key), frame), frame);
  const end = after(start, length);
  const endWall = end.kind === "date" ? end.date : end.kind === "floating" ? end.wall : endFrame.toWall(end.ms, reader);
  if (master.hasProperty("dtend")) writeTime(master.getFirstProperty("dtend")!, endWall, endFrame);
  for (const prop of master.getAllProperties("rrule")) {
    const r = prop.getFirstValue() as Recur;
    if (r.count) {
      r.count = Math.max(1, r.count - countBefore);
      prop.setValue(r);
    }
  }
  const cut = keyWall(key);
  for (const prop of master.getAllProperties("exdate")) {
    const keep = prop.getValues().filter((v) => keyWall(keyOf(intoFrame(v as Time, frameOf(prop, next), frame, reader))) >= cut);
    if (keep.length) prop.setValues(keep);
    else master.removeProperty(prop);
  }
  for (const ov of overrideComponents(next)) {
    const rid = ov.getFirstProperty("recurrence-id")!;
    if (keyWall(keyOf(intoFrame(rid.getFirstValue() as Time, frameOf(rid, next), frame, reader))) < cut) next.removeSubcomponent(ov);
  }
  for (const e of next.getAllSubcomponents("vevent")) e.updatePropertyWithValue("uid", uid);
  master.updatePropertyWithValue("created", ICAL.Time.fromJSDate(new Date(), true));
  return next;
}

export interface Edited {
  /** The event, changed in place. */
  root: Component;
  /** For "this and following": the new series it was split into. */
  split: Component | null;
}

/**
 * Changes an event. For an event that repeats, `key` names the occurrence it was changed
 * from, and `scope` says what changes: that occurrence alone, it and the ones after (the
 * series split in two, as Google Calendar does), or all of them.
 */
export function editEvent(root: Component, key: string | null, scope: Scope, fields: EventFields, repeat: RepeatRule | null, reader: string, opts: ApplyOptions = {}): Edited {
  const master = masterEvent(root)!;
  if (!isRecurring(master)) {
    applyFieldsTo(master, root, fields, opts);
    if (repeat) writeRule(master, root, repeat);
    return { root, split: null };
  }
  // The series as a whole: changed from its first occurrence.
  if (key === null) {
    key = firstKey(root, reader);
    scope = "all";
    if (key === null) throw new Error("This event has no occurrences left.");
  }
  const occ = occurrenceAt(root, key, reader);
  if (!occ) throw new Error("That occurrence isn't part of this event.");
  const frame = startFrame(master, root);

  if (scope === "this") {
    const ov = occ.event === master ? makeOverride(root, master, occ, frame) : occ.event;
    applyFieldsTo(ov, root, fields, opts);
    return { root, split: null };
  }
  if (scope === "following" && countBefore(root, key, reader) > 0) {
    const unchanged = sameRule(repeat, readRule(master, root, reader));
    const next = seriesFrom(root, key, countBefore(root, key, reader, true), reader);
    endBefore(root, master, key, reader);
    touch(master, true);
    // The rule as it was carries on in the new series, with what's left of its count.
    const nextMaster = masterEvent(next)!;
    editEvent(next, key, "all", fields, unchanged ? readRule(nextMaster, next, reader) : repeat, reader, opts);
    return { root, split: next };
  }

  // All of them.
  const plainBefore = plainFields(master);
  const current = readRule(master, root, reader);
  if (!repeat) {
    // No longer repeating: the event becomes the occurrence it was changed from.
    writeRule(master, root, null);
    for (const ov of overrideComponents(root)) root.removeSubcomponent(ov);
    applyFieldsTo(master, root, fields, opts);
    return { root, split: null };
  }
  const occFields = { start: occ.start, end: occ.end };
  const moved = !sameTimes(occFields, fields, opts, reader);
  const keepRule = sameRule(repeat, current);
  if (moved) moveSeries(root, master, occ, fields, opts, reader, keepRule);
  applyPlain(master, fields);
  propagate(root, plainBefore, fields);
  if (!keepRule) writeRule(master, root, repeat);
  touch(master, moved || !keepRule);
  return { root, split: null };
}

/** Whether the fields keep an occurrence's times, zones aside unless they're being set. */
function sameTimes(occ: { start: Moment; end: Moment }, fields: EventFields, opts: ApplyOptions, reader: string): boolean {
  if (fields.allDay !== (occ.start.kind === "date")) return false;
  if (fields.allDay) return occ.start.kind === "date" && occ.end.kind === "date" && occ.start.date === fields.start && occ.end.date === fields.end;
  if (opts.setZones) {
    const zoneOf = (m: Moment) => (m.kind === "instant" ? (m.zone ?? "UTC") : null);
    const want = (z: string | null) => (z && isUtc(z) ? "UTC" : z);
    if (zoneOf(occ.start) !== want(fields.zone) || zoneOf(occ.end) !== want(fields.endZone ?? fields.zone)) return false;
  }
  return instantIn(occ.start, reader) === wallToMs(fields.start, fields.zone ?? reader) && instantIn(occ.end, reader) === wallToMs(fields.end, fields.endZone ?? fields.zone ?? reader);
}

/**
 * Deletes an event, or for one that repeats: the occurrence `key` alone (left out of the
 * series), it and the ones after (the series ended before it), or all. Returns the event
 * changed, or null when nothing of it is left.
 */
export function deleteFrom(root: Component, key: string | null, scope: Scope, reader: string): Component | null {
  const master = masterEvent(root)!;
  if (!isRecurring(master) || key === null || scope === "all") return null;
  if (!occurrenceAt(root, key, reader)) throw new Error("That occurrence isn't part of this event.");
  const frame = startFrame(master, root);
  if (scope === "following") {
    if (countBefore(root, key, reader) === 0) return null;
    endBefore(root, master, key, reader);
    touch(master, true);
    return root;
  }
  for (const ov of overrideComponents(root)) {
    const rid = ov.getFirstProperty("recurrence-id")!;
    if (keyOf(intoFrame(rid.getFirstValue() as Time, frameOf(rid, root), frame, reader)) === key) root.removeSubcomponent(ov);
  }
  const ex = master.addPropertyWithValue("exdate", ICAL.Time.fromDateString("1970-01-01"));
  writeTime(ex, keyWall(key), frame);
  touch(master, true);
  // Nothing left: a finite series with every occurrence left out.
  const remains = firstKey(root, reader) !== null || overrideComponents(root).length > 0;
  return remains ? root : null;
}
