# Running Viauna next to Mailu

Viauna talks to Mailu's `front` container over the standard ports, so Mailu needs no
changes and upgrades independently.

```yaml
# Add to (or alongside) your Mailu docker-compose.yml
services:
  viauna:
    image: ghcr.io/bryanthomaschen/viauna:0.5
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
  `PASSWORD_CHANGE: link` and
  `PASSWORD_CHANGE_URL: https://mail.example.com/admin/user/password`. See
  [Password changes](./passwords.md).
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
