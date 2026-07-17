# One-click deployment

This directory contains the deployment entrypoint for this ZTNET fork.

The installer creates a Docker Compose deployment with:

- PostgreSQL
- ZeroTier
- ZTNET
- A scoped background updater for ZTNET
- A private, restart-only operations helper for ZeroTier

Supported hosts: Linux `amd64` and `arm64`.

## Quick start

Use the public image built from this fork:

```bash
curl -fsSL https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo bash
```

For a mainland China server, try the official GitHub API first. This endpoint is often reachable even when `raw.githubusercontent.com` is not:

```bash
curl --retry 2 --retry-all-errors -fL \
  -H 'Accept: application/vnd.github.raw+json' \
  'https://api.github.com/repos/csbsgyl/ztnet-custom/contents/deploy/one-click-install.sh?ref=main' | sudo bash
```

To automatically try multiple download paths, run this block as one command:

```bash
(
  set -Eeuo pipefail
  installer="$(mktemp)"
  cleanup() { rm -f "$installer"; }
  trap cleanup EXIT
  direct_url="https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh"
  urls=(
    'https://api.github.com/repos/csbsgyl/ztnet-custom/contents/deploy/one-click-install.sh?ref=main'
    "$direct_url"
    "https://ghproxy.net/${direct_url}"
    "https://ghfast.top/${direct_url}"
    "https://gh-proxy.com/${direct_url}"
    "https://github.xiaohangyun.org/${direct_url}"
  )
  for url in "${urls[@]}"; do
    printf '[INFO] Trying %s\n' "$url"
    if curl --retry 1 --retry-all-errors -fL \
      -H 'Accept: application/vnd.github.raw+json' \
      --connect-timeout 8 --max-time 45 \
      "$url" -o "$installer" &&
      head -n 1 "$installer" | grep -qx '#!/usr/bin/env bash'; then
      sudo bash "$installer"
      exit
    fi
  done
  printf '[ERROR] All installer download sources failed.\n' >&2
  exit 1
)
```

To deploy the unmodified upstream image with this installer instead:

```bash
curl -fsSL https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo env ZTNET_IMAGE=sinamics/ztnet:latest bash
```

## Automatic updates

Automatic ZTNET updates are enabled by default. The updater checks the configured application and restart-helper image digests every hour and recreates either labeled service when its image changes. PostgreSQL, ZeroTier, and the updater itself are not automatically upgraded.

Administrators can view the current build, latest successful image build, updater connection, and polling interval under **Admin > System Update**. The page can also request an immediate scoped update check.

Existing installations need to run the installer once to add the private updater API and restart helper. Existing database credentials, auth secrets, public URL, update settings, update API token, and restart API token are preserved on later runs:

```bash
curl --retry 2 --retry-all-errors -fL \
  -H 'Accept: application/vnd.github.raw+json' \
  'https://api.github.com/repos/csbsgyl/ztnet-custom/contents/deploy/one-click-install.sh?ref=main' | sudo bash
```

For deployments maintained directly from `deploy/docker-compose.yml`, add the new required token to the existing `.env` before running `docker compose up -d`:

```bash
printf 'RESTART_API_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
```

Also add `RESTART_HELPER_IMAGE=ghcr.io/csbsgyl/ztnet-custom:ops-latest` when migrating an existing hand-maintained deployment. Compose intentionally fails closed when the restart token is absent rather than starting with a predictable credential.

The installer inspects the selected helper image without starting it and refuses to continue unless `/app/container-ops.mjs` is present. Immediately after a new source release, wait for the matching container build if every registry mirror still serves the previous image.

After that one-time command, future application releases are detected and installed in the background or can be requested from the admin page. View updater activity with:

```bash
cd /opt/ztnet-custom
docker compose logs -f updater
```

Change the polling interval to ten minutes:

```bash
curl --retry 2 --retry-all-errors -fL \
  -H 'Accept: application/vnd.github.raw+json' \
  'https://api.github.com/repos/csbsgyl/ztnet-custom/contents/deploy/one-click-install.sh?ref=main' | sudo env AUTO_UPDATE_INTERVAL=600 bash
```

Disable background updates and remove the updater container:

