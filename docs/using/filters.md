# Filters and the vacation responder

> [!NOTE]
> Filters and the vacation responder need Viauna 0.5 or newer, and a mail server that
> offers them (most do). If your server's admins turned them off, they aren't there.

Both are kept on your mail server and run there as mail arrives. They sort your mail
and send your vacation reply even when Viauna isn't open, and they apply in every mail
app, not just this one.

## Filters

Open **Settings > Filters** and **Create a new filter**, or open a message's menu (the
three dots) and choose **Filter messages like these**, which fills in its sender.

A filter matches messages by any of:

| | |
|---|---|
| **From** | The sender's name or address. Several, separated by commas, match any of them. |
| **To** | The To and Cc addresses, the same way. |
| **Subject** | This text in the subject, as you typed it: `march invoice` doesn't match "Invoice for March". |
| **Has the words** | Words in the message's text (not its subject); `"a phrase"` in quotes is one. All must be there. |
| **Doesn't have** | None of these words may be in the message's text. |
| **Size** | Greater or less than a size. |
| **Has attachment** | |

and then, for each message that matches when it arrives:

- **Skip the Inbox**: into your Archive folder, in the sidebar, as if you'd archived it.
  If your mailbox has no Archive folder, saving the filter makes one;
- **Mark as read**, **Star it**;
- **Apply the label** or **Move to** a folder;
- **Delete it** (into Trash);
- **Forward it to** another address, if your server allows forwarding in filters.

Every filter that matches applies, as in Gmail: if two of them move the same message,
it's filed in both folders. Filters sort mail that arrives from the moment they're
saved; mail already here stays where it is. Mail a filter files outside the Inbox shows
up in Viauna within a minute.

If you rename or delete a label, or a folder, that a filter uses, edit the filter too:
it keeps using the old one. A filter whose folder is gone leaves that mail in the Inbox.

If you set up filters in another app before (Roundcube, say), they keep running after
Viauna's. If someone changes Viauna's filters from another app, Viauna says so, and
saving here replaces those changes.

## Vacation responder

At the bottom of **Settings > General**, turn the vacation responder on, choose the first
day (and the last, if you know it), and write a subject and message. Your mail server
replies to people who write to you, at most once every four days to each person, from
the first day to the last. Mail sent to any of your addresses (see "Send mail as") is
answered.

What your filters become on the mail server is in
[How it works: Filters](../how-it-works/filters.md).
