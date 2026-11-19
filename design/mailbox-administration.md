# Mailbox administration (design)

> [!NOTE]
> Built for 0.7 (on `main`, not yet released): changing and resetting passwords, recovery,
> admin reset links and the breach check; see [Passwords](../docs/self-hosting/passwords.md)
> and [Getting back in](../docs/how-it-works/recovery.md). Closing and reopening
> mailboxes, and everything under "Later", is still a proposal. This folder isn't part of
> the docs site.

Viauna can't act on a mailbox itself, only on what's in it. Resetting a forgotten
password, or closing a mailbox someone has stopped using, happens on the mail server, in
the mail server's own admin pages. This note describes a small set of **mailbox actions**
that Viauna asks a backend to carry out, so that:

- an admin has one admin page to start from, Viauna's, instead of having to know which
  product owns which setting;
- people can get back into a mailbox whose password they've forgotten (recovery);
- a mailbox can be closed (its mail kept, new mail refused) and reopened later;
- later, mail apps can get app passwords, which a second factor needs.

## Decided

- **0.7 is "Getting back in"**: recovery and admin reset links. Teams and devices move to
  0.8.
- **First recovery methods: a recovery email address and backup codes.** An authenticator
  app comes with the second factor, which uses the same setup.
- **An admin resets a password with a one-time link**, not by typing one: the person
  chooses their own, which the admin never sees or has to pass on. It ships with recovery,
  since on the first day nobody has recovery set up.
