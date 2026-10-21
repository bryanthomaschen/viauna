// VTIMEZONE definitions built from the IANA database (server/vtimezone.ts): read back
// through ical.js, as another app reads them, they give the zone's own offsets, in the
// years asked for and after, where the rule still holds. Checked the way an event's time
// is read, a wall-clock time in the zone to an instant (ical.js's other way, from UTC,
// is off near a change of offset even with Google's own definitions).
import ICAL from "ical.js";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";
import { vtimezone } from "../server/vtimezone.ts";

/** An instant's wall-clock time in the zone (IANA), and that time back to an instant through the VTIMEZONE. */
const wallAt = (zone: string, ms: number) => Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).toPlainDateTime();
const back = (tz: InstanceType<typeof ICAL.Timezone>, w: Temporal.PlainDateTime) =>
  ICAL.Time.fromData({ year: w.year, month: w.month, day: w.day, hour: w.hour, minute: w.minute, second: w.second, isDate: false }, tz).toUnixTime() * 1000;
/** A wall-clock time that happens twice, when the clocks go back, names no one instant. */
const twice = (zone: string, w: Temporal.PlainDateTime) =>
  w.toZonedDateTime(zone, { disambiguation: "earlier" }).epochMilliseconds !== w.toZonedDateTime(zone, { disambiguation: "later" }).epochMilliseconds;

describe("VTIMEZONE", () => {
  it.each([
    "Europe/London", "America/New_York", "Australia/Sydney", "Asia/Singapore", "America/Sao_Paulo",
    "Pacific/Chatham", "Asia/Tehran", "Europe/Dublin", "America/Santiago", "Asia/Kolkata", "Pacific/Auckland",
    "Africa/Casablanca", "Europe/Moscow", "America/Havana", "UTC",
  ])("gives %s's offsets, every 6 days from 2005 to 2045", (zone) => {
    const tz = new ICAL.Timezone(vtimezone(zone, 2005, 2028));
    const wrong: string[] = [];
    for (let ms = Date.parse("2005-01-02T00:00Z"); ms < Date.parse("2045-12-31T00:00Z"); ms += 6 * 86_400_000 + 3_600_000) {
      const w = wallAt(zone, ms);
      if (!twice(zone, w) && back(tz, w) !== ms) wrong.push(`${w}: ${new Date(back(tz, w)).toISOString()} for ${new Date(ms).toISOString()}`);
    }
    expect(wrong.slice(0, 3)).toEqual([]);
  });

  it("says a yearly change as a rule, open ended, as Google's and Apple's do", () => {
    const text = vtimezone("America/New_York", 2010, 2028).toString();
    expect(text).toContain("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU");
    expect(text).toContain("RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU");
    expect(text).toContain("TZNAME:EDT");
    expect(text).not.toContain("UNTIL");
    // Europe's last Sunday, not its fourth.
    expect(vtimezone("Europe/London", 2010, 2028).toString()).toContain("BYMONTH=3;BYDAY=-1SU");
  });

  it("says Chile's first Sunday on or after the 2nd the way RFC 5545 can", () => {
    expect(vtimezone("America/Santiago", 2010, 2028).toString()).toContain("BYMONTH=9;BYDAY=SU;BYMONTHDAY=2,3,4,5,6,7,8");
  });

  it("ends a rule a zone stopped using, and keeps a zone without changes to one offset", () => {
    // Brazil stopped daylight saving in 2019: every rule it had ends.
    const rules = vtimezone("America/Sao_Paulo", 2010, 2028).toString().replace(/\r\n /g, "").match(/^RRULE:.*$/gm) ?? [];
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.filter((r) => !/UNTIL=20(1\d|2[0-1])/.test(r))).toEqual([]);
    const sg = vtimezone("Asia/Singapore", 2010, 2028).toString();
    expect(sg).toContain("TZOFFSETFROM:+0800");
    expect(sg).not.toContain("RRULE");
  });
});
