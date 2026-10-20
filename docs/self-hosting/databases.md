# Databases

> [!NOTE]
> Choosing a database needs Viauna 0.2 or newer.

Viauna keeps two kinds of data, apart:

- **State**, which must survive: accounts and who is signed in, each mailbox's settings
  (name, signature, send-as addresses, image preference, page size), label names and
  colours, the senders whose images are always shown, settings changed on the admin page
  with the record of changes, and contacts. It lives in SQLite by default, or in
  PostgreSQL, MySQL or MariaDB.
- **The mail index**, a cache of your mail server: folders, conversations, message
  summaries, and the addresses you correspond with. It is always SQLite, in
  `DATA_DIR/index.db`, and is rebuilt from the mail server if it's lost.

## The default: SQLite

There's nothing to set up. State is kept in `DATA_DIR/state.db`, which is plenty for one
Viauna serving many people.

## PostgreSQL, MySQL or MariaDB

Set `DATABASE_URL`:

| Engine | `DATABASE_URL` | Tested with |
|---|---|---|
| PostgreSQL | `postgres://viauna:PASSWORD@db.example.com:5432/viauna` | 17 |
| MySQL | `mysql://viauna:PASSWORD@db.example.com:3306/viauna` | 8.4 |
| MariaDB | `mariadb://viauna:PASSWORD@db.example.com:3306/viauna` | 11.4 |

Give Viauna a database of its own (its tables have plain names such as `accounts` and
`sessions`) and a user that can create tables in it. Viauna creates its tables on first
start and updates them on upgrades. URL-encode any special characters in the password.
Driver options, such as TLS settings, go in the URL as
[node-postgres](https://node-postgres.com/features/connecting) and
[mysql2](https://sidorares.github.io/node-mysql2/docs) read them.

With Docker Compose, next to a PostgreSQL container:

```yaml
services:
  viauna:
    image: ghcr.io/bryanthomaschen/viauna:0.4
    environment:
      DATABASE_URL: postgres://viauna:${DB_PASSWORD}@postgres:5432/viauna
      # …the rest as in Getting started
    volumes:
      - viauna-data:/data
  postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: viauna
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: viauna
    volumes:
      - postgres-data:/var/lib/postgresql/data

volumes:
  viauna-data:
  postgres-data:
```

## Moving from SQLite to a server database

Point `DATABASE_URL` at an empty database and restart. On first start Viauna copies
everything from `state.db` into it, so everyone stays signed in. It only ever copies into
a database with no accounts, so a later restart never copies twice. `state.db` is unused
from then on: keep it as a backup until you're satisfied, then delete it.

Moving the other way, or from one server database to another, isn't automatic yet.

## What stays in the data directory

Even with a server database, the mail index, the message cache and attachments being
written stay in `DATA_DIR`, along with `secret.key` unless you set `SECRET_KEY`. Give each
Viauna its own data directory. Running several Viauna instances against one database
isn't supported yet: each keeps its mail server connections, sign-in limits, undo and
contacts-sync status in memory.

## Backups

Back up the state (`state.db`, or your server database the way you back up any other)
and `secret.key`. The index doesn't need backing up. See
[Upgrades and backups](./upgrading.md).
