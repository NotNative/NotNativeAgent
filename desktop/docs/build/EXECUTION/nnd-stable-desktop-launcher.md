# Stable desktop launch entry

Status: production prebuilt activation now installs a fresh selection/launcher anchor. Upgrades retain the read-only immutable-slot launch prerequisite.


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

Before spawning the GUI, the launcher starts the service through the NNA
lifecycle: it invokes the selected NNA CLI's `desktop start` (an idempotent
`nnd start` that resolves to the live status when the service already runs),
then invokes `scripts/launch-selected-desktop.mjs` to spawn the attached
Electron GUI with `--nnd-controller-generation`; Electron compares that value
with its own fresh attach. The supervised service child launches its own
attached desktop app after readiness, so a redundant launch dedups through
Electron's single-instance lock. Resolver/package integrity and launcher
health remain separate fail-closed gates.

This is not an atomic upgrade contract, and the sampled controller generation is
not cryptographically bound to the package payload. The intervals between the
launcher's service start, spawn, and Electron's attach remain bounded but real;
an immutable package payload binding and uninterrupted handoff stays future work.
The production installer creates the NNA-branded shortcut (`NotNativeAgent.lnk`,
icon `resources/icons/notnative-agent.ico` from the NNA installation) as part of
its dumb-copy install; no installed-health verification precedes or gates it.
Fresh prebuilt activation commits the stable contour after native activation
succeeds. It does not yet upgrade an existing
anchor, nor claim uninterrupted package handoff.

Focused verification: `node --test scripts/resolve-active-nnd-package.test.mjs
packages/electron/native-service-client.test.mjs
scripts/installer-selection-pin.test.mjs` exercises source/slot resolution,
changed registration and identities, shell argument handling, and fail-closed
tamper cases without starting the native service or installer.
