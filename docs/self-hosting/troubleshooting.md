# Troubleshooting

Start with the logs: set `LOG_LEVEL=debug`, restart, and watch `docker logs -f viauna`
while you reproduce the problem.

## "Could not connect to the mail server (…)"

Viauna couldn't open an IMAP connection; the text in brackets says why.

- **A certificate name error** ("Hostname/IP does not match certificate's altnames"):
  you're connecting by an internal name or an IP address. Set `IMAP_TLS_SERVERNAME` and
  `SMTP_TLS_SERVERNAME` to the name on the certificate.
- **A self-signed certificate**: `IMAP_TLS_VERIFY=false` and `SMTP_TLS_VERIFY=false`, on
  a test server only.
- **A timeout or `ECONNREFUSED`**: check the host, the port and the security setting
  (993 is `tls`, 143 is `starttls`), and that the container can reach the server: the
  same Docker network, no firewall in between.

## "Wrong email or password."

The mail server refused the login. Use the full address, as your phone's mail app does.
A separate username can only be entered when `ALLOW_CUSTOM_SERVERS` is on.

## "That address can't sign in here."

The address, or the login it uses, isn't in `ALLOWED_DOMAINS`.

## "Too many attempts. Wait a few minutes and try again."

Viauna's own limit: 20 sign-in attempts per client address, and 8 per login, every
15 minutes. If everyone gets it at once, `TRUST_PROXY` is probably off, so every client
looks like your proxy. The counts are kept in memory, so restarting Viauna clears them.

## Nobody can sign in, though the passwords are right

Your mail server may be blocking Viauna's address after failed logins. See
[Logins through Viauna come from one address](./mail-servers.md#logins-through-viauna-come-from-one-address).

## "Cross-origin request refused."

`PUBLIC_URL` doesn't match the address in the browser. Scheme, host and port must all
match: `https://webmail.example.com`, with no path.

## New mail only appears after a reload

Your proxy is buffering the live-update stream. Turn response buffering off for Viauna
(`proxy_buffering off;` in nginx); see [Reverse proxy](./reverse-proxy.md).

New mail in the Inbox should appear within about a second. Mail in other folders,
including what filters file there, takes up to a minute: that's expected. See
[How it works: Mail sync](../how-it-works/sync.md#how-fresh-the-list-is).

## A folder doesn't show

Viauna shows the folders the mailbox is subscribed to, and the special ones (Inbox,
Sent, Drafts, Archive, Junk, Trash). Subscribe to the folder in another mail app.

## Settings > Filters can't connect

Viauna reaches ManageSieve on the IMAP host's port 4190 unless told otherwise. Set
`MANAGESIEVE_HOST`, `MANAGESIEVE_PORT` and `MANAGESIEVE_SECURITY` for your server, or,
if it has no ManageSieve, `FILTERS=false` and `VACATION=false`. See
[Filters and vacation](./filters.md).

## A seventh tab never finishes loading

Browsers allow six connections per site over HTTP/1.1, and each tab's live-update stream
holds one. Turn on HTTP/2 in your proxy.

## Someone still signed in after being removed from `ALLOWED_DOMAINS`

`ALLOWED_DOMAINS` and `ALLOW_CUSTOM_SERVERS` are checked at sign-in only. Sessions already
open run until they expire (`SESSION_DAYS` after their last use) or the person signs
out. An admin can't end someone's session yet; changing `SECRET_KEY` and restarting signs
everyone out.

## Everyone is signed out after a restart

The data directory isn't on a persistent volume, `SECRET_KEY` changed between starts, or
`DATABASE_URL` now points at a different database.

## Viauna stops at startup with a database error

- "DATABASE_URL must start with…": only `postgres://`, `postgresql://`, `mysql://` and
  `mariadb://` URLs are understood; leave it unset for SQLite.
- A connection error: check the host, port and password, and that the database server
  accepts connections from Viauna's address.
- A permission error: the database user must be able to create tables in its database.

See [Databases](./databases.md).

## Labels can't be added in some folder

The server doesn't allow custom keywords there (`PERMANENTFLAGS` without `\*`). See
[Mail servers](./mail-servers.md#what-the-server-needs).

## Attachments fail to upload or send

Check `MAX_UPLOAD_MB`, your proxy's body size limit (`client_max_body_size` in nginx),
and your mail server's message size limit.

## "Your mail server won't send as …: 553 …"

Someone tried to add an address to **Send mail as** that the mail server won't let their
login send as: it isn't the mailbox's own, nor an alias the server gives it. Give the
mailbox that alias on the mail server (in Mailu, on the alias's or the user's page in its
admin pages), then add the address again. With `SEND_AS=server`, **Ask your mail server
again** confirms an address already in the list once the server takes it. See
[Sending as other addresses](../how-it-works/sending.md).

## The code to send as an address never arrives

It goes from the mailbox to that address through the mailbox's own mail server (or, for an
address with its own provider's server, through that server, to itself). Look in that
address's junk folder, and check that the mailbox can send to it. A new code can be sent
once a minute, and five a day to one address.

## Searching message text is slow

Search runs on the mail server. Turn on its full-text search; see
[Mail servers](./mail-servers.md#what-the-server-needs).

## Still stuck?

[Open an issue](https://github.com/bryanthomaschen/viauna/issues/new?template=bug_report.yml)
with the version (at the foot of the sign-in page), your mail server and reverse proxy,
and the relevant log lines. Report security problems
[privately](https://github.com/bryanthomaschen/viauna/security/advisories/new) instead.
