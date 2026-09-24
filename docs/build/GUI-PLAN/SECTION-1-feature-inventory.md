# GUI-PLAN — Section 1: Wanted feature inventory (ACCEPTANCE LIST)

Owner: the GUI bring-up effort. Superset index: [`../GUI-PLAN.md`](../GUI-PLAN.md)
(sections: 1 → this file · 2 → SECTION-2-current-state.md ·
3 → SECTION-3-reference-map.md · 4 → SECTION-4-slice-plan.md).

**Purpose:** the inventory of what NotNativeDesktop WANTS to be. Walk order:
the docs named by the effort brief (00-INDEX map; 01, 03, 04, 05, 06, 07, 08,
09, 12, 13, 14, 15). Citations are doc-§/section-title. The build checklist
sections (05 §J, 06 §13, 07 §11, 08 §14, 09 §15, 12 §J, 13 §L, 14 §L, 15 §M)
are the docs' own acceptance lists and are the authority for "done".

Conventions: wanted capabilities carry stable ids `W-xx` so slices can cite
them. "Harness" = our agentic backend behind `packages/web/src/server/harness/*`
(objective: NotNativeAgent "NNA"; today the `mock` adapter only. The
contract/auth = `docs/planning/02-opencode-harness-contract.md`).

## Collection 1 — Wanted feature inventory (ACCEPTANCE LIST)

Every user-facing capability the planning docs specify. The build checklist
sections (05 §J, 06 §13, 07 §11, 08 §14, 09 §15, 12 §J, 13 §L, 14 §L, 15 §M) are the
docs' own acceptance lists and are the authority for "done".

### 1.1 App shell & boot (01)

- W-01 Five runtime surfaces sharing one UI tree: Desktop (Electron), Web/PWA,
  VS Code, iOS/Android (Capacitor), CLI/server package roles; per-runtime
  adaptation via window globals ("who am I" contract), cross-window channels,
  RuntimeAPIs contract (01 §3.1–§3.3).
- W-02 Web/PWA cold boot sequence: index.html pre-app contract (splash, theme
  pre-paint, 10 s fallback) → `main.tsx` order → `App.tsx` boot steps (≤10
  init attempts, 1 s×2 up to 16 s cap → manual recovery screen) (01 §4.1–§4.3).
- W-03 PWA install & update UX + offline/fragile-network behavior, shell-level
  background polls (01 §4.5–§4.6, §10.6).
- W-04 Session auth gate phases inside the app tree for web electron mini-chat
  surfaces (`SessionAuthGate`: locked / tunnel-locked / rate-limited / error)
  (01 §4.4).
- W-05 Desktop app shell region tree `MainLayout`: sidebar (sessions), header,
  main area (Chat + surface pages), ContextPanel with keep-alive panes, rail,
  SettingsWindow, command palette host (01 §13.1).
- W-06 Context-panel surfaces registry with per-surface availability, default
  widths, has-content gating, rail reorder/hide, per-directory width restore,
  keep-alive classes (01 §13.2).
- W-07 URL router state ⇄ query params (session id, surface, settings deep
  link `?settings=`) (01 §12; 01 §13.2 invariants).
- W-08 Runtime endpoint/instance switching: `resetAppForRuntimeEndpointChange`
  store-reset contract (01 §11.1–§11.2).
- W-09 State ownership map (which state is shell-local vs sync-owned) (01 §14).
- W-10 Shell chrome: window controls, splash, renderer crash recovery, in-flight
  read coalescing (01 §5.2–§5.4, §10.5; 09 §12.1).
