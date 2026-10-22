// Reminders (server/reminders.ts) on each state-store engine: when each falls due, sent
// once, never more than 15 minutes late, worked out in the mailbox's zone, and only for
// calendars kept here. Times are relative to now, since saving an event marks it looked at
// now; sendDueReminders is told what time it is.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEvent, deleteEvent, listCalendars, undoChange, updateEvent } from "../server/calendar.ts";
import { sha256 } from "../server/crypto.ts";
import { type Notice, addReminderChannel, sendDueReminders } from "../server/reminders.ts";
import { updateSettings } from "../server/settings.ts";
import { type StateStore, openState, setState, state } from "../server/state/db.ts";
import { ENGINES, emptyDatabase } from "./databases.ts";

const SG = "Asia/Singapore";
const MIN = 60_000;
const sent: Notice[] = [];
addReminderChannel(async (n) => {
  sent.push(n);
});

/** A wall-clock time in Singapore (UTC+8, no clock changes), so many minutes from `base`. */
const sgWall = (ms: number) => new Date(ms + 8 * 3_600_000).toISOString().slice(0, 16);

describe.each(ENGINES)("reminders on $name", ({ url }) => {
  let store: StateStore;
  let dir: string;
  let primary: number;
  const imap = JSON.stringify({ host: "imap.example.test", port: 993, security: "tls", servername: null, verify: true });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "viauna-reminders-"));
    if (url) await emptyDatabase(url);
    store = await openState(url, path.join(dir, "state.db"));
  });

  afterAll(async () => {
    await store.db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    setState(store);
    sent.length = 0;
    await state().deleteFrom("events").execute();
    await state().deleteFrom("calendars").execute();
    await state().deleteFrom("accounts").execute();
    await state().insertInto("accounts").values({ id: 7, login: "me@example.test", email: "me@example.test", imap, imap_hash: sha256(imap), smtp: "{}", settings: JSON.stringify({ timeZone: SG }), created_at: 1 }).execute();
    primary = (await listCalendars(7, "Me"))[0].id;
  });

  afterEach(() => setState(null));

  const timed = (startIn: number, minutes: number, over: Record<string, unknown> = {}) => {
    const start = Math.ceil((Date.now() + startIn * MIN) / MIN) * MIN;
    return {
      start,
      input: { title: "Standup", allDay: false, start: sgWall(start), end: sgWall(start + 15 * MIN), zone: SG, reminders: [{ method: "notification", minutes }], ...over },
    };
  };

  it("sends a reminder once, when it's due, and works out the next of a repeating event", async () => {
    const { start, input } = timed(30, 10, { repeat: { freq: "daily", interval: 1 } });
    const ev = await createEvent(7, primary, input, SG);
    expect(ev.reminders).toEqual([{ method: "notification", minutes: 10 }]);
    // Saving makes it due at once, to be worked out: nothing yet.
    expect(await sendDueReminders(Date.now())).toBe(0);
    const row = await state().selectFrom("events").select("alarm_at").executeTakeFirstOrThrow();
    expect(row.alarm_at).toBe(start - 10 * MIN);

    expect(await sendDueReminders(start - 10 * MIN + 1000)).toBe(1);
    expect(sent[0]).toMatchObject({ accountId: 7, eventId: ev.id, method: "notification", minutes: 10, title: "Standup", allDay: false, at: start - 10 * MIN });
    expect(sent[0].start).toBe(new Date(start).toISOString());
    // Not again, and the next is tomorrow's.
    expect(await sendDueReminders(start - 5 * MIN)).toBe(0);
    const next = await state().selectFrom("events").select("alarm_at").executeTakeFirstOrThrow();
    expect(next.alarm_at).toBe(start + 1440 * MIN - 10 * MIN);
  });

  it("skips a reminder more than 15 minutes late, and sends one that's late by less", async () => {
    const a = timed(30, 10);
    await createEvent(7, primary, a.input, SG);
    await sendDueReminders(Date.now());
    expect(await sendDueReminders(a.start - 10 * MIN + 16 * MIN)).toBe(0);
    await state().deleteFrom("events").execute();
    const b = timed(30, 10);
    await createEvent(7, primary, b.input, SG);
    await sendDueReminders(Date.now());
    expect(await sendDueReminders(b.start - 10 * MIN + 14 * MIN)).toBe(1);
  });

  it("works out an all-day event's reminders in the mailbox's zone", async () => {
    const tomorrow = new Date(Date.now() + 8 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);
    const after = new Date(Date.parse(`${tomorrow}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    // On the day, at 09:00 in Singapore: 01:00 UTC.
    await createEvent(7, primary, { title: "Holiday", allDay: true, start: tomorrow, end: after, reminders: [{ method: "notification", minutes: -540 }] }, SG);
    await sendDueReminders(Date.now());
    const row = await state().selectFrom("events").select("alarm_at").executeTakeFirstOrThrow();
    expect(new Date(row.alarm_at!).toISOString()).toBe(`${tomorrow}T01:00:00.000Z`);
  });

  it("gives a new event the mailbox's usual reminders, and none to one that asks for none", async () => {
    await updateSettings(7, { reminders: [{ method: "notification", minutes: 30 }], allDayReminders: [{ method: "notification", minutes: 900 }] });
    const { input } = timed(60, 0);
    const { reminders: _r, ...plain } = input;
    expect((await createEvent(7, primary, plain, SG)).reminders).toEqual([{ method: "notification", minutes: 30 }]);
    expect((await createEvent(7, primary, { title: "Off", allDay: true, start: "2027-01-01", end: "2027-01-02" }, SG)).reminders).toEqual([{ method: "notification", minutes: 900 }]);
    expect((await createEvent(7, primary, { ...plain, reminders: [] }, SG)).reminders).toEqual([]);
    await expect(createEvent(7, primary, { ...plain, reminders: [{ method: "pigeon", minutes: 5 }] }, SG)).rejects.toThrow(/notification or an email/);
    await expect(createEvent(7, primary, { ...plain, reminders: Array.from({ length: 6 }, (_, i) => ({ method: "notification", minutes: i })) }, SG)).rejects.toThrow(/at most 5/);
  });

  it("works out again when an event changes, and sends one reminder however many instances look", async () => {
    const { start, input } = timed(30, 10);
    const ev = await createEvent(7, primary, input, SG);
    await sendDueReminders(Date.now());
    // Moved an hour later, then back with Undo.
    const { undo } = await updateEvent(7, ev.id, { start: sgWall(start + 60 * MIN), end: sgWall(start + 75 * MIN) }, SG);
    await sendDueReminders(Date.now());
    expect((await state().selectFrom("events").select("alarm_at").executeTakeFirstOrThrow()).alarm_at).toBe(start + 50 * MIN);
    await undoChange(7, undo);
    await sendDueReminders(Date.now());
    expect((await state().selectFrom("events").select("alarm_at").executeTakeFirstOrThrow()).alarm_at).toBe(start - 10 * MIN);
    const counts = await Promise.all([sendDueReminders(start - 9 * MIN), sendDueReminders(start - 9 * MIN)]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    // Deleted: nothing more.
    await deleteEvent(7, ev.id);
    expect(await state().selectFrom("events").select("id").execute()).toEqual([]);
  });

  it("has no reminders to work out for an event without any", async () => {
    const { input } = timed(30, 10);
    await createEvent(7, primary, { ...input, reminders: [] }, SG);
    expect((await state().selectFrom("events").select("alarm_at").executeTakeFirstOrThrow()).alarm_at).toBeNull();
  });
});
