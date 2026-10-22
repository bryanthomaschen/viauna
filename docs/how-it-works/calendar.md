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
| How it repeats | `RRULE`, and `EXDATE` for occurrences deleted; one changed on its own is a `VEVENT` of its own with a `RECURRENCE-ID` |

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
`DTSTART;TZID=Europe/London:20261021T090000`. Its end can be in another zone (a flight).
Viauna writes the zone's IANA name and no `VTIMEZONE` definition, which Google's and
Apple's servers and Thunderbird accept. Reading, it takes times as they come:

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
the right time. The editor shows an event in its own zones, and saving from it writes
the zones it shows. The second time zone's hours are worked out at the offsets of the
first day in view.

A time that a clock change skips (01:30 on the night clocks go forward an hour) is moved
forward by the gap; one that happens twice (clocks going back) is the first of the two.

## Repeating events

An event repeats by its rule (`RRULE`), less the dates left out (`EXDATE`), with any
occurrence changed on its own kept as a `VEVENT` of its own, named by the occurrence it
replaces (`RECURRENCE-ID`). An occurrence is named by that time as written,
`20261021T090000`, and the page asks for one by it.

**Working out the occurrences.** [ical.js](https://github.com/kewisch/ical.js) walks the
rule in the event's own wall-clock time, so a weekly meeting at 09:00 London time is at
09:00 every week, and each occurrence then becomes an instant in its zone, before and
after the clocks change. ical.js knows no time zones itself, so the rule's end and the
dates left out, which other apps often write in UTC, are first put in the event's zone;
otherwise it would compare London's 09:00 with 08:00 UTC and lose the last occurrence. A
yearly event on 29 February happens in leap years only, as RFC 5545 says. Occurrences
are worked out from the first, at most 50,000 of them (a daily event for 130 years).

**The editor's choices** are the rules it can show: daily, weekly on chosen days, monthly
on a date or on the first to fourth or last weekday, yearly, every so many of each, until
a date or so many times. A rule beyond those (another app's `BYSETPOS`, say, or extra
dates with `RDATE`) is kept as written, shown as made in another app, and can be
replaced but not edited.

**Changing one occurrence:**

| | What happens |
|---|---|
| This event | The occurrence becomes a `VEVENT` of its own, with its `RECURRENCE-ID`; changing it again changes that one |
| This and following events | The series is split: the original ends just before the occurrence (its `UNTIL`, or its `COUNT` made the number before it), and a new event carries on from it with the same rule (its `COUNT` what's left), the dates left out after it, and the occurrences changed on their own after it. Its `UID` is the original's with `_R` and the occurrence added. From the first occurrence, it's all events |
| All events | The series moves as the occurrence did: by as many days, to its new time of day, in its new zone. The dates left out, the names of occurrences changed on their own, a weekly or monthly rule's weekdays and dates, and the rule's end all move the same way, so they still match. An occurrence changed only in other ways (its title, say) moves with the series; one moved on its own stays put. A new title, place, description, colour, busy or free, or video link reaches the occurrences that had the old one |

Deleting: **this event** adds it to the dates left out (and removes its own `VEVENT`);
**this and following** ends the series before it; **all events**, or the last occurrence
left, deletes the event. A new rule can't be for one occurrence, and one occurrence can't
move to another calendar: those are for this and following events, or all of them.

## Calendar files

**Importing** a file splits it into events: every `VEVENT` with the same `UID` (the event
and its occurrences changed on their own) becomes one object, with the `VTIMEZONE`s it
names and the file's `PRODID`, and is kept as it came, but for the file's `METHOD`, which
says how the file was sent and has no place in a stored event (RFC 4791). An event with no
`UID` gets one made from its content, `urn:sha256:…`, so importing it twice still finds
it. An event already in the calendar with the same `UID` is replaced, if it changed.
`VTODO`, `VJOURNAL` and events without a start are skipped, and counted.

**Exporting** puts a calendar's events in one file, with `X-WR-CALNAME` (its name),
`X-WR-TIMEZONE` (your zone) and `METHOD:PUBLISH`, as Google's exports have, and a
`VTIMEZONE` for every zone the events use, which Outlook needs to read a time:

- For a named zone, it's built from the IANA time-zone database: the zone's changes of
  offset, found by looking at it every week, from the first year an event is in. Changes
  that follow a yearly pattern (the last Sunday of March, the second Sunday of March,
  the first Sunday on or after the 2nd, a date) are one observance with a yearly
  `RRULE`, left open ended if the zone still uses it; patterns are checked 28 years
  ahead, so that one is the zone's rule and not a coincidence of the years looked at.
  Anything irregular (Morocco's changes around Ramadan) is an observance of its own.
- For another app's own zone name (Outlook's `W. Europe Standard Time`), the definition
  the event came with is passed on as it was.

Two library faults are worked around here. ical.js converts a UTC time into a
`VTIMEZONE`'s wall-clock time wrongly in the hours before a change of offset, even with
Google's own definitions, so Viauna goes the other way (it tries each of the zone's
offsets and keeps the one that converts back). And temporal-polyfill's search for a
zone's next change misses changes that come close together, so Viauna finds them itself.

## Finding what's in a week

Beside each event, its start and end are kept in UTC milliseconds, all-day and floating
times read as if they were UTC: for a repeating event, its first occurrence's start and
its last one's end, or the largest time a JavaScript date holds if it never ends. A week, a month or a 30-day schedule asks for the events
from one date to another in the reader's time zone; Viauna takes those overlapping that
range with a day to spare either side, then places each one exactly in the reader's zone.
One request covers at most 400 days.

## The Birthdays calendar

A calendar's `kind` says where its events come from: `events`, kept in the state store
as above, or `birthdays`. Each mailbox gets one Birthdays calendar, the first time its
calendar is opened while `CONTACTS` is on, and only one, however many pages open at once.
It's never stored as events: when the calendar asks for a range of dates, Viauna makes an
all-day event for each date in the mailbox's contacts that falls in it, from the dates kept
beside each contact (see [Contacts](./contacts.md#what-viauna-reads-and-writes)), so a
date changed in Contacts or synced from a phone is right at once.

- A birthday is "Name's birthday", an anniversary "Name's anniversary", any other date
  "Name: its label" ("Name: a date" without one). With the date's year known, the age or
  the years follow in brackets, from the year after.
- 29 February is on 28 February in a year without one. Nothing shows before the date's
  year. A date in words ("circa 1950") isn't a date, so it isn't shown.
- The events are free, not busy, and can't be changed, moved or deleted, nor can events be
  added, imported or moved into this calendar. It can be renamed, recoloured and hidden,
  but not deleted. Search doesn't look at it.
- **Exported**, each date is a yearly all-day event (`RRULE:FREQ=YEARLY`) from the year it
  happened, or from 2000 when that isn't known (a leap year, so 29 February is a date),
  free (`TRANSP:TRANSPARENT`), titled without the age. 29 February repeats on the last day
  of February (`BYMONTH=2;BYMONTHDAY=-1`). Its `UID` is made from the contact's.
- With `CONTACTS` off it isn't listed and its part of the API answers that it doesn't
  exist; it comes back as it was when Contacts does.

## Calendars from the web

A calendar of kind `feed` comes from an address: its events are fetched from there and
kept like any other's, but only Viauna changes them, from what the address gives. So it
can't be changed from the page: no adding, changing, moving, deleting or importing events.

**Fetching** is done by the server, from anywhere it can reach, so the address is checked
like a mail server entered at sign-in: only public addresses, unless
`ALLOW_PRIVATE_SERVERS` is on.
The name is looked up, every address it has checked, and the connection made to one of
them, so an answer that changes between the check and the connection can't point the
server at your network. An address written as an IP (in any of its spellings) is checked
as it is. Redirects, up to 5, are checked the same way.

- `webcal://` is fetched over `https://`, and, if the server can't be reached that way,
  over `http://`, since webcal names neither. `http://` and `https://` are fetched as they
  are. An address with a name and password in it is refused, so none is kept.
- The request says it's Viauna (`User-Agent: Viauna/<version> (calendar; +<the
  repository>)`), asks for gzip, deflate or Brotli, and sends the `ETag` and
  `Last-Modified` of the last answer (`If-None-Match`, `If-Modified-Since`), so a calendar
  that hasn't changed costs a `304 Not Modified`.
- Limits: 30 s for the whole fetch, redirects included; 10 MB after decompressing (counted
  as it arrives, so a small compressed file can't unpack into a large one); 10,000 events;
  1 MB an event.

**Keeping it**: the file is split into events as an import is (see
[Calendar files](#calendar-files)), its `METHOD` left out. An event whose `UID` is new is
added, one whose content changed is replaced, and one no longer in the file is deleted,
all in one transaction. A file Viauna can't read (a server's error page, say), an
answer other than `200` or `304`, or any other failure leaves the events as they were and
keeps the reason, which the page shows. The calendar is named as the file names itself
(`X-WR-CALNAME`), or after the address's host. The same address can't be added twice.

**When it's fetched**: when it's added, then every 6 hours, or an hour after a fetch that
failed. Every 5 minutes (and 30 s after starting) Viauna looks for calendars that are due,
up to 10 at a time, and fetches them one by one. Each is claimed first, by moving its next
fetch on only if no one else has, so instances sharing a database don't both fetch it.
**Refresh now** fetches one at once, at most once a minute. With `CALENDAR_FEEDS` (or
`CALENDAR`) off, nothing is fetched and these calendars are hidden; they come back as they
were.

## Secret addresses

A calendar's secret address is `<your Viauna>/ical/<token>.ics`, where the token is 32
random bytes (256 bits) in base64url. Only its SHA-256 is kept, so the address can't be
shown again, nor read from a copy of the database; whoever asks with it gets the calendar,
without signing in. Making a new one replaces the hash, so the old address stops at once.

- **The whole calendar** is the calendar as **Export** makes it, the Birthdays calendar and
  calendars from the web included, with the time zone of Settings > Calendar (UTC if
  none) as `X-WR-TIMEZONE`.
- **Only when you're busy** keeps of each busy event its `UID`, its times (`DTSTART`,
  `DTEND`, `DURATION`), how it repeats (`RRULE`, `RDATE`, `EXDATE`) and `SEQUENCE`, with
  `SUMMARY:Busy` and `CLASS:PRIVATE`. An event shown as free (`TRANSP:TRANSPARENT`) or
  cancelled isn't included; an occurrence that's free or cancelled on its own is left out of
  its series with an `EXDATE`, so its time isn't shown either.
- Answers carry an `ETag`, and `If-None-Match` with it gets `304 Not Modified`;
  `Cache-Control: private, max-age=300`, and `X-Robots-Tag: noindex`. An address that
  names nothing, or a calendar that's hidden (the Birthdays calendar with Contacts off,
  one from the web with those off), gets `404`.
- When it was last fetched is noted, at most once a minute, for the calendar's settings.
- With `CALENDAR_SECRET_ADDRESSES` (or `CALENDAR`) off, every address answers `404` and
  none can be made; they work again when it's back on. Make a new one to be sure an old
  one stays stopped.

## Undo and other pages

- Moving, changing or deleting an event keeps it as it was, in memory, for 10 minutes;
  **Undo** puts it back (a deleted one with the same id; a split series as one again).
  Not after a restart, nor once its calendar has been deleted.
- A change tells every page signed in to the mailbox, as `calendar` on the
  [live-update stream](./live-updates.md), and they show it at once.
- Search looks through every event's title, place and description, and shows the newest
  200 matches; a repeating event at its next occurrence, or its last if it's over.

## Turning it off

With `CALENDAR=false` (or the switch on the admin page), the calendar is gone from every
page at once, and so is its part of the API. Calendars and events are kept, and come back
when it's turned on again.