- W-11 Mini Chat Electron window + embedded session-chat iframe tabs in the
  context panel (01 §8–§9; 05 §A.5, §J#22).

### 1.2 Chat & session product (05; 04 owns state)

- W-12 Session record / message record / Part union shape as rendering spine
  (05 §0.1–§0.3; 02 §6).
- W-13 Chat surface IA: composition tree (chat column + work status column +
  composer slot), per-runtime deltas, session detail header (05 §A.1–§A.4).
- W-14 Onboarding first-run chooser/local/remote/recovery screens + watcher +
  wizard copy (05 §A.6; 05 §J#25).
- W-15 Composer: editor (CodeMirror), prompt language (single source of
  truth), keyboard policy, autocomplete pickers, attachments/context supplies,
  draft persistence & targeting, submit assembly invariant, slash-command error
  toasts (05 §B.1–§B.12).
- W-16 Queue/steer sender-side semantics + abort semantics (05 §B.10–§B.11).
- W-17 Message rendering: timeline model (turns), row anatomy, full part
  catalog (text, reasoning, tool cards expandable with rich diff/JSON/bash
  live output, todo, question, task…), Markdown pipeline (sanitized,
  worker-highlighted code), text selection menu, live activity & turn
  disclosure, timestamps/freshness/pins, changed-files turn footer, history
  loading edge rules (05 §C.1–§C.10).
- W-18 Session list/sidebar: structure, project/worktree zone, session row
  (badges, activity, PR status, action indicators), ordering & structure,
  search (exact-ID rule), row context menu inventory, folders, keyboard session
  switcher, header tabs `SessionTabsStrip` (05 §D.1–§D.9).
- W-19 Status/live activity: floating status chip (working row), session-level
  sync states, idle recap `SessionRecapNote`, suggested follow-up chip,
  auto-review banner, composer status bar (todos & abort chip), session error
  notice (05 §E.1–§E.8).
- W-20 Question & permission UX: placement, permission card (reply once /
  always / reject), question card (tabs, answers), send-while-blocked rule,
  auto-accept policy UI (05 §F.1–§F.4; 04 §E.4–§E.6).
- W-21 Usage/quota/limits UI (readouts, header linkouts) (05 §G; 02 §7.3).
- W-22 Command palette, input history, snippets, magic prompts, draft starters
  (05 §H.1–§H.6; 15 §I).
- W-23 Timeline dialog (turn search, revert-from-here, fork-from-here), prompt
  navigator rail (05 §A.7–§A.8).
- W-24 AI session rename, pins/notifications/multi-select, archive view,
  export Markdown dialog (05 §D.11–§D.13; 15 §J.4).
- W-25 BTW side-channel (fork-of-turn small-model query) + session assist
  (recap + suggested follow-up) (15 §H; 05 §E.3–§E.4).
- W-26 Empty/loading/error state catalog per surface with exact strings
  (05 §I; 05 §J#24).
- W-27 Virtualized turn timeline with history paging + `#message-<id>` deep
  links (05 §J#3; 04 §E.1).

### 1.3 Sync & state engine (04)

- W-28 Layered client sync: event pipeline → routing index → directory child
  stores → React bindings; two data scopes never merged (global vs directory)
  (04 §A.1–§A.2).
- W-29 Complete event catalog with clone-on-receipt map; transport envelope
  normalization (04 §B).
- W-30 Bootstrap sequences: global bootstrap (path/config/projects), directory
  bootstrap (sessions + tails + enrichments), cold-start continuity layers,
  system-resume handler (04 §C).
- W-31 Live channel lifecycle: SSE/WS transports, coalescing, directory
  routing, ordering fixes, reconnect & recovery, watchdog / delayed poll /
  stale-stream resync, interrupted-turn reconciliation, incomplete-snapshot
  materialization scheduler (04 §D).
- W-32 Optimistic model: SessionMessageLoader as single transcript authority,
  optimistic send, send-failure taxonomy with user-visible faces, blocking
  request replies (permissions/questions), auto-accept policy, toast lifecycle,
  question cold-start recovery (04 §E).
- W-33 Session lifecycle machine: creation, directory resolution precedence,
  selection, archive/restore/delete (runtime-guarded), directory eviction,
  cache eviction, retention/auto-cleanup, folders/pins/tabs/todos/worktrees
  sidecars, session ordering/timing (04 §F).
- W-34 Persistence design: keyed localStorage catalogs, message-queue
  persistence, worktree topology cache, folder sync, input-history delta
  reconciliation, chat drafts (04 §G).
- W-35 Streaming representation consumed by 05 (stream store shape, part-text
  pipeline, revert/undo/redo representation) (04 §H).
- W-36 Performance contracts (visible-demand drivers, eviction, budgeted
  tails) (04 §I).
- W-37 Sync-state invariant set enforced mechanically (04 Appendix 1-2).

### 1.4 Server & API + harness seam (03; 02 owns the seam contract)

- W-38 Server boot & middleware chain in registration order, global `/api`
  auth gate placed after auth routes, JSON body policy, compression, request
  deadline, static/SPA/PWA + `--api-only` mode (03 §1–§3, Appendix A).
- W-39 Complete route table (~253 routes / 40 modules behind the auth gate):
  server status/system, auth/session/passkeys, remote clients & pairing,
  platform routes, settings & config, providers, config entities, plugins,
  skills, markdown image grants, project icons, git (68 routes), filesystem
  (17 routes), projects/per-project config, scheduled tasks, session
  orchestration, message queue, permission auto-accept, session goal, session
  knowledge, session folders, GitHub, Linear, TTS/STT/summarize, dictation,
  terminal, quota/credential providers, small model, walkthrough, magic
  prompts, dev-server discovery, browser control, tunnels, private relay,
  realtime proxy, notifications/attention chips, harness passthrough proxy
  (03 §5.1–§5.40, §12#3).
- W-40 Harness two-tier contract: browser→NND server proxy seam
  (`/api/*` catch-all with session-list sanitation), server→harness REST
  inventory, event-stream contract (~60 event types incl. synthetic
  `openchamber:*`/`notnative:*` server channels),LF flows (start/attach/
  restart/upgrade/shutdown) (02 §1–§5; 03 §4, §5.38-39).
- W-41 Port catalog P-01…P-24 for the replacement harness; minimal + full
  harness checklists (02 §9, §12).
- W-42 CLI (commands/flags/`--json`/`--quiet`/exit codes/tunnels/schedule/
  session subcommands), startup-service installers, update flow (03 §10, §23).
- W-43 Disk data layout + settings.json groups + migration + strict readers
  (03 §7; 03 §14 invariants).
- W-44 Env-var reference (typed parse + fallbacks) (03 §9).
- W-45 Managed vs external harness mode matrix (what degrades when the harness
  was not spawned by us) (02 §10).

### 1.5 Code review surfaces (06)

- W-46 FilesView: tree model/loading (DirectoryRequests), status dots/badges
  icons, tree search, row menus, file dialogs (create/rename/delete), open
  tabs store, unsaved guard, outside-workspace grants, markdown-image grant
  consumption (06 §2).
- W-47 Text editor: CodeMirror 6 config, load pipeline, position restore,
  poll/external changes/edit-conflict handling, autosave cycle, pending
  navigation from tool/chat, GoToLine, large-file behavior (06 §3).
- W-48 Preview panes: image / PDF / HTML / Draw.io / Markdown / JSON / generic
  code (PierreFile/Shiki) with per-type persisted view modes (06 §4).
- W-49 Diff system: data model (change scopes, ranges), diff renderer
  (Pierre-equivalent replaceable), DiffView scopes selector, stacked view,
  unified/side-by-side configs, load pipelines, hunk navigation + actions,
  scroll anchoring, binary/image diffs, open-in-editor-from-diff (06 §5).
- W-50 GitView: header cluster, in-progress ops, changes panel + tree, stage/
  unstage optimistic queue, commit section, empty state, branch workflow
  dialogs (update branch, re-integrate, conflict), history & graph, stashes,
  diff prefetching, PR chip store (06 §6).
- W-51 Worktrees UI + branch diff scoping + creation flows (06 §7; 05 §D.2).
- W-52 PlanView + persistence (resolution order, save queue, autosave,
  improve/implement sends, walkthrough step navigation) (06 §8).
- W-53 PR / GitHub & Linear surfaces: PullRequestView sections, Linear issues
  view (06 §9; 03 §5.23-24).
- W-54 Inline comments: draft store, lifecycle on CodeMirror surfaces +
  Pierre diff overlays + markdown previews, add-selection-to-chat, review flow
  (handoff → auto-review loop → final marker) (06 §10).
- W-55 Cache/invalidation trigger tables + retained-view `visible` gating
  (06 §11; §13#1).

### 1.6 Terminal (07)

- W-56 Terminal v3 wire protocol: WS framing, hello/attach/snapshot/replay
  rules, sequence/j-dedupe, redirect, heartbeats and reconnect timings,
  HTTP command plane (07 §3).
- W-57 PTY lifecycle per platform (ConPTY on Windows / bash-pty patch / shell
  fallback chains), spawn options, shell selection, history retention +
  sanitization, theme-response answering (OSC/DA1), resize/restart/close/idle
  reaping, shutdown discipline (07 §4).
- W-58 Renderer: ghostty/vt (libghostty) wasm adapter or equivalent, canvas
  surface, input matrix (legacy/Kitty, IME 229, paste bracketing, mouse
  modes), fonts, theme source mapping (07 §5).
- W-59 Client architecture: TerminalTransport (reconnect matrix),
  useTerminalStore, TerminalView panel, visibility/focus pausing, close
  semantics (tab vs session), terminal settings keys (07 §6).
- W-60 Reattach/persistence/cross-device: session observer, multi-device
  mirror, reload replay (07 §7).
- W-61 Project actions executed in terminals (run/adopt/stop/force-kill, trust
  prompt, exit-code capture, URL auto-open) (07 §8).
- W-62 Terminal security (input economy 512 KiB trimming, key separation)
  + I-list invariants (07 §9, §10).
- W-63 Attach selection → composer context / inline comment draft from
  terminal selection (07 §7.4).

### 1.7 Remote access & security (08; 09 for desktop transport)

- W-64 Auth model: UI password sessions (scrypt/JWT/cookie/rate limit),
  passkeys (WebAuthn enroll + login), runtime URL auth tokens (short-lived,
  allowlisted), trusted-device client tokens, auth-expiry detection + banner;
  call-scope partitioning (local vs tunnel vs unknown-public) (08 §2).
- W-65 Private relay E2EE: broker protocol (host control/data connections),
  Layer-2 handshake (transcribed crypto), frame formats + byte budgets,
  batching + downstream flow control, host dispatcher loopback rules, client
  tunnel surface, reconnection/keepalive, demand-driven host lifecycle,
  machine claim, pairing candidates, self-reported diagnostics, host
  management routes, security properties (08 §3).
- W-66 Tunnels: provider/mode matrix (cloudflared quick/managed-remote/
  managed-local, ngrok), start request validation, profile store,
  tunnel-gated auth (bootstrap token + tunnel cookie), lifecycle/invalidation
  (08 §4).
- W-67 Pairing + connect links: link format, payload fields/versioning, store
  + redemption flow, candidate racing, QR generation, CLI `connect-url`,
  pairing dialog scope rules, device pairing per client (08 §5–§6).
- W-68 SSH remote machines (desktop): machines-as-instances model, instance
  configuration shape, status phases/events, electron-owned internals (08 §7).
- W-69 Dev-server preview tunnel (short cross-ref; 13 §H owns depth) (08 §8).
- W-70 Reverse proxy posture: forwarded headers, Secure cookies, passkey rpID,
  robots hygiene (08 §9).
- W-71 Security promises: never-log/leak lists, secret storage locations
  (server + clients), revocation semantics, invalidations, edge/failure
  matrix (08 §12–§13).
- W-72 Host/instance management UX: device list (revoke/purge), direct
  instances, host switcher with statuses, auth-expiry banner (08 §6.4-6.7;
  §14#12).

### 1.8 Electron desktop shell & OS integration (09)

- W-73 Process architecture: in-process server hosting (no sidecar), boot flow
  (identity, port selection stored→default→ephemeral with test-bind, env
  before import, health probe before navigation), splash, single-instance
  focus, chdir to home (09 §1).
- W-74 IPC/bridge catalog: `invoke` command catalog + sender gate, main→
  renderer events, preload exposure matrix, safe-for-remote set (09 §3, §11).
- W-75 Window model: main window options, geometry restore/clamps,
  close-to-tray, Mini Chat windows, focus/multi-instance, navigation guards
  (09 §4).
- W-76 Deep links `notnative://connect` (pairing v2, consent-first), session,
  host deep links with queueing (09 §5).
- W-77 UI loading modes: packaged protocol with traversal guard, SPA fallback,
  runtime-config injection into HTML (09 §6).
- W-78 Embedded browser panel (preview host): partition, permission denial,
  cert policy, dev-server friendliness, capture integration, color-scheme
  emulation, storage controls, panel security policy (09 §7).
- W-79 SSH manager internals: import, command envelope, ControlMaster/Windows
  modes, askpass, remote install/update/serve, forwards, health gating,
  monitor/retry/disconnect (09 §8).
- W-80 Updater pipeline per platform (capabilities gating, check/download/
  apply, web-client path, manifests/channels, CLI-in-app updater) (09 §9).
- W-81 Tray, menus, native notifications (dedupe, hidden gating, click
  routing), dock badge, open-in-app chains, installed-app discovery, launch at
  login, keep-awake, power monitor resume, clear-cache (09 §10, §13.8).
- W-82 Security invariants under adversarial test (remote page cannot read
  files / spawn apps / touch SSH / updater; panel guest id fail-closed; no
  secrets in logs/DOM) (09 §11).
- W-83 Packaging matrix: electron-builder config, pipeline, arch resolution,
  update manifests, bundled CLI staging (09 §14).
- W-84 File utilities: `desktop_read_file` guard chain, markdown save, atomic
  replace with Windows retry, path validation (09 §12).

### 1.9 Autonomy & orchestration (12)

- W-85 Session Goals: payload schema + hard limits, state machine, arming +
  event wiring, tick evaluation gates, audit exchange (small model), prompt
  formats (`[HARNESS PORT]`), server-side creation, UI: composer target
  button, goal strip, manage dialog, sidebar glyph, settings keys (12 §B, §H).
- W-86 Scheduled Tasks: task storage (per-project config JSON), cron semantics
  (lib + IANA tz), next-run computation, runtime scheduling model, occurrence
  claiming across instances, run pipeline with watchdog, completion + one-shot
  consumption, loop files, multi-writer safety, task events; UI: scheduled
  tasks dialog + editor (cron preview, model/agent select, run-as-goal, auto-
  accept toggle), live `scheduled-task-ran` stream (12 §C, §H).
- W-87 Message Queue (both sides): item schema, server persistence (corrupt
  quarantine), delivery loop with live idle verification, holds (auto-review
  coordination), routes + SSE, UI projection store, composer queue/steer
  chips (edit/reorder/clear-all + context preview), VS Code auto-send,
  `followUpBehavior` setting (12 §D, §H).
- W-88 Multi-run + Fusion: config schema, identity/title conventions, create
  flow (up to 5 models, optional worktree per run), review/compare surfaces,
  fusion step, launcher + windowed variants, agent groups/manager view (12 §E,
  §H).
- W-89 Orchestration glue: `openchamber-sessions`-equivalent managed-session
  service (create/send/fork/archive with ordering/validated side effects)
  (12 §F).
- W-90 Failure/recovery matrices + invariant set (goal abort semantics, queue
  isolation, idempotent claimed occurrences, user stop always wins) (12 §G-§I).

### 1.10 Preview & inspection (13)

- W-91 Dev-server discovery: listening-socket enumeration parsers (lsof/
  netstat/proc), noise filters, TTL cache, announced servers, startup-state
  probe, `GET /api/dev-servers` + `POST /api/system/probe-url` (13 §B).
- W-92 Preview UX: panel/tabs, chrome, iframe + Chromium webview transports,
  address rules, dev-server startup wait, empty states, reload/reconnect, dev
  tunnel address mapping (13 §C).
- W-93 Browser-control inspection protocol: SSE envelope, broker (claims,
  rejectAll), HTTP callbacks, client half (claim-before-act), action
  validation, injected page scripts (element capture/styles/scroll), user
  annotation end-to-end (screenshot composite → prompt → send), console
  problem capture, `browser.capture`→project file (13 §D).
- W-94 Walkthrough (changes tour): server pipeline (sources, hunk identity,
  digest, generated-file exclusion, prompt, response schema, model budgets,
  refusals, caching, generation jobs, readiness), UI (view model, store,
  panel, stage pacing, TOC, stream, blocker), entry points (13 §F–§G).
- W-95 Dev tunnels: host runtime (auth matrix, caps, backpressure), direct
  client, relay branch (Electron MessagePort), panel decision logic (13 §H).
- W-96 Celebration fireworks (13 §I).
- W-97 Security model of preview/inspection (guest page is not privileged,
  connection-scoped capture opt-in, screenshot writes, walkthrough data
  safety) (13 §J; 09 §7.4).

### 1.11 Theme, settings, i18n, shortcuts (14)

- W-98 Design tokens (static defaults + Tailwind mapping) + typography + fonts
  + motion conventions; glass surfaces (14 §A–§B).
- W-99 Primitive component inventory (button/input/textarea/number-input/
  select/dialog/dropdown/context menus/tooltip/switch/checkbox/radio/toasts/
  card/skeleton/collapsible/scroll shadow/error boundary) + agent color
  classes (14 §C).
- W-100 Icon system: app icon sprite + ad-hoc icons + file-type icons (14 §D).
- W-101 Theme system pipeline: active-theme model, 38 built-in preset themes,
  custom-theme import format, per-surface persistence, application mechanics,
  embedded/iframe theme sync (14 §E).
- W-102 Settings system: registry (~160 keys) with scope/markers/snapshot
  gates, persistence engine (press-backed), adding-a-setting procedure;
  settings UI (window, page tree, search, appearance/session/notifications/
  voice/tunnel/general sections) (14 §F–§G).
- W-103 i18n: 12 locales, en dictionary type-loader, platform quirks
  (host-language seed), key completeness (14 §H).
- W-104 Shortcuts: full binding table (38), engine (registry/suspend/
  dispatcher/prefix), settings recorder, contextual ownership (14 §I).
- W-105 Time/money formatting conventions (14 §J).

### 1.12 Knowledge, context, skills, memory (15)

- W-106 Session knowledge blocks (pinned notes/plan/user/project/about) with
  three delivery moments/two transports + send path + routes + UI reading
  surfaces (15 §B).
- W-107 Agent memory (`openchamber`_memory`-equivalent tool, storage schema,
  restatement-dedupe, panel edit/forget, scope resolution, threat-pattern
  injection guard, feature gating, HTTP routes, UI store/badges) (15 §C).
- W-108 Project context: context.json v2 (notes/plans/todos/shared plans),
  Chats owner, legacy v1 migration, routes, invariants, UI data layer, note
  flows (15 §D).
- W-109 Skills: discovery roots, visibility flags, CRUD + file endpoints,
  catalog + install/update flow, client stores, composer autocomplete (15 §E).
- W-110 MCP management: config layers/routes, runtime status/control
  (`[HARNESS PORT]`), OAuth + import flows, draft model (15 §F).
- W-111 Obligatory context: pinned messages, compaction restoration runtime,
  directory attach flow, context file open guard, outside-file grants,
  markdown image grant server+consumer, `wrapSystemReminder` placement
  (15 §G).
- W-112 Snippets, draft starters, magic prompts (catalog + overrides), todo
  pipeline (session todos cache, project todos, send-to-agent, linked issues/
  PRs, auto-review pointer) (15 §I–§J).
- W-113 Injection matrix: what enters the model, through which port, when
  (15 §K; 02 §8).

### 1.13 Cross-cutting server facts the GUI/includes depend on (03 §6)

- W-114 Meeting each module's high-value invariant set: fs workspace grant
  rules, git, notifications (web push, APNs, desktop, SSE, attention chips),
  text/tts pipelines, markdown-image grants, permission auto-accept
  persistence, small-model proxies (03 §6.1–§6.10).
- W-115 Notifications surfaces: attention required-activity chips + status
  routes + web-push (03 §5.37, §6.3; 09 §10.2; 11 §C.6 for mobile delivery).

### 1.15 NNA workspace observability rail (NNA-first addition)

- W-116 Dockable right-side workspace rail: device-local rail order/hide and
  per-engine-context width; Context, Activity, Changes, Notes, Browser, and
  Terminal surfaces; keep-alive and visibility-gating rules; expand/close and
  surface-tab behavior. Activity is a replayable, filterable, evidence-linked NNA
  session log—not an inferred client timeline—and must apply NNA-authored
  redaction/revocation/correction to already cached rows as well as redact private
  reasoning, credentials, and unsafe diagnostic payloads. Compact view has an explicit
  return-to-chat affordance. Notes groups explicit general notes,
  todos, plans, and separately sourced agent memory. See NOTES/17 §"Right-side
  workspace rail". This adds NNA-native acceptance criteria beyond the v1.23.0
  cleanroom baseline.
- W-117 Delegated-session visibility and transcript: child rows nested under the
  initiating session with NNA-projected title/agent/live state/blocked or unread
  precedence; demand-loaded replayable child transcripts with tool evidence and a
  parent return affordance; read-only by default, with a hidden-until-authorized
  **Steer subagent** transcript-header toggle that deliberately reveals its composer;
  prompt/steer/cancel/blocker actions remain NNA-projected authorization decisions.
  Parent/child correlation, cursor gaps, redaction, deletion, entitlement loss, and a
  still-visible child with an unavailable parent must render honestly (including no
  guessed parent navigation). See NOTES/17 §"Delegated-session transcripts".

### 1.14 Deliberately NOT the GUI acceptance list (tracked separately)

- VS Code extension surface (doc 10) and mobile/Capacitor surface (doc 11) are
  separate shells consuming the same shared-UI package; they have their own
  acceptance lists (doc 10 §M, doc 11 §I). This GUI-PLAN covers the Desktop +
  Web/PWA GUI, its server, and the harness seam they share.
- Some server-side contracts (CLI, env table) support but do not gate GUI
  slices; they ride with the slice that first needs them.

---

*Non-gauges:* planning docs are static-analysis references (00-INDEX §5
"Declared Gaps" list possible drift points to re-verify per capability when
implemented).

---
