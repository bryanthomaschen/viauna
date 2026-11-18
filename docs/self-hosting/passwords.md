# Passwords

> [!NOTE]
> Password changes need Viauna 0.3 or newer; resets, and the name `MAILBOX_ADMIN`, need
> 0.7. Before 0.7 it was `PASSWORD_CHANGE`, which still works until 1.0.

Viauna keeps no passwords of its own: a mailbox's password belongs to your mail server.
So changing it from Viauna (Settings > Accounts > Change password), or resetting a
forgotten one, is handed to whatever you choose with `MAILBOX_ADMIN`, from the
[admin page](../administration/admin-page.md) or the environment:

| `MAILBOX_ADMIN` | Changing a password | Resetting a forgotten one | You set |
|---|---|---|---|
| `off` (the default) | Not offered | Not offered | |
| `link` | A button to your mail server's own page | Not offered | `MAILBOX_ADMIN_URL` |
| `command` | A form; Viauna runs your command | If your command says it can | `MAILBOX_ADMIN_COMMAND` |
| `webhook` | A form; Viauna calls your webhook | If your webhook says it can | `MAILBOX_ADMIN_WEBHOOK`, `MAILBOX_ADMIN_WEBHOOK_SECRET` |
| `ldap` | A form; Viauna changes it in your directory | With `MAILBOX_ADMIN_LDAP_RESET` | `MAILBOX_ADMIN_LDAP_URL`, and how to find the person |

Only mailboxes on your own mail server (`IMAP_HOST`) see either, never one on a server
someone typed in at sign-in.

Where each one goes (the page, the command, the webhook, the directory) is set only in
the environment, never from the admin page: a page that could change them could send
everyone to a page or a program that collects their passwords. The admin page can turn
this off, or choose among the ways you've set up.

## A link

The simplest: most mail servers have a page for it. A page can only change a password:
Viauna has no way to vouch for someone who forgot theirs.

```yaml
MAILBOX_ADMIN: link
MAILBOX_ADMIN_URL: https://mail.example.com/password
```

`{email}` in the address is filled in with the person's address, if your page wants it,
as in `https://accounts.example.com/reset?user={email}`. `{login}`, `{user}` and
`{domain}` are filled in with their login, the part before the `@` and the part after.
Each is URL-encoded.

For **Mailu**, the page is `/admin/user/password` on your mail hostname (with Mailu's
default `WEB_ADMIN`). It asks for the current password and refuses ones known from data
breaches:

```yaml
MAILBOX_ADMIN: link
MAILBOX_ADMIN_URL: https://mail.example.com/admin/user/password
```

## The form

With a command, a webhook or LDAP, people change their password inside Viauna. It asks for the
current password and the new one (at least 8 characters, and different), checks the
current one with your mail server, then hands the change on. When it succeeds:

- the browser they used stays signed in with the new password;
- every other browser signed in to that mailbox is signed out of it;
- their other mail apps ask for the new password, as they would after any change.

