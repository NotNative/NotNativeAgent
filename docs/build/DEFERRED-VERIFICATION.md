# Deferred verification checklist

Speed policy (operator instruction 2026-10-10): slices land built + adversarially
reviewed, with cheap checks run whenever they can run. Since the sandbox change on
2026-10-10, vitest and spawned CLI gates DO run in-session — the policy is now:
run the full UI suite + gates after each batch of UI slices; defer only installed
binaries and browser-driving runs.

## Suites and gates

- [x] Full UI vitest suite — `20261010-2`: 1957/1957 across 268 files, in-session
- [x] `tsc --noEmit` UI project — every slice; web projects green at `20261009-13`
      (untouched since)
- [x] `node scripts/quality-gates.js` — passed for 858 files at `20261010-2`
- [x] `node scripts/settings-coverage-gate.mjs <NNA root>` — passed at `20261010-2`
      against live NNA `2709a6c4` (20261009-5)
- [ ] Electron suites that spawn: `native-service-client.test.mjs`,
      `ssh-managed-bundle.test.mjs` (try next in-session; were spawn-blocked)
- [ ] Scripts suites that spawn: `installer-*`, `serve-supervised`,
      `resolve-active-nnd-package`, `export-prebuilt-payload`, `release-content`,
      `installed-*` (try next; same retry note)
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
