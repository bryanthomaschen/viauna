# Sending as other addresses

**Settings > Accounts > Send mail as** lists the addresses a mailbox sends from: its own,
and others its owner adds, such as aliases. An address is sent from, answers invitations
and goes in the vacation responder's replies only once it's **confirmed**: shown to be its
owner's. Until then it's in the list, and a draft can be from it, but nothing goes out
from it.

## Adding an address

1. **The mail server is asked.** Viauna signs in to the SMTP server that would send the
   address (the mailbox's, or the address's own: see below), names the address as the
   sender and the mailbox's own address as the recipient, takes the answer, and stops
   (`RSET`, then `QUIT`). Nothing is sent. A server that checks which addresses a login
   owns, as Mailu's and mailcow's do (Postfix's `smtpd_sender_login_maps`), refuses an
   address that isn't yours there, and it isn't added; the page shows the server's words.
   One that says "try again later" isn't added either.
2. **Then it's confirmed**, as the server's `SEND_AS` says:
   - `confirm` (the default): Viauna emails the address a code. Entering it confirms the
     address.
   - `server`: your mail server's yes confirms it, and no code is sent. Choose it only if
     your mail server checks senders: many say yes to any sender at this point and refuse
     the message only once it's sent, or rewrite it. An address sent through another
     provider's server still gets a code: that server's yes shows only that it would send,
     not whose the address is.
   - `off`: no other address can be added, and those already there can't be sent from.
     The mailbox's own address still works.

An address confirmed by the server's yes counts only while `SEND_AS` is `server`: with
`confirm` again, it needs a code. **Ask your mail server again** asks the same question
later, as when your server's administrator has just added the alias.

## Codes

- The code is 8 digits, emailed from the mailbox to the address through the mailbox's own
  mail server. The email says who asked, from which server, and that nothing is sent as
  the address without the code. It's marked `Auto-Submitted: auto-generated`, so vacation
  responders leave it be.
- It works for 24 hours and for 5 tries; then send a new one, which replaces it.
- At most one a minute and 5 a day go to an address, and 20 a day from a mailbox; see
  [Limits](./limits.md#sending-as-other-addresses).
- Only a keyed hash of the code is kept (HMAC-SHA256 with the server secret), with when it
  expires, the tries used and the codes sent that day.

## The mailbox's own address

Signing in with it confirms it: the mail server checked its password. With a separate
username (the sign-in page's server settings, where the server allows them), the address
typed in proves nothing by itself, so it's confirmed like any other: **Send a code** sends
one to itself. Until then, mail from it is refused with a note saying so.

## An address at another provider

Sent through your own mail server, an address at another provider fails that provider's
checks at the receiving end (SPF, DKIM and DMARC say your server may not send for it), so
it bounces or goes to junk. With `SEND_AS_SERVERS` on, an address can be sent through its
provider's own SMTP server instead, signed in with that address's username and password,
as other mail apps do.

- When it's added, Viauna signs in to that server and asks it about the address, and the
  code goes from the address to itself through that server, which shows the password
  works too.
- The password is kept the way your mailbox's is
  ([Sessions](./sessions.md#your-password-at-rest)): encrypted with your session's key,
  in your session and nowhere else. Another browser asks for it before it sends from that
  address, and signing out forgets it. Only the server's name, port, security and username
  are kept with the address.
- The servers people enter must be at public addresses, unless `ALLOW_PRIVATE_SERVERS` is
  on, and are checked again at each connection, as at sign-in.
- Mail sent this way is still filed in the mailbox's Sent folder.

## Which addresses count where

| Where | Which addresses |
|---|---|
| Writing: the From list | The mailbox's own address, and the confirmed others |
| Sending | A confirmed address only |
| Saving a draft | Any address in the list |
| Answering an invitation, or organising one | A confirmed address: an answer goes from the address the invitation was sent to |
| The vacation responder's `:addresses` | The confirmed addresses; the script is written again when one is confirmed or removed |
| Answers counted directly between mailboxes on this server | Only the address the mail server checked at sign-in, never another (see [Calendar](./calendar.md)) |
| "me" in lists and conversations | The mailbox's own address, and the confirmed others |

## Upgrading from 0.5

0.5 kept the "Send mail as" addresses in each mailbox's settings, unchecked. 0.6 moves
them into this list, not confirmed: each needs its code (or your server's yes, with
`SEND_AS=server`) before mail goes out from it again. A vacation responder that's on is
written again with only the confirmed addresses the first time its mailbox is used after
the upgrade.
