# Fresh source install (dumb copy)

Status: bounded source-build installation path. The installer is a dumb copy:
it resolves the install plan from the NND registration registry, copies and
builds the package, registers it with NNA, and creates NNA-branded shortcuts.
It never starts the service and runs no post-install verification ceremony -
service start and health verification are separate operator actions
(`nna desktop start`). This path does not claim signed distribution, login
startup, or installed-product acceptance.

The Windows installer selects and validates an installed NNA, then resolves the
install plan from the NND registration registry. A fresh target requires an
absent registration and an empty target directory; a registered target is an
upgrade: the running service is stopped best-effort, then the existing
registration is deactivated before the copy. The install path runs guard-free;
a native installation guard is required only on the Windows uninstall path.
The installer copies and builds NND, validates its service package, registers
it with NNA, pins the selected native identity, and creates shortcuts - Windows
`NotNativeAgent.lnk` with the icon from the NNA installation
(`resources/icons/notnative-agent.ico`), described as "NotNativeAgent desktop".
A Windows upgrade removes the stale pre-rename `NotNativeDesktop.lnk`. The
POSIX installer mirrors the shape (`notnativeagent.desktop` named
NotNativeAgent, `notnative-agent-32.png` icon) and stops a running service
best-effort before touching files on upgrade and uninstall.

The installer does not start the service. After registering and activating the
package with NNA it reports the installed version and the selected NNA paths
and exits. The operator starts the service with `nna desktop start`
(idempotent): the supervised service child launches the attached desktop app
after readiness, so the tray appears with the service regardless of which
entry point started it. A fresh unconfigured NNA reaches `setup-required` when
the operator starts the service; the installer reports installed-pending-setup
without probing a running service.

The structural pins for both installers (dumb-copy order, no install-path
guard, no verification ceremony, launcher `desktop start`, child GUI launch,
tray Quit service stop, shortcut branding) live in
`scripts/installer-structure.test.mjs`. The former post-install verification
helpers (`scripts/installer-fresh-service.mjs`) were retired with the
dumb-copy reshape.

If copying, registration or activation is uncertain, the installer reports an
incomplete installation and preserves both products' evidence. A second source
install refuses an existing fresh target; the operator uses the upgrade path
(stops the running service best-effort, deactivates the prior registration,
then copies). It never merge-copies past a refused fresh target or silently
converts a staged prebuilt slot into an active package.
