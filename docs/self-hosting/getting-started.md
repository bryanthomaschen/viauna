# Getting started

Viauna is one container: a Node server and the web app, with its data in one directory.
It needs nothing besides your mail server: no database server, no Redis.

## What you need

- A mail server with **IMAP** (port 993, or 143 with STARTTLS) and **authenticated SMTP
  submission** (465, or 587 with STARTTLS), both accepting the same login. See
  [Mail servers](./mail-servers.md).
- **Docker**, or Node.js 22.13 or newer.
- A **hostname of its own**, such as `webmail.example.com`, and a reverse proxy that
  terminates TLS. Viauna can't be served under a sub-path yet.

## Build the image

There's no published image yet, so build it from the repository:

```bash
git clone https://github.com/bryanthomaschen/viauna.git
cd viauna
docker build -t viauna .
```

## Run it

```bash
docker run -d --name viauna --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v viauna-data:/data \
  -e PUBLIC_URL=https://webmail.example.com \
  -e TRUST_PROXY=true \
  -e IMAP_HOST=imap.example.com \
  -e SMTP_HOST=smtp.example.com \
  viauna
```

Or with Docker Compose:

```yaml
services:
  viauna:
    image: viauna
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"   # only your reverse proxy should reach it
    environment:
      PUBLIC_URL: https://webmail.example.com
      TRUST_PROXY: "true"
      IMAP_HOST: imap.example.com
      SMTP_HOST: smtp.example.com
      ALLOWED_DOMAINS: example.com
    volumes:
      - viauna-data:/data

volumes:
  viauna-data:
```

Keep the port bound to `127.0.0.1`, or on a Docker network shared with your proxy.
Viauna serves plain HTTP and relies on the proxy for TLS.

## Put it behind your reverse proxy

Point the proxy at port 3000, with response buffering off (for live updates) and HTTP/2
on. [Reverse proxy](./reverse-proxy.md) has examples for nginx, Caddy and Traefik.

## Sign in

Open your Viauna address and sign in with your full mailbox address and its password,
the same login your phone's mail app uses. Viauna has no accounts of its own: anyone your
mail server accepts can sign in, unless you limit it with `ALLOWED_DOMAINS`.

## Next

- [Configuration](./configuration.md): every setting.
- [Upgrades and backups](./upgrading.md): what's in `/data` and what to keep.
- [Troubleshooting](./troubleshooting.md), if signing in fails.

## Without Docker

```bash
npm ci
npm run build
PUBLIC_URL=https://webmail.example.com \
IMAP_HOST=imap.example.com SMTP_HOST=smtp.example.com \
DATA_DIR=/var/lib/viauna npm start
```

Outside Docker, Viauna listens on `127.0.0.1:3000` by default. Run it as an unprivileged
user under a service manager such as systemd.
