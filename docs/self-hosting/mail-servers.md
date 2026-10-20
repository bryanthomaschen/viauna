# Mail servers

Viauna uses only standard IMAP and SMTP, so it should work with any compliant server. It
is developed and tested against Dovecot, the IMAP server inside Mailu, mailcow and
docker-mailserver.

## What the server needs

- **IMAP** over TLS (993) or STARTTLS (143).
- **SMTP submission with authentication**, over TLS (465) or STARTTLS (587), accepting
  the same login as IMAP. Each message is sent with the signed-in person's own password.
- **A Sent folder.** Viauna files a copy of each sent message there itself, as most IMAP
  servers expect.
- For **labels**: custom keywords (`PERMANENTFLAGS \*`). Dovecot, Cyrus, Stalwart and
  most others allow them. Folders work either way.

CONDSTORE/QRESYNC, MOVE, UIDPLUS, SPECIAL-USE and IDLE are used when the server offers
them, with fallbacks when it doesn't.

For **filters and the vacation responder**: ManageSieve, usually port 4190. See
[Filters and vacation](./filters.md).

**Search** runs on the server. A full-text search plugin (Dovecot's fts-flatcurve or
fts-xapian, for example) keeps searches of message bodies fast on large mailboxes.

## Connecting over a Docker network

When Viauna runs next to your mail server, connect over the shared Docker network, and
check the certificate against the public hostname:

```yaml
IMAP_HOST: dovecot                      # the mail container's name on the network
IMAP_TLS_SERVERNAME: mail.example.com   # the name on its certificate
SMTP_HOST: postfix
SMTP_TLS_SERVERNAME: mail.example.com
```

## Logins through Viauna come from one address

Your mail server sees every sign-in made through Viauna as coming from Viauna's own
address. If it blocks addresses after failed logins (Mailu's `AUTH_RATELIMIT_IP`, or
fail2ban watching Dovecot), a few mistyped passwords, or one attacker, can lock out
everyone who uses Viauna. Exempt Viauna's address there. Viauna applies its own limits
to the real client addresses instead: 20 attempts per address and 8 per login every
15 minutes, with `TRUST_PROXY` on so it can see those addresses.

## Tested with

| Server | Status |
|---|---|
| Dovecot 2.3 | Tested: the development and CI server |
| Mailu 2024.06 | Tested; see [Mailu](./mailu.md) |
| mailcow, docker-mailserver | Dovecot inside, so expected to work; not yet tested |
| Stalwart, Cyrus | Expected to work; not yet tested |

Running Viauna with another server? Please
[tell us how it went](https://github.com/bryanthomaschen/viauna/issues/new?template=server_report.yml),
whether it worked or not.

## Hosted mailboxes

Viauna can sign in to a hosted mailbox that offers IMAP and SMTP with a password or an
app password: point `IMAP_HOST` and `SMTP_HOST` at the provider, or turn on
`ALLOW_CUSTOM_SERVERS` so people can enter their own.

- **Gmail** isn't a target: its IMAP works differently (it files its own copy of sent
  mail, and its labels are folders).
- Providers that **require OAuth sign-in**, such as Outlook.com, don't work yet.
