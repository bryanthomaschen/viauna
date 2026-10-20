# Contacts and CardDAV

> [!NOTE]
> Contacts need Viauna 0.4 or newer.

Each mailbox has an address book (see [Contacts](../using/contacts.md) for how people use
it). It's on by default and needs nothing set up: contacts are kept in Viauna's state
store with everything else, so back that up as usual. Turn it off with `CONTACTS=false`
or from the [admin page](./admin.md); contacts already saved are kept.

## Syncing with a CardDAV server

To have the same contacts in Viauna, on people's phones and in Thunderbird, point Viauna
at a CardDAV server you run:

```yaml
CARDDAV_URL: https://dav.example.com/
```

Each mailbox signs in to it with **its own login and password**, the ones it uses for
mail. That's how CardDAV servers built into mail systems work, and how standalone ones
are usually set up next to a mail server (authenticating against IMAP or the same
directory). Viauna finds each person's address books from the address, the standard
way (RFC 6764 and RFC 6352); if someone has none yet, it makes one called "Contacts".

| Server | `CARDDAV_URL` |
|---|---|
| Mailu, with `WEBDAV=radicale` | `https://mail.example.com/webdav/` |
| Radicale | `https://dav.example.com/` |
| Nextcloud (logins checked against your mail server) | `https://cloud.example.com/remote.php/dav/` |
| Baïkal | `https://dav.example.com/dav.php/` |
| SOGo | `https://mail.example.com/SOGo/dav/` |

If your server wants each person's own address in the URL, `{login}`, `{user}` (the part
before the `@`) and `{domain}` are filled in: `https://dav.example.com/{login}/`.

`CARDDAV_URL` is set only in the environment, never from the admin page, because
Viauna sends each mailbox's password to it. Only mailboxes on your own mail server
(`IMAP_HOST`) sync; one on a server someone typed in at sign-in never has its password
sent anywhere else. The admin page can still turn syncing off and on
(`CONTACTS_SYNC`).

### How it syncs

Once sync is on, the server holds the contacts and Viauna keeps a synced copy for
listing, searching and suggestions.

- **The first sync** sends the contacts already saved in Viauna to the person's first
  address book, each named after its vCard UID (`<UID>.vcf`). A card the server already
  has under that name is matched, not doubled, and the server's copy is kept.
- **A change in Viauna** is sent within a couple of seconds. It's sent only if the card
  hasn't changed on the server since (`If-Match`). If it has, Viauna applies the fields
  changed in Viauna to the server's newer card, so neither side's other changes are
  lost.
- **Changes made elsewhere** come in every ten minutes while someone has Viauna open,
  when they open Contacts (if the last sync was more than a minute ago), and with
  **Sync now**. Viauna asks only for what changed (`sync-collection`, RFC 6578) and lists
  every card's ETag on a server that lacks it.
- **Several address books** are all shown; new contacts go to the first.
- In an address book the mailbox can't write to, changes made in Viauna aren't sent:
  the server's copy stands.

When each sync runs, and how a contact changed on both sides is merged, is in
[How it works: Contacts](../how-it-works/contacts.md).

The Contacts page shows where it syncs and how the last sync went: "Synced with
dav.example.com 3 minutes ago", or the error.

### If you change or remove it

Turning sync off keeps the synced copy, and changes made meanwhile are sent if it's
turned on again. Pointing `CARDDAV_URL` at a different server replaces each person's
contacts in Viauna with the new server's: the old server still has them.
