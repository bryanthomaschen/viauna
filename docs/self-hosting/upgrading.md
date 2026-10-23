# Upgrades and backups

Your mail lives on your mail server; back that up as you already do. Viauna keeps its own
state in the data directory (`/data` in the container), or in your database if you set
[`DATABASE_URL`](./databases.md).

## What's in the data directory

| Path | Holds | If it's lost |
|---|---|---|
| `state.db` | Accounts and sessions; each mailbox's settings (name, signature, send-as addresses, image preference, page size); label names and colours; senders whose images are always shown; settings changed from the admin page, and the record of changes; contacts; calendars and their events. Not present if you use `DATABASE_URL`, which holds these instead. | Everyone signs in again, and those settings and colours are gone; so are admins, settings made on the admin page, everyone's contacts (unless they sync with a CardDAV server) and everyone's calendars, which exist nowhere else. Mail is untouched, and labels stay on the messages because they live on the server. **Back this up.** |
| `index.db` | The mail index: folders, conversations, message summaries, label keywords seen on messages, and the addresses you correspond with, for autocomplete | Nothing that matters: Viauna re-syncs from the mail server. |
| `secret.key` | The generated server secret (absent if you set `SECRET_KEY`) | Everyone signs in again. |
| `cache/` | Downloaded messages, trimmed to `CACHE_MB` | Nothing: they're fetched again. |
| `uploads/` | Attachments of messages being written, kept 2 days | Those attachments, until they're added again. |
| `viauna.sock` | The socket the `viauna` command tells the server of a change through, while it runs | Nothing: it's made again at start. |

`state.db` and `index.db` each have a `-wal` and a `-shm` file beside them while Viauna
runs; they belong to the database. More on what's kept where, and for how long, is in
[How it works: Your data](../how-it-works/data.md).

## Backing up

Keep `state.db` and `secret.key`; `index.db` and `cache/` can be skipped. With
`DATABASE_URL`, back up that database the way you back up any other, plus `secret.key`.

- **Simplest**: stop the container, copy the two files, start it again.
- **Without stopping**: use SQLite's backup command, which makes a consistent copy of a
  live database. On the host, with the `sqlite3` tool installed:

  ```bash
  DATA=$(docker volume inspect viauna-data --format '{{ .Mountpoint }}')
  sudo sqlite3 "$DATA/state.db" ".backup '/backups/state.db'"
  sudo cp "$DATA/secret.key" /backups/
  ```

> [!WARNING]
> Don't just copy `state.db` while Viauna is running. The database runs in WAL mode, so
> recent changes sit in `state.db-wal` until they're merged, and a plain copy can come
> out inconsistent.

## Upgrading

Each release is listed on [GitHub](https://github.com/bryanthomaschen/viauna/releases)
with notes on what changed. With Docker Compose:

```bash
docker compose pull
docker compose up -d
```

With `docker run`, pull the new image, then remove the container and run it again with
the same options; the data volume keeps everything.

Pin a minor version, such as `ghcr.io/bryanthomaschen/viauna:0.5`, and each pull brings
that version's fixes without surprises. Move to the next one after reading its release
notes: before 1.0, a new minor version may change settings or behaviour.

The database schema updates itself on start. Back up `state.db` first: going back to an
older version after an upgrade isn't tested. People stay signed in across an upgrade as
long as the data volume and the secret are kept.

The version you're running is shown at the foot of the sign-in page, and by
`docker exec viauna viauna version`.

### From 0.5 to 0.6

- **Back up `state.db` first** (or your `DATABASE_URL` database): calendars, like contacts,
  are kept there and nowhere else. The new tables are made on the first start.
- **"Send mail as" addresses need confirming again.** Each mailbox's addresses are kept,
  but nothing is sent from one until it's confirmed, by a code emailed to it. On Mailu,
  mailcow or another server that refuses senders a login doesn't own, set
  `SEND_AS=server` and your mail server's yes confirms them instead, with no codes. Tell
  the people who use them. See [Sending as other addresses](../how-it-works/sending.md).
- **A login in front of Viauna** must let `/ical/` (secret calendar addresses), `/sw.js`,
  the manifest and the icons through. See [Reverse proxy](./reverse-proxy.md).
- **Reminders by email** need a mailbox for Viauna to send from: see
  [Viauna's own sender](./configuration.md#viauna-s-own-sender). Without one, reminders
  still show on the page and in the browser.
- The calendar and its parts are on by default; turn any off with `CALENDAR`,
  `CALENDAR_FEEDS`, `CALENDAR_SECRET_ADDRESSES` and `BROWSER_NOTIFICATIONS`, or from the
  admin page. Sending through other providers' mail servers (`SEND_AS_SERVERS`) is off
  until you turn it on.

### From 0.4 to 0.5

Nothing to do. Filters and the vacation responder appear for mailboxes on your own mail
server, and use ManageSieve on the IMAP host's port 4190; if yours is elsewhere, set
`MANAGESIEVE_HOST` and `MANAGESIEVE_PORT`. If your server has no ManageSieve, set
`FILTERS=false` and `VACATION=false`, or Settings shows a Filters tab that can't connect.
Forwarding in filters is off until you turn it on (`FILTER_FORWARDING`).

Single-key shortcuts are now off until each person turns them on; the ⌘K /
Ctrl+K command menu is always there. In a browser where someone had changed any display
setting (theme, density and so on), shortcuts stay on. Tell people who use them where
the switch is: Settings → Keyboard shortcuts, or *turn on single-key shortcuts* in the
command menu.

### From 0.3 to 0.4

Nothing to do: the address book's tables are created on the first start, and Contacts
is on. Turn it off with `CONTACTS=false` or from the admin page. To sync contacts with a
CardDAV server, set `CARDDAV_URL` (see [Contacts and CardDAV](./contacts.md)).

### From 0.2 to 0.3

Nothing to do: the new tables are created on the first start. Two things to know:

- A setting with an invalid value (a number out of range, or anything but `true`,
  `false`, `1`, `0`, `yes`, `no`, `on` or `off` for one that's on or off) now stops
  Viauna at startup with a message naming it, where 0.2 quietly read it as off.
- Most settings can now be changed from the [admin page](../administration/admin-page.md). Settings in your
  environment keep working, and stay locked there.

### From 0.1 to 0.2

0.1 kept everything in one file, `viauna.db`. On its first start, 0.2 copies the accounts,
sessions, settings, label colours and trusted senders into `state.db` (or into your
`DATABASE_URL` database), and renames `viauna.db` to `index.db`, since what's left is the
mail index. It also empties the message cache once, because cached files are now named
differently. Everyone stays signed in. Back up `viauna.db` before upgrading.
