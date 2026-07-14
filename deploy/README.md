# One-click deployment

This directory contains the deployment entrypoint for this ZTNET fork.

The installer creates a Docker Compose deployment with:

- PostgreSQL
- ZeroTier
- ZTNET
- A scoped background updater for ZTNET

Supported hosts: Linux `amd64` and `arm64`.

## Quick start

Use the public image built from this fork:

```bash
curl -fsSL https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo bash
```

For a mainland China server, download the same script through the GitHub accelerator:

```bash
curl --retry 3 --retry-all-errors -fsSL https://github.xiaohangyun.org/https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo bash
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
    curl --retry 2 --retry-all-errors -fsSL --connect-timeout 8 --max-time 60 "$1" -o "$installer" &&
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

## Automatic updates

Automatic ZTNET updates are enabled by default. The updater checks the configured ZTNET image digest every hour and recreates only the ZTNET application container when the digest changes. PostgreSQL, ZeroTier, and the updater itself are not automatically upgraded.

Existing installations need to run the installer once to add the background updater. Existing database credentials, auth secrets, public URL, and update settings are preserved:

```bash
curl --retry 3 --retry-all-errors -fsSL https://github.xiaohangyun.org/https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo bash
```

After that one-time command, future application releases are detected and installed in the background. View updater activity with:

```bash
cd /opt/ztnet-custom
docker compose logs -f updater
```

Change the polling interval to ten minutes:

```bash
curl --retry 3 --retry-all-errors -fsSL https://github.xiaohangyun.org/https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo env AUTO_UPDATE_INTERVAL=600 bash
```

Disable background updates and remove the updater container:

```bash
curl --retry 3 --retry-all-errors -fsSL https://github.xiaohangyun.org/https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo env AUTO_UPDATE=false bash
```

Old application images are retained by default for manual rollback. Set `AUTO_UPDATE_CLEANUP=true` only when automatic removal of replaced images is preferred.

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
| `DOCKER_PULL_TIMEOUT` | `0` | Maximum seconds for each `docker pull`; `0` allows slow image downloads to finish. |
| `REGISTRY_PROBE_TIMEOUT` | `8` | Maximum seconds for each registry health probe. |
| `ZTNET_MIRROR_IMAGE` | empty | Exact fallback image for the fork, useful when GHCR is unavailable. |
| `ZEROTIER_MIRROR_IMAGE` | auto-generated | Override the mirror image selected for ZeroTier. |
| `POSTGRES_MIRROR_IMAGE` | auto-generated | Override the mirror image selected for PostgreSQL. |
| `AUTO_UPDATE` | `true` | Enable the scoped background updater for ZTNET only. |
| `AUTO_UPDATE_INTERVAL` | `3600` | Seconds between image digest checks; minimum `60`. |
| `AUTO_UPDATE_CLEANUP` | `false` | Remove replaced images after a successful update. |
| `UPDATER_IMAGE` | `nickfedor/watchtower:1.19.0` | Background updater image. |
| `UPDATER_MIRROR_IMAGE` | auto-generated | Override the Docker mirror image selected for the updater. |

## Operational commands

```bash
cd /opt/ztnet-custom
docker compose ps
docker compose logs -f ztnet
docker compose logs -f updater
docker compose pull
docker compose up -d
```

## Troubleshooting slow pulls

Installer versions before `2026-07-14` stopped a `docker pull` after 300 seconds even when layers were still downloading. The current installer has no total pull deadline by default. Rerun it and Docker will reuse already downloaded layers:

```bash
curl -fsSL https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo bash
```

Set `DOCKER_PULL_TIMEOUT` only when a hard total deadline is explicitly required. It is not a network-idle timeout.

## Notes

- `NEXTAUTH_URL` must match the URL users open in the browser. If the site is behind HTTPS, set it to the HTTPS URL.
- Linux hosts must have `/dev/net/tun` available for ZeroTier.
- The first registered user becomes the administrator.
- Keep `.env` private. It contains the database password and auth secret.
- The mirror is a third-party service. Change `DOCKER_MIRROR_URL` or use `DOCKER_MIRROR_MODE=never` if its trust or availability changes.
- `github.xiaohangyun.org` accelerates GitHub file downloads only. It is not a Docker Registry and does not replace the GHCR image URL.
- The GitHub accelerator is a third-party download proxy. Its response is checked against the committed installer in CI, but operators should still use only accelerators they trust.
- If the GitHub accelerator reports a self-signed certificate, use the direct `raw.githubusercontent.com` command or wait for the accelerator certificate to recover. Do not bypass TLS verification unless the downloaded script is checked against a trusted SHA-256 value.
- Automatic updates require mounting `/var/run/docker.sock` into the updater, which grants Docker daemon control. The updater is scoped and label-restricted to the ZTNET application container.
- Automatic updates require a mutable image tag such as `latest`; digest-pinned images intentionally do not move to newer releases.
- Keep database backups. Application releases may include database migrations even though the PostgreSQL container itself is not updated.
- If you prefer manual deployment, copy `deploy/docker-compose.yml` and create a `.env` file from the variable list above.
