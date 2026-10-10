# Deferred verification checklist

Speed policy (operator instruction 2026-10-10): slices land built + adversarially
reviewed, with cheap pure checks run in-sandbox (`tsc --noEmit`, `node x.test.mjs`
where the file is pure, `repository-graph --check`, controlled-language gates).
Everything that spawns, installs, or drives a browser is deferred to this
consolidated pass and is never claimed as verified in LEDGER/PROGRESS until run.

Statuses in LEDGER stay `implemented-unverified` until the matching line below passes.

## Suites and gates (console, disposable fixtures fine)

- [ ] `pnpm install && pnpm test` (all UI suites; `native-configuration-controls.test.tsx`
      must pass with the new `Parallel tool limit` row) — covers every C4/C5 UI change since `20261009-12`
- [ ] `pnpm typecheck` (all packages)
- [ ] `node scripts/quality-gates.js` (spawn-based)
- [ ] Electron suites that spawn: `native-service-client.test.mjs`, `ssh-managed-bundle.test.mjs`
- [ ] Scripts suites that spawn: `installer-*`, `serve-supervised`, `resolve-active-nnd-package`,
      `export-prebuilt-payload`, `release-content`, `installed-*`
- [ ] `node scripts/settings-coverage-gate.mjs <NNA absolute root>` (spawns the NNA CLI census)
- [ ] `node scripts/release-gates.js`

## Installed acceptance (disposable profiles only, pinned pair)

- [ ] `node scripts/installed-source-acceptance.mjs <NNA root> --native-attachments`
      must observe the desktop phases `native_host_link_refused`,
      `native_pairing_link_refused`, `native_deep_link_ingress_verified`
      (closes alpha A5 ingress proof)
- [ ] `--native-setup-turn` full journey (A2–A4 regression on the new pair)
- [ ] `--native-removal` (A6 uninstall leg)
- [ ] `node scripts/installed-prebuilt-smoke.mjs <NNA root>` (prebuilt first install)
- [ ] A5 remaining shell side-effect audit sign-off
- [ ] V1–V6 release gates (guide 05)

## C4 rows awaiting application evidence

- [ ] `manifest:tool_concurrency` — census status flip after the suite line above passes
- [ ] C4 census rows' per-field application evidence (success, rejected, reset,
      conflict, persistence, application) — owned by the C7/C4 verification pass