Your command or webhook should make the change take effect before it answers. Viauna
allows 5 attempts that don't succeed per mailbox every 15 minutes: a wrong current
password counts, and so does a change your command, webhook or directory refused. See
[sign-in limits](../how-it-works/sessions.md#sign-in-limits).

## The requests

A command and a webhook receive the same requests, as JSON. Each says what it's for in
`action`, so one script handles them all.

**`changePassword`**: someone changes their own password. Viauna has already checked the
current one with your mail server.

```json
{
  "action": "changePassword",
  "login": "ann@example.com",
  "email": "ann@example.com",
  "currentPassword": "the current password",
  "newPassword": "the new password"
}
```

**`setPassword`**: a reset, with no current password, after someone proved who they are
another way. `reason` is `"reset"` (they used Forgot password?) or `"admin"` (an admin's
reset link), and `by` is `"recovery"` or that admin's login.

```json
{
  "action": "setPassword",
  "login": "ann@example.com",
  "email": "ann@example.com",
  "newPassword": "the new password",
  "reason": "reset",
  "by": "recovery"
}
```

**`capabilities`**: which of those your script does. Viauna asks when it starts and then
hourly, and offers only what the answer lists:

```json
{ "action": "capabilities" }
```

```json
{ "actions": ["changePassword", "setPassword"] }
```

`login` is what the mail server checked at sign-in; `email` is the address shown in
Viauna. They're the same unless your server uses separate usernames.

A script that doesn't answer `capabilities` with that JSON is taken to change passwords
only (it's asked again a minute later, in case it was briefly down). One set up under its
pre-0.7 name (`PASSWORD_CHANGE_COMMAND`, `PASSWORD_CHANGE_WEBHOOK`) is never asked, and
never sent a reset: it was written for password changes, and keeps getting only those,
now with `"action": "changePassword"` added.

### A command

```yaml
MAILBOX_ADMIN: command
MAILBOX_ADMIN_COMMAND: /scripts/mailbox-admin
```

Viauna runs it with `/bin/sh -c` and writes the request to its standard input, followed
by a newline.

- **Exit 0**: done. For `capabilities`, what it prints is the answer.
- **Anything else**: not done. The last line the command printed to standard output
  is shown to the person, so print a reason they can act on ("That password is too
  short."). With nothing printed, they see a general message.
- It's stopped after 30 seconds, and the request is reported as failed.
- It runs with only `PATH`, `HOME`, `LANG` and any variable starting with
  `MAILBOX_ADMIN_` (or `PASSWORD_CHANGE_`), not the rest of Viauna's environment (so
  never `SECRET_KEY` or `DATABASE_URL`). Pass it a token as, say,
  `MAILBOX_ADMIN_API_TOKEN`.
- When it fails, its exit code and standard error are logged. Never print the passwords.

The image has Node.js, so a script can be JavaScript. Mount it into the container:

```js
// /scripts/mailbox-admin.mjs, run as: node /scripts/mailbox-admin.mjs
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);

if (request.action === "capabilities") {
  console.log(JSON.stringify({ actions: ["changePassword", "setPassword"] }));
  process.exit(0);
}
if (request.action !== "changePassword" && request.action !== "setPassword") process.exit(1);

const res = await fetch(`https://accounts.example.com/api/users/${encodeURIComponent(request.login)}/password`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${process.env.MAILBOX_ADMIN_API_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ password: request.newPassword }),
});
if (!res.ok) {
  console.log(res.status === 422 ? "That password isn't allowed. Try a longer one." : "The account service is unavailable.");
  process.exit(1);
}
```

### A webhook

```yaml
MAILBOX_ADMIN: webhook
MAILBOX_ADMIN_WEBHOOK: https://accounts.example.com/viauna/mailbox
MAILBOX_ADMIN_WEBHOOK_SECRET: a long random string   # openssl rand -base64 32
```

Viauna POSTs the request as JSON, and waits up to 15 seconds.

- **A 2xx answer**: done. For `capabilities`, its body is the answer.
- **Anything else**: not done. If the answer is JSON with an `error`, that's shown to
  the person: `{"error": "That password is too short."}`.
- Redirects aren't followed.

Each request carries two headers, so your webhook can tell it came from Viauna and isn't
a replay:

- `X-Viauna-Timestamp`: the time it was sent, in seconds since 1970;
- `X-Viauna-Signature`: `sha256=` and the hex HMAC-SHA256, keyed with the secret, of the
  timestamp, a dot, and the raw request body.

Check both before doing anything:

```js
import crypto from "node:crypto";

