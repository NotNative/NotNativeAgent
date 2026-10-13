# Notes — Doc 01 · Architecture & App Shell

> **Historical implementation note — 2026-10-01:** Retained for contracts and dated evidence.
> Current scope, ownership, remaining work, and acceptance are defined by
> [PLAN](../PLAN.md) and the [execution audit](../EXECUTION/01-architecture-audit.md).
> Old mock-only, auto-accept, lifecycle, and deferral instructions are superseded.
> A recorded test pass is limited to its stated version and surface.


Status: **read in full**. Implementation slice: monorepo scaffold + boot pipeline +
MainLayout skeleton. Deferred-by-design items listed at bottom.

## Topology (adopted)

```
Shared UI (@notnative/ui, source-consumed)
  ▲ __NOTNATIVE_RUNTIME_APIS__ (per-entrypoint injection)
  │
web/PWA entry (@notnative/web) ──► server (same package, Node+Hono)
  │  serves HTML entries, /api/notnative/* (own), /api/fs,/api/git,/api/vcs,
  │  /api/notnative/events (SSE control), /auth/*, /health
  ─ /api/* proxy ──► HARNESS (NNA later; mock now)
```
- UI never addresses the harness directly; harness rides the same origin under `/api`.
- Two UI paths: (1) RuntimeAPIs → runtimeFetch → server-owned routes;
  (2) harness SDK facade → runtimeFetch → server → harness proxy.

## Window globals (who-am-I contract) — NND names

| Global | Meaning |
|---|---|
| `__NOTNATIVE_API_BASE_URL__` | absolute server base; rewritten on endpoint switch |
| `__NOTNATIVE_CLIENT_TOKEN__` | bearer token (local pages only) |
| `__NOTNATIVE_RUNTIME_HEADERS__` | extra headers (never Authorization) |
| `__NOTNATIVE_LOCAL_ORIGIN__` | loopback origin of local server |
| `__NOTNATIVE_RELAY_HOST_ID__` | saved desktop host id (P12) |
| `__NOTNATIVE_SURFACE__` | `desktop|mobile` stamp, once |
| `__NOTNATIVE_RUNTIME_APIS__` | RuntimeAPIs object |
| `__NOTNATIVE_ELECTRON__` | `{runtime:'electron',arch,trayEnabled}` (P12) |
| `__NOTNATIVE_PLATFORM__`, `__NOTNATIVE_MACOS_MAJOR__`, `__NOTNATIVE_HOME__` | P12 |
| `__NOTNATIVE_DESKTOP_BOOT_OUTCOME__` | validated boot JSON (P12) |
| PWA helpers + startup-trace globals | web-only |

Read-only contextBridge values: switching writes through try/catch; in-memory state
stays authoritative.

## Channel inventory (adopted, renamed)

- `notnative:runtime-endpoint-will-change` / `-changed` (CustomEvent, detail
  `{apiBaseUrl,previousApiBaseUrl,runtimeKey,previousRuntimeKey}`)
- `notnative:app-ready` + `window.__notnativeAppReady=true` on first
  `isInitialized && !isSwitchingDirectory`
- `notnative:open-session` `{sessionId,directory?}`; `notnative:open-draft-session`
  `{directory?,projectId?}`; `notnative:open-mini-chat` (P12)
- `notnative:theme-hmr` (dev)
- SSE control `/api/notnative/events`: `event-stream-ready` first; heartbeat 45 s;
  reconnect backoff cap 30 s (consumption rules doc 04)

## RuntimeAPIs (instance adapter contract)

Required: `runtime`, `terminal`, `git`, `files`, `settings`, `permissions`,
`notifications`, `tools`. Optional: `github`, `linear`, `push`, `diagnostics`,
`clientAuth`, `editor`, `vscode`, `worktrees`.
- `settings.load(): {settings, source:'desktop'|'web'}`; `save(changes)`
- Web impl = `createWebAPIs` over HTTP; terminal event union
  (`snapshot|data|exit|reconnecting`) with exact fields (doc 01 §3.4; PTY semantics doc 07).
