---
layout: home
titleTemplate: Gmail-style webmail for any IMAP server

hero:
  name: Viauna
  text: Gmail-style webmail for any IMAP server
  tagline: Self-hosted and open source. Conversations, instant search, labels and keyboard shortcuts, on the mail server you already run.
  image:
    src: /logo.svg
    alt: Viauna
  actions:
    - theme: brand
      text: Get started
      link: /self-hosting/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/bryanthomaschen/viauna

features:
  - title: Conversations across folders
    details: Your replies, filed in Sent, sit under the message they answer, threaded by Message-ID and References the way Gmail does it.
  - title: Fast and live
    details: A local index makes lists, counts and paging instant. IMAP IDLE brings new mail to the open page within about a second.
  - title: Labels, not just folders
    details: Several labels per conversation, stored on the server as IMAP keywords, so Thunderbird and Apple Mail show them as tags.
  - title: Search the way you already do
    details: from:, has:attachment, older_than:1y, "exact phrase" and the rest, run on the server against its full-text index.
  - title: Keyboard first
    details: 'c, /, j, k, e, #, r, a, f, z and the rest of Gmail''s shortcuts. Press ? for the full list.'
  - title: Safe by default
    details: Message HTML is sanitized and shown in a sandbox, and tracking images stay blocked until you allow them, per message or per sender.
---

## See it

![The inbox](./screenshots/inbox.png)

| | |
|---|---|
| ![A conversation](./screenshots/conversation.png) | ![Writing a message](./screenshots/compose.png) |
| ![Dark mode](./screenshots/dark.png) | ![On a phone](./screenshots/mobile.png) |

## One container, your mail server

Viauna is a single container with no database server to run. Point it at your IMAP and
SMTP server, put it behind your reverse proxy, and sign in with your mailbox address and
password. It's developed against Dovecot, the IMAP server inside Mailu, mailcow and
docker-mailserver, and uses only standard protocols.

[Get started](./self-hosting/getting-started.md) ·
[Read the source](https://github.com/bryanthomaschen/viauna) (AGPL-3.0)

> Viauna is an independent project. It isn't affiliated with, or endorsed by, Google.
