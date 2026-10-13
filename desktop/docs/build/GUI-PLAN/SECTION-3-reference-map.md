# GUI-PLAN — Section 3: Reference map (OpenChamber → NotNativeDesktop)

> **Historical record — superseded 2026-10-01:** This snapshot or slice order is not current execution authority.
> Use [PLAN](../PLAN.md) and [EXECUTION](../EXECUTION/01-architecture-audit.md).
> Existing references are traceability only; do not copy or transplant upstream code.
> Revalidate cited paths and native behavior before reusing historical evidence.


`OC:` = `D:\ProjectRepo\External\openchamber` (READ-ONLY). Everything below
was verified by listing/reading the reference checkout (paths exist as cited).
The docs already carry `(src: …)` citations for deeper line-level contract
passages; this section maps each wanted capability (W-ids from Section 1) to
the concrete port target.

## 3.0 Reference package layout (verified)

- Root `package.json`: OpenChamber ≤1.23.0, Bun workspace, react 19,
  tailwind 4, `@opencode-ai/sdk@1.18.30`, express 5, CodeMirror 6, node-pty /
  bun-pty, `@base-ui/react` primitives, cmdk, sonner, react-markdown,
  `@octokit/rest`, simple-git, zod 4, `@tanstack/virtual-core` (patched),
  @heroui scroll-shadow; workspaces `packages/{ui,web,electron,mobile,vscode,docs}`.
- `packages/web`: `server/index.js` + `server/lib/**` (42 module dirs, plain
  JS/Express) and Vue-free React web entries (`src/main.tsx`,
  `mini-chat-main.tsx`, `mobile-main.tsx`, `src/sw.ts`), 3 HTML entries
  (index/mini-chat/mobile).
- `packages/ui/src`: the shared app. Top dirs: `apps`, `assets`, `components`,
  `contexts`, `hooks`, `lib`, `stores`, `styles`, `sync`, `types`.
  Server-agnostic SDK wrapper: `lib/opencode/client.ts`; transport seams:
  `lib/runtime-fetch.ts`, `lib/runtime-url.ts`, `lib/runtime-auth.ts`,
  `lib/runtime-switch.ts`, `lib/api/types.ts` (RuntimeAPIs) +
  `contexts/RuntimeAPIProvider.tsx` (verified via
  `.agents/skills/ui-api-decoupling/references/implementation-map.md`).
- Teleporting note: OC's server is Express + plain JS; NND's is Hono + TS —
  the port is a shape-preserving translation (route families and module
  boundaries 1:1, middleware order per docs/planning/03 §2 + Appendix A).
  The UI side is the same stack we shipped (React/Tailwind/zustand); reference component paths identify behavior only.
  Implement independently against NNA contracts; never transplant upstream components.

## 3.1 App shell, auth gate, boot (W-01…W-11, W-64, W-72)

