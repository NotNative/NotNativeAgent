# Managed SSH bundle

The Electron workspace can produce a platform-neutral gzip-compressed USTAR
payload from the verified server bundle, its settings registry, the web
distribution, and a small remote launcher. This avoids depending on a public
package for the private web/server workspace. `ssh-managed-bundle.mjs`
preflights regular-file metadata before reading, rejects symlinks and unsafe
paths, and bounds both the resulting tar size and its entry count.

This is the payload-generation foundation only. Upload over SSH, remote
installation, lifecycle management, and readiness probing for managed mode
remain follow-up work. No remote host is contacted by the bundle builder.
