// Per-mailbox settings, shared by every browser signed in to it. Kept in the state
// store with the account, along with the senders whose images are always shown.
import { EventEmitter } from "node:events";
import { type Reminder, isZone } from "./icalendar.ts";
import { orIgnore, state } from "./state/db.ts";

/** "changed" with the account id, when a mailbox's settings change (for other open tabs). */
export const accountSettingsEvents = new EventEmitter();
accountSettingsEvents.setMaxListeners(1000);

export interface AccountSettings {
  /** Display name for outgoing mail. */
  name: string;
  /** HTML signature appended to new messages and replies. */
  signature: string;
  /** "ask": block remote images until allowed; "always": load them. */
  images: "ask" | "always";
  pageSize: 25 | 50 | 100;
  /** The calendar's time zone (IANA); empty: whichever the browser is in. */
  timeZone: string;
  /** A second time zone shown beside the calendar's times; empty: none. */
  secondTimeZone: string;
  /** The calendar's first day of the week; "auto" follows the browser's language. */
  weekStart: "auto" | "sunday" | "monday" | "saturday";
  /** How long a new event lasts, in minutes. */
  eventMinutes: 15 | 30 | 45 | 60 | 90 | 120;
  /** The reminders a new event gets: timed, and all-day. */
  reminders: Reminder[];
  allDayReminders: Reminder[];
  /** The zone a page last showed the calendar in, for reminders of all-day events when timeZone is "". Not shown. */
  seenZone: string;
  /** The calendar an invitation goes into when it's answered; null: the mailbox's own. */
  invitationCalendar: number | null;
}

export const DEFAULT_SETTINGS: AccountSettings = {
  name: "",
  signature: "",
  images: "ask",
  pageSize: 50,
  timeZone: "",
  secondTimeZone: "",
  weekStart: "auto",
  eventMinutes: 60,
  reminders: [{ method: "notification", minutes: 10 }],
  allDayReminders: [],
  seenZone: "",
  invitationCalendar: null,
};

/** Fixed limits on reminders (docs/how-it-works/limits.md). */
export const REMINDER_LIMITS = {
  perEvent: 5,
  /** Four weeks and a day before; for an all-day event, up to the end of its day after it starts. */
  before: 41_760,
  after: 1_439,
};

/** Checks reminders the page sent: at most 5, each shown or emailed, within four weeks; each once, earliest first. */
export function cleanReminders(input: unknown): Reminder[] | { error: string } {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > REMINDER_LIMITS.perEvent) return { error: `An event can have at most ${REMINDER_LIMITS.perEvent} reminders.` };
  const out: Reminder[] = [];
  for (const r of input as { method?: unknown; minutes?: unknown }[]) {
    const minutes = Number(r?.minutes);
    if (r?.method !== "notification" && r?.method !== "email") return { error: "A reminder is a notification or an email." };
    if (!Number.isInteger(minutes) || minutes > REMINDER_LIMITS.before || minutes < -REMINDER_LIMITS.after) {
      return { error: "A reminder can be at most four weeks before the event." };
    }
    if (!out.some((x) => x.method === r.method && x.minutes === minutes)) out.push({ method: r.method, minutes });
  }
  return out.sort((a, b) => b.minutes - a.minutes || a.method.localeCompare(b.method));
}

export async function getSettings(accountId: number): Promise<AccountSettings> {
  const row = await state().selectFrom("accounts").select("settings").where("id", "=", accountId).executeTakeFirst();
  let stored: Partial<AccountSettings> = {};
  try {
    stored = JSON.parse(row?.settings ?? "{}");
  } catch {
    stored = {};
  }
  // The addresses sent as were kept here before 0.6; they're in identities.ts now.
  const { aliases: _, ...rest } = stored as Partial<AccountSettings> & { aliases?: unknown };
  return { ...DEFAULT_SETTINGS, ...rest };
}

