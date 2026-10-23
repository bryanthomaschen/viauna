# Live updates

Open pages don't poll for new mail. Each tab holds one stream from the server,
`/api/events` (server-sent events), and the server says on it when something changed.
(The one exception is a mailbox signed in for the first time: until its first folder is
indexed, the page asks every 2 s.) That's why a reverse proxy must not buffer responses, and should speak HTTP/2: over
HTTP/1.1 a browser allows six connections per site, and each tab's stream holds one. See
[Reverse proxy](../self-hosting/reverse-proxy.md).

## What the stream carries

| Event | Means | The page |
|---|---|---|
| `change` | A mailbox's folders changed; lists any new Inbox messages | Refetches that mailbox's lists and counts |
| `settings` | A setting for everyone changed | Refetches everything shown from settings |
| `account-settings` | One mailbox's own settings changed (name, signature, page size…) | Refetches that mailbox's settings and lists |
| `contacts` | A contacts sync started or ended | Refetches the contact list |
| `calendar` | A mailbox's calendars or events changed (in another tab, browser or device); says when only the calendars did (a name, a colour, shown or hidden) | Refetches its calendars, and its events unless only the calendars changed |
| `reauth` | A mailbox's saved password stopped working | Asks you to sign in again |
| `ready` | The stream is set up | After a reconnect, refetches everything shown from settings |
| `ping` | Every 25 s, to keep the connection open | Nothing |

## Timings

- The server gathers changes for 150 ms and sends them as one `change`. The page waits
  250 ms more, then refetches. If actions you made are still on their way to the server,
  it waits until they finish, so it never shows the server half-way (a star back for a
  moment after unstarring).
- Ticking a calendar on or off shows at once, and stays so: a list of calendars the server
  sent before it had the change is shown with the tick on top. Each calendar has one change
  on its way at a time, so clicking fast sends two at most, the last click last.
- New Inbox mail reaches an open page within about a second; mail in other folders
  within a minute. See [Mail sync](./sync.md#how-fresh-the-list-is).
- If the stream drops, the page opens it again after 5 s.
- Apart from the stream, a page refetches anything older than 30 s when its window gets
  the focus again.
- **Desktop notifications** are for new, unread Inbox messages while the tab is in the
  background: at most three per `change`.

## Signing out ends the stream

With every event, and every 25 s, the server checks that the session is still signed in
to each mailbox on the stream and unexpired. One that isn't gets nothing more, so the
subjects of new mail stop reaching a signed-out page. When no mailbox is left, the
stream ends.

## Settings changes

A setting changed on the admin page or with the `viauna` command applies without a
restart or a reload, because the change is announced rather than polled for.

1. The change is written to the state store, with a row in the record of changes, in one
   transaction.
2. The server reads the settings again: at once for a change on its own admin page, or
   when the `viauna` command tells it, through the socket `viauna.sock` in the data
   directory. The announcement only says "changed": the server reads the store again,
   which stays the one source of truth, so a lost or repeated announcement can't leave a
   wrong value.
3. If any value differs, the server sends `settings` to every open page, the admin's
   own included. They refetch the configuration, the session, each mailbox's settings,
   filters, contacts and the admin page.

Every server also reads the settings again once a minute, as a safety net. That covers a
socket that couldn't be made (some network filesystems can't hold one; Viauna then logs
"no settings socket"). Servers sharing a PostgreSQL database would also tell each other
with `LISTEN`/`NOTIFY`, and on MySQL or MariaDB within the minute, but running several
instances against one database [isn't supported yet](../self-hosting/databases.md#what-stays-in-the-data-directory).

A mailbox's own settings (name, signature, send-as addresses, images, page size) are
sent as `account-settings` to every page on the server signed in to that mailbox, in
other tabs and other browsers.

### When each change takes effect

Most changes apply to the next request. Some only to what happens next:

| Setting | Takes effect |
|---|---|
| `ADMIN_ADDRESSES` | At once: someone removed loses the admin page on their next request. |
| `ALLOWED_DOMAINS`, `ALLOW_CUSTOM_SERVERS` | At the next sign-in. Nobody already signed in is signed out: their sessions run until they expire or they sign out. |
| `MAX_ACCOUNTS` | When someone next adds an account. Nobody is signed out. |
| `SESSION_DAYS` | For new sessions at once; for each existing one the next time it's extended (on use, at most hourly). See [Sessions](./sessions.md#how-long-you-stay-signed-in). |
| `MAX_UPLOAD_MB` | At the next upload. |
| `CACHE_MB` | At the next trim of the message cache, after 50 more messages are downloaded. |
| `CONTACTS`, `CONTACTS_SYNC` | At once. A sync already running finishes. |
| `CALENDAR` | At once. |
| `FILTERS`, `VACATION` | Hidden in Viauna at once. Rules already on the mail server keep running until they're changed. |
| `FILTER_FORWARDING` | On: at once. Off: filters that forward keep forwarding until the mailbox's filters are next saved. |
| `APP_NAME` | Pages at once. The mail server sees the new name (in the IMAP `ID` Viauna sends) on new connections. |
| `PASSWORD_CHANGE` | At once. |
| Anything set in the environment | At the next restart. |

There's no button yet to sign everyone out after narrowing who can sign in. Changing
`SECRET_KEY` does it, for everyone: see [Sessions](./sessions.md#signing-out).
