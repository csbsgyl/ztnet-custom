---
id: debian_11
title: Standalone Debian & Ubuntu
slug: /installation/linux
description: Standalone Linux support status for this ZTNET fork
sidebar_position: 2
---

## Support status

The historical standalone installer is not a supported installation or update
path for this fork. It was designed for the upstream project, fetched mutable
content over an unauthenticated endpoint, and executed that response as root.
Those properties do not meet this fork's deployment security baseline.

Use the [secure Docker Compose installation](/installation/docker-compose)
instead. It points to the repository's verified one-click procedure, which
resolves an immutable commit, verifies the installer SHA-256, and keeps the web
interface on loopback while the first administrator is created.

The files under `install.ztnet/` remain in the source tree only as upstream
history. Do not run them on a production host. Operators who need a native
systemd deployment must review and maintain their own pinned packages, service
unit, database, reverse proxy, and upgrade process.