```bash
curl --retry 2 --retry-all-errors -fL \
  -H 'Accept: application/vnd.github.raw+json' \
  'https://api.github.com/repos/csbsgyl/ztnet-custom/contents/deploy/one-click-install.sh?ref=main' | sudo env AUTO_UPDATE=false bash
```

Old application images are retained by default for manual rollback. Set `AUTO_UPDATE_CLEANUP=true` only when automatic removal of replaced images is preferred.

## Private ZeroTier restart helper

The deployment includes a restart-only helper so the ZTNET web container never receives the Docker socket. It is published as a separate minimal Node Alpine image rather than reusing the full application image. The helper:

- listens only on an internal Compose network and publishes no host port;
- requires the independently generated `RESTART_API_TOKEN` as a Bearer token;
- accepts only `GET /v1/health` and bodyless `POST /v1/restart-zerotier` requests;
- resolves exactly one container carrying the deployment instance, `zerotier` role, and explicit restart-enabled labels;
- never accepts a container name, command, image, or other Docker operation from a request;
- rejects concurrent restart requests, applies short Docker API timeouts, and verifies the target remains running after restart.

The helper mounts `/var/run/docker.sock`, which still grants that helper Docker daemon control. Its container uses a read-only root filesystem, drops Linux capabilities, and enables `no-new-privileges`. Keep the helper private and protect its token.

## Registry acceleration

The installer uses separate acceleration paths for the application image and Docker Hub images.

For the default application image, it tries these GHCR-compatible references in order before direct GHCR:

1. `ghcr.nju.edu.cn/csbsgyl/ztnet-custom:latest`
2. `ghcr.dockerproxy.net/csbsgyl/ztnet-custom:latest`
3. `ghcr.1ms.run/csbsgyl/ztnet-custom:latest`
4. `ghcr.chenby.cn/csbsgyl/ztnet-custom:latest`
5. `ghcr.io/csbsgyl/ztnet-custom:latest`

The four proxy references were verified against the official OCI index digest and an actual image layer on `2026-07-14`. The installer still treats the real `docker pull` result as authoritative and automatically continues to the next candidate after a failure. The selected reference is written into the generated Compose file, so the background updater checks the same reachable image source.

Docker Hub images such as PostgreSQL, ZeroTier, and Watchtower retain automatic fallback through `https://docker.xiaohangyun.org`. This mirror is not used as a GHCR endpoint.

Mirror modes:

- `auto`: try the built-in ZTNET proxy list first; for Docker Hub images, use the configured mirror after a source probe or pull failure. This is the default.
- `always`: try the mirror first, then fall back to the source registry.
- `never`: disable mirror detection and use only the configured source images.

Force the supplied mirror to be tried first:

```bash
curl -fsSL https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo env DOCKER_MIRROR_MODE=always bash
```

Override the complete ZTNET candidate list with a comma-separated value:

```bash
curl -fsSL https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo env \
  ZTNET_MIRROR_IMAGES='registry-a.example.com/ztnet-custom:latest,registry-b.example.com/ztnet-custom:latest' \
  bash
```

