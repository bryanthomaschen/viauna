# Calendar

> [!NOTE]
> The calendar needs Viauna 0.6 or newer.

Each mailbox has its own calendars. To open them, click the apps button (the four
squares, top right) and choose **Calendar**, or type *calendar* in the command menu. Your
server's admins can turn it off, in which case it isn't there.

## Your calendars

The first time you open the calendar, Viauna makes one for you, named after you (your
name from Settings, or your address). Add more with the **+** next to **My calendars**
(Work, Family, a trip), each with its own colour.

- Tick or untick a calendar to show or hide its events.
- Its menu (the three dots) has **Show only this one**, **Name and colour**, and
  **Delete calendar**, which deletes its events too. Your own calendar can be renamed,
  but not deleted.

## Birthdays

The **Birthdays** calendar shows the birthdays, anniversaries and other dates in your
[contacts](./contacts.md#birthdays-and-other-dates), every year: "Kai Lim's birthday (38)",
"Kai Lim's anniversary (11 years)", "Kai Lim: First day at work". The age or the years show
when the contact has the year. A birthday on 29 February is on 28 February in other
years. Nothing shows before the year a date happened.

These come from your contacts, so they change there: click one, then **Open contact**.
They can't be moved, and nothing else can be added to this calendar. Its menu has **Add a
birthday**, for someone whose other details you don't have. You can rename it, recolour
it or hide it, but not delete it. It's there while Contacts is; if your server's admins
turn Contacts off, it goes too.

## Calendars from the web

A calendar elsewhere that has an address, one ending in `.ics` or starting with
`webcal://`, can be shown here: public holidays, a team's fixtures, a school's terms, or
another calendar app's secret address for one of your calendars there. Click the **+**
next to **My calendars**, choose **From the web, by its address**, and paste it. It's
named as it names itself; rename it in its **Settings**.

These calendars are under **Other calendars**. Your server fetches each one when you add
it and every 6 hours after, and shows it as it is there: an event that's gone from it goes
from here too. So it can't be changed here. Click an event and **Duplicate** it into one of
your calendars to change your copy.

- **Refresh now**, in its menu, fetches it again (at most once a minute).
- A warning sign next to its name means the last fetch failed; its **Settings** say why
  and when, and its events stay as they were until a fetch works.
- **Remove calendar** removes it from here. It stays where it is on the web.
- An address with a name and password in it (`https://me:secret@…`) can't be used: ask
  the other app for its secret address instead.
- Your server's admins can turn this off; then the menu doesn't offer it, and calendars
  added before are hidden until it's on again.

## Sharing a calendar with another app

A calendar can have a secret address, for another app to show it read-only and keep it up
to date: your phone's calendar, Outlook, another calendar you use. In the calendar's menu
(the three dots), open **Name and colour** (**Settings** for one from the web), choose
what the address **Shows**, and **Make a secret address**:

- **The whole calendar**: every event, as it is here.
- **Only when you're busy**: "Busy" at the times of your busy events, and nothing else
  about them. Events shown as free aren't included.

**Copy the address there and then.** Viauna keeps only a fingerprint of it, so it can't
show it again. Paste it where the other app adds a calendar from a URL (Google Calendar:
**Other calendars → + → From URL**; Outlook: **Add calendar → Subscribe from web**; on an
iPhone, Calendar's accounts in Settings: **Add Account → Other → Add Subscribed
Calendar**). Other apps fetch it every few hours, so a change here takes that long to
show there.

Anyone who has the address can see what it shows, without signing in. The calendar's
settings say when it was made and when an app last fetched it. **Make a new address** stops
the old one at once, if it got out; **Turn off** stops it altogether. Changing what it
shows keeps the address. Your server's admins can turn secret addresses off, and then
none works until they're on again.

## Finding your way around

- **Day**, **Week**, **Month**, **Schedule** (the next 30 days as a list) and **4 days**:
  pick one from the menu at the top right. Each browser remembers the last one. On a
  phone, the calendar opens on Schedule.
- **Today** and the arrows move through time, and the month on the left jumps to any
  day. Click a day's name in the week to open that day.
- The red line is now.
- The address in the browser says where you are (`…/calendar/week/2026-10-21`), so
  **Back** and reloading keep your place, and a view can be bookmarked.
- The same menu shows or hides weekends and week numbers, in this browser.

## Making an event

- **Click a time** on the calendar: a card asks for a title. **Save** it, or choose
  **More options** for everything else. The event lasts your default length (an hour,
  unless you changed it in Settings > Calendar). **Drag** across times to choose how
  long. In the month view, a click makes an all-day event.
- **Create**, at the top left, opens the full editor, starting at the next half hour.
- **From an email**: open the message's menu (the three dots) and choose
  **Create event**. The title is the subject, and the description has the start of the
  message and a link back to it.

The editor has the title; when it starts and ends, or **All day**; its time zone; how it
repeats; which calendar; where; a video call link (Zoom, Google Meet, Teams, Jitsi or any
other); a description; **Show as** busy or free; and a colour, which is the calendar's
unless you pick another.

## Invitations

An invitation someone sends you (from Google Calendar, Outlook, Apple Calendar, or anything
that sends standard invitations) shows as a card at the top of its message: what, when in
your calendar's time zone, where, a video call link, who's organising it, and its guests
with their answers so far. If it clashes with something busy in your calendar, the card
says so.

- **Going?** Yes, Maybe or No puts it in your calendar with your answer, and emails the
  organiser your answer, from your address, as calendar apps expect. It goes into the
  calendar chosen in **Settings > Calendar > Invitations** (your own, out of the box), or
  the one you pick on the card. It keeps your usual reminders.
- Change your answer on the card, or in the calendar: click the event and choose again
  under **Going?**. The organiser is told each time.
- When the organiser changes it, the new invitation's card offers **Update your calendar**.
  Your reminders and colour stay, and so does your answer, unless the time changed, when
  it's asked again.
- When it's called off, the card says **This event has been cancelled**, with **Remove
  from your calendar**.
- A calendar file sent as an attachment (`.ics`) shows the same way, with **Add to
  calendar**. So does an invitation you're not on the guest list of (forwarded to you,
  say): it can be added, but not answered.
