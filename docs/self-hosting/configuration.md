# Configuration

Everything can be set with environment variables. Those marked **Live** can also be
changed while Viauna runs, from the [admin page or the command line](./admin.md); one set
in the environment wins there and can't be changed except in the environment. The rest
are read once, when Viauna starts.

Values are checked at startup: an invalid one, such as a number out of range or `ture`
for true, stops Viauna with a message naming the variable. Settings that are on or off
take `true` or `false`, `1` or `0`, `yes` or `no`, `on` or `off`.

## Mail server

| Variable | Default | |
|---|---|---|
| `IMAP_HOST` | — | Your IMAP server. Required unless `ALLOW_CUSTOM_SERVERS` is on. |
| `IMAP_PORT` | `993` | |
| `IMAP_SECURITY` | `tls` | `tls` (implicit TLS), `starttls`, or `none` (testing only). |
| `IMAP_TLS_SERVERNAME` | — | Name to check the certificate against, when `IMAP_HOST` is an internal alias or an IP address. |
| `IMAP_TLS_VERIFY` | `true` | Turn off only for a test server with a self-signed certificate. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_TLS_SERVERNAME`, `SMTP_TLS_VERIFY` | —, `465`, `tls`, —, `true` | The same, for sending. |

## Who can sign in

| Variable | Default | |
|---|---|---|
| `ALLOWED_DOMAINS` | — | **Live.** Comma-separated email domains allowed to sign in, checked against both the address and the login sent to the server. Empty: any address your IMAP server accepts. |
| `ALLOW_CUSTOM_SERVERS` | `false` | **Live.** Let people enter their own IMAP and SMTP servers, and a username different from their address, on the sign-in page. |
| `ALLOW_PRIVATE_SERVERS` | `false` | With custom servers on, also allow private and loopback addresses. Leave it off on a public instance, or anyone could use Viauna to probe your internal network. |

## Web

| Variable | Default | |
|---|---|---|
| `PUBLIC_URL` | — | The address people use, such as `https://webmail.example.com`. Requests that change anything must come from this origin. Strongly recommended; without it, the origin's host must match the request's `Host` header. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` and `X-Forwarded-Host` from one reverse proxy in front of Viauna. The last `X-Forwarded-For` entry is taken as the client. |
| `SECURE_COOKIES` | on, unless `PUBLIC_URL` starts with `http://` | Mark cookies `Secure`. |
| `APP_NAME` | `Viauna` | **Live.** Shown in the title bar and on the sign-in page. |
| `HOST`, `PORT` | `0.0.0.0`, `3000` in the image | Where to listen. Outside Docker the default host is `127.0.0.1`. |

## Sessions and limits

| Variable | Default | |
|---|---|---|
| `SESSION_DAYS` | `30` | **Live.** Session lifetime, extended by each visit. 1 to 3650. |
| `MAX_ACCOUNTS` | `10` | **Live.** Mailboxes one browser session can have signed in at once. 1 to 100. |
| `MAX_UPLOAD_MB` | `25` | **Live.** Largest single attachment. Your proxy and mail server must accept messages at least this big. 1 to 10240. |
| `CACHE_MB` | `1024` | **Live.** Disk cache for downloaded messages. 0 or more. |

## Admins and password changes

| Variable | Default | |
|---|---|---|
| `ADMIN_ADDRESSES` | — | **Live.** Comma-separated mailboxes that can open the admin page. They must sign in through `IMAP_HOST`. Set here, the list can't be changed from the page or the command line. See [Admin page and command line](./admin.md). |
| `PASSWORD_CHANGE` | `off` | **Live.** How people change their password: `off`, `link`, `command`, `webhook` or `ldap`; each needs its variables below. See [Password changes](./passwords.md). |
| `PASSWORD_CHANGE_URL` | — | For `link`: your mail server's password page. `{email}` is replaced with the person's address. Environment only. |
| `PASSWORD_CHANGE_COMMAND` | — | For `command`: run with the request as JSON on its standard input. Environment only. |
| `PASSWORD_CHANGE_WEBHOOK` | — | For `webhook`: POSTed the request as JSON. Environment only. |
| `PASSWORD_CHANGE_WEBHOOK_SECRET` | — | Signs each webhook request. Required with `PASSWORD_CHANGE_WEBHOOK`. Environment only. |
| `PASSWORD_CHANGE_LDAP_URL` | — | For `ldap`: your directory, as `ldaps://host` or `ldap://host` (then upgraded with StartTLS). Environment only, like the rest of these. |
| `PASSWORD_CHANGE_LDAP_USER_DN` | — | The person's entry, as a template such as `uid={user},ou=people,dc=example,dc=com`. Or find it with a search: |
| `PASSWORD_CHANGE_LDAP_SEARCH_BASE`, `PASSWORD_CHANGE_LDAP_SEARCH_FILTER` | —, `(mail={login})` | Where to search for the entry, and the filter that finds it. |
| `PASSWORD_CHANGE_LDAP_BIND_DN`, `PASSWORD_CHANGE_LDAP_BIND_PASSWORD` | — | A service account for the search, if anonymous searches aren't allowed. |
| `PASSWORD_CHANGE_LDAP_STARTTLS` | `true` | For `ldap://`: upgrade with StartTLS. `false` sends passwords unencrypted. |
| `PASSWORD_CHANGE_LDAP_TLS_VERIFY` | `true` | Check the directory's certificate. |

## Data and logging

| Variable | Default | |
|---|---|---|
| `DATA_DIR` | `/data` in the image, `./data` outside it | State (unless `DATABASE_URL` is set), the mail index, the message cache, uploads and the generated secret. Mount a volume here. |
| `DATABASE_URL` | — | Where accounts, sessions and settings are kept. Unset: SQLite, as `state.db` in `DATA_DIR`. Or a `postgres://`, `mysql://` or `mariadb://` URL; see [Databases](./databases.md). |
| `SECRET_KEY` | generated | Mixed into the encryption of saved passwords. If unset, one is generated into `DATA_DIR/secret.key` on first start. Changing or losing it signs everyone out. Generate one with `openssl rand -base64 32`. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
