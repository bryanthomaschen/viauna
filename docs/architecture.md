# Architecture

## Layout

Every file under `server/` is listed by its path relative to `server/`. How things
behave, with timings and limits, is in [How it works](./how-it-works/index.md).

```
server/                Node (TypeScript, Hono)
  index.ts             the server's entry point: opens storage, listens, shuts down cleanly
  app.ts               HTTP API, security headers, CSRF check, the live-updates stream
  config.ts            settings: environment, and the registry of those changeable live
  instance.ts          live settings in the state store, the record of changes, who is admin
  settings-bus.ts      announcing a settings change to the server (socket, LISTEN/NOTIFY)
  cli.ts               the `viauna` command
  log.ts               one-line JSON logs
  auth.ts              sign-in, sessions, rate limits, password change
  password.ts          handing password changes to a link, command, webhook or LDAP directory
  crypto.ts            session cookies, credential encryption, the server secret
  netpolicy.ts         vetting servers entered at sign-in: public addresses only, pinned
  storage.ts           opens both stores at startup; upgrades older layouts
  db.ts                the mail index: SQLite schema and helpers (node:sqlite)
  settings.ts          per-mailbox settings, trusted senders
  contacts.ts          the address book: storage, search, import and export, suggestions
  contacts-sync.ts     keeping contacts in step with a CardDAV server
  carddav.ts           a small CardDAV client: discovery, sync-collection, multiget, If-Match
  vcard.ts             reading and writing vCard (2.1, 3.0, 4.0) without losing anything
  text.ts              text as the state store searches it: folded, and LIKE patterns
  calendar.ts          calendars and events: storage, ranges in the reader's zone, search, undo
  icalendar.ts         events as iCalendar (ical.js) without losing anything; times and zones (Temporal)
  recurrence.ts        repeating events: occurrences, rules, this / following / all events
  calendar-file.ts     calendar files (.ics): split into events to import, built to export
  birthdays.ts         the Birthdays calendar: contacts' dates made into events, never stored
  feeds.ts             fetching calendars from the web: public addresses only, limits, conditional requests
  vtimezone.ts         VTIMEZONE definitions for IANA zones, from the zone's own changes
  filters.ts           filters and the vacation responder: checking, loading, saving
  sieve.ts             them as a Sieve script, and reading back the script Viauna wrote
  managesieve.ts       a ManageSieve client (STARTTLS, PLAIN, scripts)
  state/db.ts          the state store: engines, schema types, helpers (Kysely)
  state/migrations.ts  its schema, for SQLite, PostgreSQL and MySQL/MariaDB
  state/copy.ts        copying state between stores, ids kept
  state/node-sqlite.ts Kysely's SQLite interface over Node's built-in driver
  imap/connection.ts   imapflow connection wrapper, login check
  imap/runtime.ts      per-account runtime: sync loop, backfill, snippets, IDLE
  imap/pool.ts         runtime registry, credential re-verification
  imap/store.ts        the index's rows: mailboxes, messages, correspondents, label keywords
  mail/threading.ts    conversation grouping
  mail/views.ts        thread lists and conversation view
  mail/actions.ts      archive/move/flag/label with undo
  mail/search.ts       search operators → IMAP SEARCH
  mail/render.ts       sanitizing and rendering message HTML
  mail/fetch.ts        message download + disk cache
  mail/compose.ts      MIME building, SMTP send, drafts, uploads
  mail/labels.ts       label definitions, rename/delete, correspondent search
  mail/keywords.ts     label names as IMAP keywords, and back
  mail/structure.ts    what a list needs from a message's structure: attachments, text part
  mail/snippet.ts      the preview text, from the first bytes of the text part
web/                   React app (Vite)
  src/lib              API client, router, stores, compose state, actions, live updates
  src/components       the UI
dev/                   local Dovecot, SMTP sink, test databases, seed data, release checks
test/                  unit tests; integration tests against the dev server
```

## Storage

Two stores, split by whether the data can be fetched again:

