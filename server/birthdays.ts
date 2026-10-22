// The Birthdays calendar: the birthdays, anniversaries and other dates in a mailbox's
// contacts (kept beside each card, contacts.ts), made into all-day events as the
// calendar asks for them and never stored, so a date changed in Contacts is right at
// once. It can't be changed from the calendar. 29 February falls on the 28th in other
// years. Exported, each date is a yearly event, without the ages a file can't know.
import ICAL from "ical.js";
import type { EventSummary } from "./calendar.ts";
import { type ContactDateTable, state } from "./state/db.ts";

interface DateRow {
  contact_id: number;
  uid: string;
  name: string;
  position: number;
  kind: ContactDateTable["kind"];
  label: string;
  year: number | null;
  month: number;
  day: number;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const leap = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

/** The day a date comes round in a year: 29 February is the 28th when the year has none. */
function inYear(year: number, month: number, day: number): string {
  const d = month === 2 && day === 29 && !leap(year) ? 28 : day;
  return `${pad(year, 4)}-${pad(month)}-${pad(d)}`;
}

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function dateRows(accountId: number): Promise<DateRow[]> {
  return state()
    .selectFrom("contact_dates as d")
    .innerJoin("contacts as c", "c.id", "d.contact_id")
    .select(["d.contact_id", "c.uid", "c.name", "d.position", "d.kind", "d.label", "d.year", "d.month", "d.day"])
    .where("d.account_id", "=", accountId)
    .execute();
}

/**
 * "Ann Lee's birthday (40)", "Ann Lee's anniversary (12 years)", "Ann Lee: First day
 * at work (3 years)": with the age or the years when the date's year is known and `year`
 * is given, the year it comes round in.
 */
export function titleFor(row: Pick<DateRow, "name" | "kind" | "label" | "year">, year: number | null): string {
  const n = row.year !== null && year !== null ? year - row.year : 0;
  if (row.kind === "birthday") return `${row.name}'s birthday${n > 0 ? ` (${n})` : ""}`;
  const years = n > 0 ? ` (${n} ${n === 1 ? "year" : "years"})` : "";
  if (row.kind === "anniversary") return `${row.name}'s anniversary${years}`;
  return `${row.name}: ${row.label || "a date"}${years}`;
}

/** The dates from one day up to (not including) another, as the calendar shows them. */
export async function birthdaysBetween(accountId: number, calendarId: number, from: string, to: string): Promise<EventSummary[]> {
  const out: EventSummary[] = [];
  const first = Number(from.slice(0, 4));
  const last = Number(to.slice(0, 4));
  for (const row of await dateRows(accountId)) {
    for (let year = first; year <= last; year++) {
      if (row.year !== null && year < row.year) continue;
      const date = inYear(year, row.month, row.day);
      if (date < from || date >= to) continue;
      out.push({
        id: row.contact_id,
        calendarId,
        // Which date of the contact's, on which day: a key for the page, not an iCalendar occurrence.
        occurrence: `${date.replace(/-/g, "")}.${row.position}`,
        recurring: false,
        title: titleFor(row, year),
        allDay: true,
        start: date,
        end: nextDay(date),
        color: null,
        busy: false,
        location: "",
        video: false,
        readOnly: true,
        contactId: row.contact_id,
        response: null,
      });
    }
  }
  return out;
}

/**
 * Every date as a yearly all-day event, shown as free, for a calendar file or a secret
 * address: from the year it happened, or 2000 when that isn't known (a leap year, so
 * 29 February is a date). 29 February repeats on the last day of February.
 */
export async function birthdayObjects(accountId: number, prodid: string): Promise<InstanceType<typeof ICAL.Component>[]> {
  const stamp = ICAL.Time.fromJSDate(new Date(), true);
  return (await dateRows(accountId)).map((row) => {
    const root = new ICAL.Component(["vcalendar", [], []]);
    root.updatePropertyWithValue("version", "2.0");
    root.updatePropertyWithValue("prodid", prodid);
    const event = new ICAL.Component("vevent", root);
    root.addSubcomponent(event);
    const start = `${pad(row.year ?? 2000, 4)}-${pad(row.month)}-${pad(row.day)}`;
    event.updatePropertyWithValue("uid", `${row.kind}-${row.position}-${row.uid}`);
    event.updatePropertyWithValue("dtstamp", stamp);
    event.updatePropertyWithValue("dtstart", ICAL.Time.fromDateString(start));
    event.updatePropertyWithValue("dtend", ICAL.Time.fromDateString(nextDay(start)));
    event.updatePropertyWithValue("rrule", ICAL.Recur.fromString(row.month === 2 && row.day === 29 ? "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1" : "FREQ=YEARLY"));
    event.updatePropertyWithValue("summary", titleFor(row, null));
    event.updatePropertyWithValue("transp", "TRANSPARENT");
    return root;
  });
}
