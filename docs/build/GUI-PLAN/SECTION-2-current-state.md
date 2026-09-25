## Collection 2 — Current state (verified against the repo, 2026-09-22)

Everything below was verified by opening the cited files (line numbers from the
current workspace). Focus: what boots, what renders, what is wired, and why the
installed app looks nearly empty.

### 2.1 Packages and entry flow as they exist today

- `packages/web` = Vite UI build (`src/main.tsx`) **plus** the Hono server
  (`src/server/index.ts`, `src/server/app.ts`). `packages/ui` = the shared app
  tree. `packages/electron` = minimal P12a shell v1 (`main.mjs`, `preload.mjs`,
  `dist-server/server.mjs` esbuild bundle, `resources/web-dist`).
- Boot order inside `packages/web/src/main.tsx` (01 §4.2 order): surface stamp
  → endpoint init → credentials → fetch bridge → RuntimeAPIs registration
  (`createWebAPIs()`) → `renderMainApp()` (main.tsx:19–37).
- Provider tree (packages/ui/src/main.tsx): `I18nProvider >
  ThemeProvider > SessionAuthGate > App`; the gate renders `App` only after
  `/auth/session` answers (main.tsx:9–24).
- `App.tsx` (`runBootPhase`): `fetchHealth()` reads the server-owned plan
  flag, then `initializeApp()` is retried ≤10× (1 s doubling, 16 s cap); on
  total failure a manual recovery screen replaces the shell (App.tsx:16–67).
- `initializeApp` = `checkConnection` (probe
  `GET /api/global/health`, 5 linear-backoff attempts) → parallel
  `loadProviders` / `loadAgents` → `markInitialized` (initializeApp.ts:10–24;
  useConfigStore.ts:41–75).
- After boot: `mountEngine()` — ONE SyncEngine; SSE subscriptions to
  `/api/event` (harness) + `/api/notnative/events` (control) dispatch into the
  engine's batch pipeline (chat/app-engine.ts:14–58; lib/nnd/events.ts:71–84).
- The sync engine boots real machinery: global bootstrap (path/config/
  projects, `sync/bootstrap.ts:23–38`), default directory resolution from
  harness `/path` (engine-support.ts:76–85), directory bootstrap with cached
  seeding + status snapshot + authoritative session list
  (sync/bootstrap-directory.ts:20–106), watchdog + recovery + materializer +
  eviction, EventPipeline with reconnect hooks (engine-instance.ts:151–197).

### 2.2 What actually renders on first paint (and it is near-empty by design)

- `MainLayout` (components/MainLayout.tsx) is a **header-dominant v1 shell**:
  text toolbar (diffs, git, plan, terminal, worktrees, files, settings), the
  session tabs strip, connection pill, then ONE replaceable pane —
  `FilesView | DiffView | GitView | PlanView | TerminalView`, else
  `[ChatSidebar | ChatView]` (MainLayout.tsx:150–265). The doc-01 shell tree
  (context rail, keep-alive panes, has-content surfaces) is NOT built.
- `ChatView` starts at `currentSessionId === null` → renders an **empty
  draft**: blank transcript, starter chips, composer (chat/chat-view.tsx:64–149;
  chat/starters.ts). **UPDATE (2026-09-22, P12b-5):** this snapshot predates
  the SLICE-A boot-open wiring + its two acceptance fixes; the boot now
  opens the persisted session (or the seeded welcome demo) once the
  AUTHORITATIVE list lands — `sync/boot-open-readiness.ts` waits for
  `sessionListSource === 'authoritative'` because the 'initial' recovery
  resync short-circuits on a fresh boot, and the §F.10 ordering keeps the
  ORIGINAL session records (earlier the wrapper stripped them to
  `{id,parentID,time}`, rendering every row "Untitled Session"). The
  restore pair is wired both ways (`persistLastActiveSession` callers in
  engine-instance onSession + MainLayout open/openDraft + timeline fork).
  The view store's `activeDirectory` is set at boot;
  `currentSessionId` lands via boot-open (or a user click: view-store.ts:16–21;
  MainLayout actions.openSession:131–135).