| Want | OC reference | Port |
|---|---|---|
| Shared app tree + renderMainApp + boot steps (W-01/02) | `OC packages/ui/src/App.tsx`, `packages/ui/src/main.tsx` | We already ported the shape (`packages/ui/src/App.tsx`, `components/MainLayout.tsx`). Continue: move region tree from ⧉v1 header toward §13.1/§13.2 (ContextPanel, rail, surface pages) |
| MainLayout region tree + surfaces registry (W-05/06) | `OC packages/ui/src/components/layout/*` (Header, ContextPanel, rail), `OC stores/useUIStore.ts` (contextPanel, contextRailOrder, hidden surfaces, widths) | Port layout components + the useUIStore fields (contextPanel/scrollbars/sidebar/telemetry fiches) |
| Session auth gate incl. passkey faces (W-04, W-64) | `OC packages/ui/src/components/auth/*`, server `OC packages/web/server/lib/ui-auth/{ui-auth.js,ui-passkeys.js}`, `OC lib/auth/…` flows in docs 08 §2/§6.6 | Gate already ported; keep parity tests (`ui-auth.test.js`) re-expressed as NND hono tests (`packages/web/src/server/lib/auth/*` already exists) |
| PWA install/update + manifest + sw (W-03, W-38) | `OC packages/web/src/sw.ts`, `src/runtimeConfig.ts`, `server/lib/opencode/pwa-manifest-routes.js` | NND has `/manifest.webmanifest` (routes/notnative.ts:94–120) but no service worker runtime — port sw + update prompt store (`OC stores/useUpdateStore.ts`) in SLICE-F |
| Mini Chat + embedded iframes (W-11) | `OC packages/web/mini-chat.html` + `src/mini-chat-main.tsx`; `OC components/mini-chat/*`; `ui/src/components/chat/*` iframe chat tabs (doc 01 §8) | Later; Electron Mini Chat is doc-09 §4.6 (deferred) |
| Runtime enable/instance switching (W-08, W-72) | `OC lib/runtime-switch.ts`, `OC lib/runtime-url.ts`, `OC lib/runtime-auth.ts`, `OC stores/useProjectsStore.ts`; host switcher UI `OC components/desktop/*` + `OC stores/useDesktopSshStore.ts` | Our `lib/runtime-*` set exists and is tested; UI switcher/host cards and desktopSsh wiring remain |

## 3.2 Chat, session list, status (W-12…W-27)

