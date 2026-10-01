# Managed SSH bundle

The Electron workspace can produce a platform-neutral gzip-compressed USTAR
payload from the verified server bundle, its settings registry, the web
distribution, and a small remote launcher. This avoids depending on a public
package for the private web/server workspace. `ssh-managed-bundle.mjs`
preflights regular-file metadata before reading, rejects symlinks and unsafe
paths, and bounds both the resulting tar size and its entry count.

The uploader streams this payload over SSH stdin into a fresh private remote
directory using a fixed `tar` command. It rejects invalid SSH configuration
and bounds the archive, transfer duration, and diagnostics. The lifecycle
helper installs `node-pty` with the configured npm/bun method, starts a
loopback-only detached server, and stops it when `keepRunning` is false. The
transport requires the existing tunnel health probe to succeed before
reporting ready. Managed mode needs explicit `uploadBundleOverSsh`, a
Unix-like remote, Node.js 22.18+, and npm or bun. Real remote-host acceptance,
portable tar interoperability need verification. `keepRunning` writes
per-instance PID, port, and bundle ownership metadata, allowing later desktop
processes to reuse a matching remote server and stop stale servers before
replacing them. No remote host is contacted by tests.