- **The state store** (`server/state/`) holds what a person chose or did: accounts,
  sessions and their encrypted passwords, each mailbox's settings, label names and
  colours, trusted senders, the settings admins changed with a record of each
  change, and contacts. A contact is kept whole, as its vCard, and Viauna rewrites only
  the fields it edits, so whatever another app stored in it (a photo, a postal address,
  its own fields) survives; its name, a search text, its addresses, its labels and its
  dates sit beside it, lower-cased by Viauna where they're compared, since the engines
  compare and sort text differently. Calendars
  are kept the same way: each event whole, as its iCalendar object, with its title, a
  search text and its start and end in UTC beside it. SQLite in `DATA_DIR/state.db` by default, or PostgreSQL or
  MySQL/MariaDB through `DATABASE_URL`, with one schema and one set of queries
  ([Kysely](https://kysely.dev)). Engines differ only in auto-increment ids, the binary
  type, and MySQL's table options (utf8mb4 with binary collation, so comparisons are
  exact everywhere). SQLite runs on Node's built-in driver through a small adapter, so
  there is still no native module.
- **The index** (`server/db.ts`) is a cache of the mail server: mailboxes, messages,
  threads, autocomplete addresses, and the label keywords seen on messages. Always local
  SQLite in `DATA_DIR/index.db`, queried synchronously, so sync never waits on a network
  database. Deleting it costs a resync.

The index keys its rows by the state store's account ids and keeps a copy of each
account's identity for its foreign keys. If an id ever names a different mailbox (a
restored or different state database), `ensureIndexAccount` drops what the index held
under it rather than show it to someone else. For the same reason the message cache is
named by stable identities (login and server, folder path, UIDVALIDITY, UID), never by
local ids.

An account's id is part of the key that encrypts its saved passwords, so copying state
between stores (the upgrade from 0.1, or moving from SQLite to a server database) keeps
ids as they are.

## Contacts sync

With `CARDDAV_URL` set, the CardDAV server holds each mailbox's contacts and the state
store a synced copy: each contact has its book, URL and ETag. A sync sends first
(queued deletions, contacts made here, then edits marked dirty, each with If-Match), then
fetches (sync-collection from the book's token, or a full ETag listing). An edit that
crossed one made elsewhere is merged three ways against `base`, the card as last synced,
kept while the contact is dirty: fields changed here take this side's value, the rest
the server's. Syncs run per mailbox, one at a time, alongside its IMAP runtime (on
start, every ten minutes, soon after a local change, on opening Contacts, and on
demand), signed in with the mailbox's own password, and announce themselves on the
live-updates stream. Details: [How it works: Contacts](./how-it-works/contacts.md).

## Filters

Filters and the vacation responder live in the mailbox's Sieve script on the mail server,
which runs it on delivery; Viauna holds no copy. It owns one script, `viauna`, written
from its own model, which it keeps (base64 JSON) in a comment at the top together with a
hash of the rules, so it reads its filters back exactly and notices a hand edit. A script
another app made, active when Viauna saves, is included after Viauna's rules
(`include :optional`), so those rules keep running and none of them can `stop` Viauna's.
The script `require`s only the extensions its rules use, and the server's own
CHECKSCRIPT runs before every save. Each request opens its own ManageSieve connection,
signed in as the mailbox. Details: [How it works: Filters](./how-it-works/filters.md).

## Sync

Each mailbox row records what the server last reported (UIDVALIDITY, UIDNEXT,
HIGHESTMODSEQ, message count) and how far the index has caught up
(`synced_uidnext`, `synced_modseq`, `backfill_uid`).

- **First sync** of a folder fetches the newest 300 envelopes, so the list appears at
  once; older UIDs are queued for **backfill** in batches of 500, newest first.
- **Incremental sync**: envelopes for UIDs ≥ `synced_uidnext`; flag changes via
  `CHANGEDSINCE` (CONDSTORE) or a full flag re-read without it; expunges by comparing
  the indexed UID range with the server's.
