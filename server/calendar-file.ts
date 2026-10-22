// Calendar files (.ics, RFC 5545): one split into its events, to import; and a calendar
// put into one, to export. An event in a file is every VEVENT with its UID (the event and
// the occurrences changed on their own), kept as it came, with the VTIMEZONEs it names.
// An export has a VTIMEZONE for every zone its events use: built from the IANA database
// for named zones (vtimezone.ts), the one the event came with for another app's own.
import crypto from "node:crypto";
import ICAL from "ical.js";
import { type Component, eventTimes, isUtc, isZone, masterEvent } from "./icalendar.ts";
import { vtimezone } from "./vtimezone.ts";

export interface ParsedFile {
  /** The calendar's name, if the file gives one (X-WR-CALNAME, as Google's and Apple's do). */
  name: string | null;
  /** One iCalendar object per event. */
  events: { uid: string; root: Component }[];
  /** What wasn't an event Viauna can read: tasks, journal entries, events without a start. */
  skipped: number;
}

/** The TZIDs a component's properties name. */
function tzidsOf(c: Component, into = new Set<string>()): Set<string> {
  for (const p of c.getAllProperties()) {
    const tzid = p.getParameter("tzid");
    if (typeof tzid === "string" && tzid) into.add(tzid);
  }
  return into;
}

const clone = (c: Component) => new ICAL.Component(JSON.parse(JSON.stringify(c.toJSON())));

/** Splits a calendar file into its events, each a whole iCalendar object. Throws on something that isn't one. */
export function parseFile(text: string, prodid: string): ParsedFile {
  // A byte-order mark, which Windows apps sometimes start a file with, isn't part of it.
  const parsed = ICAL.parse(text.replace(/^\uFEFF/, "")) as unknown[];
  const jcals = (Array.isArray(parsed[0]) ? parsed : [parsed]) as unknown[][];
  const roots = jcals.map((j) => new ICAL.Component(j)).filter((c) => c.name === "vcalendar");
  if (!roots.length) throw new Error("That file has no calendar in it. Choose an .ics file.");
  let name: string | null = null;
  let skipped = 0;
  const groups = new Map<string, { root: Component; events: Component[] }>();
  for (const root of roots) {
    name ??= (root.getFirstPropertyValue("x-wr-calname") as string | null) || null;
    for (const c of root.getAllSubcomponents()) {
      if (c.name === "vtimezone") continue;
      if (c.name !== "vevent") {
        skipped++;
        continue;
      }
      let uid = String(c.getFirstPropertyValue("uid") ?? "");
      if (!uid || uid.length > 255) {
        // No UID (or one too long to keep): one from its content, so importing it twice adds it once.
        uid = `urn:sha256:${crypto.createHash("sha256").update(c.toString()).digest("hex")}`;
        c.updatePropertyWithValue("uid", uid);
      }
      const group = groups.get(uid) ?? { root, events: [] };
      group.events.push(c);
      groups.set(uid, group);
    }
  }
  const events: ParsedFile["events"] = [];
  for (const [uid, { root, events: parts }] of groups) {
    const obj = new ICAL.Component(["vcalendar", [], []]);
    obj.updatePropertyWithValue("version", "2.0");
    obj.updatePropertyWithValue("prodid", (root.getFirstPropertyValue("prodid") as string | null) || prodid);
    const calscale = root.getFirstPropertyValue("calscale");
    if (calscale) obj.updatePropertyWithValue("calscale", calscale);
    // The zone definitions its times name, from the file.
    const tzids = new Set<string>();
    for (const e of parts) tzidsOf(e, tzids);
    for (const tz of root.getAllSubcomponents("vtimezone")) {
      if (tzids.has(String(tz.getFirstPropertyValue("tzid")))) obj.addSubcomponent(clone(tz));
    }
    for (const e of parts) obj.addSubcomponent(clone(e));
    const master = masterEvent(obj);
    if (!master || !eventTimes(master, obj)) {
      skipped++;
      continue;
    }
    events.push({ uid, root: obj });
  }
  return { name, events, skipped };
}

/** What a busy-only copy of an event keeps: when it is, how it repeats, and nothing about what it is. */
const BUSY_KEEPS = new Set(["uid", "dtstamp", "dtstart", "dtend", "duration", "rrule", "rdate", "exdate", "recurrence-id", "sequence"]);

