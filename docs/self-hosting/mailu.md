# Running Viauna next to Mailu

Viauna talks to Mailu's `front` container over the standard ports, so Mailu needs no
changes and upgrades independently.

```yaml
# Add to (or alongside) your Mailu docker-compose.yml
services:
  viauna:
    image: ghcr.io/bryanthomaschen/viauna:0.6
    restart: unless-stopped
    environment:
      PUBLIC_URL: https://webmail.example.com
      TRUST_PROXY: "true"
      # Mailu's front container, reached over the compose network…
      IMAP_HOST: front
      IMAP_PORT: "993"
      SMTP_HOST: front
      SMTP_PORT: "465"
      # …with its certificate checked against the public mail hostname.
      IMAP_TLS_SERVERNAME: mail.example.com
      SMTP_TLS_SERVERNAME: mail.example.com
      ALLOWED_DOMAINS: example.com
    volumes:
      - viauna-data:/data
    networks:
      - default

volumes:
  viauna-data:
```

Then proxy `https://webmail.example.com` to `viauna:3000` (see [Reverse proxy](./reverse-proxy.md)). Viauna expects its own hostname: it can't yet be served under a sub-path.

Notes:

- Sign in with the full mailbox address and its password, or a Mailu
  **authentication token** (Mailu admin → *Authentication tokens*) if you'd rather not
  use the main password.
- Mailu rate-limits failed logins per IP (`AUTH_RATELIMIT_IP`), and every login made
  through Viauna comes from the Viauna container's address — so one person mistyping a
  password counts against everyone. Exempt the Viauna container's subnet with Mailu's
  `AUTH_RATELIMIT_EXEMPTION`; Viauna applies its own per-IP and per-login limits to the
  real client addresses (set `TRUST_PROXY=true` so it sees them).
- Mailu enables Dovecot full-text search when `FULL_TEXT_SEARCH` is set, which makes
  body search in Viauna fast.
- "Report spam" and "Not spam" move messages into and out of Junk exactly as any other
  client does, so Mailu's spam training on those moves applies.
- To let people change their password from Viauna, link to Mailu's own page, which
  checks the current password and refuses breached ones:
  `MAILBOX_ADMIN: link` and
  `MAILBOX_ADMIN_URL: https://mail.example.com/admin/user/password`. See
  [Passwords](./passwords.md). A link can't reset a forgotten password, though. For that,
  Forgot password? and admins' reset links, use a webhook that sets the password with
  Mailu's API: see [A webhook for resets](#a-webhook-for-resets) below.
- Mailu refuses a sender a login doesn't own (its own address, and the aliases its admin
  pages give it), so `SEND_AS: server` lets Mailu's check confirm the addresses people add
  in "Send mail as", without codes. See
  [Sending as other addresses](../how-it-works/sending.md).
- Filters and the vacation responder work as they are: Viauna reaches ManageSieve on
  `front`, port 4190. Mailu's own auto-reply (in its admin pages) is separate; with both
  on, people get two replies. See [Filters and vacation](./filters.md).
- To sync contacts with Mailu's own CardDAV server, turn it on in Mailu
  (`WEBDAV=radicale`) and set `CARDDAV_URL: https://mail.example.com/webdav/`. Phones
  and Thunderbird can then use the same address books. See
  [Contacts and CardDAV](./contacts.md).
- To make yourself an admin of Viauna (not of Mailu):
  `docker compose exec viauna viauna admin add you@example.com`. See
  [The admin page](../administration/admin-page.md).

## A webhook for resets

Mailu's own password page can't reset a forgotten password, so Forgot password? and
admins' reset links need a [webhook](./passwords.md#a-webhook) that sets passwords with
Mailu's API. Mailu's API token can do anything to your mail server (create mailboxes,
make admins, read every setting), so don't give it to Viauna. Run the webhook as its own
small service beside Mailu that holds the token and does only what Viauna asks.

How it reaches Mailu, as of Mailu 2024.06:

- **Leave `API=false`.** Mailu's `admin` container serves the API whenever `API_TOKEN`
  is set; `API=true` only makes `front` serve it too, at `/api` on your public hostname.
  The webhook doesn't need that: put it on Mailu's compose network and call
  `http://admin:8080/api/v1` directly.
- **Give the token only to `admin` and the webhook.** Every Mailu container reads
  `mailu.env`, `front` included, so keep `API_TOKEN` in a file of its own that only
  those two read (it overrides `mailu.env`'s empty `API_TOKEN=`).
- **Setting a password** is `PATCH /api/v1/user/{email}` with
  `{"raw_password": "…"}` and `Authorization: Bearer <token>`. Mailu hashes it, and it
  works at once (its Dovecot keeps no cache of passwords).

So that whoever holds the webhook's secret can't take over the server through it:

- **On `changePassword`, check the current password again** rather than taking Viauna's
  word for it: `GET http://admin:8080/internal/auth/basic` with HTTP Basic credentials
  (the address and the current password) answers 200 for the right one. It's the check
  Mailu's `front` uses for web logins, so it counts toward Mailu's rate limits as any
  login does.
- **On `setPassword`, refuse anyone who can administer Mailu**: a mailbox with
  `global_admin` in `GET /api/v1/user/{email}`, or in the `managers` of any domain in
  `GET /api/v1/domain`. An admin resets a forgotten password in Mailu instead (`flask
  mailu password` in the `admin` container), so do your Mailu administration from a
  separate admin mailbox and keep the ones you use every day ordinary: those get Forgot
  password?.
- **Refuse a closed mailbox** (`enabled` false) too. Answer each refusal with an
  `error` saying why: Viauna shows it to the person.

```yaml
services:
  admin:
    env_file: [mailu.env, mailbox-admin.env]   # API_TOKEN=… (openssl rand -hex 32)
  mailbox-admin:                                # your webhook
    build: ./mailbox-admin
    env_file: mailbox-admin.env                 # API_TOKEN, and the webhook's secret
    environment:
      MAILU_URL: http://admin:8080
  viauna:
    environment:
      MAILBOX_ADMIN: webhook
      MAILBOX_ADMIN_WEBHOOK: http://mailbox-admin:8080/
      MAILBOX_ADMIN_WEBHOOK_SECRET: the same secret as the webhook's
```

The webhook answers `capabilities` with `{"actions": ["changePassword", "setPassword"]}`,
and checks each request's signature before anything else, as
[A webhook](./passwords.md#a-webhook) shows.
