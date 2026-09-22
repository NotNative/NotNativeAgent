# Evaluation Log — working / broken on this system

Running ledger of what has been VERIFIED on the build host (as opposed to what
unit tests assert in-process). Entries are dated; re-verification supersedes.

## 2026-09-21 · baseline at seal 20260921-2 (+ build fix → 20260921-3)

**Verified working**

| Surface | Evidence |
|---|---|
| Server boot + API + control SSE + mock harness echo loop | `scripts/smoke-test.js` in-process (session id returned) |
| Typecheck | `tsc --noEmit` ×4 tsconfigs (ui, web ui/server/cross) — 0 errors |
| UI unit/contract suite | vitest 608/608 (64 files) |
| Web server/contract suite | vitest 586/586 (41 files) — incl. relay wire E2E, terminal live ConPTY, worktree git flows |
| Quality gates | POWER10 caps + controlled-language registry (36 terms) + repository graph (335 modules) |
| Seal integrity | `release:check` green pre-edit; flagged the index.css edit honestly until re-seal |
| Production UI bundle | vite build green AFTER the 1-line css fix: 246 modules, `dist/assets/index-*.js` 681 kB (gzip 204 kB), css 12.3 kB |
| CLI | `notnative` bin + connect-url suite green (42 tests, incl. live auto-start smoke logged at P8-5c) |

**Known broken / not yet usable**

| Item | State |
|---|---|
| Production build (pre-fix) | broken since P5-1 (bad `@import` path); fixed 2026-09-21; release gates now run `vite build` so it cannot rot silently again |
| `pnpm dev` loop | never verified in an agent context (D7); after the css fix the tailwind import resolves in dev too — needs user-terminal confirmation |
| Installer / on-system presence | **superseded 2026-09-22 — see P12a section below** |
| NNA harness | NOT integrated — everything above runs against the mock harness (by design); the PA seam phase carries the real integration risk |

## 2026-09-22 · P12a — first real install on this system (20260921-3, pending seal)

**Verified working** (installed app, not source checkout)

| Surface | Evidence |
|---|---|
| NSIS installer build | `dist-electron/NotNativeDesktop-Setup-20260921.0.3-win-x64.exe` 106.8 MiB, sha256 `21171ffc32b0556e6c9ccaee65eaa7d1862c0d1ced0de78c89d66675fbc9ec1b` (printed by pipeline step 5) |
| Silent install | `/S` exit 0 → `%LOCALAPPDATA%\Programs\@notnativeelectron\` (exe, app.asar, `resources\web-dist`, loose `resources\dist-server\{server.mjs,settings-registry.json}`); uninstaller present and verified (silent removal, dir gone) |
| Boot chain | `main.log`: app start v20260921.0.3 packaged → import loose bundle → `server ready → 127.0.0.1:57123 (harness: mock)` → handle bound → `nnd-shell-prefs.json {port:57123}` → `navigating main window` |
| Health | `GET /health` → 200 `{"ok":true,"name":"NotNativeDesktop","version":"0.0.1","runtime":"desktop","serverId":"Otxht…"}` |
| Served UI | `/` → 200 2412 B; `/assets/index-BS88G5A8.js` → 200 |
| Process state | 4 NotNativeDesktop processes resident after successful boot (left running for user evaluation) |

**Found & fixed during first-boot hardening** (source-checkout gates could not see any of these; all were packaged-only):

| Defect | Failure seen | Fix |
|---|---|---|
| `selfDir()` returned main.mjs's file path, not its directory | packaged boot exit 1: `server bundle missing … app.asar\main.mjs\dist-server\server.mjs` | `path.dirname` in `main.mjs`; `resolveServerBundle` prefers loose `resources\dist-server` outside asar |
| ESM bundle has no `require` for CJS deps | import-time `Dynamic require of "events" is not supported` (ws) | esbuild banner `createRequire(import.meta.url)` + bundle-audit guard |
| Runtime JSON siblings not copied by esbuild | `ENOENT settings-registry.json` during `startServer` | `SIBLING_DATA` staging step in `electron-package.mjs` |

**Residuals / noted**: `/health` version surface is `0.0.1` (web package.json) while app version is `20260921.0.3` (extraMetadata) — audit verdict pending; install dir `@notnativeelectron` vs userData `NotNativeDesktop` naming drift; node-pty ships external (terminal-create failure shape pending audit); rebuild runs leave exit-1 from pwsh stderr-mangling (NativeCommandError) — pipeline oracle is `reportArtifacts`, not the shell exit code.

**Open debt (from registers, non-blocking)**: P3d chat leftovers; P4-3
adversarial review still QUEUED (fs write family + session-folders, risk rows
named in the P4-3 log entry); stale-dist serving after a failed build
(audit-proven: pre-write vite failures skip emptyOutDir cleanup and
`pnpm start` then serves the last-good UI silently — serve-time build-stamp
check = P12b candidate); E-06-4..18, E-07-3..23, E-08-1..69, E-09-1..14
rows; chunk size/code-split warnings in the vite build output.
