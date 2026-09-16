# 01 — Architecture & App Shell (OpenChamber cleanroom reference)

> Scope of this document: the whole-system map — what OpenChamber is, how one shared
> React UI package serves web, desktop, VS Code, native mobile, and embedded surfaces;
> how every entrypoint boots; how the app shell is composed; how runtimes (UI hosts)
> and instances (servers) are selected and switched; the URL router; the PWA/update/
> offline behavior owned at shell level; and the build/dev pipeline. All HTTP route
> tables live in 03; the OpenCode SDK/harness contract lives in 02; sync/state engine
> internals live in 04; Electron/VS Code/mobile shell internals live in 09/10/11;
> theme/settings/i18n/shortcuts systems live in 14. This doc spells out every contract
> the shell needs itself; where another doc owns depth it is cited, and the local
> consequence is stated here.

Terminology used throughout:

- **Runtime** = a UI host shell: `web` (browser/PWA), `desktop` (Electron renderer),
  `vscode` (webview), `mobile` (Capacitor native), plus dedicated sub-shells (Mini Chat
  window, hosted `mobile.html`, embedded session-chat iframe). The `RuntimeAPIs.runtime`
  descriptor reports only `web | desktop | vscode`; the mobile surfaces are reached via
  a separate "hosted surface" decision (`runtimeSurface.ts`).
- **Instance** = one reachable OpenChamber server (local loopback, remote LAN, tunnel,
  or relay). One UI can talk to one instance at a time; switching instances is
  "runtime endpoint switching" (section 11).
- **Harness** = the agent backend (OpenCode in the reference implementation). Every
  requirement the shell imposes on it is tagged `[HARNESS PORT]`.

---

## 1. Product framing

OpenChamber is an open-source workspace for running and reviewing AI coding-agent work.
The product layer sits on top of an agent harness (OpenCode) and adds: session work
tracking ("Session Goals" that keep the agent working until a goal completes), multi-run
(the same prompt to up to five models, each in its own session/optional worktree),
a changes walkthrough (AI-guided tour of a diff), a live preview of the user's dev app
beside the conversation, GitHub issue→PR workflows, scheduled/recurring work, device
pairing with remote access (LAN, tunnels, SSH, end-to-end encrypted Private Relay),
and cross-device continuation (same projects and sessions from Desktop, Web/PWA, VS
Code, iOS, Android).

User-visible surfaces and their roles:

| Surface | Role | One-line behavior |
|---|---|---|
| Desktop (Electron) | Full workspace for macOS/Windows/Linux | Multiple windows, Mini Chat windows, remote hosts, SSH, native notifications, auto-update, tray |
| Web / PWA | Same workspace in a browser | Installable, push notifications, background updates |
| VS Code | Sessions beside the code | Sidebar + editor-tab webviews, right-click context actions, Agent Manager |
| iOS / Android (Capacitor) | Review and steer away from the desk | Connect to an existing OpenChamber server; APNs/FCM alerts; touch terminal |
| CLI / server package | Runs the OpenChamber server | `openchamber` CLI; can run headless (`--api-only`) for desktop clients |

Product copy anchors (kept from docs): "Start agent work, see what changed, and take it
through review and release. Your projects and sessions remain available when you switch
devices or step away." Default quickstart flow is: install OpenCode → install
`openchamber` CLI → run `openchamber --ui-password ...` → open `localhost:3000`.

(src: README.md, packages/docs/content/docs/quickstart.mdx)

---

## 2. System topology

### 2.1 ASCII diagram

```
                       ┌───────────────────────────────────────────────┐
                       │                SHARED UI (packages/ui)        │
                       │  apps/: App(desktop/main), MobileApp,         │
                       │  VSCodeApp, ElectronMiniChatApp, embedded     │
                       │  session-chat iframe                          │
                       │  lib/: RuntimeAPIs registry, runtime-fetch,   │
                       │  runtime-switch, runtime-url, runtime-auth,   │
                       │  relay tunnel client, device/platform         │
                       │  stores/ + sync/ (single source of UI state)  │
                       └──────────────┬────────────────────────────────┘
              window.__OPENCHAMBER_RUNTIME_APIS__ (instance-specific)
                                      │
        ┌─────────────────────────────┼───────────────────────────────────┐
        │ web/PWA                     │ desktop (Electron)                │ vscode / mobile
        │ browser fetch() patched by  │ same web API impl; native bits    │ VS Code: bridge messages
        │ installRuntimeFetchBridge   │ via __OPENCHAMBER_DESKTOP__ IPC    │ (postMessage to host)
        │                             │                                    │ mobile: direct HTTP from
        │                             │                                    │ app origin + push tokens
        └──────────────┬──────────────┴───────────────┬────────────────────┴──────────────┐
                       ▼                              ▼                                    ▼
        ┌────────────────────────────────────────────────────────────┐        ┌──────────────────┐
        │   OpenChamber server  (@openchamber/web, Express on Bun)   │        │ Remote OpenChamber│
        │   in packages/electron: runs IN the Electron main process  │◄───────┤ instance (LAN /   │
        │   (no sidecar). Same server in CLI/docker deployments.     │        │ tunnel / relay)   │
        │   - serves UI (index/mobile/mini-chat html, PWA SW)        │        └──────────────────┘
        │   - serves /api/openchamber/* (own routes) + /api/fs,/api/ │
        │     git,/api/vcs,/api/openchamber/events (SSE control)     │
        │   - can START and SUPERVISE a local OpenCode process       │
        └──────────────────────────────┬─────────────────────────────┘
                                       │ HTTP proxy (same origin)
                                       ▼
        ┌────────────────────────────────────────────────────────────┐
        │        OpenCode agent server  (the HARNESS)                │
        │  SDK v2 client base URL: <server-origin>/api               │
        │  /api/event (SSE), /api/session/*, /api/config, /api/app,  │
        │  /api/path, /api/agent, /api/provider, /api/project, ...   │
        └────────────────────────────────────────────────────────────┘
```

Data-flow rule: the UI talks to **exactly one origin** — the OpenChamber server it is
paired with. OpenCode calls are **proxied under the same origin** at `/api/*`; UI code
never addresses the OpenCode server directly. Two full paths exist:

1. **UI → RuntimeAPIs → `runtimeFetch` → OpenChamber server** (OpenChamber-owned
   routes: `/api/openchamber/*`, `/api/fs`, `/api/git`, `/api/projects/:id/config`,
   `/auth/*`, `/health`).
2. **UI → SDK v2 client → `runtimeFetch` → OpenChamber server → OpenCode** (proxied:
   `/api/session/*`, `/api/config`, `/api/event`, `/api/provider`, …). The record/log RT
   subscription runs through the same proxied SSE (`04-sync-and-state-engine.md`).

**[HARNESS PORT HP-1] Base path:** All harness API traffic shares the UI origin,
namespace `/api`. An OpenCode replacement must (a) sit behind the OpenChamber-equivalent
server's `/api` proxy, or (b) act as that server for these paths. The UI's SDK client is
built with base URL `/api` by default (`DEFAULT_BASE_URL = VITE_OPENCODE_URL || '/api'`,
"absolute" when injected) and never resolves harness routes elsewhere.
(src: packages/ui/src/lib/opencode/client.ts:45, 165-188, 218-274)

### 2.2 Package topology

| Package | Kind | Owns | Consumed by |
|---|---|---|---|
| `@openchamber/ui` (packages/ui) | React library; `main: src/main.tsx`; private | All shared UI: app shells, components, stores, sync engine, runtime adaptation libs, i18n/themes/settings registries, PWA helpers | every surface below (alias `@openchamber/ui/*` → `../ui/src`) |
| `@openchamber/web` (packages/web) | Server + web entrypoints; published npm package; `bin: openchamber` | Express(5)/Bun server (serves UI + OpenChamber routes + OpenCode proxy), the node HTML entrypoints (`index.html`, `mobile.html`, `mini-chat.html`), `main.tsx`/`mobile-main.tsx`/`mini-chat-main.tsx`, service worker `sw.ts`, `createWebAPIs()` (the `web` RuntimeAPIs implementation), CLI (03) | browsers and PWAs; Electron imports its server; mobile build copies its `dist` |
| packages/electron | Native desktop shell | Windows/menus/deep links/tray/updates/SSH/host switching; starts the web server **in-process**; preload bridge | Desktop app; 09 owns internals |
| packages/vscode | Extension | 3 webview providers + extension-host bridge runtimes (`api:*` messages) | VS Code; 10 owns internals |
| packages/mobile | Capacitor shell | iOS/Android native projects; wraps the web build rewriting `mobile.html`→`index.html` | phones/tablets; 11 owns internals |
| packages/docs | Not a Bun workspace | Product docs site | humans |
| scripts/ | Repo tooling | `oc-dev.mjs` menu, dev launchers, packaging helpers, profiling | developers |

Key sharing facts:

- Web/electron/mobile/vscode share the **same bundled UI code**; each host injects its
  own `RuntimeAPIs` implementation into `window.__OPENCHAMBER_RUNTIME_APIS__` before
  importing the matching app renderer from `@openchamber/ui/apps/*`.
- The dev alias map used by every bundler: `@openchamber/ui` → `packages/ui/src`;
  `@` → `packages/ui/src`; `@web` → `packages/web/src`; `@opencode-ai/sdk/v2` →
  `node_modules/@opencode-ai/sdk/dist/v2/client.js` (pinned `1.18.30`).
(src: packages/web/vite.config.ts:88-95; packages/ui/package.json)

### 2.3 Entrypoint inventory

| Entry | File | Loads | Purpose |
|---|---|---|---|
| Web main | `packages/web/index.html` → `src/main.tsx` | hosted surface decision → `@openchamber/ui/main` (desktop layout) or `apps/renderMobileApp` | Browser + installed PWA |
| Web mobile | `packages/web/mobile.html` → `src/mobile-main.tsx` | `apps/renderMobileApp` | Forced-mobile-UI page (also the Capacitor web build template) |
| Mini chat | `packages/web/mini-chat.html` → `src/mini-chat-main.tsx` | `apps/renderElectronMiniChatApp` | Electron Mini Chat window content |
| Desktop | Electron `main.mjs` loads the *same* web build: dev → loopback HTTP (HMR), packaged → `openchamber-ui://` protocol serving `resources/web-dist` | identical entrypoints, same-origin loopback remains the API backend | Desktop app |
| VS Code | `webviewHtml.ts` generated HTML → `webview/main.tsx` | `apps/renderVSCodeApp` per panel | extension |
| SW | `src/sw.ts` compiled by vite-plugin-pwa | — | push delivery only (no precache fetch logic) |

(src: packages/web/vite.config.ts:133-138; package.json of web/electron)

---

## 3. The shared-UI / multi-runtime adaptation layer

This is the heart of the architecture: one UI, five hosts. The adaptation contracts:

### 3.1 Window bootstrap globals (the "who am I" contract)

Injected before any app module evaluates. Every one is optional-at-runtime but absence
has defined meaning:

