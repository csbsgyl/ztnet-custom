# One-click deployment

This directory contains the deployment entrypoint for this ZTNET fork.

The installer creates a Docker Compose deployment with:

- PostgreSQL
- ZeroTier
- ZTNET

Supported hosts: Linux `amd64` and `arm64`.

## Quick start

Use the public image built from this fork:

```bash
curl -fsSL https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo bash
```

For a mainland China server, download the same script through the GitHub accelerator:

```bash
curl -fsSL https://github.xiaohangyun.org/https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo bash
```

To try GitHub directly first and safely fall back to the accelerator, run this block as one command:

```bash
(
  set -Eeuo pipefail
  installer="$(mktemp)"
  cleanup() { rm -f "$installer"; }
  trap cleanup EXIT
  direct_url="https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh"
  accelerated_url="https://github.xiaohangyun.org/${direct_url}"
  download() {
    curl -fsSL --connect-timeout 8 --max-time 60 "$1" -o "$installer" &&
      head -n 1 "$installer" | grep -qx '#!/usr/bin/env bash'
  }
  download "$direct_url" || download "$accelerated_url"
  sudo bash "$installer"
)
```

To deploy the unmodified upstream image with this installer instead:

```bash
curl -fsSL https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo env ZTNET_IMAGE=sinamics/ztnet:latest bash
```

## Registry acceleration

The installer automatically probes each source registry and the configured mirror. It retries eligible Docker Hub pulls through `https://docker.xiaohangyun.org` and writes the selected image references into the generated Compose file.

Mirror modes:

- `auto`: prefer a reachable source registry, then retry through the mirror after a probe or pull failure. This is the default.
- `always`: try the mirror first, then fall back to the source registry.
- `never`: disable mirror detection and use only the configured source images.

Force the supplied mirror to be tried first:

```bash
curl -fsSL https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo env DOCKER_MIRROR_MODE=always bash
```

The supplied mirror has been verified for Docker Hub images such as PostgreSQL and ZeroTier. It does not currently expose this fork's GHCR path. The installer therefore keeps direct GHCR as a fallback and supports an exact domestic copy through `ZTNET_MIRROR_IMAGE`:

```bash
curl -fsSL https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo env \
  DOCKER_MIRROR_MODE=always \
  ZTNET_MIRROR_IMAGE=your-registry.example.com/ztnet-custom:latest \
  bash
```

## Common options

```bash
curl -fsSL https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo env \
  APP_NAME=ztnet-custom \
  INSTALL_DIR=/opt/ztnet-custom \
  HTTP_PORT=3000 \
  NEXTAUTH_URL=http://your-server-ip:3000 \
  ZTNET_IMAGE=ghcr.io/csbsgyl/ztnet-custom:latest \
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
| `ZTNET_IMAGE` | `ghcr.io/csbsgyl/ztnet-custom:latest` | App image. Override this to deploy another build. |
| `ZEROTIER_IMAGE` | `zyclonite/zerotier:1.14.2` | ZeroTier service image. |
| `POSTGRES_IMAGE` | `postgres:15.2-alpine` | PostgreSQL image. |
| `POSTGRES_PASSWORD` | random | Database password. |
| `NEXTAUTH_SECRET` | random | Auth encryption/signing secret. |
| `APP_SUBNET` | `172.31.255.0/29` | Internal Docker bridge subnet. |
| `INSTALL_DOCKER` | `auto` | If Docker is missing, install it via `get.docker.com`. Set `0` to disable. |
| `DOCKER_MIRROR_MODE` | `auto` | Registry strategy: `auto`, `always`, or `never`. |
| `DOCKER_MIRROR_URL` | `https://docker.xiaohangyun.org` | Registry mirror used for automatic fallback. |
| `DOCKER_PULL_TIMEOUT` | `300` | Maximum seconds for each `docker pull`; set `0` to disable the timeout. |
| `REGISTRY_PROBE_TIMEOUT` | `8` | Maximum seconds for each registry health probe. |
| `ZTNET_MIRROR_IMAGE` | empty | Exact fallback image for the fork, useful when GHCR is unavailable. |
| `ZEROTIER_MIRROR_IMAGE` | auto-generated | Override the mirror image selected for ZeroTier. |
| `POSTGRES_MIRROR_IMAGE` | auto-generated | Override the mirror image selected for PostgreSQL. |

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
- The mirror is a third-party service. Change `DOCKER_MIRROR_URL` or use `DOCKER_MIRROR_MODE=never` if its trust or availability changes.
- `github.xiaohangyun.org` accelerates GitHub file downloads only. It is not a Docker Registry and does not replace the GHCR image URL.
- The GitHub accelerator is a third-party download proxy. Its response is checked against the committed installer in CI, but operators should still use only accelerators they trust.
- If you prefer manual deployment, copy `deploy/docker-compose.yml` and create a `.env` file from the variable list above.
