# Limits

Limits built into Viauna. The ones you can change are settings: see
[Configuration](../self-hosting/configuration.md).

## Reading and writing mail

| Limit | Value |
|---|---|
| Largest attachment | `MAX_UPLOAD_MB`, 25 MB by default (a setting) |
| Attachments on one message | 100 |
| Recipients | 500 each in To, Cc and Bcc |
| Subject | 998 characters |
| Message text | 5,000,000 characters of HTML |
| Attachments kept while you write | 2 days from adding them; then attach them again |
| A message opened | At most 200 MB of it is downloaded |
| Undo | 10 minutes, and not after a restart |
| Conversations per page | 25, 50 or 100 |
| A new folder's name | 200 characters |
| A label's name | 1 to 100 characters |

## Search

| Limit | Value |
|---|---|
| Matches per folder | The newest 3,000 |
| The same search again | Answered from memory for 60 s |

## Filters and the vacation responder

| Limit | Value |
|---|---|
| Filters per mailbox | 200 |
| From, To, Subject, Has the words, Doesn't have | 500 characters each |
| Forwarding address | 320 characters |
| Other apps' scripts included | 5 |
| Vacation subject | 200 characters |
| Vacation message | 10,000 characters |
| Replies to one sender | One every 4 days |

## Contacts

| Limit | Value |
|---|---|
| One import | 20 MB and 10,000 contacts |
| One contact | 1 MB as a vCard |
| Labels on a contact | 30, each 1 to 60 characters |
| Dates on a contact | A birthday and 20 others |
| A date's label | 60 characters |
| Nickname | 200 characters |
| Deleted at once | 10,000 |
| Listed at a time | 200, then 200 more with **Show more** |
| Suggestions while you write | 8 |

## Calendar

| Limit | Value |
|---|---|
| Calendars per mailbox | 50 |
| A calendar's name | 1 to 100 characters, on one line |
| An event's title | 500 characters |
| Location | 1,000 characters |
| Description | 20,000 characters |
| Video call link | 2,000 characters, starting `https://` or `http://` |
| Repeat every | 1 to 999 days, weeks, months or years |
| Repeat so many times | 1 to 9,999 |
| Occurrences worked out | 50,000 from the first |
| A rule made in another app | 2,000 characters |
| One import | 20 MB and 10,000 events |
| One event | 1 MB as iCalendar |
| Events asked for at once | 400 days |
| Search results | The newest 200 |
| Undo | 10 minutes, and not after a restart |

## Accounts and settings

| Limit | Value |
|---|---|
| Accounts per browser | `MAX_ACCOUNTS`, 10 by default (a setting, 1 to 100) |
| Session length | `SESSION_DAYS`, 30 by default (a setting, 1 to 3,650) |
| Sign-in attempts | 20 per client address and 8 per login, every 15 minutes |
| Password changes | 5 per mailbox every 15 minutes |
| New password | 8 to 1,024 characters |
| Your name | 200 characters |
| Signature | 20,000 characters |
| Send-as addresses | 50 |
| `APP_NAME` | 60 characters, on one line |
| A list setting (`ADMIN_ADDRESSES`, `ALLOWED_DOMAINS`) | 1,000 entries |
| Changes shown | The newest 25 on the admin page, 50 with `viauna changes` |

## Waiting on other systems

| Limit | Value |
|---|---|
| Connecting to IMAP | 30 s, and 16 s for the server's greeting |
| ManageSieve | 15 s without an answer |
| A CardDAV request | 20 s |
| A password command | 30 s, then it's stopped |
| A password webhook or LDAP directory | 15 s |
| A reason shown from a command, webhook or directory | 200 characters |
