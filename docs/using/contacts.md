# Contacts

> [!NOTE]
> Contacts need Viauna 0.4 or newer.

Each mailbox has its own address book: open **Contacts** in the menu on the left. Your
server's admins can turn it off, in which case it isn't there.

## Adding people

- **Create contact** asks for a name, a nickname, labels, company and job title, as many
  email addresses and phone numbers as you like (each with a label such as Home or
  Work), a birthday, other dates, and notes.
- From a message, open its menu (the three dots) and choose **Add … to contacts**. The
  name and address are filled in from the message; if they're already a contact,
  that contact opens instead.
- **Add a birthday**, in the menu at the top (the three dots), asks only for a name and
  a birthday: for a friend whose address or number you don't have.
- **Import** (the upload button) reads a vCard file, `.vcf`, the format address books
  share. One file can hold thousands of contacts.

Click a contact to change or delete it.

## Labels

A label says what someone is to you: Family, Church, Work, the running club. Type one in
a contact's **Labels** box and press Enter; the box suggests the labels you already use.
A contact can have several.

Labels show next to the name in the list, and next to the name when Viauna suggests them
while you write. They're never sent: the person you write to sees only the name.

- The menu beside **Contacts** (it says **All contacts**) lists your labels, with how many
  people have each. Pick one to see only those people. The address in the browser says
  which (`…/contacts/label/Church`), so Back works and the view can be bookmarked.
- With a label picked, **Create contact** starts with that label, and the menu at the top
  (the three dots) can **Rename label** or **Remove label** for everyone who has it. Renaming
  one to the name of another makes the two one label. Removing a label leaves the
  people.
- "Church" and "church" are the same label.

## Tidying names

Many people put who someone is into their name: "Bryan - church", "Mei (work)". That
name goes out with their address when you write to them, so they see it too.
**Tidy up names**, in the menu at the top (the three dots), finds names like these and
shows what it would do: "Bryan - church" becomes Bryan, labelled Church. People are
grouped by label, and you can change each label's name, or untick anyone to leave them
as they are. Nothing changes until you press **Tidy**, and it never runs by itself.

It looks for a name followed by a dash with spaces round it (" - ", " – " or " — ") and
something after it, or by something in brackets at the end. A hyphen inside a name
(Mary-Jane) isn't one, and brackets holding Jr., Sr., II, III, IV, PhD, MD, Esq. or MBA are
left alone.

## Birthdays and other dates

A birthday is a day and a month, with the year if you know it. **Add a date** adds an
anniversary, or any other date with your own label for it ("First day at work"), again
with or without its year.

A date that another app wrote in words, such as "circa 1950", is kept as it is and shown
as written; **Replace** swaps it for a date.

## A nickname

The **Nickname** is matched while you write: type "Bobby" and Bob Tan is suggested. Like
labels, it's never sent. Several nicknames can go in, separated by commas.

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
out with an export. Labels go out as the contact's categories, which Thunderbird, Outlook
and Android apps show, and dates as Apple's and Google's apps write them; see
[How it works: Contacts](../how-it-works/contacts.md#what-viauna-reads-and-writes).

## On your other devices

If your server syncs contacts with a CardDAV server, your contacts are the same in
Viauna, on your phone and in other apps set up with that server. A change you make here
is sent within a couple of seconds; changes made elsewhere arrive every ten minutes
while you have Viauna open, when you open Contacts (if it last synced more than a
minute ago), or when you press **Sync now** (the circular arrows). The line under the
title says when it last synced, or what went wrong. If a contact was changed in both
places, the two are merged: see [How it works: Contacts](../how-it-works/contacts.md).

## While you write

As you type a name, nickname or address in To, Cc or Bcc, Viauna suggests your contacts
first, then people you've exchanged mail with, up to 8 in all. A contact's labels show
beside their name ("Bryan · Church"); only the name and address go into the message.