The legacy `ZTNET_MIRROR_IMAGE` option is still accepted and prepended to the candidate list. Setting `DOCKER_MIRROR_MODE=never` disables all proxy candidates. Overriding `ZTNET_IMAGE` also disables the built-in fork-specific list unless `ZTNET_MIRROR_IMAGES` is supplied explicitly.

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
| `ZTNET_MIRROR_IMAGES` | Four verified GHCR proxies | Comma-separated ZTNET image candidates, tried before the source image. |
| `ZTNET_MIRROR_IMAGE` | empty | Legacy single candidate prepended to `ZTNET_MIRROR_IMAGES`. |
| `ZEROTIER_MIRROR_IMAGE` | auto-generated | Override the mirror image selected for ZeroTier. |
| `POSTGRES_MIRROR_IMAGE` | auto-generated | Override the mirror image selected for PostgreSQL. |
| `AUTO_UPDATE` | `true` | Enable the scoped background updater for ZTNET only. |
| `AUTO_UPDATE_INTERVAL` | `3600` | Seconds between image digest checks; minimum `60`. |
| `AUTO_UPDATE_CLEANUP` | `false` | Remove replaced images after a successful update. |
| `UPDATE_API_URL` | `http://updater:8080` | Private Compose-network URL used by the admin update page. |
| `UPDATE_API_TOKEN` | random | Private token shared by ZTNET and Watchtower; generated once and preserved. |
| `RESTART_API_URL` | `http://restart-helper:8081` | Internal-only URL for the fixed ZeroTier restart operation. |
| `RESTART_API_TOKEN` | random | Separate Bearer token shared by ZTNET and the restart helper; at least 32 characters, generated once and preserved. |
| `RESTART_HELPER_IMAGE` | `ghcr.io/csbsgyl/ztnet-custom:ops-latest` | Minimal image containing only the fixed restart helper and its Node runtime. |
| `RESTART_HELPER_MIRROR_IMAGES` | fork mirror list | Comma-separated fallback images used only for the restart helper. |
| `BACKUP_DIR` | `/app/backups` | Persistent in-container path for server-side backup archives. |
| `UPDATER_IMAGE` | `nickfedor/watchtower:1.19.0` | Background updater image. |
| `UPDATER_MIRROR_IMAGE` | auto-generated | Override the Docker mirror image selected for the updater. |

## Operational commands

```bash
cd /opt/ztnet-custom
docker compose ps
docker compose logs -f ztnet
docker compose logs -f updater
docker compose logs -f restart-helper
docker compose pull
docker compose up -d
```

## Troubleshooting slow pulls

Installer versions before `2026-07-14` stopped a `docker pull` after 300 seconds even when layers were still downloading. The current installer has no total pull deadline by default. Rerun it and Docker will reuse already downloaded layers:

```bash
curl -fsSL https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo bash
```

Set `DOCKER_PULL_TIMEOUT` only when a hard total deadline is explicitly required. It is not a network-idle timeout.

Candidate fallback begins after the current `docker pull` exits. If a broken network path can remain open forever, use a finite per-candidate deadline such as `DOCKER_PULL_TIMEOUT=600`; completed layers remain in Docker's content store for later attempts.

## Notes

- `NEXTAUTH_URL` should be the preferred public URL used for OAuth callbacks and generated links. Credential sign-in also accepts the exact same-origin domain forwarded by a reverse proxy through `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto`.
- Linux hosts must have `/dev/net/tun` available for ZeroTier.
- The first registered user becomes the administrator.
- Keep `.env` private. It contains the database password and auth secret.
- All acceleration endpoints are third-party services. Override `ZTNET_MIRROR_IMAGES`, change `DOCKER_MIRROR_URL`, or use `DOCKER_MIRROR_MODE=never` if their trust or availability changes.
- `github.xiaohangyun.org` accelerates GitHub file downloads only. It is not a Docker Registry and does not replace the GHCR image URL.
- The GitHub accelerator is a third-party download proxy. Its response is checked against the committed installer in CI, but operators should still use only accelerators they trust.
- If the GitHub accelerator reports a self-signed certificate, use the direct `raw.githubusercontent.com` command or wait for the accelerator certificate to recover. Do not bypass TLS verification unless the downloaded script is checked against a trusted SHA-256 value.
- Automatic updates require mounting `/var/run/docker.sock` into the updater, which grants Docker daemon control. The updater is scoped and label-restricted to the ZTNET application and restart helper containers.
- The restart helper also mounts the Docker socket, but exposes only one fixed, label-scoped ZeroTier restart operation over an internal network. Its port `8081` is not published on the host.
- The ZTNET web container does not receive the Docker socket. Manual update and restart requests use separate token-protected endpoints and tokens; neither operations port is published on the host.
- Automatic updates require a mutable image tag such as `latest`; digest-pinned images intentionally do not move to newer releases.
- Keep database backups. Application releases may include database migrations even though the PostgreSQL container itself is not updated.
- One-click deployments bind-mount `/opt/ztnet-custom/backups` into the app. Keep an additional downloaded copy off the server.
- If you prefer manual deployment, copy `deploy/docker-compose.yml` and create a `.env` file from the variable list above.
