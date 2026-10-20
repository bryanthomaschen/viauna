# Filters

Filters and the vacation responder live in the mailbox's Sieve script on the mail
server, which runs it as each message is delivered. Viauna holds no copy. For setting
it up, see [Filters and vacation](../self-hosting/filters.md); for using it,
[Filters and the vacation responder](../using/filters.md).

## Reading and saving

Each time Viauna loads them (for the Filters tab, or the vacation responder in
Settings > General) or saves a change, it opens a ManageSieve connection (RFC 5804): STARTTLS unless `MANAGESIEVE_SECURITY` says otherwise, never
falling back to sending the password in the clear; then it signs in as the mailbox with
its own login and password (SASL `PLAIN`), does the work and logs out. It gives up after
15 s without an answer.

A save:

1. reads the current script, and lists which other script is active;
2. writes the new script from Viauna's own model, `require`-ing only the Sieve
   extensions its rules use, and refuses, naming them, if the server lacks any;
3. has the server check it (`CHECKSCRIPT`), saves it (`PUTSCRIPT`) and makes it the
   active one (`SETACTIVE`).

A filter that skips the Inbox needs an Archive folder, so saving one makes Archive if
the mailbox has none.

## The script

Viauna owns one script per mailbox, called `viauna`. In order, it holds:

1. the vacation responder, first, so a reply is sent even for mail a filter moves;
2. each filter, in the order listed;
3. `include :personal :optional` for a script another app made (Roundcube's, say) that
   was active when Viauna saved, up to five, so those rules keep running.

There's no `stop` anywhere, so every filter that matches applies, and the other app's
rules run after Viauna's. When no filters and no vacation responder are left, Viauna
deletes its script and makes the first included script active again.

The script starts with two comments: `# viauna-model:`, Viauna's filters and vacation
responder as base64 JSON, which is how it reads them back exactly; and `# viauna-hash:`,
the SHA-256 of the rules below. If the rules no longer match the hash, someone edited
the script elsewhere: Viauna says so, and saving replaces their edit.

## What each filter becomes

| In Viauna | In Sieve |
|---|---|
| **From** | `header :contains "from"`, any of the values separated by commas or `OR` |
| **To** | `header :contains ["to", "cc"]`, the same way |
| **Subject** | `header :contains "subject"` with the whole text: it matches that text as typed, not each word anywhere in the subject |
| **Has the words** | `body :text :contains` for each word, or each `"quoted phrase"`: all must be in the message's text (not its headers) |
| **Doesn't have** | `not body :text :contains`, any of the words |
| **Has attachment** | A part with `Content-Disposition: attachment` (images shown inside the message don't count) |
| **Size** | `size :over` or `size :under`, in bytes |
| **Mark as read**, **Star it**, **Apply the label** | `addflag` with `\Seen`, `\Flagged` or the label's IMAP keyword |
| **Forward it to** | `redirect :copy`, so the mailbox keeps the message too |
| **Skip the Inbox** | `fileinto` the Archive folder |
| **Move to** | `fileinto` that folder |
| **Delete it** | `fileinto` Trash |

Text is matched ignoring the case of ASCII letters, Sieve's default.

Some consequences:

- **Two filters that file the same message** (move, skip the Inbox or delete) put a copy
  in each folder.
- **Flags carry forward.** A label, read mark or star from one filter is set wherever a
  later filter files the message.
- **Renaming or deleting a label** changes the messages, but not the filters that apply
  it: they keep adding the old label's keyword, so it comes back on new mail. Edit those
  filters after renaming a label.
- **A folder used by Move to that's renamed or deleted** isn't made again: its mail stays
  in the Inbox until the filter is edited.
- **Mail filed into other folders** appears in Viauna within a minute, not a second; see
  [Mail sync](./sync.md#how-fresh-the-list-is).

## The vacation responder

It becomes `vacation :days 4`, with the subject, the message and `:addresses` listing the
mailbox's address and its "Send mail as" addresses. The server remembers whom it
replied to, so each sender gets at most one reply every four days, and it replies only
to mail sent to one of those addresses. The first and last days are checked with
`currentdate`, at the UTC offset of the browser that saved them: across a change to or
from summer time, the day starts an hour off.

## When forwarding is off

With `FILTER_FORWARDING` off, a filter that forwards can't be saved: saving the filters
asks for the forwarding to be removed first. Saving only the vacation responder leaves
the filters as they were, forwarding included.