- `ChatSidebar` lists zones from `useGlobalSessionsStore.active`, hydrated
  only by directory bootstraps/merges; an empty zone renders the literal,
  honest string "No sessions in this workspace yet."
  (chat/session-sidebar.tsx:39–48, 103). Rename/archive/delete ride
  `engine.actions` (rename is queued behind a toast: "Session PATCH channel
  lands with P4" — MainLayout.tsx:136–139) and use browser `prompt()`/`confirm()`.
- Auth gate state: `driver passwordRequired()` → scope `open` with **no
  password set** (lib/auth/ui-auth.ts:33, 213); with one set, every boot shows
  the SessionAuthGate password form (SessionAuthGate.tsx:90–108). On the
  dev/packaged machine the password is now SET
  (`C:\Users\Mongrel\.notnative-desktop\settings.json` + `preferences.json`
  fields.desktopUiPassword, updated 2026-09-22T04:48:16Z), so the installed
  app currently starts at the lock screen, then (after login) the empty draft
  above.
- Zero-data hydration: with a fresh home directory and no sessions, global
  bootstrap still fills `path/projects/config`; directory bootstrap seeds
  cached sessions; if the authoritative list is EMPTY it stays empty
  (no retry loop, bootstrap-directory.ts:81–106) and the UI shows the empty
  states above — that part is *spec-compliant* (04 §C.3).

### 2.3 WHY the installed app looks almost empty (top facts)

1. **No session is ever re-opened.** Boot lands on a blank draft
   (`view.currentSessionId === null`); the "last active session" restore pair
   exists but is unwired (2.2). The user sees a mostly blank chat column +
   starters. The seeded "Welcome to NotNativeDesktop" mock session sits in the
   sidebar, unopened (mock/index.ts:43–78).
2. **The "real" harness is the mock, and its only content is one in-memory
   seed session bound to the server's CWD.** `DEFAULT_DIRECTORY =
   process.cwd()` (harness/mock/fixtures.ts:18). In the installed Electron
   app the shell chdir's to `os.homedir()` before importing the server bundle
   (packages/electron/main.mjs:47), so the welcome session lives in
   `C:/Users/Mongrel` and demos evaporate on restart (in-memory
   store/sim). There is no NNA adapter yet — `registerHarnessAdapter(mockHarness)` is
   the only registration (server/index.ts:21–25) — so chat answers are echoes
   and user-visible feature probes end at "Real answers arrive with NNA
   integration." (harness/mock/sim.ts:351–352 echo text; applyTriggers:61–112).
3. **The window is a toolbar v1** and the doc-01 shell surfaces it replaced
   (context rail, command palette host, keep-alive…) are absent, so even the
   implemented real-data views (files/diff/git/plan/terminal/worktrees are
   real client+server+tests) are TOGGLE buttons off-screen by default;
   on boot you never see them. Combined with (1), first paint = header +
   sidebar-with-one-zone + empty draft + composer. Empty **by data flow**, not
   by bug: every store renders its documented empty-state string.

Secondary facts that shape "empty" perception (for completeness):
- The initial `index.html` splash has a 10 s self-removal fallback and the
  gate releases it on first probe answer (index.html:29–52;
  SessionAuthGate.tsx:117–123) — no permanent splash issue.
- StrictMode double-boot exists only in dev; production is single-boot.
- Packaging history of the current installer (log at
  `C:\Users\Mongrel\AppData\Roaming\NotNativeDesktop\logs\main.log`): first
  runs failed on `server bundle missing` (resolveDistDir/asar path), then
  `Dynamic require of "events"` (ws in the esbuild bundle), then a missing
  `settings-registry.json` next to the bundle; the final packaged run
  (04:34:47 / 04:39:30) succeeded — `harness: mock`, port 57123, both
  windows navigated. So the installed artifacts now contain a complete
  server + the same `welcome` seed (bundle grep confirms "Welcome to
  NotNativeDesktop" and `prompt_async` inside
  `packages/electron/dist-server/server.mjs`). The web-dist hash inside the
  installer (index-BS88G5A8.js) equals `packages/web/dist` rebuilt at 23:51 —
  identical content.

### 2.4 Implemented vs unimplemented (per Collection-1 area)

| Area | Server side (packages/web/src/server) | UI side (packages/ui/src) | Verdict |
|---|---|---|---|
| Harness seam + chat loop | `harness/adapter.ts` (seam; :15–35), `harness/mock/*` full minimal+ surface: sessions, prompt_async, command/shell, fork/abort/revert/unrevert/summarize, permissions v1+v2, questions, todos, share, cursor paging (mock/index.ts) | Full SDK facade wraps all of it through `/api` (lib/nnd/client.ts:169–325), sync engine + streaming (§2.1) | **Real seam, mock adapter** — the chat loop WORKS against the mock (sim.ts streams 16-char deltas every 60 ms) |
| Sessions UX (list, ordering, archive, tabs) | session list sanitation (app.ts:32–67) | sidebar v1 + tabs + engine actions (archive/delete real; rename patched) | Implemented v1; spec depth (W-18 etc.) partial (folders/archive/pins/store-side missing) |
| Composer (queue/steer, mentions, attachments) | n/a (harness-bound) | composer.tsx with mode/policy/history/drafts; BTW fork via `engine.actions.fork` | v1; W-15/16 depth (attachments pipeline, mentions serialization, queue integration) not built |
| Message rendering (parts) | mock emits only text parts (+todo) | transcript.tsx + turns.ts render text/tool/todo/question/permission basics, streaming tail, markdown | Partial: text+todo+permission/question cards; tool-card rich diff, gallery, selection menu etc. missing |
| Terminal | full protocol: `terminal/*` (wire.ts protocol, history, PTY backend, shells, theme-response; tests p7-1-*) | TerminalView + transport/store/observer (wired via `lib/server-api.ts` and `/api/terminal/ws`); **but web RuntimeAPIs `terminal` seam is a throwing stub** (createWebAPIs.ts:8–17) while direct lib uses the real routes | Implemented both sides |
| Files/editor | `routes/fs.ts`, `fs-read.ts`, `fs-write.ts` (+tests p6-1) | FilesView + FileTree + tabs + dialogs + DirectData `/api/fs/*` (lib/files/api.ts:14–79) | Implemented |
| Diff | `routes/git-diff.ts` (+p6-2 tests) | DiffView + diff model (lib/git/diff-model.ts) | Implemented (the diff renderer is a custom DiffView, not Pierre parity) |
| Git/co | `routes/git.ts`, `git-worktrees.ts`, `git-diff.ts` (+p6-3b) | GitView + WorktreesView + git store; server-api worktree calls (server-api.ts:55–86) | Implemented subset of W-49/50/51 |
| Plans/review/comments/comments | none (no plan persistence routes; PlanView loads/`save-queue` files only) | PlanView.tsx + lib/plan/save-queue.ts + inline comments lib | Half: UI scaffolding, no server persistence, no walkthrough |
| Auth/relay/tunnels/pairing | Full implementations + heavy test suites (lib/auth/*, lib/relay/*, lib/tunnels/*; routes: auth, client-auth, relay, tunnel) | SessionAuthGate + passkeys + pairing dialog + relay client libs (`lib/relay/*`) | Implemented, mostly unwired into daily flows (UI tabs don't expose most of it; pairing dialog exists) |
| Message queue | `queue/*` runtime + routes registered before the harness proxy (app.ts:211) — bootstrapped at startup (index.ts:63, 84–90) | **No UI client at all** (grep: no `/api/openchamber|notnative|queue` consumers in UI lib) | Server yes, UI no |
| Goals | `goals/goal-payload.ts` + `goal-state.ts` + `goal-metadata.ts` (+p9-2a tests) — **but no routes module registers goal endpoints** (absent from registerApiSurfaces) | no UI | Core logic exists, routes + UI missing |
| Scheduled tasks | none (no directory) | none | Unimplemented |
| Settings system | `lib/settings-store.ts` (preferences.json, registry-gated), `settings-registry.json`, `settings-gate.ts`; routes in routes/projects.ts:48+; `/api/notnative/settings` (routes/notnative.ts:28–41) | Full settings window + 6 pages + registries + appearance appliers + search (components/settings/*) | Implemented above-v1 (registry-gated server + UI) |
| Theme system | n/a (client-owned) | lib/theme/* 38 presets + custom + generator + storage; ThemeProvider | Implemented (not yet surfaced via settings pages parity) |
| i18n / shortcuts | n/a | lib/i18n (en only + loader), lib/shortcuts registry+dispatcher+recorder, ShellShortcuts | Implemented |
| Knowledge/memory/skills/MCP | none (UI probes `/skill` against the harness only) | none | Unimplemented (harness `/skill` returns [] in mock) |
| Session-sidecar (folders) | `routes/session-folders.ts` registered (app.ts:225) | no UI consumer | Server yes, UI no |
| Goals/queue events | control bus `/api/notnative/events` publishes `notnative:*` frames (routes/notnative.ts:71–83; lib/bus.ts) | control stream subscribed into the engine (app-engine.ts:51–54) | Pipe exists; event vocabulary beyond `eventStreamReady` minimal |
| Notifications | none beyond update-check stub | in-page Notification API (createWebAPIs.ts:58–73) + work-status toasts | Minimal |
| Updater | `/api/notnative/update-check` stub + unsupported install (routes/notnative.ts:62–65; 87) | update surfaces pending P12 | Stub |
| Electron shell | n/a | main.mjs v1 (boot, IPC `desktop_open_external`/`desktop_get_boot_info`, splash, guards); NO tray/menus/deep links/updater/SSH/Mini Chat (main.mjs:359–373) | v1 subset of W-73..84 |

### 2.5 Implemented-but-unwired inventory (quick wins later)

- `persistLastActiveSession` (persist-cache.ts:154–171) — never called; boot
  restore intentionally deferred.
- Message-queue routes (p9-1 suites) + runtime pod — no UI store (doc 12 §D.6
  defines the projection store to build).
- Session-goal payload/state/metadata modules (p9-2a suites) — no routes
  assembly, no UI; doc 12 §B is the contract.
- Relay host + tunnel planes + client-auth/pairing are fully server-tested;
  the UI only has the pair of dialogs (components/pairing/*) and relay client
  libs — no settings pages, no host switcher, no tunnel surfaces (doc 08 §6
  UX to build).
- `createWebAPIs` seams: `terminal` stub vs the real direct lib paths;
  `git`/`files` RuntimeAPIs throw ("not wired in the P0 web shell yet") while
  the views use their own fetch libs — an inconsistency SLICE-A must not
  touch but later slices should reconcile.
- Mock `/api` surfaces the UI probes explicitly say "arrives with the
  server-side PTY/NNA" (e.g. shell echoes) — candidates to swap when the NNA
  adapter lands.

