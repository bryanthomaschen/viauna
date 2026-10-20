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
| Gmail | [contacts.google.com](https://contacts.google.com) → Export → vCard |
| Apple Contacts | Select the contacts, then File → Export → Export vCard |
| Thunderbird | Address Book → right-click the address book → Export → vCard |
| Roundcube | Contacts → Export |

Importing the same file again doesn't add anyone twice: a contact that's already here
is updated instead. Contacts that name nobody (no name, company or address) are
skipped, and the import says how many.

**Export** (the download button) saves every contact as one `.vcf` file that any
address book can read.

Viauna keeps each contact exactly as it was imported, and changes only the fields you
edit here. Photos, postal addresses and anything else another app stored travel back
out with an export.

## While you write

As you type a name or address in To, Cc or Bcc, Viauna suggests your contacts first,
then people you've exchanged mail with.