- Registry: `registerRuntimeAPIs(apis)` before app render; classification helpers
  `isDesktopShell/isVSCodeRuntime/isMobileSurfaceRuntime/isWebRuntime/getClientPlatform`.

## Harness ports surfaced by doc 01 (full catalog in doc 02)

- HP-1 base path `/api` (never elsewhere); `DEFAULT_BASE_URL = VITE_NNA_URL || '/api'`
- HP-2 SDK unwrap convention `{data,error[,response.status]}`; error strings
  `<operation> failed (<status>): <message>` / `… failed: empty response`
- HP-3 30 s GET timeout; POST + `/event` bypass
- HP-4 single current directory (normalized: `/` separators, drive uppercased, trimmed);
  scoped clients per directory; mismatch guard throws
  `Message was not sent because the runtime changed.`
- HP-5 health probe 4 s; checkConnection ≤5 attempts, sleep 400·attempt; phases
  `connected|reconnecting|connecting`; reasons `health_check_failed|health_check_unhealthy|health_probe_unhealthy|init_error`
- HP-6 GET coalescing allowlist `/api/(config|path|app/agents|agent|project|command)`;
  clone-per-caller; map entry dropped at settle
- HP-8 URL-token flow: `POST /auth/url-token → {token,expiresAt}`; append
  `?nn_url_token=`; proactive refresh at `expiresAt−10s−5s`; generation bump invalidates
- HP-9 `/health` → `planModeExperimentalEnabled` (keep field name)
- HP-10 auth endpoints `/auth/session`, `/auth/url-token`, login family;
  401/403 = auth required (never "offline")

## Boot order (web/PWA canonical)

1. HTML prelude: keyboard-mode attr → manifest link → theme before paint
   (`localStorage['notnative.themeMode']`) → splash render → 10 s fallback fade
   (non-desktop only) → `window.process={env:{}}` → main.tsx
2. main: resolve+stamp surface → embedded bootstrap (skip until P12) →
   createConfiguredWebAPIs (endpoint init, tokens, fetch bridge) → viewport watcher
   (800 ms debounce full reload) → render desktop tree (mobile deferred)
3. Provider tree: `I18nProvider > ThemeSystemProvider > ThemeProvider >
   SessionAuthGate > App`
4. App: register APIs; router; `/health`; `initializeApp()` (retry 10× 1 s→16 s cap →
   manual recovery screen); providers/agents recovery poll 2 s ×15 while connected &
   empty; effects (§10.6 polls); app-ready event; tree
   `ErrorBoundary > SyncProvider(key=epoch) > RuntimeAPIProvider > … > MainLayout +
   Toaster + dialogs`; error toasts auto-clear 5 s
5. Splash gates: non-desktop dismiss needs `isInitialized` (5 s App fallback, 10 s HTML);
   fade 300 ms after ≥150 ms grace

## Auth gate

`GET /auth/session` (4 retries × 1.5 s on transient; 200/401/429 definitive); full-screen
unlock; password login; trust-device persist `notnative.uiAuth.trustDevice`; passkeys
(08); expiry banner via runtimeFetch classifier + focus recheck.

## PWA shell contracts (web-owned; implemented in P0-lite, finished at P4/P11)

- Manifest built client-side: endpoint-first `GET /manifest.webmanifest?appName=&orientation=`
  (1500 ms abort, content-type check) else Blob fallback; name persisted
  `notnative.pwaName` (64 chars), shortcuts = Appearance + up to 3 recent sessions
  (`notnative.pwaRecentSessions`).
- Install prompt: `beforeinstallprompt` prevent + Infinity toast, once/session
  (`sessionStorage pwa-install-toast-shown`; dismiss persist `pwa-install-toast-dismissed`).
