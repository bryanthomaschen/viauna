// Calendars and events (server/calendar.ts) on each state-store engine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CalendarError,
  cleanFields,
  createCalendar,
  exportCalendar,
  importEvents,
  createEvent,
  deleteCalendar,
  deleteEvent,
  eventsBetween,
  getEvent,
  listCalendars,
  searchEvents,
  undoChange,
  updateCalendar,
  updateEvent,
} from "../server/calendar.ts";
import { setOverrides } from "../server/config.ts";
import { createContact } from "../server/contacts.ts";
import { sha256 } from "../server/crypto.ts";
import { type StateStore, openState, setState, state } from "../server/state/db.ts";
import { ENGINES, emptyDatabase } from "./databases.ts";

const imap = JSON.stringify({ host: "imap.example.test", port: 993, security: "tls", servername: null, verify: true });
const account = { id: 7, login: "me@example.test", email: "me@example.test", imap, smtp: "{}" };
const SG = "Asia/Singapore";

const lunch = (over: Record<string, unknown> = {}) => ({
  title: "Lunch", allDay: false, start: "2026-10-21T12:00", end: "2026-10-21T13:00", zone: SG, ...over,
});

describe.each(ENGINES)("calendars on $name", ({ url }) => {
  let store: StateStore;
  let dir: string;
  let primary: number;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "viauna-calendar-"));
    if (url) await emptyDatabase(url);
    store = await openState(url, path.join(dir, "state.db"));
  });

  afterAll(async () => {
    await store.db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    setState(store);
    await state().deleteFrom("events").execute();
    await state().deleteFrom("calendars").execute();
    await state().deleteFrom("accounts").execute();
    await state().insertInto("accounts").values({ ...account, imap_hash: sha256(imap), settings: "{}", created_at: 1 }).execute();
    primary = (await listCalendars(7, "Me Myself"))[0].id;
  });

  afterEach(() => setState(null));

  it("makes the mailbox's own calendar and its Birthdays once, even when asked for at the same moment", async () => {
    await state().deleteFrom("calendars").execute();
    const lists = await Promise.all([listCalendars(7, "Me"), listCalendars(7, "Me"), listCalendars(7, "Me")]);
    for (const list of lists) {
      expect(list).toEqual([
        expect.objectContaining({ name: "Me", primary: true, visible: true, kind: "events", readOnly: false }),
        expect.objectContaining({ name: "Birthdays", primary: false, visible: true, kind: "birthdays", readOnly: true }),
      ]);
    }
    const rows = await state().selectFrom("calendars").select("id").execute();
    expect(rows).toHaveLength(2);
  });

  it("adds, renames, hides and deletes calendars, but not the mailbox's own", async () => {
    const work = await createCalendar(7, { name: " Work " });
    expect(work).toMatchObject({ name: "Work", primary: false, visible: true });
    expect(work.color).not.toBe("dodgerblue"); // the next colour not in use
    expect(await updateCalendar(7, work.id, { name: "Office", color: "tomato", visible: false })).toMatchObject({ name: "Office", color: "tomato", visible: false });
    await expect(updateCalendar(7, work.id, { color: "#123456" })).rejects.toThrow(CalendarError);
    await expect(createCalendar(7, { name: "" })).rejects.toThrow(/name/);
    await expect(deleteCalendar(7, primary)).rejects.toThrow(/can't be deleted/);
    // Another mailbox's calendar is no one's here.
    await expect(updateCalendar(8, work.id, { name: "Mine" })).rejects.toMatchObject({ status: 404 });

    await createEvent(7, work.id, lunch(), SG);
    await deleteCalendar(7, work.id);
    expect((await listCalendars(7, "Me")).map((c) => c.name)).toEqual(["Me Myself", "Birthdays"]);
    expect(await state().selectFrom("events").selectAll().execute()).toEqual([]);
  });

  it("lists events on the days they fall in the reader's zone", async () => {
    const e = await createEvent(7, primary, lunch({ start: "2026-10-21T07:00", end: "2026-10-21T08:00" }), SG);
    expect(e).toMatchObject({ title: "Lunch", start: "2026-10-21T07:00", calendarId: primary, eventZone: null });
    // 07:00 in Singapore on the 21st is 23:00 UTC on the 20th.
    expect(await eventsBetween(7, "2026-10-21", "2026-10-22", SG)).toEqual([
      expect.objectContaining({ id: e.id, allDay: false, start: "2026-10-20T23:00:00.000Z", end: "2026-10-21T00:00:00.000Z" }),
    ]);
    expect(await eventsBetween(7, "2026-10-21", "2026-10-22", "UTC")).toEqual([]);
    expect(await eventsBetween(7, "2026-10-20", "2026-10-21", "UTC")).toHaveLength(1);
    // Read from London, it keeps the zone it was made in.
    expect(await getEvent(7, e.id, "Europe/London")).toMatchObject({ start: "2026-10-21T00:00", zone: "Europe/London", eventZone: SG });
  });

  it("keeps all-day events on their dates wherever you read them", async () => {
    await createEvent(7, primary, { title: "Holiday", allDay: true, start: "2026-10-21", end: "2026-10-23" }, SG);
    for (const zone of ["Pacific/Auckland", "UTC", "America/Los_Angeles"]) {
      expect(await eventsBetween(7, "2026-10-22", "2026-10-23", zone)).toEqual([expect.objectContaining({ title: "Holiday", start: "2026-10-21", end: "2026-10-23" })]);
      expect(await eventsBetween(7, "2026-10-23", "2026-10-24", zone)).toEqual([]);
      expect(await eventsBetween(7, "2026-10-20", "2026-10-21", zone)).toEqual([]);
    }
  });

  it("counts an event that ends as the range starts out, and one at a single moment in", async () => {
    await createEvent(7, primary, lunch({ start: "2026-10-20T23:00", end: "2026-10-21T00:00" }), SG);
    await createEvent(7, primary, lunch({ title: "Alarm", start: "2026-10-21T00:00", end: "2026-10-21T00:00" }), SG);
    expect((await eventsBetween(7, "2026-10-21", "2026-10-22", SG)).map((e) => e.title)).toEqual(["Alarm"]);
  });

  it("changes only what it's given, moves events between calendars, and undoes", async () => {
    const work = await createCalendar(7, { name: "Work" });
    const e = await createEvent(7, primary, lunch({ location: "Canteen", color: "gold" }), SG);
    const renamed = await updateEvent(7, e.id, { title: "Team lunch" }, SG);
    expect(renamed.event).toMatchObject({ title: "Team lunch", start: "2026-10-21T12:00", location: "Canteen", color: "gold" });

    const moved = await updateEvent(7, e.id, { start: "2026-10-22T09:00", end: "2026-10-22T09:30", calendarId: work.id }, SG);
    expect(moved.event).toMatchObject({ start: "2026-10-22T09:00", end: "2026-10-22T09:30", calendarId: work.id, title: "Team lunch" });
    expect((await eventsBetween(7, "2026-10-22", "2026-10-23", SG))[0]).toMatchObject({ calendarId: work.id });

    expect(await undoChange(7, moved.undo)).toBe(true);
    expect(await getEvent(7, e.id, SG)).toMatchObject({ start: "2026-10-21T12:00", calendarId: primary, title: "Team lunch" });
    expect(await undoChange(7, moved.undo)).toBe(false); // once only
    expect(await undoChange(8, renamed.undo)).toBe(false); // and only by its mailbox
  });

  it("deletes an event, and puts it back with the same id", async () => {
    const e = await createEvent(7, primary, lunch(), SG);
    const token = await deleteEvent(7, e.id);
    await expect(getEvent(7, e.id, SG)).rejects.toMatchObject({ status: 404 });
    expect(await undoChange(7, token)).toBe(true);
    expect(await getEvent(7, e.id, SG)).toMatchObject({ id: e.id, title: "Lunch" });
    // A new event after that still gets a new id (the sequence moved on).
    const next = await createEvent(7, primary, lunch({ title: "Dinner" }), SG);
    expect(next.id).not.toBe(e.id);
  });

  it("can't undo the deletion of an event whose calendar went too", async () => {
    const trip = await createCalendar(7, { name: "Trip" });
    const e = await createEvent(7, trip.id, lunch(), SG);
    const token = await deleteEvent(7, e.id);
    await deleteCalendar(7, trip.id);
    expect(await undoChange(7, token)).toBe(false);
  });

  it("finds events by title, place and description, accents and case aside", async () => {
    await createEvent(7, primary, lunch({ title: "Café with Élodie", location: "Tiong Bahru" }), SG);
    await createEvent(7, primary, lunch({ title: "Dentist", description: "Bring the referral" }), SG);
    expect((await searchEvents(7, "elodie", SG)).map((e) => e.title)).toEqual(["Café with Élodie"]);
    expect((await searchEvents(7, "BAHRU", SG)).map((e) => e.title)).toEqual(["Café with Élodie"]);
    expect((await searchEvents(7, "referral", SG)).map((e) => e.title)).toEqual(["Dentist"]);
    expect(await searchEvents(7, "100%", SG)).toEqual([]);
  });

  it("lists a repeating event's occurrences, years on, and finds it at its next one", async () => {
    const e = await createEvent(7, primary, lunch({ title: "Standup", start: "2026-10-19T09:00", end: "2026-10-19T09:15", repeat: { freq: "weekly", interval: 1, days: ["MO", "WE"] } }), SG);
    expect(e).toMatchObject({ recurring: true, repeat: { freq: "weekly", days: ["MO", "WE"] } });
    const later = await eventsBetween(7, "2030-01-06", "2030-01-13", SG);
    expect(later.map((x) => [x.occurrence, x.start])).toEqual([
      ["20300107T090000", "2030-01-07T01:00:00.000Z"],
      ["20300109T090000", "2030-01-09T01:00:00.000Z"],
    ]);
    const found = await searchEvents(7, "standup", SG);
    expect(found).toHaveLength(1);
    expect(found[0].start > new Date().toISOString().slice(0, 10)).toBe(true);
  });

  it("splits a series for this and following, and Undo puts both back as one", async () => {
    const e = await createEvent(7, primary, lunch({ title: "Standup", start: "2026-10-19T09:00", end: "2026-10-19T09:15", repeat: { freq: "daily", interval: 1, count: 10 } }), SG);
    const { event, undo } = await updateEvent(7, e.id, { occurrence: "20261024T090000", scope: "following", title: "New standup", start: "2026-10-24T10:00", end: "2026-10-24T10:15" }, SG);
    expect(event).toMatchObject({ title: "New standup", start: "2026-10-24T10:00", repeat: { freq: "daily", count: 5 } });
    expect(event.id).not.toBe(e.id);
    const week = await eventsBetween(7, "2026-10-19", "2026-10-29", SG);
    expect(week.map((x) => `${x.start.slice(5, 10)} ${x.title}`)).toEqual([
      "10-19 Standup", "10-20 Standup", "10-21 Standup", "10-22 Standup", "10-23 Standup",
      "10-24 New standup", "10-25 New standup", "10-26 New standup", "10-27 New standup", "10-28 New standup",
    ]);
    expect(await undoChange(7, undo)).toBe(true);
    const back = await eventsBetween(7, "2026-10-19", "2026-10-29", SG);
    expect(back.map((x) => x.title)).toEqual(Array(10).fill("Standup"));
    expect(new Set(back.map((x) => x.id))).toEqual(new Set([e.id]));
  });

  it("changes or deletes one occurrence, and Undo brings it back", async () => {
    const e = await createEvent(7, primary, lunch({ start: "2026-10-19T12:00", end: "2026-10-19T13:00", repeat: { freq: "daily", interval: 1, count: 3 } }), SG);
    const moved = await updateEvent(7, e.id, { occurrence: "20261020T120000", scope: "this", start: "2026-10-20T13:00", end: "2026-10-20T14:00" }, SG);
    expect(moved.event).toMatchObject({ occurrence: "20261020T120000", start: "2026-10-20T13:00" });
    expect(await getEvent(7, e.id, SG, "20261020T120000")).toMatchObject({ start: "2026-10-20T13:00" });
    const token = await deleteEvent(7, e.id, "20261021T120000", "this");
    expect((await eventsBetween(7, "2026-10-19", "2026-10-22", SG)).map((x) => x.start.slice(0, 16))).toEqual(["2026-10-19T04:00", "2026-10-20T05:00"]);
    expect(await undoChange(7, token)).toBe(true);
    expect(await eventsBetween(7, "2026-10-19", "2026-10-22", SG)).toHaveLength(3);
    await expect(updateEvent(7, e.id, { occurrence: "20261021T120000", scope: "this", calendarId: (await createCalendar(7, { name: "Other" })).id }, SG)).rejects.toThrow(/another calendar/);
    await expect(updateEvent(7, e.id, { occurrence: "20261021T120000", scope: "this", repeat: { freq: "weekly", interval: 1 } }, SG)).rejects.toThrow(/following/);
    await expect(getEvent(7, e.id, SG, "20261025T120000")).rejects.toMatchObject({ status: 404 });
  });

  it("keeps the zones the editor sets, a different one for the end", async () => {
    const flight = await createEvent(7, primary, lunch({ title: "SQ 322", start: "2026-11-02T23:30", zone: SG, end: "2026-11-03T06:00", endZone: "Europe/London" }), SG);
    expect(flight).toMatchObject({ start: "2026-11-02T23:30", end: "2026-11-03T14:00", eventZone: null, eventEndZone: "Europe/London" });
    const moved = await updateEvent(7, flight.id, { start: "2026-11-03T00:30", end: "2026-11-03T15:00" }, SG);
    // Moved from Singapore's view, its end stays in London's time.
    expect(moved.event).toMatchObject({ start: "2026-11-03T00:30", end: "2026-11-03T15:00", eventEndZone: "Europe/London" });
    expect(await getEvent(7, flight.id, "Europe/London")).toMatchObject({ end: "2026-11-03T07:00", eventZone: SG });
  });

  it("imports a calendar file into a new calendar, again without repeats, and exports it", async () => {
    const file = (title: string) =>
      [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Google Inc//Google Calendar 70.9054//EN", "METHOD:PUBLISH", "X-WR-CALNAME:Holidays",
        "BEGIN:VEVENT", "UID:a@google.com", "DTSTAMP:20261021T000000Z", "DTSTART;VALUE=DATE:20261225", "DTEND;VALUE=DATE:20261226", `SUMMARY:${title}`, "END:VEVENT",
        "BEGIN:VEVENT", "UID:b@google.com", "DTSTAMP:20261021T000000Z", "DTSTART;TZID=Europe/London:20261231T230000", "DTEND;TZID=Europe/London:20270101T003000",
        "RRULE:FREQ=YEARLY", "SUMMARY:New Year", "END:VEVENT",
        "BEGIN:VTODO", "UID:c@google.com", "SUMMARY:A task", "END:VTODO",
        "END:VCALENDAR", "",
      ].join("\r\n");
    const first = await importEvents(7, "new", file("Christmas"));
    expect(first).toMatchObject({ added: 2, updated: 0, unchanged: 0, skipped: 1 });
    expect((await listCalendars(7, "Me")).find((c) => c.id === first.calendarId)).toMatchObject({ name: "Holidays", primary: false });
    expect(await importEvents(7, first.calendarId, file("Christmas"))).toMatchObject({ added: 0, unchanged: 2 });
    expect(await importEvents(7, first.calendarId, file("Christmas Day"))).toMatchObject({ updated: 1, unchanged: 1 });
    // A year on, the New Year event repeats, at 23:00 in London.
    expect((await eventsBetween(7, "2027-12-31", "2028-01-01", "Europe/London")).map((e) => [e.title, e.start])).toEqual([["New Year", "2027-12-31T23:00:00.000Z"]]);
    const out = await exportCalendar(7, first.calendarId, SG);
    expect(out.name).toBe("Holidays");
    expect(out.text).toContain("SUMMARY:Christmas Day");
    expect(out.text).toContain("BEGIN:VTIMEZONE\r\nTZID:Europe/London");
    expect(out.text.match(/^METHOD:/gm)).toEqual(["METHOD:"]); // the file's own, not each event's
    await expect(importEvents(7, primary, "BEGIN:VCARD\r\nFN:Ann\r\nEND:VCARD\r\n")).rejects.toThrow(/calendar file/);
    await expect(importEvents(7, primary, "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n")).rejects.toThrow(/no events/);
    await expect(importEvents(7, 9999, file("x"))).rejects.toMatchObject({ status: 404 });
  });

  it("shows the contacts' dates on a Birthdays calendar, which can't be changed from here", async () => {
    const birthdays = (await listCalendars(7, "Me Myself")).find((c) => c.kind === "birthdays")!;
    const kai = await createContact(7, {
      firstName: "Kai", lastName: "Lim", birthday: "1988-03-14",
      dates: [{ date: "2015-06-20", label: "anniversary" }, { date: "--01-06", label: "First day at work" }],
    });
    await createContact(7, { firstName: "Leap", birthday: "2000-02-29" });
    const dated = async (from: string, to: string) =>
      (await eventsBetween(7, from, to, SG)).filter((e) => e.calendarId === birthdays.id).map((e) => [e.start, e.title]);
    expect(await dated("2027-01-01", "2028-01-01")).toEqual([
      ["2027-01-06", "Kai Lim: First day at work"],
      ["2027-02-28", "Leap's birthday (27)"],
      ["2027-03-14", "Kai Lim's birthday (39)"],
      ["2027-06-20", "Kai Lim's anniversary (12 years)"],
    ]);
    // 29 February when there is one; nothing before someone was born.
    expect(await dated("2028-02-01", "2028-03-01")).toEqual([["2028-02-29", "Leap's birthday (28)"]]);
    expect(await dated("1999-12-01", "2000-03-01")).toEqual([["2000-01-06", "Kai Lim: First day at work"], ["2000-02-29", "Leap's birthday"]]);
    const one = (await eventsBetween(7, "2027-03-14", "2027-03-15", SG)).find((e) => e.calendarId === birthdays.id);
    expect(one).toMatchObject({ allDay: true, start: "2027-03-14", end: "2027-03-15", readOnly: true, contactId: kai!.id, busy: false });

    await expect(createEvent(7, birthdays.id, lunch(), SG)).rejects.toThrow(/in Contacts/);
    await expect(importEvents(7, birthdays.id, "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART;VALUE=DATE:20270101\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")).rejects.toThrow(/in Contacts/);
    const ev = await createEvent(7, primary, lunch(), SG);
    await expect(updateEvent(7, ev.id, { calendarId: birthdays.id }, SG)).rejects.toThrow(/in Contacts/);
    await expect(deleteCalendar(7, birthdays.id)).rejects.toThrow(/Hide it/);
    expect(await updateCalendar(7, birthdays.id, { name: "Dates", color: "tomato", visible: false })).toMatchObject({ name: "Dates", visible: false });

    // As a file: yearly events, 29 February on the last day of February, no ages.
    const { text } = await exportCalendar(7, birthdays.id, SG);
    expect(text).toContain("DTSTART;VALUE=DATE:19880314");
    expect(text).toContain("SUMMARY:Kai Lim's birthday\r\n");
    expect(text).toContain("DTSTART;VALUE=DATE:20000106"); // its year isn't known
    expect(text).toMatch(/DTSTART;VALUE=DATE:20000229\r\n(.*\r\n)*?RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1\r\n/);
    expect(text).toContain("TRANSP:TRANSPARENT");
  });

  it("leaves the Birthdays calendar out while contacts are off", async () => {
    const birthdays = (await listCalendars(7, "Me Myself")).find((c) => c.kind === "birthdays")!;
    await createContact(7, { firstName: "Kai", birthday: "--03-14" });
    setOverrides(new Map([["contacts", false]]));
    try {
      expect((await listCalendars(7, "Me Myself")).map((c) => c.kind)).toEqual(["events"]);
      expect(await eventsBetween(7, "2027-03-01", "2027-04-01", SG)).toEqual([]);
      await expect(updateCalendar(7, birthdays.id, { visible: false })).rejects.toMatchObject({ status: 404 });
    } finally {
      setOverrides(new Map());
    }
    expect((await eventsBetween(7, "2027-03-01", "2027-04-01", SG)).map((e) => e.title)).toEqual(["Kai's birthday"]);
  });

  it("refuses times it can't use, and calendars that aren't the mailbox's", async () => {
    await expect(createEvent(7, primary, lunch({ end: "2026-10-21T11:00" }), SG)).rejects.toThrow(/before it starts/);
    await expect(createEvent(7, primary, lunch({ zone: "Mars/Olympus" }), SG)).rejects.toThrow(/time zone/);
    await expect(createEvent(7, primary, lunch({ start: "2026-02-30T09:00" }), SG)).rejects.toThrow(/start and an end/);
    await expect(createEvent(7, primary, { title: "x", allDay: true, start: "2026-10-21", end: "2026-10-21" }, SG)).rejects.toThrow(/before it starts/);
    await expect(createEvent(7, primary, lunch({ video: "javascript:alert(1)" }), SG)).rejects.toThrow(/https/);
    await expect(createEvent(7, 9999, lunch(), SG)).rejects.toMatchObject({ status: 404 });
    await expect(eventsBetween(7, "2026-01-01", "2027-06-01", SG)).rejects.toThrow(/at most/);
    expect(() => cleanFields(lunch({ title: "x".repeat(501) }))).toThrow(/at most 500/);
    await expect(createEvent(7, primary, lunch({ repeat: { freq: "hourly" } }), SG)).rejects.toThrow(/how often/);
    await expect(createEvent(7, primary, lunch({ repeat: { freq: "daily", until: "2026-10-01" } }), SG)).rejects.toThrow(/before it starts/);
    await expect(createEvent(7, primary, lunch({ repeat: { freq: "weekly", days: ["XX"] } }), SG)).rejects.toThrow(/days of the week/);
  });
});