| Global | Injected by | Shape / values | Consumers |
|---|---|---|---|
| `__OPENCHAMBER_API_BASE_URL__` | web server HTML template; Electron preload args (`--openchamber-api-base-url`); rewritten by runtime switching | absolute server base URL string | runtime-url resolver, runtime-switch, runtime-auth |
| `__OPENCHAMBER_CLIENT_TOKEN__` | web server HTML; Electron preload (local pages only) | bearer token string | runtime-auth bearer credential |
| `__OPENCHAMBER_RUNTIME_HEADERS__` | web server HTML; Electron preload (local pages only) | `Record<string,string>` (never `Authorization`) | runtime-auth extra headers |
| `__OPENCHAMBER_LOCAL_ORIGIN__` | web server HTML; Electron preload | loopback origin of the local server (e.g. `http://127.0.0.1:3901`) | desktop local-origin detection, realtime proxy |
| `__OPENCHAMBER_RELAY_HOST_ID__` | Electron preload (local pages only) | saved desktop host id | desktop relay restore |
| `__OPENCHAMBER_SURFACE__` | stamped once at boot by entry code | `'desktop' \| 'mobile'` | `isMobileSurfaceRuntime()`, device/perf/sync paging |
| `__OPENCHAMBER_RUNTIME_APIS__` | each entrypoint (web main / mini-chat main / webview main) | `RuntimeAPIs` object | App, VSCodeApp, ElectronMiniChatApp constructors |
| `__OPENCHAMBER_ELECTRON__` | Electron preload, **all pages** | `{ runtime: 'electron', arch: string, trayEnabled: boolean }` | `isDesktopShell()`, shell identity (not capability) |
| `__OPENCHAMBER_PLATFORM__` | Electron preload | `process.platform` | frameless-chrome decision (win32/linux) |
| `__OPENCHAMBER_MACOS_MAJOR__` | Electron preload + initScript | number | traffic-light window-chrome offsets |
| `__OPENCHAMBER_HOME__` | Electron preload (local) / VS Code HTML (= workspace folder) | string | home-dir hints, small-model requests |
| `__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__` | Electron main via `contextIsolation` **initScript** on `did-finish-load` (read-only contextBridge would block re-navigation updates) | `DesktopBootOutcome` JSON (below) | desktop boot splash/chooser/recovery |
| `__VSCODE_CONFIG__` | VS Code `webviewHtml.ts` | `{ workspaceFolder, workspaceFolders, theme, connectionStatus, cliAvailable, extensionVersion, platform, arch, panelType, viewMode, initialSessionId }` | earliest VS Code detection; `isVSCodeRuntime()` prefers it over RuntimeAPIs registration order |
| `__OPENCHAMBER_HOST_LANGUAGE__` | VS Code HTML | VS Code display language (e.g. `en`, `fr`) | initial locale before user choice; splash strings |
| `__OPENCHAMBER_PANEL_TYPE__` | VS Code webview `main.tsx` from config | `'chat' \| 'agentManager'` | VSCodeApp layout switch |
| PWA helpers (web only): `__OPENCHAMBER_GET_PWA_INSTALL_NAME__`, `__OPENCHAMBER_SET_PWA_INSTALL_NAME__(value)`, `__OPENCHAMBER_SET_PWA_ORIENTATION__(value)`, `__OPENCHAMBER_UPDATE_PWA_MANIFEST__()` | `index.html` inline script | functions; persist in localStorage `openchamber.pwaName`, `openchamber.pwaOrientation`, rebuild manifest link | settings UI |
| Debug: `__OPENCHAMBER_STARTUP_TRACE__`, `__OPENCHAMBER_STARTUP_TRACE_START__`, `__OPENCHAMBER_STARTUP_TRACE_SUMMARY__` | `startupTrace.ts` when `?startupTrace=1` or `localStorage.OPENCHAMBER_STARTUP_TRACE === '1'` | event ring buffer (max 500 entries `{t,name,data?}`), `t` = ms since first mark | performance tracing |

In Electron, contextBridge-exposed globals are **read-only**; values that must change at
runtime (API base, client token, runtime headers) are re-injected by the main-process
initScript, and `runtime-switch` writes through try/catch recognizing the read-only
failure and keeping its in-memory state authoritative.

(src: packages/ui/src/lib/runtimeConfig.ts:24-44; packages/electron/preload.mjs:14-104;
packages/vscode/src/webviewHtml.ts:180-201; packages/ui/src/lib/runtime-switch.ts:22-37,65-132;
packages/ui/src/lib/runtimeSurface.ts:73-79; packages/ui/src/lib/startupTrace.ts)

### 3.2 Cross-window / cross-process events and channels

| Channel | Kind | Direction | Payload |
|---|---|---|---|
| `openchamber:runtime-endpoint-will-change` | `window` CustomEvent | internal | `RuntimeEndpointChangedDetail { apiBaseUrl, previousApiBaseUrl, runtimeKey, previousRuntimeKey }` |
| `openchamber:runtime-endpoint-changed` | `window` CustomEvent | internal | same detail |
| `openchamber:app-ready` | `window` Event | app → Electron/tests | dispatched once when `isInitialized && !isSwitchingDirectory`; also sets `window.__openchamberAppReady = true` and a global `__openchamberSetEmbeddedVisibility` function on embedded frames |
| `openchamber:open-session` | `window` CustomEvent | Electron menu/tray → any window | `{ sessionId: string, directory?: string }` — opens session in place (mini chat excludes switching behavior) |
| `openchamber:open-draft-session` | `window` CustomEvent | menu/tray/actions | `{ directory?, projectId? }` — opens a new-session draft (project draft when target present, chat draft otherwise; also closes the session switcher) |
| `openchamber:open-mini-chat` | `window` Event | native File menu/tray | no payload; the desktop App calls `desktop_open_draft_mini_chat_window` (draft mini chat windows are NOT deduplicated, so this is single-fire) |
| `openchamber:memory-debug-toggle` | `window` Event | palette-only action | toggles MemoryDebugPanel |
| `openchamber:theme-hmr` | `window` CustomEvent | dev server → app | theme JSON (HMR only) |
| `openchamber:mini-chat-presence` | `BroadcastChannel` | mini chat windows ⇄ main | `{ type: 'mini-chat-session-presence', sessionId, directory, viewed }` every 5s while a mini chat shows a session |
| SSE control stream `/api/openchamber/events` | server → all clients | server push: `event-stream-ready`, message-queue updates, `session-created`, `scheduled-task-ran`, `worktree-changed` (`directories[], changedAt`), `browser-control-request`, `agent-memory-changed`; heartbeat 45s, reconnect backoff capped 30s | consumption rules in 04 |
| Embedded iframe (below) | `window.parent.postMessage` | both ways | see 8 |
| Electron IPC `openchamber:invoke` | preload → main | commands | `{command, args}`; COMMANDS_SAFE_FOR_REMOTE set (see 5.4) |
| Electron main → renderer | `openchamber:emit` | events | `{event, detail}`; also re-dispatched as DOM CustomEvent |
| `openchamber:relay-dev-tunnel-connect` | Electron | main ⇄ renderer browser-panel | MessagePort handoff `{connectionId, remotePort}` |

(src: packages/ui/src/lib/runtime-switch.ts:16-17; packages/ui/src/App.tsx:636-751;
packages/ui/src/components/layout/contextPanelEmbeddedChat.ts:29-33;
packages/electron/preload.mjs:148-198)

### 3.3 The RuntimeAPIs contract (instance-owned API surface)

`RuntimeAPIs` is a plain object the *instance adapter* (web server minimal, VS Code
extension host, Capacitor/mobile reuse of web) hands to the shared UI. The UI imports it
once at boot; the runtime descriptor classifies the host. Members:

| Member | Required | Contract summary (full shapes in JSON below where small) |
|---|---|---|
| `runtime` | yes | `{ platform: 'web'\|'desktop'\|'vscode'; isDesktop: boolean; isVSCode: boolean; label?: string }` |
| `terminal` | yes | PTY lifecycle; exact event stream below |
| `git` | yes | the whole Git work API (status/diff/stage/commit/push/pull/branch/worktree/rebase/merge/identity/log/stash); ~60 methods; all take `directory` first |
| `files` | yes | `listDirectory`, `search`, `createDirectory`, optional `statFile/readFile/readFileBinary/writeFile/uploadFile/delete/revealPath/execCommands/downloadFile`; `rawFile` URLs come from the URL resolver (`/api/fs/raw?path=&download=&allowOutsideWorkspace=&outsideFileGrant=`) |
| `settings` | yes | `load(): Promise<{settings: DesktopSettings; source: 'desktop'\|'web'}>`; `save(changes): Promise<SettingsPayload>`; optional `restartOpenCode(): Promise<{restarted:boolean}>`; document shape owned by the settings registry (14) |
| `permissions` | yes | `requestDirectoryAccess({path})`, `startAccessingDirectory(path)`, `stopAccessingDirectory(path)` — may be native picker (desktop) or server routes |
| `notifications` | yes | `notifyAgentCompletion(payload?: {title?,body?,tag?,kind?,sessionId?,directory?,requireHidden?})`; optional `canNotify()` |
| `github?` | optional | auth (device flow `authStart`/`authComplete`), PR surface (status/create/update/merge/ready/list/context), issues, repo upstream/branches; full result types are long — the PR/UI components bind to these exact fields (`state: 'open'\|'closed'\|'merged'`, checks summary `success\|failure\|pending\|unknown`) |
| `linear?` | optional | OAuth status/start/disconnect/activate; issues list/get/update with cursor paging `{connected, issues, cursor, hasMore}`; team↔project mapping; session status comments `{kind: 'started'\|'completed'\|'failure', sessionId, issueIdentifier?}`; result `skipped:` values `'already-posted'\|'issue-not-found'\|'not-started'\|'disabled'\|'origin-not-public'` |
| `push?` | optional | Web-push + native APNs registration: `getVapidPublicKey()`, `subscribe({endpoint,keys:{p256dh,auth},origin?,platform?})`, `unsubscribe({endpoint})`, `setVisibility({visible,platform?})`, `registerApnsToken({token, platform,'sandbox'\|'production'})` |
| `diagnostics?` | optional | `downloadLogs(): Promise<{fileName, content}>` |
| `clientAuth?` | optional | device/client management: `listClients`, `createClient`, `createPairingSession({label, allowedClientKinds, serverUrl, includeRelay, includeDirect})`, `purgeRevokedClients`, `revokeClient`, `listPendingPairings`, `cancelPairing`, `getPairingTransports(): {local, lan, relayAvailable}` |
| `tools` | yes | `getAvailableTools(): Promise<string[]>` |
| `editor?` | optional | VS Code only: `openFile(path, line?, column?)`, `openDiff(original, modified, label?, {line?, patch?})` |
| `vscode?` | optional | VS Code only: `executeCommand`, `openAgentManager`, `openExternalUrl`, `pickFiles?`, `saveImage?`, `saveMarkdown?`, `addWorkspaceFolder?` |
| `worktrees?` | optional | `WorktreeMetadata[]` seed |

The web implementation (`createWebAPIs`) announces itself as
`{ platform: 'web', isDesktop: false, isVSCode: false, label: 'web' }` and implements
terminal/git/files/settings/permissions/notifications/github/linear/push/clientAuth/tools
over HTTP routes (03). VS Code implements its own over `api:*` bridge messages but
ships a **throwing stub** `terminal` (`createStubTerminalAPI()` — every method throws
"unsupported") because the Terminal UI is not mounted in VS Code.

Settings on the VS Code webview resolve the workspace folder as last directory and a
theme from the host (`themeVariant: 'light'\|'dark'`).

(src: packages/ui/src/lib/api/types.ts:1442-1459 and member interfaces;
packages/web/src/api/index.ts:35-54; packages/vscode/src/DOCUMENTATION.md:167)