| Want | OC reference (verified paths) | Port |
|---|---|---|
| Part renderer catalog (W-17) | `OC packages/ui/src/components/chat/message/parts/*`: `AssistantTextPart.tsx`, `ReasoningPart.tsx`, `ToolPart.tsx`, `ToolPartDiffPreview.tsx`, `PlainDiffFallback.tsx`, `JsonSummaryView.tsx`, `GeneratedJsonResultCard.tsx`, `UserTextPart.tsx`, `UserContextPart.tsx`, `taskToolModel.ts`, `toolOutput.ts`, `toolRenderUtils.ts`, `workingPlaceholder/BusyDots/ProgressiveGroup` | Highest-value transplant under chat; pairs with `OC components/chat/message/*` rows. Our `chat/transcript.tsx` + `turns.ts` are the v1 substitutes to grow into |
| Markdown pipeline (W-17) | `OC components/chat/markdown/*` (sanitized react-markdown pipeline; virtualized `VirtualizedCodeBlock.tsx` lives in parts) | Port behind our transcript; keep our sanitizer policy |
| Composer (W-15/16) | `OC components/chat/composer/{editor,language,state,submit,attachments,ui}/*` + `keyboardPolicy.ts`, `largeTextPaste*.ts`; submit assembly per doc 05 §B.9 | Port module-by-module; our v1: `chat/composer.tsx`, `composer-bits.tsx`, `send-planner.ts`, `keyboard-policy.ts`, `drafts.ts`, `input-history.ts` already mirror several seams — extend, don't restart |
| Session sidebar product (W-18/24) | `OC components/session/sidebar/{sessions,projects,folders,recent,shell,list}/*`, `OC components/session/* dialogs`, `OC stores/{useSessionDisplayStore,useSessionFoldersStore,useSessionPinnedStore,useSessionTabsStore,useSessionMultiSelectStore}.ts` | Port after data model (folders/pins server routes exist in doc 03 §5.22/or NND session-folders route is present but the folders model rides useSessionFoldersStore + server persistence) |
| Status chip / recap / suggestion (W-19) | `OC components/chat/work-status/{...}` (the workstatus panel); recap/suggestion generation server-side `OC packages/web/server/lib/session-assist/{context.js,prompt.js,runtime.js}` | Port UI with the literal label strings (05 §E), wire to `/api/notnative/events` control surfaces (same SSE pipe exists) |
| Question/permission UX (W-20) | `OC components/chat/message/index` (cards), `OC stores/permissionStore.ts` (+ auto-accept runtime on server `OC lib/permission-auto-accept/*`) and ask/reply flow in doc 05 §F | Our reducer handles v1/v2 asks (sync Rust engine); port the card UI + `permissionStore.ts` and the auto-accept settings page (14 §G.8) |
| Usage/quota UI (W-21) | `OC components/usage/*`, `OC stores/useQuotaStore.ts`; server `OC packages/web/server/lib/quota/**` (claude/google providers, credentials) | Later slice; note OC provider impls are a BONUS over docs (W-21 cites 02 §7.3/05 §G only) |
| Command palette (W-22) | `cmdk`-based `OC components/layout/*` (CommandPalette) + `OC stores/useCommandsStore.ts` | Port together with shortcuts registry (ours exists) |
| Input history/snippets/magic prompts/starters (W-22, W-112) | `OC stores/{useInputHistoryStore,useSnippetsStore,useMagicPromptsStore}.ts`; server `OC lib/magic-prompts/{routes.js,runtime.js}` + `OC lib/opencode/snippets.js` | Our input-history + starters exist; snippets/magic prompts are server-route-only today — port both sides in SLICE-C/D |
| Timeline dialog + prompt rail (W-23) | `OC ui/src/components/chat/...` TimelineDialog (`chat/components/*`) + PromptNavigatorRail; our staggered `chat/timeline-dialog.tsx` + `prompt-rail.tsx` match the seams | Extend with row actions per doc 05 §A.7 |
| BTW (W-25) | `OC components/chat/btw/*` + `OC stores/useBtwStore.ts`; server fork semantics (harness-owned) | Port panel + fork-at-last-completed-turn logic (15 §H.1) once NNA fork is real (P-16) |
| Empty/loading/error states (W-26) | doc 05 §I strings; implementation mirrors exist throughout OC views | Re-derive as we build each surface (the docs own copy regimes) |
| Virtualized timeline + history paging (W-27) | `@tanstack/virtual-core` patched bun-patch + `OC chat/*` virtualizer usage (05 §J#3) | Port the virtual core patch (root-level decision: keep patch or adopt @heroui list patch per `bun-patches/`) |

## 3.3 Sync & state engine (W-28…W-37)

NND's engine is already a faithful port of doc 04 (two scopes, event catalog,
bootstrap phases, recovery/materialization, persistence) — see SECTION-2 §2.1.
Reference cross-check points if we need to extend:
`OC packages/ui/src/sync/**` (the doc-04 code), `OC stores/globalSessions.ts` +
`globalSessionStructure.ts` (hierarchy model), `OC stores/globalSessions.test.ts`.
Streaming representation is exactly where W-35's part-text pipeline lives:
`OC sync/*` + `OC components/chat/message/parts/assistantTextVisibility.ts`.

## 3.4 Server & API + harness seam (W-38…W-45)

