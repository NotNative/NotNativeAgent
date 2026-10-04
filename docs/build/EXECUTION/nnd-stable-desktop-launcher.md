# Stable desktop launch entry

Status: source-installer shortcut integration and read-only immutable-slot launch
prerequisite. This does not activate a staged slot.

The Windows source installer now points Desktop and Start Menu shortcuts at
`scripts/launch-selected-desktop.ps1` in its stable installation root. That script
reads the external pinned NNA selection and runs the Node launcher using the
selected installed NNA runtime. No Electron executable path is stored in the
shortcut. Every launch queries the selected NNA's `nnd package status`; the
resolver checks the pinned installation/data identities before and after the
query and verifies either the current source install or a sealed immutable slot.
The launched Electron receives the same external selection file as an argument.
Before every attachment, including reconnect, it rereads that selection and
checks the native registration against its own package root and boot-pinned
version. An old shell therefore refuses to attach to a newly selected package.
The resolver and shell both refuse missing, invalid, or changed selection
evidence. Hidden shortcut preflight failures display a local error dialog.

Before spawning Electron, the launcher only invokes a read-only controller
health proof; it never starts NND. The proof samples the selected NNA's public
attach response and generation. It refuses `nnd_service_not_running` and passes
`--nnd-controller-generation`; Electron compares that value with its own fresh
attach, but may then call NNA's guarded `service start` on a cold selected
installation. Resolver/package integrity and launcher health remain separate
fail-closed gates.

This is not an atomic upgrade contract, and the sampled controller generation is
not cryptographically bound to the package payload. The intervals between the
launcher's health proof, spawn, and Electron's attach remain bounded but real;
an immutable package payload binding and uninterrupted handoff stays future work.
The production prebuilt installer must place and preserve this stable anchor,
then create its shortcut only after activation and installed health verification.
The current prebuilt staging branch does neither.

Focused verification: `node --test scripts/resolve-active-nnd-package.test.mjs
packages/electron/native-service-client.test.mjs
scripts/installer-selection-pin.test.mjs` exercises source/slot resolution,
changed registration and identities, shell argument handling, and fail-closed
tamper cases without starting the native service or installer.
