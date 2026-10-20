# Changelog

What changed in each release of Viauna, newest first. Each release's section is also its
[GitHub Release](https://github.com/bryanthomaschen/viauna/releases) text. Changes on
`main` that aren't released yet are under **Unreleased**; the `edge` image has them.

Before 1.0, a new minor version (0.2 to 0.3) may change settings or behaviour, so read
its notes before moving to it. A patch release (0.2.0 to 0.2.1) only fixes things.

## Unreleased

### Added

- **Filters**, Gmail-style, in Settings > Filters or from a message's menu ("Filter
  messages like these"): match on from, to, subject, words, attachments or size; skip
  the inbox, mark as read, star, label, move, delete or forward. They're kept on your
  mail server as Sieve (over ManageSieve, port 4190), so they sort mail as it arrives,
  with Viauna closed and in every app. Filters made in another app keep running.
  Forwarding is off until an admin allows it (`FILTER_FORWARDING`). See
  [Filters and the vacation responder](https://bryanthomaschen.github.io/viauna/using/filters).
- **A vacation responder**, at the bottom of Settings > General: from a first day to an
  optional last day, at most one reply every four days to each sender, sent by your
  mail server.

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
