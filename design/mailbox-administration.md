# Mailbox administration (design)

> [!NOTE]
> A proposal: nothing here is built. This folder isn't part of the docs site; when a
> feature ships, its pages go in `docs/` and this note says so.

Viauna can't act on a mailbox itself, only on what's in it. Resetting a forgotten
password, or closing a mailbox someone has stopped using, happens on the mail server, in
the mail server's own admin pages. This note proposes a small set of **mailbox actions**
that Viauna asks a backend to carry out, so that:

- an admin has one admin page to start from, Viauna's, instead of having to know which
  product owns which setting;
- people can get back into a mailbox whose password they've forgotten (recovery);
- a mailbox can be closed (its mail kept, new mail refused) and reopened later;
- later, mail apps can get app passwords, which a second factor needs.

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

| Action | Sent | The backend must | Used by |
|---|---|---|---|
| `capabilities` | — | Answer with the actions below that it supports | Viauna, at startup and then hourly, to show only those |
| `status` | `login` | Say whether the mailbox exists, and whether it's open | The admin page |
| `setPassword` | `login`, `newPassword`, `reason` | Set the password **without** the current one, in effect before answering | Recovery (`reason: "reset"`); an admin (`"admin"`) |
| `close` | `login` | Refuse new mail to the mailbox while the sender is still connected, and refuse its sign-ins. Keep its mail. | The admin page |
| `reopen` | `login` | Undo `close` | The admin page |

Changing your own password (the current one and a new one) stays as it is, under
[`PASSWORD_CHANGE`](../docs/self-hosting/passwords.md).

Every action:

- may be repeated: closing a closed mailbox succeeds;
- names the mailbox by `login`, what the mail server checks at sign-in, and also sends
  `email`, the address shown in Viauna;
- sends `by`: the admin's login, or `"recovery"`;
- is answered within 15 seconds: 2xx means done; anything else means not done, with an
  optional `{"error": "...", "permanent": true}` shown to the admin.

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

`MAILBOX_ADMIN`: `off` (the default), `webhook`, `command` or `ldap`. Where each one goes
(the URL, the command, the directory) is set only in the environment, as for
`PASSWORD_CHANGE`, so a stolen admin session can't point it elsewhere.

- **Webhook** (`MAILBOX_ADMIN_WEBHOOK`, `MAILBOX_ADMIN_WEBHOOK_SECRET`): as for password
  changes, a JSON POST signed with `X-Viauna-Timestamp` and `X-Viauna-Signature`, with no
  redirects followed. Its own URL and secret, since it can do more. The body:
  `{"action": "close", "login": "ann@example.com", "email": "ann@example.com", "by": "admin@example.com"}`.
- **Command** (`MAILBOX_ADMIN_COMMAND`): the same JSON on standard input, never in the
  arguments; exit 0 means done.
- **LDAP**: `setPassword` with the Password Modify operation
  ([RFC 3062](https://www.rfc-editor.org/rfc/rfc3062)); `close`, `reopen` and `status` by
  writing and reading an attribute the mail server checks, which the operator names, with
  its open and closed values (for example `nsAccountLock`, or a `mailEnabled` attribute).
  Unlike password changes, this binds as a service account allowed to change other
  people's entries. That's a lasting credential in Viauna, so the directory should limit
  it to those two attributes. Operators who'd rather not have it can use a webhook.

An SQL backend, for servers whose Postfix and Dovecot read accounts from a database,
could come later. Until then, a command does it with a database user allowed only those
updates.

## Who can do what

- **Admin actions** (`status`, `close`, `reopen`, `setPassword` with `"admin"`): only
  [Viauna admins](../docs/administration/admin-page.md), only for mailboxes on the
  server's own mail server (`IMAP_HOST`), and within `ALLOWED_DOMAINS` when it's set.
  Each is recorded in **Recent changes** (who, when, which mailbox; never a password). An
  admin can't close their own mailbox.
- **After `close` or `setPassword`**, Viauna signs that mailbox out of every session at
  once, instead of waiting for the
  [10-minute password check](../docs/how-it-works/sessions.md#passwords-are-checked-again).
- **Limits**, like password changes: a few tries per mailbox and per client address every
  15 minutes. Every failure counts, including those the backend refused.

## Recovery (a forgotten password)

People set up recovery while signed in, in **Settings > Accounts**, entering their
password again. There are three methods, kept in Viauna's database for that mailbox:

- **a recovery email address**, confirmed with a code sent to it;
- **an authenticator app** (TOTP, [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238));
- **backup codes**: ten, each usable once, stored hashed.

On the sign-in page, **Forgot password?** asks for the address. If that mailbox has a
method set up, it's asked for. Once verified, the person chooses a new password (the same
rules as changing it), and Viauna sends `setPassword` with `"reset"`. Then:

- every session of that mailbox is signed out, and mail apps ask for the new password;
- a notice goes to the mailbox and to the recovery address, from `SENDER_ADDRESS`.

The page answers the same whether or not the address exists or has a method, so it can't
be used to find out which do. It's offered only when the backend supports `setPassword`,
and only for mailboxes on `IMAP_HOST`. A mailbox is only as safe as its weakest recovery
method: whoever controls the recovery address can reset the password.

## A second factor for signing in to Viauna

The same authenticator app and backup codes, asked for after the password at sign-in.

Mail apps (IMAP, SMTP) can't ask for a code, so this protects signing in to Viauna, not
the mailbox. To protect the mailbox, its server must refuse the real password from mail
apps and accept only app passwords, which needs the later actions above and a server that
can require them. Some can only require them for everyone at once. Viauna itself signs in
over IMAP and SMTP with the mailbox's password
([sessions](../docs/how-it-works/sessions.md#your-password-at-rest)), so on such a server
it would need an app password of its own for each mailbox. That's left open.

## An example adapter: Mailu

A small service next to Mailu, not code in Viauna. It holds Mailu's API key and does only
these actions:

- `status`: `GET /api/v1/user/{email}`;
- `setPassword`: `PATCH /api/v1/user/{email}` with `raw_password`;
- `close` and `reopen`: the same, with `enabled` false or true.

Mailu's `enabled` only blocks sign-ins; mail to a disabled user is still delivered. So
the adapter also answers a Postfix lookup (`check_recipient_access` over a socketmap)
that refuses mail to disabled users, and to aliases that lead only to them. Mailu itself
is unchanged. It starts in one deployment's own infrastructure, and may move into this
repository as an optional image once the actions settle.

## In order

1. The actions, the webhook and command backends, and the admin page: `status`, `close`,
   `reopen`, and `setPassword` by an admin.
2. Recovery.
3. A second factor for signing in to Viauna.
4. App passwords.

## Open questions

- Fold `PASSWORD_CHANGE` into `MAILBOX_ADMIN` (one backend), or keep them apart because
  one acts as the person and the other above them?
- What a closed mailbox's owner sees at sign-in. The mail server only says the password
  was refused; Viauna could ask `status` and say the mailbox is closed, which also tells
  anyone trying that address.
- Whether `status` should list mailboxes, so the admin page can show them all, or stay
  one mailbox at a time.
- Exporting recovery methods and second factors along with the rest of a person's data,
  as the backends rule asks.
