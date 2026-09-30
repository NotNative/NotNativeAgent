# Managed SSH bundle

The Electron workspace can produce a platform-neutral gzip-compressed USTAR
payload from the verified server bundle, its settings registry, the web
distribution, and a small remote launcher. This avoids depending on a public
package for the private web/server workspace. `ssh-managed-bundle.mjs`
preflights regular-file metadata before reading, rejects symlinks and unsafe
paths, and bounds both the resulting tar size and its entry count.

The uploader streams this payload over SSH stdin into a fresh private remote
directory using a fixed `tar` command. It rejects invalid SSH configuration
and bounds the archive, transfer duration, and diagnostics. This does not
install remote runtime dependencies or start/supervise the server; readiness
handoff for managed mode remains follow-up work. No remote host is contacted
by the builder or uploader.