| Want | OC reference | Port |
|---|---|---|
| Route families (W-39) | `OC packages/web/server/lib/opencode/{core-routes.js,feature-routes-runtime.js,routes.js,config-entity-routes.js,plugin-routes.js,skill-routes.js,openchamber-routes.js,providers.js,project-icon-routes.js,pwa-manifest-routes.js,tunnel-auth.js}`; git: `OC lib/git/**`; fs: `OC lib/fs/**`; projects: `OC lib/projects/**`; github: `OC lib/github/**` (22 routes) + `OC lib/github/repo/*`; linear: `OC lib/linear/**`; notifications: `OC lib/notifications/**` (routes.js, template-runtime.js, push/pdn/apns runtimes) | Route-table per doc 03 §5 — NND has already stood up fs/fs-read/write, git (+diff, worktrees), settings, projects, session-folders, queue, terminal, relay, tunnels, auth/client-auth. Remaining families (W-114/115, github/linear, tts/summarize, dev-servers, walkthrough, browser-control, knowledge/skills, magic promps) map to these dirs |
| Proxy seam + event stream (W-40) | `OC lib/opencode/proxy.js` (+ `packages/web/opencode-proxy.test.js`), `OC lib/event-stream/{index.js,global-hub.js,upstream-reader.js,protocol.js,directory-ws-bridge.js,global-ws-bridge.js,runtime.js}` | NND seam: harness proxy via adapter (app.ts:126–140) + SSE `/api/event` from mock events.ts — the NNA adapter must implement the same upstream-reader/heartbeat/backpressure semantics (03 §4.4, 02 §5) |
| Auth plumbing (W-64) | `OC server/lib/ui-auth/ui-auth.js`, `OC lib/opencode/tunnel-auth.js`, `OC lib/client-auth/*`, `OC lib/security/*` | Already ported + tested (p8-* suites); continue UI-touching flows (W-72) |
| Managed harness lifecycle (W-40/45) | `OC lib/opencode/{lifecycle.js,closer/shutdown-runtime.js,cli-entry-runtime.js,network-runtime.js,env-config.js,env-runtime.js,project-directory-runtime.js,managed-process-registry.js,claude-cli-auth.js}` | The port for NNA: spawn/attach/restart/upgrade + env merge order (doc 02 LF-1…LF-19); sit behind `packages/web/src/server/harness/nna.ts` |
| CLI (W-42) | `OC packages/web/bin/**` (+ `OC lib/opencode/cli-options.js`, server-startup-runtime.js, startup-service natives) | Ours: `packages/web/src/cli/*` exists (args/bin/instances/main/output/connect-url) — extend with the doc-03 §10/§23 commands (schedule/session/models/projects/update) |
| Disk layout/strict readers (W-43) | `OC server/lib/{data-dir-migration.js,package-manager.js,inherited-env.js,network-defaults.js,path-realpath-cache.js}`, `OC lib/opencode/settings-{runtime.js,helpers.js,files.js,normalization-runtime.js}` + `settings-registry.json` | NND preferences-store strict-reader gate already exists (lib/settings-store.ts, settings-gate.ts); mirror migrations in slots (§2.5) |
| Dev server boot constraints | `OC server/lib/opencode/proxy-headers.js` (+ test) | Keep as the header-fidelity reference for the proxy envelope |

## 3.5 Code review surfaces (W-46…W-55)

Verified view files (OC `packages/ui/src/components/views/`): `FilesView.tsx`,
`DiffView.tsx`, `PierreDiffViewer.tsx`, `GitView.tsx`, `WorktreesView.tsx`,
`PlanView.tsx`, `PullRequestView.tsx`, `LinearIssuesView.tsx`, `ArchiveView.tsx`,
`GoToLineDialog.tsx`, `PreviewToggleButton.tsx`, plus helpers
`fileContentPoller.ts`, `fileEditorContent.ts`, `fileStatChange.ts`,
`diffScrollAnchor.ts`, `branchDiffScope.ts`, `useFileViewVirtualizer.ts`;
tree machinery `views/files/directoryRequests.ts` + `fileTreeStatus.ts`;
git logic `views/git/*` (ChangesPanel/changesTree/ChangeRow,
BranchComparisonSelector, BranchIntegrationSection, CommitComparisonSelector,
AIHighlightsBox, baseBranch). Stores: `useFilesViewTabsStore.ts`,
`useGitStore.ts`, `useGitBaseBranchStore.ts`, `useFileSearchStore.ts`,
`useInlineCommentDraftStore.ts`, `useCommitSelectionStore.ts`,
`usePrContextStore.ts`, `usePullRequestSelectionStore.ts`,
`useGitIdentitiesStore.ts`, `useGitHubAuthStore.ts`/`useGitHubPrStatusStore.ts`,
`useLinearAuthStore.ts`, `useWorktreeOrderStore.ts`.

