# Changelog

What changed in each release of Viauna, newest first. Each release's section is also its
[GitHub Release](https://github.com/bryanthomaschen/viauna/releases) text. Changes on
`main` that aren't released yet are under **Unreleased**; the `edge` image has them.

Before 1.0, a new minor version (0.2 to 0.3) may change settings or behaviour, so read
its notes before moving to it. A patch release (0.2.0 to 0.2.1) only fixes things.

## Unreleased

### Fixed

On a phone:

- Conversations can be selected: press and hold one, then tap others to add them. The list
  has no checkboxes there, so before only **Select all** could pick any.
- Settings no longer slides sideways on the Filters and Calendar tabs; the tabs scroll by
  themselves. The admin page's links fit too.
- An event's card opens at the foot of the screen, not off its left edge, and tapping a
  time opens the full editor.
- An open message's sender, date and buttons no longer overlap, and the Compose button
  is gone from conversations, where it covered the reply, and from Settings and Contacts.
- Every toolbar button is on the screen, down to 360 pixels wide; the filter editor's
  choices, the calendar's title and the schedule's event names fit.
- Esc closes the menu drawer.

Elsewhere:

- In dark mode, menus are light, as tooltips are, and pop-ups and dialogs are a lighter
  grey than the mail behind them; the page behind a dialog dims. A menu such as **More**
  was the same colour as the message list, so it was hard to see that it had opened. A
  button stays highlighted while its menu is open.
- The search options' fields no longer look like rows of the message list.
- Closing a menu with a click outside it no longer shows its button's tooltip (such as
  **More**). Tooltips still show when a button is reached with the keyboard.

## 0.6.0 - 2026-10-23

A calendar for each mailbox, with repeating events, reminders and invitations any
calendar app understands; labels and birthdays in contacts; and addresses you send as,
shown to be yours before mail goes out from them.

### Calendar

Each mailbox has calendars, as many as you like, kept by Viauna in standard iCalendar
with nothing else to set up. Open them from the new apps button at the top right. Day,
week, month, schedule and 4-day views; click or drag on the calendar to make an event,
drag to move it, and Undo; each event's card has **Join video call** for its link;
search; and **Create event** in a message's menu, with a link back to the email.

Repeating events (daily, weekly on chosen days, monthly on a date or a weekday, yearly,
until a date or so many times), and changed or deleted as this event, this and following
events, or all events. A rule another app wrote is kept as it is.

Time zones done right: times are shown in your zone (Settings > Calendar), with a second
zone beside them if you like; an event can be in a zone of its own, with its end in
another for a flight; an event made in another zone keeps it when you move it; and a
repeating meeting stays at 09:00 in its own zone through clock changes.

A **Birthdays** calendar shows the birthdays, anniversaries and other dates in your
contacts every year, with the age or the years when the contact has the year. It changes
when the contacts do, and its menu can **Add a birthday**.

**Calendars from the web**: add one by its address (`https://` or `webcal://`): public
holidays, fixtures, another app's calendar. Your server fetches it every 6 hours, and only
from public addresses, and shows it under **Other calendars** as it is there, so it can't
be changed here; **Duplicate** an event to keep your own copy. **Refresh now** fetches it
at once, and a failed fetch says why. `CALENDAR_FEEDS` (or the admin page) turns it off.

**Reminders**: an event can remind you minutes, hours, days or weeks before, or for an
all-day event, days before at a time of day; new events get your usual ones, set in
**Settings > Calendar**. A reminder shows in every page you have open, and as a desktop
notification when they're on. **Reminders with Viauna closed** (Settings > General): your
browser shows them even with no Viauna tab open, sent through its push service, encrypted
for it alone; on an iPhone, from Viauna added to the Home Screen. Imported events'
reminders are kept, and sent too. `BROWSER_NOTIFICATIONS` (or the admin page) turns the
pushing off. **Reminders by email**, to your own address, once the server has a sender of
its own: set `SENDER_ADDRESS` and `SENDER_PASSWORD` for a mailbox such as
`noreply@example.com`.

