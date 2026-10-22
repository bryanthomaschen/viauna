// Events as iCalendar (server/icalendar.ts): read, changed and written without losing
// anything, with times in the zones they were written in.
import { describe, expect, it } from "vitest";
import {
  type EventFields,
  applyFields,
  eventTimes,
  isZone,
  masterEvent,
  msToWall,
  newEvent,
  ownZone,
  parseCalendar,
  readFields,
  serialize,
  wallToMs,
} from "../server/icalendar.ts";

const fields = (over: Partial<EventFields> = {}): EventFields => ({
  title: "Lunch",
  allDay: false,
  start: "2026-10-21T12:00",
  end: "2026-10-21T13:00",
  zone: "Asia/Singapore",
  location: "",
  description: "",
  busy: true,
  color: null,
  video: null,
  endZone: null,
  reminders: [],
  ...over,
});

const ics = (...lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...lines, "END:VCALENDAR", ""].join("\r\n");
const event = (...lines: string[]) => ics("BEGIN:VEVENT", "UID:e1@test", "DTSTAMP:20261001T000000Z", ...lines, "END:VEVENT");

describe("iCalendar events", () => {
  it("writes a new event with its zone, and reads it back the same", () => {
    const root = newEvent(fields({ location: "Lau Pa Sat, 18 Raffles Quay", description: "Bring cash;\nno cards", video: "https://meet.example.com/a,b" }), "u1", "-//Viauna//Test//EN");
    const text = serialize(root).replace(/\r\n[ \t]/g, "");
    expect(text).toContain("DTSTART;TZID=Asia/Singapore:20261021T120000");
    expect(text).toContain("LOCATION:Lau Pa Sat\\, 18 Raffles Quay");
    expect(text).toMatch(/CONFERENCE;[^:]*VALUE=URI[^:]*:https:\/\/meet\.example\.com\/a,b/);
    expect(text).toContain("SEQUENCE:0");
    const back = readFields(parseCalendar(text), "Asia/Singapore");
    expect(back).toEqual(fields({ location: "Lau Pa Sat, 18 Raffles Quay", description: "Bring cash;\nno cards", video: "https://meet.example.com/a,b" }));
  });

  it("shows times in the reader's zone, and keeps the event's own when it's moved", () => {
    const root = newEvent(fields({ start: "2026-10-21T09:00", end: "2026-10-21T10:00", zone: "Europe/London" }), "u2", "x");
    expect(readFields(root, "Asia/Singapore")).toMatchObject({ start: "2026-10-21T16:00", end: "2026-10-21T17:00", zone: "Asia/Singapore" });
    // Someone in Singapore moves it an hour later: it stays a London meeting, at 10:00 there.
    applyFields(root, fields({ start: "2026-10-21T17:00", end: "2026-10-21T18:00", zone: "Asia/Singapore" }));
    const text = serialize(root);
    expect(text).toContain("DTSTART;TZID=Europe/London:20261021T100000");
    expect(ownZone(root)).toBe("Europe/London");
  });

  it("writes all-day events as dates, with the day after as the end", () => {
    const root = newEvent(fields({ allDay: true, start: "2026-10-21", end: "2026-10-23", zone: null }), "u3", "x");
    const text = serialize(root);
    expect(text).toContain("DTSTART;VALUE=DATE:20261021");
    expect(text).toContain("DTEND;VALUE=DATE:20261023");
    expect(text).not.toContain("TZID");
    // The same dates wherever you are.
    expect(readFields(root, "Pacific/Auckland")).toMatchObject({ allDay: true, start: "2026-10-21", end: "2026-10-23" });
    expect(readFields(root, "America/Los_Angeles")).toMatchObject({ allDay: true, start: "2026-10-21", end: "2026-10-23" });
  });

  it("turns a timed event all-day and back", () => {
    const root = newEvent(fields(), "u4", "x");
    applyFields(root, fields({ allDay: true, start: "2026-10-21", end: "2026-10-22", zone: null }));
    expect(serialize(root)).toContain("DTSTART;VALUE=DATE:20261021");
    applyFields(root, fields({ start: "2026-10-22T08:00", end: "2026-10-22T08:30" }));
    const text = serialize(root);
    expect(text).toContain("DTSTART;TZID=Asia/Singapore:20261022T080000");
    expect(text).not.toContain("VALUE=DATE");
  });

  it("leaves what it doesn't show as it was: guests, alarms, other apps' fields", () => {
    const original = event(
      "SUMMARY:Planning",
      "DTSTART;TZID=Europe/Paris:20261103T140000",
      "DTEND;TZID=Europe/Paris:20261103T150000",
      "ORGANIZER;CN=Ann:mailto:ann@example.com",
      "ATTENDEE;PARTSTAT=ACCEPTED;CN=Bob:mailto:bob@example.com",
      "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC",
      "SEQUENCE:3",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-PT15M",
      "END:VALARM",
    );
    const root = parseCalendar(original);
    applyFields(root, { ...readFields(root, "Europe/Paris")!, title: "Planning, round 2" });
    const text = serialize(root);
    for (const kept of ["ORGANIZER;CN=Ann:mailto:ann@example.com", "ATTENDEE;PARTSTAT=ACCEPTED;CN=Bob:mailto:bob@example.com", "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC", "TRIGGER:-PT15M", "UID:e1@test"]) {
      expect(text).toContain(kept);
    }
    expect(text).toContain("SUMMARY:Planning\\, round 2");
    // Only a new time is a new version of the event.
    expect(text).toContain("SEQUENCE:3");
    applyFields(root, { ...readFields(root, "Europe/Paris")!, start: "2026-11-03T15:00", end: "2026-11-03T16:00" });
    expect(serialize(root)).toContain("SEQUENCE:4");
  });

  it("reads UTC, floating and DURATION times, and events with no end", () => {
    const utc = parseCalendar(event("DTSTART:20261021T010000Z", "DTEND:20261021T020000Z"));
    expect(readFields(utc, "Asia/Singapore")).toMatchObject({ start: "2026-10-21T09:00", end: "2026-10-21T10:00" });
    expect(ownZone(utc)).toBeNull();

    // A floating time is that time wherever you are.
    const floating = parseCalendar(event("DTSTART:20261021T090000", "DURATION:PT90M"));
    expect(readFields(floating, "Asia/Singapore")).toMatchObject({ start: "2026-10-21T09:00", end: "2026-10-21T10:30" });
    expect(readFields(floating, "Europe/London")).toMatchObject({ start: "2026-10-21T09:00", end: "2026-10-21T10:30" });

    expect(readFields(parseCalendar(event("DTSTART;VALUE=DATE:20261021")), "UTC")).toMatchObject({ allDay: true, start: "2026-10-21", end: "2026-10-22" });
    expect(readFields(parseCalendar(event("DTSTART:20261021T090000Z")), "UTC")).toMatchObject({ start: "2026-10-21T09:00", end: "2026-10-21T09:00" });
    // An end before the start is read as none.
    expect(readFields(parseCalendar(event("DTSTART:20261021T090000Z", "DTEND:20261020T090000Z")), "UTC")).toMatchObject({ end: "2026-10-21T09:00" });
  });

  it("reads a zone Outlook names its own way through the object's VTIMEZONE", () => {
    const root = parseCalendar(
      ics(
        "BEGIN:VTIMEZONE",
        "TZID:W. Europe Standard Time",
        "BEGIN:STANDARD",
        "DTSTART:16010101T030000",
        "TZOFFSETFROM:+0200",
        "TZOFFSETTO:+0100",
        "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10",
        "END:STANDARD",
        "BEGIN:DAYLIGHT",
        "DTSTART:16010101T020000",
        "TZOFFSETFROM:+0100",
        "TZOFFSETTO:+0200",
        "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3",
        "END:DAYLIGHT",
        "END:VTIMEZONE",
        "BEGIN:VEVENT",
        "UID:outlook",
        "DTSTAMP:20261001T000000Z",
        "DTSTART;TZID=W. Europe Standard Time:20261021T090000",
        "DTEND;TZID=W. Europe Standard Time:20261021T100000",
        "END:VEVENT",
      ),
    );
    // 09:00 summer time in Berlin is 07:00 UTC.
    expect(readFields(root, "UTC")).toMatchObject({ start: "2026-10-21T07:00", end: "2026-10-21T08:00" });
  });

  it("prefers a changed occurrence's master event, the one without a RECURRENCE-ID", () => {
    const root = parseCalendar(
      ics(
        "BEGIN:VEVENT", "UID:r", "DTSTAMP:20261001T000000Z", "RECURRENCE-ID:20261028T090000Z", "DTSTART:20261028T100000Z", "SUMMARY:Moved one", "END:VEVENT",
        "BEGIN:VEVENT", "UID:r", "DTSTAMP:20261001T000000Z", "DTSTART:20261021T090000Z", "RRULE:FREQ=WEEKLY", "SUMMARY:Weekly", "END:VEVENT",
      ),
    );
    expect(masterEvent(root)?.getFirstPropertyValue("summary")).toBe("Weekly");
  });

  it("reads Google's and Teams' video links, and replaces or clears one", () => {
    const google = parseCalendar(event("DTSTART:20261021T090000Z", "X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij"));
    expect(readFields(google, "UTC")?.video).toBe("https://meet.google.com/abc-defg-hij");
    applyFields(google, { ...readFields(google, "UTC")!, video: null });
    expect(serialize(google)).not.toContain("meet.google.com");

    const teams = parseCalendar(event("DTSTART:20261021T090000Z", "X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/x"));
    expect(readFields(teams, "UTC")?.video).toBe("https://teams.microsoft.com/l/meetup-join/x");
    applyFields(teams, { ...readFields(teams, "UTC")!, video: "https://meet.example.com/new" });
    const text = serialize(teams);
    expect(text).not.toContain("teams.microsoft.com");
    expect(readFields(parseCalendar(text), "UTC")?.video).toBe("https://meet.example.com/new");
  });

  it("marks free time as transparent, and keeps a colour by its CSS name", () => {
    const root = newEvent(fields({ busy: false, color: "tomato" }), "u5", "x");
    const text = serialize(root);
    expect(text).toContain("TRANSP:TRANSPARENT");
    expect(text).toContain("COLOR:tomato");
    expect(readFields(parseCalendar(text), "Asia/Singapore")).toMatchObject({ busy: false, color: "tomato" });
  });

  it("knows named zones, not offsets or Windows names", () => {
    expect(isZone("Europe/London")).toBe(true);
    expect(isZone("UTC")).toBe(true);
    expect(isZone("+08:00")).toBe(false);
    expect(isZone("Pacific Standard Time")).toBe(false);
    expect(isZone("Nowhere/Special")).toBe(false);
  });

  it("moves a time a clock change skips to after it, and back again", () => {
    // London skips 01:00-02:00 on 29 March 2026.
    const ms = wallToMs("2026-03-29T01:30", "Europe/London");
    expect(msToWall(ms, "Europe/London")).toBe("2026-03-29T02:30");
    expect(msToWall(ms, "UTC")).toBe("2026-03-29T01:30");
    expect(() => wallToMs("2026-02-30T09:00", "UTC")).toThrow();
  });

  it("finds the start and end of an event for indexing", () => {
    const root = parseCalendar(event("DTSTART;TZID=Asia/Singapore:20261021T090000", "DTEND;TZID=Asia/Singapore:20261021T100000"));
    const times = eventTimes(masterEvent(root)!, root)!;
    expect(times.start).toEqual({ kind: "instant", ms: Date.parse("2026-10-21T01:00:00Z"), zone: "Asia/Singapore" });
  });
});

