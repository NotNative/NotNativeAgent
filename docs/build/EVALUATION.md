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
| Installer / on-system presence | **none exists yet** — no P12 shell, no packaged artifact; the app only "runs" from a source checkout |
| NNA harness | NOT integrated — everything above runs against the mock harness (by design); the PA seam phase carries the real integration risk |

**Open debt (from registers, non-blocking)**: P3d chat leftovers; P4-3
adversarial review still QUEUED (fs write family + session-folders, risk rows
named in the P4-3 log entry); stale-dist serving after a failed build
(audit-proven: pre-write vite failures skip emptyOutDir cleanup and
`pnpm start` then serves the last-good UI silently — serve-time build-stamp
check = P12b candidate); E-06-4..18, E-07-3..23, E-08-1..69, E-09-1..14
rows; chunk size/code-split warnings in the vite build output.
