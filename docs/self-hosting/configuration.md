# Configuration

Everything is set with environment variables, read when Viauna starts.

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
| `ALLOWED_DOMAINS` | — | Comma-separated email domains allowed to sign in, checked against both the address and the login sent to the server. Empty: any address your IMAP server accepts. |
| `ALLOW_CUSTOM_SERVERS` | `false` | Let people enter their own IMAP and SMTP servers, and a username different from their address, on the sign-in page. |
| `ALLOW_PRIVATE_SERVERS` | `false` | With custom servers on, also allow private and loopback addresses. Leave it off on a public instance, or anyone could use Viauna to probe your internal network. |

## Web

| Variable | Default | |
|---|---|---|
| `PUBLIC_URL` | — | The address people use, such as `https://webmail.example.com`. Requests that change anything must come from this origin. Strongly recommended; without it, the origin's host must match the request's `Host` header. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` and `X-Forwarded-Host` from one reverse proxy in front of Viauna. The last `X-Forwarded-For` entry is taken as the client. |
| `SECURE_COOKIES` | on, unless `PUBLIC_URL` starts with `http://` | Mark cookies `Secure`. |
| `APP_NAME` | `Viauna` | Shown in the title bar and on the sign-in page. |
| `HOST`, `PORT` | `0.0.0.0`, `3000` in the image | Where to listen. Outside Docker the default host is `127.0.0.1`. |

## Sessions and limits

| Variable | Default | |
|---|---|---|
| `SESSION_DAYS` | `30` | Session lifetime, extended by each visit. |
| `MAX_ACCOUNTS` | `10` | Mailboxes one browser session can have signed in at once. |
| `MAX_UPLOAD_MB` | `25` | Largest single attachment. Your proxy and mail server must accept messages at least this big. |
| `CACHE_MB` | `1024` | Disk cache for downloaded messages. |

## Data and logging

| Variable | Default | |
|---|---|---|
| `DATA_DIR` | `/data` in the image, `./data` outside it | State (unless `DATABASE_URL` is set), the mail index, the message cache, uploads and the generated secret. Mount a volume here. |
| `DATABASE_URL` | — | Where accounts, sessions and settings are kept. Unset: SQLite, as `state.db` in `DATA_DIR`. Or a `postgres://`, `mysql://` or `mariadb://` URL; see [Databases](./databases.md). |
| `SECRET_KEY` | generated | Mixed into the encryption of saved passwords. If unset, one is generated into `DATA_DIR/secret.key` on first start. Changing or losing it signs everyone out. Generate one with `openssl rand -base64 32`. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
