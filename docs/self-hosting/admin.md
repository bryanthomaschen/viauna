# Admin page and command line

> [!NOTE]
> The admin page and the `viauna` command need Viauna 0.3 or newer.

Most settings can be changed while Viauna runs, without a restart: from the **admin
page**, or from the server's console with the **`viauna` command**. A change applies at
once, in every page people have open (nobody needs to reload).

Some changes apply only to what happens next. Narrowing who can sign in
(`ALLOWED_DOMAINS`, `ALLOW_CUSTOM_SERVERS`) or lowering `MAX_ACCOUNTS` applies to the
next sign-in and signs nobody out; a new `SESSION_DAYS` reaches each session the next
time it's extended. See
[when each change takes effect](../how-it-works/live-updates.md#when-each-change-takes-effect).

A setting given as an environment variable can't be changed either way: the environment
wins, and the page shows it as locked. So you can keep everything in your compose file,
change things from the page, or mix the two.

## Becoming an admin

On a new server nobody is an admin. Make yourself one from the console:

```bash
docker exec viauna viauna admin add you@example.com
```

Then sign in with that mailbox and open **Admin settings** from the account menu (your
avatar, top right), or go to `/admin`. The page acts as the mailbox you opened it from and
says which (*Signed in as*), and changes are recorded under its address. With several
mailboxes signed in at once, **Admin settings** is in the menu only while you're in an
admin's, so switch to it first; `/admin` on its own opens the page as the first admin
signed in.

Or list the admins in the environment, which also stops anyone changing the list from the
page:

```yaml
environment:
  ADMIN_ADDRESSES: you@example.com, colleague@example.com
```

An admin is a mailbox on **your own mail server** (`IMAP_HOST`), signed in with its
password. A mailbox on a server someone typed in at sign-in never counts, whatever its
address, since anyone can run a server that accepts any name. What's checked is the login
your mail server accepted, not the address typed in. If an admin's password changes, or
the mailbox is removed, their admin rights end within ten minutes.

## The admin page

Each setting shows where its value comes from:

- **The default**, with the environment variable that would set it;
- **Changed by** an admin or the command line, and when, with a button to put it back;
- **Set in the environment**: locked, and changed there.

Below the settings, **This server** shows what the environment fixed at startup, and
**Recent changes** lists the 25 most recent: when, who, and from what to what. Every
change is kept; `viauna changes` shows the last 50.

What the page can change:

| Setting | Variable | |
|---|---|---|
| Admin mailboxes | `ADMIN_ADDRESSES` | Who can open the admin page. The page won't remove the last admin; the command line can. |
| Allowed domains | `ALLOWED_DOMAINS` | Who can sign in. |
| Other mail servers | `ALLOW_CUSTOM_SERVERS` | Whether people can enter their own IMAP and SMTP servers. |
| Contacts, contacts sync | `CONTACTS`, `CONTACTS_SYNC` | The address book, and syncing it with `CARDDAV_URL`, on or off. |
| Calendar, calendars from the web | `CALENDAR`, `CALENDAR_FEEDS` | The calendar, and adding calendars by their address, which this server then fetches; each on or off. |
| Filters, forwarding in filters, vacation responder | `FILTERS`, `FILTER_FORWARDING`, `VACATION` | Forwarding is off by default. See [Filters and vacation](./filters.md). |
| Session length, accounts per browser, largest attachment, message cache | `SESSION_DAYS`, `MAX_ACCOUNTS`, `MAX_UPLOAD_MB`, `CACHE_MB` | |
| Name | `APP_NAME` | |
| Password changes | `PASSWORD_CHANGE` | Off, or one of the ways the environment set up. See [Password changes](./passwords.md). |

### What the page can never change

Some settings are read only from the environment, at startup:

- where Viauna listens and keeps its data (`HOST`, `PORT`, `DATA_DIR`, `DATABASE_URL`,
  `SECRET_KEY`), and how it sits behind your proxy (`PUBLIC_URL`, `TRUST_PROXY`,
  `SECURE_COOKIES`);
- your mail server (`IMAP_*`, `SMTP_*`, `MANAGESIEVE_*`): the IMAP server is part of
  each account's identity, so changing it would make every account a new, empty one;
- `LOG_LEVEL`;
- anything that could run code, reach your internal network, or send people's passwords
  somewhere: `ALLOW_PRIVATE_SERVERS`, where password changes go
  (`PASSWORD_CHANGE_URL`, `PASSWORD_CHANGE_COMMAND`, `PASSWORD_CHANGE_WEBHOOK`,
  `PASSWORD_CHANGE_LDAP_*`), and the contacts server (`CARDDAV_URL`), which each
  mailbox signs in to with its password.

That last group is deliberate. Someone who steals an admin's session can change what the
page offers, but can't use it to run commands on your server, probe your network or
send everyone to a page that collects their passwords.

## The command line

The image includes a `viauna` command. Run it inside the container, where it uses the
same settings and database as the server:

```bash
docker exec viauna viauna settings                    # every setting, its value, and where that comes from
docker exec viauna viauna settings set SESSION_DAYS 14
docker exec viauna viauna settings set ALLOWED_DOMAINS "example.com, example.org"
docker exec viauna viauna settings reset SESSION_DAYS # back to the default
docker exec viauna viauna admin list
docker exec viauna viauna admin add you@example.com
docker exec viauna viauna admin remove you@example.com
docker exec viauna viauna changes                     # recent changes, newest first
docker exec viauna viauna version
```

Settings are named by their environment variable. Lists are comma-separated, and `""` is
an empty list. A change made here is recorded as made by "command line". The command
tells the running server through a socket in the data directory (`viauna.sock`), so the
change applies at once; if it can't, the server still picks it up within a minute.

Without Docker, run `node dist/server/cli.js` from the Viauna directory, with the same
environment as the server.

If an upgrade is waiting (the first start after moving from 0.1, or after setting
`DATABASE_URL` on a server that had been using SQLite), the command asks you to start
Viauna once first, so it never works on data the server is about to move.
