// What the calendar's parts share: the time zone it shows, the first day of its week,
// its colours, and dates and times as it shows them. Times travel as wall-clock strings
// in the calendar's zone ("2026-10-21T09:00") or as ISO instants; Temporal (the polyfill
// FullCalendar brings) converts between them.
import { Temporal } from "temporal-polyfill";
import { ui, useAccount } from "./account";
import type { CalendarView } from "./router";
import type { RepeatRule, Scope, Settings, Weekday } from "./types";

export const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** The zone the calendar shows times in: the mailbox's setting, or the browser's. */
export function useCalendarZone(): string {
  return useAccount().settings?.timeZone || browserZone();
}

type WeekInfoLocale = Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };

/** 0 for Sunday to 6 for Saturday: the setting, or what the browser's language says. */
export function firstDay(setting: Settings["weekStart"] | undefined): number {
  if (setting === "sunday") return 0;
  if (setting === "monday") return 1;
  if (setting === "saturday") return 6;
  try {
    const locale = new Intl.Locale(navigator.language) as WeekInfoLocale;
    const info = locale.getWeekInfo?.() ?? locale.weekInfo;
    if (info) return info.firstDay % 7;
  } catch {
    // an odd language tag: Sunday, as in the US
  }
  return 0;
}

/** Colours for calendars and events, by their CSS names (what iCalendar's COLOR holds). */
export const COLORS = [
  { name: "tomato", label: "Tomato", hex: "#ff6347" },
  { name: "palevioletred", label: "Pink", hex: "#db7093" },
  { name: "darkorange", label: "Orange", hex: "#ff8c00" },
  { name: "gold", label: "Yellow", hex: "#ffd700" },
  { name: "mediumseagreen", label: "Green", hex: "#3cb371" },
  { name: "seagreen", label: "Dark green", hex: "#2e8b57" },
  { name: "dodgerblue", label: "Blue", hex: "#1e90ff" },
  { name: "royalblue", label: "Royal blue", hex: "#4169e1" },
  { name: "slateblue", label: "Violet", hex: "#6a5acd" },
  { name: "darkorchid", label: "Purple", hex: "#9932cc" },
  { name: "sienna", label: "Brown", hex: "#a0522d" },
  { name: "dimgray", label: "Grey", hex: "#696969" },
];

export const colorLabel = (name: string) => COLORS.find((c) => c.name === name)?.label ?? name;

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** White or near-black, whichever reads better on the colour (WCAG contrast). */
export function textOnColor(color: string): string {
  const hex = COLORS.find((c) => c.name === color)?.hex ?? (/^#[0-9a-f]{6}$/i.test(color) ? color : null);
  if (!hex) return "#ffffff";
  const l = luminance(hex);
  return (1.05) / (l + 0.05) >= (l + 0.05) / (luminance("#1f1f1f") + 0.05) ? "#ffffff" : "#1f1f1f";
}

// ---------------------------------------------------------------- dates and times

export const today = (zone: string): string => Temporal.Now.plainDateISO(zone).toString();

export const addDays = (date: string, days: number): string => Temporal.PlainDate.from(date).add({ days }).toString();

/** An instant as the wall-clock time in a zone: "2026-10-21T09:00". */
export const instantToWall = (instant: string | number, zone: string): string =>
  (typeof instant === "number" ? Temporal.Instant.fromEpochMilliseconds(instant) : Temporal.Instant.from(instant))
    .toZonedDateTimeISO(zone)
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" });

/** A wall-clock time in a zone as epoch milliseconds (a time a clock change skips moves on). */
export const wallToMs = (wall: string, zone: string): number => Temporal.PlainDateTime.from(wall).toZonedDateTime(zone).epochMilliseconds;

/** Minutes added to a wall-clock time, through the zone, so they're real minutes. */
export const addMinutes = (wall: string, minutes: number, zone: string): string => instantToWall(wallToMs(wall, zone) + minutes * 60_000, zone);

/** The current time in a zone, rounded up to the next half hour: when a new event starts. */
export function nextHalfHour(zone: string): string {
  const now = Temporal.Now.zonedDateTimeISO(zone);
  const rounded = now.round({ smallestUnit: "minute", roundingIncrement: 30, roundingMode: "ceil" });
  return rounded.toPlainDateTime().toString({ smallestUnit: "minute" });
}

/** A date or wall-clock string as a Date whose UTC fields are its own, for formatting with timeZone "UTC". */
const asUtc = (value: string) => new Date(`${value.length === 10 ? `${value}T00:00` : value}:00Z`);

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { ...opts, timeZone: "UTC" });

export const formatDay = (date: string, long = true) => fmt(long ? { weekday: "long", day: "numeric", month: "long" } : { weekday: "short", day: "numeric", month: "short" }).format(asUtc(date));

