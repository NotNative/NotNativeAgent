# Supported platforms

NNA captures bounded, sanitized forensic events by default in a per-workspace SQLite
database beneath `$NNA_HOME/projects`. This local-only evidence can include prompts,
responses, tool input/output, review decisions, hooks, recovery, and lifecycle outcomes so
an operator can investigate a prior failure without first reproducing it in a debug mode.
Known credential fields and secret-like values are redacted before storage. Retention is
bounded to 30 days or 1 GiB per workspace, whichever limit is reached first.

`/trace` queries this local evidence. `/support` flushes it and creates a stricter redacted
troubleshooting ZIP that can include issues from a prior launch. The ZIP does not contain
the rich SQLite database and is never uploaded automatically. The separate
`$NNA_HOME/logs/runtime.ndjson` operational log remains content-free and bounded.

The date-versioned release candidate requires an official Node.js 24.x runtime and targets:

- Windows 11 and Windows Server 2022 or newer, x86-64; arm64 is provisional.
- macOS 13.5 or newer, x86-64 or arm64.
- GNU/Linux x86-64 or arm64 with kernel 4.18 or newer and glibc 2.28 or newer.

These ranges follow the upstream Node.js 24 binary/runtime floor. Native conformance must
still pass on each claimed release artifact before publication. WSL, musl/Alpine,
32-bit systems, terminal hyperlinks, mouse input, Unix sockets, named pipes, and a shell
tool are not claimed by this candidate. Unsupported or non-TTY terminals degrade to the
headless or one-shot text surfaces rather than attempting an interactive screen.

The package contains JavaScript only, has no install script or native dependency, and
does not require a compiler at installation time.

Per-user installers are provided for Windows PowerShell and POSIX-compatible GNU/Linux
shell environments. Windows installs beneath `%LOCALAPPDATA%\NotNativeAgent`; Linux
installs beneath `${XDG_DATA_HOME:-$HOME/.local/share}/not-native-agent`. Both use
`$HOME/.nna` (or an explicit absolute `NNA_HOME`) for durable application data. Native
install/launch/uninstall conformance runs on Windows and Ubuntu in the platform matrix.
Reinstallation fully replaces the application-owned `installed` payload while preserving
the sibling managed runtime and home-scoped application data.
