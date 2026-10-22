# Quick start

Viauna needs nothing besides your mail server: no database server, no Redis, nothing to
build. All it needs to know is where your mail is. Pick one:

- [**Try it on your computer**](#try-it-on-your-computer): one command, about two
  minutes.
- [**Run it on a server**](#run-it-on-a-server): one file and two commands, about ten
  minutes once your hostname points at the server.

Either way you need [Docker](https://docs.docker.com/get-docker/), and a mailbox you can
reach with IMAP and SMTP: on your own mail server, or at a provider that allows other mail
apps. Some providers want an app password for that, made in their account settings,
instead of your usual one.

## Try it on your computer

Put your mail server's IMAP and SMTP hostnames in place of the examples (the ones your
phone's mail app uses), and run:

```bash
docker run -d --name viauna \
  -p 127.0.0.1:3000:3000 -v viauna-data:/data \
  -e PUBLIC_URL=http://localhost:3000 \
  -e IMAP_HOST=imap.example.com \
  -e SMTP_HOST=smtp.example.com \
  ghcr.io/bryanthomaschen/viauna:0.5
```

Open `http://localhost:3000` and sign in with your full address and its password. Your
most recent mail comes first, and the rest follows in the background.

It serves plain HTTP, so it's for your own computer only: `127.0.0.1` keeps anyone else
from reaching it. Viauna connects to IMAP on port 993 and SMTP on 465, both encrypted
from the start; if your server wants 143 or 587 with STARTTLS instead, see
[Configuration](./self-hosting/configuration.md#mail-server).

To remove it, with what it kept:

```bash
docker rm -f viauna && docker volume rm viauna-data
```

Your mail stays on your mail server: the volume holds only Viauna's index of it and your
settings in Viauna.

## Run it on a server

You need:

- a server with Docker, and ports 80 and 443 free;
- a hostname for Viauna, such as `webmail.example.com`, whose DNS already points at the
  server.

Save this as `compose.yml`, with your hostname in both places it says
`webmail.example.com`, and your mail server's hostnames:

```yaml
services:
  viauna:
    image: ghcr.io/bryanthomaschen/viauna:0.5
    restart: unless-stopped
    environment:
      PUBLIC_URL: https://webmail.example.com
      TRUST_PROXY: "true"
      IMAP_HOST: imap.example.com
      SMTP_HOST: smtp.example.com
    volumes:
      - viauna-data:/data

  # Gets and renews the certificate, and serves Viauna over HTTPS.
  caddy:
    image: caddy:2
    restart: unless-stopped
    command: caddy reverse-proxy --from webmail.example.com --to viauna:3000
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - caddy-data:/data

volumes:
  viauna-data:
  caddy-data:
```

Then, in the same directory, start it and make your own mailbox an admin:

```bash
docker compose up -d
docker compose exec viauna viauna admin add you@example.com
```

Open `https://webmail.example.com` and sign in. The first visit can take a few seconds
while Caddy gets the certificate.

Anyone with a mailbox on your mail server can now sign in; nobody can type in a server of
their own. As an admin you'll find **Admin settings** in the account menu (your avatar,
top right), to limit sign-ins to your domains and turn features on or off: see
[The admin page](./administration/admin-page.md).

## Next

- Already running nginx, Traefik or another proxy? [Getting started](./self-hosting/getting-started.md)
  and [Reverse proxy](./self-hosting/reverse-proxy.md) put Viauna behind it instead of
  Caddy.
- [Upgrades and backups](./self-hosting/upgrading.md): what's in the volume, and what to
  keep. The `0.5` tag brings fixes with each `docker compose pull`, never a new
  version's changes.
- [Configuration](./self-hosting/configuration.md): every setting, including the
  calendar's [reminders by email](./self-hosting/configuration.md#viauna-s-own-sender).
- [Using Viauna](./using/basics.md), for the people who'll sign in.
