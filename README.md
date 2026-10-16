# Wren

**A fast, Gmail-style webmail client for any IMAP/SMTP server.** Self-hosted, one
container, no database server to run. Point it at the mail server you already have and
get conversations, instant search, labels, keyboard shortcuts and a compose window that
feels like the one you already know.

It uses only standard IMAP and SMTP, so it should work with any compliant server; it is
developed and tested against Dovecot (the IMAP server inside Mailu, mailcow and
docker-mailserver). Reports from other servers are very welcome.

![Inbox](docs/screenshots/inbox.png)

> Wren is an independent project. It isn't affiliated with, or endorsed by, Google.

## Why

Most open-source webmail looks and behaves like a 2009 desktop client. Wren copies the
interaction model people actually use every day — conversations, archive-don't-delete,
one-key shortcuts, inline replies — on top of plain IMAP, so it works with the mail
server you already run.

## Features

- **Conversations across folders.** Replies you sent (in Sent) sit under the message
  they answer (in Inbox), threaded by `Message-ID`/`References` the way Gmail does it —
  a reply that changes the subject starts a new conversation.
- **Fast.** A local index of every folder (SQLite) makes lists, counts and paging
  instant; newest mail first, older mail backfilled in the background.
- **Live.** IMAP IDLE pushes new mail to the open page within about a second.
- **Gmail-style labels** — several per conversation, stored on the server as IMAP
  keywords, so they follow your mail (Thunderbird and Apple Mail show them as tags).
  Plain folders work too.
- **Search with Gmail syntax** — `from:`, `to:`, `subject:`, `has:attachment`,
  `is:unread`, `is:starred`, `label:`, `in:`, `before:`/`after:`,
  `older_than:`/`newer_than:`, `larger:`, `-exclude`, `"exact phrase"` — run on the
  server, so body text is covered by its full-text index.
- **Archive, delete, spam, move, star, mark read — with Undo.**
- **Compose like Gmail** — pop-up windows (minimise, full screen, several at once),
  inline replies with the quoted text tucked behind `•••`, recipient autocomplete from
  people you correspond with, rich text, pasted images, drag-and-drop attachments,
  drafts autosaved to your server's Drafts folder.
- **Several accounts at once** with an account switcher (`/u/0`, `/u/1`, …) and
  "send mail as" aliases.
- **Keyboard shortcuts** — `c` `/` `j` `k` `o` `u` `e` `#` `!` `s` `x` `r` `a` `f` `l` `v`
  `z` `g i` … (press `?`).
- **Safe by default** — message HTML is sanitized and shown in a sandboxed iframe with
  its own content security policy; remote images (tracking pixels) are blocked until you
  allow them, per message or per sender.
- Light and dark themes, three densities, desktop notifications, works on phones.

| | |
|---|---|
| ![Conversation](docs/screenshots/conversation.png) | ![Compose](docs/screenshots/compose.png) |
| ![Dark mode](docs/screenshots/dark.png) | ![Phone](docs/screenshots/mobile.png) |

## Quick start

```bash
docker build -t wren .
docker run -d --name wren \
  -p 127.0.0.1:3000:3000 \
  -v wren-data:/data \
  -e PUBLIC_URL=https://mail.example.com \
  -e IMAP_HOST=imap.example.com \
  -e SMTP_HOST=smtp.example.com \
  wren
```

