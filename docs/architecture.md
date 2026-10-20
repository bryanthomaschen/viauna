# Architecture

## Layout

```
server/            Node (TypeScript, Hono)
  app.ts           HTTP API, security headers, CSRF check, SSE
  auth.ts          sign-in, sessions, rate limits
  crypto.ts        session cookies, credential encryption
  storage.ts       opens both stores at startup; upgrades older layouts
  db.ts            the mail index: SQLite schema and helpers (node:sqlite)
  settings.ts      per-mailbox settings, trusted senders
  state/
    db.ts          the state store: engines, schema types, helpers (Kysely)
    migrations.ts  its schema, for SQLite, PostgreSQL and MySQL/MariaDB
    copy.ts        copying state between stores, ids kept
  imap/
    connection.ts  imapflow connection wrapper, login check
    runtime.ts     per-account runtime: sync loop, backfill, snippets, IDLE
    pool.ts        runtime registry, credential re-verification
    store.ts       the local index (mailboxes, messages, contacts, label keywords)
  mail/
    threading.ts   conversation grouping
    views.ts       thread lists and conversation view
    actions.ts     archive/move/flag/label with undo
    search.ts      Gmail query syntax → IMAP SEARCH
    render.ts      sanitizing and rendering message HTML
    fetch.ts       message download + disk cache
    compose.ts     MIME building, SMTP send, drafts, uploads
    labels.ts      label definitions, rename/delete, contacts search
web/               React app (Vite)
  src/lib          API client, router, stores, compose state, actions
  src/components   the UI
dev/               local Dovecot, SMTP sink, seed data
test/              unit tests; integration tests against the dev server
```

## Storage

Two stores, split by whether the data can be fetched again:

- **The state store** (`server/state/`) holds what a person chose or did: accounts,
  sessions and their encrypted passwords, each mailbox's settings, label names and
  colours, trusted senders. SQLite in `DATA_DIR/state.db` by default, or PostgreSQL or
  MySQL/MariaDB through `DATABASE_URL`, with one schema and one set of queries
  ([Kysely](https://kysely.dev)). Engines differ only in auto-increment ids, the binary
  type, and MySQL's table options (utf8mb4 with binary collation, so comparisons are
  exact everywhere). SQLite runs on Node's built-in driver through a small adapter, so
  there is still no native module.
- **The index** (`server/db.ts`) is a cache of the mail server: mailboxes, messages,
  threads, autocomplete addresses, and the label keywords seen on messages. Always local
  SQLite in `DATA_DIR/index.db`, queried synchronously, so sync never waits on a network
  database. Deleting it costs a resync.

The index keys its rows by the state store's account ids and keeps a copy of each
account's identity for its foreign keys. If an id ever names a different mailbox (a
restored or different state database), `ensureIndexAccount` drops what the index held
under it rather than show it to someone else. For the same reason the message cache is
named by stable identities (login and server, folder path, UIDVALIDITY, UID), never by
local ids.

An account's id is part of the key that encrypts its saved passwords, so copying state
between stores (the upgrade from 0.1, or moving from SQLite to a server database) keeps
ids as they are.

## Sync

Each mailbox row records what the server last reported (UIDVALIDITY, UIDNEXT,
HIGHESTMODSEQ, message count) and how far the index has caught up
(`synced_uidnext`, `synced_modseq`, `backfill_uid`).

- **First sync** of a folder fetches the newest 300 envelopes, so the list appears at
  once; older UIDs are queued for **backfill** in batches of 500, newest first.
- **Incremental sync**: envelopes for UIDs ≥ `synced_uidnext`; flag changes via
  `CHANGEDSINCE` (CONDSTORE) or a full flag re-read without it; expunges by comparing
  the indexed UID range with the server's.
- **Snippets** are filled in by a separate pass that fetches only the first 3 KB of each
  message's text part (`BINARY.PEEK[part]<0.3072>` where supported).
- **Triggers**: IDLE on INBOX (a dedicated connection), a LIST-STATUS poll of every
  folder each minute while someone is looking, and the user's own actions (which update
  the index directly, using COPYUID from MOVE when the server sends it).

