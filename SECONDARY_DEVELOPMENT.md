# Secondary development notes

This repository, [csbsgyl/ztnet-custom](https://github.com/csbsgyl/ztnet-custom), is a secondary-development fork of [sinamics/ztnet](https://github.com/sinamics/ztnet).

## Upstream and license

- Upstream project: `sinamics/ztnet`
- Fork repository: `csbsgyl/ztnet-custom`
- Initial upstream base: `v0.8.1` (`8230dcb3`)
- Fork container image: `ghcr.io/csbsgyl/ztnet-custom`
- Upstream license: GPL-3.0
- Keep `LICENSE` and upstream attribution in the repository.
- If this fork is distributed, published as a Docker image, or provided to customers, review GPL-3.0 obligations before release.

## Recommended GitHub setup

Keep `origin` pointing to `csbsgyl/ztnet-custom` and keep an `upstream` remote for the original project:

```bash
git remote add upstream https://github.com/sinamics/ztnet.git
```

Use feature branches for custom changes:

```bash
git checkout -b feature/your-change
```

On Windows, after you know the target GitHub repository, you can prepare placeholders and the `origin` remote with:

```powershell
.\scripts\prepare-github-fork.ps1 -Repository "csbsgyl/ztnet-custom"
```

For an SSH remote:

```powershell
.\scripts\prepare-github-fork.ps1 -Repository "csbsgyl/ztnet-custom" -RemoteUrl "git@github.com:csbsgyl/ztnet-custom.git"
```

## Fork automation

- `.github/workflows/main_build.yml` runs application linting, formatting checks, tests, and a production build without relying on upstream Docker Hub credentials.
- `.github/workflows/deployment-check.yml` validates the installer syntax and rendered Docker Compose configuration.
- `.github/workflows/ghcr-image.yml` is the only container publishing workflow and targets this repository's GHCR package.
- Upstream workflows tied to the `ztnet.network` and `ztnet.installer` self-hosted runners are intentionally not carried forward.

The one-click installer automatically detects registry connectivity and can fall back to `https://docker.xiaohangyun.org` for Docker Hub images. Because that mirror does not currently proxy the fork's GHCR path, use `ZTNET_MIRROR_IMAGE` when an exact copy is published to a domestic registry.

GitHub source and Raw downloads can use `https://github.xiaohangyun.org/<original-url>`. The deployment guide includes both an accelerator-only command and a direct-first download block that validates the script before execution.

## Container image

This fork includes a GHCR workflow at `.github/workflows/ghcr-image.yml`.

When pushed to GitHub, it builds and publishes:

```text
ghcr.io/csbsgyl/ztnet-custom:latest
ghcr.io/csbsgyl/ztnet-custom:sha-<short-sha>
```

For public one-click deployments, make the GitHub package public or users will need GHCR authentication.

## One-click deploy command

After the fork is published and the GHCR image exists, document this command in your public README:

```bash
curl -fsSL https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo bash
```

For custom domains:

```bash
curl -fsSL https://raw.githubusercontent.com/csbsgyl/ztnet-custom/main/deploy/one-click-install.sh | sudo env \
  NEXTAUTH_URL=https://ztnet.example.com \
  ZTNET_IMAGE=ghcr.io/csbsgyl/ztnet-custom:latest \
  bash
```

## Release checklist

- Keep repository and image references aligned with `csbsgyl/ztnet-custom`.
- Keep fork-specific behavior and deployment changes documented.
- Keep a clear changelog of secondary-development changes.
- Confirm `NEXTAUTH_URL` instructions are correct for HTTP and HTTPS deployments.
- Confirm the GHCR package is public if the one-click command is meant for anonymous users.
- Test `deploy/one-click-install.sh` on a clean Linux host before announcing it.
- Keep upstream remote available so security fixes can be merged.

## Areas to customize carefully

- `src/utils/ztApi.ts`: ZeroTier local controller and ZeroTier Central API integration.
- `src/server/api/routers/networkRouter.ts`: network configuration, DNS, routes, members list.
- `src/server/api/routers/memberRouter.ts`: node authorization, naming, stashing, deletion.
- `src/server/api/services/memberService.ts`: member reconciliation and live-status cache.
- `prisma/schema.prisma`: data model changes and migrations.
- `src/lib/auth.ts`: Better Auth, OAuth, MFA, device tracking.
