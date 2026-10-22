// Reminders as they fall due. Each event keeps when its next reminder is due (alarm_at,
// set to 0 whenever it's saved: "work it out"), and when they were last looked at. Every
// 30 seconds the due events are claimed (alarm_at moved on, only if no other instance
// has), the reminders that came due since they were last looked at are sent, and the next
// one is worked out. A reminder that came due while Viauna was down is sent if it's at
// most 15 minutes late, and skipped after that. Times are in the mailbox's zone, which
// matters for all-day and floating events (settings.ts, reminderZone).
//
// Sending is the channels' business: the pages open on the mailbox (app.ts, the
// live-update stream), browsers' notifications and email register here.
import { EventEmitter } from "node:events";
import { setting } from "./config.ts";
import { type Component, type Reminder, eventTimes, instantIn, masterEvent, parseCalendar, readReminders, videoProperty } from "./icalendar.ts";
import { log } from "./log.ts";
import { type Occurrence, occurrences, seriesSpan } from "./recurrence.ts";
import { reminderZone } from "./settings.ts";
import { state } from "./state/db.ts";

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Fixed limits (docs/how-it-works/limits.md). */
export const REMINDER_TIMING = {
  /** How often due reminders are looked for. */
  tickMs: 30_000,
  /** A reminder later than this (Viauna was down) is skipped. */
  staleMs: 15 * MINUTE,
  /** How far ahead the next reminder is looked for; past that, it's looked for again then. */
  horizonMs: 62 * DAY,
};

/** A reminder that's due: what it's for, and how. */
export interface Notice {
  accountId: number;
  eventId: number;
  /** Which occurrence, for an event that repeats. */
  occurrence: string | null;
  method: Reminder["method"];
  minutes: number;
  /** When it was due. */
  at: number;
  title: string;
  allDay: boolean;
  /** An all-day event's dates (end exclusive), else ISO instants. */
  start: string;
  end: string;
  location: string;
  video: string | null;
  /** The zone the times were worked out in. */
  zone: string;
}

type Channel = (notice: Notice) => Promise<void>;
const channels: Channel[] = [];

/** Something that sends reminders: each due reminder is given to every one, and a failure in one doesn't stop the others. */
export function addReminderChannel(channel: Channel) {
  channels.push(channel);
}

/** "reminder" with each notice: the live-update stream passes it to the mailbox's open pages. */
export const reminderEvents = new EventEmitter();
reminderEvents.setMaxListeners(1000);
addReminderChannel(async (notice) => {
  if (notice.method === "notification") reminderEvents.emit("reminder", notice);
});

const text = (event: Component, name: string) => String(event.getFirstPropertyValue(name) ?? "").trim();

/** An occurrence's reminders that fall in (from, to], each with when it's due. */
function dueIn(occ: Occurrence, zone: string, from: number, to: number): { reminder: Reminder; at: number }[] {
  const start = instantIn(occ.start, zone);
  return readReminders(occ.event)
    .map((reminder) => ({ reminder, at: start - reminder.minutes * MINUTE }))
    .filter((r) => r.at > from && r.at <= to);
}

/** The occurrences whose reminders could fall in (from, to]: those starting from four weeks after `from` back, to a day after `to`. */
function candidates(root: Component, zone: string, from: number, to: number): Occurrence[] {
  const lo = from - DAY;
  const hi = to + 29 * DAY;
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return occurrences(root, zone, { fromMs: lo, toMs: hi, fromDate: date(lo - DAY), toDate: date(hi + DAY) });
}

/** The reminders of an event that fall due in (from, to], in order. */
export function remindersBetween(root: Component, zone: string, from: number, to: number): { occ: Occurrence; reminder: Reminder; at: number }[] {
  return candidates(root, zone, from, to)
    .flatMap((occ) => dueIn(occ, zone, from, to).map((r) => ({ occ, ...r })))
    .sort((a, b) => a.at - b.at);
}

/**
 * When an event's next reminder after `after` is due; or, if none is due within the
 * horizon, when to look again; or null if it has none to come (no reminders, or over).
 */
