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

Install Docker from your distribution or Docker's signed package repository first. Then resolve one immutable commit from the official repository, download the installer from that commit, and verify its published checksum before running it:

```bash
set -Eeuo pipefail
repo='csbsgyl/ztnet-custom'
installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT
commit="$(git ls-remote "https://github.com/${repo}.git" refs/heads/main | awk 'NR == 1 { print $1 }')"
printf '%s\n' "$commit" | grep -Eq '^[0-9a-f]{40}$'
curl -fsSL "https://raw.githubusercontent.com/${repo}/${commit}/deploy/one-click-install.sh" -o "$installer"
printf '%s  %s\n' '1369ff03a14ec446ae6bc3487f31fb0d1229287537dcf9afa0f7e33a5bcc079e' "$installer" | sha256sum -c -
sudo bash "$installer"
```

If `raw.githubusercontent.com` is unavailable but the official GitHub API is reachable, keep the same resolved commit and checksum and use the API as the download source:

```bash
set -Eeuo pipefail
repo='csbsgyl/ztnet-custom'
installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT
commit="$(git ls-remote "https://github.com/${repo}.git" refs/heads/main | awk 'NR == 1 { print $1 }')"
printf '%s\n' "$commit" | grep -Eq '^[0-9a-f]{40}$'
curl --retry 2 --retry-all-errors -fsSL \
  -H 'Accept: application/vnd.github.raw+json' \
  "https://api.github.com/repos/${repo}/contents/deploy/one-click-install.sh?ref=${commit}" \
  -o "$installer"
printf '%s  %s\n' '1369ff03a14ec446ae6bc3487f31fb0d1229287537dcf9afa0f7e33a5bcc079e' "$installer" | sha256sum -c -
sudo bash "$installer"
```

Do not pipe a third-party proxy response into `sudo bash`. TLS to a proxy authenticates the proxy, not the GitHub content it returns. A CI-time comparison cannot protect a later or selectively modified user download.

The installer does not run Docker's remote convenience installer by default. `INSTALL_DOCKER=auto` is an explicit opt-in to trust `get.docker.com`; signed OS packages are preferred.

To deploy the unmodified upstream application image, pass the override only after downloading and verifying this installer:

```bash
sudo env ZTNET_IMAGE=sinamics/ztnet:latest bash "$installer"
```

## Automatic updates

Automatic application updates are enabled by default. The updater checks only the configured ZTNET application image every hour. PostgreSQL, ZeroTier, the updater, and the privileged restart helper are not automatically upgraded. One-click deployments include the updater only while `AUTO_UPDATE=true`; static Compose deployments gate it behind the `auto-update` profile.

Administrators can view the current build, latest successful image build, updater connection, and polling interval under **Admin > System Update**. The page can also request an immediate scoped update check.

Existing installations can rerun a freshly downloaded and verified installer. Database credentials, auth secrets, public URL, bind address, bootstrap email, configured application image, update settings, and API tokens are preserved. Installations created before `PUBLIC_BIND` was introduced keep their legacy `0.0.0.0` listener with a migration warning so they are not silently disconnected; explicitly set `PUBLIC_BIND=127.0.0.1` after arranging the SSH/reverse-proxy bootstrap. An old helper reference matching `<registry>/csbsgyl/ztnet-custom:ops-latest` is migrated to the verified digest on the same registry and then source-verified. Other mutable helper tags remain rejected.

```bash
sudo bash /path/to/verified-one-click-install.sh
```

For deployments maintained directly from `deploy/docker-compose.yml`, add the new required token and enable the updater profile in the existing `.env` before running `docker compose up -d`. Also set `PUBLIC_BIND` explicitly: use `127.0.0.1` after arranging an SSH tunnel or same-host reverse proxy, or temporarily keep `0.0.0.0` only when preserving the old public listener is required. Omitting it uses the new loopback default and can disconnect an existing remotely accessed deployment.

```bash
printf 'RESTART_API_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
printf 'COMPOSE_PROFILES=auto-update\n' >> .env
printf 'PUBLIC_BIND=0.0.0.0\n' >> .env # Legacy reachability only; migrate to 127.0.0.1.
```

