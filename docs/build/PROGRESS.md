# Progress Log

Goal: full cleanroom build of NotNativeDesktop per docs/planning (see `PLAN.md`).

| Phase | Doc(s) | Status |
|---|---|---|
| P0 scaffold + shell | 01 | ✅ done 2026-07-21 (typecheck ×3 · vitest 6/6 · vite build · prod-serve + echo-loop smoke) |
| P1 harness seam | 02 | ✅ done 2026-07-22 (typecheck ×3 · vitest 11/11 incl. in-process contract tests · vite build · live smoke: LF-8 event sequence, Last-Event-ID replay, messageID echo, permission 404-settled) |
| P2 sync engine | 04 | 🔶 done 2026-09-16 (typecheck ×3 · vitest 84/84 across 12 suites · gates+smoke · adversarial sub-agent review: P0+P1 fixed in-slice, residuals registered) |
| P3 chat UI | 05 | 🔶 P3a+P3b+P3c done 2026-09-16 (P3a: chat spine; P3b: model picker/starters/timeline/prompt-rail/BTW fork/focus mode; P3c: work-status panel §E.9 subset + §E.3/§E.4 recap+suggestion band; P3b+P3c adversarial review: P0×2 + P1×9 fixed; 122 vitest · tsc ×3 · gates+smoke · P3d/P4+ per NOTES 05 §A + review register) |
| P4 server/API | 03 | 🔶 P4-1..3 done 2026-09-16 (P4-1: fs read+git status/check pre-proxy w/ containment; P4-2: settings/themes/projects-config/context + git log/branches; P4-3: fs write family (mkdir/write/delete/rename atomic+root-refusal) + session-folders §5.22 (last-writer-wins, 413, sync write queue); P4-1 review escaped-fixes landed, P4-2 review P1×4 fixed, P4-3 review QUEUED; web 23/23 · UI 122 · gates+smoke) |
| P5 themes/settings | 14 | 🔶 P5-1 done 2026-09-16 (design-system.css full token block §B.1 light+dark + generated-token seed + radius/fonts/motion + §B.3 semantic typography + §B.2 @theme inline mappings wired into web index.css; ThemeProvider upgraded: system mode follows matchMedia both ways (Delta D8 resolved); 130 UI tests (theme tokens 5 + provider 3) · gates+smoke; P5-2 settings registry + presets + i18n queued) |
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

- 2026-09-16 · **ADR 0020 accepted (both repos), design freeze.** Ecosystem framing
  locked: NNA = root headless-first harness (TUI native, GUI-less core, add-on
  activation contract; NNO today, NND as second package); NND = GUI integration
  package + standalone remote client (client-only mode needs the NND web service
  installed in the target NNA); NNO = business layer above; delegated contexts spawn
  per consumer with run-as entitlement; loopback default + token handshake; network
  exposure = explicit opt-in gate; NNA projection (13-state) = sole turn-state
  authority; surfaces own their sessions/config; governance owns decisions (mode
  ladder is settable, not decidable, client-side); lifecycle split (NNA core owns
  commands, NND-local owns tray/shell face). NND registry grew four terms
  (integration package, engine context, projection frame, shell). PLAN.md re-scoped:
  P4 → NND web-service package routes (not a standalone server), P11 promoted to
  client core, P12 = shell delivery vehicle; ecosystem phases PA/PB/PC appended.
  NNA-side stub written: NotNativeAgent/docs/architecture/0020-ecosystem-integration.md
  (add-on contract, package activations, concerns incl. NNA harness-surface gap and
  console ADR 0018/0019 reconciliation registered, integration robustness noted as
  future NNA work). No product code changed; gates stay green (84/84, tsc ×3).

