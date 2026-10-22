# Search

Type words to find, or narrow a search with the operators below. Press `/` to jump to the
search box. Searches run on your mail server, so they cover message text, not just what
Viauna has downloaded.

| Search | Finds |
|---|---|
| `invoice march` | Messages containing both words, anywhere |
| `"exact phrase"` | That phrase |
| `from:anna` `to:` `cc:` `bcc:` | Sender or recipients containing the text |
| `subject:dinner` | Subject containing the text |
| `label:travel` | Conversations with that label |
| `is:unread` `is:read` | Unread or read |
| `is:starred` `is:unstarred` | Starred or not |
| `is:answered` | Messages you've replied to (`is:replied` also works) |
| `has:attachment` | Messages with attachments |
| `before:2025/01/31` `after:2024/12/01` | Received before, or on or after, a date (`YYYY/MM/DD` or `YYYY-MM-DD`) |
| `older_than:1y` `newer_than:2w` | Relative dates, in days (`d`), weeks (`w`), months (`m`) or years (`y`) |
| `larger:5m` `smaller:100k` | Message size, in bytes or with `k`, `m` or `g` |
| `in:sent` | One folder: `inbox`, `sent`, `drafts`, `spam`, `trash`, `archive`, or any folder's name |
| `in:anywhere` | Every folder, Trash and Spam included |
| `rfc822msgid:abc123@mail.example.com` | The message with that Message-ID (what an event made from an email links to) |
| `-word` `-from:anna` | Excludes matches; works with any of the above |

Combine as many as you like: all of them must match. There's no `OR` yet.

Without `in:`, search looks in every folder in your sidebar except Trash and Spam.

`older:` and `newer:` work as `before:` and `after:`, and `since:` as `after:`. Dates
are the day the server received the message.

How fast searching message text is depends on your server's full-text index; see
[Mail servers](../self-hosting/mail-servers.md#what-the-server-needs).

Good to know: each folder gives its newest 3,000 matches, and the same search again
within a minute shows the same results. See
[How it works: Mail sync](../how-it-works/sync.md#search).