export function nextReminder(root: Component, zone: string, after: number): number | null {
  const master = masterEvent(root);
  if (!master || !eventTimes(master, root)) return null;
  if (!root.getAllSubcomponents("vevent").some((e) => readReminders(e).length)) return null;
  // Nothing starts after the last occurrence's end (with a day either way for floating times).
  if (seriesSpan(root).end + DAY < after) return null;
  const until = after + REMINDER_TIMING.horizonMs;
  const first = remindersBetween(root, zone, after, until)[0];
  return first ? first.at : until;
}

function noticeOf(accountId: number, eventId: number, occ: Occurrence, reminder: Reminder, at: number, zone: string): Notice {
  const iso = (m: Occurrence["start"]) => (m.kind === "date" ? m.date : new Date(instantIn(m, zone)).toISOString());
  return {
    accountId, eventId, occurrence: occ.key, method: reminder.method, minutes: reminder.minutes, at,
    title: text(occ.event, "summary"), allDay: occ.start.kind === "date", start: iso(occ.start), end: iso(occ.end),
    location: text(occ.event, "location"), video: (videoProperty(occ.event)?.getFirstValue() as string | undefined) ?? null, zone,
  };
}

async function deliver(notice: Notice) {
  for (const channel of channels) {
    try {
      await channel(notice);
    } catch (err) {
      log.warn("a reminder couldn't be sent", { account: notice.accountId, event: notice.eventId, method: notice.method, error: (err as Error).message });
    }
  }
}

/**
 * Sends the reminders that are due, and works out each event's next. Returns how many
 * were sent. Only events in calendars kept here remind: a calendar from the web's
 * reminders are its owner's.
 */
export async function sendDueReminders(now = Date.now(), limit = 200): Promise<number> {
  if (!setting("calendar")) return 0;
  const due = await state()
    .selectFrom("events as e")
    .innerJoin("calendars as c", "c.id", "e.calendar_id")
    .select(["e.id", "e.account_id", "e.ics", "e.alarm_at", "e.alarm_checked_at", "c.kind"])
    .where("e.alarm_at", "<=", now)
    .orderBy("e.alarm_at")
    .limit(limit)
    .execute();
  let sent = 0;
  for (const row of due) {
    // Claimed for a minute: if this instance stops mid-way, another takes it up then.
    const claimedUntil = now + MINUTE;
    const claim = await state()
      .updateTable("events")
      .set({ alarm_at: claimedUntil })
      .where("id", "=", row.id)
      .where("alarm_at", "=", row.alarm_at)
      .executeTakeFirst();
    if (!Number(claim.numUpdatedRows)) continue;
    let next: number | null = null;
    try {
      if (row.kind === "events") {
        const root = parseCalendar(row.ics);
        const zone = await reminderZone(row.account_id);
        // Since they were last looked at, but nothing more than 15 minutes late.
        const since = Math.max(row.alarm_checked_at ?? now, now - REMINDER_TIMING.staleMs);
        for (const r of remindersBetween(root, zone, since, now)) {
          await deliver(noticeOf(row.account_id, row.id, r.occ, r.reminder, r.at, zone));
          sent++;
        }
        next = nextReminder(root, zone, now);
      }
    } catch (err) {
      log.warn("couldn't work out an event's reminders", { event: row.id, error: (err as Error).message });
    }
    // Unless the event was saved meanwhile, which made it due again.
    await state()
      .updateTable("events")
      .set({ alarm_at: next, alarm_checked_at: now })
      .where("id", "=", row.id)
      .where("alarm_at", "=", claimedUntil)
      .execute();
  }
  return sent;
}

/** Looks for due reminders every 30 seconds while Viauna runs. */
export function startReminders(): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    sendDueReminders()
      .catch((err) => log.warn("sending reminders failed", { error: (err as Error).message }))
      .finally(() => (running = false));
  };
  const first = setTimeout(tick, 5_000);
  const timer = setInterval(tick, REMINDER_TIMING.tickMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
