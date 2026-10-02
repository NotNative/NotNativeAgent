# Native slot activation: next executable installer slice

Status: planned. Immutable payload staging does not implement this sequence.
Read the paired NNA ADR 0023 and the [payload contract](nnd-prebuilt-payload.md).

## Native implementation

1. Split `nnd-service-supervisor.js` into ordinary public startup and an internal
   owned lifecycle. Ordinary startup still acquires its lease and validates native
   registration. The internal lifecycle starts unpublished components, observes
   health, publishes discovery, and drains components without releasing the
   caller's genuine lease. Preserve shutdown uncertainty and existing child-exit
   checks. Never add caller-controlled `ignorePending` or `skipAdmission` flags.
2. Add bounded activation storage, transaction and recovery modules in NNA. Mint an
   opaque transaction capability only after validating a live lease, slot provenance,
   receipt and selected installation/data identity. Its exception covers only that
   transaction's pending barrier and candidate. Browser input cannot mint it.
3. Keep lock order data-root lease, then registration SQLite mutex. Under both,
   capture exact prior registration bytes/revision, desired pointer bytes/hash,
   candidate payload/provenance hashes, unchanged supported schema evidence,
   operation identity and trial generation. Publish prepared evidence and the
   admission barrier before starting components. Retain owned child PID and start
   identity durably; secrets stay in existing private discovery storage.
4. Launch the staged GUI with the selected native executable and private bootstrap
   channel. Keep discovery unpublished and deny external attach/tickets or user
   mutations during trial. Check exact identity, generation/version, actual loopback
   GUI response, locked browser state, native health, child liveness and lifecycle
   failure. Bound cancellation while retaining ownership until shutdown settles.
5. Resolve native runtime startup explicitly. Transport readiness alone is insufficient.
   Accept `ready` or `setup_required`; reject degraded, failed or unresolved starting
   state. Provider availability remains independent. Starting integrations can create
   writers, so trial shutdown must include their confirmed settlement.
6. Recheck provenance and prior pointer revision. CAS the sole package registration
   through `transactLockedManifest`, record its durable outcome, then CAS-publish
   discovery. Recheck health/liveness, record completion and remove only the owned
   barrier. Keep public attach gated until completion. Transfer the still-held lease
   to the same-process supervisor; never close it and spawn a replacement owner.

## Rollback and recovery

Restore the exact previous registration only after all trial writers are confirmed
stopped and current registration equals this transaction's exact desired bytes.
Restore absence only when absence was recorded. Initial activation must prohibit
package-driven data migration and require unchanged supported schemas. Pointer
rollback does not restore runtime data. The first failed-activation contract may
leave the previous package registered but stopped; automatic restart is separate.

Implement rollback through a native held-registration-mutex operation that compares
the exact current revision and durably records restoration of raw prior bytes or
absence. `transactLockedManifest` serializes JSON with a trailing newline, so a JSON
transform cannot satisfy exact-byte restoration or represent deletion. Do not use
an unrecorded overwrite/unlink: recovery must reconcile the rollback operation's
before/after revisions as well as the original activation CAS.

On process death, lease availability does not prove the GUI or integration
descendants stopped. Recover by recorded process start identity and durable phase
evidence. Never kill a reused PID. Registration with third-party bytes, uncertain
shutdown, unknown publication or uncertain schema effects preserves the barrier.
The live process retains its lease when writers cannot be confirmed stopped.

Required real-death tests cover prepared-before-trial, trial-running parent death,
healthy-before-CAS, pointer-replaced-before-phase-receipt, CAS-before-discovery,
discovery-before-completion, completion-before-barrier-clear, and failed shutdown.
The missing phase receipt must be reconciled from exact bytes and the manifest
operation receipt, rather than interpreted as an unpublished write.

## Installer and launchers

After native activation/recovery passes audit and full tests, add the stable native
desktop launch command. It reads registration under its mutex, validates the
selected package/slot and launches that Electron entry with the exact NNA selection.
Shortcuts and login startup must target this command; the current installer pins
an Electron path and would continue selecting an old slot after upgrades.

Then change the production installer to discover/select NNA, verify capabilities,
offer an explicit verified NNA dependency installation when none is available,
stage a prebuilt artifact and invoke native activation/recovery. Reprobe the
installed dependency rather than trusting the download or installer exit code.
It must build no dependencies during that transaction. Keep source development
installation explicit. NNA remains separately usable and independently owned.
Only authenticated installed health permits the final completion screen.

Acceptance must show browser/desktop access, service survival after installer and
shell exit, exact selected slot, browser credential isolation, setup-required setup,
failed activation recovery, and independent NNA TUI identity. Follow each logical
slice with an adversarial audit, required tests, version/report updates and a commit.
Signing, NSIS distribution, upgrade pruning, uninstall and login startup retain
their own release gates; this guide does not mark those gates complete.
