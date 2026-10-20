# Mail sync

Viauna keeps a local index of each mailbox's folders: which messages are in them, their
senders, subjects, flags, labels and a line of preview text. Lists, counts and paging
come from the index, so they're instant. The index is a cache: the mail itself stays on
your mail server, and if the index is lost Viauna builds it again.

## The connections to your mail server

Each signed-in mailbox has one runtime, shared by every browser and tab signed in to it.
It starts when someone uses the mailbox, and holds three IMAP connections:

- one for what you do (opening a message, moving, starring, searching), so a click never
  waits behind sync;
- one for background sync;
- one idling on the Inbox (IMAP IDLE), to hear of new mail.

The runtime stops when no page has the mailbox's [live-update stream](./live-updates.md)
open and nothing has asked for it for 10 minutes (checked every minute). While it's
stopped nothing is synced; the next visit fetches only what changed.

Besides those three, Viauna logs in briefly to check a password: at sign-in, and at most
every 10 minutes after (see [Sessions](./sessions.md#passwords-are-checked-again)). Loading
or saving filters opens a ManageSieve connection each time, and contacts sync uses
CardDAV; see [Filters](./filters.md) and [Contacts](./contacts.md).

## Which folders show

Viauna syncs, shows and searches the folders you're subscribed to, plus the special ones
(Inbox, Sent, Drafts, Archive, Junk, Trash), subscribed or not. A folder made in another
app and not subscribed there doesn't appear; subscribe to it in that app. Folders made in
Viauna are subscribed, and renaming one keeps its subfolders' subscriptions.

## How fresh the list is

- **The Inbox** is watched with IDLE. When the server reports new, deleted or re-flagged
  messages, Viauna waits 300 ms to gather a burst, then syncs the Inbox. An open page
  shows it within about a second.
- **Every other folder**, Archive and the folders filters file mail into included, is
  checked once a minute: Viauna asks the server for every folder's status (message
  count, next UID, highest modification sequence, unread count) in one LIST-STATUS
  command, and syncs the folders that moved.
- **Changes made in other apps** (reading, starring, moving) appear the same way: within
  about a second in the Inbox, within a minute elsewhere.
- **What you do in Viauna** updates the index at once.

All of this happens only while the mailbox's runtime runs.

## The order things are done in

Background work runs one task at a time, in this order: the folder list, the Inbox,
other folders (Sent, Drafts, Archive, the rest, then Junk and Trash), preview text, then
older mail. A sync waits for the task already running to finish, which is at most one
batch.

- **First sync of a folder**: the newest 300 messages, so the list appears at once. The
  rest are fetched 500 at a time, newest first. Until a folder is fully indexed, its
  unread and total counts are the server's.
- **Preview text**: the first 3 KB (3,072 bytes) of each message's text, 60 messages at a
  time, Inbox first.
- **After that**: new messages from the folder's next UID on; flag changes with
  CONDSTORE (`CHANGEDSINCE`) where the server has it, or by reading every flag again
  where it doesn't; and deleted messages by comparing the UIDs the index holds with the
  server's.
- **If a folder's UIDVALIDITY changes**, every UID Viauna held for it is meaningless, so
  the folder is indexed again from scratch.

## When something fails

Each task retries on its own, after 4 s, then 8 s, 16 s and so on, doubling up to
10 minutes, so one that keeps failing neither spins nor holds the others back. A message
the server refuses to return (a corrupt file, an unknown encoding) is fetched alone, then
skipped. If the Inbox's IDLE connection drops, it's opened again after 5 s, or 30 s if
connecting failed.

## Search

A search runs on the mail server, so it covers message text, using the server's full-text
index where it has one.

- Viauna sends an IMAP SEARCH to each folder in scope: every synced folder except Trash
  and Spam, or the one named with `in:`.
- It takes the newest 3,000 matches in each folder. Matches older than what the index has
  reached are indexed there and then.
- `has:attachment` is decided from the index; everything else is the server's search.
- The same search within 60 s gives the same results, without asking the server again.
- An operator Viauna doesn't know (a URL, `re:`) is searched as text. For `older_than:`
  and `newer_than:`, a month is 30 days and a year 365.
