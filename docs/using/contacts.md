# Contacts

> [!NOTE]
> Contacts need Viauna 0.4 or newer.

Each mailbox has its own address book: open **Contacts** in the menu on the left. Your
server's admins can turn it off, in which case it isn't there.

## Adding people

- **Create contact** asks for a name, company and job title, as many email addresses
  and phone numbers as you like (each with a label such as Home or Work), a birthday
  and notes.
- From a message, open its menu (the three dots) and choose **Add … to contacts**. The
  name and address are filled in from the message; if they're already a contact,
  that contact opens instead.
- **Import** (the upload button) reads a vCard file, `.vcf`, the format address books
  share. One file can hold thousands of contacts.

Click a contact to change or delete it.

## Moving contacts in and out

To bring your contacts over:

| From | Export as vCard |
|---|---|
| Google Contacts | [contacts.google.com](https://contacts.google.com) → Export → vCard |
| Apple Contacts | Select the contacts, then File → Export → Export vCard |
| Thunderbird | Address Book → right-click the address book → Export → vCard |
| Roundcube | Contacts → Export |

Importing the same file again doesn't add anyone twice: a contact that's already here
(the same vCard UID) is replaced by the file's version. Contacts that name nobody (no
name, company, email address or phone number), or are over 1 MB, are skipped, and the
import says how many. One file can be up to 20 MB and 10,000 contacts.

**Export** (the download button) saves every contact as one `.vcf` file that any
address book can read.

Viauna keeps each contact exactly as it was imported, and changes only the fields you
edit here. Photos, postal addresses and anything else another app stored travel back
out with an export.

## On your other devices

If your server syncs contacts with a CardDAV server, your contacts are the same in
Viauna, on your phone and in other apps set up with that server. A change you make here
is sent within a couple of seconds; changes made elsewhere arrive every ten minutes
while you have Viauna open, when you open Contacts (if it last synced more than a
minute ago), or when you press **Sync now** (the circular arrows). The line under the
title says when it last synced, or what went wrong. If a contact was changed in both
places, the two are merged: see [How it works: Contacts](../how-it-works/contacts.md).

## While you write

As you type a name or address in To, Cc or Bcc, Viauna suggests your contacts first,
then people you've exchanged mail with, up to 8 in all.