/** "Wednesday, 21 October · 12:00 – 13:00", "21 – 23 October", as the event card says it. */
export function formatWhen(e: { allDay: boolean; start: string; end: string }): string {
  if (e.allDay) {
    const last = addDays(e.end, -1);
    return last === e.start ? formatDay(e.start) : fmt({ day: "numeric", month: "long", year: "numeric" }).formatRange(asUtc(e.start), asUtc(last));
  }
  const day = e.start.slice(0, 10);
  if (e.end.slice(0, 10) === day) return `${formatDay(day)} · ${fmt({ hour: "numeric", minute: "2-digit" }).formatRange(asUtc(e.start), asUtc(e.end))}`;
  return fmt({ day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).formatRange(asUtc(e.start), asUtc(e.end));
}

/** "UTC+8", for showing which zone times are in. */
export function zoneOffset(zone: string, at = Date.now()): string {
  const offset = Temporal.Instant.fromEpochMilliseconds(at).toZonedDateTimeISO(zone).offset;
  const [, sign, h, m] = /^([+-])(\d\d):(\d\d)/.exec(offset) ?? [];
  if (!sign) return "UTC";
  return `UTC${sign}${Number(h)}${m === "00" ? "" : `:${m}`}`;
}

// ---------------------------------------------------------------- views

export const VIEW_LABELS: Record<CalendarView, string> = { day: "Day", week: "Week", month: "Month", schedule: "Schedule", "4days": "4 days" };

/** The single key that switches to each view, as in Google Calendar. */
export const VIEW_KEYS: Record<CalendarView, string> = { day: "d", week: "w", month: "m", schedule: "a", "4days": "x" };

// ---------------------------------------------------------------- repeating

export const WEEKDAYS: Weekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** The weekday a date falls on. */
export const weekdayOf = (date: string): Weekday => WEEKDAYS[Temporal.PlainDate.from(date.slice(0, 10)).dayOfWeek - 1];

/** "Monday", from a Monday in 2024 (1 January). */
export const dayName = (d: Weekday, style: "long" | "short" = "long") =>
  fmt({ weekday: style }).format(new Date(Date.UTC(2024, 0, 1 + WEEKDAYS.indexOf(d))));

const ORDINALS: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", [-1]: "last" };

/** Which of its weekday in the month a date is (the third Wednesday), and whether it's also the last. */
export function nthOf(date: string): { week: number; last: boolean } {
  const d = Temporal.PlainDate.from(date.slice(0, 10));
  return { week: Math.ceil(d.day / 7), last: d.day + 7 > d.daysInMonth };
}

const list = (items: string[]) => new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(items);

/** "Weekly on Monday and Wednesday, until 30 June 2027", as the editor and an event's card say it. */
export function repeatText(rule: RepeatRule, start: string): string {
  if (rule.custom) return "Repeats, by a rule made in another app";
  const n = rule.interval || 1;
  const date = start.slice(0, 10);
  let text: string;
  if (rule.freq === "daily") text = n === 1 ? "Daily" : `Every ${n} days`;
  else if (rule.freq === "weekly") {
    const days = rule.days?.length ? rule.days : [weekdayOf(date)];
    if (n === 1 && days.join() === "MO,TU,WE,TH,FR") text = "Every weekday (Monday to Friday)";
    else text = `${n === 1 ? "Weekly" : `Every ${n} weeks`} on ${list(days.map((d) => dayName(d)))}`;
  } else if (rule.freq === "monthly") {
    const on = rule.nth ? `the ${ORDINALS[rule.nth.week]} ${dayName(rule.nth.day)}` : `day ${Temporal.PlainDate.from(date).day}`;
    text = `${n === 1 ? "Monthly" : `Every ${n} months`} on ${on}`;
  } else {
    text = `${n === 1 ? "Annually" : `Every ${n} years`} on ${fmt({ day: "numeric", month: "long" }).format(asUtc(date))}`;
  }
  if (rule.count) text += rule.count === 1 ? ", once" : `, ${rule.count} times`;
  else if (rule.until) text += `, until ${fmt({ day: "numeric", month: "long", year: "numeric" }).format(asUtc(rule.until))}`;
  return text;
}

/** The repeats the editor offers for an event starting on `start`, as Google Calendar does. */
export function repeatPresets(start: string): { label: string; rule: RepeatRule | null }[] {
  const date = start.slice(0, 10);
  const day = weekdayOf(date);
  const { week, last } = nthOf(date);
  const monthly = (w: number): RepeatRule => ({ freq: "monthly", interval: 1, nth: { week: w, day } });
  const rules: (RepeatRule | null)[] = [
    null,
    { freq: "daily", interval: 1 },
    { freq: "weekly", interval: 1 },
    ...(week <= 4 ? [monthly(week)] : []),
    ...(last ? [monthly(-1)] : []),
    { freq: "yearly", interval: 1 },
    { freq: "weekly", interval: 1, days: ["MO", "TU", "WE", "TH", "FR"] },
  ];
  return rules.map((rule) => ({ label: rule ? repeatText(rule, date) : "Does not repeat", rule }));
}

/** Whether two rules say the same (the server's sameRule). */
export function sameRule(a: RepeatRule | null, b: RepeatRule | null): boolean {
  const norm = (r: RepeatRule | null) => r && JSON.stringify([r.freq, r.interval || 1, r.days ?? [], r.nth ?? null, r.until ?? null, r.count ?? null, r.custom ?? null]);
  return norm(a) === norm(b);
}

/**
 * Asks which occurrences of a repeating event a change or a deletion is for: this event,
 * this and following, or all. A new repeat rule can't be for one occurrence alone.
 */
export function askScope(action: "change" | "delete", ruleChanged = false): Promise<Scope | null> {
  return new Promise((resolve) => ui.set((s) => ({ ...s, scopeDialog: { action, ruleChanged, resolve } })));
}