function fromViauna(headers, rawBody, secret) {
  const timestamp = headers["x-viauna-timestamp"];
  if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const given = String(headers["x-viauna-signature"] ?? "");
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```

Viauna won't start with a webhook but no secret.

## An LDAP directory

When your mail accounts live in LDAP (OpenLDAP, 389 Directory Server, FreeIPA and the
like), Viauna can change the password there itself. It binds as the person with their
current password, then asks the directory to change it with the standard Password Modify
operation ([RFC 3062](https://www.rfc-editor.org/rfc/rfc3062)). The directory hashes the
new password and applies its own password policy; when the policy refuses one, its
reason is shown to the person.

Tell Viauna where the directory is, and how to find the person's entry. Either with a
template:

```yaml
MAILBOX_ADMIN: ldap
MAILBOX_ADMIN_LDAP_URL: ldaps://ldap.example.com
MAILBOX_ADMIN_LDAP_USER_DN: uid={user},ou=people,dc=example,dc=com
```

`{login}` is the whole login (`ann@example.com`), `{user}` the part before the `@`
(`ann`), and `{domain}` the part after. The template must contain `{user}` or `{login}`.
Each is escaped, so no login can change the DN.

Or by a search, as a service account if your directory doesn't allow anonymous ones:

```yaml
MAILBOX_ADMIN: ldap
MAILBOX_ADMIN_LDAP_URL: ldaps://ldap.example.com
MAILBOX_ADMIN_LDAP_SEARCH_BASE: ou=people,dc=example,dc=com
MAILBOX_ADMIN_LDAP_SEARCH_FILTER: (mail={login})   # the default
MAILBOX_ADMIN_LDAP_BIND_DN: cn=viauna,ou=services,dc=example,dc=com
MAILBOX_ADMIN_LDAP_BIND_PASSWORD: the service account's password
```

The filter must contain `{user}` or `{login}`, and the search must find exactly one
entry. Set either `MAILBOX_ADMIN_LDAP_USER_DN` or the search, not both; a service
account needs both its DN and its password. For a change, the service account only
searches: the change is made as the person, with their own password.

`MAILBOX_ADMIN_LDAP_URL` is the directory's address alone, with a port if it isn't the
usual one, and no path: `ldaps://ldap.example.com:6360`. Viauna won't start with any of
these wrong, and says which.

- **Encryption.** `ldaps://` (port 636) is encrypted from the start. With `ldap://` (port
  389), Viauna upgrades the connection with StartTLS before sending any password. Set
  `MAILBOX_ADMIN_LDAP_STARTTLS=false` only on a network you trust completely: the
  passwords then travel unencrypted.
- **Certificates** are checked against the directory's name. For a test directory with a
  self-signed certificate, `MAILBOX_ADMIN_LDAP_TLS_VERIFY=false` skips that.
- **Access.** The directory's rules must let people change their own password, as most do
  by default (in OpenLDAP, `access to attrs=userPassword by self write`).
- **Active Directory** changes passwords differently (the `unicodePwd` attribute); use a
  command for it.

### Resets over LDAP

A reset has no current password to bind with, so it's made as the service account:

```yaml
MAILBOX_ADMIN_LDAP_BIND_DN: cn=viauna,ou=services,dc=example,dc=com
MAILBOX_ADMIN_LDAP_BIND_PASSWORD: the service account's password
MAILBOX_ADMIN_LDAP_RESET: "true"
```

Bound as that account, Viauna sends the same Password Modify operation, naming the
person's entry and with no old password. The directory must let the account change
other people's passwords: in OpenLDAP, add `by dn.exact="cn=viauna,ou=services,dc=example,dc=com" write`
to the rule for `userPassword`. Give it that and nothing else: its password is kept in
Viauna's environment for as long as resets are on. If you'd rather it weren't, a webhook
on another machine can make resets instead.

## Forgot password?

Once your backend can reset passwords (a command or webhook that answers `setPassword`
in its capabilities, or LDAP with `MAILBOX_ADMIN_LDAP_RESET`), the sign-in page offers
**Forgot password?**, and Settings > Accounts offers **Recovery**:

| Way in | Needs | Turn off with |
|---|---|---|
| A recovery address, confirmed with a code; a code sent to it at a reset | [Viauna's own sender](./configuration.md#viauna-s-own-sender) (`SENDER_ADDRESS`), which sends the codes and notices | `PASSWORD_RECOVERY_EMAIL=false` |
| Backup codes, ten at a time, each good once | Nothing more | `PASSWORD_RECOVERY_CODES=false` |

Both are on by default, and can also be turned off from the admin page. Turned off, what
people set up is kept but not used, and works again if it's turned back on.

When someone proves who they are, Viauna sends your backend `setPassword` with `reason:
"reset"`, signs the mailbox out of every session, and emails a notice to the mailbox and
its recovery address. Only mailboxes on your own mail server (`IMAP_HOST`) that have
signed in to Viauna can set recovery up. How it works, and its limits:
[Getting back in](../how-it-works/recovery.md).

## Reset links

An admin can make a **reset link** on the admin page, for a mailbox with no recovery set
up, or one that has never signed in to Viauna. It works once, for 24 hours; the person
opens it and chooses their own password, and your backend gets `setPassword` with
`reason: "admin"` and `by` set to the admin's login. See
[The admin page](../administration/admin-page.md#reset-a-password).

## Breached passwords

A new password, changed or reset, must be at least 8 characters and, while
`PASSWORD_BREACH_CHECK` is on (the default), not one known from a data breach. Viauna
asks [Have I Been Pwned](https://haveibeenpwned.com/Passwords)'s range API, sending only
the first 5 characters of the password's SHA-1 hash, so your server needs to reach
`api.pwnedpasswords.com` over HTTPS. If it can't, the password is allowed and a warning
is logged. Your backend may refuse passwords for its own reasons too; its message is
shown. See [Breached passwords](../how-it-works/recovery.md#breached-passwords).