- **New passwords are checked against known data breaches**
  ([Have I Been Pwned](https://haveibeenpwned.com/API/v3#PwnedPasswords)'s range API:
  only the first five characters of the password's SHA-1 leave the server).
- **`PASSWORD_CHANGE` is folded into `MAILBOX_ADMIN`**: one backend changes and resets
  passwords.
- **Each recovery method is the admin's to turn off** (`PASSWORD_RECOVERY_EMAIL`,
  `PASSWORD_RECOVERY_CODES`; one per method as more come), keeping what people set up.

## Why actions, and not a standard protocol

Mail itself has standards (IMAP, SMTP, ManageSieve), but administering mailboxes doesn't.
The nearest are:

- **LDAP**, where the mail server keeps its accounts in a directory. Viauna already
  changes passwords there. It covers servers that use a directory, not those that keep
  accounts in their own database.
- **SCIM** ([RFC 7644](https://www.rfc-editor.org/rfc/rfc7644)), the standard for
  managing user accounts, with an `active` flag for exactly this. Few if any mail servers
  speak it.

So Viauna defines a few actions of its own, and a backend translates them: LDAP where it
applies, a webhook or a command for everything else, as the
[backends rule](../docs/architecture.md#backends-and-lock-in) asks.

## Principles

1. **The mail server stays the source of truth** for whether a mailbox exists, whether
   it's open, and its password. Viauna asks; it never keeps a copy, so nothing drifts.
2. **Viauna stores only what mail servers have no idea of**: recovery methods, its own
   second factor, sessions.
3. **Viauna never holds a credential that can run the whole mail server.** A mail
   server's admin API key can usually do anything, deleting domains included. Viauna is
   the part facing the internet, so it sends one signed request, for one action on one
   mailbox, to something that holds that key and allows only these actions.
4. **Off by default.** With no backend set, the admin page links to the mail server's own
   pages, as `LINKS` can today, and recovery isn't offered.
5. **The admin page shows only what the backend can do**, and links to the mail server's
   own pages for the rest (aliases, quotas, domains).

## The actions

| Action | Sent | The backend must | Used by | When |
|---|---|---|---|---|
| `capabilities` | — | Answer `{"actions": [...]}`: those below that it supports | Viauna, at startup and then hourly, to offer only those | 0.7 |
| `changePassword` | `login`, `email`, `currentPassword`, `newPassword` | Change it (Viauna has already checked the current one with the mail server) | Settings > Accounts | 0.7 (was `PASSWORD_CHANGE`) |
| `setPassword` | `login`, `email`, `newPassword`, `reason`, `by` | Set the password **without** the current one, in effect before answering | Recovery (`reason: "reset"`); an admin's reset link (`"admin"`) | 0.7 |
| `status` | `login` | Say whether the mailbox exists, and whether it's open | The admin page | Later |
| `close` | `login` | Refuse new mail to the mailbox while the sender is still connected, and refuse its sign-ins. Keep its mail. | The admin page | Later |
| `reopen` | `login` | Undo `close` | The admin page | Later |

Every request:

- carries `action`, so one webhook or command handles them all;
- names the mailbox by `login`, what the mail server checks at sign-in, and also sends
  `email`, the address shown in Viauna;
- for `setPassword`, sends `by`: the admin's login, or `"recovery"`;
- is answered within 15 seconds (30 for a command): 2xx (exit 0) means done; anything
  else means not done, with an optional `{"error": "..."}` shown to the person.

A backend that doesn't answer `capabilities` is taken to offer `changePassword` only.
Set up under the old `PASSWORD_CHANGE_*` names, Viauna never asks: those scripts were
written for password changes, and an unexpected `setPassword` mustn't reach them.

**`close` must do both halves, or not be offered.** On many servers, turning a user off
only blocks sign-ins: mail still arrives, into a mailbox nobody can read. Refusing while
the sender is still connected (`550 5.2.1`, "mailbox disabled") means the sender's own
server tells them, and nothing here sends a bounce. Addresses that only forward to a
closed mailbox should be refused too.

**Later, for a second factor:** `listAppPasswords`, `createAppPassword` (the secret is
returned once), `revokeAppPassword`, and `requireAppPasswords` for a mailbox.

**Not in scope:** creating or deleting mailboxes and domains, aliases, quotas, DNS. The
mail server's own pages keep those; the admin page links to them.

## Backends

`MAILBOX_ADMIN`: `off` (the default), `link`, `command`, `webhook` or `ldap`, the same
choices as `PASSWORD_CHANGE`, which it replaces. Where each one goes (the page, the
command, the URL, the directory) is set only in the environment, so a stolen admin
session can't point it elsewhere. Every `PASSWORD_CHANGE_*` variable becomes
`MAILBOX_ADMIN_*` with the same suffix; the old names are still read until 1.0, with a
warning at startup.

- **Link** (`MAILBOX_ADMIN_URL`): the mail server's own password page. Changes only: a
  page can't reset a password Viauna has no way to vouch for.
- **Webhook** (`MAILBOX_ADMIN_WEBHOOK`, `MAILBOX_ADMIN_WEBHOOK_SECRET`): a JSON POST
  signed with `X-Viauna-Timestamp` and `X-Viauna-Signature`, with no redirects followed.
- **Command** (`MAILBOX_ADMIN_COMMAND`): the same JSON on standard input, never in the
  arguments; exit 0 means done, and for `capabilities` its standard output is the answer.
- **LDAP**: `changePassword` as today, bound as the person. `setPassword` only with
  `MAILBOX_ADMIN_LDAP_RESET=true`: bound as the service account
  (`MAILBOX_ADMIN_LDAP_BIND_DN`), with the Password Modify operation naming the person's
  entry ([RFC 3062](https://www.rfc-editor.org/rfc/rfc3062)). That's a lasting credential
  in Viauna, so the directory should let it change passwords and nothing else; operators
  who'd rather not have it can use a webhook.

An SQL backend, for servers whose Postfix and Dovecot read accounts from a database,
could come later. Until then, a command does it with a database user allowed only those
updates.

## Recovery (a forgotten password)

People set up recovery while signed in, in **Settings > Accounts**, entering their
password again:

- **a recovery email address**, confirmed with a code sent to it. Viauna sends these
  messages from its own sender (`SENDER_ADDRESS`), since the person can't sign in to send
  from their mailbox; without one, only backup codes are offered.
- **backup codes**: ten, each usable once, shown once, stored only as keyed hashes; a
  printable sheet. Making new ones voids the old.

On the sign-in page, **Forgot password?** asks for the address, then for a code: one
emailed to the recovery address, or a backup code. Then the person chooses a new
password (at least 8 characters, not in a known breach), and Viauna sends `setPassword`
with `"reset"`. Then:

- every session of that mailbox is signed out, and mail apps ask for the new password;
- a notice goes to the mailbox and to the recovery address, from `SENDER_ADDRESS`.

The pages answer the same whether or not the address exists or has recovery set up, so
they can't be used to find out which do. Codes expire (15 minutes for one emailed at a
reset), allow a few wrong tries, and are counted per mailbox and per client address. It's
offered only when the backend supports `setPassword`, only for mailboxes on `IMAP_HOST`,
and only for the methods the admin leaves on (both are, by default). A mailbox is only as safe as its
weakest recovery method: whoever controls the recovery address can reset the password.

## An admin's reset link

On the admin page, **Reset a password** takes a mailbox address and makes a link, good
for 24 hours and one use, which the admin hands over however they like (in person, by
phone, in a chat). The link opens a page where the person chooses a new password; Viauna
sends `setPassword` with `"admin"` and `by` set to the admin, signs the mailbox out
everywhere, and sends the mailbox a notice. The token is in the link's `#fragment`, so it
never reaches a server log or another site. The mailbox needn't have used Viauna before.
Making a link is recorded in **Recent changes** (who, when, which mailbox).

## A second factor for signing in to Viauna

An authenticator app and the same backup codes, asked for after the password at sign-in.

Mail apps (IMAP, SMTP) can't ask for a code, so this protects signing in to Viauna, not
the mailbox. To protect the mailbox, its server must refuse the real password from mail
apps and accept only app passwords, which needs the later actions above and a server that
can require them. Some can only require them for everyone at once. Viauna itself signs in
over IMAP and SMTP with the mailbox's password
([sessions](../docs/how-it-works/sessions.md#your-password-at-rest)), so on such a server
it would need an app password of its own for each mailbox. That's left open.

## Later recovery methods

- **Authenticator app**, with the second factor.
- **A trusted contact**: someone the person names, often on the same server, gets a code
  and reads it to them after recognising their voice. Suits families, and servers with no
  admin desk.
- **Approval from a signed-in device**: someone still signed in on their phone approves
  the reset there. Only from sessions old enough, with a notice, or a stolen session
  could take over the account.
- **A waiting period** for weaker methods: a reset by recovery email takes effect after,
  say, 24 hours, while the mailbox is told and can cancel from any signed-in device.

Not planned: SMS (a number can be moved to another SIM, and it needs a paid provider), and
security questions (guessable; [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html)
rules them out).

## Passkeys

Signing in with a device's lock screen, with the passkey synced between devices, so less
is ever lost. It clashes with how Viauna works today: it needs the mailbox password to
read mail over IMAP. With passkeys it would keep an app password for each mailbox,
ideally sealed by the passkey itself (the WebAuthn PRF extension) so that the database
alone still opens nothing. A project of its own, after app passwords.

## An example adapter: Mailu

A small service next to Mailu, not code in Viauna. It holds Mailu's API key and does only
these actions:

- `changePassword` and `setPassword`: `PATCH /api/v1/user/{email}` with `raw_password`.
  A change checks the current password again with Mailu (`/internal/auth/basic`); a reset
  is refused for global admins, domain managers and closed mailboxes, so the webhook
  secret can't be turned into control of the server. It calls `admin:8080` directly on
  Mailu's network: Mailu's admin serves the API whenever `API_TOKEN` is set, and `API=true`
  would only expose it on `front` too, so `API` stays false (built 2026-11-19; see
  [Running Viauna next to Mailu](../docs/self-hosting/mailu.md#a-webhook-for-resets));
- later, `status`: `GET /api/v1/user/{email}`, and `close` and `reopen`: the same
  `PATCH`, with `enabled` false or true.

Mailu's `enabled` only blocks sign-ins; mail to a disabled user is still delivered. So
for `close` the adapter will also answer a Postfix lookup (`check_recipient_access` over
a socketmap) that refuses mail to disabled users, and to aliases that lead only to them.
Mailu itself is unchanged. It starts in one deployment's own infrastructure, and may move
into this repository as an optional image once the actions settle.

## In order

1. 0.7: `MAILBOX_ADMIN` with `capabilities`, `changePassword` and `setPassword`;
   recovery; admin reset links; the breach check.
2. Closing and reopening mailboxes, from the admin page.
3. A second factor for signing in to Viauna, with an authenticator app.
4. App passwords.

## Open questions

- What a closed mailbox's owner sees at sign-in. The mail server only says the password
  was refused; Viauna could ask `status` and say the mailbox is closed, which also tells
  anyone trying that address.
- Whether `status` should list mailboxes, so the admin page can show them all, or stay
  one mailbox at a time.
- Exporting recovery methods along with the rest of a person's data, as the backends rule
  asks. (Backup codes can't be exported: only their hashes are kept.)
