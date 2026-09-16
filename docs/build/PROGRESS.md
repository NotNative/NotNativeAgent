# Progress Log

Goal: full cleanroom build of NotNativeDesktop per docs/planning (see `PLAN.md`).

| Phase | Doc(s) | Status |
|---|---|---|
| P0 scaffold + shell | 01 | ✅ done 2026-07-21 (typecheck ×3 · vitest 6/6 · vite build · prod-serve + echo-loop smoke) |
| P1 harness seam | 02 | ✅ done 2026-07-22 (typecheck ×3 · vitest 11/11 incl. in-process contract tests · vite build · live smoke: LF-8 event sequence, Last-Event-ID replay, messageID echo, permission 404-settled) |
| P2 sync engine | 04 | 🔶 done 2026-09-16 (typecheck ×3 · vitest 84/84 across 12 suites · gates+smoke · adversarial sub-agent review: P0+P1 fixed in-slice, residuals registered) |
| P3 chat UI | 05 | pending |
| P4 server/API | 03 | pending |
| P5 themes/settings | 14 | pending |
| P6 review | 06 | pending |
| P7 terminal | 07 | pending |
| P8 autonomy | 12 | pending |
| P9 knowledge/context | 15 | pending |
| P10 preview | 13 | pending |
| P11 remote/security | 08 | pending |
| P12 Electron | 09 | pending |
| (deferred) VS Code | 10 | long-term deferred |
| (deferred) Mobile | 11 | long-term deferred |

## Log

- 2026-07-21 · Read 00-INDEX + 01 in full. Scoping decisions recorded (harness=NNA
  later + mock now; web spine → Electron; defer 10/11; stack per DECISIONS.md).
  Writing P0 scaffold.