**[HARNESS PORT HP-2] Harness SDK methods reading shape:** every SDK result is
unwrapped with the convention `{data, error[, response.status]}` — non-2xx becomes
`<operation> failed (<status>): <message>`; missing data → "`<operation> failed: empty
response`". A harness replacement must keep this return shape (or thin-wrap it in the
client adapter); 02 owns the method list.
(src: packages/ui/src/lib/opencode/client.ts:55-90)

**[HARNESS PORT HP-3] Request behavior:** SDK reads go through `runtimeFetch` with a
**30 s read timeout** (`OPENCODE_REQUEST_TIMEOUT_MS = 30_000`); POSTs and event-stream
URLs (`url.includes('/event')`) bypass the timeout and pass through untouched.
(src: packages/ui/src/lib/opencode/client.ts:200-274)

**[HARNESS PORT HP-4] Directory coupling:** the UI keeps a single "current directory"
for SDK calls (`opencodeClient.setDirectory`, normalized: backslashes→`/`, Windows drive
letter uppercased, trailing slashes trimmed). Scoped clients per directory exist for
worktree APIs (`getScopedApiClient(directory)`), and a mismatch guard throws
`'Message was not sent because the runtime changed.'` if `getRuntimeKey()` changed
between build and send. Harness calls therefore observe a stable working-directory
header/parameter semantics (exact wire header `x-opencode-directory`: 03).
(src: packages/ui/src/lib/opencode/client.ts:312-334, 360-410, 477-499)

**[HARNESS PORT HP-5] Health probe:** client health check reads the harness with a 4s
timeout (`OPENCODE_HEALTH_TIMEOUT_MS = 4_000`); `checkConnection()` retries up to 5
attempts with linear backoff `sleep(400 * attempt)` on failure and classifies:
`isConnected/haveEverConnected`, `connectionPhase: 'connected' | 'reconnecting' |
'connecting'`, `lastDisconnectReason: 'health_check_failed' | 'health_check_unhealthy' |
'health_probe_unhealthy' | 'init_error'`.
(src: packages/ui/src/stores/useConfigStore.ts:3121-3195; packages/ui/src/lib/opencode/client.ts:47)

**[HARNESS PORT HP-6] Read coalescing allowlist:** identical concurrent GETs to
`/api/(config|path|app/agents|agent|project|command)` are coalesced (§10.5); a harness
replacing these routes under different names must publish the same idempotent-read
identity or extend the allowlist.
(src: packages/ui/src/lib/runtime-fetch.ts:249-258)

**[HARNESS PORT HP-7] Terminal contract:** exact event protocol in §3.4.1 (Web) / 09
(Electron native). A harness equivalent must satisfy the session/stream semantics below.

**[HARNESS PORT HP-8] URL auth token:** streams and assets carried by
EventSource/WebSocket/img cannot attach headers, so the UI mints short-lived URL tokens
`POST /auth/url-token` → `{ token, expiresAt }` (bearer or session cookie), refreshes
5s+10s before expiry while consumers are active (`acquireRuntimeUrlAuthToken` /
`subscribeRuntimeUrlAuthToken`), and appends `?oc_url_token=<token>` to SSE/WS/asset
URLs. Non-Latin-1 header values are URI-encoded with a marker
`x-opencode-directory-encoding: 'uri'`. `ngrok` hosts get
`ngrok-skip-browser-warning: openchamber`.
(src: packages/ui/src/lib/runtime-auth.ts:23-35, 140-207, 338-436;
packages/ui/src/lib/runtime-url.ts:98-138; packages/ui/src/lib/runtime-fetch.ts:37-46,
122-157)

### 3.4 TerminalAPI contract (exact)

```jsonc
// TerminalStreamEvent — one of:
{ type: 'snapshot', sequence?: number, data?: string, replayData?: string,
  cols?: number, rows?: number,                     // PTY size the snapshot was drawn for
  status?: 'running'|'exited'|'error', exitCode?: number, signal?: number|null,
  attempt?: number, maxAttempts?: number,
  runtime?: 'node'|'bun', ptyBackend?: string,
  mode?: 'interactive'|'command',
  purpose?: { type: 'terminal' } | { type: 'project-action'; actionId: string; executionId: string } }
{ type: 'data', sequence?: number, data?: string }
{ type: 'exit', exitCode?: number, signal?: number|null, status?: 'running'|'exited'|'error' }
{ type: 'reconnecting', attempt?: number, maxAttempts?: number }
```

- `createSession(options)` — options: `{cwd, sessionId?, cols?, rows?, themeMode?:
  'light'|'dark', terminalBackground?, terminalForeground?, shell?: 'auto'|'bash'|'zsh'|
  'sh'|'fish'|'pwsh'|'powershell'|'cmd'|'dash'|'ksh'|'nu', loginShell?, purpose?,
  mode?: 'interactive'}` or `{...mode:'command', command: string}`; returns
  `{sessionId, cols, rows, status: 'running'|'exited'|'error', mode?, purpose?}`.
- `connect(sessionId, {onEvent, onError?}) → Subscription{close}`; `sendInput(sessionId, input)`;
  `resize({sessionId, cols, rows})`; optional `close/updateAppearance/listShells/listSessions(cwd)/
  touchSessions(ids)/restartSession/forceKill({sessionId?, cwd?})`.
- Optional methods are runtime capability gaps the UI must survive (e.g. VS Code stub).

### 3.5 Runtime classification helpers (what the shell consults)

| Question | Function source | Answer priority |
|---|---|---|
| Is this Electron? | `isDesktopShell()` = `isElectronShell()` = `__OPENCHAMBER_ELECTRON__.runtime === 'electron'` | hard shell flag |
| Is this VS Code? | `isVSCodeRuntime()`: `isVSCodeBootstrapPresent()` (`__VSCODE_CONFIG__`) first, else RuntimeAPIs descriptor | bootstrap before API registration |
| Is this the mobile surface? | `isMobileSurfaceRuntime()`: stamp → `?surface=` override → Capacitor (`Capacitor.isNativePlatform()` or `capacitor:` protocol) → desktop/vscode shells pinned → phone heuristic (`min(innerWidth, screen.width) <= 768` AND coarse pointer/touch) | workout in §6.3 |
| Is this a "web" client? | `isWebRuntime()`: platform `web` → true; `desktop`/`vscode` → false; default `!isVSCode()` | notification/install/update gating |
| Client platform (push presence) | `getClientPlatform(): 'ios'|'android'|'vscode'|'desktop'|'web'` | Capacitor native wins first |
| iPad in Capacitor | `isIPadApp()`: platform `ios` AND (UA `iPad` OR Mac-like UA with >1 touch points) | tablet layout identity |
| Windows ARM64 workaround | `isWindowsArm64()` | suppress OpenCode update UI (upstream Bun FFI bug) |

(src: packages/ui/src/lib/desktop.ts:340-411; packages/ui/src/lib/platform.ts;
packages/ui/src/lib/runtimeSurface.ts:15-79)

---

## 4. Hosted web/PWA runtime (packages/web)

### 4.1 `index.html` pre-app contract

Compiled page performs, in order:

1. Reads `localStorage['openchamber.mobileKeyboardMode']` (`'native'|'resize-content'`,
   default `resize-content`), sets `<html data-oc-mobile-keyboard-mode>` and rewrites the
   viewport meta (`interactive-widget=resizes-content` only in `resize-content`).
2. Builds the PWA `<link rel="manifest">` (below).
3. Applies theme **before first paint** from `localStorage['themeMode']`
   (`dark|light|system`, fallback `useSystemTheme`/`selectedThemeVariant` legacy keys,
   default system) — sets `dark`/`light` class, `data-splash-variant`, `color-scheme`,
   and four splash CSS vars (`splashBgLight/FgLight/BgDark/FgDark` persisted by the theme system, 14).
4. Renders the splash (`#initial-loading`: isometric cube SVG, splash CSS vars,
   `--splash-background-dark: #151313`, light `#FFFCF0`, stroke `#CECDC3`/`#100F0F`,
   Nerd-Font `@font-face` preflight for terminal glyphs).
5. Starts the 10-second fallback: if `__OPENCHAMBER_LOCAL_ORIGIN__` is set (desktop
   shell), the splash is *never* force-removed by this timer; otherwise `fade-out` after
   10s (300ms fade).
6. Polyfills `window.process = { env: {} }`, then imports `/src/main.tsx`.

PWA manifest contract (built client-side; endpoint-first with data-URL fallback):

- Endpoint candidate: `GET <origin>/manifest.webmanifest?appName=&orientation=` with
  `credentials: include`, `cache: 'no-store'`, Accept
  `application/manifest+json, application/json;q=0.9, */*;q=0.1`, 1500 ms abort; must
  return content-type matching `manifest|json` — otherwise a Blob URL fallback manifest
  is used (so installs work behind auth proxies via `crossOrigin='use-credentials'`,
  and offline/legacy servers still install).
- Manifest fields: `name` (overridable, normalized to 64 chars, stored
  `openchamber.pwaName`), `short_name` (default `OpenChamber`, else truncated 30),
  `description: 'Web interface companion for OpenCode AI coding agent'`,
  `id/start_url/scope = <origin>/`, `display: 'standalone'`,
  `display_override: ['window-controls-overlay']`, optional `orientation`
  (`portrait-primary|landscape-primary` per stored preference `openchamber.pwaOrientation`,
  default system), `background_color: '#151313'`, `theme_color: '#edb449'`, icon set
  (`pwa-192.png`, `pwa-512.png`, `pwa-maskable-192/512.png`, `apple-touch-icon-180/152/167? [actually 180+152]`,
  `favicon-32/16`), `categories: ['developer','tools','productivity']`, `lang: 'en'`,
  and `shortcuts`: always "Appearance Settings" → `/?settings=appearance`, plus up to 3
  recent sessions read from `localStorage['openchamber.pwaRecentSessions']`
  (`{sessionId,title}` deduped, titles max 48 chars) → `/?session=<id>`.

(src: packages/web/index.html:1-605)

### 4.2 Web main boot (`src/main.tsx`) — numbered

1. `resolveHostedSurface()` decides `'desktop' | 'mobile'` and **stamps**
   `window.__OPENCHAMBER_SURFACE__` (§6.3). Dev HMR: listens for
   `openchamber:theme-updated` and re-dispatches as `openchamber:theme-hmr`.
2. If this document is an embedded session chat (`?ocPanel=session-chat`), await its
   postMessage runtime bootstrap (§8, 5s timeout) with retry every 100ms.
3. `createConfiguredWebAPIs(bootstrap)` — configures URL resolver, runtime endpoint
   (`initializeRuntimeEndpoint`), bearer/extra headers, optional relay switch (§11),
   rebinds the SDK client, installs the patched `window.fetch` bridge (§10.4), restores
   a desktop relay host (`restoreDesktopRelayRuntime`) raced against a 10 s give-up, and
   schedules `warmDesktopHostStatuses()` 3 s after settle (3000 ms delay constant
   `HOST_STATUS_WARMUP_DELAY_MS`). Assigns `window.__OPENCHAMBER_RUNTIME_APIS__`.
4. `watchHostedSurfaceViewport()` — 800 ms debounced reload when the post-boot viewport
   crosses the phone threshold (no-op in fixed shells and with `?surface=` override).
5. If surface === `'mobile'` → dynamic import `renderMobileApp(apis)`; return.
6. Else await `getDesktopRelayRestoreReady()` (hold splash until a relay-vs-direct
   transport is picked; never more than 10 s), then `await import('@openchamber/ui/main')`
   which renders `I18nProvider > ThemeSystemProvider > ThemeProvider > SessionAuthGate > App`
   into `#root` in `StrictMode`, after: `initializeLocale()`,
   `initializeAppearancePreferences()` then `syncDesktopSettings()` +
   `applyPersistedDirectoryPreferences()` (async; app renders with defaults first),
   starting `appearanceAutoSave`, `modelPrefsAutoSave`, `typographyWatcher`, and
   `preloadMarkdownRenderer()` (first session render shows text, not empty boxes).
7. Service worker: in PROD, register after load via `registerSW({onRegisterError})`
   (guards: `serviceWorker in navigator`, `isSecureContext`, protocol http/https, not
   prerendering/`visibilityState==='prerender'`); in DEV, unregister all registrations.

(src: packages/web/src/main.tsx:20-120; packages/ui/src/main.tsx:25-74;
packages/web/src/runtimeConfig.ts:13,51-108)

### 4.3 App bootstrap (`packages/ui/src/App.tsx`) — numbered

1. Register RuntimeAPIs in the global registry; subscribe runtime endpoint changes — a
   change runs `resetAppForRuntimeEndpointChange(detail)` (§11.2) and remounts the
   provider tree via a `runtimeEndpointEpoch` key bump.
2. Route hook `useRouter()` (§13) parses/normalizes deep links.
3. Fetch `GET /health` once: boolean-ish `planModeExperimentalEnabled`
   (`true|1|'1'|'true'`) toggles the`plan-mode` feature flag + rail surface.
   **[HARNESS PORT HP-9]** The flag is an OpenChamber-server field driven by env
   `OPENCODE_EXPERIMENTAL_PLAN_MODE` or `OPENCODE_EXPERIMENTAL`; keep the field name.
   (src: packages/web/server/index.js:235)