**Invitations** from any calendar app show as a card in their message: what, when, where,
who's going, and what it clashes with. **Going?** Yes, Maybe or No puts it in your
calendar and emails the organiser your answer the standard way; change it later from the
event. Cards also bring your calendar up to date with a newer version, remove a cancelled
event, add an `.ics` file's events, and, for events you organise, count a guest's answer.
The calendar shows your answer: outlined until you answer, striped for maybe, struck
through for no. Nothing in an email changes your calendar until you press its card's
button. **Invite people** to your events: add guests in the editor, and Viauna emails
them standard invitations (it asks first), updates when you change or move the event, and
cancellations when you take someone off or delete it. Their answers are counted from
their cards. Between mailboxes on the same Viauna server, an event someone has answered
stays in step both ways: their answer reaches the organiser's event at once, and the
organiser's changes, or its cancellation, reach their calendar.

**A secret address** for any calendar, so another app (your phone, Outlook, another
calendar) can show it read-only: the whole calendar, or only "Busy" at the times you're
busy. Viauna keeps only a fingerprint of it; make a new one to stop the old one, and its
settings say when an app last fetched it. Served at `/ical/`, which a login in front of
Viauna must let through; `CALENDAR_SECRET_ADDRESSES` (or the admin page) turns them off.

Calendars move in and out as `.ics` files: import Google Calendar's, Outlook's, Apple
Calendar's or Thunderbird's exports (again, without adding anything twice), and export
any calendar, with the time zone definitions Outlook needs. See
[Calendar](https://bryanthomaschen.github.io/viauna/using/calendar).

### Contacts

**Labels** say what someone is to you (Family, Church, Work): pick one from the menu
beside **Contacts** to see only those people, and rename or remove one for everyone at
once. They show next to the name, also when Viauna suggests people while you write, and
are never sent: the person you write to sees only the name. **Tidy up names** finds names
that carry context ("Bryan - church", "Mei (work)"), which goes out with every message to
them, and moves it into a label; it shows what it would do, and changes only the people
you leave ticked.

**Birthdays and other dates**: a birthday, with or without its year, an anniversary, and
dates of your own ("First day at work"). **Add a birthday** adds someone with only a name
and a birthday. And a **nickname**, which suggestions match while you write and which is
never sent either.

Labels are the vCard's categories, and dates are written as Apple's and Google's apps
write them, so they travel with an export and sync with your CardDAV server; a field you
didn't change stays exactly as another app wrote it. See
[Contacts](https://bryanthomaschen.github.io/viauna/using/contacts).

### Sending as other addresses

**Send mail as** (Settings > Accounts) now checks that an address is yours before mail goes
out from it. Your mail server is asked first, and an address it won't send as isn't added,
with its words saying why. Then Viauna emails the address a code, from the mailbox; entering
it confirms the address. Until then it's in the list, and a draft can be from it, but
nothing is sent from it, no invitation is answered as it, and the vacation responder
doesn't reply as it. Codes work for a day and five tries, at most five a day to an address.
The address typed in beside a separate username at sign-in is confirmed the same way, by a
code to itself; signing in with the address itself still confirms it.

`SEND_AS` (or the admin page) chooses what confirms an address: a code (`confirm`, the
default), your mail server accepting it as the sender (`server`, for servers that refuse
senders a login doesn't own, as Mailu and mailcow do; an address sent through another
provider's server still needs its code), or nothing but the mailbox's own address
(`off`).

With `SEND_AS_SERVERS` on (off by default), an address at another provider can be sent
through that provider's own mail server, so the mail passes its checks; its password is kept
only in the browser session that entered it, as the mailbox's is. Answers to invitations go
from the address the invitation was sent to. See
[Sending as other addresses](https://bryanthomaschen.github.io/viauna/how-it-works/sending).

### Also

- **Links** in the apps menu (the four squares, top right), added on the admin page or with
  `LINKS`: each with a label and a web address, for everyone or only in admins' mailboxes,
  such as your mail server's own settings and admin pages.
- Search: `rfc822msgid:` finds a message by its Message-ID.
- Text boxes and lists are one size across Viauna, Settings' lists included, and the event
  editor's labels share one column, with every box starting at one edge.
- On a phone, the end of Settings scrolls clear of the floating Compose button, which
  covered its last buttons.
- How conversations are grouped is in the docs:
  [Conversations](https://bryanthomaschen.github.io/viauna/how-it-works/conversations).
- The command menu scrolls with the mouse wheel when its commands don't fit; only the
  keyboard could reach the ones below. It also opens in the middle of the window, where
  it used to appear half its width to the right for a moment.
- **Admin settings** is in the account menu only while you're in an admin's mailbox, and
  the admin page acts as that mailbox (`/u/1/admin`). Before, one admin signed in put it
  in every mailbox's menu in that browser, and the page acted as the first admin signed
  in. `/admin` on its own still opens it, as the first admin.
- The docs have a [Quick start](https://bryanthomaschen.github.io/viauna/quick-start): try
  Viauna on your computer with one command, or run it on a server with one compose file
  that puts it behind Caddy. The admin page and the `viauna` command have their own
  section, [Administration](https://bryanthomaschen.github.io/viauna/administration/admin-page),
  moved from Self-hosting; the old address still leads there.

### Upgrading from 0.5

The "Send mail as" addresses each mailbox had are kept, but not confirmed: each needs its
code (or, with `SEND_AS=server`, your mail server's yes) before mail goes out from it
again, so tell the people who use them. A vacation responder that's on is written again
with only the confirmed addresses the first time its mailbox is used. On Mailu, or another
server that refuses senders a login doesn't own, `SEND_AS=server` confirms them without
codes, as people use them.

Otherwise, nothing you have to do: the calendar's tables are made on the first start, and
it's on. The same start finds the labels, nicknames and dates in the contacts already
kept. For reminders by email, give Viauna a mailbox to send from: see [Viauna's own
sender](https://bryanthomaschen.github.io/viauna/self-hosting/configuration#viauna-s-own-sender).
If you put a login of your own in front of Viauna, leave `/ical/`, `/sw.js`, the manifest
and the icons out of it: see [Reverse
proxy](https://bryanthomaschen.github.io/viauna/self-hosting/reverse-proxy). Calendars
are kept in the state store and nowhere else, so back up `state.db` (or your
`DATABASE_URL` database) as the [upgrading
page](https://bryanthomaschen.github.io/viauna/self-hosting/upgrading#backing-up) says.
Turn the calendar off with `CALENDAR=false` or from the admin page.
## 0.5.0 - 2026-10-21

Filters and a vacation responder, kept on your mail server so they work with Viauna
closed; and a command menu for doing anything by name.

### Filters

Sort mail as it arrives, the way Gmail does: in **Settings > Filters**, or from a
message's menu with **Filter messages like these**. Match on who it's from or to, the
subject, words in it, attachments or size; then skip the Inbox, mark it read, star it,
label it, move it, delete it or forward it. Filters are kept on your mail server as a
Sieve script (over ManageSieve), so they run with Viauna closed and apply in every app,
and rules you made in another app (Roundcube, say) keep running alongside. A filter that
skips the Inbox makes an Archive folder if your mailbox has none. Forwarding is off
until an admin allows it. See
[Filters and the vacation responder](https://bryanthomaschen.github.io/viauna/using/filters).

### Vacation responder

At the bottom of **Settings > General**: an automatic reply from a first day to an
optional last day, in your own time zone, sent at most once every four days to each
sender. Your mail server sends it, so it works while you're away from Viauna too.

### The command menu

Press **⌘K** on a Mac or **Ctrl+K** elsewhere, or click the **⌘** button at the top,
then type: an action on the conversation you're reading or the ones you've ticked
(archive, label as, move to, reply…), a folder or label to go to, something to make
(compose, a new label), or a setting (dark theme, compact density). When nothing
matches, Enter searches your mail. See
[Command menu and shortcuts](https://bryanthomaschen.github.io/viauna/using/shortcuts).

### Keyboard shortcuts are now opt-in, and all of them work

Gmail's single-key shortcuts are off until each person turns them on (Settings >
Keyboard shortcuts, or *turn on single-key shortcuts* in the command menu), because
single keys get in the way of speech input and some screen readers. Every shortcut was
pressed in a browser to check it, and these were fixed (a test now presses them all on
every change):

- `n` / `p` moved between messages without showing which; the message now gets a bar,
  and the "N more" fold opens when they reach it.
- After clicking into a message, or ticking a conversation's checkbox, no shortcut
  worked until you clicked elsewhere.
- `l` and `v` in the list did nothing with no conversation ticked.
- `Esc` after closing the label or folder picker didn't go back to the list.
- `z` pressed before the server had finished an action did nothing, or undid the
  action before it.

### How it works

A new part of the docs for anyone who wants to know what happens behind the scenes:
[mail sync](https://bryanthomaschen.github.io/viauna/how-it-works/sync), live updates
and how settings reach open pages, sessions, what's stored and cached where and what
leaves the server, how filters run, how contacts sync merges, and every fixed limit.
The user and admin pages stay short and link to it, and a test now fails when the docs
and the code disagree.

### Also

- The Settings tab is part of the address (`?tab=filters`), so a reload or Back keeps it.
- Contacts: **Sync now** pressed while a sync was already running waited for that one,
  which could have started before your latest change, so the change went out only on
  the next sync. It now syncs once more after the running one.

### Upgrading from 0.4

Nothing to do for most servers. Filters use ManageSieve on the IMAP host's port 4190
(Mailu's front already serves it); if yours is elsewhere, set `MANAGESIEVE_HOST` and
`MANAGESIEVE_PORT`, and if your server has none, set `FILTERS=false` and
`VACATION=false`. Shortcuts stay on in browsers where someone had changed a display
setting; everyone else finds them off. See
[Upgrades](https://bryanthomaschen.github.io/viauna/self-hosting/upgrading).

## 0.4.2 - 2026-10-20

### Fixed

- A setting changed on the admin page or with the `viauna` command now applies at once
  in every open page, including the admin's own: before, some (such as the app's name,
  or turning contacts on or off) took effect only after reloading the page. Changes
  from the command line are announced to the server rather than picked up every ten
  seconds.
- You were signed out `SESSION_DAYS` (30 days) after first signing in on a browser,
  however often you used it: the session was extended, but the browser's cookie wasn't.
  It's now sent again when the session is extended, so you stay signed in for 30 days
  after your last visit, as documented.
- `PASSWORD_CHANGE_URL` accepted `{login}`, `{user}` and `{domain}` but filled in only
  `{email}`; all four are filled in now.

## 0.4.1 - 2026-10-20

### Fixed

- Starring a conversation and quickly unstarring it (or any two quick actions on the
  same conversation) could show the first one again for a moment. The two could also
  reach the server out of order and leave the first in place; they're now sent in the
  order you make them.

## 0.4.0 - 2026-10-20

An address book for every mailbox, which can stay in step with your phone through your
own CardDAV server.

### Contacts

Open **Contacts** in the menu on the left to keep an address book for each mailbox:
names, several addresses and phone numbers, company, job title, birthday and notes. Add
someone from a message's menu, or import a vCard file (`.vcf`) exported from Gmail,
Apple Contacts, Thunderbird or Roundcube, and export them all the same way. Viauna keeps
each contact exactly as imported and changes only what you edit, so photos and other
apps' fields survive. While you write, your contacts are suggested first. See
[Contacts](https://bryanthomaschen.github.io/viauna/using/contacts).

### Sync with your CardDAV server

Set `CARDDAV_URL` and each mailbox's contacts sync with your CardDAV server (Radicale,
Mailu with `WEBDAV=radicale`, Nextcloud, Baïkal, SOGo), signed in with the mailbox's own
password, so they're the same on phones and in Thunderbird. Changes go both ways; when a
contact was edited in both places at once, the two are merged field by field, so
neither change is lost. See [Contacts and CardDAV](https://bryanthomaschen.github.io/viauna/self-hosting/contacts).

### Upgrading from 0.3

Nothing to do: the new tables are created on the first start, and Contacts is on. Turn
it off with `CONTACTS=false` or from the admin page.

## 0.3.1 - 2026-10-20

### Fixed

- After changing the page size in Settings, going back kept the old page size until the
  browser tab was reloaded. Changing the images setting had the same delay for messages
  already opened.

## 0.3.0 - 2026-10-20

Run your server from a web page: settings change without a restart, and people can
change their own password.

### An admin page

Open **Admin settings** in the account menu (or go to `/admin`) to change who can sign
in, session length and limits, the app's name, and how passwords are changed, while
Viauna runs. Each setting shows where its value comes from: the default, an admin's
change (who, and when), or the environment, where it stays locked. Every change is
listed. Settings that could run code, reach your network or send passwords somewhere
stay in the environment only. See [Admin page and command line](https://bryanthomaschen.github.io/viauna/self-hosting/admin).

Nobody is an admin to begin with. Make yourself one from the server:

```bash
docker exec viauna viauna admin add you@example.com
```

or list admins in `ADMIN_ADDRESSES`. The same `viauna` command lists and changes every
setting.

### Password changes

Settings > Accounts can now change a mailbox's password, in the way that suits your mail
server: a link to its own page (for Mailu, `/admin/user/password`), your LDAP directory
(Password Modify, RFC 3062), or a command or signed webhook you provide. Afterwards,
other browsers are signed out of that mailbox. It's off until you set it up; see
[Password changes](https://bryanthomaschen.github.io/viauna/self-hosting/passwords).

### Upgrading from 0.2

Nothing to do: the new tables are created on the first start. One change to know
about: a setting with an invalid value, such as a number out of range or `ture` for
true, now stops Viauna at startup with a message naming it, where 0.2 read it as off.

## 0.2.1 - 2026-10-20

### Fixed

- Settings could open as a blank page, depending on how quickly it loaded.

## 0.2.0 - 2026-10-20

### Choose your database

Accounts, sessions and settings can now live in **PostgreSQL, MySQL or MariaDB**: set
`DATABASE_URL` and Viauna creates its tables on first start. SQLite stays the default, with
nothing to set up. The mail index, a cache of your mail server, stays local, so syncing
never waits on a network database. See [Databases](https://bryanthomaschen.github.io/viauna/self-hosting/databases).

Already running on SQLite? Point `DATABASE_URL` at an empty database and restart; Viauna
copies everything across and everyone stays signed in.

### Upgrading from 0.1

Back up `viauna.db` and `secret.key` first. On its first start, 0.2:

- moves accounts, sessions, settings, label colours and trusted senders into `state.db`
  (or your `DATABASE_URL` database), keeping everyone signed in;
- renames `viauna.db` to `index.db`, since what's left is the mail index;
- empties the message cache once, because cached files are now named differently.

From now on, back up `state.db` (or your database) and `secret.key`; `index.db` is a cache.
Details: [From 0.1 to 0.2](https://bryanthomaschen.github.io/viauna/self-hosting/upgrading#from-0-1-to-0-2).

### Fixed

- Cached messages are now named by what identifies them on the server (account, folder,
  UIDVALIDITY, UID). Before, a rebuilt index could show a cached message from another
  folder when two folders shared a UIDVALIDITY, which happens when a mail server creates
  them in the same second.

### Under the hood

- Tested on SQLite, PostgreSQL 17, MySQL 8.4 and MariaDB 11.4 on every change, end to end
  against a real IMAP server.

## 0.1.0 - 2026-10-19

The first release. Viauna is a fast, Gmail-style webmail client for any IMAP/SMTP server:
self-hosted, one container, open source (AGPL-3.0). Point it at the mail server you
already run and get conversations, instant search, labels and keyboard shortcuts.

### Highlights

- **Conversations across folders**: your replies, filed in Sent, sit under the message they answer.
- **Fast and live**: a local index makes lists instant; new mail arrives within about a second.
- **Gmail-style labels**, stored on the server as IMAP keywords, so Thunderbird and Apple Mail see them too.
- **Search with Gmail's syntax** (`from:`, `has:attachment`, `older_than:1y`, `"exact phrase"`…), run on your server.
- **Archive, delete, spam, move and star, with undo**, and Gmail's keyboard shortcuts (press `?`).
- **Compose like Gmail**: pop-up windows, inline replies, autocomplete, rich text, drafts saved to your server.
- **Several accounts at once**, and send-as aliases.
- **Safe by default**: message HTML is sanitized and sandboxed, and remote images stay blocked until you allow them.
- Light and dark themes, three densities, desktop notifications, works on phones.

### Good to know

- Images for `linux/amd64` and `linux/arm64`.
- Developed and tested against **Dovecot**, including Mailu. Other servers should work: please
  [tell us how it went](https://github.com/bryanthomaschen/viauna/issues/new?template=server_report.yml).
- Gmail, and providers that only allow OAuth sign-in (such as Outlook.com), aren't supported yet.