- When you organise an event and a guest's answer arrives, its card offers **Count it in
  your event**, to show their answer on the event's guest list.

Nothing in an email changes your calendar by itself: an invitation, an update, a
cancellation or an answer does something only when you press its button on the card.

In the calendar, an invitation you haven't answered is outlined, a maybe is striped, and
one you've said no to is faded and struck through. An event's card lists its guests and
their answers.

### Inviting people

Add **Guests** in the event's editor: type names or addresses, as in a message, and pick
from the suggestions. When you save, Viauna asks **Send invitations?**: **Send** emails each
guest a standard invitation, which they can answer from whatever calendar or mail app they
use; **Don't send** saves without emailing anyone. You're the event's organiser.

Their answers come back by email: **Count it in your event** on each one's card adds it to
the event, whose card and editor list who's said yes, maybe or no.

A guest whose mailbox is on your Viauna server too gets the same email as anyone else.
Once they've answered, the event stays in step both ways: their answer reaches your event
at once, and so do the changes you send to their calendar. Taking them off the guest list,
or deleting the event, takes it out of their calendar. Nothing goes into their calendar
before they answer.

When you change, move or delete an event you organise with guests, Viauna asks whether to
email them. Yes sends the new version (an invitation to anyone new), tells anyone you took
off that it's cancelled for them, and tells everyone if you delete it. Only an event's
organiser can change who's invited: on an invitation from someone else, the guest list is
just shown.

## Reminders

An event can remind you before it starts: under **Notifications** in the editor, so many
minutes, hours, days or weeks before (up to four), or for an all-day event, so many days
before at a time of day ("1 day before at 09:00", or 0 days for the morning of). An event
can have up to 5. Its card lists them. If your server sends them, a reminder can be an
**Email** to your own address instead: choose it where it says **Notification**.

A new event starts with your usual reminders, which you set in **Settings > Calendar >
Notifications**, one list for events at a time and another for all-day events; out of the
box, 10 minutes before for events at a time, and none for all-day ones. Ticking **All
day** in the editor swaps one list for the other.

When a reminder is due, every page you have open on the mailbox shows it at the bottom,
with **Open**; with **Desktop notifications** on (**Settings > General**) and the tab in
the background, your computer shows it too. Times are in your calendar's time zone.

### With Viauna closed

To have reminders even with no Viauna tab open, go to **Settings > General > Reminders
with Viauna closed** and choose **Turn on in this browser**, then allow notifications when
the browser asks. **Send a test** checks it works. It's for this mailbox in this browser:
turn it on in each browser you want them in, and for each of your mailboxes. Clicking a
reminder opens its day in the calendar.

They reach your browser through its maker's push service (Google's for Chrome and Edge,
Mozilla's for Firefox, Apple's for Safari), encrypted so that only your browser can read
them. Your server's admins can turn this off.

