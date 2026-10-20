# Roadmap

Viauna is pre-1.0. Work is planned as batches, one release each, in this order; nothing
here has a date. What's already out is in the
[changelog](https://github.com/bryanthomaschen/viauna/blob/main/CHANGELOG.md).

## 0.4: Contacts

- **An address book** with vCard import and export, and optional CardDAV sync.

## 0.5: Filters

- **Filters**: Sieve rules, over ManageSieve.
- **Vacation responder**, also a Sieve rule.

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
