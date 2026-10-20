# Roadmap

Viauna is pre-1.0. Work is planned as batches, one release each, in this order; nothing
here has a date. What's already out is in the
[changelog](https://github.com/bryanthomaschen/viauna/blob/main/CHANGELOG.md).

## 0.6: Calendar

- **Calendars for each mailbox**, as many as you like, kept by Viauna in standard
  iCalendar, with nothing else to set up.
- **Events as rich as Google Calendar's**: repeating, with changed or skipped occurrences;
  all-day and multi-day; time zones; reminders; video-call links.
- **Invitations**: people on the same Viauna server find them in their calendar and
  answer yes, no or maybe; anyone else gets a standard email invitation, which any
  calendar app understands, and their answer updates the event.

## 0.7: Teams and devices

- **Shared calendars**, with what each person may do: see only when you're busy, see the
  details, or edit.
- **Find a time** from colleagues' free and busy times.
- **Your phone and other apps**: Viauna serves CalDAV and CardDAV, so iPhone, Android
  (with DAVx5) and Thunderbird sync calendars and contacts with Viauna directly.

## Later

Undo send and send later; snooze; an installable app with offline reading; JMAP for
servers that speak it.

## How features are built

Anything that relies on a system outside Viauna follows the
[backends rule](./architecture.md#backends-and-lock-in): a standard protocol where one
exists, a default that needs no setup, and vendor APIs only as optional add-ons, so
choosing Viauna never ties you to one vendor.

Have an idea, or need one of these sooner?
[Open an issue](https://github.com/bryanthomaschen/viauna/issues/new?template=feature_request.yml).
