---
id: reverse-proxy
title: Reverse Proxy
slug: /installation/reverse-proxy
description: Configure authentication and live WebSocket updates behind a reverse proxy.
sidebar_position: 5
---

# Reverse Proxy

:::info Applies from v0.8.0
Live updates over WebSocket were introduced in **v0.8.0**. On earlier versions this page doesn't apply.
:::

ZTNET validates the browser origin during authentication and pushes live updates (member status, network changes) over a **WebSocket** (Socket.IO, served on `/socket.io/`). A reverse proxy must preserve the public host and protocol as well as forward the WebSocket upgrade.

## Authentication origin

ZTNET automatically accepts the exact public origin represented by `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto`. The proxy must overwrite these headers rather than append untrusted client values. Otherwise sign-in can fail with `Invalid origin`.

Keep `NEXTAUTH_URL` set to the preferred public URL because OAuth callbacks and links generated outside an HTTP request still use it.

## Verify

Open DevTools → Network → **WS**, then reload a network page. You should see a `/socket.io/?...` connection switch to **101 Switching Protocols**. If it stays on polling or errors with `wss://… can't connect`, the proxy isn't forwarding the upgrade.

## Configuration

Replace `127.0.0.1:3000` with wherever ZTNET listens.

### nginx

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### Apache

Enable the modules, then add the rewrite to your vhost:

```bash
a2enmod proxy proxy_http proxy_wstunnel rewrite headers
```

```apache
ProxyPreserveHost On
RequestHeader set X-Forwarded-Proto "https"

# Tunnel the WebSocket upgrade to the ws:// backend
RewriteEngine On
RewriteCond %{HTTP:Upgrade} =websocket [NC]
RewriteRule ^/?(.*) "ws://127.0.0.1:3000/$1" [P,L]

# Everything else over normal HTTP
ProxyPass        /  http://127.0.0.1:3000/
ProxyPassReverse /  http://127.0.0.1:3000/
```

### Caddy & Traefik

Both forward the host, protocol, and WebSockets automatically — no extra configuration is normally needed.

```
your.domain {
    reverse_proxy 127.0.0.1:3000
}
```
