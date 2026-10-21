# Calendar

How Viauna keeps calendars and events, and how it handles times and time zones. For using
the calendar, see [Calendar](../using/calendar.md).

## Where calendars are kept

Viauna keeps each mailbox's calendars itself, in its [state store](./data.md), with no
other server to set up. There is no copy anywhere else, so back up the state store: see
[Upgrades and backups](../self-hosting/upgrading.md#backing-up).

- The mailbox's own calendar is made the first time its calendar is opened, named after
  the mailbox (its name in Settings, or its address). Only one is made, even when two
  pages open at the same moment. It can be renamed, not deleted.
- Each calendar has a name, a colour, a place in the list and whether it's shown. Hiding
  one is kept with the mailbox, so it's hidden in every browser.
- Deleting a calendar deletes its events.

## Each event is kept whole

An event is kept as its iCalendar object (RFC 5545): the event and, later, any changed
occurrences of it, exactly as made. Beside it are its title, a lower-cased text to
search (title, place and description, accents removed) and when it starts and ends. To
change an event, Viauna changes only the fields it shows, and leaves everything else
(guests, alarms, another app's own properties) as it was.

| In Viauna | In the event |
|---|---|
| Title, location, description | `SUMMARY`, `LOCATION`, `DESCRIPTION` |
| Starts, ends | `DTSTART`, `DTEND` (an event that had `DURATION` gets `DTEND` instead) |
| Busy or free | `TRANSP`: `OPAQUE` or `TRANSPARENT` |
| Colour | `COLOR` (RFC 7986), as a CSS colour name; none means the calendar's |
| Video call link | `CONFERENCE` (RFC 7986), with `FEATURE=VIDEO` |

- A new event gets a random `UID`, `SEQUENCE:0`, and `DTSTAMP`, `CREATED` and
  `LAST-MODIFIED` set to the time. Each change sets `DTSTAMP` and `LAST-MODIFIED` again.
- Changing an event's time adds 1 to its `SEQUENCE`, which is how a calendar that has a
  copy (an invitation, say) tells a newer version from an older one (RFC 5546). Changing
  anything else doesn't.
- Google writes its video links as `X-GOOGLE-CONFERENCE`, and Teams as
  `X-MICROSOFT-SKYPETEAMSMEETINGURL` or `X-MICROSOFT-ONLINEMEETINGCONFLINK`. Viauna
  shows those too; changing or removing the link replaces it with `CONFERENCE`.
- An event's end before its start counts as no end. With no end, an all-day event lasts
  its day and a timed one is a moment (RFC 5545 3.6.1).

## Times and time zones

A timed event is written the iCalendar way: a wall-clock time and the zone it's in,
`DTSTART;TZID=Europe/London:20261021T090000`. Viauna writes the zone's IANA name and no
`VTIMEZONE` definition, which Google's and Apple's servers and Thunderbird accept.
Reading, it takes times as they come:

| Written as | Read as |
|---|---|
| `TZID=` an IANA name | That time in that zone, converted with the IANA time-zone database |
| `TZID=` another name (Outlook's `W. Europe Standard Time`) | Through the `VTIMEZONE` sent with it; without one, as floating |
| A time ending in `Z` | UTC |
| A time with neither ("floating") | That time wherever you are |
| A date (`VALUE=DATE`) | All day, on that date wherever you are |

The page sends its time zone with every request: the one in Settings > Calendar, or the
browser's. Times come back in it, and the page sends them in it. When someone moves an
event that was made in another zone, the new time is converted into that zone and kept
there, so a meeting in London moved by someone in Singapore stays a London meeting at
the right time.

A time that a clock change skips (01:30 on the night clocks go forward an hour) is moved
forward by the gap; one that happens twice (clocks going back) is the first of the two.

## Finding what's in a week

Beside each event, its start and end are kept in UTC milliseconds, all-day and floating
times read as if they were UTC. A week, a month or a 30-day schedule asks for the events
from one date to another in the reader's time zone; Viauna takes those overlapping that
range with a day to spare either side, then places each one exactly in the reader's zone.
One request covers at most 400 days.

## Undo and other pages

- Moving, changing or deleting an event keeps it as it was, in memory, for 10 minutes;
  **Undo** puts it back (a deleted one with the same id). Not after a restart, nor once
  its calendar has been deleted.
- A change tells every page signed in to the mailbox, as `calendar` on the
  [live-update stream](./live-updates.md), and they show it at once.
- Search looks through every event's title, place and description, and shows the newest
  200 matches.

## Turning it off

With `CALENDAR=false` (or the switch on the admin page), the calendar is gone from every
page at once, and so is its part of the API. Calendars and events are kept, and come back
when it's turned on again.
