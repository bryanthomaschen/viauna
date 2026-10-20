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
looks like your proxy.

## Nobody can sign in, though the passwords are right

Your mail server may be blocking Viauna's address after failed logins. See
[Logins through Viauna come from one address](./mail-servers.md#logins-through-viauna-come-from-one-address).

## "Cross-origin request refused."

`PUBLIC_URL` doesn't match the address in the browser. Scheme, host and port must all
match: `https://webmail.example.com`, with no path.

## New mail only appears after a reload

Your proxy is buffering the live-update stream. Turn response buffering off for Viauna
(`proxy_buffering off;` in nginx); see [Reverse proxy](./reverse-proxy.md).

## A seventh tab never finishes loading

Browsers allow six connections per site over HTTP/1.1, and each tab's live-update stream
holds one. Turn on HTTP/2 in your proxy.

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

## Searching message text is slow

Search runs on the mail server. Turn on its full-text search; see
[Mail servers](./mail-servers.md#what-the-server-needs).

## Still stuck?

[Open an issue](https://github.com/bryanthomaschen/viauna/issues/new?template=bug_report.yml)
with the version (at the foot of the sign-in page), your mail server and reverse proxy,
and the relevant log lines. Report security problems
[privately](https://github.com/bryanthomaschen/viauna/security/advisories/new) instead.