const isFree = (e: Component) => String(e.getFirstPropertyValue("transp") ?? "").toUpperCase() === "TRANSPARENT";
const isCancelled = (e: Component) => String(e.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED";

/**
 * An event as a busy-only secret address shows it: "Busy", at its times, with nothing
 * else of it; or null if it isn't busy (shown as free, or cancelled). An occurrence that's
 * free or cancelled on its own is left out of the series (EXDATE), so even its time stays
 * private. Its zones' definitions stay, for its times.
 */
export function busyOnly(root: Component): Component | null {
  const master = masterEvent(root);
  if (!master || isFree(master) || isCancelled(master)) return null;
  const out = new ICAL.Component(["vcalendar", [], []]);
  for (const p of ["version", "prodid", "calscale"]) {
    const v = root.getFirstPropertyValue(p);
    if (v) out.updatePropertyWithValue(p, v);
  }
  for (const tz of root.getAllSubcomponents("vtimezone")) out.addSubcomponent(clone(tz));
  const events = root.getAllSubcomponents("vevent");
  const plain = (e: Component) => {
    const copy = new ICAL.Component("vevent", out);
    for (const p of e.getAllProperties()) if (BUSY_KEEPS.has(p.name)) copy.addProperty(new ICAL.Property(JSON.parse(JSON.stringify(p.toJSON()))));
    copy.updatePropertyWithValue("summary", "Busy");
    copy.updatePropertyWithValue("class", "PRIVATE");
    copy.updatePropertyWithValue("transp", "OPAQUE");
    return copy;
  };
  const kept = plain(master);
  out.addSubcomponent(kept);
  for (const e of events) {
    if (e === master || !e.hasProperty("recurrence-id")) continue;
    if (isFree(e) || isCancelled(e)) {
      const jcal = JSON.parse(JSON.stringify(e.getFirstProperty("recurrence-id")!.toJSON()));
      jcal[0] = "exdate";
      kept.addProperty(new ICAL.Property(jcal));
    } else {
      out.addSubcomponent(plain(e));
    }
  }
  return out;
}

/** The years a component's times in one zone fall in. */
function yearsIn(c: Component, tzid: string): number[] {
  const out: number[] = [];
  for (const p of c.getAllProperties()) {
    if (p.getParameter("tzid") !== tzid) continue;
    for (const v of p.getValues()) {
      if (v && typeof v === "object" && "year" in v) out.push((v as { year: number }).year);
    }
  }
  return out;
}

/** A calendar as one file: its events, and a VTIMEZONE for every zone they name. */
export function buildFile(name: string, objects: Component[], prodid: string, zone: string): string {
  return assemble(objects, prodid, zone, { method: "PUBLISH", "x-wr-calname": name, "x-wr-timezone": zone });
}

/** An iTIP message (RFC 5546): one event's object with a method (REQUEST, REPLY, CANCEL), and its zones' definitions. */
export function buildItip(method: "REQUEST" | "REPLY" | "CANCEL", object: Component, prodid: string): string {
  return assemble([object], prodid, "UTC", { method });
}

function assemble(objects: Component[], prodid: string, zone: string, headers: Record<string, string>): string {
  const root = new ICAL.Component(["vcalendar", [], []]);
  root.updatePropertyWithValue("prodid", prodid);
  root.updatePropertyWithValue("version", "2.0");
  root.updatePropertyWithValue("calscale", "GREGORIAN");
  for (const [k, v] of Object.entries(headers)) root.updatePropertyWithValue(k, v);
  const events = objects.flatMap((o) => o.getAllSubcomponents("vevent"));
  const now = new Date().getUTCFullYear();
  const tzids = new Set<string>();
  for (const e of events) tzidsOf(e, tzids);
  for (const tzid of [...tzids].sort()) {
    if (isZone(tzid) && !isUtc(tzid)) {
      // From the first year an event is in, to now or the last, if later; the definition's
      // rules carry on from there for as long as the zone keeps them.
      const years = events.flatMap((e) => yearsIn(e, tzid));
      root.addSubcomponent(vtimezone(tzid, Math.min(now, ...years), Math.max(now, ...years)));
    } else {
      const own = objects.flatMap((o) => o.getAllSubcomponents("vtimezone")).find((tz) => tz.getFirstPropertyValue("tzid") === tzid);
      if (own) root.addSubcomponent(clone(own));
    }
  }
  for (const e of events) root.addSubcomponent(clone(e));
  return root.toString() + "\r\n";
}
