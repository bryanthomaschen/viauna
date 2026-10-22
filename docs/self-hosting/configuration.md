# Configuration

Everything can be set with environment variables. Those marked **Live** can also be
changed while Viauna runs, from the [admin page](../administration/admin-page.md) or the
[command line](../administration/command-line.md); one set in the environment wins there
and can't be changed except in the environment. The rest are read once, when Viauna
starts.

Values are checked at startup: an invalid one, such as a number out of range or `ture`
for true, stops Viauna with a message naming the variable (all but `LOG_LEVEL`, below).
Settings that are on or off take `true` or `false`, `1` or `0`, `yes` or `no`, `on` or
`off`.

> [!TIP]
> A **Live** change applies without a restart, but some only to what happens next: a
> narrower `ALLOWED_DOMAINS` stops new sign-ins, and signs nobody out. See
> [when each change takes effect](../how-it-works/live-updates.md#when-each-change-takes-effect).

## Mail server

| Variable | Default | |
|---|---|---|
| `IMAP_HOST` | — | Your IMAP server. Required unless `ALLOW_CUSTOM_SERVERS` is on. |
| `IMAP_PORT` | `993` | |
| `IMAP_SECURITY` | `tls` | `tls` (implicit TLS), `starttls`, or `none` (testing only). |
| `IMAP_TLS_SERVERNAME` | — | Name to check the certificate against, when `IMAP_HOST` is an internal alias or an IP address. |
| `IMAP_TLS_VERIFY` | `true` | Turn off only for a test server with a self-signed certificate. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_TLS_SERVERNAME`, `SMTP_TLS_VERIFY` | —, `465`, `tls`, —, `true` | The same, for sending. |
| `MANAGESIEVE_HOST`, `MANAGESIEVE_PORT`, `MANAGESIEVE_SECURITY`, `MANAGESIEVE_TLS_SERVERNAME`, `MANAGESIEVE_TLS_VERIFY` | IMAP's host, `4190`, `starttls` (`none` if IMAP's is), IMAP's, IMAP's | The same, for filters and the vacation responder (ManageSieve). The certificate name is IMAP's only while `MANAGESIEVE_HOST` is unset or the same as `IMAP_HOST`. See [Filters and vacation](./filters.md). |

## Who can sign in

| Variable | Default | |
|---|---|---|
| `ALLOWED_DOMAINS` | — | **Live.** Comma-separated email domains allowed to sign in, checked against both the address and the login sent to the server, so a username without a domain can't sign in. Empty: any address your IMAP server accepts. Checked at sign-in only. |
| `ALLOW_CUSTOM_SERVERS` | `false` | **Live.** Let people enter their own IMAP and SMTP servers, and a username different from their address, on the sign-in page. Turning it off stops new sign-ins that way; it doesn't sign out those already in. |
| `ALLOW_PRIVATE_SERVERS` | `false` | Allow private and loopback addresses for the mail servers people enter (with custom servers on) and the calendars they add from the web. Leave it off on a public instance, or anyone could use Viauna to probe your internal network. |

## Web

| Variable | Default | |
|---|---|---|
| `PUBLIC_URL` | — | The address people use, such as `https://webmail.example.com`. Requests that change anything must come from this origin. Strongly recommended; without it, the origin's host must match the request's `Host` header. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` and `X-Forwarded-Host` from one reverse proxy in front of Viauna. The last `X-Forwarded-For` entry is taken as the client. |
| `SECURE_COOKIES` | on, unless `PUBLIC_URL` starts with `http://` | Mark cookies `Secure`. |
| `APP_NAME` | `Viauna` | **Live.** Shown in the title bar and on the sign-in page. |
| `HOST`, `PORT` | `0.0.0.0`, `3000` in the image | Where to listen. Outside Docker the default host is `127.0.0.1`. |

## Features

| Variable | Default | |
|---|---|---|
| `CONTACTS` | `true` | **Live.** Each mailbox's address book, with vCard import and export, and suggestions from it while writing. Off: the Contacts page and the Birthdays calendar are gone, and suggestions come only from mail people have exchanged; saved contacts are kept. |
| `CARDDAV_URL` | — | A CardDAV server to sync contacts with, signed in as each mailbox with its own password. `{login}` (or `{email}`, the same), `{user}` and `{domain}` are filled in. Environment only. See [Contacts and CardDAV](./contacts.md). |
| `CONTACTS_SYNC` | `true` | **Live.** Sync with `CARDDAV_URL`, when it's set. |
| `CALENDAR` | `true` | **Live.** Each mailbox's calendars, kept by Viauna as iCalendar in the state store. Off: the calendar is gone from every page; calendars and events are kept. See [How it works: Calendar](../how-it-works/calendar.md). |
| `CALENDAR_SECRET_ADDRESSES` | `true` | **Live.** Let people give a calendar a secret address, `/ical/…`, so another app can show it read-only, whole or only when they're busy. Anyone with an address can fetch it without signing in, so leave `/ical/` out of any login in front of Viauna. Off: every address answers 404, until it's on again. See [Secret addresses](../how-it-works/calendar.md#secret-addresses). |
| `BROWSER_NOTIFICATIONS` | `true` | **Live.** Let people turn on calendar reminders in their browser with Viauna closed (Web Push). Each reminder goes, encrypted, through that browser's push service (Google's, Mozilla's or Apple's), from this server. See [Reminders](../how-it-works/calendar.md#reminders). |
| `CALENDAR_FEEDS` | `true` | **Live.** Let people add a calendar from the web by its address, which this server fetches every 6 hours: only from public addresses, unless `ALLOW_PRIVATE_SERVERS` is on. Off: nothing is fetched, and those calendars are hidden until it's on again. See [Calendars from the web](../how-it-works/calendar.md#calendars-from-the-web). |
| `FILTERS` | `true` | **Live.** Filters, kept on the mail server as Sieve. See [Filters and vacation](./filters.md). |
| `FILTER_FORWARDING` | `false` | **Live.** Let a filter forward mail to another address. |
| `VACATION` | `true` | **Live.** The vacation responder. |

## Sessions and limits

| Variable | Default | |
|---|---|---|
| `SESSION_DAYS` | `30` | **Live.** Session lifetime, extended by each visit (at most hourly). 1 to 3650. A change reaches each session the next time it's extended. |
| `MAX_ACCOUNTS` | `10` | **Live.** Mailboxes one browser session can have signed in at once. 1 to 100. |
| `MAX_UPLOAD_MB` | `25` | **Live.** Largest single attachment. Your proxy and mail server must accept messages at least this big. 1 to 10240. |
| `CACHE_MB` | `1024` | **Live.** Disk cache for downloaded messages. 0 to 10,000,000. It's trimmed after every 50 downloads, least recently opened first, so it can run over in between; `0` still writes each message, then removes it at the next trim. |

## Viauna's own sender

A mailbox that Viauna sends from itself, for [reminders by email](../using/calendar.md#reminders).
They're due when nobody may be signed in, and a person's own password can be used only
while they are, so the server needs a mailbox of its own: create one on your mail server,
such as `noreply@example.com`. Email reminders go only to each mailbox's own address, and
only for mailboxes on `IMAP_HOST` signed in with that address as their login, which the
mail server checked. Without `SENDER_ADDRESS`, reminders aren't offered by email. All
environment only.

| Variable | Default | |
|---|---|---|
| `SENDER_ADDRESS` | — | The address reminders come from. Setting it turns email reminders on. |
| `SENDER_NAME` | `APP_NAME` | The name they come from. |
| `SENDER_LOGIN`, `SENDER_PASSWORD` | `SENDER_ADDRESS`, — | How Viauna signs in to the SMTP server as the sender. Without a password, it sends without signing in, for a server that relays for Viauna's address. |
| `SENDER_SMTP_HOST`, `SENDER_SMTP_PORT`, `SENDER_SMTP_SECURITY`, `SENDER_SMTP_TLS_SERVERNAME`, `SENDER_SMTP_TLS_VERIFY` | `SMTP_HOST`'s, and with it its port, security, certificate name and checking; for another host, `465`, `tls`, —, `true` | Where it sends from, if not where people send. |

## Admins and password changes

| Variable | Default | |
|---|---|---|
| `ADMIN_ADDRESSES` | — | **Live.** Comma-separated mailboxes that can open the admin page. They must sign in through `IMAP_HOST`. Set here, the list can't be changed from the page or the command line. See [The admin page](../administration/admin-page.md). |
| `PASSWORD_CHANGE` | `off` | **Live.** How people change their password: `off`, `link`, `command`, `webhook` or `ldap`; each needs its variables below. See [Password changes](./passwords.md). |
| `PASSWORD_CHANGE_URL` | — | For `link`: your mail server's password page. `{email}` is filled in with the person's address, and `{login}`, `{user}` and `{domain}` with their login, the part before the `@` and the part after, all URL-encoded. Environment only. |
| `PASSWORD_CHANGE_COMMAND` | — | For `command`: run with the request as JSON on its standard input. Environment only. |
| `PASSWORD_CHANGE_WEBHOOK` | — | For `webhook`: POSTed the request as JSON. Environment only. |
| `PASSWORD_CHANGE_WEBHOOK_SECRET` | — | Signs each webhook request. Required with `PASSWORD_CHANGE_WEBHOOK`. Environment only. |
| `PASSWORD_CHANGE_LDAP_URL` | — | For `ldap`: your directory, as `ldaps://host` or `ldap://host` (then upgraded with StartTLS), with a port if needed but no path. Environment only, like the rest of these. |
| `PASSWORD_CHANGE_LDAP_USER_DN` | — | The person's entry, as a template containing `{user}` or `{login}`, such as `uid={user},ou=people,dc=example,dc=com`. Or find it with a search; set one or the other, not both: |
| `PASSWORD_CHANGE_LDAP_SEARCH_BASE`, `PASSWORD_CHANGE_LDAP_SEARCH_FILTER` | —, `(mail={login})` | Where to search for the entry, and the filter that finds it, containing `{user}` or `{login}`. |
| `PASSWORD_CHANGE_LDAP_BIND_DN`, `PASSWORD_CHANGE_LDAP_BIND_PASSWORD` | — | A service account for the search, if anonymous searches aren't allowed. Set both or neither. |
| `PASSWORD_CHANGE_LDAP_STARTTLS` | `true` | For `ldap://`: upgrade with StartTLS. `false` sends passwords unencrypted. |
| `PASSWORD_CHANGE_LDAP_TLS_VERIFY` | `true` | Check the directory's certificate. |

## Data and logging

| Variable | Default | |
|---|---|---|
| `DATA_DIR` | `/data` in the image, `./data` outside it | State (unless `DATABASE_URL` is set), the mail index, the message cache, uploads and the generated secret. Mount a volume here. |
| `DATABASE_URL` | — | Where accounts, sessions, settings and contacts are kept. Unset: SQLite, as `state.db` in `DATA_DIR`. Or a `postgres://` (or `postgresql://`), `mysql://` or `mariadb://` URL; see [Databases](./databases.md). |
| `SECRET_KEY` | generated | Mixed into the encryption of saved passwords. If unset, one is generated into `DATA_DIR/secret.key` on first start. Changing or losing it signs everyone out, and browsers need reminders with Viauna closed turned on again. Generate one with `openssl rand -base64 32`. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`; anything else means `info`. Logs are one JSON object per line: `debug` and `info` on standard output, `warn` and `error` on standard error. |

The image's health check fetches `/api/config` every 30 seconds; a load balancer can use
the same address. It answers without signing in, with the app's name, its version and
which features are on.

What's kept in the data directory, and what leaves the server, is in
[How it works: Your data](../how-it-works/data.md).

## Internal

Set by the image or the build; you don't need them.

| Variable | |
|---|---|
| `WEB_ROOT` | Where the built web app is. The image sets `/app/dist/web`. |
| `VIAUNA_VERSION` | The version shown at the foot of the sign-in page, set when the image is built (for `edge`, the release it follows and its commit). Defaults to `package.json`'s. |
