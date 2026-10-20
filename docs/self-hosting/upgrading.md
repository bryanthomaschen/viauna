# Upgrades and backups

Your mail lives on your mail server; back that up as you already do. Viauna keeps its own
state in the data directory (`/data` in the container), or in your database if you set
[`DATABASE_URL`](./databases.md).

## What's in the data directory

| Path | Holds | If it's lost |
|---|---|---|
| `state.db` | Accounts and sessions; each mailbox's settings (name, signature, send-as addresses, image preference, page size); label names and colours; senders whose images are always shown. Not present if you use `DATABASE_URL`, which holds these instead. | Everyone signs in again, and those settings and colours are gone. Mail is untouched, and labels stay on the messages because they live on the server. **Back this up.** |
| `index.db` | The mail index: folders, conversations, message summaries, label keywords seen on messages, and the addresses you correspond with, for autocomplete | Nothing that matters: Viauna re-syncs from the mail server. |
| `secret.key` | The generated server secret (absent if you set `SECRET_KEY`) | Everyone signs in again. |
| `cache/` | Downloaded messages, up to `CACHE_MB` | Nothing: they're fetched again. |
| `uploads/` | Attachments of messages being written | Those attachments, until they're added again. |

## Backing up

Keep `state.db` and `secret.key`; `index.db` and `cache/` can be skipped. With
`DATABASE_URL`, back up that database the way you back up any other, plus `secret.key`.

- **Simplest**: stop the container, copy the two files, start it again.
- **Without stopping**: use SQLite's backup command, which makes a consistent copy of a
  live database. On the host, with the `sqlite3` tool installed:

  ```bash
  DATA=$(docker volume inspect viauna-data --format '{{ .Mountpoint }}')
  sudo sqlite3 "$DATA/state.db" ".backup '/backups/state.db'"
  sudo cp "$DATA/secret.key" /backups/
  ```

> [!WARNING]
> Don't just copy `state.db` while Viauna is running. The database runs in WAL mode, so
> recent changes sit in `state.db-wal` until they're merged, and a plain copy can come
> out inconsistent.

## Upgrading

Each release is listed on [GitHub](https://github.com/bryanthomaschen/viauna/releases)
with notes on what changed. With Docker Compose:

```bash
docker compose pull
docker compose up -d
```

With `docker run`, pull the new image, then remove the container and run it again with
the same options; the data volume keeps everything.

Pin a minor version, such as `ghcr.io/bryanthomaschen/viauna:0.2`, and each pull brings
that version's fixes without surprises. Move to the next one (`0.3`) after reading its
release notes: before 1.0, a new minor version may change settings or behaviour.

The database schema updates itself on start. Back up `state.db` first: going back to an
older version after an upgrade isn't tested. People stay signed in across an upgrade as
long as the data volume and the secret are kept.

The version you're running is shown at the foot of the sign-in page.

### From 0.1 to 0.2

0.1 kept everything in one file, `viauna.db`. On its first start, 0.2 copies the accounts,
sessions, settings, label colours and trusted senders into `state.db` (or into your
`DATABASE_URL` database), and renames `viauna.db` to `index.db`, since what's left is the
mail index. It also empties the message cache once, because cached files are now named
differently. Everyone stays signed in. Back up `viauna.db` before upgrading.