4. `initializeApp()` (unless VS Code runtime — VS Code bootstraps after its managed
   instance reports "connected" to avoid startup races). On failure an automatic retry
   loop runs: max **10 attempts**, base **1000 ms**, doubling, capped **16 000 ms**;
   exhausted → full-screen `StartupInitializationRecovery` with a manual retry button.
   The retry also removes the HTML splash (300 ms fade) so recovery is reachable.
5. Startup recovery for providers/agents: while connected and either list is empty,
   re-run `loadProviders`/`loadAgents` on a **2 s interval, max 15 attempts**
   (`source: 'startupRecovery'`) — these loaders swallow errors, so a reactive effect
   cannot detect failure; it must poll.
6. Desktop splash gating (`desktopBoot`, §5). Non-desktop: splash removed when
   `isInitialized` (plus the 5 s fallback in App and 10 s in HTML).
7. GitHub + Linear auth statuses refreshed once connection state changes
   (`refreshStatus({force: true})`).
8. Effects mounted at shell level: `usePushVisibilityBeacon({enabled}),
   useWebNotificationStream({enabled}), useAgentMemorySync(currentDirectory||null) —
   message memory index is loaded at startup, not lazily — usePwaInstallPrompt() (web),
   useWindowTitle, useRootScrollLock, useMenuActions, useTraySync,
   useGlobalSessionsPolling (45 s, §10.6), useSessionStatusBootstrap, useUpdatePolling.
9. `openchamber:app-ready` dispatched on first `isInitialized && !isSwitchingDirectory`.
10. Full desktop layout render: `ErrorBoundary > SyncProvider(key=epoch, sdk,
    directory='') > RuntimeAPIProvider > FireworksProvider > TooltipProvider(300ms delay,
    150ms skip) > MainLayout + Toaster + AppLinkConfirmDialog + SharedTrustConfirmDialog`,
    plus (only after init) `ConfigUpdateOverlay`, `AboutDialogWrapper`, MemoryDebugPanel.
    Boot shell state (`!isInitialized && !desktop`) skips the heavy overlays.
11. Error toasts auto-clear after **5000 ms**.

(src: packages/ui/src/App.tsx:230-979)

### 4.4 Session auth gate (web + vscode + mini chat + mobile browser)

- Status check: `GET /auth/session` (`credentials: include`, Accept json). Transient
  network/5xx failures retry up to **4 attempts**, base **1500 ms** (protects a
  relay-first-connect race: 200/401/429 are definitive and never retried).
- Renders as a full-screen unlock: password submit
  (`POST /auth/login`-family routes; 03), optional "trust this device" checkbox
  (persisted `localStorage['openchamber.uiAuth.trustDevice']`), WebAuthn/passkey
  unlock when the server advertises it (`browserSupportsWebAuthn`), and — in Electron —
  issuance of a local desktop client token with `clientKind: 'desktop-local'`,
  dedupeKey `'desktop-local'` when the target origin is loopback-local.
- Auth-expiry contract: `runtime-auth-expiry.ts` classifies responses that flow through
  runtimeFetch and flips an `AuthSessionStore` shown by `AuthExpiredBanner`; installing
  the focus watch re-checks on window focus.
- Shells that skip the gate: Capacitor native mobile (its own connection flow), and
  desktop-local pages already bound to a client token.
- Desktop host switcher UI is embedded in the gate for desktop recovery flows.

**[HARNESS PORT HP-10] Auth endpoints the shell depends on:** `/auth/session` (status),
`POST /auth/url-token` (mint `{token,expiresAt}`), plus login/password endpoints and
(optional) passkey endpoints — route table in 03. A harness replacing routing must
preserve these names and status semantics (401/403 = auth required, never "offline").

(src: packages/ui/src/components/auth/SessionAuthGate.tsx:31-110;
packages/ui/src/lib/runtime-auth-expiry.ts)

### 4.5 PWA install & update UX (shell-owned)

- **Install prompt:** on `beforeinstallprompt` (web runtime only, browser tab only):
  prevent default; store the deferred event; show an Infinity-duration toast
  (i18n `pwa.installPrompt.description`) with Accept (calls `prompt()`,
  success toast `pwa.installPrompt.started`) and Cancel (dismiss persisting
  `localStorage['pwa-install-toast-dismissed']`); once per tab session
  (`sessionStorage['pwa-install-toast-shown']`). `appinstalled` → dismiss toast +
  success toast `pwa.installPrompt.installed`.
- **Display-mode detection** (`pwa.ts`): `android-app://` referrer → `'twa'`;
  iOS `navigator.standalone` → `'standalone'`; `matchMedia('(display-mode: …)')` for
  `standalone|minimal-ui|fullscreen|window-controls-overlay`; default `'browser'`.
- **Server update flow (web/PWA + clients of an embedded desktop host):**
  1. Poll `GET /api/openchamber/update-check?appType=web&reportUsage=false&updateStatus=true`
     on a service-suggested interval: default `3600_000` ms, clamped to
     [300 000, 86 400 000] per `nextSuggestedCheckInSec`.
  2. When available, the UI offers **`POST /api/openchamber/update-install`** (no body)
     which returns one of:
     ```json
     { "success": true, "autoRestart": true, "version": "1.24.0", "updateOwner": "electron-updater" }
     { "success": true, "autoRestart": true, "updateOwner": "package-manager" }
     { "error": "…", "code": "DESKTOP_UPDATE_RESTART_FAILED" }   // HTTP ≥400, install failed
     ```
  3. Then `waitForUpdateApplied` polls the check endpoint every 2 s until applied or
     10 min timeout: electron-updater owner ⇒ `currentVersion === target.version`;
     package-manager owner ⇒ `available === false` or `currentVersion` changed; a 401/403
     during a package-manager restart is followed by one `/health` probe — `ok` counts as
     applied (the browser session was replaced).
  4. Update toasts (`OpenCodeUpdateToast`, `MobileAppUpdateToast`) and the VS Code path
     are 05/10/09 features; the shell only owns polling + bridge.
- Desktop-native updates go over `desktop_check_for_updates /
  desktop_download_and_install_update` IPC with `openchamber:update-progress` events
  (`{event: 'Started'|'Progress'|'Finished', data:{contentLength|downloaded|total}}`) —
  09 owns dialogs; the shell function contract is `UpdateInfo {available, version?,
  currentVersion, body?, date?, releaseUrl?, downloadUrl?, nextSuggestedCheckInSec?,
  packageManager?, updateCommand?}`.

(src: packages/ui/src/lib/web-update.ts:1-87; packages/ui/src/hooks/usePwaInstallPrompt.ts;
packages/ui/src/hooks/usePwaDetection.ts; packages/ui/src/hooks/useUpdatePolling.ts:24-60;
packages/ui/src/lib/desktop.ts:8-25, 544-628)

### 4.6 Offline / fragile-network behavior (shell level)

- **Chunk load recovery** (`chunkLoadRecovery.ts`): every heavy view is `lazy`-wrapped by
  `lazyWithChunkRecovery`. A dynamic-import failure is detected by patterns
  (`Importing a module script failed`, `Failed to fetch dynamically imported module`,
  `error loading dynamically imported module`, `Loading chunk N failed`, `ChunkLoadError`),
  retried once after **250 ms**, then, outside VS Code, schedules **one** `location.reload()`
  guarded by a `sessionStorage['openchamber:chunk-import-reload']` marker
  (`{signature: '<appVersion>:<first 500 chars of error>', timestamp}`) valid **30 s**.
  **VS Code deliberately skips navigation recovery** (`window.location.reload()` is
  unsupported); the error must reach the error boundary instead.
  (src: packages/ui/src/lib/chunkLoadRecovery.ts:6-16, 44-108)
- **Background network gate** (`background-network.ts`): all poll/prefetch-shaped
  background calls run through `runBackgroundNetworkTask` — a global semaphore of
  **3** concurrent tasks — to keep sockets free for interactive traffic (browser per-origin
  ~6 connections). GitHub PR status has its own separate gate.
- **In-flight GET coalescing:** see §10.5 (allowlist HP-6; no AbortSignal, GET only, never
  `/event`).
- **Read timeouts:** 30 s (SDK) / 4 s (health); URL-token mint failures retry promptly
  via the proactive scheduler (HP-8).

### 4.7 Debug startup trace

`?startupTrace=1` or `localStorage.OPENCHAMBER_STARTUP_TRACE=1` enables `markStartupTrace`
(name) and `measureStartupTrace(name, fn)` (records `:start/:end/:error` with
`durationMs`), keeps max 500 entries since first mark, exposes `window.__OPENCHAMBER_STARTUP_TRACE_SUMMARY__()`
(a console.table-ready filtered tail around `ModelControls:ready`), and marks
hotspots: `checkConnection`, `initializeApp`, `loadProviders`, `loadAgents`,
`activateDirectory`, `opencodeClient:setDirectory`, `config.defaults`, `modelsMetadata`,
`ModelControls`. Boot also prints a one-line hint. `App:mounted` is always marked.
(src: packages/ui/src/lib/startupTrace.ts)

---

## 5. Desktop (Electron) runtime — shell-facing contract

09 owns window/tray/updater internals; this is what the shared UI and any re-implementer
of the *shell boundary* must know.

### 5.1 In-process server + asset origin

- Desktop starts the same Express web server **inside the Electron main process**
  (`main.mjs` imports `@openchamber/web/server/index.js`, calls `startWebUiServer()`).
  There is no sidecar.
- UI load: dev → loopback HTTP/HMR origin; packaged → staged assets under
  `resources/web-dist` served by the `openchamber-ui://` custom protocol (origin
  `openchamber-ui://app`), while the **loopback server remains the API backend**
  (`__OPENCHAMBER_LOCAL_ORIGIN__`).
- Electron sets env `OPENCHAMBER_RUNTIME=desktop` before starting the server; desktop
  dev flags: `OPENCHAMBER_ELECTRON_DEV=1`, `OPENCHAMBER_ELECTRON_USE_BUNDLED_UI=1`,
  `OPENCHAMBER_SKIP_LOCAL_SERVER=1` (start UI connected to the default remote
  instance), HMR ports `OPENCHAMBER_HMR_UI_PORT` (default 5173) /
  `OPENCHAMBER_HMR_API_PORT` (default 3901).

### 5.2 Boot outcome contract (authoritative)

The native layer computes a `DesktopBootOutcome` and injects it (initScript, see §3.1).
Validation and view mapping are pure and shared:

```jsonc
// window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__ — validated shape
{ "target": "local"  , "status": "ok"           , "localAvailable?: false }
{ "target": "remote" , "status": "ok"           , "hostId": "<id>", "url": "<http(s) url>", "localAvailable?": false }
{ "target": null     , "status": "not-configured", "localAvailable?": false }        // first launch
{ "target": "local"  , "status": "unreachable"   , "localAvailable?": false }
{ "target": "remote" , "status": "unreachable"   , "hostId", "url" }
{ "target": "remote" , "status": "incompatible"  , "hostId", "url" }   // server too old/new
{ "target": "remote" , "status": "wrong-service" , "hostId", "url" }   // redirect/unknown service
{ "target": "remote" , "status": "missing"       , "hostId" }           // host entry gone
```

View resolution (`resolveDesktopBootView`):

| Outcome | Screen |
|---|---|
| `local/ok` | `main` |
| `remote/ok` | `main` (+ hostId/url) |
| `null/not-configured` | `chooser` (OnboardingScreen `mode="first-launch"`) |
| `local/unreachable` | `chooser` (not a hard recovery — user picks) |
| `remote/unreachable` | `recovery` variant `remote-unreachable` |
| `remote/incompatible` | `recovery` variant `remote-incompatible` |
| `remote/wrong-service` | `recovery` variant `remote-wrong-service` |
| `remote/missing` | `recovery` variant `remote-missing` |

Injection status enum: `'not-injected' | 'malformed' | 'valid'`.

Splash lifecycle gates (`canDismissInitialLoading`):

