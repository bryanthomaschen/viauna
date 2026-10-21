// What the calendar's parts share: the time zone it shows, the first day of its week,
// its colours, and dates and times as it shows them. Times travel as wall-clock strings
// in the calendar's zone ("2026-10-21T09:00") or as ISO instants; Temporal (the polyfill
// FullCalendar brings) converts between them.
import { Temporal } from "temporal-polyfill";
import { useAccount } from "./account";
import type { CalendarView } from "./router";
import type { Settings } from "./types";

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