- **Snippets** are filled in by a separate pass that fetches only the first 3 KB of each
  message's text part (`BINARY.PEEK[part]<0.3072>` where supported).
- **Triggers**: IDLE on INBOX (a dedicated connection), a LIST-STATUS poll of every
  folder each minute while the account's runtime runs, and the user's own actions (which
  update the index directly, using COPYUID from MOVE when the server sends it).

Tasks run one at a time on the background connection in priority order: folder list,
INBOX, other folders, snippets, backfill. User actions use a separate connection and
never wait behind sync. Only subscribed and special-use folders are synced. Timings,
backoff and the runtime's lifecycle: [How it works: Mail sync](./how-it-works/sync.md).

## Conversations

`thread_refs` maps every Message-ID we have seen — including ones only referenced by
replies — to a thread. A new message joins the threads of the ids it references (its
own, `In-Reply-To`, `References`), merging threads when it bridges two, but only threads
whose normalised subject matches (`Re:`/`Fwd:`/`[list]` stripped). A copy of a known
message in another folder, from the same sender, always joins its original's thread. Conversations are shown
with every copy de-duplicated by Message-ID, and with Trash and Spam hidden unless you
are looking at them.

## Backends and lock-in

Whatever Viauna stores or talks to besides the mail server is the operator's choice,
not built in.

- **Standards first.** Where a protocol or format exists, use it: IMAP, SMTP, CardDAV,
  CalDAV, ManageSieve, vCard, iCalendar. A vendor's API is only ever an optional driver.
- **A default that needs no setup**, with alternatives picked on the admin page (or by
  environment variable or CLI), and in time a button to test each (none has one yet). A setting given in the
  environment is locked and shown read-only.
- **A custom method where it makes sense**: an HTTP webhook or a local command, so an
  unusual system can be wired up without changing Viauna.
- **Vendor drivers are separate modules**, off unless selected. Core code never imports
  one.
- **Data can always leave**, in open formats, and the CLI moves it between storage
  engines.
- **No options for internals.** The mail index is a cache rebuilt from IMAP, so it stays
  local SQLite everywhere. Choices are offered where operators gain something.

| Feature | Default | Alternatives | Custom | Status |
|---|---|---|---|---|
| Mail | Any IMAP/SMTP server | — | — | built |
| Mail index, message cache | Local SQLite and disk | none, by design | — | built |
| Accounts, sessions, settings | SQLite in `DATA_DIR` | PostgreSQL, MySQL/MariaDB | — | built |
| Password change | Off | Link to the mail server's own page; LDAP | Webhook, command | built; no vendor drivers yet |
| Contacts | Viauna's database, vCard import/export | CardDAV sync, any server | — | built |
| Calendars | Viauna's database, kept as iCalendar; .ics import and export | — | — | being built |
| Filters, vacation responder | On, kept on the mail server over ManageSieve | — | — | built |

The database is chosen by `DATABASE_URL`, not the admin page, because the settings
themselves live in it. A password change first proves the current password with an IMAP
login; a webhook then receives the address and new password signed with a shared
secret, and a command gets them on stdin, never in its arguments.

## Settings

Every setting can come from the environment. Those in `SETTINGS` (`server/config.ts`)
can also be changed while Viauna runs, from the admin page or the `viauna` command:
`server/instance.ts` keeps them in the state store (a row only for one that was
changed). A value in the environment wins and locks the setting. Each change is
recorded in `admin_log` with who made it.

