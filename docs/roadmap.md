# Roadmap

Viauna is pre-1.0. Work is planned as batches, one release each, in this order; nothing
here has a date. What's already out is in the
[changelog](https://github.com/bryanthomaschen/viauna/blob/main/CHANGELOG.md).

## 0.7: Teams and devices

- **Shared calendars**, with what each person may do: see only when you're busy, see the
  details, or edit. Nobody sees your calendar, not even when you're busy, until you share
  it with them, so a server open to anyone, such as a free email service, shows no one's
  schedule to strangers.
- **Organisations**, for a workplace: the server's admin can name groups (mail domains, or
  a group in your LDAP directory) whose members see when each other are busy without
  sharing one by one. Off until set up, and each person can still narrow what theirs show.
- **Find a time** from the free and busy times you can see: of the people who share with
  you, and of your organisation.
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
