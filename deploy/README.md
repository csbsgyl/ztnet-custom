# One-click deployment

This directory contains the deployment entrypoint for this ZTNET fork.

The installer creates a Docker Compose deployment with:

- PostgreSQL
- ZeroTier
- ZTNET

Supported hosts: Linux `amd64` and `arm64`.

## Quick start

After this fork is published to GitHub and its container image is available, use:

```bash
curl -fsSL https://raw.githubusercontent.com/<your-org>/<your-repo>/main/deploy/one-click-install.sh | sudo env ZTNET_IMAGE=ghcr.io/<your-org>/<your-repo>:latest bash
```

For local validation with the upstream image:

```bash
curl -fsSL https://raw.githubusercontent.com/<your-org>/<your-repo>/main/deploy/one-click-install.sh | sudo bash
```

The default upstream image is `sinamics/ztnet:latest`. Set `ZTNET_IMAGE` to your fork image before announcing this command to users.

## Common options

```bash
curl -fsSL https://raw.githubusercontent.com/<your-org>/<your-repo>/main/deploy/one-click-install.sh | sudo env \
  APP_NAME=ztnet-custom \
  INSTALL_DIR=/opt/ztnet-custom \
  HTTP_PORT=3000 \
  NEXTAUTH_URL=http://your-server-ip:3000 \
  ZTNET_IMAGE=ghcr.io/<your-org>/<your-repo>:latest \
  bash
```

Supported environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `APP_NAME` | `ztnet-custom` | Compose project/container prefix. |
| `INSTALL_DIR` | `/opt/${APP_NAME}` | Directory for generated `.env` and `docker-compose.yml`. |
| `HTTP_PORT` | `3000` | Host port exposed by the app. |
| `NEXTAUTH_URL` | Auto-detected `http://<host>:<port>` | Public URL used by auth callbacks. Set this explicitly behind a domain or reverse proxy. |
| `PUBLIC_HOST` | empty | Hostname/IP used only when auto-generating `NEXTAUTH_URL`. |
| `ZTNET_IMAGE` | `sinamics/ztnet:latest` | App image. Use `ghcr.io/<your-org>/<your-repo>:latest` for the fork. |
| `ZEROTIER_IMAGE` | `zyclonite/zerotier:1.14.2` | ZeroTier service image. |
| `POSTGRES_IMAGE` | `postgres:15.2-alpine` | PostgreSQL image. |
| `POSTGRES_PASSWORD` | random | Database password. |
| `NEXTAUTH_SECRET` | random | Auth encryption/signing secret. |
| `APP_SUBNET` | `172.31.255.0/29` | Internal Docker bridge subnet. |
| `INSTALL_DOCKER` | `auto` | If Docker is missing, install it via `get.docker.com`. Set `0` to disable. |

## Operational commands

```bash
cd /opt/ztnet-custom
docker compose ps
docker compose logs -f ztnet
docker compose pull
docker compose up -d
```

## Notes

- `NEXTAUTH_URL` must match the URL users open in the browser. If the site is behind HTTPS, set it to the HTTPS URL.
- Linux hosts must have `/dev/net/tun` available for ZeroTier.
- The first registered user becomes the administrator.
- Keep `.env` private. It contains the database password and auth secret.
- If you prefer manual deployment, copy `deploy/docker-compose.yml` and create a `.env` file from the variable list above.