A change is announced rather than polled for (`server/settings-bus.ts`), and open pages
refetch what depends on it (`web/src/lib/config.ts`); how, and when each change takes
effect, is in [How it works: Live updates](./how-it-works/live-updates.md#settings-changes).
Anything new that reads a setting in the page should read it through those queries, not
keep its own copy.

A setting stays environment-only when changing it live would be unsafe or meaningless:
where Viauna listens and keeps data, the mail server (part of every account's identity),
and anything that could run code, reach the internal network, or send people's passwords
somewhere (where password changes go: a page, a command, a webhook, a directory). A new setting
should say which kind it is.

## Security model

- **Credentials**: AES-256-GCM, key = HKDF(cookie secret, server secret, session id,
  account id). The database stores only the hash of the session id.
- **Password changes**: every session proves its own password. One whose password
  differs from the shared runtime's logs in fresh (the proof is trusted for ten
  minutes), and when it succeeds the runtime's own password is re-checked at once and
  the runtime retired if it no longer works. The runtime's password is also re-proven
  every ten minutes. So within ten minutes of a password change, sessions holding the
  old one are refused. Mail is sent with the requesting session's own password.
- **Malformed mail**: a message the server refuses to return (a corrupt file, an
  unknown transfer encoding) is fetched alone, then skipped, so it can't stall sync;
  each background task backs off on its own.
- **CSRF**: cookies are `SameSite=Lax`, and every non-GET request must carry an `Origin`
  (or `Referer`) matching `PUBLIC_URL`.
- **Message HTML**: sanitize-html with an allowlist; then linkedom rewrites links
  (`target=_blank`, `rel=noopener noreferrer`), cid images, and blocked remote images;
  shown via `srcdoc` in an iframe sandboxed without `allow-scripts`, with a per-message
  CSP (`script-src 'none'`, remote `img-src` only when allowed).
- **Attachments** download as `application/octet-stream` with `Content-Disposition:
  attachment`, except a short list of safe types viewed inline under a sandbox CSP.
- **SSRF**: users can't choose mail servers unless the operator allows it, and even then
  private and loopback addresses are refused. Calendars from the web (`CALENDAR_FEEDS`)
  are fetched the same way: every address a name has is checked as it's looked up, the
  connection goes to one of them, and redirects are checked again, within limits on time
  and size.
- **Secret calendar addresses** are 256-bit random tokens, kept only as their SHA-256,
  served at `/ical/` without a session and outside `/api/`, so none of the session or CSRF
  machinery is involved; a wrong one is a 404.
- **Brute force**: sign-in attempts are counted before the login is tried (so
  parallel bursts can't slip under the limit), per IP and per login; with
  `TRUST_PROXY` the client address is the last `X-Forwarded-For` entry, the one your
  proxy added.
- **Live updates** stop for an account once it is signed out or its session expires:
  the stream checks before each event and every 25 s.
- **Admins** are mailboxes listed in the admins setting, signed in through the
  operator's own `IMAP_HOST`; an account on a server entered at sign-in never counts.
  The login the server accepted is compared, not the address typed, so another
  mailbox's password can't borrow an admin's address. An admin's password is re-proven
  every ten minutes, as for mail. The page can't change anything that runs code,
  reaches the internal network or receives passwords (see Settings above), so a stolen
  admin session can't be turned into any of those. The last admin can only be removed
  from the command line, which needs access to the server.
- **Filters** can't forward unless the operator allows it (`FILTER_FORWARDING`), so a
  stolen session can't quietly route someone's mail elsewhere. A folder from the page
  must be one of the mailbox's own, a label's keyword only characters IMAP and Sieve
  accept, and every string is quoted for Sieve.
- **CardDAV** gets each mailbox's own login and password, so `CARDDAV_URL` is
  environment-only, and only accounts on `IMAP_HOST` sync: a typed-in server's
  password is never sent to the operator's CardDAV server.
- **Changing a password** checks the current one with the mail server first, counts
  attempts per mailbox, and hands the change to the operator's link, command, webhook or
  LDAP directory.
  The command gets its request on standard input and runs with a stripped environment
  (no `SECRET_KEY` or `DATABASE_URL`), in its own process group so a timeout ends all of
  it; the webhook request is signed (HMAC-SHA256 over timestamp and body) and redirects
  aren't followed. LDAP binds as the person with their current password, then uses
  Password Modify (RFC 3062); a login is escaped into the DN or search filter, and
  passwords go only over LDAPS or StartTLS unless the operator turns that off.
  Afterwards the session is re-encrypted with the new password, every other session is
  signed out of that mailbox, and its sync restarts.
