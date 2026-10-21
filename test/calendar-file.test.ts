// Calendar files (server/calendar-file.ts): splitting Google's, Outlook's and Apple's
// exports into events, and putting a calendar into a file other apps read.
import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { buildFile, parseFile } from "../server/calendar-file.ts";
import { masterEvent, parseCalendar, readFields } from "../server/icalendar.ts";
import { occurrences } from "../server/recurrence.ts";

const lines = (...l: string[]) => [...l, ""].join("\r\n");

/** As Google Calendar exports a calendar (Settings > Import & export). */
const GOOGLE = lines(
  "BEGIN:VCALENDAR", "PRODID:-//Google Inc//Google Calendar 70.9054//EN", "VERSION:2.0", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
  "X-WR-CALNAME:Work", "X-WR-TIMEZONE:America/New_York",
  "BEGIN:VTIMEZONE", "TZID:America/New_York", "X-LIC-LOCATION:America/New_York",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "TZNAME:EDT", "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "TZNAME:EST", "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT", "DTSTART;TZID=America/New_York:20260105T090000", "DTEND;TZID=America/New_York:20260105T093000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE;TZID=America/New_York:20260119T090000", "DTSTAMP:20261021T000000Z",
  "UID:weekly-sync@google.com", "ATTENDEE;CN=ann@example.com;PARTSTAT=ACCEPTED:mailto:ann@example.com",
  "SEQUENCE:2", "STATUS:CONFIRMED", "SUMMARY:Weekly sync", "TRANSP:OPAQUE",
  "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:This is an event reminder", "TRIGGER:-P0DT0H10M0S", "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART;TZID=America/New_York:20260112T100000", "DTEND;TZID=America/New_York:20260112T103000", "DTSTAMP:20261021T000000Z",
  "UID:weekly-sync@google.com", "RECURRENCE-ID;TZID=America/New_York:20260112T090000", "SEQUENCE:2", "SUMMARY:Weekly sync (later)", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20261225", "DTEND;VALUE=DATE:20261226", "DTSTAMP:20261021T000000Z", "UID:xmas@google.com", "SUMMARY:Christmas", "TRANSP:TRANSPARENT", "END:VEVENT",
  "BEGIN:VEVENT", "DTSTART:20261021T013000Z", "DTEND:20261021T020000Z", "DTSTAMP:20261021T000000Z", "UID:utc@google.com", "SUMMARY:Call with Tokyo", "END:VEVENT",
  "BEGIN:VTODO", "UID:todo@google.com", "SUMMARY:Not an event", "END:VTODO",
  "END:VCALENDAR",
);

/** As Outlook writes one: its own zone names, defined in the file. */
const OUTLOOK = lines(
  "BEGIN:VCALENDAR", "METHOD:PUBLISH", "PRODID:Microsoft Exchange Server 2010", "VERSION:2.0", "X-WR-CALNAME:Calendar",
  "BEGIN:VTIMEZONE", "TZID:W. Europe Standard Time",
  "BEGIN:STANDARD", "DTSTART:16010101T030000", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10", "END:STANDARD",
  "BEGIN:DAYLIGHT", "DTSTART:16010101T020000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3", "END:DAYLIGHT",
  "END:VTIMEZONE",
  "BEGIN:VEVENT", "UID:040000008200E00074C5B7101A82E008", "SUMMARY:Board meeting", "DTSTART;TZID=W. Europe Standard Time:20261104T140000",
  "DTEND;TZID=W. Europe Standard Time:20261104T160000", "X-MICROSOFT-CDO-BUSYSTATUS:BUSY", "DTSTAMP:20261021T000000Z", "END:VEVENT",
  "END:VCALENDAR",
);

