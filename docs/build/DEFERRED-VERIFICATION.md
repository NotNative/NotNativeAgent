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
      `installer-fresh-service` 7 pass / 1 fail, `resolve-active-nnd-package`
      5/5, `settings-coverage-gate` 12/12, `installed-review-provider` 2/2,
      `installer-native-guard` 2 skipped. STILL FAILING in-session (daytime
      list, recorded with observed mode): `installer-removal` 0/3,
      `installer-nna-preflight` 0/1, `installer-nna-dependency` 0/7,
      `installer-selection-pin` 0/1, `installer-prebuilt-stage` 0/7,
      `installer-prebuilt-activation` 0/3, `installer-prebuilt-anchor` 2/2,
      `installer-prebuilt-uninstall` 0/3 — all abort in "Installer syntax
      failed" PowerShell parse steps, an environment-class failure to triage
      by day, not yet evidence about the installer itself.
- [ ] `node scripts/release-gates.js`

## Installed acceptance (disposable profiles only, pinned pair — operator daytime)

- [ ] `node scripts/installed-source-acceptance.mjs <NNA root> --native-attachments`
      must observe `native_host_link_refused`, `native_pairing_link_refused`,
      `native_deep_link_ingress_verified` (closes alpha A5 ingress proof)
- [ ] `--native-setup-turn` full journey (A2–A4 regression on the new pair)
- [ ] `--native-removal` (A6 uninstall leg)
- [ ] `node scripts/installed-prebuilt-smoke.mjs <NNA root>` (prebuilt first install)
- [ ] A5 remaining shell side-effect audit sign-off
- [ ] Provider-profile PATCH round trip against a live NNA: binding choice,
      secret reference, explicit clear (`credential: null` clears BOTH channels),
      limit resend on model change (new editor surface, `20261010-2`)
- [ ] Secret roster picker against a live broker (real `GET /api/v1/secrets` shapes)
- [ ] V1–V6 release gates (guide 05)

## C4 rows awaiting installed application evidence

- [ ] C4 census rows' per-field application evidence (success, rejected, reset,
      conflict, persistence, application) — owned by the C7/C4 verification pass;
      suite-level evidence landed `20261010-2` (`tool_concurrency` and the four
      provider write rows now record it)