On an **iPhone or iPad**, a web page can't show notifications: add Viauna to your Home
Screen (in Safari, the Share button, then **Add to Home Screen**), open it from there, and
turn them on in its Settings. On a computer or Android phone you can do the same, to have
Viauna in a window of its own.

Reminders that came with an imported event are kept, and sent the same way. Calendars from
the web and the Birthdays calendar don't remind.

## Repeating events

**Repeats** offers the usual choices for the event's start date: daily; weekly on
its weekday; monthly on, say, the third Wednesday (and on the last one, when it's also
the last in its month); annually on its date; every weekday. **Custom…** sets the rest:
every so many days, weeks, months or years; which days of the week; for a monthly event,
its date or its weekday; and whether it ends, on a date or after so many times.

Changing, moving or deleting one occurrence asks which ones you mean:

- **This event**: only this one. It keeps its own changes from then on.
- **This and following events**: this one and every one after. The series before it is
  left as it was.
- **All events**: the whole series. Moving one occurrence an hour or a day moves them
  all the same way, and a new title reaches every occurrence that had the old one.

A new way of repeating can't be for one occurrence alone, so then **This event** isn't
offered. An event that repeats by a rule another app set, which Viauna doesn't edit,
says so; you can keep it or replace it with one of the choices here.

## Changing events

Click an event to see it: when and where, its description (links work), **Join video
call** if it has a link, and buttons to edit, duplicate or delete it.

Drag an event to move it, or drag its bottom edge to change when it ends. Moves snap to
15 minutes. Moving, saving and deleting each say so at the bottom of the page, with
**Undo** for 10 minutes.

## Time zones

Times are shown in the time zone chosen in **Settings > Calendar**, or your device's if
you haven't chosen one. Pick one there to see your calendar in your home time while you
travel. **Second time zone**, there too, shows another zone's hours beside yours in the
day and week views.

An event can be in a zone of its own: in the editor, click the zone under its times
and pick one, and the times you type are in that zone. Tick **A different time zone for
the end** for a flight, which leaves in one zone and lands in another. An event's card
shows its own times when they're in another zone.

An event made in another time zone (by another app, or by you before you moved) keeps
it: you see it in your time, and moving it keeps it right in its own. A repeating event
keeps its time in its own zone through clock changes: a weekly 09:00 meeting in London is
at 09:00 London time all year. All-day events are on their dates wherever you are. For
the details, see [How it works: Calendar](../how-it-works/calendar.md).

## Moving calendars in and out

**Import** (the **+** next to **My calendars**, then **Import from a file**) reads a
calendar file, `.ics`, the format calendar apps share, into one of your calendars or a
new one named as the file names it. To bring a calendar over:

| From | Export as a file |
|---|---|
| Google Calendar | [calendar.google.com](https://calendar.google.com) → Settings → Import & export → Export (a zip with one `.ics` per calendar) |
| Outlook | File → Save Calendar (Outlook on the web: Settings → Calendar → Shared calendars → Publish, then the ICS link) |
| Apple Calendar | Select the calendar, then File → Export → Export… |
| Thunderbird | Right-click the calendar → Export |

Repeating events, occurrences changed on their own, time zones, guests and reminders come
in as they were. Importing the same file again doesn't add anything twice: an event
that's already in that calendar (the same UID) is replaced by the file's version. Tasks
and other entries that aren't events are skipped, and the import says how many. One file
can be up to 20 MB and 10,000 events.

**Export** (a calendar's menu, the three dots, then **Export to a file**) saves the
calendar as one `.ics` file that any calendar app can import, with the time zone
definitions they need. The Birthdays calendar exports each date as an event every year,
without the ages, which a file can't know.

## Searching

In the calendar, the search box at the top searches events: their titles, places and
descriptions, accents and capitals aside. Birthdays aren't searched; search your
contacts for them. Results are grouped by day, newest first;
click one to open it, or its date to go to that day.

## Settings

**Settings > Calendar** has the time zone, a second time zone, the first day of the week
(or what's usual for your language), and how long a new event lasts. These are kept with your mailbox, so
every browser you use has them. Weekends and week numbers are kept in each browser.

## Keyboard

With single-key shortcuts on, `c` makes an event, `t` goes to today, `j` and `k` (or `n`
and `p`) move forward and back, and `d`, `w`, `m`, `a` and `x` switch views. The command
menu has all of them, and **New event**. See
[Command menu and shortcuts](./shortcuts.md#in-the-calendar).
