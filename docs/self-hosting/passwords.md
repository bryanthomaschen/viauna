# Password changes

> [!NOTE]
> Password changes need Viauna 0.3 or newer.

Viauna keeps no passwords of its own: a mailbox's password belongs to your mail server.
So changing it from Viauna (Settings > Accounts > Change password) is handed to whatever
you choose with `PASSWORD_CHANGE`, from the [admin page](./admin.md) or the environment:

| `PASSWORD_CHANGE` | People see | You set |
|---|---|---|
| `off` (the default) | Nothing | |
| `link` | A button to your mail server's own page | `PASSWORD_CHANGE_URL` |
| `command` | A form; Viauna runs your command | `PASSWORD_CHANGE_COMMAND` |
| `webhook` | A form; Viauna calls your webhook | `PASSWORD_CHANGE_WEBHOOK`, `PASSWORD_CHANGE_WEBHOOK_SECRET` |
| `ldap` | A form; Viauna changes it in your directory | `PASSWORD_CHANGE_LDAP_URL`, and how to find the person |

Only mailboxes on your own mail server (`IMAP_HOST`) see it, never one on a server
someone typed in at sign-in.

Where each one goes (the page, the command, the webhook, the directory) is set only in the environment,
never from the admin page: a page that could change them could send everyone to a page
or a program that collects their passwords. The admin page can turn password changes off,
or choose among the ways you've set up.

## A link

The simplest: most mail servers have a page for it.

```yaml
PASSWORD_CHANGE: link
PASSWORD_CHANGE_URL: https://mail.example.com/password
```

`{email}` in the address is filled in with the person's address, if your page wants it,
as in `https://accounts.example.com/reset?user={email}`. `{login}`, `{user}` and
`{domain}` are filled in with their login, the part before the `@` and the part after.
Each is URL-encoded.

For **Mailu**, the page is `/admin/user/password` on your mail hostname (with Mailu's
default `WEB_ADMIN`). It asks for the current password and refuses ones known from data
breaches:

```yaml
PASSWORD_CHANGE: link
PASSWORD_CHANGE_URL: https://mail.example.com/admin/user/password
```

## The form

With a command, a webhook or LDAP, people change their password inside Viauna. It asks for the
current password and the new one (at least 8 characters, and different), checks the
current one with your mail server, then hands the change on. When it succeeds:

- the browser they used stays signed in with the new password;
- every other browser signed in to that mailbox is signed out of it;
- their other mail apps ask for the new password, as they would after any change.

Your command or webhook should make the change take effect before it answers. Viauna
allows five wrong current passwords per mailbox per 15 minutes.

A command and a webhook receive the same request:

```json
{
  "login": "ann@example.com",
  "email": "ann@example.com",
  "currentPassword": "the current password",
  "newPassword": "the new password"
}
```

`login` is what the mail server checked at sign-in; `email` is the address shown in
Viauna. They're the same unless your server uses separate usernames.

### A command

```yaml
PASSWORD_CHANGE: command
PASSWORD_CHANGE_COMMAND: /scripts/change-password
```

Viauna runs it with `/bin/sh -c` and writes the request to its standard input, followed
by a newline.

- **Exit 0**: changed.
- **Anything else**: not changed. The last line the command printed to standard output
  is shown to the person, so print a reason they can act on ("That password is too
  short."). With nothing printed, they see a general message.
- It's stopped after 30 seconds, and the change is reported as failed.
- It runs with only `PATH`, `HOME`, `LANG` and any variable starting with
  `PASSWORD_CHANGE_`, not the rest of Viauna's environment (so never `SECRET_KEY` or
  `DATABASE_URL`). Pass it a token as, say, `PASSWORD_CHANGE_API_TOKEN`.
- When it fails, its exit code and standard error are logged. Never print the passwords.

The image has Node.js, so a script can be JavaScript. Mount it into the container:

```js
// /scripts/change-password.mjs, run as: node /scripts/change-password.mjs
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { login, newPassword } = JSON.parse(input);

const res = await fetch(`https://accounts.example.com/api/users/${encodeURIComponent(login)}/password`, {
  method: "PUT",
  headers: { Authorization: `Bearer ${process.env.PASSWORD_CHANGE_API_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ password: newPassword }),
});
if (!res.ok) {
  console.log(res.status === 422 ? "That password isn't allowed. Try a longer one." : "The account service is unavailable.");
  process.exit(1);
}
```

### A webhook

```yaml
PASSWORD_CHANGE: webhook
PASSWORD_CHANGE_WEBHOOK: https://accounts.example.com/viauna/password
PASSWORD_CHANGE_WEBHOOK_SECRET: a long random string   # openssl rand -base64 32
```

Viauna POSTs the request as JSON, and waits up to 15 seconds.

- **A 2xx answer**: changed.
- **Anything else**: not changed. If the answer is JSON with an `error`, that's shown to
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

### An LDAP directory

When your mail accounts live in LDAP (OpenLDAP, 389 Directory Server, FreeIPA and the
like), Viauna can change the password there itself. It binds as the person with their
current password, then asks the directory to change it with the standard Password Modify
operation ([RFC 3062](https://www.rfc-editor.org/rfc/rfc3062)). The directory hashes the
new password and applies its own password policy; when the policy refuses one, its
reason is shown to the person.

Tell Viauna where the directory is, and how to find the person's entry. Either with a
template:

```yaml
PASSWORD_CHANGE: ldap
PASSWORD_CHANGE_LDAP_URL: ldaps://ldap.example.com
PASSWORD_CHANGE_LDAP_USER_DN: uid={user},ou=people,dc=example,dc=com
```

`{login}` is the whole login (`ann@example.com`), `{user}` the part before the `@`
(`ann`), and `{domain}` the part after. Each is escaped, so no login can change the DN.

Or by a search, as a service account if your directory doesn't allow anonymous ones:

```yaml
PASSWORD_CHANGE: ldap
PASSWORD_CHANGE_LDAP_URL: ldaps://ldap.example.com
PASSWORD_CHANGE_LDAP_SEARCH_BASE: ou=people,dc=example,dc=com
PASSWORD_CHANGE_LDAP_SEARCH_FILTER: (mail={login})   # the default
PASSWORD_CHANGE_LDAP_BIND_DN: cn=viauna,ou=services,dc=example,dc=com
PASSWORD_CHANGE_LDAP_BIND_PASSWORD: the service account's password
```

The search must find exactly one entry. The service account only searches: the change is
made as the person, with their own password.

- **Encryption.** `ldaps://` (port 636) is encrypted from the start. With `ldap://` (port
  389), Viauna upgrades the connection with StartTLS before sending any password. Set
  `PASSWORD_CHANGE_LDAP_STARTTLS=false` only on a network you trust completely: the
  passwords then travel unencrypted.
- **Certificates** are checked against the directory's name. For a test directory with a
  self-signed certificate, `PASSWORD_CHANGE_LDAP_TLS_VERIFY=false` skips that.
- **Access.** The directory's rules must let people change their own password, as most do
  by default (in OpenLDAP, `access to attrs=userPassword by self write`).
- **Active Directory** changes passwords differently (the `unicodePwd` attribute); use a
  command for it.
