// VTIMEZONE definitions for IANA time zones, for events that leave Viauna (an exported
// calendar, and later an invitation). RFC 5545 wants one for every TZID an object uses,
// and Outlook reads a time only through it. Built from the IANA database's own
// transitions (Temporal): each run of yearly changes that follow a pattern, the last
// Sunday of March at 01:00 UTC, say, becomes one observance with a yearly RRULE, open
// ended if it's still the rule; anything irregular is an observance of its own.
import ICAL from "ical.js";
import { Temporal } from "temporal-polyfill";
import { type Component, isUtc } from "./icalendar.ts";

interface Transition {
  ms: number;
  /** Offsets in seconds, before and after. */
  from: number;
  to: number;
  /** The wall-clock time it happens at, in the offset before it: how a VTIMEZONE says it. */
  wall: Temporal.PlainDateTime;
}

const offsetAt = (zone: string, ms: number) => Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).offsetNanoseconds / 1e9;

/**
 * The zone's changes of offset from the start of one year to the end of another: its
 * offset looked at every week, and each change found to the second between two looks.
 * (temporal-polyfill's getTimeZoneTransition misses changes that come close together,
 * Morocco's around Ramadan; no zone changes twice in a week.)
 */
function transitions(zone: string, fromYear: number, toYear: number): Transition[] {
  const out: Transition[] = [];
  const WEEK = 7 * 86_400_000;
  const start = Date.UTC(fromYear, 0, 1) - 86_400_000;
  const end = Date.UTC(toYear + 1, 0, 1) + 86_400_000;
  let at = start;
  let before = offsetAt(zone, at);
  while (at < end) {
    const next = Math.min(at + WEEK, end);
    const after = offsetAt(zone, next);
    if (after !== before) {
      let lo = at;
      let hi = next;
      while (hi - lo > 1000) {
        const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
        if (offsetAt(zone, mid) === before) lo = mid;
        else hi = mid;
      }
      out.push({ ms: hi, from: before, to: after, wall: Temporal.Instant.fromEpochMilliseconds(hi + before * 1000).toZonedDateTimeISO("UTC").toPlainDateTime() });
    }
    at = next;
    before = after;
  }
  return out.filter((t) => t.wall.year >= fromYear);
}

const DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/**
 * The ways a transition's date can be a yearly rule: its nth weekday, its last, its date,
 * or the first of its weekday on or after some day ("Sun>=2" in the IANA database, Chile's
 * rule), which RFC 5545 says as that weekday on one of the seven days from it.
 */
function patterns(t: Transition): string[] {
  const d = t.wall;
  const day = DAYS[d.dayOfWeek - 1];
  const out = [`BYMONTH=${d.month};BYDAY=${Math.ceil(d.day / 7)}${day}`, `BYMONTH=${d.month};BYMONTHDAY=${d.day}`];
  if (d.day + 7 > d.daysInMonth) out.push(`BYMONTH=${d.month};BYDAY=-1${day}`);
  for (let from = Math.max(1, d.day - 6); from <= d.day; from++) {
    out.push(`BYMONTH=${d.month};BYDAY=${day};BYMONTHDAY=${Array.from({ length: 7 }, (_, i) => from + i).join(",")}`);
  }
  return out;
}

/** Of the patterns a run of changes fits, the plainest: the last weekday, the nth, on or after a day, a date. */
function plainest(fits: string[]): string {
  return (
    fits.find((p) => p.includes("BYDAY=-1")) ??
    fits.find((p) => /BYDAY=\d/.test(p)) ??
    fits.filter((p) => /BYDAY=[A-Z]{2};BYMONTHDAY/.test(p)).pop() ??
    fits[0]
  );
}

