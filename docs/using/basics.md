# The basics

Viauna works like Gmail, so if you've used Gmail you already know most of it. This page
covers the essentials and the parts that differ on your own mail server.

## Signing in

Sign in with your mailbox address and password. You stay signed in for 30 days after your
last visit, unless your administrator has changed that.

To use several mailboxes at once, open the account menu (top right) and choose **Add
another account**. Each one has its own address in the browser: `/u/0`, `/u/1` and so on.

## Conversations

A conversation is a message and its replies, including the ones you sent, which are filed
in Sent. A reply that changes the subject starts a new conversation, as in Gmail.

## Archive, delete and undo

- **Archive** (`e`) moves a conversation out of the Inbox into your Archive folder.
- **Delete** (`#`) moves it to Trash.
- **Report spam** (`!`) moves it to Junk; **Not spam** moves it back.
- Almost anything can be undone: click **Undo** in the notice at the bottom of the
  screen, or press `z`.

## Labels and folders

A conversation can carry several labels (`l`). Labels are stored on your mail server as
IMAP keywords, so they stay with the mail: Thunderbird and Apple Mail show them as tags.
Create, rename, recolour and delete labels from the sidebar; renaming or deleting one
updates your messages on the server.

Folders work too: **Move to** (`v`) files a conversation in one.

## Writing mail

- **Compose** (`c`) opens a window at the bottom of the screen. You can minimise it, make
  it full screen, or have several open at once.
- Replies open under the conversation, with the quoted text tucked behind `•••`.
- Recipients autocomplete from the people you've written to or heard from.
- Paste images straight in, and drag files in to attach them.
- Drafts are saved to your server's Drafts folder as you type, so your other devices see
  them too.
- `Ctrl` + `Enter` (`⌘` + `Enter` on a Mac) sends.

## Images from the internet

Images loaded from the internet can tell the sender that, when and where you opened a
message, so Viauna blocks them until you choose:

- **Display images below** shows them in that message.
- **Always display images from …** remembers the sender.
- **Settings → Images → Always display external images** stops blocking them.

## Settings

Some settings follow your mailbox to every browser; others apply to this browser only.

| Follow your mailbox | This browser only |
|---|---|
| Your name, signature, send mail as, images, maximum page size | Theme, density, keyboard shortcuts, desktop notifications |

- **Send mail as** adds addresses you can send from, such as aliases your mail server
  lets you use.
- **Desktop notifications** appear for new mail while the tab is in the background.
- **Theme** follows your device by default; choose Light or Dark to fix it.
- **Change password** (Settings > Accounts) appears if your server has set it up. It
  either opens your mail server's own page, or asks for your current and new password
  here. Afterwards, other browsers signed in to your mailbox are signed out, and your
  other mail apps ask for the new password.
- **Contacts** has its own page, in the menu on the left: see [Contacts](./contacts.md).
- **Admin settings**, in the account menu, appears only for the people who run your
  server: it changes settings for everyone.
