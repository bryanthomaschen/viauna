// Repeating events (server/recurrence.ts): occurrences in their own zone through clock
// changes, rules other apps write, and changing or deleting this event, this and
// following, or all.
import { describe, expect, it } from "vitest";
import { type EventFields, fieldsOf, masterEvent, parseCalendar, serialize } from "../server/icalendar.ts";
import {
  NEVER,
  type RepeatRule,
  deleteFrom,
  editEvent,
  occurrenceAt,
  occurrences,
  readRule,
  seriesSpan,
  writeRule,
} from "../server/recurrence.ts";

const ics = (...lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Test//EN", ...lines, "END:VCALENDAR", ""].join("\r\n");
const vevent = (...lines: string[]) => ["BEGIN:VEVENT", "UID:s1", "DTSTAMP:20260101T000000Z", "SUMMARY:Standup", ...lines, "END:VEVENT"];
const LONDON = "Europe/London";

/** Occurrences as [key, start as an ISO instant or date, title]. */
const list = (text: string | ReturnType<typeof parseCalendar>, reader = LONDON) => {
  const root = typeof text === "string" ? parseCalendar(text) : text;
  return occurrences(root, reader).map((o) => [o.key, o.start.kind === "date" ? o.start.date : new Date(o.start.kind === "instant" ? o.start.ms : 0).toISOString().slice(0, 16), String(o.event.getFirstPropertyValue("summary"))]);
};
const starts = (text: string | ReturnType<typeof parseCalendar>, reader = LONDON) => list(text, reader).map((o) => o[1]);

/** The fields of an occurrence as the page would send them back, changed. */
const fieldsAt = (root: ReturnType<typeof parseCalendar>, key: string, over: Partial<EventFields> = {}, reader = LONDON): EventFields => {
  const occ = occurrenceAt(root, key, reader)!;
  return { ...fieldsOf(occ.event, occ, reader), ...over };
};

const weekly = (...extra: string[]) =>
  ics(...vevent("DTSTART;TZID=Europe/London:20260316T090000", "DTEND;TZID=Europe/London:20260316T093000", ...extra));

describe("repeating events", () => {
  it("stay at 09:00 in their own zone when the clocks change", () => {
    // London goes from GMT to BST on 29 March 2026: 09:00 is 09:00Z, then 08:00Z.
    expect(starts(weekly("RRULE:FREQ=WEEKLY;COUNT=3"))).toEqual(["2026-03-16T09:00", "2026-03-23T09:00", "2026-03-30T08:00"]);
  });

  it("include an occurrence at the rule's UTC end, which ical.js alone would drop", () => {
    // 13 April, 09:00 BST is 08:00Z: exactly UNTIL, which RFC 5545 counts in.
    expect(starts(weekly("RRULE:FREQ=WEEKLY;UNTIL=20260413T080000Z"))).toEqual([
      "2026-03-16T09:00", "2026-03-23T09:00", "2026-03-30T08:00", "2026-04-06T08:00", "2026-04-13T08:00",
    ]);
  });

  it("leave out excluded dates, in their zone or in UTC, and show changed occurrences where they are", () => {
    const text = ics(
      ...vevent("DTSTART;TZID=Europe/London:20260316T090000", "DTEND;TZID=Europe/London:20260316T093000", "RRULE:FREQ=WEEKLY;COUNT=5",
        "EXDATE;TZID=Europe/London:20260323T090000", "EXDATE:20260330T080000Z"),
      ...["BEGIN:VEVENT", "UID:s1", "DTSTAMP:20260101T000000Z", "RECURRENCE-ID;TZID=Europe/London:20260406T090000",
        "DTSTART;TZID=Europe/London:20260408T150000", "DTEND;TZID=Europe/London:20260408T160000", "SUMMARY:Moved to Wednesday", "END:VEVENT"],
      ...["BEGIN:VEVENT", "UID:s1", "DTSTAMP:20260101T000000Z", "RECURRENCE-ID:20260413T080000Z", "STATUS:CANCELLED",
        "DTSTART;TZID=Europe/London:20260413T090000", "DTEND;TZID=Europe/London:20260413T093000", "END:VEVENT"],
    );
    expect(list(text)).toEqual([
      ["20260316T090000", "2026-03-16T09:00", "Standup"],
      ["20260406T090000", "2026-04-08T14:00", "Moved to Wednesday"],
    ]);
  });

  it("follow monthly and yearly rules, and leave months without a 31st out", () => {
    const at = (start: string, rule: string) => starts(ics(...vevent(`DTSTART;VALUE=DATE:${start}`, rule)));
    expect(at("20261021", "RRULE:FREQ=MONTHLY;BYDAY=3WE;COUNT=3")).toEqual(["2026-10-21", "2026-11-18", "2026-12-16"]);
    expect(at("20261030", "RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3")).toEqual(["2026-10-30", "2026-11-27", "2026-12-25"]);
    expect(at("20260131", "RRULE:FREQ=MONTHLY;COUNT=3")).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
    expect(at("20240229", "RRULE:FREQ=YEARLY;UNTIL=20291231")).toEqual(["2024-02-29", "2028-02-29"]);
  });

  it("read a VTIMEZONE Outlook sends for its own zone names, through the clock change", () => {
    const text = ics(
      "BEGIN:VTIMEZONE", "TZID:W. Europe Standard Time",
      "BEGIN:STANDARD", "DTSTART:16010101T030000", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10", "END:STANDARD",
      "BEGIN:DAYLIGHT", "DTSTART:16010101T020000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3", "END:DAYLIGHT",
      "END:VTIMEZONE",
      ...vevent("DTSTART;TZID=W. Europe Standard Time:20260323T090000", "DTEND;TZID=W. Europe Standard Time:20260323T100000", "RRULE:FREQ=WEEKLY;COUNT=2"),
    );
    expect(starts(text)).toEqual(["2026-03-23T08:00", "2026-03-30T07:00"]);
  });

  it("find a window's occurrences without walking a series that never ends past it", () => {
    const root = parseCalendar(weekly("RRULE:FREQ=DAILY"));
    const w = { fromMs: Date.parse("2030-01-07T00:00Z"), toMs: Date.parse("2030-01-09T00:00Z"), fromDate: "2030-01-07", toDate: "2030-01-09" };
    expect(occurrences(root, LONDON, w).map((o) => o.key)).toEqual(["20300107T090000", "20300108T090000"]);
    expect(seriesSpan(root).end).toBe(NEVER);
    expect(seriesSpan(parseCalendar(weekly("RRULE:FREQ=WEEKLY;COUNT=3")))).toEqual({ start: Date.parse("2026-03-16T09:00Z"), end: Date.parse("2026-03-30T08:30Z") });
  });
});

describe("repeat rules", () => {
  const rule = (r: string, start = "DTSTART;TZID=Europe/London:20261021T090000") => {
    const root = parseCalendar(ics(...vevent(start, r)));
    return readRule(masterEvent(root)!, root, LONDON);
  };

  it("read as the editor offers them", () => {
    expect(rule("RRULE:FREQ=WEEKLY")).toEqual({ freq: "weekly", interval: 1 });
    expect(rule("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE")).toEqual({ freq: "weekly", interval: 2, days: ["MO", "WE"] });
    expect(rule("RRULE:FREQ=MONTHLY;BYDAY=-1FR")).toEqual({ freq: "monthly", interval: 1, nth: { week: -1, day: "FR" } });
    expect(rule("RRULE:FREQ=YEARLY;COUNT=10")).toEqual({ freq: "yearly", interval: 1, count: 10 });
    // The rule's UTC end is the last date in the event's zone: 23:30Z is the 31st in London.
    expect(rule("RRULE:FREQ=DAILY;UNTIL=20261231T233000Z")).toEqual({ freq: "daily", interval: 1, until: "2026-12-31" });
  });

  it("keep what the editor doesn't offer as custom, as written", () => {
    expect(rule("RRULE:FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,TU,WE,TH,FR")).toEqual({ freq: "daily", interval: 1, custom: "FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,TU,WE,TH,FR" });
    expect(rule("RRULE:FREQ=WEEKLY", "DTSTART;TZID=Europe/London:20261021T090000\r\nRDATE;TZID=Europe/London:20261225T090000")?.custom).toBeTruthy();
  });

  it("are written back the way they read, with the end at the end of that day in UTC", () => {
    const root = parseCalendar(ics(...vevent("DTSTART;TZID=Europe/London:20261021T090000", "DTEND;TZID=Europe/London:20261021T100000")));
    const master = masterEvent(root)!;
    const back = (r: RepeatRule) => {
      writeRule(master, root, r);
      return readRule(master, root, LONDON);
    };
    for (const r of [
      { freq: "daily", interval: 3 },
      { freq: "weekly", interval: 1, days: ["TU", "TH"] },
      { freq: "monthly", interval: 1, nth: { week: 3, day: "WE" } },
      { freq: "yearly", interval: 1, count: 5 },
      { freq: "weekly", interval: 1, until: "2027-06-30" },
    ] as RepeatRule[]) {
      expect(back(r)).toEqual(r);
    }
    // 23:59:59 on 30 June in London (BST) is 22:59:59Z.
    expect(serialize(root)).toContain("RRULE:FREQ=WEEKLY;UNTIL=20270630T225959Z");
    writeRule(master, root, null);
    expect(serialize(root)).not.toContain("RRULE");
  });
});

describe("changing one occurrence", () => {
  const series = () => parseCalendar(weekly("RRULE:FREQ=WEEKLY;COUNT=5", "EXDATE;TZID=Europe/London:20260406T090000"));
  const repeat = (root: ReturnType<typeof parseCalendar>) => readRule(masterEvent(root)!, root, LONDON);

  it("this event: an occurrence of its own, and the rest as they were", () => {
    const root = series();
    editEvent(root, "20260323T090000", "this", fieldsAt(root, "20260323T090000", { title: "Long standup", start: "2026-03-23T10:00", end: "2026-03-23T11:00" }), repeat(root), LONDON);
    expect(list(root)).toEqual([
      ["20260316T090000", "2026-03-16T09:00", "Standup"],
      ["20260323T090000", "2026-03-23T10:00", "Long standup"],
      ["20260330T090000", "2026-03-30T08:00", "Standup"],
      ["20260413T090000", "2026-04-13T08:00", "Standup"],
    ]);
    expect(serialize(root)).toContain("RECURRENCE-ID;TZID=Europe/London:20260323T090000");
    // Changing it again changes the same one.
    editEvent(root, "20260323T090000", "this", fieldsAt(root, "20260323T090000", { title: "Longer standup" }), repeat(root), LONDON);
    expect(root.getAllSubcomponents("vevent")).toHaveLength(2);
  });

  it("all events: the series moves with it, and what was left out or changed still lines up", () => {
    const root = series();
    editEvent(root, "20260323T090000", "this", fieldsAt(root, "20260323T090000", { title: "Own title" }), repeat(root), LONDON);
    // From the third occurrence, an hour later and a day later (Mondays become Tuesdays).
    editEvent(root, "20260330T090000", "all", fieldsAt(root, "20260330T090000", { start: "2026-03-31T10:00", end: "2026-03-31T10:30" }), repeat(root), LONDON);
    expect(list(root)).toEqual([
      ["20260317T100000", "2026-03-17T10:00", "Standup"],
      ["20260324T100000", "2026-03-24T10:00", "Own title"],
      ["20260331T100000", "2026-03-31T09:00", "Standup"],
      ["20260414T100000", "2026-04-14T09:00", "Standup"],
    ]);
  });

  it("all events: a new title reaches occurrences that had the old one, not those with their own", () => {
    const root = series();
    editEvent(root, "20260323T090000", "this", fieldsAt(root, "20260323T090000", { start: "2026-03-23T09:30", end: "2026-03-23T10:00" }), repeat(root), LONDON);
    editEvent(root, "20260330T090000", "this", fieldsAt(root, "20260330T090000", { title: "Planning" }), repeat(root), LONDON);
    editEvent(root, "20260316T090000", "all", fieldsAt(root, "20260316T090000", { title: "Daily sync" }), repeat(root), LONDON);
    expect(list(root).map((o) => o[2])).toEqual(["Daily sync", "Daily sync", "Planning", "Daily sync"]);
  });

  it("this and following: the series ends before it, and a new one carries on, with what was left out", () => {
    const root = series();
    const { split } = editEvent(root, "20260330T090000", "following", fieldsAt(root, "20260330T090000", { title: "New standup", start: "2026-03-30T09:15", end: "2026-03-30T09:45" }), repeat(root), LONDON);
    expect(list(root).map((o) => o[1])).toEqual(["2026-03-16T09:00", "2026-03-23T09:00"]);
    expect(repeat(root)).toMatchObject({ count: 2 });
    expect(list(split!)).toEqual([
      ["20260330T091500", "2026-03-30T08:15", "New standup"],
      ["20260413T091500", "2026-04-13T08:15", "New standup"],
    ]);
    // Five in all, two before: three to go, one of them left out.
    expect(repeat(split!)).toMatchObject({ count: 3 });
    expect(String(masterEvent(split!)!.getFirstPropertyValue("uid"))).toBe("s1_R20260330T090000");
  });

  it("this and following from the first is all events", () => {
    const root = series();
    const { split } = editEvent(root, "20260316T090000", "following", fieldsAt(root, "20260316T090000", { title: "Renamed" }), repeat(root), LONDON);
    expect(split).toBeNull();
    expect(new Set(list(root).map((o) => o[2]))).toEqual(new Set(["Renamed"]));
  });

  it("all events, with the zone set: the same wall-clock times, in the new zone", () => {
    const root = series();
    editEvent(root, "20260316T090000", "all", fieldsAt(root, "20260316T090000", { zone: "Asia/Singapore", start: "2026-03-16T09:00", end: "2026-03-16T09:30" }), repeat(root), LONDON, { setZones: true });
    expect(serialize(root)).toContain("DTSTART;TZID=Asia/Singapore:20260316T090000");
    expect(starts(root)).toEqual(["2026-03-16T01:00", "2026-03-23T01:00", "2026-03-30T01:00", "2026-04-13T01:00"]);
  });

  it("no longer repeating: the event is the occurrence it was changed from", () => {
    const root = series();
    editEvent(root, "20260330T090000", "all", fieldsAt(root, "20260330T090000"), null, LONDON);
    expect(list(root)).toEqual([[null, "2026-03-30T08:00", "Standup"]]);
  });
});

describe("deleting occurrences", () => {
  const series = () => parseCalendar(weekly("RRULE:FREQ=WEEKLY;COUNT=3"));

  it("this one: left out of the series", () => {
    const root = deleteFrom(series(), "20260323T090000", "this", LONDON)!;
    expect(starts(root)).toEqual(["2026-03-16T09:00", "2026-03-30T08:00"]);
  });

  it("this and following: the series ends before it; from the first, nothing's left", () => {
    expect(starts(deleteFrom(series(), "20260330T090000", "following", LONDON)!)).toEqual(["2026-03-16T09:00", "2026-03-23T09:00"]);
    expect(deleteFrom(series(), "20260316T090000", "following", LONDON)).toBeNull();
  });

  it("the last occurrence left: the whole event", () => {
    let root = series();
    root = deleteFrom(root, "20260316T090000", "this", LONDON)!;
    root = deleteFrom(root, "20260323T090000", "this", LONDON)!;
    expect(deleteFrom(root, "20260330T090000", "this", LONDON)).toBeNull();
  });

  it("refuses an occurrence the series doesn't have", () => {
    expect(() => deleteFrom(series(), "20260324T090000", "this", LONDON)).toThrow(/isn't part/);
  });
});