- 2026-09-16 · **P3a done (chat spine).** Doc 05 read in full (1957 lines) →
  NOTES/05 staging. Built under packages/ui/src/chat/: prompt-language
  (4-key tokenizer+triggers+shell transitions+§H.7 instruction exact),
  keyboard-policy (§B.5 exact), send-planner (§B.9/§F.4 taxonomy: local
  command/queue/steer/blocked-authority + §B.9 error mapping), turns
  projection renderable gate + §E.1 status derivation tool-phrase table,
  drafts (identity, tombstones, §B.10 client-held queue), input-history
  (§H.4 recall+overlays), composer v2 split to fit POWER10 matrix (real
  idle-flush queue, shell mode → runShell action, reactive catalog,
  draft-restore on failure returns column to draft), transcript (tail
  dedupe, synthetic filtering, skill/reasoning/tool/subtask/unknown-safe,
  §E.1 chip, §F cards incl. Alt+Enter/Alt+Shift+Enter/Alt+Backspace newest-
  wins), sidebar (§F.10 lifecycle ordering — engine-level tie-break fix
  applied), session tabs (left-neighbor close, digit keys renderable-only,
  no tombstones), engine mount (App rewired; P1 interim session store
  retired from the wire path; runShell/abort actions via routing).
  Adversarial review: P0-1 openSession no longer denies pending requests
  (§F.4/GUI-POWER10 #2); P1×11 fixed in-slice (tail dup, real queue,
  draft-failure restore, picker sources, shell no-op, reactive catalog,
  card keyboard, sidebar updated-sort, tab neighbor/tombstone, POWER10
  split, synthetic leak). P2-residuals recorded (§I error card, subtenants
  subtree scope, Other… input, retry tick, unbounded maps list, §E.9 panel).
  105 tests incl. 21 new chat gates; engine +2 (P2-4 partial reconcile,
  P2-11 tie-break) verified.

- 2026-09-16 · **P3b done (chat depth).** model-catalog (3-layer
  provider→model→variant layers, favorites persisted per runtime, effort
  cycle Default→variants both directions, §A.2 collision display labels),
  ModelPicker popover (search, Favorites+provider groups, current marker,
  star toggle, Left/Right effort within row), starters §H.5 (two groups,
  insert rule commands 'text ' vs skills sha 'text
', hover X remove), composer P3b props (expanded/focus mode, /btw →
  runShell-style fork via actions.fork + banner, model selection round-trip),
  timeline dialog §A.7 (newest-first, search, revert/fork/scroll actions,
  no-text placeholder), prompt rail §A.8 (≥2 prompts teleport instant),
  engine actions: rename (PATCH title), fork (returns new session id),
  revert (to-message), MainLayout /timeline via 'nnd:timeline-open' event,
  /undo //redo → last user message revert. Deferred with halo: BTW peek
  panel + promote/destroy (fork-open only in P3b), AI rename small-model
  service (P4+), starters DnD reorder + shared marker (P5 settings),
  model tooltip metadata (P5). 113 tests (+8 catalog/starters gates).

- 2026-09-16 · **P3c done (work-status §E.9 subset + §E.3/§E.4).** work-status
  selectors + panel-gate (§E.9 identity rule: computed only while
  sessionStatusReady + idle + completed turn; committed stats SURVIVE the next
  active turn — review caught the broken wiring), panel (presence-collapsed
  sections Session/Project/Turn stats/Subagents/Tasks, catalog-resolved
  context limit, §G no-borrow rule honored, no fabricated 0% on tokenless
  totals, no cost-only row), recapFor v2: metadata.nnd.assist + `generatedAt`
  60s quiet window + anchor freshness; §E.4 suggestion chip in the composer
  band FILLS the composer (never sends) via the nnd:composer-fill channel
  (shared with /undo). Adversarial review fixed: P0-1 fork children now
  REGISTER + ENQUEUE ensure-session-messages materialization (they were
  skeleton-forever), P0-2 /undo vs /redo split (keep-point truncate +
  composer refill vs unrevert+refetch) with 'nnd:composer-fill'; P1×9:
  expanded keyboard policy wired, model selection reaches promptAsync, shell
  on draft no longer creates a prompt session, timeline anchors
  (id=message-*) + replaceState hash + error toasts + Escape, panel committed
  stats wired, context% suppresses tokenless totals + catalog limit, recap
  branded + quiet + suggestion surface. Register: §I cards, picker metadata
  tooltips, starters add-dialog + DnD, BTW peek/promote, §E.9 MCP/Pinned/
  context-sources rows + equalizer persistence,subscription, cycleVariant per-row variant, transient-runtimeKey guard for
  persistence namespaces, POWER10 span-heuristic blindness to TSX (tracked
  in gates backlog). 122 tests (+9).
  subscription, cycleVariant per-row variant, transient-runtimeKey guard for
  persistence namespaces, POWER10 span-heuristic blindness to TSX (tracked in
  gates backlog). 122 tests (+9).