Tasks run one at a time on the background connection in priority order: folder list,
INBOX, other folders, snippets, backfill. User actions use a separate connection and
never wait behind sync.

## Conversations

`thread_refs` maps every Message-ID we have seen — including ones only referenced by
replies — to a thread. A new message joins the threads of the ids it references (its
own, `In-Reply-To`, `References`), merging threads when it bridges two, but only threads
whose normalised subject matches (`Re:`/`Fwd:`/`[list]` stripped). A copy of a known
message in another folder always joins its original's thread. Conversations are shown
with every copy de-duplicated by Message-ID, and with Trash and Spam hidden unless you
are looking at them.

## Backends and lock-in

Whatever Viauna stores or talks to besides the mail server is the operator's choice,
not built in.

- **Standards first.** Where a protocol or format exists, use it: IMAP, SMTP, CardDAV,
  CalDAV, ManageSieve, vCard, iCalendar. A vendor's API is only ever an optional driver.
- **A default that needs no setup**, with alternatives picked on the admin page (or by
  environment variable or CLI), each with a test button. A setting given in the
  environment is locked and shown read-only.
- **A custom method where it makes sense**: an HTTP webhook or a local command, so an
  unusual system can be wired up without changing Viauna.
- **Vendor drivers are separate modules**, off unless selected. Core code never imports
  one.
- **Data can always leave**, in open formats, and the CLI moves it between storage
  engines.
- **No options for internals.** The mail index is a cache rebuilt from IMAP, so it stays
  local SQLite everywhere. Choices are offered where operators gain something.

| Feature | Default | Alternatives | Custom | Status |
|---|---|---|---|---|
| Mail | Any IMAP/SMTP server | — | — | built |
| Mail index, message cache | Local SQLite and disk | none, by design | — | built |
| Accounts, sessions, settings | SQLite in `DATA_DIR` | PostgreSQL, MySQL/MariaDB | — | built |
| Password change | Off | Link to the mail server's own page; LDAP; vendor drivers | Webhook, command | planned |
| Contacts | Viauna's database, vCard import/export | CardDAV sync, any server | — | planned |
| Filters | Off | ManageSieve, when the server offers it | — | planned |

The database is chosen by `DATABASE_URL`, not the admin page, because the settings
themselves live in it. A password change first proves the current password with an IMAP
login; a webhook then receives the address and new password signed with a shared
secret, and a command gets them on stdin, never in its arguments.

## Security model

- **Credentials**: AES-256-GCM, key = HKDF(cookie secret, server secret, session id,
  account id). The database stores only the hash of the session id.
- **Password changes**: every session proves its own password. One whose password
  differs from the shared runtime's logs in fresh (the proof is trusted for ten
  minutes), and when it succeeds the runtime's own password is re-checked at once and
  the runtime retired if it no longer works. The runtime's password is also re-proven
  every ten minutes. So within ten minutes of a password change, sessions holding the
  old one are refused. Mail is sent with the requesting session's own password.
- **Malformed mail**: a message the server refuses to return (a corrupt file, an
  unknown transfer encoding) is fetched alone, then skipped, so it can't stall sync;
  each background task backs off on its own.
- **CSRF**: cookies are `SameSite=Lax`, and every non-GET request must carry an `Origin`
  (or `Referer`) matching `PUBLIC_URL`.
- **Message HTML**: sanitize-html with an allowlist; then linkedom rewrites links
  (`target=_blank`, `rel=noopener noreferrer`), cid images, and blocked remote images;
  shown via `srcdoc` in an iframe sandboxed without `allow-scripts`, with a per-message
  CSP (`script-src 'none'`, remote `img-src` only when allowed).
- **Attachments** download as `application/octet-stream` with `Content-Disposition:
  attachment`, except a short list of safe types viewed inline under a sandbox CSP.
- **SSRF**: users can't choose servers unless the operator allows it, and even then
  private and loopback addresses are refused.
- **Brute force**: sign-in attempts are counted before the login is tried (so
  parallel bursts can't slip under the limit), per IP and per login; with
  `TRUST_PROXY` the client address is the last `X-Forwarded-For` entry, the one your
  proxy added.
- **Live updates** stop for an account the moment it is signed out or its session
  expires.
