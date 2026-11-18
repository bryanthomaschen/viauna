# Getting back in

How "Forgot password?" and reset links work underneath. For setting it up, see
[Passwords](../self-hosting/passwords.md#forgot-password); for using it, see
[Getting back in](../using/recovery.md). The design, and the methods still to come, are
in [`design/mailbox-administration.md`](https://github.com/bryanthomaschen/viauna/blob/main/design/mailbox-administration.md).

## Who sets the password

Viauna never sets a password itself: a mailbox's password belongs to your mail server.
Once someone has proven who they are, Viauna asks the backend (`MAILBOX_ADMIN`) to set
the new one with a `setPassword` request: a command or webhook that says it can, or an
LDAP directory with `MAILBOX_ADMIN_LDAP_RESET`. Without one, recovery isn't offered and
reset links can't be made.

## What's kept

In the state store, for each mailbox that sets recovery up:

- **its recovery address**, and whether it's been confirmed;
- **the code waiting** for it, if any: what it's for (confirming the address, or a
  reset), when it expires, the wrong tries so far, and the codes sent today;
- **its backup codes**, and which have been used.

Codes, backup codes and reset tokens are kept only as **keyed hashes**: HMAC-SHA256 with
the server secret, each labelled with what it's for and, except tokens, the mailbox. A
copy of the database alone can't be used to test guesses, and a hash for one mailbox
can't stand in for another's. A backup code can't be shown again after it's made.

## The codes

- **Emailed codes** are 8 random digits, from `crypto.randomInt`. One to confirm a
  recovery address works for 60 minutes; one for a reset, 15. Five wrong tries void it;
  each try is counted before the code is compared, so tries in parallel can't get past
  five. A code is used up once it's right.
- **Backup codes** are 10 characters of [Crockford's base32](https://www.crockford.com/base32.html)
  (`0`–`9` and letters without I, L, O or U), 50 random bits each, shown as `7KQ2M-9XDR4`.
  As typed, case, spaces and dashes don't matter, and O, I and L are read as 0, 1 and 1.
  Making a new set deletes the old.
- **Sent from Viauna's own sender** (`SENDER_ADDRESS`), since the person can't sign in to
  send from their mailbox. Without a sender, recovery addresses aren't offered.

## Forgot password?, step by step

1. **An address.** Viauna answers at once, the same for any address. Afterwards, only if
   the address is a mailbox on your own mail server (`IMAP_HOST`) that has signed in here
   and has a confirmed recovery address, a reset code is emailed to that address. Since
   the email goes after the answer, neither the words nor the timing say which addresses
   have recovery set up.
2. **A code.** An 8-digit one is checked as an emailed code; anything else as a backup
   code, which is marked used. Either way, a wrong one gets the same answer. A right one
   gets a **reset token**: 32 random bytes, good for 15 minutes and one use, kept as a
   keyed hash.
3. **A new password**, with the token: at least 8 characters, and checked against known
   breaches (below). Viauna sends `setPassword` with `reason: "reset"` and `by:
   "recovery"`. If the backend refuses, its reason is shown and the token can be used
   again; once it succeeds:
   - every token waiting for that mailbox is used up, a reset link included;
   - every session signed in to the mailbox loses it, a session left empty ends, and the
     mailbox's sync stops (it used the old password);
   - a notice goes to the mailbox and to its recovery address, saying when and how.

Turned off, a method (`PASSWORD_RECOVERY_EMAIL`, `PASSWORD_RECOVERY_CODES`) is neither
offered nor accepted; what people set up for it is kept, and works again if it's turned
back on.

## A reset link

An admin makes it on the admin page, for a mailbox address in `ALLOWED_DOMAINS` (if set);
the mailbox needn't have used Viauna. It's a reset token like the one above, good for 24
hours, in the link's `#fragment`: browsers don't send that part to the server, so it's
never in an access log, and Viauna's `Referrer-Policy: no-referrer` keeps it from other
sites. The page reads it and takes it out of the address bar. Finishing it sends
`setPassword` with `reason: "admin"` and `by` set to the admin's login, then does what
step 3 does. Making a link is recorded in Recent changes, with who made it and for which
mailbox, never the link.

## Breached passwords

A new password, whether changed or reset, is checked against
[Have I Been Pwned](https://haveibeenpwned.com/Passwords)'s list of passwords from data
breaches, by its range API:

1. Viauna takes the password's SHA-1 hash, and sends only its **first five hex
   characters**, with `Add-Padding: true`, to `api.pwnedpasswords.com`.
2. The API answers with the remaining characters of every hash it knows that starts that
   way, hundreds of them, padded with made-up ones so even the answer's size gives
   nothing away.
3. Viauna looks for the rest of the hash among them, on your server.

Nothing in the request says whose password it is, or which of the hundreds it was. If
the API can't be reached in 5 seconds, the password is allowed and that's logged: a
breach list being down shouldn't keep people from choosing one. Turn the check off with
`PASSWORD_BREACH_CHECK=false`, for instance where the server may not reach the internet.

## Limits

| | |
|---|---|
| Forgot password? started | 10 per client address every 15 minutes |
| Codes tried | 8 per address and 20 per client address every 15 minutes; 5 tries at one emailed code |
| Codes emailed | One a minute while one is waiting, 5 a day per mailbox |
| Changes to recovery | Need the password, counted as password changes are: 5 per mailbox every 15 minutes |
| A reset token | 15 minutes from recovery, 24 hours from an admin's link; one use |
