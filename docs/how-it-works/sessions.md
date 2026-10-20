# Sessions

Viauna has no user database of its own. Signing in is your mailbox's own IMAP login: if
the mail server accepts it, Viauna records the account (the login and the mail server)
and starts a session for your browser.

## The cookie

The session is one cookie, `viauna_session`: `HttpOnly`, `SameSite=Lax`, and `Secure`
unless `SECURE_COOKIES` is off (by default, when `PUBLIC_URL` is plain `http://`). It holds two random values, a session id and a
key. The state store keeps only the SHA-256 of the session id, with when the session
started and was last used, the client address it signed in from and the browser's user
agent.

## Your password at rest

Viauna needs your mailbox password while you're signed in, to sync and send. It keeps it
in the state store encrypted with AES-256-GCM, under a key derived (HKDF-SHA256) from the
cookie's key, the server secret (`SECRET_KEY`, or the generated `secret.key`), the session
and the account. So the database, or a backup of it, opens nothing on its own, and
neither does a cookie without the server secret. Changing or losing the server secret
makes every saved password unreadable: everyone signs in again.

Several mailboxes in one browser share one session, each with its own encrypted password,
up to `MAX_ACCOUNTS`.

## How long you stay signed in

A session lasts `SESSION_DAYS` (30 by default) from its last use. When a request arrives
and the session was last extended more than an hour ago, the server moves its expiry to
`SESSION_DAYS` from now and sends the cookie again with the same lifetime. So you stay
signed in for `SESSION_DAYS` after your last visit, to within an hour. A changed
`SESSION_DAYS` reaches a browser the next time its session is extended. Expired sessions
are deleted every hour.

## Passwords are checked again

Every session proves its own password, and Viauna trusts a proof for 10 minutes:

- Once a mailbox's sync has used its password for 10 minutes, the next request logs in
  again to check it. If the server refuses, the sync stops and you're asked to sign in
  again. A connection refused for the password while syncing does the same.
- A session whose saved password differs from the one sync uses logs in with its own,
  and if that works, the sync's password is checked at once (at most once a minute).
- Admin rights are checked the same way, so they end within 10 minutes of the admin's
  password changing or the mailbox going.
- A mail server that can't be reached proves nothing either way: you see an error, and
  aren't signed out.

So after a password is changed in another app, a session still holding the old one is
refused within 10 minutes. Mail is always sent with the requesting session's own
password.

## Signing out

- **Signing out of one account** removes it from this browser's session. Signing out of
  the last one ends the session and clears the cookie.
- **Other browsers** stay signed in. There's no list of sessions to end yet. Changing
  `SECRET_KEY` and restarting signs out everyone, everywhere.
- **Changing your password in Viauna** (Settings > Accounts) keeps this browser signed in
  with the new password, signs every other browser out of that mailbox (ending any
  session left empty), and restarts the mailbox's sync.
- **Open pages** stop receiving a signed-out mailbox's updates at the next event, or
  within 25 s; see [Live updates](./live-updates.md#signing-out-ends-the-stream).
- Signing out doesn't delete the mailbox's index or cached messages; see
  [Your data](./data.md#after-someone-stops-using-viauna).

## Sign-in limits

Viauna counts sign-in attempts before trying them, so a burst of parallel requests can't
slip under the limit:

- **20 attempts per client address, and 8 per login, every 15 minutes.** A successful
  sign-in doesn't count. One the mail server couldn't answer counts against the address
  but not the login.
- **5 password changes per mailbox every 15 minutes.** Every attempt that doesn't
  succeed counts: a wrong current password, or one your command, webhook or directory
  refused. They also count towards the address's 20.

The client address is the connection's, or with `TRUST_PROXY` on, the last
`X-Forwarded-For` entry, the one your proxy added. The counters are kept in memory, so a
restart resets them.