Put it behind your TLS-terminating reverse proxy (nginx, Caddy, Traefik) and sign in
with your mailbox address and password. See [`docker-compose.yml`](docker-compose.yml)
for a fuller example, and [Reverse proxy](#reverse-proxy) below.

## Configuration

Everything is set with environment variables.

| Variable | Default | |
|---|---|---|
| `IMAP_HOST` | — | Your IMAP server. Required unless `ALLOW_CUSTOM_SERVERS` is on. |
| `IMAP_PORT` | `993` | |
| `IMAP_SECURITY` | `tls` | `tls` (implicit TLS), `starttls`, or `none` (testing only). |
| `IMAP_TLS_SERVERNAME` | — | Name to verify the certificate against, when `IMAP_HOST` is an internal alias or IP. |
| `IMAP_TLS_VERIFY` | `true` | Only turn off for a development server with a self-signed certificate. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_TLS_SERVERNAME`, `SMTP_TLS_VERIFY` | —, `465`, `tls` | The same, for sending. |
| `PUBLIC_URL` | — | The address people use, e.g. `https://mail.example.com`. Used for the CSRF origin check. Strongly recommended. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For`/`-Proto`/`-Host` from your reverse proxy. |
| `ALLOWED_DOMAINS` | — | Comma-separated email domains allowed to sign in. Empty: any address your IMAP server accepts. |
| `ALLOW_CUSTOM_SERVERS` | `false` | Let users enter their own IMAP/SMTP servers on the sign-in page. Private and loopback addresses stay blocked unless `ALLOW_PRIVATE_SERVERS=true`. |
| `SECRET_KEY` | generated | Mixed into credential encryption. If unset, one is generated into the data directory on first start. |
| `SESSION_DAYS` | `30` | Sliding session lifetime. |
| `MAX_ACCOUNTS` | `10` | Accounts per browser session. |
| `MAX_UPLOAD_MB` | `25` | Largest single attachment. |
| `CACHE_MB` | `1024` | Disk cache for downloaded messages. |
| `DATA_DIR` | `/data` (image) | Database, cache, uploads. Mount a volume here. |
| `APP_NAME` | `Wren` | Shown in the title bar and on the sign-in page. |
| `HOST`, `PORT` | `0.0.0.0`, `3000` (image) | Where to listen. Outside Docker the default host is `127.0.0.1`. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

### Reverse proxy

Wren serves plain HTTP; terminate TLS in front of it. Server-sent events need buffering
off. For nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;              # live updates (/api/events)
    proxy_read_timeout 1h;
    client_max_body_size 30m;         # attachments
}
```

### Mail server notes

- Wren files a copy of each sent message in your Sent folder itself, as most IMAP
  servers expect. (Gmail's IMAP saves its own copy; Gmail isn't a target here.)
- Labels need a server that allows custom keywords (`PERMANENTFLAGS \*`): Dovecot,
  Cyrus, Stalwart and most others do.
- CONDSTORE/QRESYNC, MOVE, UIDPLUS, SPECIAL-USE and IDLE are used when the server offers
  them, with fallbacks when it doesn't.
- Search runs on the server. Dovecot with a full-text search plugin (fts-xapian or
  fts-flatcurve) makes body search fast on large mailboxes.

## How it works

```
browser ──HTTP/SSE──▶ Wren (Node) ──IMAP──▶ your mail server
                        │        └──SMTP──▶
                        └── SQLite: sessions, the index, labels, settings
```

- Signing in is your mailbox's own IMAP login — Wren has no user database. The
  password is encrypted (AES-256-GCM) with a key that exists only in your browser's
  session cookie, so the database alone opens nothing.
- Per signed-in mailbox, Wren keeps three IMAP connections while you're active: one for
  your clicks, one for background sync, one idling on the Inbox. They close after ten
  idle minutes; the index persists, so the next visit syncs only what changed.
- The index is a cache of the server. Delete it and Wren rebuilds it; your mail is only
  ever on your mail server.

More detail in [`docs/architecture.md`](docs/architecture.md).

## Development

You need Node.js 22.13+ and Docker.

```bash
npm install
cp .env.example .env
npm run dev:mail      # a throwaway Dovecot + SMTP sink on localhost (any user, password "pass")
npm run seed          # fill alice@example.test with realistic sample mail
npm run dev           # http://127.0.0.1:5173 — sign in as alice@example.test / pass
```

`npm run seed -- bob@example.test` seeds a second mailbox; mail sent between them is
delivered for real, so you can watch live updates arrive.

```bash
npm run typecheck
npm test                  # unit tests
npm run test:integration  # end-to-end against the dev mail server
npm run build && npm start
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

Ideas, roughly in order: undo send and send later; snooze; filters (Sieve via
ManageSieve); vacation responder; contacts (CardDAV); an installable PWA with offline
reading; JMAP for servers that speak it.

## License

[AGPL-3.0-only](LICENSE). If you run a modified Wren as a service for others, you must
offer them your changes.
