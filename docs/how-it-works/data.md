# Your data

Viauna keeps two kinds of data, apart: **state**, what people chose or did, which must
survive; and **copies of mail**, which can always be fetched again from the mail server.
For backups, see [Upgrades and backups](../self-hosting/upgrading.md).

## What's kept where

The **state store** (`state.db`, or your `DATABASE_URL` database) holds:

- accounts: each login and its mail servers, and the mailbox's settings (name,
  signature, send-as addresses, images, page size, and the calendar's time zone, second
  time zone, first day of the week and event length);
- sessions, each with its mailboxes' encrypted passwords, when it started and was last
  used, the client address it signed in from and the browser's user agent (see
  [Sessions](./sessions.md));
- label names and colours, and senders whose images are always shown;
- settings changed on the admin page or with the `viauna` command, and the record of
  changes;
- contacts, each as its vCard, with their address books and what's still to sync;
- calendars, and their events, each as its iCalendar object (see
  [Calendar](./calendar.md)).

The **data directory** (`DATA_DIR`, `/data` in the image) holds:

| Path | Holds |
|---|---|
| `state.db`, `state.db-wal`, `state.db-shm` | The state store, unless `DATABASE_URL` is set. It runs in WAL mode: recent changes sit in `-wal` until they're merged. |
| `index.db`, `index.db-wal`, `index.db-shm` | The mail index: each folder's messages with their senders, recipients, subjects, dates, sizes, flags and labels; preview text; conversations; the addresses you correspond with. |
| `cache/` | Whole messages as downloaded (`.eml`), one directory per mailbox. |
| `uploads/` | Attachments of messages being written, one directory per session. |
| `secret.key` | The generated server secret, unless `SECRET_KEY` is set. |
| `viauna.sock` | The socket the `viauna` command uses to tell the server a setting changed. Made at start, removed at stop. |

Files in `cache/` and `uploads/` are readable only by Viauna's user (mode 600), but not
encrypted, and `index.db` holds every subject and preview. Protect the data directory as
you would your mail server's storage.

Each browser keeps its own preferences (theme, density, keyboard shortcuts, desktop
notifications, the calendar's last view, weekends and week numbers) in its local
storage.

## Caches

| What | Kept | Where |
|---|---|---|
| Messages you open | Until the cache is over `CACHE_MB` (1,024 MB by default); then the least recently opened go first | `cache/` |
| The last 24 messages opened, parsed | Until replaced, or a restart | Memory |
| Search results | 60 s for the same search | Memory |
| Attachments you've added while writing | 2 days from adding them, sent or not (checked hourly); then "An attachment has expired" | `uploads/` |
| Undo | 10 minutes, or until a restart | Memory |

A message under a given UID never changes, so a cached one is read from disk without
asking the server. Cached files are named by what identifies the message on the server
(the login and server, the folder, its UIDVALIDITY and the UID), so a rebuilt index
reuses them and never shows one to the wrong person. The cache is checked against
`CACHE_MB` after every 50 downloads, so it can run over by up to 50 messages in between;
with `CACHE_MB=0`, messages are still written and then removed at the next check. At
most 200 MB of a single message is downloaded.

If `index.db` is lost or deleted, Viauna builds it again: each folder is synced from
scratch, newest mail first. Settings, label colours, contacts and calendars are in the
state store and unaffected.

## What leaves the server

- **To your mail server**: IMAP, SMTP and ManageSieve, each signed in with the person's
  own login and password. When the server supports IMAP `ID`, Viauna sends `APP_NAME`
  and "Viauna" as the client's name.
- **To `CARDDAV_URL`**, if set: each mailbox's contacts, signed in with its own login and
  password. Only mailboxes on your own mail server (`IMAP_HOST`) sync.
- **To the address of a calendar from the web**, every 6 hours while it's added: a request
  for the file, saying it's Viauna and which version, from your server's address. Only
  to public addresses unless `ALLOW_PRIVATE_SERVERS` is on. See
  [Calendars from the web](./calendar.md#calendars-from-the-web).
- **For a password change**: the login, the address, and the current and new passwords,
  to your command (on its standard input), your webhook (a signed POST) or your LDAP
  directory. See [Password changes](../self-hosting/passwords.md).
- **Remote images**, once someone allows them: their browser loads them straight from
  the sender's servers, with no `Referer`. Viauna doesn't fetch or proxy them, so the
  sender sees the reader's address. That's why they're blocked until allowed.
- **Nothing else**: no telemetry, no update checks. Without signing in, `/api/config`
  answers with the app's name, its version and which features are on; the Docker
  healthcheck uses it.

## When Viauna restarts

On `SIGTERM`, Viauna stops each mailbox's sync (waiting at most 5 s), stops listening for
settings changes and closes its stores.

- **Kept**: sessions, so everyone stays signed in (as long as the state and the secret
  are kept); the index; the message cache; attachments being written; contact changes
  not yet sent.
- **Lost**, since they're held in memory: undo, the sign-in counters, password checks (so
  each mailbox's first request logs in again), the parsed-message and search caches, and
  when contacts last synced.
- **Open pages** try to reconnect every 5 s until the server is back. Each mailbox's
  sync then starts again and fetches only what changed.

## After someone stops using Viauna

Signing out deletes the mailbox's saved password from the session, and the session too
when it was the last mailbox in it. An expired session is deleted within the hour, with
its passwords. The rest stays: the account, its mailbox settings, label colours and
contacts in the state store, and its index rows and cached messages in the data
directory. Nothing deletes them yet, and there's no command for it; cached messages go
with the rest when the cache is over `CACHE_MB`. If the mailbox signs in again, it picks
up where it left off.

To remove everyone's copies of mail, stop Viauna and delete `index.db` (with its `-wal`
and `-shm`) and `cache/`. They're rebuilt for whoever signs in next.