const MAX_SIGNATURE = 20_000;

/** Validates and merges a partial update. Returns the new settings or an error. */
export async function updateSettings(accountId: number, patch: Record<string, unknown>): Promise<AccountSettings | { error: string }> {
  const next = await getSettings(accountId);
  if ("name" in patch) next.name = String(patch.name ?? "").slice(0, 200).trim();
  if ("signature" in patch) {
    const sig = String(patch.signature ?? "");
    if (sig.length > MAX_SIGNATURE) return { error: "Signature is too long." };
    next.signature = sig;
  }
  if ("images" in patch) next.images = patch.images === "always" ? "always" : "ask";
  if ("pageSize" in patch) {
    const size = Number(patch.pageSize);
    next.pageSize = size === 25 || size === 100 ? size : 50;
  }
  if ("timeZone" in patch) {
    const zone = String(patch.timeZone ?? "");
    if (zone && !isZone(zone)) return { error: `"${zone}" isn't a time zone Viauna knows.` };
    next.timeZone = zone;
  }
  if ("secondTimeZone" in patch) {
    const zone = String(patch.secondTimeZone ?? "");
    if (zone && !isZone(zone)) return { error: `"${zone}" isn't a time zone Viauna knows.` };
    next.secondTimeZone = zone;
  }
  if ("weekStart" in patch) {
    const day = String(patch.weekStart);
    next.weekStart = day === "sunday" || day === "monday" || day === "saturday" ? day : "auto";
  }
  if ("eventMinutes" in patch) {
    const minutes = Number(patch.eventMinutes);
    next.eventMinutes = ([15, 30, 45, 60, 90, 120] as const).find((m) => m === minutes) ?? 60;
  }
  if ("invitationCalendar" in patch) {
    const id = patch.invitationCalendar === null ? null : Number(patch.invitationCalendar);
    if (id !== null && !Number.isInteger(id)) return { error: "Pick a calendar." };
    if (id !== null) {
      const cal = await state().selectFrom("calendars").select("kind").where("account_id", "=", accountId).where("id", "=", id).executeTakeFirst();
      if (!cal || cal.kind !== "events") return { error: "Pick one of your own calendars." };
    }
    next.invitationCalendar = id;
  }
  for (const key of ["reminders", "allDayReminders"] as const) {
    if (!(key in patch)) continue;
    const reminders = cleanReminders(patch[key]);
    if ("error" in reminders) return reminders;
    next[key] = reminders;
  }
  await state().updateTable("accounts").set({ settings: JSON.stringify(next) }).where("id", "=", accountId).execute();
  accountSettingsEvents.emit("changed", accountId);
  return next;
}

/**
 * Notes the zone a page shows the calendar in, for reminders of all-day events when the
 * mailbox has no zone of its own. Quietly: it isn't a setting anyone changed.
 */
export async function noteSeenZone(accountId: number, zone: string): Promise<void> {
  if (!isZone(zone)) return;
  const current = await getSettings(accountId);
  if (current.seenZone === zone) return;
  await state().updateTable("accounts").set({ settings: JSON.stringify({ ...current, seenZone: zone }) }).where("id", "=", accountId).execute();
}

/** The zone a mailbox's reminders are worked out in: its own, else the one last seen, else UTC. */
export async function reminderZone(accountId: number): Promise<string> {
  const s = await getSettings(accountId);
  return s.timeZone || s.seenZone || "UTC";
}

/** Senders whose remote images this account always shows. */
export async function isTrustedSender(accountId: number, address: string): Promise<boolean> {
  const row = await state()
    .selectFrom("trusted_senders")
    .select("address")
    .where("account_id", "=", accountId)
    .where("address", "=", address)
    .executeTakeFirst();
  return !!row;
}

export async function trustSender(accountId: number, address: string) {
  await orIgnore(state().insertInto("trusted_senders").values({ account_id: accountId, address })).execute();
}
