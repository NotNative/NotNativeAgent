# Deferred verification checklist

Speed policy (operator instruction 2026-10-10): slices land built + adversarially
reviewed, with cheap checks run whenever they can run. Since the sandbox change on
2026-10-10, vitest and spawned CLI gates DO run in-session — the policy is now:
run the full UI suite + gates after each batch of UI slices; defer only installed
binaries and browser-driving runs.

## Suites and gates

- [x] Full UI vitest suite — `20261010-2`: 1957/1957 across 268 files, in-session;
      re-run green after every slice through `20261010-17` (1982/1982 across 271 files)
- [x] Full web vitest suite — latest green at `20261010-13`: 1470/1470 across 136
      files; 1471/1471 recorded at `20261010-14` after the knowledge-suite rewrite
      (`node --max-old-space-size=3072 node_modules/vitest/vitest.mjs run` in
      `packages/web`), in-session
- [x] `tsc --noEmit` UI project — every slice; web projects green through
      `20261010-17`
- [x] `node scripts/quality-gates.js` — green through `20261010-17` (870 files)
- [x] `node scripts/settings-coverage-gate.mjs <NNA root>` — green through
      `20261010-16` against live NNA `2709a6c4` (20261009-5), now enforcing
      subcommands and env-read provenance (407 census rows)
- [x] Electron suites that spawn: `native-service-client.test.mjs` 13/13 and
      `ssh-managed-bundle.test.mjs` (3 pass, 2 skipped) — green in-session at
      `20261010-7` via `node --test` in `packages/electron`; `native-service-client`
      re-verified 13/13 at `20261010-17`
- [ ] Scripts suites that spawn — last full in-session run at `20261010-7`
      (`node --test` in `scripts/`): GREEN — `serve-installed` 1/1,
      `nnd-service-contract` 7/7, `installed-service-package` 4/4,
      `release-content` 3/3, `export-prebuilt-payload` 12/12,
      `serve-supervised` 2/2, `supervised-protocol` 4/4,
      `installer-structure` (supersedes the retired `installer-fresh-service`
      suite; its helpers were removed with the installer reshape),
      `resolve-active-nnd-package`
      5/5, `settings-coverage-gate` 12/12, `installed-review-provider` 2/2,
      `installer-native-guard` 2 skipped. RESOLVED at `20261011-8`: the
      daytime "Installer syntax failed" list (`installer-removal`,
      `installer-nna-preflight`, `installer-nna-dependency`,
      `installer-selection-pin`, `installer-prebuilt-stage`,
      `installer-prebuilt-activation`, `installer-prebuilt-anchor`,
      `installer-prebuilt-uninstall`) was environment-class, exactly as
      suspected — two causes: (1) suites were run from `scripts/` instead of
      the repository root, so `resolve('install.ps1')` pointed at a missing
      file and the parse step failed; (2) suites spawning
      `powershell -File install.ps1` without `-ExecutionPolicy Bypass` were
      blocked by the operator machine's AllSigned policy
      (`UnauthorizedAccess`). All `-File` spawn sites now pass Bypass
      (matching the `install.cmd` operator entry), and a full sweep of every
      `scripts/*.test.mjs` from the repository root is green.
- [x] `node scripts/release-gates.js` — GREEN at `20261011-8` (in-session,
      operator daytime): `release-candidate gates passed` in verify mode
      after `--write-hashes` resealed the manifest for the post-reshape tree;
      settings-coverage remains skipped with `NNA_SOURCE_ROOT` unset (the
      seal documents that gap); smoke sessions spawned and completed inside
      the gate run (earlier `ses_de2kqnqr` note predates this pass).
      Remaining gap for full closure: set `NNA_SOURCE_ROOT` to run the
      settings-coverage gate against the pinned NNA pair.

## Installed acceptance (disposable profiles only, pinned pair)

Executed in-session 2026-10-11 (NND 20261011-78 source install against local
NNA `20261011-10`, disposable fixtures only):