| Want | What to port |
|---|---|
| W-46 FilesView tree/tabs/dialogs | `views/files/*` + `useFilesViewTabsStore` + row menus/dialog components `components/projects/*` (dialogs) |
| W-47 Editor (CodeMirror config, autosave, edit-conflict poll) | `FilesView.tsx` editor config (doc 06 §3.1) + `fileContentPoller/fileEditorContent/fileStatChange` + GoToLine |
| W-48 Preview panes | OC FilesView preview-switch internals + `fragment files (06 §4)`; diashow/drawio stuff is `components/diagram/*` |
| W-49 Diff system | `PierreDiffViewer.tsx` is OC's render tech (doc says replaceable — our `diff/DiffView.tsx` + `lib/git/diff-model.ts` is already a substitute; port the surrounding scope/stack/hunk machinery instead: `DiffView.tsx`, `diffPatchUtils.ts`, `MultiFileDiffEntry`, hunk actions portals) |
| W-50 GitView | `GitView.tsx` + `views/git/*` + `useGitStore` (reconcile/optimistic index queue semantics ported to `lib/git/store.ts`) |
| W-51 Worktrees | `WorktreesView.tsx` + `useWorktreeOrderStore` + server part already present (`routes/git-worktrees.ts`, p6-3b tests) |
| W-52 PlanView + walkthrough step nav | `PlanView.tsx` + plan save queue (ours exists: lib/plan/save-queue.ts) + walkthrough stepping from doc 13 §G.8 (needs 13 pipeline, Slice G) |
| W-53 PullRequest/Linear | `PullRequestView.tsx`, `PullRequestSection` (doc 06 §9.2 src cite), `LinearIssuesView.tsx`; server `OC lib/github/**`, `OC lib/linear/**` |
| W-54 Inline comments + review flow | `components/comments/*` (ours exists as scaffolding v1), `useInlineCommentDraftStore`, `lib/addSelectionToChat` (ours: lib/add-selection-to-chat.ts), review flow `lib reviewFlow.ts` (auto-review loop protocol max-15/loop-marker) + server `OC lib/auto-review? → openchamber-control` docs (06 §10.6) |
| W-55 Invalidation tables | doc 06 §11; enforcement points are in the stores above |

## 3.6 Terminal (W-56…W-63)

- Server: `OC packages/web/server/lib/terminal/{runtime.js,history.js,shells.js,terminal-ws-protocol.js,theme-response.js}` — NND's
  `packages/web/src/server/terminal/*` is the ported equivalent with tests
  (p7-1-*). Re-verify only the ConPTY bugfix-derived behaviors (07 §4.3).
- Renderer: OC vendors the ghostty/libghostty wasm trampoline under
  `OC packages/ui` (doc 07 §5 "ABI notes you must replicate"). Our
  `lib/terminal/{transport,store,observer,wire}` + `TerminalView` follow the
  contract; the renderer lib itself is the piece to pull when SLICE-B signs
  off input matrices (07 §5 references the vendored artifact).
