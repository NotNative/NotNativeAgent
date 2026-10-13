# F7 journey debug journal

Durable state for the F7 browser-only journey (`scripts/installed-browser-only-journey.mjs`).
Append after **every** run — this file must let a fresh session (or fresh model) resume
without re-deriving anything.

## Process rules adopted (P0/P1)

1. **Repro-first ladder**: identify the layer of a mapped error, test it offline
   (`node --test` / `vitest` / direct HTTP) *before* any full journey run.
2. **Evidence gate**: never start a run whose evidence channel isn't proven to deliver
   (`f7Probe` returns `channel`; journey asserts it before judging the chain).
3. **Decisive experiment**: before each run write: *if the fix works, phase Y will show Z.*
4. **Structured state**: journey writes `f7-run-latest.json` (verdict/stage/error/notes) via
   `scripts/f7-run-report.mjs`; `node scripts/f7-run-report.mjs <log>` extracts verdict +
   phases + errors from any run log (encoding-sniffing). `--latest` prints last state.
5. **Stages**: `--stage=setup` (fresh-install setup leg only), `--stage=chain --fixture=last`
   (skip setup, reuse configured fixture, F7 chain only), `--stage=all` (default full path).
   Reused fixtures keep installed code fresh — `install.ps1` still runs.
6. Run logs: `$env:TEMP\f7-runNN.log` + `-child.log`. Fixture drains:
   stop `electron.exe`/`node.exe` with CommandLine like `*nnd-installed-acceptance-fixtures*`
   before `Remove-Item`.

## Current status

- **GREEN (run 68, 2026-10-12)**: `--stage=all` passed on fresh fixture
  `installed-accept-5b5c03778f5347b5` — setup leg `setup_required → receipt
  saved → ready`, chain `page marker [FOUND]` + honest `Raster capture is
  unavailable in a browser-only tab` refusal + fixture port discovered.
  State: `$env:TEMP/f7-run-latest.json` (`verdict PASS`, `stage all`).
  The row is closed in `docs/build/DEFERRED-VERIFICATION.md`.
  Re-confirmed by **run 72** (2026-10-12, fresh `installed-accept-11f462f8f0064cff`,
  `verdict PASS`, 45 notes, 19 tool results, 8m35s) after the quality-gate
  refactor of `main()` — behavior-identical.
- **Root causes found on the way** (all fixed, unit-gated):
  1. `server/app.ts` registered the preview proxy AFTER the harness `/api/*`
     catch-all → preview requests forwarded to NNA → 404
     `integration endpoint not found` (regression test added).
  2. Hidden guest iframe unmounted → tab executor had no frame; guest now
     stays mounted while hidden; `waitFrame` polls; readiness evaluates while
     hidden.
  3. Journey stub read NNA contracts wrong: lifecycle `'completed'` doesn't
     exist (use `'succeeded'`), marker must search raw envelope content
     (receipt projection has no `.text`), capture assert reads the chain
     entry not `toolResults[0]`.
- **Evidence tooling**: node writes `f7-evidence.json` (notes + tool_results +
  issued branch tally) — pwsh console reflow corrupts long JSON, never parse
  shell-redirected run logs for anything but eyeballing.

## Next experiment

None — journey green. Keep the run ledger below for regressions; rerun
`--stage=chain --fixture=last` (fast, ~1 min) to smoke a change, or
`--stage=all` (~9–12 min) for full acceptance.

## Recent run ledger