Ensure `RESTART_API_TOKEN` differs from `UPDATE_API_TOKEN`. Also use the digest-pinned `RESTART_HELPER_IMAGE`, `RESTART_HELPER_SOURCE_SHA256`, and `UPDATER_IMAGE` values from `deploy/.env.example`. Compose intentionally fails closed when either required token is absent rather than starting with a predictable credential.

The installer requires every helper and updater reference to use `@sha256`. It copies `/app/container-ops.mjs` out without starting the helper container and compares it with the expected source SHA-256. The helper has no Watchtower update label. Updating it is an explicit release operation that must update both verified helper digests.

Docker Compose itself cannot enforce an `@sha256` format or compare a file inside an image. In the static Compose path, `RESTART_HELPER_SOURCE_SHA256` is review metadata and is not consumed by Compose. Leave the pinned helper and updater defaults unchanged unless you independently verify the replacement references. Use the one-click installer whenever automated digest and helper-source validation is required.

After that one-time command, future application releases are detected and installed in the background or can be requested from the admin page. View updater activity with:

```bash
cd /opt/ztnet-custom
docker compose logs -f updater
```

Change the polling interval to ten minutes:

```bash
sudo env AUTO_UPDATE_INTERVAL=600 bash /path/to/verified-one-click-install.sh
```

Disable background updates and remove the updater container from a one-click deployment:

```bash
sudo env AUTO_UPDATE=false bash /path/to/verified-one-click-install.sh
```

For a static Compose deployment, set both values in `.env`, then reconcile the project so the profiled updater becomes an orphan and is removed:

```dotenv
AUTO_UPDATE=false
COMPOSE_PROFILES=
```

```bash
docker compose up -d --remove-orphans
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

Third-party registry acceleration is disabled by default. The installer pulls the configured official source references directly and has no built-in ZTNET or restart-helper proxy list. `DOCKER_MIRROR_URL` is inactive until mirror mode is explicitly enabled.

Mirrors expand the image supply chain. Configure only registries you operate or explicitly trust. A successful pull proves availability, not authenticity.

Mirror modes:

- `never`: use only configured source images. This is the default.
- `auto`: try the official source first, then explicitly configured mirrors after a pull failure.
- `always`: try explicitly configured mirrors first, then the official source.

Enable an explicit application mirror as a fallback, using a verified local installer:

```bash
sudo env \
  DOCKER_MIRROR_MODE=auto \
  ZTNET_MIRROR_IMAGES='registry.example.com/ztnet-custom:latest' \
  bash /path/to/verified-one-click-install.sh
```

For a helper mirror, both the official and mirror references must be immutable digest references. The copied helper source must also match `RESTART_HELPER_SOURCE_SHA256`:

```bash
sudo env \
  DOCKER_MIRROR_MODE=auto \
  RESTART_HELPER_MIRROR_IMAGES='registry.example.com/ztnet-custom@sha256:<64-hex-digest>' \
  RESTART_HELPER_SOURCE_SHA256='<64-hex-source-sha256>' \
  bash /path/to/verified-one-click-install.sh
```

`UPDATER_IMAGE` and `UPDATER_MIRROR_IMAGE` must also use immutable `@sha256` references. The installer rejects tag-only updater overrides before pulling or starting them.

The legacy `ZTNET_MIRROR_IMAGE` option remains an explicit single-mirror alias and is prepended to `ZTNET_MIRROR_IMAGES`. `DOCKER_MIRROR_MODE=never` ignores every mirror setting.

## Secure first start

The web port binds to `127.0.0.1` by default. Create the first administrator through an SSH tunnel before exposing the service:

```bash
ssh -L 3000:127.0.0.1:3000 user@your-server
```

Open `http://127.0.0.1:3000` locally through that tunnel and register the intended administrator. For an OAuth-only fresh installation, set `INITIAL_ADMIN_EMAIL` before the first start. Better Auth and OAuth user creation will refuse to assign the first administrator role to any other normalized email.

For a reverse proxy on the same host, keep `PUBLIC_BIND=127.0.0.1` and set `NEXTAUTH_URL` to the external HTTPS URL. Set `RATE_LIMIT_TRUST_PROXY=true` only when every request reaches ZTNET through a trusted proxy that removes and rewrites `X-Forwarded-For`. Otherwise clients could spoof the address used for rate limiting.