| Shell | Dismiss requires |
|---|---|
| non-desktop | `isInitialized` |
| desktop, view=chooser/recovery | only valid boot outcome known |
| desktop, view=main | valid outcome **and** `isInitialized` |

Desktop injection poll: start 200 ms, factor ×1.1, cap 2000 ms, 50 attempts (~10 s)
before splash text becomes "Desktop startup is taking longer than expected...".
Malformed outcome: splash text "Desktop startup failed — please restart the app." and the
splash never dismisses on its own. Dismiss = `#initial-loading` gets class `fade-out`
(300 ms) then removed, 150 ms grace before starting the fade.

Recovery actions: when the local HTTP origin is not active yet
(`shouldRestartDesktopBootFlow`), the retry path must **restart the desktop app** via
`desktop_restart` IPC (`restartDesktopApp()`), not reload the page; otherwise
`window.location.reload()`.

(src: packages/ui/src/lib/desktopBoot.ts:23-309; packages/ui/src/App.tsx:361-421, 764-832;
packages/electron/main.mjs:1663, 2442)

### 5.3 Shell-touching bridge helpers (shared UI side)

- `invokeDesktop(command, args)` — only present when `window.__OPENCHAMBER_DESKTOP__.invoke`
  exists; privileged commands are additionally gated in the main process. Notable
  commands used by the shell (09 owns the complete list): `desktop_open_draft_mini_chat_window`,
  `desktop_focus_window`, `desktop_start_window_drag`, `desktop_get_lan_address`,
  `desktop_open_path`, `desktop_reveal_path`, `desktop_open_in_app`,
  `desktop_open_file_in_app`, `desktop_get_installed_apps`, `desktop_save_markdown_file`,
  `desktop_check_for_updates`, `desktop_download_and_install_update`, `desktop_restart`,
  `desktop_get/set_launch_at_login` `{supported,enabled}`,
  `desktop_get/set_minimize_to_tray`, `desktop_get/set_keep_awake` `{supported,enabled,active}`.
- Filesystem access: `openDialog({directory, multiple, title, filters, defaultPath,
  returnGrant})` → `{path, outsideFileGrant?, expiresAt?}` (grant tokens created through
  `openchamber:file:grant-existing`); native pickers available only when
  `isDesktopLocalOriginActive()`; web runtimes fall back to server routes.
- Frameless chrome: `usesFramelessElectronChrome()` — win32/linux get in-app
  minimize/maximize/close; position setting `desktopWindowControlsPosition`
  `left|right` (legacy `auto`→right); order left = `[close, minimize, maximize]`
  (macOS traffic lights), right = `[minimize, maximize, close]`.

### 5.4 Remote-page safety surface

`window.__OPENCHAMBER_DESKTOP__` is exposed on every page (including remote-instance
pages), but the main process rejects non-window commands from non-local senders. Allow
list `COMMANDS_SAFE_FOR_REMOTE` (exact):

```
desktop_hosts_get, desktop_host_probe, desktop_new_window, desktop_new_window_at_url,
desktop_new_window_for_host, desktop_set_window_title, desktop_set_window_theme,
desktop_is_window_fullscreen, desktop_start_window_drag, desktop_minimize_current_window,
desktop_toggle_current_window_maximized, desktop_close_current_window,
desktop_get_current_window_state, desktop_get_app_version, desktop_get_lan_address,
desktop_capture_page_rect, desktop_tray_update
```

Native file dialogs and any fs/shell command are local-origin only. Reused verbatim when
porting: remote tab pages must keep this split.

(src: packages/electron/main.mjs:5090-5117)

### 5.5 Multi-window & Mini Chat (shell-side facts)

- Mini Chat window geometry: default **520×760**, min **360×480**; content is Electron
  `mini-chat.html` (dev: loopback origin; packaged: `openchamber-ui://`).

---

## 6. Hosted mobile surface & Capacitor shell

### 6.1 Two mobile surfaces, one app tree

- `mobile.html` (hosted): the web server's forced-mobile page — same-origin phone UI in
  a browser; regular web auth.
- Capacitor app (iOS/Android): build copies `packages/web/dist`, rewrites
  `mobile.html` → `index.html`; app id `com.openchamber.app`; Android WebView serves
  from an `https://` scheme (`androidScheme: 'https'`) with `allowMixedContent: true` so
  plain-HTTP LAN servers are reachable; `capacitor://localhost` must stay in the server
  CORS allowlist for packaged clients.

### 6.2 `renderMobileApp` boot — numbered

1. Stamp `window.__OPENCHAMBER_SURFACE__ = 'mobile'` **before** anything reads it.
2. `initializeSharedPreferences()` — locale + appearance/settings hydration (same set as
   web main), then `markAppBootReady()` (release splash gate once typography is final).
3. `installMobileWidgetSnapshotBridge()` — exposes session-overview snapshot builder for
   home/lock-screen widgets.
4. `getDeviceInfo()` once to apply `device-mobile`/`mobile-pointer` classes on `<html>`
   **before first React paint** (mobile typography sizes otherwise shift one frame late).
5. Notifications: in native shell replace with
   `{ notifyAgentCompletion: async () => false, canNotify: () => false }` (APNs/FCM
   deliveries are background-native; Web Notifications API does not render in WKWebView).
6. Render tree: `StrictMode > I18nProvider > ThemeSystemProvider > ThemeProvider >
   DiffWorkerProvider > [SessionAuthGate? > MobileApp]` — SessionAuthGate is **omitted
   in the native shell** (connection flow handles auth); kept for hosted mobile web.

(src: packages/ui/src/apps/renderMobileApp.tsx:46-99; packages/mobile/capacitor.config.ts)

### 6.3 Mobile shell structure (behavioral)

- **Navigation model:** left = sessions (phones: `MobileSessionsSheet` drawer; tablets ≥
  short-side 600 px: persistent resizable sidebar `IpadSidebarResizeHandle`, persisted
  widths under `openchamber.ipad.leftSidebarWidth` / `rightSidebarWidth`, default
  `IPAD_LEFT_SIDEBAR_WIDTH`, `IPAD_WORKSPACE_SIDEBAR_MAX_WIDTH`); right = workspace
  drawer (`MobileWorkspaceDrawer`) with tabs **`changes` (default) / `files` / `terminal`
  / `notes`** (+ MCP in the footer); app-level full-screen surfaces reachable only from
  the drawer footer: `instances`, `settings` (page list
  `general, appearance, chat, notifications, sessions, git, magic-prompts, snippets,
  behavior, agents, commands, mcp, plugins, skills.installed, skills.catalog, providers,
  usage, voice, integrations, about`; stage `nav|page-content`), `update`. Exactly one
  full-screen surface at a time; a second open replaces the first; closing returns to chat.
- **Tablet layout is a size class, not a device check** (`readTabletLayout`):
  `enabled = isIPadApp() || min(width,height) >= 600`; `roomyForPanels = enabled &&
  width > height && width >= 1000` (workspace becomes a side panel only then; book
  foldables unfolded still full-cover in both orientations; folding is just a resize
  since the Android activity declares `configChanges`).
- **Chrome:** header (`MobileHeader`) with session switcher (`MobileSessionSwitcher`,
  `MobileSessionsSheet`), connection debug panel overlay (capacitor), header dropdowns
  become anchored popovers on tablets, bottom sheets on phones; edge swipe (`useEdgeSwipe`)
  opens/reopens the workspace drawer preserving the last tab; hardware keyboard
  (`useHardwareKeyboard`) keeps draft starter chips visible when there is room
  (`oc-keep-draft-starters` root class when `isTabletLayout && (isPortrait ||
  hasHardwareKeyboard)`); `wide-chat-layout` root class applies here too.
- **Keyboard modes:** `resize-content` (default; viewport meta
  `interactive-widget=resizes-content`) vs `native` (Capacitor keyboard `resize:'none'`,
  UI follows `--oc-keyboard-inset`; chosen via settings, stored
  `openchamber.mobileKeyboardMode`).
- **Connection model:** first launch in Capacitor shows `MobileConnectionWelcome`
  (QR scan `openchamber://connect?...` pairing v2 link, or manual URL + password):
  payload contract in §5.4/`connectionPayload.ts`:

```jsonc
// Pairing link: openchamber://connect?v=2&p=<base64url(JSON)>  (payload ≤ 16384 chars)
{ "v": 2, "pairingId": "...", "secret": "...", "label?": "...", "fingerprint?": "...",
  "expiresAt?": "<iso>", "candidates": [
    { "type": "lan",    "url": "http://192.168.1.10:3000", "priority?": 0 },
    { "type": "tunnel", "url": "https://example.trycloudflare.com", "priority?": 1 },
    { "type": "relay",  "relayUrl": "wss://…", "serverId": "…",
      "hostEncPubJwk": { "kty":"EC","crv":"P-256","x":"…","y":"…" }, "grant?": "…" } ] }
```

  - `lan/tunnel` candidates are health-checked, then the pairing `secret` is redeemed
    over direct fetch; `relay` candidates open the E2EE tunnel (09/relay doc) and redeem
    over it. Old Android WebViews mis-parse `openchamber://` URLs — a regex fallback
    parser (`parsePairingConnectionPayloadString`) applies after URL parsing fails.
  - Saved instances (connection records) are managed in `Instances`; switching or
    disconnecting uses the runtime-switch machinery of §11 with the special key
    `mobile-disconnected` (`MOBILE_DISCONNECTED_RUNTIME_KEY`) as the transient
    "no instance" state; theme/`ui-store` scoping must never read/write under it.
  - **Connection debug:** `mobileConnections` logs connect events (`logMobileConnectEvent`),
    auto-connects the last instance (`autoConnectLastInstance`), re-probes
    (`reprobeActiveConnection`), and offers a `MobileConnectionDebugPanel` overlay.
- **Resume:** native lifecycle hook re-syncs on foreground
  (`NATIVE_RESUME_SYNC_EVENT_THROTTLE_MS = 1000`); deep links
  (`openchamber://` nav intents, notification taps, widgets) route via
  `deepLinkNavigation` to `openSessions`/`openChanges({diffPath,staged})`/`openFiles`/
  `openSettings` — exposed by `mobileAppContext` handlers.
- **Widget snapshot bridge:** `mobileWidgetSnapshot.ts` publishes the attention count +
  recent sessions to the native layer.

(src: packages/ui/src/apps/MobileApp.tsx:81-261; packages/ui/src/apps/mobileAppContext.tsx;
packages/ui/src/lib/connectionPayload.ts:11-246; packages/mobile/README.md)

---

## 7. VS Code runtime

### 7.1 Hosts and injection

- Three webview providers, all rendering `renderVSCodeApp` → `VSCodeApp`:
  `ChatViewProvider` (sidebar, `panelType 'chat'`, `viewMode 'sidebar'`),
  `SessionEditorPanelProvider` (editor tab, `panelType 'chat'`, `viewMode 'editor'`),
  `AgentManagerPanelProvider` (editor tab, `panelType 'agentManager'`).
- HTML injected: `__VSCODE_CONFIG__` (shape in §3.1), `__OPENCHAMBER_HOME__` =
  workspace folder, `__OPENCHAMBER_HOST_LANGUAGE__`; a pre-bundle loading splash whose
  strings come from OpenChamber's saved locale
  (`localStorage['openchamber.i18n.v1']` → VS Code display language fallback; markers
  `window.__OPENCHAMBER_HOST_LANGUAGE__`); `OpenCode CLI not found. Please install it
  first.` banner when `cliAvailable === false`.
- Webview boot (`webview/main.tsx`): reads config; sets
  `window.__OPENCHAMBER_PANEL_TYPE__`; `createVSCodeAPIs()` →
  `window.__OPENCHAMBER_RUNTIME_APIS__`; initial `connectionStatus` from config
  (`'connecting'` default) + `cliAvailable`; emits host theme; dynamic import of
  `renderVSCodeApp` at the end so the splash covers bundle load.