describe("importing a calendar file", () => {
  it("splits Google's export into its events, each with the changed occurrences and zones it needs", () => {
    const file = parseFile(GOOGLE, "-//Viauna//Test//EN");
    expect(file.name).toBe("Work");
    expect(file.events.map((e) => e.uid)).toEqual(["weekly-sync@google.com", "xmas@google.com", "utc@google.com"]);
    expect(file.skipped).toBe(1); // the task
    const weekly = file.events[0].root;
    expect(weekly.getAllSubcomponents("vevent")).toHaveLength(2);
    expect(weekly.getAllSubcomponents("vtimezone")).toHaveLength(1);
    expect(file.events[1].root.getAllSubcomponents("vtimezone")).toHaveLength(0);
    // Everything else as it came: guests, the reminder, Google's PRODID.
    const text = weekly.toString();
    for (const kept of ["ATTENDEE;CN=ann@example.com", "TRIGGER:-P0DT0H10M0S", "PRODID:-//Google Inc//Google Calendar 70.9054//EN", "SEQUENCE:2"]) expect(text).toContain(kept);
    // Monday 5 January at 09:00 in New York; the 19th left out; the 12th moved to 10:00.
    const occ = occurrences(weekly, "America/New_York").slice(0, 3).map((o) => [o.key, new Date(o.start.kind === "instant" ? o.start.ms : 0).toISOString()]);
    expect(occ).toEqual([
      ["20260105T090000", "2026-01-05T14:00:00.000Z"],
      ["20260112T090000", "2026-01-12T15:00:00.000Z"],
      ["20260126T090000", "2026-01-26T14:00:00.000Z"],
    ]);
  });

  it("reads Outlook's own zone names through the definitions it sends", () => {
    const file = parseFile(OUTLOOK, "x");
    expect(readFields(file.events[0].root, "UTC")).toMatchObject({ title: "Board meeting", start: "2026-11-04T13:00", end: "2026-11-04T15:00" });
  });

  it("gives an event without a UID one from its content, so a second import finds it", () => {
    const text = lines("BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "DTSTART:20261021T090000Z", "SUMMARY:No UID", "END:VEVENT", "END:VCALENDAR");
    const [a] = parseFile(text, "x").events;
    const [b] = parseFile(text, "x").events;
    expect(a.uid).toMatch(/^urn:sha256:[0-9a-f]{64}$/);
    expect(b.uid).toBe(a.uid);
  });

  it("reads several calendars in one file, one that starts with a byte-order mark, and refuses what isn't a calendar", () => {
    expect(parseFile(GOOGLE + OUTLOOK, "x").events).toHaveLength(4);
    expect(parseFile(`\uFEFF${OUTLOOK}`, "x").events).toHaveLength(1);
    expect(() => parseFile("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ann\r\nEND:VCARD\r\n", "x")).toThrow();
  });
});

describe("exporting a calendar", () => {
  const objects = () => [...parseFile(GOOGLE, "x").events, ...parseFile(OUTLOOK, "x").events].map((e) => e.root);

  it("puts every event in one file with a VTIMEZONE for each zone they use", () => {
    const text = buildFile("Work", objects(), "-//Viauna//Test//EN", "Asia/Singapore");
    const root = parseCalendar(text);
    expect(root.getFirstPropertyValue("x-wr-calname")).toBe("Work");
    expect(root.getAllSubcomponents("vtimezone").map((t) => t.getFirstPropertyValue("tzid"))).toEqual(["America/New_York", "W. Europe Standard Time"]);
    expect(root.getAllSubcomponents("vevent")).toHaveLength(5);
    // New York's is built from the IANA database (open-ended rules), Outlook's kept as it sent it.
    expect(text).toContain("RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU");
    expect(text).toContain("RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10");
    expect(text).not.toContain("BEGIN:VTODO");
  });

  it("reads back the same, through its own zone definitions, as another app would", () => {
    const text = buildFile("Work", objects(), "x", "UTC");
    const back = parseFile(text, "x");
    expect(back.events.map((e) => e.uid).sort()).toEqual(["040000008200E00074C5B7101A82E008", "utc@google.com", "weekly-sync@google.com", "xmas@google.com"]);
    // The New York times, through the exported VTIMEZONE alone (ical.js, as another app reads it).
    const weekly = back.events.find((e) => e.uid === "weekly-sync@google.com")!.root;
    const tz = new ICAL.Timezone(weekly.getFirstSubcomponent("vtimezone")!);
    const start = masterEvent(weekly)!.getFirstPropertyValue("dtstart") as InstanceType<typeof ICAL.Time>;
    expect(ICAL.Time.fromData({ year: start.year, month: start.month, day: start.day, hour: start.hour, minute: start.minute, second: 0, isDate: false }, tz).toUnixTime()).toBe(Date.parse("2026-01-05T14:00:00Z") / 1000);
  });
});
