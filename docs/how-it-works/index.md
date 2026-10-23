# How it works

Viauna is a Node server between your browser and your mail server. It signs in to the
mail server with each person's own login, keeps a local index of their folders so lists
and counts are instant, and keeps what people chose (accounts, sessions, settings,
contacts, calendars) in its state store. Your mail itself stays on the mail server. These pages say
what happens behind the scenes, with the timings and limits taken from the code. You
don't need any of it to use or run Viauna.

## What happens when…

| When… | See |
|---|---|
| New mail arrives, in the Inbox or another folder | [Mail sync](./sync.md#how-fresh-the-list-is) |
| A folder you made in another app doesn't show | [Mail sync](./sync.md#which-folders-show) |
| You search | [Mail sync](./sync.md#search) |
| A reply joins its conversation, or starts a new one | [Conversations](./conversations.md) |
| Something changes and open pages update | [Live updates](./live-updates.md) |
| An admin changes a setting | [Live updates](./live-updates.md#settings-changes) |
| You sign in, sign out, or change your password | [Sessions](./sessions.md) |
| You open a message, or attach a file | [Your data](./data.md#caches) |
| Viauna restarts | [Your data](./data.md#when-viauna-restarts) |
| Someone stops using Viauna | [Your data](./data.md#after-someone-stops-using-viauna) |
| You wonder what Viauna sends where | [Your data](./data.md#what-leaves-the-server) |
| Mail arrives and a filter or the vacation responder runs | [Filters](./filters.md) |
| A contact changes here or on your phone | [Contacts](./contacts.md) |
| You type a recipient | [Contacts](./contacts.md#suggestions-while-you-write) |
| You make or move an event, or travel to another time zone | [Calendar](./calendar.md) |
| You import or export a calendar file | [Calendar](./calendar.md#calendar-files) |
| You hit a size or count limit | [Limits](./limits.md) |

For how the code is laid out, see [Architecture](../architecture.md).
