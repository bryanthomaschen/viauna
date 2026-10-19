# Viauna

**A fast, Gmail-style webmail client for any IMAP/SMTP server.** Self-hosted, one
container, no database server to run. Point it at the mail server you already have and
get conversations, instant search, labels, keyboard shortcuts and a compose window that
feels like the one you already know.

It uses only standard IMAP and SMTP, so it should work with any compliant server; it is
developed and tested against Dovecot (the IMAP server inside Mailu, mailcow and
docker-mailserver). Reports from other servers are very welcome.

![Inbox](docs/screenshots/inbox.png)

> Viauna is an independent project. It isn't affiliated with, or endorsed by, Google.

## Why

Most open-source webmail looks and behaves like a 2009 desktop client. Viauna copies the
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
docker run -d --name viauna \
  -p 127.0.0.1:3000:3000 \
  -v viauna-data:/data \
  -e PUBLIC_URL=https://mail.example.com \
  -e IMAP_HOST=imap.example.com \
  -e SMTP_HOST=smtp.example.com \
  ghcr.io/bryanthomaschen/viauna:0.1
```

Images are published for `linux/amd64` and `linux/arm64`.

Put it behind your TLS-terminating reverse proxy (nginx, Caddy, Traefik) and sign in
with your mailbox address and password. See [Getting started](docs/self-hosting/getting-started.md)
for Docker Compose, and [Reverse proxy](docs/self-hosting/reverse-proxy.md) for nginx,
Caddy and Traefik.

## Documentation

Everything is on **[the docs site](https://bryanthomaschen.github.io/viauna/)**, and in
[`docs/`](docs/) here:

- **Self-hosting**: [getting started](docs/self-hosting/getting-started.md) ·
  [reverse proxy](docs/self-hosting/reverse-proxy.md) ·
  [configuration](docs/self-hosting/configuration.md) ·
  [mail servers](docs/self-hosting/mail-servers.md) · [Mailu](docs/self-hosting/mailu.md) ·
  [upgrades and backups](docs/self-hosting/upgrading.md) ·
  [troubleshooting](docs/self-hosting/troubleshooting.md)
- **Using Viauna**: [the basics](docs/using/basics.md) · [search](docs/using/search.md) ·
  [keyboard shortcuts](docs/using/shortcuts.md)
- **The project**: [architecture](docs/architecture.md) · [development](docs/development.md) ·
  [roadmap](docs/roadmap.md) · [contributing](CONTRIBUTING.md) · [security](SECURITY.md)

## How it works

```
browser ──HTTP/SSE──▶ Viauna (Node) ──IMAP──▶ your mail server
                        │        └──SMTP──▶
                        └── SQLite: sessions, the index, labels, settings
```

- Signing in is your mailbox's own IMAP login — Viauna has no user database. The
  password is encrypted (AES-256-GCM) with a key that exists only in your browser's
  session cookie, so the database alone opens nothing.
- Per signed-in mailbox, Viauna keeps three IMAP connections while you're active: one for
  your clicks, one for background sync, one idling on the Inbox. They close after ten
  idle minutes; the index persists, so the next visit syncs only what changed.
- The index is a cache of the server. Delete it and Viauna rebuilds it; your mail is only
  ever on your mail server.

More detail in [`docs/architecture.md`](docs/architecture.md).

## License

[AGPL-3.0-only](LICENSE). If you run a modified Viauna as a service for others, you must
offer them your changes.