- 2026-09-16 · **P4-1 done (server surface first layer).** /api/fs list,
  search (NND extension — bounded server walk for the remote-first mention
  picker), git-dirs + /api/git check/status(light) mounted BEFORE the /api
  harness proxy (Hono order). Workspace containment DEVICE-AWARE (relative()
  returns absolute strings cross-drive on Windows) + realpath root gates;
  adversarial review: P0-1 cross-device enumeration and P0-2 junction escapes
  (proven route-level on this host) FIXED; P1: git-dirs scope-bound +
  root-excluded, search .git boundary, git unborn-branch parse ("No" → name),
  composer mention source /api/fs/search with monotonic token + query-match
  staleness guards. Web package gains its own vitest suite (workspace-
  resolution note: pnpm install needed CI=true + --no-frozen-lockfile).
  Registered: symlink transparency deviation (links listed but boolean-
  neutralized unless target realpath stays in scope), gitignore
  approximation, plans-dir lazy-empty case, parse light/drop of merge/rebase
  states (P4-2 with full §5.13 files), rename `old -> new` path shape.

- 2026-09-16 · **P4-3 done (fs write family + session-folders).** /api/fs
  mkdir/write/delete/rename (P4-3): all four handlers workspace-bound with
  the SAME device-aware + realpath containment as the read routes; write is
  atomic tmp+rename; rename relies on single-?directory-scope (both targets
  containment-checked); delete refuses the scope root; mkdir rejects
  allowOutsideWorkspace outright (§5.14 grant rule). /api/session-folders
  §5.22: last-writer-wins by updatedAt (`ignored:true`), 4MiB cap after
  parse (413), malformed stored snapshots → 500 with documented strings,
  single-flight write queue, atomic rename. Refactored to sub-functions to
  clear the 60-line function gate that fired mid-slice. Review: QUEUED
  (context budget) — first next-session item before P5; risk areas: write
  no-op check missing (registered P5), content-no-op false-positive on
  registerFile-gated routes, session-folders corruption semantics.
  23/23 web tests (+7).

- 2026-09-16 · **P5-1 done (theme token system core).** design-system.css
  authored from doc 14 §B.1 table verbatim (light `:root` + dark `.dark`
  shadcn-style aliases in oklch, shell/environment tokens, glass clusters per
  variant) + generated-token SEED (surface/interactive/status/pr/chat/tools/
  loading clusters condensed to base variables — runtime themes overwrite
  whole blocks via the css generator at doc-14 E.6) + §B.2 radius scale
  (0.25/0.4375/0.5625/0.75rem) + fonts/motion + §B.3 semantic typography
  (web/desktop column) + §B.2 `@theme inline` utility mappings. web index.css
  re-imports the sheet; body now uses token variables (no more hardcoded
  hex). ThemeProvider: Delta D8 RESOLVED — `system` mode follows matchMedia
  both directions; `.dark`/`.light` root classes drive the block switch.
  Tests read the CSS as a fixture (both-variant coverage, seed presence,
  typography values) + jsdom provider tests (classes persist, system
  follows). 130 UI tests (+8). Registered: 38 preset themes + custom theme
  import format (E.6) + settings registry snapshot gate (P5-2), VS Code
  webview typography column (P10), i18n catalog + shortcuts (P5-3).

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
