## Historical standalone installer

This directory is retained as upstream source history. Its installer is not a
supported installation or update path for this fork and must not be executed on
a production host.

Use the verified procedure in [`deploy/README.md`](../deploy/README.md). That
workflow downloads the installer from an immutable commit, verifies its
published SHA-256 locally, and only then runs the verified file.

The scripts in this directory have not been adapted to the fork's loopback
bootstrap, digest-pinned operations containers, scoped updater, or current
security checks.
