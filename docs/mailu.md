# Running Wren next to Mailu

Wren talks to Mailu's `front` container over the standard ports, so Mailu needs no
changes and upgrades independently.

```yaml
# Add to (or alongside) your Mailu docker-compose.yml
services:
  wren:
    image: wren:latest
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
      - wren-data:/data
    networks:
      - default

volumes:
  wren-data:
```

Then proxy `https://webmail.example.com` to `wren:3000` (see the README's nginx
example). Wren expects its own hostname: it can't yet be served under a sub-path.

Notes:

- Sign in with the full mailbox address and its password, or a Mailu
  **authentication token** (Mailu admin → *Authentication tokens*) if you'd rather not
  use the main password.
- Mailu rate-limits failed logins per IP (`AUTH_RATELIMIT_IP`), and every login made
  through Wren comes from the Wren container's address — so one person mistyping a
  password counts against everyone. Exempt the Wren container's subnet with Mailu's
  `AUTH_RATELIMIT_EXEMPTION`; Wren applies its own per-IP and per-login limits to the
  real client addresses (set `TRUST_PROXY=true` so it sees them).
- Mailu enables Dovecot full-text search when `FULL_TEXT_SEARCH` is set, which makes
  body search in Wren fast.
- "Report spam" and "Not spam" move messages into and out of Junk exactly as any other
  client does, so Mailu's spam training on those moves applies.
