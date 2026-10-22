# Reverse proxy

Viauna serves plain HTTP on port 3000 and needs a reverse proxy in front to terminate
TLS. Whichever you use, it needs to:

- **Not buffer responses.** Every open tab holds a live-update stream (`/api/events`,
  server-sent events; see [Live updates](../how-it-works/live-updates.md)). A proxy that
  buffers it holds new mail back.
- **Speak HTTP/2 to browsers.** Over HTTP/1.1 a browser allows six connections per site,
  and each tab's stream holds one, so a seventh tab would hang.
- **Accept large uploads**: attachments up to `MAX_UPLOAD_MB` (25 MB by default), plus
  some headroom.
- **Pass the client's address** in `X-Forwarded-For`, with `TRUST_PROXY=true` on Viauna,
  so its sign-in limits apply per real client rather than to your proxy. Viauna reads
  the *last* entry, the one your proxy added.

Give Viauna a hostname of its own (it can't be served under a sub-path yet), and set
`PUBLIC_URL` to exactly that address: requests that change anything are refused from any
other origin.

If you put a login of your own in front of Viauna (HTTP Basic Auth, a single sign-on
proxy), leave `/ical/` out of it: that's where other apps fetch calendars by their
[secret addresses](../how-it-works/calendar.md#secret-addresses), and they can't sign in to
your proxy. The address itself is the key. With `CALENDAR_SECRET_ADDRESSES=false`, nothing
is served there. Leave out `/sw.js`, `/manifest.webmanifest` and the icons
(`/icon-192.png`, `/icon-512.png`, `/apple-touch-icon.png`, `/favicon.svg`) too: browsers
may fetch them without your login's credentials, to run the service worker that shows
reminders and to add Viauna to a home screen. They're the same for everyone.

> [!TIP]
> If a CDN or another proxy sits in front of yours, have your proxy restore the client's
> address first (nginx's `realip` module, for example), so the last `X-Forwarded-For`
> entry is the real client and not the CDN.

## nginx

```nginx
server {
    listen 443 ssl;
    http2 on;                          # nginx 1.25.1+; older: listen 443 ssl http2;
    server_name webmail.example.com;

    ssl_certificate     /etc/letsencrypt/live/webmail.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/webmail.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;           # live updates (/api/events)
        proxy_read_timeout 1h;
        client_max_body_size 30m;      # attachments
    }
}
```

## Caddy

```text
webmail.example.com {
    request_body {
        max_size 30MB
    }
    reverse_proxy 127.0.0.1:3000
}
```

Caddy gets the certificate, serves HTTP/2, sets `X-Forwarded-For` and passes server-sent
events through unbuffered, with no further settings.

## Traefik

As labels on the Viauna service, assuming an entrypoint called `websecure` and a
certificate resolver called `letsencrypt` (use your own names):

```yaml
services:
  viauna:
    # …as in Getting started, without the ports: section
    labels:
      - traefik.enable=true
      - traefik.http.routers.viauna.rule=Host(`webmail.example.com`)
      - traefik.http.routers.viauna.entrypoints=websecure
      - traefik.http.routers.viauna.tls.certresolver=letsencrypt
      - traefik.http.services.viauna.loadbalancer.server.port=3000
```

Traefik doesn't buffer responses unless you add its buffering middleware, and serves
HTTP/2 over TLS by default. If large uploads fail on slow connections, check the
entrypoint's `respondingTimeouts.readTimeout`.