- `VSCodeApp` layout: `panelType === 'agentManager'` → `SyncProvider > RuntimeAPIProvider >
  TooltipProvider > AgentManagerView` (+ same dialog set, `Toaster position="top-center"`);
  else `FireworksProvider > … > VSCodeLayout` + `ConfigUpdateOverlay`.
  App-level effects here: `usePushVisibilityBeacon` (always on), `useRouter()` (state-only),
  `useGlobalSessionsPolling` except agentManager, GitHub status refresh, `/health`
  plan-mode flag fetch, error auto-clear 5 s, skip `initializeApp` (VS CodeLayout
  bootstraps after the managed OpenCode instance reports "connected").

### 7.2 Layout reachability (contract summary)

`VSCodeLayout` has exactly three views: `sessions`, `chat`, `settings`. There is no
`MainLayout`/`ContextPanel`/rail in this runtime, so the following deviate:

- Mounted: chat timeline, composer, work-status panel, permission/question cards,
  timeline dialog, tool output, sessions sidebar, session dialogs/switcher, MCP dropdown,
  context usage, usage/quota, notifications/MCP/agents/commands/skills/plugins/providers
  settings, agent manager, work status, GitHub PR status via sidebar store.
- Partial: settings (gated pages `remote-instances, git, shortcuts, magic-prompts, voice,
  tunnel, about` hidden), worktrees (create/remove only), voice/dictation (voice page gated),
  command palette (shortcut toggles state but `CommandPalette` renders only in
  `MainLayout` — opens nothing).
- Not mounted: terminal (throwing stub API), files/diff/git views, plan view, PR view,
  browser pane, walkthrough, archive, scheduled tasks, mini chat, project context panel.
- Control stream: the extension does not run the OpenChamber server, so
  `subscribeOpenchamberEvents` returns a near-no-op before resolving URLs (prevents 403s
  against the webview origin); session sync rides the proxied OpenCode SSE + global
  sessions polling.
- Chunk-recovery navigation skip applies (§4.6).

Full surface-by-surface table owned by 10 (`packages/vscode/src/DOCUMENTATION.md`).

### 7.3 VS Code settings surface default

When `settings.load()` is asked with no stored settings, the webview answers with
`lastDirectory = __VSCODE_CONFIG__.workspaceFolder` and
`themeVariant = theme === 'light' ? 'light' : 'dark'` (host theme mirror). Writes are
gated by the generated settings registry snapshot (14).

---

## 8. Embedded session-chat iframe (context-panel chat tabs)

A same-origin iframe hosts the chat of one session inside `ContextPanel`. URL contract
(parent-built):

```
<origin>/?ocPanel=session-chat&surface=desktop&sessionId=<id>
         [&directory=<dir>] [&readOnly=1]
         &themeMode=light|dark|system&lightThemeId=<id>&darkThemeId=<id>
         &themeVariant=dark|light [&allowPromptingSubagentSessions=1|0]
```

- Detection: `isEmbeddedSessionChat()` — `?ocPanel === 'session-chat'`, **cached on first
  call per realm** (embedded-ness is fixed at mount; parent src swap = full reload).
- Boot: iframe `main.tsx` `start()` asks the parent repeatedly (100 ms) for the runtime
  bootstrap and gives up after **5 s** (messages below are same-origin-checked:
  `event.origin === location.origin && event.source === window.parent`):

| Message type | Direction | Payload |
|---|---|---|
| `openchamber:embedded-runtime-bootstrap-request` | iframe → parent, retried 100ms | `{requestId}` |
| `openchamber:embedded-runtime-bootstrap-response` | parent → iframe | `{requestId, payload: EmbeddedSessionRuntimeBootstrap}` with `{apiBaseUrl, clientToken, localOrigin, runtimeHeaders?, relayHostId, relay?}` (relay without `grant`) |
| `openchamber:embedded-visibility-request` | iframe → parent | — |
| `openchamber:embedded-visibility` | parent → iframe | `{visible: boolean}` |

- The parent may also set `window.__openchamberSetEmbeddedVisibility(payload)` directly.
- Visibility semantics: a background tab starts **inactive**
  (`embeddedBackgroundWorkEnabled = false`) so it cannot steal composer focus or run
  background work; messages subscription stays enabled so a busy subagent still shows.
  URL: chat tab src caches per tab id; signature =
  `JSON.stringify({sessionID, directory, readOnly})`.
- Iframe in-place navigation ("Open subtask") may change the current session without
  rewriting the URL (`useRouter()` skips URL sync entirely in this shell).
- The iframe registers `App` with the *desktop* surface → renders only
  `EmbeddedSessionChatContent` (ChatView + Toaster + dialogs), skipping MainLayout.
- Parent-side keep-alive rules: chat tab *records* stay open; only the active iframe is
  mounted while the panel is open; no iframe mounted when the panel is closed
  (surfaces doc + 04 own the state ownership).

(src: packages/ui/src/components/layout/contextPanelEmbeddedChat.ts:20-245;
packages/ui/src/App.tsx:114-228, 563-634, 904-923)

---

## 9. Electron Mini Chat window

- URL config query: `mode=session|draft&sessionId=&directory=&projectId=`.
- Boot (`renderElectronMiniChatApp`): same shared prelude; then
  `ElectronMiniChatApp` = ErrorBoundary > SyncProvider > RuntimeAPIProvider >
  TooltipProvider > [MiniChatBootstrap + MiniChatPresencePublisher +
  SyncRuntimeEffects + MiniChatLayout(mode, autoOpenDraft=(mode==='draft'), unavailable)].
- `MiniChatBootstrap` behavior (numbered):
  1. `initializeApp()`; retry interval **1 s** up to **10** if init not done.
  2. `mode=session` and a directory given → `setDirectory(directory)` once
     (`showOverlay: false`).
  3. `mode=session`: select `config.sessionId` unless the user already selected a
     different session; unknown session → `sync.ensureSessionRenderable(sessionId)`.
  4. `mode=draft`: `openNewSessionDraft` with target `'project'` when
     projectId/directory given else `'chat'` (`CHAT_DRAFT_PROJECT_ID`), and follow the
     draft's directory.
  5. Worktree discovery per project (best effort) + control-stream
     `worktree-changed` re-listen via `refreshWorktreeTopologyForChange`.
  6. Providers/agents recovery when empty while connected
     (`source: 'electronMiniChat:recovery'`).
  7. HTML splash (`#initial-loading`) fade (300 ms) when ready: target session active
     (100 ms) or draft open; grace timer **1500 ms**.
- Presence: BroadcastChannel `openchamber:mini-chat-presence`, posts
  `{type:'mini-chat-session-presence', sessionId, directory, viewed:true}` immediately and
  every **5 s**, `viewed:false` on beforeunload/unmount; the main app's
  `MiniChatPresenceBridge` marks the session viewed externally (no duplicate notifications).
- Unavailability: if the session is unknown and no current selection after **5 s**,
  `MiniChatLayout` renders its unavailable state.
- In-place switching: listens `openchamber:open-session` and swaps sessions in this
  window instead of spawning another.
- Keyboard shortcuts: `useMiniChatKeyboardShortcuts`.

(src: packages/ui/src/apps/ElectronMiniChatApp.tsx:35-372)

---

## 10. Boot sequences summary tables

### 10.1 Web/PWA cold boot (canonical)

| # | Step | Detail / timing |
|---|---|---|
| 1 | HTML prelude | theme + viewport + manifest (§4.1), splash visible |
| 2 | module load | `main.tsx` start(): surface decision & stamp; embedded bootstrap if `?ocPanel` |
| 3 | RuntimeAPIs | `createConfiguredWebAPIs()`: resolve URL config → `initializeRuntimeEndpoint` → tokens → fetch bridge → relay restore (≤10 s wait) |
| 4 | Render | mobile → `renderMobileApp`; else `ui/main` (gate: relay restore ready) |
| 5 | Auth | `SessionAuthGate` checks `GET /auth/session` (≤4 transient retries ×1.5 s) |
| 6 | App mount | Router parse; `/health` plan flag; RuntimeAPIs registration |
| 7 | Init | `initializeApp()` (checkConnection ≤5 attempts, backoff 400·n ms; providers+agents parallel loads); retry loop 10× (1s→16s) if failed; manual recovery screen after exhaust |
| 8 | Recovery | providers/agents re-poll 2 s ×15 if empty post-connect |
| 9 | Ready | splash fade (300 ms; dismisses ≥150 ms after gates); `openchamber:app-ready` |
| 10 | Background | global-sessions polling 45 s; tray sync 5 s; SW changes; update polling hourly default; PWA hint toast |

### 10.2 Desktop (Electron) cold boot

| # | Step | Detail |
|---|---|---|
| 1 | Main process | start web server in-process; env `OPENCHAMBER_RUNTIME=desktop` |
| 2 | Window | frameless on win/linux; load dev-HMR or `openchamber-ui://` assets; preload args → §3.1 globals |
| 3 | Boot outcome | main computes target/status; injects on `did-finish-load` initScript |
| 4 | UI poll | 200 ms ×1.1 → 2 s cap, 50 attempts; splash text overruns |
| 5 | Shell screens | chooser / recovery via OnboardingScreen (§5.2) |
| 6 | Init | web-equivalent init (§10.1 steps 6–9) with no SessionAuthGate redirect for local pages (client token issued) |
| 7 | Relay/direct | desktop relay restore picks transport (direct probe: 1.5 s headstart before relay tunnel takeover; fresh LAN candidates hot-switch relay→direct keeping the same `host:<id>` key) |

### 10.3 VS Code boot

| # | Step | Detail |
|---|---|---|
| 1 | HTML | splash + `__VSCODE_CONFIG__` + host language |
| 2 | Bundle | webview `main.tsx`: panel type, `createVSCodeAPIs`, connection-status boot |
| 3 | App | `VSCodeApp` per panel; no `initializeApp` (deferred until managed instance reports "connected"); global-sessions polling except agentManager |
| 4 | Views | `VSCodeLayout` (sessions/chat/settings) or `AgentManagerView` |

### 10.4 Mobile (Capacitor) boot

| # | Step | Detail |
|---|---|---|
| 1 | Assets | `mobile.html` (rewritten as `index.html`) |
| 2 | Shell | surface stamp → settings hydration → widget bridge → device classes pre-paint → notifications no-op |
| 3 | Connect | no SessionAuthGate; `MobileConnectionWelcome` if no saved instance; else auto-connect last (probe/redeem) |
| 4 | App | `MobileApp` shell (+ tablet size class); push registration (`useNativePushRegistration`) |

### 10.5 In-flight read coalescing (every runtime)

Rule: method `GET`, URL matches `/api/(config|path|app\/agents|agent|project|command)`,
no URL containing `/event`, caller without an AbortSignal (or Request) → identical
concurrent fetches share one promise; every caller receives `response.clone()`; map
entry removed as soon as the request settles (never a stale cache).
(src: packages/ui/src/lib/runtime-fetch.ts:233-258, 300-322)

### 10.6 Shell-level background polls (consolidated)

| Poller | Interval | Notes |
|---|---|---|
| Global sessions | 45 000 ms | `useGlobalSessionsPolling` (sync-owned behavior, 04) |
| Tray status | 5 000 ms | `useTraySync` (desktop) |
| Terminal keepalive | 10 min | `touchSessions` so the server idle sweep does not reap visible terminals |
| Push visibility beacon | 20 000 ms heartbeat | reports `visible|hidden`+focus; server focus-gates pushes |
| Update polling | clamp(300 000 … 86 400 000) default 3 600 000 ms | suggested by `nextSuggestedCheckInSec` |
| URL-token proactive refresh | `expiresAt − 10 000 − 5 000` while consumers > 0 | HP-8 |
| Auto message-queue hold reassert | 2 min | queue ownership |

---

## 11. Runtime endpoint / instance switching

### 11.1 The mechanism

- Module state: `activeApiBaseUrl`, `activeRuntimeKey`. Keys:
  - `local` when API base origin === `__OPENCHAMBER_LOCAL_ORIGIN__`;
  - `host:<id>` for desktop hosts;
  - `url:<normalized-origin>` otherwise (bare-origin form);
  - sentinel `mobile-disconnected` (mobile has dropped);
  - `url:default` = uninitialized. `isTransientRuntimeKey()` covers all three special
    values — caches/stores/scoped settings must not read or write under them.
