# Secondary development notes

This repository is a secondary-development fork of [sinamics/ztnet](https://github.com/sinamics/ztnet).

## Upstream and license

- Upstream project: `sinamics/ztnet`
- Upstream license: GPL-3.0
- Keep `LICENSE` and upstream attribution in the repository.
- If this fork is distributed, published as a Docker image, or provided to customers, review GPL-3.0 obligations before release.

## Recommended GitHub setup

1. Create a GitHub repository for the fork.
2. Push this worktree to that repository.
3. Keep `origin` pointing to your fork.
4. Add an `upstream` remote for the original project:

```bash
git remote add upstream https://github.com/sinamics/ztnet.git
```

5. Use feature branches for custom changes:

```bash
git checkout -b feature/your-change
```

On Windows, after you know the target GitHub repository, you can prepare placeholders and the `origin` remote with:

```powershell
.\scripts\prepare-github-fork.ps1 -Repository "your-org/your-repo"
```

For an SSH remote:

```powershell
.\scripts\prepare-github-fork.ps1 -Repository "your-org/your-repo" -RemoteUrl "git@github.com:your-org/your-repo.git"
```

## Container image

This fork includes a GHCR workflow at `.github/workflows/ghcr-image.yml`.

When pushed to GitHub, it builds and publishes:

```text
ghcr.io/<your-org>/<your-repo>:latest
ghcr.io/<your-org>/<your-repo>:sha-<short-sha>
```

For public one-click deployments, make the GitHub package public or users will need GHCR authentication.

## One-click deploy command

After the fork is published and the GHCR image exists, document this command in your public README:

```bash
curl -fsSL https://raw.githubusercontent.com/<your-org>/<your-repo>/main/deploy/one-click-install.sh | sudo env ZTNET_IMAGE=ghcr.io/<your-org>/<your-repo>:latest bash
```

For custom domains:

```bash
curl -fsSL https://raw.githubusercontent.com/<your-org>/<your-repo>/main/deploy/one-click-install.sh | sudo env \
  NEXTAUTH_URL=https://ztnet.example.com \
  ZTNET_IMAGE=ghcr.io/<your-org>/<your-repo>:latest \
  bash
```

## Release checklist

- Replace all `<your-org>/<your-repo>` placeholders in docs.
- Decide the fork name and public branding.
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
