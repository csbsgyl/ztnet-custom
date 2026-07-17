---
id: docker-compose
title: Docker Compose
slug: /installation/docker-compose
description: Secure Docker Compose installation instructions for ZTNET
sidebar_position: 1
---

## Secure installation for this fork

This fork uses a hardened deployment workflow. The only executable installation
instructions are maintained in the repository's
[one-click deployment guide](https://github.com/csbsgyl/ztnet-custom/blob/main/deploy/README.md#quick-start).
That guide resolves an immutable Git commit, verifies the installer checksum,
and runs the verified local file.

Do not use an installation command copied from an upstream release, a registry
proxy, or an older version of this page.

### Security baseline

The supported deployment:

- binds the web interface to `127.0.0.1` for administrator bootstrap;
- generates database, authentication, update, and restart secrets locally;
- keeps PostgreSQL credentials out of unrelated containers;
- pins the Docker-socket updater and restart helper to immutable digests;
- verifies the restart helper source before starting it;
- disables third-party registry mirrors unless an operator explicitly opts in.

Install Docker from your operating system's signed package repository, then
follow the repository deployment guide from beginning to end. Create the first
administrator through the documented SSH tunnel before making the service
reachable through a trusted HTTPS reverse proxy. OAuth-only deployments must set
`INITIAL_ADMIN_EMAIL` before the first start.

### Existing deployments

Download and verify the current installer again before upgrading. It preserves
existing database credentials and application secrets. Deployments created
before loopback binding was introduced retain their previous listener with a
migration warning so an upgrade does not silently disconnect the service.
Follow the guide's migration section to move them behind loopback or a trusted
reverse proxy.

### Upstream Compose examples

The upstream project historically published a general-purpose Compose example
with a public application port and placeholder credentials. It is useful only as
upstream reference material and is not a supported installation path for this
fork. The hardened repository deployment guide above is the sole executable
installation and update procedure.