| run | verdict | key evidence |
|-----|---------|--------------|
| 54 | f7-chain-fail | probe-url alpha-gate exemption added after this one |
| 55/56 | f7-chain-fail / TIMEOUT(900s) | guest never mounted; 56 lost all state (watchdog now added) |
| 57 | f7-chain-fail | `pane:true, guest:false`, channel OK, repair/activation green |
| 58 | process-fail | first staged run died instantly: `prepare()` mkdir(shortcuts) EEXIST on reuse → made idempotent in `installed-source-acceptance.mjs` |
| 59 | channel-fail (misclassified) | staged pipeline works; deeper notes delivered. **Root causes found:** (1) reused manifest points at run 57's provider port → turn never reaches the new stub, probe throws `probe_error` after 300s; (2) my channel assert fired on the mis-shaped `{probe_error}` result, hiding (1). Evidence: `entered=1 dom=98 toolResults=[]`, first note `pane:false visible:false`. Fixed: `retargetManifestProvider()` before chain start + shape asserts (probe_error/stub/channel) |
| 60 | f7-chain-fail | manifest retarget WORKED (model runs). New failure: broker 503 → NNA maps `'No connected desktop browser can perform this action'` — no executor client registered when the instant stub chain dispatched. Notes: `f7-dom-before`+`f7-entered` only (chain < 3s, expected). Fixes: executor `onStatus` indicator + probe waits for `registered`; tab guest now survives hidden panes (render class + readiness-always); desktop semantics unchanged |
| 61 | f7-chain-fail | **Big jump**: `exec=registered`, `guest=true` (iframe mounted hidden), open succeeds. Snapshot now gets *no reply* (bridgeAsk 15s timeout ×4: `'The preview page did not answer the action.'`). Pane still `ASIDE-hidden`, `wait=false` (ready), `addr` set, `guestSrc` = `/api/preview-proxy/<fixture>` ✓. UI suite 2051 green. Added: probe now pre-validates the proxy (`preview proxy check failed` fast-fail) + `guestLoaded` watcher. **Open question: does the proxied page contain/execute the bridge?** |
| 62 | probe-fail (informative) | proxy check did its job: `/api/preview-proxy/<port>/` → **404 `integration endpoint not found` (NNA)**. ROOT CAUSE: `registerHarnessProxy` claimed `/api/*` before `registerPreviewProxyRoutes` in `app.ts` — preview requests were forwarded to NNA. Fixed: preview routes now register after the auth/alpha gates but before the harness catch-all; new regression test `'registers ahead of the harness catch-all'` (5/5 green) |
| 63 | probe-fail (informative) | **proxy fix validated in-page** (check passed: 200 + bridge present). New failure: turn hits `model-step ceiling 1024` — the stub saw **1025 identical generic requests** (`content('f7_open')` never populated → no tool message ever appended → same toolCall looped). Also learned: pwsh `>` reflow corrupts long JSON (mangles spaces/drops chars) — journey now writes `f7-evidence.json` (node-written) and the stub records `roles` (last 8 message roles/ids per request) |
| 64 | probe-fail (diagnosed) | Evidence file worked. Fingerprint: **1019/1025 requests identical**, window frozen at `tool:f7_snap_r3` — after r3 the stub's response never advances conversation state. Broker diag (`data/nnd/diagnostics/browser-control.jsonl`) shows run 64: `open ok → 4×snapshot ok` **all within 1.2s** (bridge fast ✓), then **no inspect dispatch**. Also found: **`tool_lifecycle_status:'completed'` does not exist in NNA** (canonical set: `succeeded,failed,completed_nonzero,cancelled,timed_out,invalid_request,denied,unknown_effect`) → my `okSnap` could never match. Fixes: `okSnap` → `'succeeded'`; stub now records `state.issued` (which id/branch returned per request) in evidence |
| 65 | f7-chain-fail (landmark) | **Full chain completed in 34s**: open→snap→inspect→click→snap2→type→snap3→capture→summary, `issued` tally proves every stage, snapshot text contains page content, **capture honest refusal present** ('Raster capture is unavailable in a browser-only tab…'). Failed only on marker: `page marker [ABSENT]` because NNA projected snap3 as a **receipt** (no `.text`) and the marker check parsed a fixed shape. Fixed: marker searches raw envelope content (holds for both projections); capture assert now reads the chain entry (`find(e => e.capture)`) not `toolResults[0]` |
| 66 | f7-assert-fail | **`page marker [FOUND]` — marker fix confirmed.** Failed at the very next assert: capture read `toolResults[0].capture` (generic push) → empty. Fixed: locate chain entry via `find(e => typeof e.capture === 'string')` |
| 67 | **PASS (chain)** | **Chain stage green**: `page marker [FOUND]`, honest capture refusal, `discovered.includes(port)` — all three asserts passed in one run |
| 68 | **PASS (all)** | **F7 JOURNEY GREEN** — fresh fixture `installed-accept-5b5c03778f5347b5`, `--stage=all`: setup leg (`setup_required → receipt saved → ready`) + chain (`page marker [FOUND]`, honest `Raster capture is unavailable…` refusal, fixture port discovered), 45 probe notes, 19 tool results, 9m23s |
| 69 | prebuilt smoke | First attempt failed `electron build stamp: stale` → rebuilt with `electron-package.mjs --no-nsis` + stamp write/check (current, 20261012-1). Second attempt failed `nnd_payload_invalid: payload-runtime-incomplete` — reproduced offline with `readNndServiceIdentity → installHost → verifyNndPayload` (detail: NNA still required `packages/electron/tray.mjs`, deleted by the de-tray slice). Fixed NNA `nnd-payload-contract-runtime.js` (commented why), NNA install-slots 24/24, NND contract test green. Third attempt: **stage + activate PASSED** (slot `20261012-1-5f4153…`, generation, endpoint 55882, shortcuts repointed) but the smoke's later child step hit `Acceptance child timed out` while the NNA full suite ran concurrently (contention, known pattern). NNA graph refreshed (572 modules; graph+productization 31/31) |
| 70 | **PASS (prebuilt smoke)** | Solo retries exposed the real defect: attempts 4/6 wedged after activation with the installer PowerShell EXITED (`exit code=0`, full 873B output) but `run()`'s `close` never firing — a temporary child-lifecycle trace proved `close PENDING` (the detached retained owner holds the stdio write end). Attempt 7 tripped `electron build stamp: stale` after my own `scripts/` edit (scripts/ is a stamp input → re-stamp after ANY scripts/ change); attempt 8 died from a self-matching pwsh filter that killed the owner (never embed fixture strings/`activate-slot` in a diagnostic command — build patterns from fragments). Fix: `run()` in `installed-source-acceptance.mjs` resolves on `exit` after a 250 ms grace when `close` never arrives; trace removed after diagnosis, file re-trimmed to the 500-line cap. **Final attempt green: `Prebuilt 20261012-1 staged, activated, attached from Chromium and Electron, and removed on disposable NNA.`** |
| 71 | seal | Quality gates green at 916 files (browser surface split into `browser-surface-parts.tsx`; executor/createApp/journey functions re-trimmed under the 60-line cap; `installed-source-acceptance.mjs` at 500), NND repository graph rebuilt, and `release-gates --write-hashes` with `NNA_SOURCE_ROOT` set passed end-to-end (settings coverage 223/223 rows) after resealing the still-uncommitted 20261012-1 ledger entry to current content — no VERSION bump |
| 72 | **PASS (all, re-run)** | Refactor validation: the `--fixture=last` chain attempt failed on a stale unregistered fixture (old `installed-accept-c837d964d94d457e` leftover; run 68's `5b5c…` was cleaned post-pass) with `Fresh NND target already exists without a registration` → drained + removed it, then ran `--stage=all` fresh on `installed-accept-11f462f8f0064cff`: **`verdict PASS`, 45 notes, 19 tool results, 8m35s** — the quality-gate refactor of `main()` (`resolveFixtureRoot`/`installAndVerify`/`reportRun` extraction) is behavior-identical |
| 73 | aborted (pre-flight) | `--stage=chain --fixture=last` failed before any work: `no reusable installed-accept fixture exists yet; run --stage=all first` — run 72's passing `--stage=all` deletes its fixture in the `finally` cleanup, so no `last` fixture remained. Not a defect; the full-acceptance green for the final code state is **run 72** (and the prebuilt smoke passed with the same harness) |
