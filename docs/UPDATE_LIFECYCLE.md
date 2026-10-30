# NNA platform update lifecycle

Version `20261017-2` verifies NNA and its registered Windows desktop component as one update result.
The updater resolves `main` to a GitHub commit, reads that commit's `VERSION`, and downloads that
exact commit's archive. It never installs an older repository version over a newer installed build.
The check command reports that distinction explicitly.

## Installation and service ownership

An installed CLI selects its own adjacent `install.json`, including custom installation roots.
The descriptor must name that same installation. Source/development invocations retain the normal
per-user installation lookup. The installer receives the selected install and data roots explicitly.

For a registered desktop, the downloaded desktop version and package stamp must match NNA before
installation starts. The main Windows installer observes the existing desktop service before
replacing NNA's runtime files. It stops a running service through its native controller and waits
for discovery removal and release of the selected service lock. An apparently stopped service also
requires lock release; a starting or unknown owner cannot authorize file replacement.

After installing NNA, the main installer invokes `desktop/install.cmd` at the registered desktop
root. That installer copies, builds and activates the desktop package. Only after successful desktop
installation does the main installer restart a service that it previously observed running. Startup
waits for the expected package to report `ready` or `setup_required`; missing provider configuration
does not itself invalidate the settings service. A stopped service remains stopped. These actions
do not enable or disable Windows sign-in wiring.

Before reporting update success, the updater independently verifies:

- the installed CLI version and descriptor version;
- unchanged install/data roots and an existing installation incarnation;
- a valid desktop registration and matching desktop version at the original desktop root;
- preserved running/stopped, enabled/disabled and sign-in wiring state;
- a different usable service generation when the service was running.

The normal installer retains the separate Telegram and OpenCode lifecycle owners. The installed
acceptance below requires Telegram to be stopped and disabled and verifies that both services retain
their original states. It never starts Telegram for verification.

OpenCode uses its public `service.autostart_enabled` field to refresh enabled sign-in wiring.
Its runtime restart decision is independent of that setting: a manually running runtime restarts
even when sign-in is disabled, and a stopped runtime stays stopped. Unknown state or a failed
login refresh fails installation instead of reporting preserved state. Behavior tests cover all
four sign-in/running combinations; installed acceptance keeps the operator's OpenCode stopped
and disabled.

The OpenChamber binding is never stored in the user profile. `nna opencode start` passes
`OPENCODE_HOST`, `OPENCODE_SKIP_START`, and the generated credential in the environment of the
OpenChamber process it launches, and `enable` installs only the login script that runs
`opencode start` again. Because the binding lives exactly as long as that child process, a
reboot, logoff, or forced kill cannot leave OpenChamber pointed at a server that no longer
exists; it also cannot suppress OpenChamber's own fallback launch. An upgraded installation
whose profile still carries a binding written by an earlier build clears it on the next
`opencode stop`, and the ownership comparison keeps a binding that another product has changed.

## Failure and recovery

An installer failure or failed final verification is not success. The updater retains the selected
source and a copy of the previous NNA payload. Its error identifies the source installer to use for
repair and the previous payload location. It does **not** copy only the old NNA files over a newer
descriptor or desktop registration. Such a partial rollback can make both components unusable and
cannot undo data migrations.

Repair with the retained source installer and the same install/data roots. A failed installation may
leave the service stopped; resolve the reported failure before starting it. Previous payload copies
are recovery evidence, not a complete platform or user-data backup. Three retained recovery copies
block another installation until the operator reviews them, bounding repeated failure storage.

An existing `update.lock` can mean a running or interrupted update. Check installer processes and logs
before clearing it; the absence of the original updater process does not prove its installer child
has stopped. The updater does not infer ownership from a PID or remove that lock automatically.

## Repeatable installed acceptance

Run from this checkout on Windows with a real registered desktop and a fresh, ignored evidence
directory. This intentionally installs a previous-version acceptance baseline in the selected real
installation, then upgrades it twice. It interrupts that installation's background service.

```powershell
node scripts/installed-update-smoke.mjs ABSOLUTE_NNA_INSTALL_ROOT ABSOLUTE_FRESH_EVIDENCE_DIRECTORY
```

The baseline contains the candidate updater and installer code, stamped at the immediately preceding
version. This exercises the new updater, rather than relying on a previously shipped updater to
contain new verification logic. No mock installation root or installer is used.

The acceptance first fetches GitHub's actual immutable commit/archive, checks its embedded `VERSION`
and desktop installer, and records the result. For the unpublished candidate, a loopback HTTP feed
substitutes only the three acquisition responses through a test-only Node preload. The installed
CLI, version comparison, archive streaming, real `tar` validation/extraction, main installer, desktop
build/registration and final verification all run normally. No test feed option is added to the
production updater. The feed checks the exact commit-pinned request sequence.

The two cases start with the desktop service running and stopped. Both must update NNA and desktop
to the candidate version, preserve the installation identity, selected roots, sign-in state,
launch preferences, credential files and trust bytes, and preserve Telegram/OpenCode state. The
running case must also prove shutdown preceded NNA file replacement. The original service state is
restored afterward, and a real GitHub check replaces the temporary feed's update cache. Evidence
includes per-case installer/update logs and `result.json`.

## Verification record

The `20261017-2` installed matrix passed both cases in the normal registered locations. The final
source installer also passed with an initially stopped desktop service. The original running state
and enabled sign-in wiring were restored; Telegram remained stopped and disabled. The rebuilt
installed Electron UI passed preference publication/restoration, and browser General displayed
desktop/web `20261017.0.2` and installed NNA `20261017-2`.

GitHub `main` advertised `20261014-12` at commit
`903c1f0bd82489e7451911f80c66baf11270eb8f`. Its actual archive was fetched and inspected. Installing
the new candidate directly from GitHub still requires publishing the candidate commit; the local
candidate acceptance must not be described as a published-release installation.

Failure tests use actual tar archives and stateful installer outcomes. They cover invalid downloads,
wrong descriptors, stale desktop versions, changed service/login/root state, unchanged generations,
unknown ownership, startup transitions, refused shutdown, concurrent update locks, bounded recovery
retention and a custom CLI selecting its own installation. Failed installation preserves the reached
state and repair evidence; it never claims that an unverified rollback succeeded.

The full core run passed 2,553 tests with eight skips. The final focused installer/update run
passed 98 tests, including execution of the actual PowerShell lifecycle sections against service
status fixtures built from the public OpenCode status contract.