- 2026-07-21 · **P0 done.** Monorepo (pnpm·Node24-native-TS·Hono·Vite7·Tailwind4·
  zustand5), runtime lib (globals, url/auth/fetch-bridge+HP-6 coalescing, endpoint
  switch, surface stamp, splash, startupTrace, chunkRecovery), harness seam + mock
  harness (echo loop, SSE /api/event), control SSE, auth-session/url-token stubs,
  App boot state machine (10× retry → recovery screen), MainLayout skeleton
  (sidebar/header/chat/rail), vitest 6/6, production bundle served by the Node
  server. Verified: /health, /auth/*, /api/session echo POST→reply, / + assets 200.
  Known limits: agent sandbox cannot spawn esbuild → dev-loop (`pnpm dev`) is a
  user-terminal step; browser visual check pending user eyes at http://127.0.0.1:3902.
- 2026-07-22 · **P1 done.** Doc 02 read in full (1484 lines) → `NOTES/02-harness-contract.md`.
  Mock harness rewritten as contract implementation (`server/harness/mock/{index,store,sim,
  events,fixtures}.ts`): bare-payload wire (D12), §6 shapes via new `ui/lib/nna/types.ts`,
  LF-8 turn simulation (transcription deltas → durable part), §5.1 envelope + ring replay
  w/ Last-Event-ID, v1+v2 permissions, questions, todos, fork/abort/revert/summarize/share,
  providers/models/agents/commands/tools-ids/path/project, `x-nnd-directory` header transport.
  Server proxy adds session-list sanitation (§3.2 keep-list). UI SDK facade (`nna/client.ts`)
  grows to the §3.4 catalog with §3.5a directory transport + ascendingId message ids; events
  client unwraps envelopes; sessions store keeps authoritative status map; ChatView busy
  pill; control stream standardized to `notnative:*` data frames. New in-process contract
  tests (messageID echo, 204+events, replay, abort-mid-part, permission 404-settled).
  Also: P0 mojibake repaired; harness naming centralized (`server/lib/harnessNaming.ts`).

- 2026-09-16 · **P2 done (resumed + completed by new agent).** Interrupted build
  repaired: sync-engine corruption (stray parens, missing view-store, bogus
  allSettled-concurrency) + repo-wide NUL/mojibake sweep (15 files; box-drawing
  comment dividers). Brand unified nna→nnd paths (`lib/nnd`), VITE_NND_URL.
  Engine split to POWER10 caps: pipeline-queues/attempts, transcript/blocking
  reducers, bootstrap(+directory/enrichment), engine-{instance,recovery,
  materialization,watchdog,message-poll,side-effects,actions,support}, view-store.
  84 vitest tests per NOTES §J.2 hinges (queues: 4 coalescing keys + barriers +
  frames + caps; reducer: freshness/chronology/terminal-part/dedupe/no-op/
  tombstone; routing precedence; child-store scheduler+eviction; loader
  inflight/expansion/tail/generations; optimistic taxonomy; ordering/timing;
  signature merge; batch primitive publication). Quality suite added
  (quality-gates POWER10 hard caps TS-aware, controlled-language NND-CTL with
  32-term registry + report, repository-graph, bump-version, release-gates,
  in-process smoke) wired to `pnpm run check`.
  Adversarial review dispositions (sub-agent): FIXED — runtime-reset scheduler
  brick (manager.reset, §11.2), primitive field publication in batches
  (sessionRevision/Total/deletedRevision), mergeBootstrapLists closed hierarchy,
  global bootstrap at start, eviction sweep interval, signature guard reads
  post-fetch state (no resurrect/loss), archive echo carries the stripped record
  (global cached bucket + status retirement), pipeline interrupt/heartbeat
  classification + real disconnect reasons. REGISTERED for later phases:
  control-frame normalization seam (P2-2), routing scan/info.directory (P2-3),
  streaming reconcile hooks + bounds (P2-4), per-dir watchdog cooldowns +
  discovery insert (P2-5), recovery runtime guards (P2-6), lifecycle action
  completeness (P2-7), optimistic revert-branch + ownership dirs (P2-8), loader
  complete-flag/deletion-merge (P2-9), bootstrap pagination + project.current
  abort rule (P2-10), covered-snapshot settle + ordering tie-break (P2-11),
  minor churn/bounds items (P2-12) — full list in NOTES/04 §"Review register".

## Delta/Delayed register

| # | Item | Phase landing | Note |
|---|---|---|---|
| D1 | Mock harness semantics | P1 (doc 02) | P0 ships `/health`,`/auth/*`,`/api` proxy + control SSE only |
| D2 | Real auth (password/passkey) | P11 (doc 08) | P0 ships allow-all session + url-token mint |
| D3 | PWA manifest endpoint, SW update UX | P4 | P0 uses fallback manifest |
| D4 | GitHub/Linear/push integrations | P3/P4 | API members stubbed behind RuntimeAPIs optional fields |
| D5 | Terminal/git/files RuntimeAPIs bodies | P6/P7 | throwing stubs with typed contracts now |
| D6 | Electron globals/boot outcome | P12 | types now, behavior later |
| D7 | dev loop (`pnpm dev`) verification | user terminal | agent sandbox blocks esbuild/vite spawns; prod-build path verified instead |
| D8 | `system` theme variant via matchMedia | P5 (doc 14) | system currently renders dark |
| D9 | PWA manifest link + install/push hooks | P4/P11 | server endpoint exists; HTML prelude simplified |
| D10 | mobile surface | long-term | renders desktop tree + console warning |
| D11 | control-stream consumers | P2 (doc 04) | subscribed in App, handlers minimal |
| D12 | bare harness payloads | P1 | `{data,error,response}` synthesized in UI facade; v2 surface keeps `{data}` on the wire |
| D13 | seam renames | P1 | `x-nnd-directory`, stdout line `notnativeagent server listening on <URL>`, `NNA_*` env, `notnative:*` control events — coordinated pass pending NNA |
| D14 | mock scope boundary | P1 | mock = §12.1 + early §12.2 items; lifecycle/spawn/Basic-auth (P-01/03/22) belong to the future NNA adapter, not the mock |
| D15 | wire-name duplication | P1 | `server/lib/harnessNaming.ts` mirrors `ui/lib/nna/constants.ts`; both files change together |
| D16 | WS event bridges | P2 (doc 04) | P1 ships SSE only; §9.4 WS frame vocabulary recorded in NOTES/02 |