A non-loopback bind is an explicit opt-in and requires an HTTPS `NEXTAUTH_URL`. It still exposes the backend HTTP port, so restrict that port to the trusted proxy with the host firewall and complete administrator bootstrap first.

## Common options

```bash
sudo env \
  APP_NAME=ztnet-custom \
  INSTALL_DIR=/opt/ztnet-custom \
  HTTP_PORT=3000 \
  PUBLIC_BIND=127.0.0.1 \
  NEXTAUTH_URL=https://ztnet.example.com \
  INITIAL_ADMIN_EMAIL=owner@example.com \
  ZTNET_IMAGE=ghcr.io/csbsgyl/ztnet-custom:latest \
  bash /path/to/verified-one-click-install.sh
```

Supported environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `APP_NAME` | `ztnet-custom` | Compose project/container prefix. |
| `INSTALL_DIR` | `/opt/${APP_NAME}` | Directory for generated `.env` and `docker-compose.yml`. |
| `HTTP_PORT` | `3000` | Host port used on `PUBLIC_BIND`. |
| `PUBLIC_BIND` | `127.0.0.1` | Host address for the web port. Non-loopback values must be explicitly supplied with an HTTPS `NEXTAUTH_URL`. |
| `NEXTAUTH_URL` | `http://127.0.0.1:<port>` | Canonical URL used by authentication callbacks. Use the external HTTPS URL behind a reverse proxy. |
| `INITIAL_ADMIN_EMAIL` | empty | On a fresh OAuth-only deployment, restrict first-admin creation to this normalized email. |
| `RATE_LIMIT_TRUST_PROXY` | `false` | Trust proxy-supplied client IP headers only when a trusted proxy overwrites them for every request. |
| `ZTNET_IMAGE` | `ghcr.io/csbsgyl/ztnet-custom:latest` | App image. Override this to deploy another build. |
| `ZEROTIER_IMAGE` | `zyclonite/zerotier:1.14.2` | ZeroTier service image. |
| `POSTGRES_IMAGE` | `postgres:15.2-alpine` | PostgreSQL image. |
| `POSTGRES_PASSWORD` | random | Database password. |
| `NEXTAUTH_SECRET` | random | Auth encryption/signing secret. |
| `APP_SUBNET` | `172.31.255.0/29` | Internal Docker bridge subnet. |
| `INSTALL_DOCKER` | `0` | Do not install Docker remotely. Set `auto` only to explicitly trust Docker's convenience installer. |
| `DOCKER_MIRROR_MODE` | `never` | Registry strategy: `never`, `auto` (source first), or `always` (mirror first). |
| `DOCKER_MIRROR_URL` | `https://docker.xiaohangyun.org` | Inactive unless mirror mode is explicitly enabled; applies only to eligible Docker Hub images. |
| `DOCKER_PULL_TIMEOUT` | `0` | Maximum seconds for each `docker pull`; `0` allows slow image downloads to finish. |
| `REGISTRY_PROBE_TIMEOUT` | `8` | Maximum seconds for each registry health probe. |
| `STARTUP_TIMEOUT` | `180` | Maximum seconds the installer waits for the application HTTP server to become ready. |
| `ZTNET_MIRROR_IMAGES` | empty | Explicit comma-separated ZTNET mirror candidates. |
| `ZTNET_MIRROR_IMAGE` | empty | Legacy single candidate prepended to `ZTNET_MIRROR_IMAGES`. |
| `ZEROTIER_MIRROR_IMAGE` | empty | Explicit ZeroTier mirror image. |
| `POSTGRES_MIRROR_IMAGE` | empty | Explicit PostgreSQL mirror image. |
| `AUTO_UPDATE` | `true` | Enable the scoped background updater for ZTNET only. |
| `COMPOSE_PROFILES` | `auto-update` in `.env.example` | Static Compose only: create the updater service. Clear it together with `AUTO_UPDATE=false` to remove the updater. |
| `AUTO_UPDATE_INTERVAL` | `3600` | Seconds between image digest checks; minimum `60`. |
| `AUTO_UPDATE_CLEANUP` | `false` | Remove replaced images after a successful update. |
| `UPDATE_API_URL` | `http://updater:8080` | Private Compose-network URL used by the admin update page. |
| `UPDATE_API_TOKEN` | random | Private token shared by ZTNET and Watchtower; generated once and preserved. |
| `RESTART_API_URL` | `http://restart-helper:8081` | Internal-only URL for the fixed ZeroTier restart operation. |
| `RESTART_API_TOKEN` | random | Separate Bearer token shared by ZTNET and the restart helper; at least 32 characters, different from `UPDATE_API_TOKEN`, generated once and preserved. |
| `RESTART_HELPER_IMAGE` | official `@sha256:207f...33bd` | Immutable minimal restart-helper image. Tag-only references are rejected. |
| `RESTART_HELPER_SOURCE_SHA256` | `1038d5e1...28fa0` | Expected SHA-256 of `/app/container-ops.mjs`, verified before deployment. |
| `RESTART_HELPER_MIRROR_IMAGES` | empty | Explicit digest-pinned helper mirrors; each must pass the same source verification. |
| `BACKUP_DIR` | `/app/backups` | Persistent in-container path for server-side backup archives. |
| `UPDATER_IMAGE` | `nickfedor/watchtower@sha256:c1df...3bdf` | Digest-pinned background updater image. Installer overrides must also use `@sha256`. |
| `UPDATER_MIRROR_IMAGE` | empty | Explicit updater mirror; the installer requires an `@sha256` reference. |

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

