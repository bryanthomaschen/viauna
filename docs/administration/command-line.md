# The command line

> [!NOTE]
> The `viauna` command needs Viauna 0.3 or newer.

The `viauna` command changes the same settings as the [admin page](./admin-page.md), from
the server's console, so it works before anyone is an admin and when nobody can sign in.
The image includes it. Run it inside the container, where it uses the same settings and
database as the server:

```bash
docker exec viauna viauna settings                    # every setting, its value, and where that comes from
docker exec viauna viauna settings set SESSION_DAYS 14
docker exec viauna viauna settings set ALLOWED_DOMAINS "example.com, example.org"
docker exec viauna viauna settings reset SESSION_DAYS # back to the default
docker exec viauna viauna admin list
docker exec viauna viauna admin add you@example.com
docker exec viauna viauna admin remove you@example.com
docker exec viauna viauna changes                     # recent changes, newest first
docker exec viauna viauna version
```

Settings are named by their environment variable. Lists are comma-separated, and `""` is
an empty list. A change made here is recorded as made by "command line". The command
tells the running server through a socket in the data directory (`viauna.sock`), so the
change applies at once; if it can't, the server still picks it up within a minute.

Without Docker, run `node dist/server/cli.js` from the Viauna directory, with the same
environment as the server.

If an upgrade is waiting (the first start after moving from 0.1, or after setting
`DATABASE_URL` on a server that had been using SQLite), the command asks you to start
Viauna once first, so it never works on data the server is about to move.
