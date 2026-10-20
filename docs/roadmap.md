# Roadmap

Viauna is pre-1.0. Nothing here has a date, and the order is a rough priority.

## Next

- **An admin page and a command-line tool** to turn features on and off and change
  settings without a restart. Settings given as environment variables stay locked.
- **Contacts**: an address book with vCard import and export, and optional CardDAV sync.
- **Password change**: a link to your mail server's own page, LDAP, or a webhook or
  command you provide.
- **Filters**: Sieve rules, over ManageSieve.

## Later

Vacation responder; undo send and send later; snooze; an installable app with offline
reading; JMAP for servers that speak it.

## How features are built

Anything that relies on a system outside Viauna follows the
[backends rule](./architecture.md#backends-and-lock-in): a standard protocol where one
exists, a default that needs no setup, and vendor APIs only as optional add-ons, so
choosing Viauna never ties you to one vendor.

Have an idea, or need one of these sooner?
[Open an issue](https://github.com/bryanthomaschen/viauna/issues/new?template=feature_request.yml).