- Electron terminal = same suite over loopback (07 §11#14) — our RuntimeAPIs
  `terminal` stub vs the direct lib path must reconcile (SECTION-2 §2.5).
- Project actions (W-61): action-terminal orchestration lives in OC's
  `components/projects/*` + terminal session purposes (07 §8); our
  server-api.ts already has create/restart/force-kill/touch +
  shells/sessions routes.

## 3.7 Remote access UI (W-65…W-72)

- Server semantically ported already: NND `lib/relay/*` (host-broker,
  dispatcher, crypto, identity...), `lib/tunnels/*`, `lib/auth/*` + heavy
  p8 suites. Reference files if transplanting logic:
  `OC server/lib/relay/{e2ee.js,host-client.js,tunnel-host.js,downstream-scheduler.js,identity.js,signing-key.js,tunnel-codec.js,service.js,host-lock.js}`,
  `OC server/lib/tunnels/{providers/,cloudflare…}` (root files
  cloudflare-tunnel.js/ngrok-tunnel.js), `OC lib/client-auth/{remote-clients.js, pairing.js}`.
- UI surfaces to BUILD (doc 08 §6): pairing dialog exists in NND
  (`components/pairing/*`); port the rest from
  `OC components/sections/remote-instances/*`, `OC components/desktop/*`
  (host switcher), `OC components/settings` tunnel section (14 §G.8),
  `OC stores/useDesktopSshStore.ts` + SSH UI components (desktop), candidate
  refresh (`OC lib/relay` client side + `OC stores/useAppLinkTrustStore.ts`).
- SSH machines (W-68): OC electron package owns the manager
  (`OC packages/electron/**` per doc 09 §8) — ours defers (no ssh in
  main.mjs).

## 3.8 Electron shell + OS (W-73…W-84)

- OC main processes: `OC packages/electron/**` (main process + runtime
  modules, per doc 09). Our `packages/electron/main.mjs` implements only the
  v1 subset (boot/port/splash/IPC-2-commands/guards, main.mjs:359–373).
  Port targets in OC for the rest of the catalog: window model & Mini Chat
  (§4), deep links (§5), embedded browser panel (§7), SSH manager (§8),
  updater (§9), tray/menus/notifications (§10), renderer recovery + file
  utilities (§12), packaging (§14, electron-builder `build` config + ensure-
  electron script). Decision: prefer port-by-contract from doc 09 sections;
  open OC files per feature only to verify IPC shapes/security gates.
- Notifications parity: OC `components/usage`/tray store hook `stores` sync
  (09 §13.8) — pull `OC stores/useUpdateStore.ts` + `OC components/update/*`.

## 3.9 Autonomy (W-85…W-90)

- Server goal runtime: `OC packages/web/server/lib/session-goal/{create.js,routes.js,runtime.js,objectives.js}` — port verbatim
  semantics to NND `server/goals/*` (payload/state/metadata already exist
  here; missing routes + the small-model exchange + event wiring).
- Scheduled tasks: `OC server/lib/scheduled-tasks/{routes.js,runtime.js,service.js,loops.js}` (+ cron eval semantics per doc 12 §C.2 uses
  a JS cron lib; NND must pick the equivalent), JSON per-project config =
  `OC lib/projects/**` config-entity behavior.
- Message queue: `OC server/lib/message-queue/runtime.js` (canonical item
  schema, delivery loop, holds) — NND `server/queue/*` already implements
  the p9-1 surface; reconcile names with doc 12 §D.
- Multi-run: `OC stores/useMultiRunStore.ts` +
  `OC components/multirun/{MultiRunLauncher.tsx, MultiRunFusionDialog.tsx}` (doc 12 §E) + `OC lib/multirun/title.ts`
  + agent manager view `OC components/views/agent-manager/{AgentManagerView,AgentGroupDetail,AgentManagerSidebar}.tsx` +
  `OC stores/useAgentGroupsStore.ts`. Magic-prompt-backed fusion: server
  `OC lib/magic-prompts/*` + settings `OC components/sections/magic-prompts/*`.
- Orchestration service: `OC server/lib/openchamber-sessions/routes.js`
  (create/send/fork/archive flows, doc 12 §F.1).

## 3.10 Preview & inspection + walkthrough (W-91…W-97)

- Dev-servers: `OC server/lib/dev-servers/{parse.js,routes.js}`.
- Browser control + capture: `OC server/lib/browser-control/{broker.js,routes.js}`,
  `OC server/lib/openchamber-control/{service.js,actions.js,routes.js,screenshots.js}`,
  agent tool `OC server/lib/agent-tool/runtime.js` (the injected
  `openchamber_web` equivalent; doc 13 §D).
- Walkthrough server pipeline: `OC server/lib/walkthrough/**` (hunks.js,
  digest.js, sources.js, prompt.js, schema.js, model-settings.js, store.js,
  jobs, routes.js, pull-request.js, generated.js, languages.js).
- Client side: `OC stores/useWalkthroughStore.ts` +
  `OC components/views/walkthrough/{WalkthroughView.tsx,...}` + `OC lib/walkthrough/**` (doc 13 §G).
- Preview transports: iframe client `OC components/browser/*` + electron
  webview half (doc 13 §E via OC packages/electron), dev-tunnel host
  `OC server/lib/dev-tunnel/*` (+ tests), relay branch in electron MessagePort
  (09 §3.3).
- Fireworks canvass: `OC components/...` per doc 13 §I (`useFireworks`).

## 3.11 Theme/settings/i18n/shortcuts (W-98…W-105)

- Tokens/design: `OC packages/ui/src/styles/design-system.css` (B.1-B.2) +
  tailwind `@theme inline`; typography `OC lib/typography.ts`, font loading
  `OC lib/fontOptions.ts` + `lib/fontLoader.ts`; our
  `styles/design-system.css` + classes are the v1 port.
- Primitives: `OC packages/ui/src/components/ui/**` (verified dir; story
  per doc 14 §C). Ours: `components/settings/primitives.tsx` v1 subset.
- Icons: `OC components/icon/*` + `scripts/generate-icon-sprite.mjs` +
  file-type sprite script + assets (`OC packages/ui/src/assets/icons/file-types/`).
- Theme system: `OC contexts/ThemeSystemContext.tsx`, `OC lib/theme/**`
  (presets/themes/custom/theme generator; our `lib/theme/*` already
  mirrors it incl. 38 presets — surfaced in the appearance settings).
- Settings engine + snapshot gate: `OC lib/settings/**` (registry + parsers +
  persistence), server gate `OC lib/opencode/settings-runtime.js` +
  ds example `settings-registry.json`; ours:
  `lib/settings/*` + `server/lib/settings-{store,gate}.ts` +
  `server/lib/settings-registry.json` (registry snapshot in
  `packages/electron/dist-server/settings-registry.json` copy — packaging
  must keep it adjacent to the bundle, elseif boot-ENOENT (observed in
  main.log 04:32:03)).
- Pages: `OC components/sections/{agents,behavior,commands,git-identities,integrations,magic-prompts,mcp,openchamber,plugins,projects,providers,remote-instances,shared,skills,snippets,usage}/*`; ours has 6 pages
  (general/appearance/chat/sessions/notifications/shortcuts).
- i18n: `OC lib/i18n/**` (12 locales; our i18n has en + loader scaffolding).
- Shortcuts: `OC lib/shortcuts/**` + settings recorder
  (`OC components/settings/...` recorder; ours `lib/shortcuts/{recorder,registry,dispatcher}` exist with tests).

## 3.12 Knowledge/context/skills/memory (W-106…W-113)

Server (OC): `session-knowledge/{routes.js,runtime.js}`,
`project-context/{routes.js,runtime.js}`,
`agent-memory/{routes.js,runtime.js,actions.js,threat-patterns.js,feature-flag.js,project-resolution.js}`,
`skills-catalog/{scan.js,install.js,git.js,cache.js,disk-cache.js,github-meta.js,curated-sources.js,source.js}`,
`context-obligatory/runtime.js`, `session-assist/{context.js,prompt.js,runtime.js}`,
`text/summarization` (03 §6.4), `markdown-image-grants/`,
`small-model/**`, `system-prompt/**` (8.4 optimizer plugin).
UI (OC): `stores/{useAgentMemoryStore,useProjectContextStore,useSkillsStore,useSkillsCatalogStore,useMcpStore,useMcpConfigStore,useTodosPersistStore,useSnippetsStore,useMagicPromptsStore}.ts`,
`OC components/chat/composer` skill-mention autocomplete, memory panel
`components/session/project-context/*`, MCP components
`components/mcp/*`.

## 3.13 Bonus capabilities in OC NOT covered by our docs (consider adopting)

1. **Quota/Credential providers** concretely implemented for Claude + Google
   (`OC server/lib/quota/providers/{claude,google}`, `credentials/`) — our
   docs reference quota only at contract level (W-21). Wiring these gives the
   usage readouts real data on day one.
2. **`claude-cli-auth.js`** — provider onboarding via the Claude CLI's
   credential file (provider-auth UX without manual tokens).
3. **Changelog/update-notes serving** (`OC server/lib/changelog/…` +
   `scripts/changelog-beta/*`) powering an update dialog with release notes —
   pairs with W-80.
4. **npm-registry + package-manager helpers** (`OC lib/opencode/npm-registry.js`,
   `OC server/lib/package-manager.js`) — needed by any harness upgrade/inc
   install UX.
5. **Managed plugin spec/runtime** (`OC lib/opencode/{plugin-spec.js,plugins.js,managed-plugin-config.js,watcher.js}`) — server-side
   config-watch + plugin schema; bigger than doc 03 §5.9 route summary implies.
6. **`realtime-proxy.js`** (desktop bridge SSE/WS) and
   `event-stream/{directory-ws-bridge.js,global-ws-bridge.js}` WS twins for
   streams — our engine is SSE-only today; WS twins would strengthen
   reconnect coverage for the Electron runtime.
7. **serve-sim mobile dev loop + `with-mobile-env` tooling** — dev-quality
   tooling pattern worth replicating when we later stand up surfaces beyond
   the GUI.
8. **`dev-web-full.mjs` / `dev-web-hmr.mjs` orchestrations and
   `scripts/react-doctor.js` / `deslop` / knip dead-code hygiene** — cheap
   adoptables for our repo hygiene per doc 01 §15 equivalent.
9. **bun-patches** discipline (`@tanstack/virtual-core`, `bun-pty`,
   `@legendapp/list`) — port the virtual-core patch only; pty patch is
   ConPTY-specific and our node-pty path already pins 1.2.0-beta.12.
10. **Caddyfile + Dockerfile + reverse-proxy posture** (03 §9) — deploy path
    for headless use (`--api-only` equivalent in our CLI), a macro-scale
    "run NND as a server in a container" capability our docs don't spell
    out; low cost to adopt via the CLI flags we already have.

## 3.14 Deliberate deltas (our docs/architecture vs OC reference)

| Topic | OC | NND plan/delta |
|---|---|---|
| Harness | OpenCode (external binary, SDK 1.18.30 wire) | NNA behind `packages/web/src/server/harness/adapter.ts`; doc 02 owns the seam; `NOTNATIVE_HARNESS=mock|nna` (server/index.ts:21–25) |
| Server runtime | Express 5 + CommonJS-friendly plain JS | Hono + native TS (erasable) — same route families, different middleware (03 §2 map already translated in app.ts) |
| Electron shell | Full parity (deep links, tray, updater, SSH, Mini Chat) | v1 subset in main.mjs (verified); doc 09 §15 checklist is the completion gauge; default port 57123 + stored-port file (D-09-6) |
| Relay broker | Separate broker project ("inferred" per doc 08 gap note) | Same contract; NND ships host+client libs; broker remains external service to be stood up for relay UX |
| Names/branding | openchamber:// links, `openchamber_*` events/tools | `notnative://` + `notnative:*` (already in code: routes/notnative.ts; naming helper `lib/harnessNaming.ts`) |
| Data dir | `~/.openchamber` | `~/.notnative-desktop` (settings/preferences observed live; docs 03 §7) |
| Plans file location | `.opencode/plans/` harness-side | doc 06 §8.5: ours rides OUR harness config; plan resolution order must be re-pointed at `.nna/` equivalents (verify during SLICE-C) |
| Auth posture | same shape | same shape (password + passkeys + tunnel + client tokens); desktop password + trust-device + access via init script |
| VS Code / mobile | first-class OC packages | deferred (docs 10/11 are specs-only for later); the shared-UI contract (`RuntimeAPIs`) is ready to host them |

---

*Traceability: doc-section citations across this file point at
`docs/planning/*.md` heading anchors (§Collection 1). Reference paths point
at the OC checkout; use them to read the module before porting, per cleanroom
discipline (docs are the authority; sources confirm shapes).*
