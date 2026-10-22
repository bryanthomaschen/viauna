# Contacts

Each mailbox's contacts are in the state store, each kept whole as its vCard. Viauna
rewrites only the fields it shows (name, nickname, email addresses, phone numbers,
company, job title, birthday and other dates, labels, notes), so a photo, a postal
address or another app's own fields survive. For setting up sync, see
[Contacts and CardDAV](../self-hosting/contacts.md).

## What Viauna reads and writes

| In Viauna | In the vCard |
|---|---|
| First and last name | `N` (its other parts, such as a prefix, are kept), and `FN` made from them |
| Nickname | `NICKNAME`, several separated by commas |
| Labels | `CATEGORIES` |
| Email addresses, phone numbers | `EMAIL`, `TEL`, each with its `TYPE` (home, work, mobile…) or Apple's own label |
| Company, job title | `ORG` (its department is kept), `TITLE` |
| Birthday | `BDAY` |
| Anniversary | `ANNIVERSARY` in a vCard 4.0 card; in a 3.0 card, which has none, Apple's `X-ABDATE` labelled `_$!<Anniversary>!$_`, as Apple and Google write it |
| Other dates | `X-ABDATE` with its own `X-ABLabel` (Apple's form, which Google also writes) |
| Notes | `NOTE` |

A field that wasn't changed keeps its properties exactly as they were written, so saving
a contact after changing its job title doesn't rewrite its birthday or labels.

**Dates** are read as apps write them: `1990-05-12` or `19900512` (sometimes with a time,
which is ignored), and without a year as `--05-12` or `--0512`. Apple marks a date without
a year by giving it the year 1604 and `X-APPLE-OMIT-YEAR=1604`, which is read as no year.
KDE's `X-ANNIVERSARY` is read as an anniversary. A date Viauna writes or changes is
`1990-05-12` or `--05-12` in a 3.0 card, and `19900512` or `--0512` in a 4.0 card, as
RFC 6350 has it; it takes none of the old value's parameters, so Apple's 1604 can't become
a real year. A date written in words (`BDAY;VALUE=text:circa 1950`) is shown as it is and
kept unless replaced.

**Labels** compare without case or accents, so "Church" and "church" are one label;
the list of labels shows each as most of its contacts spell it. Google's export lists its own groups among the categories (`myContacts`,
`starred`): they stay in the card, ahead of the labels, and aren't shown as labels.

Beside each card, the state store keeps what's needed without reading it: its name, a
text to search (names, nickname, company, addresses and phone digits, lower-cased and
without accents), its addresses, its labels, and its dates. Upgrading from 0.5 fills
these in from the contacts already there, the first time Viauna starts.

## When contacts sync

With `CARDDAV_URL` set and `CONTACTS_SYNC` on, a mailbox on your own mail server
(`IMAP_HOST`) syncs:

- 2 s after its [runtime](./sync.md#the-connections-to-your-mail-server) starts, then
  every 10 minutes while it runs, that is while someone has Viauna open, and for up to
  10 minutes after;
- 1.5 s after a change in Viauna, so a burst of edits is sent once (unless a sync starts
  before then, which sends it);
- when someone opens Contacts and the last sync that worked ended more than a minute
  ago, or there's been none since a restart;
- on **Sync now**.

One sync runs per mailbox at a time. A change in Viauna or **Sync now** asking while
another runs queues one more, to start when that one ends and shared by everyone who asks
meanwhile: the running one may have read the contacts before the change. The 10-minute
sync and the one on opening Contacts make do with the one running. Each signs in to the
CardDAV server with the mailbox's own login and password. The page hears on the
[live-update stream](./live-updates.md) when a sync starts and ends, and refetches the
list. When the last sync ended, and how, is kept in memory, so after a restart the page
shows nothing until the next one.

## Finding the address books

Viauna fills in `CARDDAV_URL`'s placeholders and finds the mailbox's address books from
there, the standard way (RFC 6764, then RFC 6352). It looks again on **Sync now**, after
a sync fails, on the first sync after a restart, and at least every 24 hours. If the
mailbox has none, it makes one called "Contacts". An address book gone from the server
takes its contacts out of Viauna too.

## A sync, step by step

1. **Deletions made here** are sent, each with the card's ETag (`If-Match`). If the card
   changed on the server since, it's deleted anyway: it was still meant to go.
2. **Contacts made here** go to the first address book, as `<UID>.vcf`, only if the server
   has no card there (`If-None-Match: *`). If it has, the server's copy is kept instead
   of a second one.
3. **Edits made here** are sent with the ETag Viauna last saw (`If-Match`), so a card
   changed elsewhere in the meantime is never overwritten unseen.
4. **Changes made elsewhere** are fetched: only what changed since the last sync
   (`sync-collection`, RFC 6578, from the book's sync token), or, on a server without it,
   a list of every card's ETag. Changed cards are fetched together
   (`addressbook-multiget`). A contact with changes not yet sent is never overwritten or
   deleted by this step.

## When both sides changed a contact

When an edit is refused because the card changed on the server (`412`), Viauna fetches
the server's card and merges three ways, against `base`, the card as it was at the last
sync:

- a field changed in Viauna since then takes Viauna's value;
- every other field takes the server's, as do the fields Viauna doesn't show.

All of a contact's email addresses count as one field, as do its phone numbers. Without a
`base`, the fields Viauna shows take Viauna's values. Then:

- a card deleted on the server but edited here is put back;
- in an address book the mailbox can't write to (`403` or `405`), the edit isn't sent
  and the server's copy stands. It replaces the edit here the next time Viauna fetches
  the card: at the same sync on a server without `sync-collection`, otherwise when the
  card next changes on the server.

If the server has the same card in two address books, Viauna keeps both.

## When sync is off, or moves

While `CONTACTS_SYNC` is off, or `CARDDAV_URL` is unset, edits and deletions of synced
contacts are still recorded, and sent when sync is on again. Pointing `CARDDAV_URL` at a different server
finds new address books there: the old ones, and their contacts, are removed from
Viauna, changes not yet sent included. Contacts made in Viauna and never synced are sent
to the new server.

## Tidying names

**Tidy up names** looks at each contact's name (`FN`) for context after it:

- a dash with a space either side (`-`, `–` or `—`), and anything after it: "Bryan -
  church", or "Ann Lee - Acme - sales", where the label is "Acme - sales";
- or something in brackets at its end: "Mei Ling (Work)". Jr., Sr., II, III, IV, PhD, MD,
  Esq. and MBA in brackets aren't context.

What follows becomes a label, with a capital first letter if it was all lower case, or
spelled as a label already in use. The first and last names lose it: from the last name if
it's there ("Bryan" and "- church" become "Bryan"), else from the first. If it's inside the
first name with a last name after it, which part is the context isn't clear, and the
contact isn't offered. Nothing else changes; the name is then made from the first and last
names as usual.

Only the contacts ticked change, and each is checked again when it does: one whose name
was edited since the list was made is left alone.

## Suggestions while you write

As you type in To, Cc or Bcc, Viauna suggests up to 8 people:

1. **your contacts** whose name, nickname or address contains what you typed, those whose
   address starts with it first (unless `CONTACTS` is off), each with its labels to show
   beside it. The name sent is the contact's name, which never includes its labels or
   nickname;
2. **people you correspond with**, from the [mail index](./sync.md): the senders of mail
   you received, and the recipients of mail in Sent. Junk, Trash and Drafts aren't
   counted, nor addresses starting with `no-reply`, `noreply` or `mailer-daemon`. They're
   ranked by whether the address starts with what you typed, then by how often you
   write to them (counted five times) plus how often they write to you, then by how
   recently.

Only mail the index has reached counts, so in a mailbox still being indexed, older
correspondents show up as it fills in.