Installer versions before `2026-07-14` stopped a `docker pull` after 300 seconds even when layers were still downloading. The current installer has no total pull deadline by default. Rerun the verified local installer and Docker will reuse already downloaded layers:

```bash
sudo bash /path/to/verified-one-click-install.sh
```

Set `DOCKER_PULL_TIMEOUT` only when a hard total deadline is explicitly required. It is not a network-idle timeout.

Candidate fallback begins after the current `docker pull` exits. If a broken network path can remain open forever, use a finite per-candidate deadline such as `DOCKER_PULL_TIMEOUT=600`; completed layers remain in Docker's content store for later attempts.

## Notes

- `NEXTAUTH_URL` should be the preferred public URL used for OAuth callbacks and generated links. Credential sign-in also accepts the exact same-origin domain forwarded by a reverse proxy through `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto`.
- Keep `RATE_LIMIT_TRUST_PROXY=false` unless a trusted proxy overwrites forwarded client IP headers for every request.
- Linux hosts must have `/dev/net/tun` available for ZeroTier.
- Keep the initial service on loopback until the intended administrator exists. OAuth-only deployments should set `INITIAL_ADMIN_EMAIL` before first start.
- Keep `.env` private. It is created with mode `600` and contains database, authentication, update, and restart secrets. PostgreSQL receives only its three database variables rather than the full file.
- Third-party download and registry proxies are outside the project trust boundary. They are never enabled automatically and must not be piped into a root shell.
- Automatic updates require mounting `/var/run/docker.sock` into the updater, which grants Docker daemon control. The digest-pinned updater is scoped and label-restricted to the ZTNET application.
- Static Compose creates the updater only when the `auto-update` profile is active. Clear `COMPOSE_PROFILES` and set `AUTO_UPDATE=false` together when disabling it.
- The restart helper also mounts the Docker socket, but exposes only one fixed, label-scoped ZeroTier restart operation over an internal network. Its port `8081` is not published on the host.
- The restart helper is digest-pinned, source-verified, and intentionally excluded from Watchtower. Update its image and source digests together after reviewing a release.
- Static Compose does not execute the installer's image validators; its helper source checksum is operator review metadata. Keep its pinned privileged-image defaults unless replacements are independently verified.
- The ZTNET web container does not receive the Docker socket. Manual update and restart requests use separate token-protected endpoints and tokens; neither operations port is published on the host.
- Automatic updates require a mutable image tag such as `latest`; digest-pinned images intentionally do not move to newer releases.
- Keep database backups. Application releases may include database migrations even though the PostgreSQL container itself is not updated.
- One-click deployments bind-mount `/opt/ztnet-custom/backups` into the app. Keep an additional downloaded copy off the server.
- If you prefer manual deployment, copy `deploy/docker-compose.yml` and create a `.env` file from the variable list above.
