# Upgrades and backups

Your mail lives on your mail server; back that up as you already do. Viauna keeps only
its own state, in the data directory (`/data` in the container).

## What's in the data directory

| Path | Holds | If it's lost |
|---|---|---|
| `viauna.db` | Sessions; each mailbox's settings (name, signature, send-as addresses, image preference, page size); label colours; senders whose images are always shown; the mail index; the addresses you correspond with, for autocomplete | Everyone signs in again and Viauna re-syncs. Mail is untouched, and labels stay on the messages because they live on the server, but those settings and colours are gone. |
| `secret.key` | The generated server secret (absent if you set `SECRET_KEY`) | Everyone signs in again. |
| `cache/` | Downloaded messages, up to `CACHE_MB` | Nothing: they're fetched again. |
| `uploads/` | Attachments of messages being written | Those attachments, until they're added again. |

## Backing up

Keep `viauna.db` and `secret.key`; `cache/` can be skipped.

- **Simplest**: stop the container, copy the two files, start it again.
- **Without stopping**: use SQLite's backup command, which makes a consistent copy of a
  live database. On the host, with the `sqlite3` tool installed:

  ```bash
  DATA=$(docker volume inspect viauna-data --format '{{ .Mountpoint }}')
  sudo sqlite3 "$DATA/viauna.db" ".backup '/backups/viauna.db'"
  sudo cp "$DATA/secret.key" /backups/
  ```

> [!WARNING]
> Don't just copy `viauna.db` while Viauna is running. The database runs in WAL mode, so
> recent changes sit in `viauna.db-wal` until they're merged, and a plain copy can come
> out inconsistent.

## Upgrading

Viauna is pre-1.0 and has no tagged releases yet, so upgrading means building from the
latest `main`:

```bash
cd viauna
git pull
docker build -t viauna .
docker compose up -d     # or remove the container and run it again as before
```

The database schema updates itself on start. Back up `viauna.db` first: going back to an
older version after an upgrade isn't tested. People stay signed in across an upgrade as
long as the data volume and the secret are kept.

The version you're running is shown at the foot of the sign-in page.
