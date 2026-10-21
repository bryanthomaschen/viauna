// Calendars and events (server/calendar.ts) on each state-store engine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CalendarError,
  cleanFields,
  createCalendar,
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

  it("makes the mailbox's own calendar once, even when asked for at the same moment", async () => {
    await state().deleteFrom("calendars").execute();
    const lists = await Promise.all([listCalendars(7, "Me"), listCalendars(7, "Me"), listCalendars(7, "Me")]);
    for (const list of lists) expect(list).toEqual([expect.objectContaining({ name: "Me", primary: true, visible: true })]);
    const rows = await state().selectFrom("calendars").select("id").execute();
    expect(rows).toHaveLength(1);
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
    expect((await listCalendars(7, "Me")).map((c) => c.name)).toEqual(["Me Myself"]);
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

  it("refuses times it can't use, and calendars that aren't the mailbox's", async () => {
    await expect(createEvent(7, primary, lunch({ end: "2026-10-21T11:00" }), SG)).rejects.toThrow(/before it starts/);
    await expect(createEvent(7, primary, lunch({ zone: "Mars/Olympus" }), SG)).rejects.toThrow(/time zone/);
    await expect(createEvent(7, primary, lunch({ start: "2026-02-30T09:00" }), SG)).rejects.toThrow(/start and an end/);
    await expect(createEvent(7, primary, { title: "x", allDay: true, start: "2026-10-21", end: "2026-10-21" }, SG)).rejects.toThrow(/before it starts/);
    await expect(createEvent(7, primary, lunch({ video: "javascript:alert(1)" }), SG)).rejects.toThrow(/https/);
    await expect(createEvent(7, 9999, lunch(), SG)).rejects.toMatchObject({ status: 404 });
    await expect(eventsBetween(7, "2026-01-01", "2027-06-01", SG)).rejects.toThrow(/at most/);
    expect(() => cleanFields(lunch({ title: "x".repeat(501) }))).toThrow(/at most 500/);
  });
});