- Update flow: poll `/api/notnative/update-check?appType=web…` (default 1 h, clamp
  5 min…24 h), `POST update-install` (owners: electron-updater | package-manager),
  `waitForUpdateApplied` 2 s poll ≤10 min.
- Offline: lazyWithChunkRecovery (patterns → 250 ms retry → one reload/30 s/signature via
  `sessionStorage notnative:chunk-import-reload`); background-network semaphore = 3.

## Runtime endpoint switching

Keys: `local` | `host:<id>` | `url:<origin>` | sentinel `mobile-disconnected` |
`url:default` (uninitialized). Transient keys are forbidden persistence namespaces.
Switch sequence: will-change event → set in-memory + globals (try/catch) → URL resolver
→ headers/bearer (generation bump) → relay activation (P11) before token mint →
fire-and-forget refresh token → changed event → App runs
`resetAppForRuntimeEndpointChange` (exhaustive store-reset list, §11.2 — grows with each
store) + remounts `SyncProvider` under `runtimeEndpointEpoch`.
Same-instance transport change = `reconnectAppForTransportSwitch()` (no store teardown).

## URL router (query params, no lib)

`?session=<id>` · `?tab=chat|git|diff|terminal|files` (non-chat opens context surface;
main area stays chat) · `?settings=<slug>` (exclusive; aliases general/preferences→home)
· `?file=<path>` (with diff tab). Skip URL sync in vscode/embedded. popstate re-applies;
re-entrancy guard; deep links pass AppLinkConfirm + shared-command trust gates.

## MainLayout regions

CommandPalette; HelpDialog; StatusDialog; SessionDialogs; TitlebarLeftControls;
Sidebar(SessionSidebar); Header; main(ChatView + surface pages: MultiRun, ScheduledTasks,
Archive, Worktrees) + ContextPanel; ContextPanelRail; SettingsWindow (lazy, mount on
first open); Toaster; overlays (ConfigUpdateOverlay, About, AppLinkConfirm,
SharedTrustConfirm, MemoryDebug).

Context-rail registry (id·mode·icon·widthFraction): context 0.45 · git 0.4 · pr 0.45
(hidden w/o GitHub) · diff 0.6 · walkthrough 0.6 (≥768 px) · linear 0.45 (hidden w/o) ·
editor(file) 0.6 · terminal 0.6 · notes 0.6 · plan 0.45 (flag) · browser 0.45 ·
chat 0.45 (has-content). Rail order/hide persisted (`contextRailOrder`,
`contextRailHiddenSurfaces`); widths persist per directory+mode; keep-alive classes for
editor/diff/browser/terminal/chat; singletons remount.

Background polls: sessions 45 s · tray 5 s (P12) · terminal keepalive 10 min · push beacon
20 s · updates clamp(5 min…24 h) · URL-token `expiresAt−15 s` · queue reassert 2 min.

## Invariants (shell scope) — carried into code comments/tests

One origin one instance · boot gating authoritative · docs-read fail-open vs
privileged fail-closed (`COMMANDS_SAFE_FOR_REMOTE` list, P12) · URL-token never clears
in use · coalescing never invents data · instance switch leak-free (reset list) ·
transient keys forbidden · surface stamped once (drift = reload) · embedded identity
survives · recovery always reachable · chunk failure recovers once/30 s · credentials
never in iframe URLs · splash text never black-box.

## Deferred from doc 01 (tracked)

- Electron/Mini Chat/embedded-iframe/VS Code/Capacitor boot branches (P12 / long-term)
- Relay restore + desktop host store (P11/P12)
- Push registration, Web Push, VAPID (P4+), GitHub/Linear bindings (P3/P4)
- Service worker registration + update flow endpoints (server routes land P4; UI wiring
  now, endpoints stubbed)
- PWA manifest endpoint server-side (P4); fallback manifest works from P0