describe("reminders", () => {
  // As Google exports them, with an alarm of a kind Viauna doesn't edit (after the end).
  const GOOGLE = ics(
    "BEGIN:VEVENT", "UID:r1", "DTSTAMP:20261001T000000Z", "DTSTART;TZID=Asia/Singapore:20261021T120000", "DTEND;TZID=Asia/Singapore:20261021T130000", "SUMMARY:Lunch",
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:This is an event reminder", "TRIGGER:-P0DT0H30M0S", "END:VALARM",
    "BEGIN:VALARM", "ACTION:EMAIL", "DESCRIPTION:This is an event reminder", "SUMMARY:Alarm notification", "ATTENDEE:mailto:me@example.test", "TRIGGER:-P1D", "END:VALARM",
    "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:After", "TRIGGER;RELATED=END:PT5M", "END:VALARM",
    "END:VEVENT",
  );

  it("reads the reminders before an event starts, shown or emailed, earliest first", () => {
    expect(readFields(parseCalendar(GOOGLE), "Asia/Singapore")?.reminders).toEqual([
      { method: "email", minutes: 1440 },
      { method: "notification", minutes: 30 },
    ]);
  });

  it("writes them as alarms, and leaves the kinds it doesn't edit alone", () => {
    const root = parseCalendar(GOOGLE);
    applyFields(root, fields({ reminders: [{ method: "notification", minutes: 10 }] }));
    const out = serialize(root);
    expect(out).toContain("BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT10M\r\nDESCRIPTION:Reminder\r\nEND:VALARM");
    expect(out).toContain("TRIGGER;RELATED=END:PT5M");
    expect(out).not.toContain("-P1D");
    expect(readFields(parseCalendar(out), "Asia/Singapore")?.reminders).toEqual([{ method: "notification", minutes: 10 }]);
  });

  it("leaves reminders that didn't change exactly as they were written", () => {
    const root = parseCalendar(GOOGLE);
    applyFields(root, fields({ title: "Lunch!", reminders: [{ method: "notification", minutes: 30 }, { method: "email", minutes: 1440 }] }));
    const out = serialize(root);
    expect(out).toContain("TRIGGER:-P0DT0H30M0S");
    expect(out).toContain("SUMMARY:Alarm notification");
  });

  it("writes an all-day event's reminder from the start of its day", () => {
    const root = newEvent(fields({ allDay: true, start: "2026-10-21", end: "2026-10-22", zone: null, reminders: [{ method: "email", minutes: 900 }] }), "r2", "-//Test//EN");
    const out = serialize(root);
    expect(out).toContain("ACTION:EMAIL\r\nTRIGGER:-PT15H\r\nSUMMARY:Reminder\r\nDESCRIPTION:Reminder");
  });
});
