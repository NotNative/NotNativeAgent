# Third-party notices

This package has no npm runtime dependencies and vendors no third-party source.

It requires Node.js 24 or newer. The installer uses a compatible operator-supplied
runtime when present, or retrieves an official Node.js 24 LTS binary into the per-user
application directory after SHA-256 verification. Node.js is distributed under the MIT
license and includes its own third-party notices; consult the notices shipped with the
installed runtime. Node.js binaries are not embedded in this source package.

The implementation interoperates with the public Model Context Protocol specification.
No MCP SDK or schema source is vendored.

At the user's request, the installers may ask an existing operating-system package manager
to install ripgrep as an optional search accelerator. NNA does not embed ripgrep and remains
functional without it. ripgrep is dual-licensed under the Unlicense and MIT licenses; the
system package manager owns the installed copy and its notices.

The optional managed WebSearch deployment retrieves the official SearXNG container
version `2026.7.26-b060c780d`, pinned to OCI index digest
`sha256:d0aaeb14880e6e92bde1518fcc7261e995783367d63d95203383607bef9c6516`,
at the user's request. SearXNG is
licensed under AGPL-3.0-or-later. NNA includes only its own Compose and minimal
configuration files; it does not embed the SearXNG image or source code.
