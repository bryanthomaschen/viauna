# Filters and the vacation responder

> [!NOTE]
> Filters and the vacation responder need Viauna 0.5 or newer.

Viauna keeps each mailbox's filters and vacation responder on the mail server, as a
[Sieve](https://www.rfc-editor.org/rfc/rfc5228) script, the standard rule language mail
servers run as mail arrives. It reads and saves the script over
[ManageSieve](https://www.rfc-editor.org/rfc/rfc5804), signed in as the mailbox. So the
rules work with Viauna closed, and in every mail app.

## What the server needs

- **ManageSieve**, usually on port 4190 with STARTTLS. Dovecot has it through Pigeonhole
  (Mailu, mailcow and docker-mailserver include it); Stalwart and Cyrus have their own.
- **These Sieve extensions**, which Pigeonhole has by default: `fileinto`, `imap4flags`
  (marking read, starring and labels), `body` (words in the message), `mime`
  (attachments), `copy` (forwarding), `vacation`, `date` and `relational` (the
  vacation responder's days), `mailbox` and `include`. Viauna uses only the ones a
  filter needs, and says which the server lacks if it can't save one.
- For the vacation responder and forwarding, a way for the server to **send mail**
  (Dovecot's `submission_host` or `sendmail_path`; Mailu sets this up).

## Setting it up

Usually nothing: Viauna connects to ManageSieve on your IMAP server's host, port 4190,
with STARTTLS (or without encryption if IMAP has none), checking the same certificate
name as IMAP. On a Docker network with Mailu, that's its `front` container, as for IMAP.

If yours is elsewhere:

| Variable | Default | |
|---|---|---|
| `MANAGESIEVE_HOST` | `IMAP_HOST` | |
| `MANAGESIEVE_PORT` | `4190` | |
| `MANAGESIEVE_SECURITY` | `starttls` (`none` if IMAP's is) | `starttls`, `tls` or `none` (testing only). |
| `MANAGESIEVE_TLS_SERVERNAME`, `MANAGESIEVE_TLS_VERIFY` | IMAP's | |

Only mailboxes on your own mail server (`IMAP_HOST`) have filters.

## On the admin page

| Setting | Variable | Default | |
|---|---|---|---|
| Filters | `FILTERS` | on | |
| Vacation responder | `VACATION` | on | |
| Forwarding in filters | `FILTER_FORWARDING` | **off** | |

Forwarding is off unless you turn it on: someone who stole a session could otherwise
add a filter that quietly sends a person's mail elsewhere, with no trace in their inbox.
With it off, a filter that already forwards keeps working until the next time that
mailbox's filters are saved, when Viauna asks for the forwarding to be removed.

Turning filters or the vacation responder off hides them in Viauna. Rules a mailbox
already has keep running on the mail server until they're changed, since they live
there.

## How the script is kept

Viauna owns one script per mailbox, called `viauna`, and makes it the active one. If
another script was active (Roundcube's `roundcube`, say), Viauna's script includes it
after its own rules, so those rules keep running. When a mailbox has no filters and no
vacation responder left, Viauna deletes its script and makes the other one active
again.

The script starts with a comment holding Viauna's own copy of the filters, which is how
it reads them back exactly. If someone edits the script by hand, Viauna notices and
warns before replacing it.

Mailu has its own auto-reply and forwarding, in its admin pages; they run before every
mailbox's script. If someone turns on both Mailu's auto-reply and Viauna's vacation
responder, they'll send two replies.