- `initializeRuntimeEndpoint({apiBaseUrl, runtimeKey?})` — one-shot; ignores repeats.
- `switchRuntimeEndpoint({apiBaseUrl, clientToken?, runtimeKey?, requestHeaders?,
  relay?})` sequence (numbered):
  1. compute detail `{apiBaseUrl, previousApiBaseUrl, runtimeKey, previousRuntimeKey}`;
  2. dispatch `openchamber:runtime-endpoint-will-change`;
  3. set in-memory values; attempt to write `__OPENCHAMBER_API_BASE_URL__ / _CLIENT_TOKEN__ /
     _RUNTIME_HEADERS__` (read-only globals silently fail);
  4. `configureRuntimeUrlResolver({apiBaseUrl, realtimeBaseUrl: apiBaseUrl})`;
  5. `setRuntimeExtraHeaders` + `setRuntimeBearerToken` (generation bump invalidates
     in-flight token mints);
  6. relay: `activateRelayTunnel(descriptor)` BEFORE the token mint (the mint rides the
     tunnel), else `deactivateRelayTunnel()`;
  7. fire-and-forget `refreshRuntimeUrlAuthToken(apiBaseUrl)`;
  8. dispatch `openchamber:runtime-endpoint-changed`.

- `App` listens to the changed event → `resetAppForRuntimeEndpointChange(detail)` and
  remounts `SyncProvider` under a new `runtimeEndpointEpoch` key.
- A **same-instance transport change** (LAN↔relay for one paired device) instead calls
  `reconnectAppForTransportSwitch()`: dispose terminal transports, rebind the SDK
  (`opencodeClient.reconnectToRuntimeBaseUrl()`), reset streaming state — no store
  teardown, no remount, session/view preserved.
- Desktop relay restore: at boot, if a relay host id is known, direct address is probed
  with a **1.5 s headstart** before the relay tunnel takes over; after a relay switch
  settles (5 s delay) a background refresh asks the server
  `GET /api/client-auth/connection/candidates` for current LAN addresses (identity-gated
  by the pinned `serverId`), updates the stored direct address, and hot-switches to
  direct when it probes healthy (transport change, not instance switch). `https://`
  stored addresses are never overwritten.

### 11.2 `resetAppForRuntimeEndpointChange` — store reset contract (exact)

Resets, in order: `sessionUI.prepareForRuntimeSwitch(previousKey)`; stop auto-review runs
of the previous runtime; dispose terminal transports; clear terminal store;
`opencodeClient.reconnectToRuntimeBaseUrl()`; confg store
`{providers:[], agents:[], isConnected:false, isInitialized:false, connectionPhase:'connecting',
lastDisconnectReason:null}`; projects reset; project-context (notes/todos/plans) reset
(path-derived ids can collide across instances); global sessions reset;
`replaceGlobalSessionStatusById(new Map())`; session ordering reset; activity timing
reset (restarts the resume window); permissions reset; message queue
`resetForRuntimeSwitch(runtimeKey)`; file search, git store (new key), GitHub PR status,
session folders (new key), files-view tabs (new key); **Linear + GitHub auth resets**
(auth is instance-owned, not browser-owned); quota/MCP/skills/agent-memory resets;
Linear issue list filters reapplied; `sessionUI.restoreForRuntimeSwitch(runtimeKey)`
(sessionTabs etc. are runtime-scoped); streaming state reset; queued desktop-settings
sync (`queueMicrotask`). Any new per-instance cache must join this list or become
keyed like `runtimeKey`.

(src: packages/ui/src/apps/runtimeEndpointReset.ts:1-99; packages/ui/src/lib/runtime-switch.ts:59-205;
packages/ui/src/lib/desktopRelayRestore.ts:1-191; packages/web/src/runtimeConfig.ts)

---

## 12. URL router (state ⇄ query params)

No router library. `useRouter()` performs bidirectional sync; params:

| Param | Values | Effect |
|---|---|---|
| `?session=<id>` | session id | selects the session; re-resolved against the global list to land on the right directory (cold loads may guess the active project first) |
| `?tab=` | `chat \| git \| diff \| terminal \| files` (legacy workspace-surface name) | non-chat tabs `openContextSurface(directory, mode)` into the context panel (files→`file`); `activeSurface` stays `chat` — nothing renders non-chat in the main area |
| `?settings=<section>` | slug list (14) with aliases `openchamber\|general\|preferences → home` | opens the settings window at that section; while settings is open no other route param is applied, and serialization writes only `?settings=` (returns early) |
| `?file=<path>` | URL-decodable path | with `?tab=diff` (or absent tab) opens the diff on that file |

Behavior:

- Parse tolerates unknown/empty params (null). `parseSettingsPath` lowercases;
  unknown slugs pass through for apply-time resolution (`resolveSettingsSlug`).
- Serialization includes only `?session=` plus `?settings=` when open (tab/file are
  intentionally not rewritten).
- URL updates are **skipped** in VS Code and in the embedded iframe (their identity
  params must survive); otherwise `pushState({route: state})` / `replaceState` on init
  normalization, no-op when the URL already matches.
- popstate: re-applies parsed params; bare-URL pop closes settings, keeps session.
- Route application is guarded by `isApplyingRouteRef` re-entrancy.
- Native/desktop deep links also carry the app-link confirm dialog
  (`AppLinkConfirmDialog`) and shared-commands trust dialog at App root.