- [x] `node scripts/installed-source-acceptance.mjs <NNA root> --native-attachments`
      must observe `native_host_link_refused`, `native_pairing_link_refused`,
      `native_deep_link_ingress_verified` (closes alpha A5 ingress proof) —
      passed; the base journey carries the same ingress probe
- [x] `--native-setup-turn` full journey (A2–A4 regression on the new pair)
- [x] `--native-removal` (A6 uninstall leg)
- [ ] `node scripts/installed-prebuilt-smoke.mjs <NNA root>` (prebuilt first install)
      — STILL OPEN: prebuilt slot activation fails in-session; the retained
      `nnd service activate-slot` child exits 2 (`nna: internal_failure`)
      before publishing its readiness frame. Evidence preserved at
      `C:\Users\Mongrel\p\nnd-accept-c50e32c823`, stage operation
      `e4541374-82e6-4504-b87e-9f3f75bdf012`; do not retry blindly.
- [x] A5 remaining shell side-effect audit sign-off (the deep-link probe
      asserts dialogs, host prefs, boot target, window count and the
      URL-minus-session unchanged on the installed shell)
- [ ] Provider-profile PATCH round trip against a live NNA: binding choice,
      secret reference, explicit clear (`credential: null` clears BOTH channels),
      limit resend on model change (new editor surface, `20261010-2`)
- [ ] Secret roster picker against a live broker (real `GET /api/v1/secrets` shapes)
- [ ] V1–V6 release gates (guide 05)
- [ ] Installed timeline fork observation: fork a session from the NND timeline
      against the installed pinned pair and confirm the child session renders
      the inherited history and continues independently (NNA `20261011-8`
      `POST /session/:id/fork`, implemented-unverified)
- [ ] Installed native revert observation: revert a timeline entry on the
      installed pinned pair, confirm the removed turns disappear and the next
      prompt continues without them, then unrevert and confirm the turns
      return in canonical order (NNA `20261011-10` `POST /session/:id/revert`
      / `/unrevert`, implemented-unverified)
- [ ] Installed multi-run comparison journey (F9): run the same prompt in two
      separate sessions with different model selections against the installed
      pinned pair and confirm each run's per-session route holds
      (`assertConfiguredSelection` path, NND `20261011-30` orchestration,
      implemented-unverified)

## C4 rows awaiting installed application evidence

- [ ] F7 browser-only journey (guide 04:148-150): run the required
      preview/inspection/capture/annotation flow with Electron never
      launched and deliver the attachment to native execution. Source side
      is built (`preview/browser-control-broker.ts` +
      `browser-control-callback.ts`, `chat/browser-annotation-controls.tsx`
      surface) and stays implemented-unverified until this passes; a
      desktop handoff does not close the gate.
- [ ] F10 notification delivery across both doors (browser push + desktop
      click/deep-link routing, dedup/read-state coherence, no private
      content in OS notifications) — `lib/browser-push.ts` and the
      notifications settings page are implemented-unverified pending an
      installed two-door pass.
- [ ] F10 shortcut inventory/recorder against the real window (settings
      shortcuts page + recorder dialog exist; conflicts and recorder
      behavior need an installed pass).
- [ ] Stash routes against a real repo state (empty-state locale caveat:
      the "No local changes to save" detection is English-locale sensitive —
      verify with a non-English git environment or pin `LC_ALL=C` in the
      server spawn at the daytime pass).

- [ ] C4 census rows' per-field application evidence (success, rejected, reset,
      conflict, persistence, application) — owned by the C7/C4 verification pass;
      suite-level evidence landed `20261010-2` (`tool_concurrency` and the four
      provider write rows now record it)
- [ ] L3 six-minute installed probe (guide 02:210–213): requests and SSE
      reconnects after renewal, revocation taking effect, forged
      subject/workspace rejection, NNA restart reacquisition without replay.
      The capability chain is enforced end-to-end in-session as of
      `20261011-12` (NNA listener refuses non-live grants; supervised child
      presents and renews); the probe needs the operator's installed pair
      and a controllable clock run — rerun after the next NNA reinstall.