const icalWall = (d: Temporal.PlainDateTime) => d.toString({ smallestUnit: "second" }).replace(/[-:]/g, "");
const icalUtc = (ms: number) => `${new Date(ms).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;

/** The zone's usual abbreviation at an instant ("EDT", "BST"), if English has one. */
function abbreviation(zone: string, ms: number): string | null {
  for (const locale of ["en-US", "en-GB", "en-AU"]) {
    const name = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "short" }).formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value;
    if (name && /^[A-Z]{2,6}$/.test(name)) return name;
  }
  return null;
}

/**
 * A VTIMEZONE for an IANA zone, right from the start of `fromYear` on. Its changes are
 * looked at 28 years beyond `toYear` (and today), long enough for every weekday to fall on
 * every date, so a pattern is the zone's rule and not a coincidence of the years asked
 * for (Chile's "first Sunday on or after the 2nd" is the first Sunday until 1 April is
 * one). A pattern still in use then is left open ended.
 */
export function vtimezone(zone: string, fromYear: number, toYear: number): Component {
  const key = `${zone}\0${fromYear}\0${toYear}`;
  let jcal = cache.get(key);
  if (!jcal) {
    jcal = build(zone, fromYear, toYear).toJSON() as unknown[];
    cache.set(key, jcal);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  return new ICAL.Component(JSON.parse(JSON.stringify(jcal)));
}

/** Built definitions, by zone and years: the IANA database doesn't change while Viauna runs. */
const cache = new Map<string, unknown[]>();

function build(zone: string, fromYear: number, toYear: number): Component {
  const horizon = Math.max(toYear, new Date().getUTCFullYear()) + 28;
  const tz = new ICAL.Component("vtimezone");
  tz.addPropertyWithValue("tzid", zone);
  tz.addPropertyWithValue("x-lic-location", zone);
  const startMs = Temporal.ZonedDateTime.from({ timeZone: zone, year: fromYear, month: 1, day: 1 }).epochMilliseconds;
  const list = isUtc(zone) ? [] : transitions(zone, fromYear, horizon);
  // Daylight is any offset above the least one seen: the zone's standard time.
  const standard = Math.min(offsetAt(zone, startMs), ...list.map((t) => t.to));
  const observance = (kind: "standard" | "daylight", start: string, from: number, to: number, at: number) => {
    const c = new ICAL.Component(kind);
    c.addPropertyWithValue("tzoffsetfrom", ICAL.UtcOffset.fromSeconds(from));
    c.addPropertyWithValue("tzoffsetto", ICAL.UtcOffset.fromSeconds(to));
    const name = abbreviation(zone, at);
    if (name) c.addPropertyWithValue("tzname", name);
    c.addPropertyWithValue("dtstart", ICAL.Time.fromDateTimeString(`${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}T${start.slice(9, 11)}:${start.slice(11, 13)}:${start.slice(13, 15)}`));
    tz.addSubcomponent(c);
    return c;
  };
  if (!list.length) {
    // No changes in the years asked for: one offset, from the start.
    const o = offsetAt(zone, startMs);
    observance("standard", `${fromYear}0101T000000`, o, o, startMs);
    return tz;
  }
  // The offset in force before the first change, from the start of the range.
  const first = list[0];
  observance(first.from > standard ? "daylight" : "standard", `${fromYear}0101T000000`, first.from, first.from, startMs);

  // Runs of the same change, a year apart, that fit a yearly pattern.
  type Run = { items: Transition[]; patterns: string[] };
  const runs: Run[] = [];
  const open = new Map<string, Run>();
  for (const t of list) {
    const key = `${t.from}/${t.to}/${t.wall.toPlainTime().toString()}`;
    const run = open.get(key);
    const last = run?.items[run.items.length - 1];
    const fits = run && last && t.wall.year === last.wall.year + 1 ? run.patterns.filter((p) => patterns(t).includes(p)) : [];
    if (run && fits.length) {
      run.items.push(t);
      run.patterns = fits;
    } else {
      const next = { items: [t], patterns: patterns(t) };
      runs.push(next);
      open.set(key, next);
    }
  }
  for (const run of runs) {
    const [head] = run.items;
    const tail = run.items[run.items.length - 1];
    const c = observance(head.to > standard ? "daylight" : "standard", icalWall(head.wall), head.from, head.to, head.ms);
    if (run.items.length < 2) continue;
    // Still the rule in the last year looked at: open ended. Otherwise it stopped (Iran
    // in 2022, Brazil in 2019).
    const ongoing = tail.wall.year >= horizon;
    const pattern = plainest(run.patterns);
    c.addPropertyWithValue("rrule", ICAL.Recur.fromString(`FREQ=YEARLY;${pattern}${ongoing ? "" : `;UNTIL=${icalUtc(tail.ms)}`}`));
  }
  return tz;
}