(src: packages/ui/src/lib/router/*.ts; packages/ui/src/hooks/useRouter.ts:41-254)

Other URL-affecting params (summary):

| Param | Owner | Effect |
|---|---|---|
| `?surface=desktop|mobile` | hosted surface | forces/locks the app tree; disables reload watcher when present |
| `?ocPanel=session-chat` (+identity params) | embedded chat | full iframe contract §8 |
| `?startupTrace=1` | startup trace | debug |
| `?pwa_name=|app_name=|appName=` | manifest name | persists + rebuilds manifest |
| `?settings=…` (PWA shortcut, e.g. `appearance`) | router | opens settings |

---

## 13. Desktop app shell inventory (MainLayout)

### 13.1 Region tree

```
MainLayout (desktop + web)
├─ CommandPalette (global ⌘K host; renders MainLayout-only)      [shortcuts in 14]
├─ HelpDialog, OpenCodeStatusDialog (debug), SessionDialogs, SessionWorktreeMoveConfirmDialog
├─ TitlebarLeftControls (persistent: sidebar toggle + project actions; survives header animation)
├─ Sidebar (left; SettingsSidebar? no → SessionSidebar content, topBar=SidebarTopBar)
│   └─ SessionSidebar (projects, folders, recent, sessions; drag-to-reorder; worktree menu)
├─ Header (project bar + controls + session search + usable window controls)
├─ main area
│   ├─ ChatView (absolute inset-0; invisible while a surface page is open)
│   ├─ MultiRunLauncher (z-10 overlay page; replaces chat while open)
│   ├─ ScheduledTasksDialog (full-page), ArchiveView, WorktreesView
│   └─ ContextPanel (right work surfaces; keep-alive panes; see 13.2)
├─ ContextPanelRail (48-px-ish vertical rail far right)
├─ SettingsWindow (lazy; windowed dialog; mount-after-first-open; blur backdrop)
└─ Toaster (sonner) / ConfigUpdateOverlay / AboutDialog (App-level, gated above init)
```

Component responsibilities (selection):

| Region | Responsibility / UI contract |
|---|---|
| `SessionSidebar` | sessions/projects/folders/recent listing; draft layer handled by the sync session store; `useSessionListSync({isVSCode:false})` mounted in MainLayout |
| `Header` | window drag region (Electron), session title, model/agent chips, status indicators, search; height hosts macOS traffic-light offset |
| Surface pages (`isSurfacePageOpen`) | any of scheduled-tasks/archive/worktrees/multi-run open ⇒ chat is `invisible` (not just covered) and `active=false`; selecting a session or opening a draft closes all surface pages (`closeMainSurfaces()`; also on draft identity change) |
| Settings | lazy `SettingsWindow` mounted only after first open (closed it still stays mounted for close animation); route `?settings=` integrates |
| Device | `useDeviceInfo()` syncs `useUIStore.isMobile` for responsive rails |

### 13.2 Context-panel surfaces registry (exact data)

| id | mode | icon | availability | default width fraction | label key | hidden when |
|---|---|---|---|---|---|---|
| `context` | context | donut-chart-fill | always | 0.45 | contextPanel.mode.context | — |
| `git` | git | git-branch | always | 0.4 | layout.rightSidebar.git | — |
| `pr` | pr | github | always | 0.45 | contextPanel.mode.pr | GitHub not connected (OAuth or `gh` CLI detected) |
| `diff` | diff | arrow-left-right | always | 0.6 | contextPanel.mode.diff | — |
| `walkthrough` | walkthrough | route | always | 0.6 | contextPanel.mode.walkthrough | VS Code, or viewport < 768 px |
| `linear` | linear | linear | always | 0.45 | contextPanel.mode.linear | Linear workspace not connected |
| `editor` | file | file-edit | always | 0.6 | contextPanel.mode.files | — |
| `terminal` | terminal | terminal-box | always | 0.6 | layout.mainTab.terminal | — |
| `notes` | notes | book-marked | always | 0.6 | contextRail.surface.notes | — |
| `plan` | plan | file-text | always | 0.45 | contextPanel.mode.plan | plan-mode feature flag off |
| `browser` | browser | global | always | 0.45 | contextPanel.mode.browser | VS Code (no Chromium host) |
| `chat` | chat | chat-4 | **has-content** | 0.45 | contextPanel.mode.chat | no open chat tab |

Invariants (owner: surfaces registry):

- Rail order is user-reorderable (`useUIStore.contextRailOrder`), persisted, unknown ids
  dropped, missing appended in default order.
- User may hide surfaces (`contextRailHiddenSurfaces`, edited via
  `ContextRailSurfacesDialog`); hidden ones are also removed from digit shortcuts
  (`switch_context_surface` — 14 owns the keybind); badge digits and shortcut targets
  come from the same `getVisibleContextRailSurfaces` filter so they always agree.
- `has-content` surfaces stay visible while any tab of their mode exists (never
  disappear under the user), and are hidden until one exists.
- Per-surface widths: default `defaultWidthFraction` of the content area; manual resize
  persists per directory/mode (`contextPanelByDirectory[dir].widthFractionByMode`,
  last-pixel `widthByMode`); every surface restores both across reloads.
- Content incl. walkthrough restores across reload; walkthrough requires min width 768.
- Keep-alive classes: editor/diff/browser/terminal/chat panes survive surface switching
  (open tabs, xterm session, scroll positions preserved; only the active chat iframe is
  mounted while the panel is open); singleton surfaces (git, pr, linear, notes, plan,
  context, walkthrough) remount on switch and must restore from stores/snapshots.
- Opening a surface requires only the rail, the command palette, or an in-content link
  (`openContext*` store actions); no header buttons for this.
- Linear surface: status filters (All, Backlog, To Do, In Progress, In Review, Done,
  Canceled, Duplicate) + assignee (`any|me`) + team + priority; below 520 px filters
  collapse to icons (status keeps its label); active non-default filters tint the rail
  icon `text-primary`; a persisted Linear tab survives reload until auth resolves; the
  panel closes only on a confirmed disconnect; workspace switch is not a filter.
- Runtime scope: desktop/web `MainLayout` **only**; VS Code and mobile pack their own.

### 13.3 Global overlays owned by App shell

| Overlay | Trigger | Notes |
|---|---|---|
| `CommandPalette` | `open_command_palette` (⌘K, 14) | MainLayout-mounted; VS Code shortcut opens nothing (documented gap) |
| `HelpDialog` | shortcuts overlay | lists keybinds |
| `OpenCodeStatusDialog` | debug | harness status snapshot |
| `ConfigUpdateOverlay` | config-change notification | shows when the server reports a settings/config update (04/14) |
| `AboutDialog` | settings/about | version info |
| `AppLinkConfirmDialog` / `SharedTrustConfirmDialog` | deep-link open / shared project command trust | security gates; rendered at every app root |
| `MemoryDebugPanel` | palette action `openchamber:memory-debug-toggle` / menu | perf debug only; also enables stream-perf + in-flight request tracking while open |

---

## 14. State ownership map (where state lives)

| Layer | Owner | Contents |
|---|---|---|
| Session sync | `packages/ui/src/sync/*` (SyncProvider, stores under `sync/`) | sessions, messages, permissions, questions, streaming, live status; SSE/RT pipeline; 04 owns |
| Config store | `useConfigStore` | providers, agents, models, defaults, connection phase, per-directory config caches (TTL 10 s) |
| Directory store | `useDirectoryStore` | current directory + switching overlay state |
| UI store | `useUIStore` (persisted `ui-store`) | sidebar, panels, context tabs, surface pages, theme-relevant UI bits, settings page, hidden models |
| Session UI | `useSessionUIStore` (sync/) | current session/directory, draft state, worktrees, tabs |
| Feature flags | `useFeatureFlagsStore` | plan-mode etc. |
| Update store | `useUpdateStore` | server update availability + runtime type |
| GitHub/Linear auth stores | per integration | instance-owned credentials state |
| Persisted prefs | `persistence.ts` + settings registry (14) | appearance, fonts, model prefs, directory prefs; localStorage-backed |
| Desktop hosts | `desktopHosts.ts` | `{hosts, defaultHostId, initialHostChoiceCompleted}`, each host `{id, apiUrl, clientToken?, requestHeaders?, relay?}` |

URL identity for instance connection: window globals (§3.1) + runtime-switch module
state; the SDK client rebinds on change (`reconnectToRuntimeBaseUrl` clears scoped
clients, config cache, directory caches). SDK request timeout 30 s; health 4 s;
config TTL 10 s.

---

## 15. Build pipeline & development workflow

### 15.1 Root scripts (exact)

| Script | Does |
|---|---|
| `bun run dev` / `dev:web:hmr` | `scripts/dev-web-hmr.mjs`: web API server (Bun, `dev:server:watch`) on `OPENCHAMBER_HMR_API_PORT` default **3902** + Vite dev UI on `OPENCHAMBER_HMR_UI_PORT` default **5180** (host override `OPENCHAMBER_HMR_HOST`; strictPort; `OPENCHAMBER_DISABLE_PWA_DEV=1`); clears `packages/web/node_modules/.vite*` first; kills children in SIGINT→TERM→KILL ladder (macOS children detached) |
| `dev:web:full` | `scripts/dev-web-full.mjs` (build & watch variant of API server + UI) |
| `dev:web` / `dev:web:server` | build/server watch individually |
| `oc-dev` | interactive menu + non-interactive actions (build-deploy-web, remote-deploy-web, start-web-dev, start-mobile-dev, mobile-tools, start-electron-app, prepare-opencode-cli, build-electron-app, start-vscode-extension, install-vscode-extension-local, create-release). Ports: global **2606**, testing **1202**; personal config `~/.config/openchamber/oc-dev.json` |
| `electron:dev` / `electron:dev:bundled` | HMR dev Electron / packaged-assets mode |
| `vscode:dev` | watchers + Extension Development Host |
| `mobile:*` | build/sync/add/simulator/electron-free workflows (11) |
| `build` | `--filter '!@openchamber/mobile' build` + mobile `build:assets` |
| `type-check` / `lint` / `test` | workspace-wide; tests run isolated per package (UI via `run-isolated-tests.mjs`) |
| `settings-registry:generate` | regenerates the settings registry snapshot that gates writes (14) |
| `dead-code` | knip report (non-blocking) |

### 15.2 Web Vite build facts

- Inputs: `index.html`, `mobile.html`, `mini-chat.html`; output `dist`.
- React with `babel-plugin-react-compiler` (root + dev deps).
- PWA: `injectManifest` strategy, `sw.ts` (`registerType autoUpdate`,
  `injectRegister: false`, no plugin manifest — index.html owns it, glob
  `**/*.{js,css,html,ico,png,svg,woff,woff2,ttf,otf,eot,wasm}`, rollupFormat `iife` for
  iOS reliability; dev SW enabled unless `OPENCHAMBER_DISABLE_PWA_DEV=1`).
- Custom chunk pins (both matter for cold-start): `vendor-react`, `vendor-zustand`,
  `vendor-opencode-sdk`, `vendor-markdown`, `vendor-base-ui`, per-package
  `vendor-*`; **dynamic-only** (never merged): `@shikijs/langs`, `@shikijs/themes`,
  `@codemirror/legacy-modes`, `@pierre/diffs`; vite preload helper in its own
  `vendor-vite-runtime` chunk (otherwise Shiki's oniguruma engine joins the eager graph).
- Dev proxy (vite dev server, default API target port `OPENCHAMBER_PORT || 3001`):
  `/auth`, `/health`, `/linear`, `/api` (with ws).
- defines: `process.env = {}`, `global = globalThis`,
  `__APP_VERSION__ = web package version` (used by chunk-reload signatures).
- Theme JSON HMR plugin: theme file edits send WS event `openchamber:theme-updated`
  (`main.tsx` re-dispatches as `openchamber:theme-hmr`) and cancel page reload.

### 15.3 Electron pipeline (numbered)

1. `build:web-assets` — build `packages/web`, stage into
   `packages/electron/resources/web-dist` (`openchamber-ui://app` serves this).
2. `prepare:opencode-cli` — download/cache pinned OpenCode CLI (version =
   root `@opencode-ai/sdk` version; override `OPENCHAMBER_OPENCODE_CLI_VERSION`)
   into `resources/opencode-cli`; verify `opencode --version`.
3. `bundle:main` — bundle `dist-bundle/main.mjs` (keep `@openchamber/web`, `bun-pty`,
   `node-pty`, native modules **external**).
4. `rebuild:native` — rebuild native modules against Electron.
5. `package.mjs` — electron-builder (`afterPack` stages macOS icon assets); artifacts:
   dmg+zip (macOS), NSIS installer (Windows; `latest.yml` x64 / `latest-arm64.yml`
   arm64 channels), AppImage (Linux x64/arm64; `OPENCHAMBER_TARGET_ARCH` must match
   host; identity stable: executable `openchamber`, `openchamber.desktop`,
   `StartupWMClass=openchamber`).
6. Linux verify: `verify:linux-appimage` (ELF arch, desktop identity, pinned CLI,
   native `.node` modules).

Managed OpenCode binary resolution order (desktop): settings `opencodeBinary` → env
`OPENCODE_BINARY`/`OPENCODE_PATH`/`OPENCHAMBER_OPENCODE_PATH`/`OPENCHAMBER_OPENCODE_BIN`
→ bundled CLI → PATH → known npm/bun/homebrew/scoop/choco locations → platform discovery
(`where opencode` / login shell).

### 15.4 Mobile pipeline

`build` = build `packages/web` + `build:assets` (copy dist, rewrite mobile.html→
index.html); `sync` = assets + `cap sync`; simulator/device scripts per 11; iOS requires
CocoaPods; Android JDK 21 + SDK 35; `serve-sim` browser preview streams the simulator.

### 15.5 Packaging `@openchamber/web` (npm/CLI users)

`files: [dist, server, bin, public, package.json, README.md]`; `bin.openchamber`
→ `bin/cli.js`; `openchamber serve` = `node bin/cli.js serve`. Data/ports and CLI
behavior belong to 03.

---

## 16. Correctness invariants enforced at shell scope

1. **One origin, one instance.** UI traffic goes only to the active instance origin;
   harness traffic is proxied under `/api`. Backend serves must never let a UI window
   reach a different instance implicitly.
2. **Boot gating is authoritative, never guessed** — desktop splash requires the
   injected, validated boot outcome; a malformed outcome is deterministic terminal
   state, never a silent retry.
3. **Fail open for docs-only reads, fail closed for privileged actions** — project
   config read failure resolves to the empty setup (worktree creation and drafts keep
   working); native file access requires the local desktop bridge + local origin; remote
   pages can only reach `COMMANDS_SAFE_FOR_REMOTE`.
4. **The URL auth token must never clear while in use** — mints swap atomically
   (previous token stays valid until replacement), proactive refresh fires before the
   10 s skew window, and refresh is only scheduled while consumers are active.
5. **Read coalescing never invents data** — only overlapping in-flight identical GETs
   share a promise; no cache; aborted callers excluded.
6. **Switching instances must not leak per-instance state** — the §11.2 reset list is
   exhaustive; caches not in it must be runtime-keyed. Integrations (GitHub/Linear) are
   re-asked after switch rather than trusted.
7. **Transient runtime keys are forbidden namespaces** — no persisted per-instance
   state under `''`, `url:default`, `mobile-disconnected`.
8. **Surface stamping happens once**; post-boot surface drift = full reload (800 ms
   debounce) because app trees are not safe to swap in place.
9. **Embedded identity survives navigation** — never rewrite `?ocPanel=…`-style URLs;
   router skips URL sync in VS Code and embedded iframes.
10. **Recovery is always reachable** — initialization retry ends in a manual-retry
    screen (5 s non-desktop splash fallback; HTML 10 s fallback for non-desktop origin
    only); desktop recovery prefers `desktop_restart` over page reload when the local
    origin is not yet active.
11. **Chunk failures recover exactly once per signature per 30 s** and never navigate
    inside VS Code.
12. **Credentials never enter iframe URLs**; the embedded bootstrap travels over
    same-origin-checked postMessage only.
13. **Splash text is never black-box** — connect failures, malformed boot outcomes, long
    desktop startups each have distinct user-visible text.

---

## 17. Traceability index (source of truth for every contract above)

| Topic | Source (read-only citation) |
|---|---|
| Product goals/surfaces | README.md; packages/docs/content/docs/quickstart.mdx, install.mdx |
| Package/deps | packages/*/package.json |
| Web entrypoints | packages/web/index.html, src/main.tsx, src/mobile-main.tsx, src/mini-chat-main.tsx, src/sw.ts, src/runtimeConfig.ts, src/api/* |
| Runtime plumbing | packages/ui/src/lib/{runtime-switch,runtime-url,runtime-auth,runtime-fetch,runtimeSurface,desktopBoot,desktop,desktopHosts,desktopRelayRestore,vscodeBootstrap,openchamberConfig,connectionPayload,pwa,background-network,chunkLoadRecovery,device,platform,startupTrace}.ts |
| SDK client | packages/ui/src/lib/opencode/client.ts |
| Boot/init | packages/ui/src/App.tsx, apps/{AppEffects,runtimeEndpointReset,ElectronMiniChatApp,MobileApp,VSCodeApp}.tsx, apps/appBootReady.ts |
| Surfaces registry | packages/ui/src/lib/surfaces/{registry.ts,DOCUMENTATION.md}; components/layout/* |
| Router | packages/ui/src/lib/router/*, hooks/useRouter.ts |
| Auth gate | packages/ui/src/components/auth/SessionAuthGate.tsx |
| Updates | packages/ui/src/lib/web-update.ts, hooks/useUpdatePolling.ts, hooks/usePwaInstallPrompt.ts |
| VS Code | packages/vscode/src/{webviewHtml.ts,DOCUMENTATION.md}, webview/main.tsx, webview/api (stub terminal) |
| Electron | packages/electron/{main.mjs,preload.mjs,README.md} |
| Mobile | packages/mobile/{capacitor.config.ts,README.md}, packages/ui/src/apps/{mobileConnections,mobileAppContext,deepLinkNavigation,useNativePushRegistration}.ts* |
| Build/dev | package.json, scripts/{oc-dev,dev-web-hmr,dev-web-full}.mjs, packages/web/vite.config.ts |
| Control stream | packages/ui/src/lib/openchamberEvents.ts |
| Config store boot | packages/ui/src/stores/useConfigStore.ts (initializeApp/checkConnection) |
| Health flag | packages/web/server/index.js (`planModeExperimentalEnabled`) |
