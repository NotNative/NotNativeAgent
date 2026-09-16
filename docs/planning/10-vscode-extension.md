# NotNativeDesktop Reference — 10. VS Code Extension

Complete re-implementation specification for the `packages/vscode` surface of OpenChamber:
a VS Code extension that embeds the shared OpenChamber UI in three webview hosts, runs an
agent-harness (OpenCode) server as a managed child process, and acts as the extension-host
side of a message bridge that replaces the filesystem/server the web UI normally talks to.

Audience: engineers with zero access to the source repository. Everything needed to
implement the mechanism is inline; `(src: packages/vscode/...)` citations are for
traceability only.

Cross-references (do not re-spec here):

- **01 shared-UI adaptation layer** owns `RuntimeAPIs` — the consumer-facing API surface
  (`git`, `files`, `settings`, `permissions`, `notifications`, `github`, `tools`,
  `editor`, `vscode`, `terminal`) and the render entrypoint this extension binds to.
  This document specifies what the extension implements **behind** those APIs.
- **02 harness contract** owns the OpenCode HTTP/SSE API surface itself. VS Code-specific
  lifecycle pieces are tagged `[HARNESS PORT]` here.
- **03 OpenChamber server** owns the server product. The extension does **not** run it.
- **05 chat UI** owns the chat consumers of these messages.
- **12 goals/multirun** owns the Agent Manager product behavior; this doc owns only the
  extension-side host that renders it.
- **14 settings/theme** owns the settings registry and shared theme tokens; this doc owns
  only the extension-specific persistence gate, and Editor-theme integration.

---

## A. Extension architecture

### A.1 Package identity and manifest skeleton

`packages/vscode/package.json` (src):

| Field | Value |
|---|---|
| name / displayName | `openchamber` / `OpenChamber` |
| publisher | `fedaykindev` |
| version | `1.23.0` (tracked in VS Code CHANGELOG; regenerated at release — see L) |
| engines.vscode | `^1.85.0` |
| main | `./dist/extension.js` (esbuild-bundled CJS, `external: vscode`) |
| l10n | `./l10n` |
| categories | `Programming Languages`, `Machine Learning`, `Other` |
| icon | `assets/app-icon.png` |
| dependencies | `@openchamber/ui` (workspace), `@opencode-ai/sdk` 1.18.30, `react` 19, `react-dom` 19, `jsonc-parser`, `yaml`, `adm-zip` |

Activation events (exactly three):

```
onCommand:openchamber.openSidebar
onCommand:openchamber.attachExplorerToChat
onView:openchamber.chatView
```

Everything else (editor-tab panels, right-click commands on files not yet opened) is
lazily reachable only after one of these fired — e.g. inline comments are **not
available** until the extension activated via command palette/sidebar/explorer attach.

### A.2 Layout of the extension host

```
src/extension.ts                 activation, command registration, wiring
src/opencode.ts                  [HARNESS PORT] harness process lifecycle (A.4, E)
src/opencode-ready.ts            readiness gate for URL handout
src/opencodeProcessRegistry.ts   on-disk orphan-prevention registry (shared with server)
src/opencodeAuth.ts              provider auth storage (~/.local/share/opencode/auth.json)
src/opencodeConfigPaths.ts       global config dir (XDG)
src/opencodeConfig.ts            agents/commands/MCP/plugins/skills/providers CRUD on config files
src/skillsCatalog.ts             git-clone-based skill marketplace catalog
src/opencode-upgrade-runtime.ts  capability check + self-upgrade flow
src/bridge.ts                    thin delegating bridge dispatcher (A.5)
src/bridge-*-runtime.ts          domain runtimes, each owning a message family
src/ChatViewProvider.ts          sidebar webview view provider
src/SessionEditorPanelProvider.ts editor-tab chat panels (multi-panel manager)
src/AgentManagerPanelProvider.ts  Agent Manager editor tab
src/activePanelRouting.ts        pure "which panel gets a payload" pick
src/sessionActivityWatcher.ts    global SSE watcher for session busy/idle phases
src/InlineCommentThreads.ts      editor comment controller (gutter +, right-click)
src/inlineCommentSelection.ts    pure logic for comment threads (unit-tested)
src/gitService.ts                git/worktree operations (F)
src/git.d.ts                     vscode.git API type shim
src/sseProxy.ts                  upstream-only SSE pipe w/ stall watchdog
src/settings-files.ts            pure split/marshal of settings.json + preferences.json
src/settings-registry-gate.ts    generated-registry write gate
src/settings-registry.json       generated snapshot (204 fields)
src/project-setup.ts             pure personal/shared project config rules (server mirror)
src/bridge-project-setup-runtime.ts store over ~/.config/openchamber/projects/
src/webviewHtml.ts               CSP'd HTML + splash for the webview
src/webviewCachedStateRetry.ts   staggered re-send of cached state
src/webviewDevServer.ts          dev-mode HMR URL resolution
src/theme.ts, src/shikiThemes.ts theme-kind name + contributed-theme JSON extraction
src/pathUtils.ts                 Windows drive-letter normalization
src/workspaceResolver.ts         dedup+sort workspace folder candidates
src/workingDirectoryChange.ts    pure working-dir change decision
src/networkDefaults.ts           5s default socket connect attempt timeout
src/provider-env-aliases.ts      [HARNESS PORT] env aliasing (re-export of server module)
src/quotaProviders.ts, quotaCredentials.ts, ollamaQuota.ts, opencodeGoQuota.ts, exeDevQuota.ts  quota stack (H)

webview/                          the bundled webview app (Vite)
webview/main.tsx                  fetch() interceptor, RuntimeAPIs wiring, command handlers
webview/api/bridge.ts             acquireVsCodeApi wrapper, request/response + SSE client
webview/api/*.ts                  RuntimeAPIs implementations (each delegates to bridge)
webview/requestBodyTransport.ts   body extraction for intercepted fetches
webview/inlineCommentTarget.ts    where a delivered comment is filed
webview/inlineCommentRemovals.ts  tombstone list for removal-before-delivery races
```

### A.3 Webview hosts

All three hosts render the same shared app (`renderVSCodeApp` → `VSCodeApp` for `panelType:
'chat'`; `AgentManagerView` for `panelType: 'agentManager'`) and boot with different
`window.__VSCODE_CONFIG__` fields (A.8):

| Host | View type | Shape | panelType | viewMode | Reachable |
|---|---|---|---|---|---|
| `ChatViewProvider` | `openchamber.chatView` | sidebar webview view | `chat` | `sidebar` | via `onView` activation |
| `SessionEditorPanelProvider` | `openchamber.sessionEditor` | editor tab (createWebviewPanel) | `chat` | `editor` | via commands (not in `views` contribution) |
| `AgentManagerPanelProvider` | `openchamber.agentManager` | editor tab | `agentManager` | — | via commands |

- Sidebar: `retainContextWhenHidden: true`; `localResourceRoots: [extensionUri, <ext>/dist]`.
- Editor tabs: `ViewColumn.Beside` (session editor) / `ViewColumn.One` (agent manager),
  `retainContextWhenHidden: true`, tab icon `assets/icon.svg` / `icon-titlebar.svg`.
- Session editor panels are a **multi-panel manager**: a `Map<panelId, state>`, where the
  panel id is either a session id (existing session) or `new_<ts>_<rand>` (new-session
  draft). `createOrShow(sessionId)` reveals an existing panel (retitling it);
  `createOrShowNewSession()` always makes a fresh draft panel. Each panel is a separate
  webview with its own webview message routing and its own SSE stream set.

### A.4 OpenCode manager (single source of runtime truth)

`createOpenCodeManager(context)` returns the `OpenCodeManager` interface consumed by all
three providers and several runtimes:

```
start(workdir?), stop(), restart()
setWorkingDirectory(path) -> {success: true, path} | {success:false, error}
getStatus(): 'disconnected' | 'connecting' | 'connected' | 'error'
getApiUrl(): string | null
getOpenCodeAuthHeaders(): Record<string,string>   // Authorization header only
getWorkingDirectory(): string
isCliAvailable(): boolean
getDebugInfo(): OpenCodeDebugInfo
onStatusChange(cb): Disposable   // fires cb synchronously with current status
```

Full lifecycle (spawn/health/auth/config/upgrade) is section E.

### A.5 Bridge architecture (extension host)

`bridge.ts` is deliberately thin. It receives `{id, type, payload}` and delegates in this
exact order, first return wins:

1. `handlePermissionAutoAcceptBridgeMessage` — `api:permission-auto-accept:get|set`
2. `handleStandardGitBridgeMessage` — 40+ `api:git/*` routes (F)
3. `handleSpecialGitBridgeMessage` — `api:git/pr-description`, `api:git/conflict-details`
4. `handleProjectSetupBridgeMessage` — `api:project-setup:get|update|update-shared`
5. `handleFsBridgeMessage` — fs/files routes (D)
6. `handleConfigBridgeMessage` — settings/config/skills routes (D)
7. `handleSystemBridgeMessage` — system/editor/quota/provider routes (D)
8. `handleProxyBridgeMessage` — generic OpenCode HTTP proxy (D)
9. Fallthrough: 19 `api:github/*` types answered with a hard "backend disabled" error;
   anything else → `{success:false, error:"Unknown message type: <type>"}`.

Special provider-level routes handled **before** the bridge by each webview host (with
their own response envelope): `restartApi`, `api:sse:start`, `api:sse:stop`, and
`inlineComments:sync` (one-way notification, no response). `vscode:command` is also
intercepted by the session editor provider for exactly one command:
`openchamber.updateSessionEditorTitle` (retitles the tab and echoes a success response;
every other `vscode:command` falls through to the system runtime).

Implementation rule (replicate): a handler returns `null` to decline ownership; the
dispatcher continues. New route families must become new `bridge-*-runtime.ts` modules
with injected dependencies — `bridge.ts` stays orchestration-only.

Every response is the same envelope:

```
{ id, type, success: boolean, data?: unknown, error?: string }
```

Errors thrown inside any runtime are caught at the dispatcher and returned as
`{success:false, error: message}` — never as an unhandled rejection into the webview.

### A.6 Bridge architecture (webview side)

`webview/api/bridge.ts`:

- Acquires `acquireVsCodeApi()` once at first use. If the API is missing (broken slots:
  Cursor after an update, VSCodium, headless), a no-op API drops messages with a single
  console warning instead of throwing.
- `sendBridgeMessage(type, payload, {timeoutMs=30000, signal, onAbort})` mints
  `id = req_<counter>_<Date.now()>`, stores the resolver in a pending map, posts
  `{id, type, payload}`, and resolves when a message with the same `id` arrives.
  `timeoutMs: 0` disables the timer (used by the proxy and session-message bridges).
- On every response that carries a `_msgId`, the webview immediately posts
  `{type:'bridge:ack', _msgId}` — the extension's retry-confirmation protocol (C.4).
- `postBridgeNotification(type, payload)` sends without creating a pending entry (used
  for `inlineComments:sync`, which has no response).
- Abort handling: an `AbortSignal` on a request removes the pending entry and posts
  `{id:'abort_<reqid>', type:'api:proxy:abort', payload:{requestID: <reqid>}}`.
- The webview never reaches the harness directly except through the `window.fetch`
  interception layer (A.7) and the SDK used by the activity watcher (E.6).
- `onCommand(command, handler)` registers webview-side handlers for `{type:'command'}`
  messages; `onThemeChange(handler)` for `themeChange`.

### A.7 The webview fetch() interception layer

`webview/main.tsx` replaces `window.fetch`. Any request whose pathname is under `/api`
(or exactly `/auth/session`) is routed locally first, then proxied:

```
1. /health (exact)                       → local status JSON (connection state mirror)
2. handleLocalApiRequest(...)            → ~40 locally-served routes (D.8)
3. if locally handled → return Response
4. if not under /api → original fetch
5. /api/event | /api/global/event (GET)  → SSE proxy stream (C.5)
6. POST /api/session/<id>/message        → api:session:message bridge (serialized body, 45 s upstream timeout)
7. everything else under /api            → api:proxy bridge (base64 or text body)
8. hostname contains 'models.dev'        → api:models/metadata bridge (empty {} on error)
```

URL / body handling:

- Paths are normalized (collapse `//`); the proxy receives `pathname+search` with the
  leading `/api` stripped (`suffixPath`).
- Headers: `Request` headers merged with `init` headers through a sanitizer
  (`sanitizeHeadersForBrowser` from the shared UI) into a plain record.
- Directory hint: `?directory=` query, or `x-opencode-directory` header (decoded only when
  the matching `x-opencode-directory-encoding: uri` header says `uri`).
- Bodies: `extractBodyBase64` for `Request`/`init` bodies (chunks of 0x8000 through
  `btoa`), `extractBodyText` for text/JSON needs; `GET/HEAD` never carry bodies.
- Responses: null-body statuses 204/205/304 return `new Response(null, …)`;
  `bodyText` returned as text when present; otherwise `bodyBase64` decoded via `atob`.

### A.8 Bootstrap globals injected into the HTML

`window.__VSCODE_CONFIG__`:

```
workspaceFolder   — first workspace folder path (drive-letter normalized)
workspaceFolders  — [{name, path}] sorted by name, deduped
theme             — 'light' | 'dark'
connectionStatus  — cached ConnectionStatus at HTML build time
cliAvailable      — boolean, from the manager
extensionVersion  — package.json version (shown by /api/system/info)
platform, arch    — os.platform()/os.arch()
panelType         — 'chat' | 'agentManager'
viewMode          — 'sidebar' | 'editor' (chat hosts only)
initialSessionId  — session id for an editor chat panel, else null (or absent)
```

Plus:
- `window.__OPENCHAMBER_HOME__` — same as workspaceFolder (backslash→slash normalized,
  drive letter upper-cased in the webview). Also seeded into `localStorage.lastDirectory`
  and `homeDirectory`, and `directoryTreeShowHidden='true'`,
  `filesViewShowGitignored='false'` defaults.
- `window.__OPENCHAMBER_HOST_LANGUAGE__` — `vscode.env.language`. The UI reads it as the
  default locale until the user saves one (`detectInitialLocale`), and the pre-bundle
  splash picks its strings from it.
- The splash (inline HTML, C.2) reads the user's own saved
  `localStorage['openchamber.i18n.v1']` first, then the host language.

### A.9 Network defaults

Before registering anything, activation calls `applyConnectAttemptTimeout()`, which sets
`net.setDefaultAutoSelectFamilyAttemptTimeout(5000)`. This is an extension-host
process-wide Node setting shared with every Node connection in the host; it exists so
quota requests to distant providers can connect, mirroring the web runtime. Address-family
selection is otherwise untouched. (src: `networkDefaults.ts`)

### A.10 Sidebar auto-move (first run)

On first activation per machine (Cursor-like hosts excluded via `/\bcursor\b/i` test on
`vscode.env.appName`): look up the user's move-to-secondary-sidebar command across naming
variants (`workbench.action.moveViewToSecondarySideBar`, `...SecondarySidebar`,
`...FocusedViewToSecondarySideBar(dbar)`, `workbench.action.moveViewToAuxiliaryBar`, plus
fuzzy matches containing workbench.action+move+view and secondary/auxiliary), then after
800 ms: focus `openchamber.chatView`, run the move command. The attempt flag is
`globalState['openchamber.sidebarAutoMoveAttempted']` — one-shot forever.

### A.11 Legacy cleanup

Activation clears `openchamber.apiUrl` when it matches
`^https?:\/\/localhost:4768\d\/?$` — ports 47680–47689 were auto-assigned by older
extension versions and must not pin the current extension. (src: `extension.ts:134-138`)

---

## B. Full contribution surface

### B.1 Commands (17 contributed)

Category `OpenChamber` for all. Behavior specified here is authoritative.

| Command id | Title (nls key) | Behavior | Palette/menu |
|---|---|---|---|
| `openchamber.openSidebar` | Open Sidebar | `workbench.view.extension.openchamber` then `openchamber.chatView.focus`; if the webview is not yet resolved, shows a warning "Chat sidebar is not ready" and returns `false` | yes |
| `openchamber.focusChat` | Focus Chat | openSidebar flow + 80 ms bootstrap wait + `focusChatInput` command into webview; warns if webview disposed | not in palette (registered) |
| `openchamber.restartApi` | Restart API Connection | Prefer full in-app reload: `ChatViewProvider.reloadOpenCode()` posts `command:'reloadOpenCode'` (overlay + bridge `/api/config/reload` + data refresh). If no sidebar webview resolved: bare `manager.restart()` + info message | yes |
| `openchamber.showOpenCodeStatus` | Show OpenCode Status | Writes a diagnostic block to the "OpenChamber" output channel and reveals it (D.10 for content) | yes |
| `openchamber.openAgentManager` | Open Agent Manager | `agentManagerProvider.createOrShow()` | title bar `$(circuit-board)` |
| `openchamber.openActiveSessionInEditor` | Open Active Session in Editor | Opens `activeSessionId` (tracked via `openchamber.setActiveSession`) in an editor panel; info message when none | title bar `$(link-external)` |
| `openchamber.openNewSessionInEditor` | Open New Session in Editor | `createOrShowNewSession()` (new draft panel) | editor/title `navigation@1` + title bar |
| `openchamber.openCurrentOrNewSessionInEditor` | Open Session in Editor | Active session if set, else new session panel | title bar `$(link-external)` |
| `openchamber.openSessionInEditor` | (not contributed) | args `(sessionId, title)` → `createOrShow` | runtime-only |
| `openchamber.setActiveSession` | (not contributed) | args `(sessionId, title)` → caches the active session for the above | runtime-only, invoked from webview |
| `openchamber.addToContext` | Add to Context | Active editor selection → `{filePath: fsPath, filename:"rel:l-r", text}`. Routing: active session panel first, else reveal sidebar and `addContextSelection`. Files target the sidebar relativePath broadcast format so the attachment dedupes against the active-editor pin suggestion | editor context submenu |
| `openchamber.attachExplorerToChat` | Attach to OpenChamber Chat | Explorer context (files only, `resourceScheme == file && !explorerResourceIsFolder`); collects `{filePath, fileName, fileSize}`, dedupes URIs, skips folders/unsupported with an info notice | explorer/context |
| `openchamber.explain` | Explain | Builds prompt `Explain the following Code / Text:\n\n<rel>:<range>\n```\n<langId>\n<selection>\n```` (or `<rel>` alone for whole file) and sends via `createSessionWithPrompt` routing | editor context submenu |
| `openchamber.improveCode` | Improve Code | Same shape with `Improve the following Code:`; requires a selection | editor context submenu |
| `openchamber.addLineComment` | Add Comment | Gated by `canCommentOn` (workspace files only); opens a thread on the active selection | editor context submenu |
| `openchamber.submitLineComment` | Comment | `openchamber.submitLineComment` receives a `CommentReply` (typed text) → `InlineCommentThreads.submitReply` | comment thread context (hidden from palette) |
| `openchamber.removeLineComment` | Remove Comment | Thread title `$(close)` → removes thread + tells webview to drop the draft | comment thread title (hidden from palette) |
| `openchamber.newSession` | New Session | args `(directory?)`. Empty folder case → info message. Multi-root prompts a quick-pick; single root autoselects. Calls `manager.setWorkingDirectory(folder)` and posts `newSession` with `{directory, workspaceFolders}` including the picked folder even if not a workspace folder | view/title `$(add)` |
| `openchamber.showSettings` | Settings | posts `showSettings` (sidebar reloads to settings view) | view/title `$(settings-gear)` |

Runtime-only internal commands, **not** in `package.json`:

| Command | Purpose |
|---|---|
| `openchamber.internal.settingsSynced` | after a successful `api:config/settings:save`, providers re-broadcast merged settings to every active webview (`command:'settingsSynced'`) |
| `openchamber.internal.permissionAutoAcceptSynced` | after a permission-policy write, broadcast the committed snapshot to every active webview |
| `openchamber.internal.inlineCommentsSync` | webview draft snapshots → `InlineCommentThreads.reconcile(surfaceId, drafts)`; snapshots without a surfaceId are ignored |

Keybindings: none are contributed; all interaction is through commands/menus.

### B.2 Views and containers

```
viewsContainers.activitybar: [{ id: "openchamber", title: "OpenChamber", icon: "assets/icon.svg" }]
views.openchamber:           [{ type: "webview", id: "openchamber.chatView", name: "%views.chat.name%" }]
```

The editor-tab providers are not views; they are plain `WebviewPanel` factories.

### B.3 Menus

- `editor/context`: `openchamber.submenu` (label "OpenChamber"), group `navigation`.
- Submenu `openchamber.submenu` order: `explain`, `improveCode`, `addToContext`,
  `addLineComment`.
- `explorer/context`: `attachExplorerToChat`,
  `when: resourceScheme == file && explorerResourceIsFolder == false`, `navigation@50`.
- `editor/title`: `openNewSessionInEditor`, `navigation@1` (uses the extension icon
  light/dark pair).
- `view/title` (all `when: view == openchamber.chatView`): `newSession` `navigation@1`,
  `openCurrentOrNewSessionInEditor` `navigation@2`, `openAgentManager` `navigation@3`,
  `showSettings` `navigation@4`.
- `commands/commentThread/context`: `submitLineComment`, group `inline`,
  `when: commentController == openchamber.inlineComments`.
- `commands/commentThread/title`: `removeLineComment` `$(close)`, group `navigation`,
  `when: commentController == openchamber.inlineComments && commentThread == openchamberAttached`.
- `commandPalette`: `submitLineComment` and `removeLineComment` gated with `when: false`.
  The controller id `openchamber.inlineComments` must match the JSON gate — the ids are
  duplicated by hand because JSON cannot import them.

### B.4 Configuration keys (both)

| Key | Default | Purpose / where consumed |
|---|---|---|
| `openchamber.apiUrl` | `""` | URL of an external harness API. Non-empty ⇒ external attach mode: manager reports `connected` immediately at start and never spawns (E.2). Also read by "Show OpenCode Status" (`configuredApiUrl`). Legacy ports 47680–47689 cleared on activation. |
| `openchamber.opencodeBinary` | `""` | Absolute path to the `opencode` CLI. Consumed by `resolveOpencodeCliPath` and `validateConfiguredOpencodeBinaryForManagedStart`; "Requires window reload/restart to apply" per its description. Also read from the shared `~/.config/openchamber/settings.json` `opencodeBinary` key as a second candidate. Settings expose it to the shared UI through `readSettings().opencodeBinary` (undefined when empty). |

Both live under the `openchamber` configuration title.

### B.5 Localization resources (extension host)

Two bundles; both must be complete for every locale (VS Code silently falls back to
English per missing key, so a partial translation looks like a shipped feature; a test
enforces that — see L.4):

- `package.nls.json` — manifest `%token%` strings (23 keys). Locales: `package.nls.fr.json`, `package.nls.tr.json`. Keys: `extension.description`, `views.chat.name`,
  `command.*.title` (17 entries covering the contributed commands),
  `configuration.apiUrl.description`, `configuration.opencodeBinary.description`.
- `l10n/bundle.l10n.json` — `vscode.l10n.t(...)` call-site strings (28 keys in English;
  `fr`, `tr` variants). Covers command error/info toasts, Explain/Improve prompt
  templates, comment thread labels (`Comment on line {0}`, `Comment on lines {0}-{1}`),
  "Not sent yet", "More Info", spawn failure text.

Mechanism: `"l10n": "./l10n"` in the manifest; `const t = vscode.l10n.t` at module top;
placeholders `{0}`/`{1}` must be preserved identically across locales.

The **webview** has its own splash messages fixed in the generated HTML (en/fr/tr, C.2);
the shared UI bundle handles its own localization after boot.

---

## C. Webview protocol specification

### C.0 Envelopes

Extension → webview, request/response:

```
BridgeResponse: { id, type, success: boolean, data?, error?, _msgId? }
_msgId is set only on responses produced by _sendMessageWithRetry (all postAPI bridge
responses from ChatViewProvider; other hosts post without _msgId but the webview still
acks only what it receives).
```

Extension → webview, one-way:

```
{ type: 'connectionStatus', status: 'disconnected'|'connecting'|'connected'|'error', error?: string }
{ type: 'themeChange', theme: { kind: 'light'|'dark', shikiThemes: {light?, dark?} | null } }
{ type: 'command', command: string, payload?: object }
{ type: 'api:sse:chunk', streamId: string, chunk: string }
{ type: 'api:sse:end', streamId: string, error?: string }
{ type: 'openchamber:session-activity', properties: { sessionId, phase: 'idle'|'busy'|'cooldown' } }
```

Webview → extension, request/response (request envelope `{id, type, payload}`):

```
{ type: 'bridge:ack', _msgId: string }         (no response)
{ type: 'restartApi' }                          (no response; manager.restart())
{ type: 'api:sse:start', payload: {path, headers?, streamId?} }
{ type: 'api:sse:stop',  payload: {streamId} }
{ type: 'inlineComments:sync', payload: {drafts: [{id, text}]} }   (no response)
{ type: 'vscode:command', payload: {command, args[]} }
'api:proxy:abort'   payload {requestID}
... plus every bridge message type in D.
```

### C.1 Command catalog (extension → webview `command:*`)

| Command | Payload | Webview effect |
|---|---|---|
| `focusChatInput` | — | focuses the composer |
| `addContextSelection` | `{filePath, filename, text}` | `inputStore.addVSCodeSelectionAttachment(path, File)`; then focus |
| `addFileAttachments` | `{files: [{filePath, fileName, fileSize}]}` | `inputStore.addVSCodeFileAttachment` per file |
| `addFileMentions` | `{paths: string[]}` | composer text gets `@path` mentions appended |
| `addLineComment` | `{draftId?, filePath, relativePath, source:'diff'|'file', side?, startLine, endLine, code, language, comment, targetSessionId?}` | files a draft in the inline-comment store (C.6) |
| `removeLineComment` | `{draftId}` | tombstone + store removal search |
| `createSessionWithPrompt` | `{prompt}` | creates a session draft and sends; falls back to prefilled text when no model configured |
| `newSession` | `{directory?, workspaceFolders?}` | opens a new-session draft (optionally pinned to directory/project); dispatches navigate-to-chat |
| `workspaceFoldersChanged` | `{workspaceFolders}` | resyncs the projects store |
| `showSettings` | — | navigate to settings view |
| `settingsSynced` | merged settings document | re-syncs shared persistence in the webview |
| `permissionAutoAcceptSynced` | `{sessions, revision}` | applies into the permission store |
| `reloadOpenCode` | — | full reload overlay + `api:config/reload` + refresh (used by the restart command and after upgrades) |
| `windowFocusChanged` | `{focused}` | gates `requireHidden` notifications / document.hasFocus() substitute |
| `activeEditorFile` | `{filePath, fileName, relativePath, fileSize, selection:{startLine,endLine,text}} | null` | drives the composer's pin-selection suggestion; `null` clears it |
| `showNotification` | `{title?, body?, sessionId?, tag?, requireHidden?}` | Web Notifications path (D.9) |

### C.2 HTML shell, CSP, and splash

`getWebviewHtml` builds the page (src: `webviewHtml.ts`):

- CSP (`default-src 'none'`) with:
  - `style-src`: `webview.cspSource`, `'unsafe-inline'`, dev-server origin
  - `script-src`: `webview.cspSource`, `'unsafe-inline'`, `'unsafe-eval'`, dev origin
  - `connect-src`: `*`, `ws:`, `wss:`, `http:`, `https:`, dev origin
  - `img-src`: `cspSource`, `data:`, `https:`, dev origin
  - `font-src`: `cspSource`, `data:`, dev origin
  - `worker-src`: `cspSource`, `blob:`, dev origin — the ONLY `blob:` allowance.
    Shared-UI parsers (fflate async inflate) run in blob-backed workers; blob scripts in
    `script-src` remain prohibited.
- In production the app loads `dist/webview/assets/index.js` via `webview.asWebviewUri`.
- A `process` polyfill (`window.process = {env:{NODE_ENV:'production'}, ...}`) precedes it.
- An inline pre-bundle splash: animated cube + OpenCode mark (glowing via
  `@keyframes`, `prefers-reduced-motion` respected), an empty status line that only
  shows on error, and a CLI-missing line when `cliAvailable === false`.
- Splash logic: `connectionStatus` messages update `#loading-status` (only error text is
  visible); the whole overlay fades out once the UI app has mounted **and** status hit
  `connected` (or `error`/`disconnected`). The boot decision "usable content is behind the
  overlay" deliberately does not wait for provider/agent fetches — per-widget loaders
  cover the tail. (src: `main.tsx` `maybeHideLoadingOverlay`)
- Dev mode (development builds, `OPENCHAMBER_VSCODE_WEBVIEW_URL` or default
  `http://localhost:5173`, skip with `OPENCHAMBER_DISABLE_WEBVIEW_HMR=1`): the shell
  imports `/@vite/client`, `/@react-refresh` (wiring `injectIntoGlobalHook` and the
  `$RefreshSig$` preamble), then `/main.tsx`, waits for `#root` children (4 s timeout,
  retries every 500 ms on failure, showing "waiting for dev server… attempt N").

### C.3 State bootstrap and the cached-state retry (webviewHtml + webviewCachedStateRetry)

Invariant: VS Code drops `postMessage` calls made before the webview's
`acquireVsCodeApi` bridge is ready (code-server, flaky networks). Therefore:

1. Every provider sends its cached state immediately on resolve: `connectionStatus`
   (status+error) and `windowFocusChanged`.
2. `scheduleCachedStateRetries` re-sends at **staggered delays [500, 1500, 3500, 7000,
   12000, 20000] ms**, but only while `status === 'connected'` (retries only make sense
   for the connected transition; payload is idempotent), and only while the target
   webview is still the current one (a replaced view/panel invalidates its callbacks).
   Triggered at: view resolve, and on every `updateConnectionStatus` where the new status
   is `connected`.
3. `ChatViewProvider._lastActiveEditorFilePayload` dedupes active-editor broadcasts; a
   leaving editor schedules a `null` broadcast with a 200 ms clear timer.
4. Selection-change broadcasts debounce 150 ms.

Session editor panels specifically: comments delivered to a panel whose script has not
booted are held in `pendingLineComments` (a **list**, not a slot, because a second comment
can be written while the panel is still starting). Any inbound message proves the
webview script runs (`webviewReady = true`) and drains the hold, posting each as
`command:'addLineComment'` with `targetSessionId`.

### C.4 Delivery confirmation + retry for responses

Only `ChatViewProvider` arms the ack protocol: every bridge response gets a `_msgId`
(`msg_<ts>_<rand>`), is tracked in `_pendingMessages`, and is re-sent up to `_MAX_RETRIES
= 3` if the webview does not ack within `_MESSAGE_TIMEOUT = 5000` ms (`bridge:ack` with
the same `_msgId` clears it). On `postMessage` returning false ("webview rejected
delivery") a linear backoff retry (100 ms × (attempt+1)) re-sends. After 3 failures the
message is dropped with a console error. Rationale: an unanswered response would leave a
webview promise pending until its own 30 s timeout.

### C.5 SSE proxy protocol

Request (webview): `api:sse:start` with `{path, headers?, streamId?}`.

- The webview **allocates** the id itself: `sse_webview_<Date.now()>_<n>` and installs
  its stream listener BEFORE awaiting the start response, so an immediate reconnect
  replay cannot race the bridge response. The extension accepts an id matching
  `^sse_webview_\d+_\d+$`; otherwise it mints `sse_<n>_<ts>`.
- The extension calls `openSseProxy({manager, path, headers: SSE defaults + auth headers,
  signal, onChunk})` where SSE request defaults are
  `Accept: text/event-stream, Cache-Control: no-cache, Connection: keep-alive` merged
  before the webview's headers and after the harness auth headers (order: defaults,
  caller headers, auth).
- Response: `{success:true, data:{status, headers, streamId}}` or
  `{status:502|503, headers:{content-type:application/json}, streamId:null, error?}` —
  503 when no manager, 502 when opening the upstream failed.
- Stream deltas are pushed as `{type:'api:sse:chunk', streamId, chunk}` (UTF-8 strings,
  TextDecoder `{stream:true}`) and termination as `{type:'api:sse:end', streamId,
  error?}`. The webview enqueues chunks into a `ReadableStream` and closes/errors it on
  `end`, then posts `api:sse:stop` itself. Abort of the proxied request or stream cancel
  also stops the upstream.
- Upstream-only stall watchdog: quiet for `stallTimeoutMs` (default **20 s**) cancels the
  reader and throws swallowed as a stall; the shared sync layer reconnects rather than
  trusting an open-but-silent stream.
- Reconnect policy inside `openSseProxy`: up to `MAX_RECONNECTS = 3` with exponential
  backoff (1 s, 2 s, 4 s) on initial connect failure and on `UND_ERR_SOCKET`/`ECONNRESET`
  mid-stream. Path normalization: only `/event` and `/global/event` allowed; a missing
  `directory` query on `/event` is filled with the manager's working directory (or
  `'global'`). Response headers exposed to the webview are just `content-type` and
  `cache-control` from the upstream.
- Disposal: provider `onDidDispose` / panel dispose aborts all streams tracked in the
  provider's `_sseStreams`/`sseStreams` map for that view.

The generic `api:proxy` **rejects** SSE paths: `/event` and `/global/event` via
`api:proxy` answer `{status:400, error:'SSE requests must use api:sse:start'}`.

### C.6 Inline comment drafts (cross-layer pipeline)

Extension side (`InlineCommentThreads` + `inlineCommentSelection.ts`):

- Controller id `openchamber.inlineComments`; commenting ranges = whole file for
  workspace documents (`canCommentOnDocument(scheme, inWorkspace)`: scheme `comment`
  never allowed; the file must resolve to a workspace folder).
- Real path for `git:` documents: `resolveCommentFilePath(fsPath, uriQuery)` parses the
  URI query JSON `{path}` and prefers it (diff original side).
- Origin: `resolveCommentOrigin(uri, scheme, activeDiff)` — diff `original`/`modified`
  when the active tab is a `TabInputTextDiff` matching this URI; `git:` scheme ⇒
  `diff/original`; else `file`. Captured before any await.
- Line range: `selectionLineRange` — 1-based; a selection ending at character 0 on a
  later line does not count that line.
- Draft id minted extension-side: `icd-<now>-<rand36>` so thread and chip agree on
  identity without a round trip.
- Submission routing: active session panel (`addLineCommentToActivePanel`) → returns its
  surface id; else sidebar via `openSidebar` flow (surface id `'sidebar'`). Adding from
  the command path (right-click) does not use holds (panel is revealed); restoring
  panels use holds.
- A submitted thread: `canReply=false`, `contextValue='openchamberAttached'`, comment
  label "Not sent yet", body rendered as plain text (MarkdownString `appendText` — user
  prose must not be markdown-rendered), 30 s confirmation deadline
  (`DELIVERY_CONFIRMATION_TIMEOUT_MS`). If the composer never reports holding the draft:
  retract everywhere (`removeDraft`), dispose the thread, tell the user it was discarded.
- Reconciliation: webview sends whole draft lists as `inlineComments:sync`
  `{snapshot:{drafts:[{id,text}]}, surfaceId}` (panel providers stamp the surfaceId;
  the sidebar stamps `'sidebar'`). `snapshotOwnsThread` — only the owning surface's
  snapshot decides a thread. `reconcileThreadFate(text, confirmed)`:
  - absent + confirmed ⇒ dispose; absent + unconfirmed ⇒ wait (delivery may be in flight);
  - empty text ⇒ dispose; else show/update body (no-op when text unchanged), clear the
    deadline.

Webview side:

- `inlineCommentTarget.ts` decides the draft key `{directory, sessionKey}` from one
  store snapshot: if `targetSessionId` is present (session panel), wait (poll every
  250 ms, up to 80 attempts ≈ 20 s) until `currentSessionId === targetSessionId`, then
  key `{sessionDirectory ?? currentDirectory, sessionId}`. Sidebar/new-session panels
  file on the current session or the open draft (`sessionKey:'draft'`). Filing before
  the session is visible used to land drafts under a key the composer never reads.
- `inlineCommentRemovals.ts` — tombstones (max 50, FIFO) for `removeLineComment` arriving
  before the draft lands; `consume(draftId)` closes the window.
- Publish: the draft store subscription flattens all drafts `{id, text}` and posts a
  whole-list signature-diffed `inlineComments:sync` notification on every change
  (sending a message empties the list — threads clear through this same path).

### C.7 Window state, permissions sync, settings sync

- `onDidChangeWindowState` fans `windowFocusChanged` to all three providers.
- Settings save: after `api:config/settings:save` succeeds, the provider executes
  `openchamber.internal.settingsSynced` with the response data; each provider
  re-broadcasts `settingsSynced` to its webviews; each webview calls shared persistence
  re-sync (`syncDesktopSettings({adoptTheme:false})`).
- Permission auto-accept: `api:permission-auto-accept:set` returns and broadcasts the
  exact committed snapshot `{sessions: Record<sessionId, boolean>, revision}`.

---

## D. Bridge runtime catalog

### D.1 Permission auto-accept runtime

`bridge-permission-auto-accept-runtime.ts`. Storage: `context.globalState` key
`permissionAutoAccept`, snapshot shape `{sessions: {[sessionId]: boolean}, revision}`.

- `api:permission-auto-accept:get` — normalized read (bad shapes drop silently to
  `{sessions:{}, revision:0}`), under the operation lock.
- `api:permission-auto-accept:set` — payload `{sessionId: string, enabled: boolean}`.
  Read-modify-write (revision + 1), broadcast to every active OpenChamber webview via
  the internal command, return the snapshot. All operations are serialized per context
  with a promise-queue (WeakMap-keyed), so concurrent writes can't interleave.
- Rationale: replies to permission requests stay foreground/UI-owned because VS Code does
  not run the OpenChamber server runtime; the policy is the only state that must survive
  webview recreations. Errors: "sessionId is required", "enabled must be a boolean",
  "Extension context is unavailable".

### D.2 Git runtimes (see F for mechanics)

`bridge-git-runtime.ts` — standard routes. Every route requires `payload.directory`
unless noted. Route table with payload/response fields:

| Type | Payload | Data |
|---|---|---|
| `api:git/check` | directory | bool |
| `api:git/worktree-type` | directory | bool (linked worktree) |
| `api:git/status` | directory, mode? `'light'` | GitStatusResult (F.3) |
| `api:git/branches` | directory; method GET/POST/DELETE; name, startPoint, force | GET: {all, current, branches}; POST/DELETE: {success, branch} |
| `api:git/branch-push-status` | directory, branches: string[] (≤5 deduped) | {counts: {branch: number}} |
| `api:git/remote-branches` | directory, branch, remote? | {success} (push --delete) |
| `api:git/checkout` | directory, branch | {success, branch} |
| `api:git/worktrees` | directory; method GET/POST/DELETE; POST body = CreateGitWorktreePayload; DELETE body.directory + deleteLocalBranch | GET: GitWorktreeInfo[]; POST: create result; DELETE: {success} |
| `api:git/worktrees/validate` | directory, payload | {ok, errors[{code,message}], resolved{mode, localBranch}} |
| `api:git/worktrees/bootstrap-status` | directory | {status, phase, error, updatedAt} |
| `api:git/worktrees/preview` | directory, payload | GitWorktreeInfo (name/branch/path reserved) |
| `api:git/validate-directory` | directory, worktreeRoot | {valid, insideWorktreeRoot, resolvedWorktreeRoot, resolvedCwd} |
| `api:git/canonicalize-worktree-state` | directory | {worktreeRoot, cwd, branch, headState:'branch'|'detached'|'unborn', worktreeStatus:'ready'|'missing'|'invalid'|'not-a-repo', legacy:false, degraded:false, attentionReason?} |
| `api:git/diff` | directory, path, staged?, contextLines? | {diff} |
| `api:git/file-diff` | directory, path, staged? | {original, modified, path} |
| `api:git/revert` | directory, path, scope? 'all'|'working' | {success:true} |
| `api:git/stage` | directory, path(s) | {success:true} |
| `api:git/unstage` | directory, path(s) | {success:true} |
| `api:git/apply-hunk` | directory, path, patch, action 'stage'|'unstage'|'discard' | {success:true} |
| `api:git/commit` | directory, message, addAll?, files?, stageFiles? | GitCommitResult {success, commit, branch, summary} |
| `api:git/push` | directory, remote?, branch?, options? | {success, pushed:[{local,remote}], repo, ref:null} |
| `api:git/pull` | directory, remote?, branch?, rebase? | {success, summary, files, insertions, deletions} |
| `api:git/fetch` | directory, remote?, branch? | {success} |
| `api:git/stashes` | directory | {stashes:[{ref,message,relativeTime,hash}]} |
| `api:git/stashes/file-counts` | directory, refs[] | {counts} |
| `api:git/stash` | directory, message? | {success, created, message, output} |
| `api:git/stash/apply|pop|drop` | directory, ref? | {success, ref} (default `stash@{0}`) |
| `api:git/remotes` | directory; method GET/DELETE (remote) | GET: GitRemote[]; DELETE: {success} |
| `api:git/rebase` | directory, onto | {success, conflict?, conflictFiles?} |
| `api:git/rebase/abort` / `merge/abort` | directory | {success} |
| `api:git/rebase/continue` / `merge/continue` | directory | {success, conflict, conflictFiles?} |
| `api:git/checkout-commit` | directory, hash (7–40 hex) | {success} |
| `api:git/cherry-pick` / `revert-commit` | directory, hash | {success, conflict, conflictFiles?} |
| `api:git/reset-to-commit` | directory, hash, mode soft/mixed/hard, force? | {success} (hard refuses dirty tree unless force) |
| `api:git/log` | directory, maxCount? (default 50), from?, to?, file?, all? | {all: GitLogEntry[], latest, total} |
| `api:git/commit-files` | directory, hash | {files:[{path, insertions, deletions, isBinary, changeType}]} |
| `api:git/commit-file-diff` | directory, hash, path, binary | {original, modified, isBinary} |
| `api:git/identity` | directory; GET or POST {userName, userEmail, sshKey?, signCommits?, signingKey?} | GET: GitIdentitySummary|null; POST {success} |
| `api:git/ignore-openchamber` | — | {success:true} (no-op in VS Code) |

`bridge-git-special-runtime.ts`:

- `api:git/pr-description` — payload `{directory, base, head, context?, providerId?,
  modelId?, zenModel?}`. Lists range files (`base...head`), collects per-file diffs with
  3 context lines, builds a strict JSON-drafting prompt (title ≤80 chars, body with
  Summary/Testing/Notes), generates text through the harness with
  `generateBridgeTextWithSessionFlow` (creates a temp session titled "Git Generation",
  `session.promptAsync`, polls `session.messages` every 500 ms scanning for the newest
  assistant message with `finish==='stop'`, timeout 2 min, deletes the temp session in
  `finally`). Model choice (`bridge-git-generation-model.ts`, pure + unit-tested):
  1. payload `providerId/modelId` when present in the model catalog (30 s cached
     `model.list` via SDK v2, 8 s timeout);
  2. settings `smallModelOverride` (`provider/model`, first-slash split) when
     `smallModelUseDefault === false` and present in catalog;
  3. zen fallback: `{providerID:'zen', modelID: payloadZenModel || settings.zenModel ||
     'gpt-5-nano'}`. The old `gitProviderId`/`gitModelId` pair is not read.
  Response: `{title, body}` parsed from fenced JSON; unparsable → `{title:'', body:raw}`.
- `api:git/conflict-details` — payload `{directory}`. Data:
  `{statusPorcelain, unmergedFiles (diff-filter=U), diff, headInfo ('MERGE_HEAD: <sha>' +
  MERGE_MSG | 'REBASE_HEAD: <sha>'), operation:'merge'|'rebase'}`.

`bridge-git-process-runtime.ts` — the `execGit` helper the bridge injects into fs/special
runtimes: spawns `git` with `windowsHide`, env = process.env + `GIT_TERMINAL_PROMPT:'0'`
+ `SSH_AUTH_SOCK` fallback (existing env wins, else `~/.gnupg/S.gpg-agent.ssh` if a
socket, else `gpgconf --list-dirs agent-ssh-socket`, launching gpg-agent and retrying;
Windows returns undefined). gitService keeps its own identical copy (uses the
`vscode.git`-resolved git binary path).

### D.3 Local filesystem proxy helpers

`bridge-localfs-proxy-runtime.ts`:

- Serves, by intercepting before the generic proxy: `GET|HEAD` only.
  - `/api/fs/stat` (alias `/fs/stat`) → `{path (slash-normalized), isFile:true, size,
    mtimeMs}`, `cache-control: no-store`.
  - `/api/fs/read` (alias `/fs/read`) → UTF-8 text, `text/plain; charset=utf-8`.
  - `/api/fs/raw` (alias `/fs/raw`) → binary base64, mime from extension map
    (png/jpg/jpeg/gif/webp/svg/text-md/markdown/mmd/mermaid/json/pdf; default octet-stream).
- `/api/fs/directory-stat` → **501** "Directory availability probes are not supported
  in the VS Code runtime" (stays unknown rather than falling through to OpenCode).
- `/api/openchamber/sessions/<id>/markdown-image-grants` → **501** (grant route
  unsupported; workspace-contained Markdown gallery images use the local fs routes
  instead, and OpenCode temp-dir images get an explicit unsupported response).
- Auth model: `resolveFileReadPath(targetPath, directory?)` (src:
  `bridge-fs-helpers-runtime.ts`) — resolve `~`/relative against the requested root
  chosen from: the workspace folder equal to the requested `directory`, else the first
  workspace folder, else `os.homedir()`; check path containment `isPathInside(resolved,
  baseRoot)`; then `realpath` and return the canonical path. Outside-workspace paths ⇒
  403 "Access to file denied"; ENOENT ⇒ 404. `?optional=true` turns a 404 on `stat`
  into `{status:200, body:{path, exists:false}}` (so availability probes without a
  directory-stat endpoint still work).
- Shared proxy utilities exported to the proxy runtime: `base64EncodeUtf8`,
  `collectHeaders(Headers)`, `sanitizeForwardHeaders` (drops `content-length`, `host`,
  `connection`), `buildUnavailableApiResponse` (503 JSON `{error:'OpenCode API
  unavailable'}`).

### D.4 Generic proxy runtime

`bridge-proxy-runtime.ts`:

- `api:proxy` payload `{method?, path?, headers?, bodyBase64?}` → proxied fetch to
  `<harness-url>/<path>`, response `{status, headers (minus content-length/
  content-encoding/transfer-encoding), bodyText? (json/text/+json), bodyBase64?}` forwarded
  under `success:true`; fetch errors become `{status:502, bodyText:{error}}`.
  Connection: `waitForApiUrl(manager)` (E.3) makes invalid responses impossible while
  startup is in flight; null ⇒ 503 unavailable envelope.
- In-flight read coalescing (parity with the web runtimeFetch): GET only, path matching
  `^\/(config|path|app\/agents|agent|project|command)(\b|\/|\?|$)` — cold start fires the
  same idempotent bootstrap reads concurrently; coalescing shares one fetch and copies
  response payloads per caller. Entries are removed as soon as the request settles
  (never serves stale). No AbortController on the shared read — `api:proxy:abort` cannot
  cancel it (read is fast/idempotent).
- Non-coalesced requests hold an `AbortController` keyed by message id;
  `api:proxy:abort {requestID}` aborts (the requestID is the triggering request id).
- `api:session:message` payload `{path, headers?, bodyText}` — POST, strict path regex
  `^\/session\/[^/]+\/message(?:\?.*)?$`, 45 s ceiling via `AbortSignal.timeout`, sync'd
  abort propagation, errors mapped: timeout ⇒ 504 "OpenCode message forward timed out",
  other ⇒ 503.
- SSE paths rejected with 400 (C.5).

### D.5 Config & skills runtime

`bridge-config-runtime.ts` (OpenCode config file CRUD lives in `opencodeConfig.ts`,
which aliases the same files the OpenCode CLI reads):

Config layer model `[HARNESS PORT]`:

- Global config dir: `OPENCODE_CONFIG_DIR = $XDG_CONFIG_HOME/opencode || ~/.config/opencode`
  (resolved once at module import; `opencodeConfigPaths.ts`).
- JSONC reads (`jsonc-parser`) merge three layers: global `config.json`,
  project `<workdir>/.opencode/config.json`, and `process.env.OPENCODE_CONFIG` custom
  file. Parse failures fail **closed** (`INVALID_JSONC` coded error): a broken layer is
  omitted from the merge, recorded in `layerErrors`, and a partial/non-object parse tree
  must never let a mutation rewrite a `$schema`-only stub over an existing config.
  Comment-only files read as empty; content that yields no JSON value (YAML, plain
  text) fails closed. Writes refuse to overwrite a broken layer (recorded errors gate).
- Projects: `<workdir>/.opencode/agents` (fallback legacy `.opencode/agent`),
  `commands`, global `agents/` and `commands/` dirs under the config dir; snippets in
  `<config>/snippet|snippets/*.md` (name pattern `[a-z0-9][a-z0-9_-]{0,79}`, `#tag`
  expansion, max 15 expansions; `{file:...}` directive support).

Routes:

| Type | Notes |
|---|---|
| `api:config/opencode-resolution:get` | parity data for shared Settings: `{configured (from VS Code setting), resolved (cliPath), resolvedDir, source 'settings'|'env'|'path', detectedNow, detectedSourceNow, shim:null, viaWsl:false, node: process.execPath, bun:null, wsl*:null}` |
| `api:config/settings:get` / `api:config/settings:save` | see D.6 |
| `api:behavior/agents-md:get` / `:save` | global `<OPENCODE_CONFIG_DIR>/AGENTS.md`, 1 MB cap; GET `{content, exists, path}` (path always included — shared Settings shows it in a warning when the file is missing); save returns the deferred-restart envelope. (src: `opencodeConfigPaths.ts` doc) |
| `api:magic-prompts:get|save|reset|reset-all` | file `~/.config/openchamber/magic-prompts.json` `{version:1, overrides:{id:text}}`; id pattern `^[a-z0-9._-]{1,160}$`; visible-prompt ids (`*.visible`) must be non-empty; text cap 200 000 chars |
| `api:config/reload` | `manager.restart()` (serialized), response `{restarted:true}` — the "Apply & Restart OpenCode" button |
| `api:config/agents` | method GET/POST/PATCH/DELETE; `{name, body?, scope?, directory?}`; GET `{name, sources (md/json paths+fields), scope, isBuiltIn}`; mutations return deferred-restart |
| `api:config/commands` | same shape |
| `api:config/mcp` | GET list or named; POST/PATCH/DELETE with `body.scope` user/project; writes MCP server config into config layers |
| `api:config/plugins` | `target` list/registry/entry/file. GET list: `{entries: PluginEntry[], files: PluginFile[]}`; registry: per-spec npm/path status (`npm-ok|npm-missing-version|npm-missing-package|npm-malformed|npm-network|path-ok|path-missing|path-unreadable`), `?specs=a,b`, `?refresh=true`; entry CRUD (POST create, PATCH update, DELETE, GET) — responses use the deferred restart; file CRUD `POST/PUT/DELETE /api/config/plugins/file(:id)` |
| `api:config/snippets` | GET list / named; POST create (scope 'global'|'project'); PATCH update; DELETE; POST with no name = **expand** (body.text); snippet behavior parity with the CLI |
| `api:config/skills` | GET all (API skills merged with locally discovered; each tagged `renamable` when the path is managed under the working dir); GET named `{name, sources, scope, source}`; POST create (body.scope user/project, body.source 'opencode'|'agents'); PATCH update or `renameTo` (rename restarts immediately with `reloadDelayMs` instead of the deferred envelope); DELETE |
| `api:config/skills:catalog` | `getSkillsCatalog(workingDirectory, refresh, additionalSources, installedSkills)` — sources come from settings `skillCatalogs` (`[{id,label,source,subpath?}]`), plus the built-in catalog; manages cache freshness |
| `api:config/skills:scan` / `:install` | git-and-probe based: shallow-clone source repo (`--depth 1 --filter=blob:none --no-checkout`, fallback without filter) into temp, scan skill dirs, install selected with conflict policy (`prompt|skipAll|overwriteAll` + per-skill decisions), scope user/project, targetSource `opencode|agents`; install response carries `installed/skipped` + deferred-restart when anything installed |
| `api:config/skills/files` | GET/PUT/DELETE supporting files inside a skill dir (`{name, filePath, content}`) |

Mutation response envelope (src: `config-mutation-response.ts`) — the same shape on
every OpenCode-config mutation:

```
{ success:true, requiresReload:false, requiresRestart:true, restartDeferred:true,
  message: "... Restart OpenCode to apply." }
```

Writes persist to disk immediately; the UI accumulates pending changes and applies them
once via `api:config/reload`. Skill rename and provider upsert are the exceptions (both
force an immediate restart, see below).

### D.6 Settings persistence runtime

`bridge-settings-runtime.ts` + pure `settings-files.ts` + `settings-registry-gate.ts`.
This is the parity surface with the OpenChamber server's settings store; keep byte
compatibility.

Files (cross-surface shared, always under `<home>/.config/openchamber/` on every
platform — `os.homedir()` joined, not `%APPDATA%`; only the `install-id-vscode` file in
D.7 switches to `%APPDATA%\openchamber` on Windows):

- `settings.json` — instance facts + legacy keys.
- `preferences.json` — `{version:1, fields:{key:{value?, updatedAt, surfaces?}}}`, holds
  every registry-`profile` key. `updatedAt` stamped only when a value actually changes.
- `magic-prompts.json` — overrides (D.5).

Read model:

- Merged view: settings.json ⊕ preferences (preferences win). Missing preferences.json
  is **seeded once** from profile keys still in settings.json. An existing but
  unparseable preferences.json is a **failure, not empty**: never seeded over or
  rewritten; one warning per process; reads return settings.json only; writes drop the
  profile part until a later read succeeds (`preferencesUnavailable` latch).
- settings.json parse failure coerces to `{}` (next write replaces it).
- Writes are atomic (tmp + rename) and throw on failure, so a failed save rejects and
  the webview sees "save failed" instead of silent success.
- Surface kind: this host is always `vscode`, so writes to per-surface profile keys land
  under `fields[key].surfaces.vscode`; reads resolve `vscode` first, base otherwise.
  Every write also writes a legacy copy of profile base values into settings.json so
  pre-split builds still read them (current builds ignore the copy).

Migration: `globalState['openchamber.settings']` is the legacy store. On first read per
process, keys present in globalState but missing from disk are migrated to disk
fire-and-forget; reads merge `{...globalState, ...disk}` (disk wins).

Registry gate (`settings-registry-gate.ts`, generated snapshot
`src/settings-registry.json`, regenerated by the root script
`bun run settings-registry:generate` → `packages/ui/src/lib/settings/registry-snapshot.ts`):

- The snapshot is `{version:1, fields: Record<key, {scope: 'profile'|'instance'|'device',
  perSurface?, derived?, computed?, secret?, local?, owner?, surfaces?}>}` — 204 fields
  in the current build.
- Write path filter `filterPersistableSettingsChanges`: only keys the registry lists,
  without `computed:true`, without `local:true`, and without `owner === 'desktop-shell'`
  ever reach the shared files. Unknown keys are dropped silently. If the snapshot is
  stale (UI registry changed, snapshot not regenerated), brand-new user-visible keys
  would vanish on save while the webview keeps them in memory — this is the classic
  "setting doesn't persist" bug the invariant protects against. Device keys never
  persist on either side.
- Read path filter `withoutSecretSettings`: keys marked `secret:true` are write-only
  (accepted on save, never handed back — UI passwords and tunnel tokens). Of 204 fields:
  30 `local`, 3 `secret`, 5 `computed`, 13 `perSurface`, plus all `desktop-shell`-owned
  ones and desktop-only `surfaces:['desktop']` instance keys which naturally never
  apply here.

Serialization rules (`sanitize` in `persistSettings`, replicate exactly):

- Derived fields `themeVariant` and `lastDirectory` are never persisted; recomputed at
  read (themeVariant from the active theme kind, lastDirectory = first workspace folder).
- Empty-string values clear and delete these keys:
  `defaultModel, defaultVariant, defaultAgent, defaultGitIdentityId, opencodeBinary,
  smallModelOverride, walkthroughModelOverride`.
- Boolean coercion drops non-boolean values for `smallModelUseDefault,
  sessionRecapEnabled, sessionSuggestionEnabled, sessionGoalEnabled,
  sessionGoalDefaultBudgetEnabled`.
- `sessionGoalDefaultBudget` must be a finite number > 0.
- `opencodeBinary` is trimmed.
- Returns the same shape as a read (secrets withheld, derived fields re-applied).

Skills API parity: `fetchOpenCodeSkillsFromApi(ctx, workingDirectory)` GETs
`<manager-url>/skill?directory=<dir>` (8 s timeout, auth headers) and maps each skill to
`DiscoveredSkill {name, path, scope, source ('opencode'|'claude'|'agents' inferred from
the location string), description, content}`; `'<built-in>'` location keeps
`scope:'user'`. Local scope inference: a path under any project ancestor's `.opencode`,
`.claude/skills`, or `.agents/skills` is `project`; under the config dir/`~/.opencode`
etc. is `user` (see `bridge-settings-runtime.ts:71-107`). The webview merges API skills
with local discovery (`mergeDiscoveredSkills`).

### D.7 System/editor/quota/provider runtime

`bridge-system-runtime.ts`:

| Type | Data / behavior |
|---|---|
| `api:opencode/directory` | `{path}` → `resolveUserPath` against the working dir → `manager.setWorkingDirectory` → `{success:true, path}` or failure |
| `api:models/metadata` | fetch `https://models.dev/api.json` (8 s timeout) via `fetchModelsMetadata` |
| `api:opencode/version` | GET `<api>/global/health` → `{version}` (v-prefixed stripped) or `{version:null, error}`; success even when the manager is missing (`{version:null, error:'OpenCode manager unavailable'}`) |
| `api:opencode/upgrade-status` | capability + `{available, currentVersion, latestVersion, upgrade}` (E.4) |
| `api:opencode/upgrade` | `{target?}` → upgrade flow (E.4); response passthrough `{status, body}` |
| `api:session-activity:get` | snapshot `{sessionId: {type:'idle'|'busy'|'cooldown'}}` from the watcher (E.6) |
| `api:notifications:claim` | `{key}` → `{claimed}`; in-process TTL claim map (10 s) to dedupe cross-webview notifications |
| `api:zen:models` | parity handler → `{models: []}` (free-zen list intentionally empty in VS Code) |
| `api:openchamber:update-check` | POST to `OPENCHAMBER_UPDATE_API_URL` (default `https://api.openchamber.dev/v1/update/check`, 10 s timeout). Body `{appType:'vscode', deviceClass (default 'desktop'), platform (API-shaped: macos/windows/linux/…), arch (arm64/x64/unknown), channel:'stable', currentVersion (payload or package.json), installId (per-scope file `install-id-vscode` in `%APPDATA%/openchamber` or `~/.config/openchamber`, UUID, mode 0600), instanceMode (default 'local'), reportUsage}`. `installId` only when `reportUsage !== false`. |
| `editor:openFile` | `{path, line?, column?}` → `vscode.open` with a collapsed selection |
| `editor:openDiff` | `{original?, modified, label?, line?, patch?}`. With a unified-diff `patch`, reconstructs the original content by reverse-applying hunks and opens a **virtual** left side via a registered `openchamber-diff` scheme `TextDocumentContentProvider` (contents map, ≤100 entries FIFO). Reveals `line` in the modified editor and centers it. |
| `api:provider/auth:delete` | `{providerId, scope ('auth' default | user | project | custom | all), directory?}`; `all` combines auth + user + project + custom removal; responses carry the deferred-restart envelope when something was removed |
| `api:provider/source:get` | `{providerId, directory?}` → `{providerId, sources}` where `sources.auth.exists` reflects `~/.local/share/opencode/auth.json` |
| `api:provider:upsert` | `{providerID|providerId, config, scope 'user'|'project'|'custom', directory?}` — writes provider config (OpenAI Chat Completions / OpenAI Responses / Anthropic Messages style) with validation; preserves existing provider/option/retained-model fields not managed by the form; honors explicit model/header/env removal; migrates legacy `providers` entries to canonical `provider` when edited; secrets go via the harness auth API, so `config` requires `env` or stored auth; **immediately restarts the harness** and returns `{success, providerId, path, config, requiresReload:true, reloadDelayMs}` |
| `api:quota:providers` | `{providers: string[]}` — configured provider ids (H.2) |
| `api:quota:credentials` | `{providerId: 'exe-dev'|'ollama-cloud'|'cursor', method GET/PUT/DELETE/VALIDATE/IMPORT, credential?}` (H.1) |
| `api:quota:get` | `{providerId}` → ProviderResult (H.3), coalesced in-flight |
| `api:workspace:addFolder` | `{path}` → adds a workspace folder (drive-letter normalized both sides for equality), returns `{workspaceFolders}` |
| `vscode:command` | `{command, args}` → `vscode.commands.executeCommand` passthrough (the session editor intercepts `openchamber.updateSessionEditorTitle`) |
| `vscode:openExternalUrl` | `{url}` → `vscode.env.openExternal` |

### D.8 Locally-served web routes (webview-side router, `handleLocalApiRequest`)

These exist so shared UI code can keep calling plain HTTP paths; the VS Code runtime
answers them locally (either from the bridge or with deterministic stubs):

- `GET /api/system/info` → `{openchamberVersion, runtime:'vscode', platform, arch}`
- `501 unsupported` (explicit, never proxied): `/api/preview/targets`, `/api/openchamber/
  tunnel/*`, `/api/openchamber/sessions/archive` (server-side batch archiving needs the
  OpenChamber server), `/api/projects/<id>/scheduled-tasks(:id)`, `/api/fs/git-dirs`
- `GET|PUT /api/projects/<id>/config(/shared)` → `api:project-setup:get|update|update-shared`
  (D.9). GET/shared is not bridged. Errors map "must be|is required|unsupported
  characters" to 400, else 500.
- `GET /api/sessions/snapshot` → `{statusSessions:{}, attentionSessions:{},
  activitySessions:<activity>, serverTime}` (activity from the bridge; the VS Code
  runtime has no status/attention aggregates — those stay empty objects).
- `POST /api/sessions/<id>/(view|unview)` → `{success:true}`
- `GET|PUT /api/permission-auto-accept(/sessions/<id>)` → bridge (D.1)
- `POST /api/sessions/<id>/message-sent` → optimistic-success echo `{success:true,
  sessionId, messageSent:true}`
- `GET /api/session-activity` → activity map; `GET /api/sessions/status` and
  `/api/sessions/attention` → empty `{sessions:{}, serverTime}`; per-session
  `GET /api/sessions/<id>/(status|attention)` → 404 `{error:'Session not found…'}`
- `GET /api/tts/status` → `{available:false}`; `/api/tts/say/status` → `{available:false,
  voices:[]}`; `POST /api/tts/speak|say/speak` → 501 "TTS endpoints are not available in
  VS Code runtime"
- `GET /api/dictation/status` → `{provider:'local', available:false,
  reasonCode:'unsupported_runtime', models:[]}` (the mic button hides without a server);
  `/api/dictation/*` → 501
- `GET /health` and `/api/health` → `{status, isOpenCodeReady, cliAvailable}` mirror
- `GET /api/fs/list` → `api:fs:list` bridge; `POST /api/fs/mkdir` → `api:fs:mkdir`;
  `GET /api/fs/home` → `api:fs/home`
- `GET /api/vscode/pick-files` → `api:files/pick`; `POST /api/vscode/drop-files` →
  `api:files/drop`; `POST /api/vscode/save-image` → `api:files/save-image`; `POST
  /api/vscode/save-markdown` → `api:files/save-markdown`
- `/api/config/agents/:name` (+ list), `/api/config/commands/:name`, `/api/config/mcp(:name)`,
  `/api/config/snippets(/expand|:name)`, `/api/config/skills(/:name|:catalog|:scan|,
  :install|:name/files/:path)`, `/api/config/settings`, `/api/behavior/agents-md`,
  `/api/magic-prompts(:id)`, `/api/config/opencode-resolution`, `/api/config/reload`,
  `/api/config/plugins(/registry|/entry/:id|/file/:id)`, `/api/openchamber/models-metadata`
  (empty `{}` on error), `/api/opencode/version|health|upgrade-status|upgrade`,
  `/api/zen/models`, `/api/openchamber/update-check` (query params forwarded),
  `/auth/session` → `{authenticated:true, requireSetup:false, authenticatedAt}` (the host
  is trusted — mirrors the server shape so UI logic holds), `/api/opencode/directory` POST,
  `/api/quota/providers|credentials/:provider(/validate|import)|:providerId`
  (credential route regex covers only `ollama-cloud|cursor` — the exe-dev credential
  surface is intentionally not exposed in VS Code), `/api/provider/:id/auth` DELETE
  (scope query), `/api/provider/:id/source` GET, `/api/provider` PUT.
- Also outside `/api`: hostname `models.dev` requests are redirected to the
  `api:models/metadata` bridge (the extension-host fetch exists precisely so CSP and
  remote hosts do not matter).

### D.9 FS runtime routes (extension host)

`bridge-fs-runtime.ts` (injected helpers from `bridge-fs-helpers-runtime.ts`):

- `files:list {path}` and `workspace:folder` and `config:get {key}` — VS Code workspace
  convenience routes (older callers); `config:get` reads the `openchamber` configuration
  namespace.
- `api:fs:list {path?, respectGitignore?}` — resolveUserPath against workspace root
  (or home), `listDirectoryEntries` (readDirectory), normalized; with
  `respectGitignore`, runs a 2.5 s-capped `git check-ignore -- <names>` batch and filters
  entries (timeout/failure returns the unfiltered list).
- `api:fs:search {directory?, query, limit, includeHidden?, respectGitignore?}` — first
  `vscode.workspace.findFiles('**/*q*', exclude '**/{node_modules,.git,dist,build,.next,
  .turbo,.cache,coverage,tmp,logs}/**', limit)`, then a fuzzy `**/*q-j-o-i-n*` pattern for
  2–32 char queries; if both come up empty, a bounded (1.5 s budget) in-process traversal
  with fuzzy scoring (`fuzzyMatchScore`: include/position-prefix/boundary/consecutive
  bonuses), gitignored filtering via `check-ignore`, hidden-file rules, and a 10-dir
  concurrent read batch. Results carry `{name, path (absolute, slash-normalized),
  relativePath, extension}`.
- `api:fs:read {path}` / `api:fs:stat {path}` — via the same `resolveFileReadPath`
  authorization (containment before symlink resolution); stat requires is-file.
- `api:fs:write {path, content}` — creates parent dirs; `api:fs:delete {path}`
  (recursive, no trash); `api:fs:rename {oldPath, newPath}` (no overwrite);
  `api:fs:mkdir {path}`; `api:fs:home`; `api:fs:reveal {path}` (`revealFileInOS`, parses
  `://` URIs).
- `api:fs:exec {commands: string[], cwd}` — runs each command through `$SHELL -c` (or
  `cmd.exe /c` on Windows) with a 300 s command timeout, 20 MB buffers at the shell level
  (exec), sequential. A read-cache exists only for the bounded pattern
  `^git rev-parse (--absolute-git-dir|--git-common-dir|--show-toplevel){1,3}$`:
  TTL 30 s (env `OPENCHAMBER_GIT_READ_CACHE_TTL_MS`), 500 entries, 1 MB total, LRU
  semantics, in-flight dedupe (env `OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS` = 2500
  controls check-ignore caps). Response `{success: allSucceeded, results:[{command,
  success, exitCode?, stdout?, stderr?, error?}]}`.
- `api:files/pick {allowMany?, extensions?}` — `showOpenDialog` (files only, default
  workspace folder, label "Attach", extension filters) → attachments data-URLs.
- `api:files/drop {uris}` — parseDroppedFileReference: strip quotes, accept `file:` URIs
  or absolute paths; other schemes/relative paths are skipped with reasons.
- `api:files/save-image {fileName?, dataUrl}` — requires `data:image/…`, `showSaveDialog`
  (png filter), validates the data URL comma, decodes and writes. Cancelled →
  `{saved:false, canceled:true}`.
- `api:files/save-markdown {fileName?, content}` — same but for md (label "Export
  session").
- Attachment read (`readUriAsAttachment`): 20 MB cap (`MAX_FILE_ATTACH_SIZE_BYTES`),
  mime guessed from extension, data URL built as `data:<mime>;base64,<…>`.

` dinners` NOTE: `api:fs:*` write/exec routes exist for parity but several are dead in
the VS Code UI (see L.6 dead surface) — implement them anyway if you want the shared
Settings/Project pages to remain mountable.

### D.10 Diagnostics status reporter ("Show OpenCode Status")

Writes to the OpenChamber output channel, then reveals: `{Time, OpenChamber version,
OpenCode Version, VS Code version, Platform, Workspace folders, Status, Working
directory, Working dir matches workspace, API URL (configured | resolved), API URL path,
OpenCode server URL, OpenCode mode (managed|external, starts, restarts), Secure OpenCode
connection, OpenCode auth source, OpenCode CLI path, OpenCode detected port, OpenCode API
prefix, Last start, Last ready (ms), Ready attempts, Start attempts, Last connected,
Connected for, Last exit code, Last error, Settings keys (stored)}` plus a probe table:
`GET /global/health` (no directory), `/config`, `/config/providers`, `/agent` (12 s),
`/command` (10 s), `/project/current`, `/path`, `/session` (12 s), `/session/status` —
each with `?directory=` when a working directory exists, 6 s default timeout, 3 s abort,
JSON-shape summary (`json[object] keys=…` / `json[array] len=…`), auth headers attached,
`ok` requires JSON content-type. This is the user-facing artifact for bug reports —
replicate it verbatim.

---

## E. Harness lifecycle in VS Code `[HARNESS PORT]`

All OpenCode-specific behavior is behind `OpenCodeManager` (A.4). Sections E.1–E.4 are
the implementation contract; the "harness" here is `opencode serve` (the OpenCode CLI),
the same target the web server manages.

### E.1 Managed start (E.1 for the whole spawn path)

`start(workdir?)`:

1. Serialize via `pendingOperation` (a module-level promise chain — concurrent
   start/stop/restart always await the in-flight one).
2. `startInternal(workdir, {rotateManaged:true})`:
   - `startCount++`, `status='connecting'`, `lastStartAt=now`.
   - Resolve working directory (arg, else first workspace folder, else `~`), normalized
     (`normalizeWindowsDriveLetter` — VS Code's `fsPath` can carry lowercase drive
     letters; the harness cwd comes out upper-case, and session directory queries must
     match, so the extension host normalizes the working directory, not the other way).
   - **External attach mode**: if `openchamber.apiUrl` is set → `status='connected'`
     immediately, done. Nothing is spawned; `getApiUrl()` returns the configured URL
     (with trailing slashes stripped).
   - If a server is already running → connect it, done.
   - Once per host process: `reapOrphanedProcesses()` — deregisters dead harness
     processes recorded by any runtime (the registry is shared with the web server;
     E.2), scoped to pids this extension family owns; must never touch a live instance
     or the user's own server.
   - `applyLoginShellEnvSnapshot()` — Windows only: capture the *shell* environment
     (pwsh/powershell/cmd fallback; `Name=value\0` parse) and, for keys not already
     non-empty in the extension host env, copy them over; PATH is a merge (snapshot
     first). This repairs a stale VS Code PATH (tools such as `opencode` installed via
     login-shell rc files). POSIX hosts skip interactive login shells entirely.
   - CLI resolution (`resolveOpencodeCliPath`), order:
     1. VS Code setting `openchamber.opencodeBinary` (strip wrapping quotes; if a
        directory, join `opencode.exe`/`opencode`);
     2. shared `~/.config/openchamber/settings.json` `opencodeBinary`;
     3. env `OPENCODE_BINARY`, `OPENCODE_PATH`, `OPENCHAMBER_OPENCODE_PATH`,
        `OPENCHAMBER_OPENCODE_BIN`;
     4. cached detection, then platform fallbacks:
        - Windows: `%USERPROFILE%\.opencode\bin\opencode.exe|.cmd`,
          `%APPDATA%\npm\node_modules\opencode-ai\bin\opencode.exe`, `%APPDATA%\npm\opencode.exe|.cmd|.bat`,
          `%ProgramFiles%\nodejs\opencode.cmd`, `%USERPROFILE%\scoop\shims\opencode.exe|.cmd`,
          `%ProgramData%\chocolatey\bin\opencode.exe|.cmd`, `%USERPROFILE%\.bun\bin\opencode.exe|.cmd`,
          then PATH scan honoring `PATHEXT`, then `where opencode`;
        - Unix: `~/.opencode/bin/opencode`, `~/.bun/bin/opencode`, `~/.local/bin/opencode`,
          `/usr/local/bin/opencode`, `/opt/homebrew/bin/opencode`, `~/bin/opencode`, PATH scan.
     5. **Desktop-app rejection**: paths that resolve to the OpenCode desktop app bundle
        (macOS `*/OpenCode.app/Contents/MacOS/*`, Windows `%LOCALAPPDATA%*/programs/
        opencode/opencode.exe`) are rejected as configured binaries — the user gets an
        error pointing at the standalone CLI instead of a hung spawn.
   - When a configured binary is set but invalid (missing/not executable/desktop app), a
     **managed start with an explicit setting throws** the descriptive error before
     spawning. A merely-detected binary failing later surfaces via the spawn error path.
   - Password: `userProvidedEnvPassword` (`OPENCODE_SERVER_PASSWORD` env) wins; else
     persist per-process, rotating on each start/restart (`rotateManaged:true`) the
     generated value `randomBytes(32).base64 → '+','-','/' → '-','_','=' stripped`.
     Always written to `process.env.OPENCODE_SERVER_PASSWORD` so the harness child
     inherits it. Header: `Authorization: Basic base64(<user>:<password>)` with user =
     `OPENCODE_SERVER_USERNAME || 'opencode'`.
   - Spawn: server cwd is `context.globalStorageUri.fsPath` (normalized, mkdir -p) —
     a **neutral cwd**; the workspace travels through explicit `directory` API
     parameters, matching the web runtime. Port allocated by binding port 0 on
     127.0.0.1. Command line: `opencode serve --hostname 127.0.0.1 --port <port>`.
     - Windows launch spec: `.cmd/.bat` shims (and bare names, which PATHEXT-resolve to
       `.cmd`) run under `cmd.exe /d /s /c call <shim> args...` — spawned **directly**
       (`shell:false`), because `shell:true` builds an unquoted command line and breaks
       on `C:\Program Files\...` paths.
     - Windows kill uses `taskkill /PID <pid> /T /F` (5 s timeout); kill on close
       also re-awaits the registry write so unregister cannot beat register.
   - URL discovery: watch stdout/stderr; the first line matching
     `/^opencode server listening/` with `on <http(s)://...>` resolves the base URL.
     Exit before serving → descriptive error including captured output (and a macOS
     desktop-app hint when relevant). No output within 30 s
     (`READY_CHECK_TIMEOUT_MS`) → timeout error including any captured output
     ("process printed nothing" distinction matters for diagnosis).
   - Register into the shared process registry (`registerManagedProcess({pid, ownerPid:
     process.pid, port, binary, runtime:'vscode'})`).
   - Readiness: poll `<url>/global/health` (candidates: bare origin first, then the
     SDK-style URL only when already root) every 100 ms; each attempt uses a 3 s abort;
     healthy requires `res.ok` and body `healthy === true`; records
     `lastReadyElapsedMs/attempts`, `version` from the health body. Ready ⇒
     `managedApiUrlOverride = ready.baseUrl`, `detectedPort`, `status='connected'`.
     Health failure ⇒ close the server and throw "Server started but health check
     failed".
   - Failure classification: messages containing `ENOENT` or `spawn opencode` ⇒
     `cliMissing=true`, status error "OpenCode CLI not found. Install it and ensure
     it's in PATH." + a toast with "More Info" (opens
     `https://github.com/anomalyco/opencode`); anything else ⇒ "Failed to start
     OpenCode: <message>".

### E.2 Modes

- `managed` — everything in E.1. `getApiUrl` = health-probed base URL.
- `external` — `openchamber.apiUrl` set. Never spawns; start marks connected instantly;
  upgrades are unsupported; auth headers still applied **if** `OPENCODE_SERVER_PASSWORD`
  is in the environment (the external server's basic auth).

`getDebugInfo().mode` and `secureConnection`/`authSource` flags derive from this.

### E.3 Readiness gate (`opencode-ready.ts`)

`waitForApiUrl(manager, timeoutMs = 30_000)` — the single point every consumer goes
through before using the harness:

- Only hand out a URL when `getStatus() === 'connected'`. `getApiUrl()` may expose
  `server.url` as soon as the child spawns — before health passes — so URL presence
  alone would forward to a not-yet-ready harness (and to a stale port across workspace
  restarts).
- Subscribers: `onStatusChange` (which fires synchronously with the current state at
  subscribe time). `'error'` (CLI missing / spawn failure) resolves `null` immediately
  — fail fast instead of burning the timeout, mirroring the web gate's fast 503.
- Timeout resolves the current `getApiUrl()` — possibly null — so stuck startups surface
  as unavailable rather than hanging.

### E.4 Upgrade flow (`opencode-upgrade-runtime.ts`)

- Capability: Windows ARM64 ⇒ unsupported with `reason:'windows-arm64-workaround'`
  (upstream workaround — the ARM64 `opencode.exe` currently fails; the upgrade must not
  overwrite the working x64 binary). No manager / external mode / no API URL ⇒
  unsupported (`manager:'external'|null`, `reason:'external'|'unavailable'`). Managed ⇒
  `supported, manager:'opencode'`.
- Status (`getOpenCodeUpgradeStatus`): GET `global/health` for the current version and
  fetch the latest from **two** sources in parallel —
  `https://registry.npmjs.org/opencode-ai/latest` (`version`) and
  `https://api.github.com/repos/anomalyco/opencode/releases/latest` (`tag_name`), 10 s
  timeouts — then compare with `compareVersions` (numeric core split on `.`; prerelease
  orders below release). Response `{available: bool|null, currentVersion, latestVersion,
  upgrade}`; on health error `{available:null, error, upgrade}`.
- Upgrade request (`upgradeManagedOpenCode`, serialized by a module-level promise; a
  second concurrent call → 409 `OPENCODE_UPGRADE_IN_PROGRESS`; unsupported → 409
  `OPENCODE_UPGRADE_UNSUPPORTED`):
  1. Resolve the target: requested `{target}` string or the fetched latest (unresolvable
     → 502 `OPENCODE_UPGRADE_TARGET_UNRESOLVED`).
  2. `POST <api>/global/upgrade` JSON `{target}` with auth headers.
  3. Error-message extraction: OpenCode rejects as `{name, data:{message, kind}}` with
     no `error` field — read `payload.error || payload.data.message || payload.message`
     before falling back to `response.statusText`.
  4. On HTTP success, restart the harness (`manager.restart()`); a failed restart returns
     `{status:500, body:{success:false, upgraded:true, error:'OpenCode upgraded, but
     restart failed: …'}}`.
  5. Success ⇒ `{status:200, body:{...upstream-payload, restarted:true}}`.

### E.5 Auth file management (`opencodeAuth.ts`) `[HARNESS PORT]`

`~/.local/share/opencode/auth.json` (harness auth store):

- `updateProviderAuth(providerId, entry)` — upsert.
- `removeProviderAuth(providerId)` — boolean; `getProviderAuth(providerId)`.
- Write discipline: mkdir -p data dir with `0o700` (chmod on non-Windows), back up the
  previous file to `auth.json.openchamber.backup` (`0o600`) before replacing, write with
  mode `0600`. Read failure throws "Failed to read OpenCode auth configuration"
  (providers settings surfaces the error; a missing file is `{}`).

### E.6 Session activity watcher

`sessionActivityWatcher.ts` mirrors web/desktop activity derivation. Started/stopped on
manager status transitions (connected ⇒ start; disconnected/error ⇒ stop):

- Before opening the SSE: reconcile from `GET /session/status` `{sessionId: {type}}`
  (`busy|retry` ⇒ `busy`, else `idle`); drop in-memory entries that authoritative status
  no longer lists.
- Then connect global SSE via **SDK v2** `client.global.event({sseMaxRetryAttempts:0})`
  with reconnecting outer loop (backoff `min(1000*2^attempt, 30000)`, attempt cap ≈ 5
  for the exponent).
- Derivation (`deriveSessionActivity`):
  - `session.status` (`status.type` or `info.type`) → `busy` for `busy|retry`, `idle`.
  - `message.updated|message.part.updated|message.part.delta` with assistant role and
    `finish==='stop'` → `cooldown` (2 s, then auto back to `idle`).
  - `session.idle` → `idle`.
- Pushes `{type:'openchamber:session-activity', properties:{sessionId, phase}}` into the
  sidebar webview through the provider's `postMessage`; snapshot is also served through
  `api:session-activity:get` (D.7) which `GET /api/sessions/snapshot` (D.8) embeds as
  `activitySessions`.
- Port availability: waits (500 ms poll, 30 s) for the manager to expose a port; on
  exhaustion schedules a retry (2 s). Start tokens invalidate overlapping starts.

The OpenChamber **control stream** (`/api/openchamber/events`, doc 03) is absent here:
`subscribeOpenchamberEvents` resolves to a no-op subscription in VS Code before any URLs
resolve (sending it at the webview origin caused repeated 403s and auth-token requests).
Session sync therefore runs purely on the OpenCode SSE bridge plus global session
polling (doc 01 owns the sync contract).

### E.7 Shared modules that must not diverge

Two modules are thin re-exports of server-side code (bundled via esbuild at build time):

- `opencodeProcessRegistry.ts` → `packages/web/server/lib/opencode/managed-process-registry.js`
  (`registerManagedProcess | unregisterManagedProcess | reapOrphanedProcesses`); VS Code
  passes `runtime:'vscode'`. A process spawned by any runtime (web, desktop, VS Code)
  must be reapable by any other; that only holds while all runtimes share the on-disk
  registry and algorithm.
- `provider-env-aliases.ts` → `packages/web/server/lib/opencode/provider-env-aliases.js`
  (applies provider env-key aliasing to the spawned child's env — feeds E.1's spawn).

---

## F. Git & worktree composition

### F.1 What is different vs. the server git API and why

The OpenChamber server exposes git over HTTP (doc 03), backed by its own process tree.
The extension cannot and should not proxy all of it:

- It composes **VS Code's built-in git extension API** (`vscode.git`, fetched via
  `extensions.getExtension('vscode.git')`, `getAPI(1)`, `git.d.ts` shim) for repository
  state (status/branches/identity/commit/pull/fetch) **with a raw `git` child process**
  (`execGit`) for everything worktree, patch (hunks), stash file-counts, push with
  upstream fallback, conflict detection, and log. Every VS Code API path has a raw-git
  fallback (e.g. when the git extension is disabled or doesn't know the directory).
- Worktrees are a **first-class in-editor flow**: OpenChamber-style managed worktrees
  live under the harness data dir (`$XDG_DATA_HOME || ~/.local/share` →
  `<...>/opencode/worktree/<40-char project id>/<name>/`), created during an active chat.
  Creation returns immediately once the directory exists; git population and setup
  commands run in the background with explicit phase reporting the shared UI renders as
  progress. This is the core reason for a bespoke implementation rather than the
  server: the extension host owns phase state per-extension-process, races with the
  user deleting a worktree mid-bootstrap must be prevented locally, and Windows
  long-path problems are handled here (`core.longpaths`).

### F.2 Process environment

`execGit` env: inherit + `GIT_TERMINAL_PROMPT:'0'` + `SSH_AUTH_SOCK` resolution
(existing ⇒ keep; Windows ⇒ none; macOS/Linux ⇒ `~/.gnupg/S.gpg-agent.ssh` if socket,
else `gpgconf --list-dirs agent-ssh-socket` with launch-and-retry). The binary is
`gitApi.git.path` when the vscode.git extension is alive, else `git`.

### F.3 Status (VS Code API first)

`getGitStatus(directory, {mode?})` — `mode:'light'` is accepted for parity but the
heavier diff-stats computation is intentionally not implemented here (callers can rely
on contract parity; the result simply omits diffStats):

- From `repo.state`: `indexChanges` + `workingTreeChanges` mapped to sticky
  `{path (repo-relative), index, working_dir}` codes
  (INDEX_MODIFIED→M, INDEX_ADDED→A, INDEX_DELETED→D, INDEX_RENAMED→R, INDEX_COPIED→C,
  MODIFIED→M, DELETED→D, UNTRACKED→?, IGNORED→!, INTENT_TO_ADD→A,
  INTENT_TO_RENAME→R, TYPE_CHANGED→T, conflict states→U).
- `current`/`tracking`/`ahead`/`behind` from `state.HEAD`.
- `mergeInProgress` (MERGE_HEAD + MERGE_MSG first line) and `rebaseInProgress`
  (`.git/rebase-merge|rebase-apply` `head-name`/`onto`) detected by reading git-dir
  files directly (works for worktrees whose `.git` is a file? — note: the code joins
  `directory/.git` and would miss linked worktrees' common dir for these reads; the
  canonicalize route below handles linked state via git commands).
- Fallback raw parse: `git status --porcelain=v1 -b -uall` (branch header `## <branch>…
  [ahead/behind]`, rows XY path with rename-tab extraction).

### F.4 Worktree machinery

Location/context resolution:

- `resolveWorktreeProjectContext(directory)` → `{projectID, sandbox, primaryWorktree,
  worktreeRoot}`: top-level via `git rev-parse --show-toplevel`, common dir via
  `--git-common-dir`, primary worktree = common dir's parent, project id =
  `ensureOpenCodeProjectId` (reads `<common>.git/opencode` file; creates it as the
  lexicographically-first root of `git rev-list --max-parents=0 --all`).
- Worktree root: `<XDG_DATA_HOME default ~/.local/share>/opencode/worktree/<projectID>`.

Names/branch candidates (OpenCode-flavored):

- `slugWorktreeName` (strip refs, spaces→`-`, path segments→`-`, charset clamp, 80 chars).
- Random names: adjective+noun from fixed OpenCode lists (`brave-cabin` style),
  26 attempts. With a base name: `<base>`, then `<base>-<random>` variants. Branch
  (new mode, no explicit branch): `openchamber/<name>`, checked against existing refs.

Creation (`createWorktree`):

- `validateWorktreeCreate` (also exposed as `api:git/worktrees/validate`), error codes:
  `branch_not_found`, `branch_exists`, `branch_in_use` (branch checked out in another
  worktree), `invalid_remote_config` (ensureRemoteName/Url must pair),
  `upstream_incomplete`, `remote_not_found`, `remote_unreachable` (ls-remote), 
  `start_ref_not_found`, `validation_failed`. `resolved.localBranch` returned on success.
- Modes:
  - `new`: optional `startRef` (default HEAD). If it parses as a remote-tracking ref
    (`refs/remotes/<remote>/<branch>` or `remotes/…` or `remote/branch` when no such
    local ref exists) the extension refreshes it first — **fetch-fallback**: on fetch
    failure, if the repo is clean (`ahead 0`) and tracks exactly that remote branch,
    fall back to the local branch and set `sourceFetchFailed:true` (shared UI reports
    "using the local branch" instead of failing); otherwise proceed with the existing
    tracking ref if it still exists, else rethrow. `git worktree add --no-checkout -b
    <branch> <dir> [<startRef>]` with `--no-track` inserted when the start ref is a
    remote branch (branch must not auto-track).
  - `existing`: requested branch may be local (checkout exists) or remote
    (`<remote>/<branch>` or full ref): a missing remote-tracking ref is fetched
    (`fetchRemoteBranchRef`, refspec `+refs/heads/<b>:refs/remotes/<r>/<b>`); then
    `git worktree add --no-checkout [-b <local>] <dir> <checkoutRef>` with
    `createLocalBranch:true` when starting from the remote ref.
- Preview (`api:git/worktrees/preview`) reserves dir+branch names without creating.
- `returnAfterDirectoryCreated:true` (fast path used by the in-editor flow): validate,
  mkdir the worktree directory **only**, register bootstrap state
  `pending/directory-created`, and continue the whole `worktree add` + population
  **in background** (tracked task; on failure mark failed + clean up an empty,
  non-attached directory). Result immediately: `{head:'', name, branch, path,
  directoryCreated:true, bootstrapStatus, sourceFetchFailed?}`.
- Population (`queueWorktreeBootstrap`, background):
  1. `ensureWorktreeLongpaths` — set repo-local `core.longpaths=true` if not set (the
     managed worktree root is deep; Windows MAX_PATH otherwise kills `git reset --hard`,
     issue: "Filename too long"). Failures here are non-fatal; the reset also carries
     `-c core.longpaths=true`.
  2. `git -c core.longpaths=true reset --hard` with **index.lock recovery**:
     on retryable lock errors (`index.lock: File exists` / "another git process seems
     to be running"), wait 250 ms, retry; wait 750 ms, retry; on final lock with a
     **stat-identical unchanged lock file** (dev:ino:size:mtime), unlink it and retry
     once. Non-lock errors throw with a "Filename too long" hint appended.
  3. Explicit **post-checkout hook** invocation — `--no-checkout` + `reset --hard` skip
     git's own hook firing; run `<git-path hooks>/post-checkout <null-ref> <HEAD> 1`
     with `GIT_DIR` + `GIT_WORK_TREE` env (worktree top-level cwd), executable and
     file checks match git, failures warn and continue.
  4. Upstream configuration when requested: optional `ensureRemoteWithUrl` (get-url vs
     set-url/add), fetch the remote branch, `git branch --set-upstream-to=<remote>/
     <branch> <local>`; on fetch failure fall back to `branch.<local>.remote|.merge`
     config writes (`setBranchTrackingFallback`).
  5. Phase `git-ready`, then run start scripts: project start command from
     `<data>/opencode/storage/project/<projectID>.json` → `commands.start` (read-only),
     plus the request's extra `startCommand`; shell `bash -lc` (unix) / `cmd /c`
     (Windows), 20 MB captured; failures warn and complete as
     `ready/setup-ready`. Phase transitions: `directory-created` → `git-ready` →
     `setup-ready`; failure keeps the last phase and sets `failed`.
- `api:git/worktrees/bootstrap-status {directory}` returns
  `{status:'pending'|'ready'|'failed', phase, error, updatedAt}` — default
  `ready/setup-ready` for worktrees with no tracked state (legacy/existing ones; the
  shared UI also accepts legacy responses without `phase`).
- Removal (`removeWorktree`): **waits for the active create/bootstrap task for the same
  directory** so background git/setup cannot race deletion or restore stale state;
  refuses the primary worktree; matches by canonical path; `git worktree remove --force`;
  optional `deleteLocalBranch` (`git branch -D`); not-a-worktree targets are `rm -rf`
  when they exist; bootstrap state cleared after.
- Listing: `git worktree list --porcelain` parse (`worktree|HEAD|branch`) into
  `{head, name (basename), branch (cleaned), path}`.

### F.5 Patch/hunk, stash, push/pull, log

- `applyGitHunk` — validate patch has `@@` header; repo-relative the path; extract the
  patch's own `---/+++` target path (JSON-quoted paths supported) and require it to
  match; write temp patch file; `git apply --check` first ("Hunk no longer applies —
  refresh and try again." + detail), then `git apply` with action flags
  (stage `--cached`; unstage `--cached --reverse`; discard `--reverse`).
- `stageGitFiles` — batch `git add -- …`; on a pathspec-not-found failure (optimistic UI
  races a queued mutation, typically a deletion already staged) retry **per path** and
  skip paths already in their target state rather than failing the whole batch.
- `unstageGitFiles` — `restore --staged` with `reset HEAD --` fallback.
- `gitPush` — implements upstream auto-setup: when the push fails like a missing upstream
  (message heuristics: "has no upstream"…), resolve current branch + first remote
  (`origin` preferred) and push with `--set-upstream`. Response shape
  `{success, pushed:[{local, remote}], repo, ref:null}`.
- `gitPull` — vscode.git `repo.pull()` unless `rebase:true` (then raw
  `git pull --rebase`); computes changed files via `diff --name-only <before> <after>`.
- `getGitLog` — `--pretty=format:%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ad%x1f%s%x1f%D` +
  `--shortstat`; `\x1e`-separated records, `\x1f`-delimited header fields; shortstat
  regex for files/insertions/deletions; `all` mode adds `--all --topo-order`;
  range `from..to` / `from..HEAD`; `resolveBaseRefForLog` — local ref first; missing
  local falls back to `origin/<from>` when the tracking ref exists; else pass through.
- Stashes — list `--format=%gd%x1f%gs%x1f%cr%x1f%H`; `stash push --include-untracked -m
  <message default "OpenChamber stash <iso>">` (created = output not "no local
  changes"); apply prefers `--index` (restore staged/unstaged split) falling back to
  plain; per-ref file counts with concurrency 4.
- Identity — `getGitIdentity` GET → `{userName, userEmail, sshCommand}` (vscode.git
  config first, raw fallback); POST writes `user.name|user.email|core.sshCommand`
  (ssh key path escaped for shell — Windows path converted to MSYS `/c/...`, single
  quoted; injection guarded by a dangerous-character check) and, when
  `signCommits`+`signingKey`, `gpg.format=ssh`, `user.signingkey`, `commit.gpgsign=true`.
- Range APIs for the PR generator: `getGitRangeDiff` / `getGitRangeFiles`
  (`base...head`, resolving `origin/<base>` when the tracking ref exists).

### F.6 VS Code git API lifecycle

`gitExtensionEnabled` + `gitApi` cached; `initGitExtension` activates the extension,
validates `extension.enabled`, listens for enablement changes (disables the cache).
`getRepository(directory)` → `api.getRepository(uri)` then `api.openRepository(uri)`.

---

## G. Sessions / panels UX (extension-side behavior)

### G.1 Panel routing (`activePanelRouting.ts`)

`pickActivePanelId(panels:[{id, active}], lastActivePanelId)` — the currently active
panel wins; otherwise the last-active id; else null. It backs every
`*ToActivePanel` method (`addContextSelectionToActivePanel`,
`createSessionWithPromptInActivePanel`, `addFileAttachmentsToActivePanel`,
`addLineCommentToActivePanel`). The caller must re-check the id against live panels.

### G.2 Capture flows (right-click family)

Order for every editor-context command: **active session panel** → else reveal sidebar
(`openSidebar` → 80 ms → hasResolvedView check) → else abort. The active-editor
broadcast keeps the composer's pin-selection suggestion in sync: broadcast dedupe is by
structural equality of the payload; relativePath uses `asRelativePath(uri, false)` so it
matches `addToContext`'s attachment and dedupes correctly.

### G.3 Session editor titles

`createOrShow(sessionId, title)` reveals and re-titles; the webview may retitle itself
via `vscode:command {command:'openchamber.updateSessionEditorTitle', args:[?, title]}`
(intercepted, echoes success). `new` draft panels get id `new_<ts>_<rand5>` and title
"New Session" (localized); a later command can retitle when the session is created.

### G.4 Active session tracking

The webview posts `openchamber.setActiveSession(sessionId, title)` (runtime command) —
used by `openActiveSessionInEditor` and `openCurrentOrNewSessionInEditor`.

### G.5 New session command

`openchamber.newSession(directory?)`: directory validation is a filesystem check
(`setWorkingDirectory`); the webview payload includes `workspaceFolders` (the full
resolved list, with the picked folder appended when it is not one of them) so the shared
projects store can pin the directory.

### G.6 Agent Manager

Single-instance panel (`ViewColumn.One`), iconPath pair, same message bridge, same SSE
proxy handling, no `viewMode` in config. Cross-ref 12 for the product behavior
(parallel runs, model comparison); the extension contributes only the host + the
`openchamber.openAgentManager` command + title-bar icon.

### G.7 Settings surface differences

`VSCodeLayout` exposes exactly three views: `sessions`, `chat`, `settings`. Settings
pages hidden by `metadata.ts` gate (`isAvailable: (ctx) => !ctx.isVSCode`):
`remote-instances`, `git`, `shortcuts`, `magic-prompts`, `voice`, `tunnel`, `about`.
Mounted partials: `UsagePage` (slug `usage`), `notifications`, MCP, agents/commands/
skills/plugins/providers/projects. Worktrees are reachable through the session sidebar
(NewWorktreeDialog + worktree menu); `WorktreesView` itself is not mounted. Git is
read-only through `useGitStore` in the sidebar/composer (stage/commit/push UI lives in
the unmounted GitView). (src: DOCUMENTATION.md reachability map — keep it in sync when
mounts change; doc 14 covers settings pages.)

---

## H. Quota providers matrix

### H.1 Managed credentials (`quotaCredentials.ts`)

Private file contract matches the web runtime: directory
`<OPENCHAMBER_DATA_DIR env || ~/.config/openchamber>/quota/`, per-provider JSON
(`exe-dev.json` `{usageToken}`, `ollama-cloud.json` `{cookie}`, `cursor.json`
`{accessToken, refreshToken?}`), dir `0o700`, file `0o600`, atomic rename. Cursor
import reads the macOS-only Cursor SQLite state (`~/Library/Application Support/Cursor/
User/globalStorage/state.vscdb`, `sqlite3 -json`, keys `cursorAuth/accessToken|
refreshToken`). Validation **happens before** any credential write: exe-dev runs one
usage probe; ollama-cloud parses the settings page; cursor refreshes an access token via
`https://api2.cursor.sh/oauth/token` (client id `KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB`) when
only a refresh token was supplied and probes
`POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`.
`deleteLegacyOpenCodeGoCredential` removes the pre-quota-module `opencode-go.json` file.

Credential status responses mask (secretMasked: '••••••••') and add
`hasRefreshToken` for cursor.

### H.2 Provider list and ordering (`api:quota:providers`)

`listConfiguredQuotaProviders()` — configured-detection by OpenCode auth store
(`~/.local/share/opencode/auth.json` entries by alias) plus managed credential files.
Provider matrix:

| providerId | alias keys in auth.json | source of truth |
|---|---|---|
| `opencode-go` | `opencode-go` | auth.json `key`/`token`; legacy credential file deleted |
| `ollama-cloud` | — | managed cookie |
| `cursor` | — | managed tokens |
| `exe-dev` | — | managed usageToken |
| `claude` | `anthropic`, `claude` | auth.json `access|token` |
| `codex` | `openai`, `codex`, `chatgpt` | auth.json |
| `google` | `google`, `google.oauth` + antigravity file | auth.json + `$CONFIG/antigravity-accounts.json`, `<data>/antigravity-accounts.json` |
| `zai-coding-plan` | `zai-coding-plan`, `zai`, `z.ai` | auth.json |
| `zhipuai-coding-plan` | `zhipuai-coding-plan` | auth.json |
| `kimi-for-coding` | `kimi-for-coding`, `kimi` | auth.json |
| `minimax-coding-plan` / `minimax-cn-coding-plan` | same ids | auth.json |
| `openrouter` | `openrouter` | auth.json |
| `nano-gpt` | `nano-gpt`, `nanogpt`, `nano_gpt` | auth.json |
| `github-copilot` + `github-copilot-addon` | `github-copilot`, `copilot` | auth.json (both ids added together) |
| `wafer` | `wafer`, `wafer-ai`, `wafer_ai`, `wafer.ai` | auth.json |
| `crof` | `crof` | auth.json |
| `cline-pass` | `cline-pass` | auth.json |
| `neuralwatt` | `neuralwatt` | auth.json |
| `deepseek` | `deepseek` | auth.json |
| `hyper` | `hyper` | auth.json |
| `xai` | `xai` (typed oauth `access|refresh|expires`) | auth.json |

### H.3 Fetch matrix (`fetchQuotaForProvider`, coalesced per provider)

Common result shape `{providerId, providerName, ok, configured, usage:{windows:{label:
UsageWindow}, models?}, fetchedAt, error?, planLabel?}`; UsageWindow =
`{usedPercent, remainingPercent, windowSeconds, resetAfterSeconds, resetAt,
resetAtFormatted, resetAfterFormatted, valueLabel?}`.

| Provider | Endpoint / parsing notes |
|---|---|
| `claude` | GET `https://api.anthropic.com/api/oauth/usage` (header `anthropic-beta: oauth-2025-04-20`); windows `5h` (session), `7d` (weekly_all), per-model `7d` (weekly_scoped by scope.model.display_name); legacy `five_hour`/`seven_day` shapes; `spend` → `extra_usage` value label in minor units. **Cooldown**: on 429 cache and honor `retry-after` (default 5 min, ≤1 h); cached usage served during cooldown. 401/403 ⇒ "Claude session expired" message. Credential-fingerprint change clears cache+cooldown. |
| `codex` | GET `https://chatgpt.com/backend-api/wham/usage` with `ChatGPT-Account-Id` when set; windows from `rate_limit.primary/secondary_window` (label by window seconds → `Nh`/`Nd`/`weekly`), `credits.balance` (`$x.xx` or `Unlimited`), `spend_control.individual_limit` (`used / limit used`). |
| `github-copilot` (+addon) | GET `https://api.github.com/copilot_internal/user` (Editor-Version vscode/1.96.2, X-Github-Api-Version 2025-04-01); window `premium_interactions` from `quota_snapshots` (unlimited ⇒ valueLabel 'Unlimited'; entitlement/remaining ⇒ percent + `N / M left`); reset from `quota_reset_date`. |
| `google` | Two sources merged: Gemini CLI auth (`google`/`google.oauth`, refresh token format `token|project|managed`, embedded installed-app client id/secret) and Antigravity accounts file (`activeIndex`, `refreshToken` same split). Buckets via `POST cloudcode-pa/v1internal:retrieveUserQuota`; models via `POST {daily|autopush|prod}-cloudcode-pa/v1internal:fetchAvailableModels` (15 s each); windows `daily` for gemini, `5h`/`daily` for antigravity based on remaining time; scope model names `gemini/<model>`. |
| `kimi-for-coding` | GET `https://api.kimi.com/coding/v1/usages`; `usage` block (`used` | `remaining` on `limit`) ⇒ `weekly`; `limits[].window.duration/timeUnit` ⇒ labels (`5h` window gets `Rate Limit (5h)` label); `usedPercent` derived from whichever of used/remaining is present. |
| `nano-gpt` | GET `https://nano-gpt.com/api/subscription/v1/usage`; `daily` (86400 s window) and `monthly` from `percentUsed` or used/limit; non-active `state` appended to labels. |
| `minimax-coding-plan` | GET `https://api.minimax.io/v1/api/openplatform/coding_plan/remains`; `base_resp.status_code !== 0` surfaces the API error; windows `5h` (current_interval) + `weekly` from `model_remains[0]` (`usageFieldsAreRemaining:false` — interval/weekly usage fields are **used** counts). |
| `minimax-cn-coding-plan` | Same against `https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains` with `usageFieldsAreRemaining:true` (fields are **remaining** counts, converted to used by `total − remaining`). |
| `ollama-cloud` | `fetchOllamaUsage(cookie)` — GET `https://ollama.com/settings` (manual-redirect-fail, Safari UA, 15 s): regex windows `session`, `weekly` (percent), `premium N / M`, `monthly $x of $y`, `Balance remaining $x` (credits, omitted at 0); redirects/HTTP failures/pages without any window reject; 15 s timeout. Credential validated before write. |
| `exe-dev` | POST `https://exe.dev/exec` body `billing credits usage --group=day --json`, Bearer usageToken, 15 s; parse `{total_cost_usd, monthly_allowance_usd, period_end}` → single `monthly` window with value label `$used / $limit`. |
| `openrouter` | GET `https://openrouter.ai/api/v1/key` (`Accept-Encoding: identity`, 15 s); `is_management_key` rejected ("quota needs an inference API key"); window from `limit`+`limit_remaining` (`limit_reset` daily/weekly/monthly → reset times computed toward the next UTC boundary; otherwise `credits`, no reset) or the `usage_monthly`-only variant. 401/403 ⇒ "Session expired — please re-authenticate with OpenRouter". |
| `zai-coding-plan` | GET `https://api.z.ai/api/monitor/usage/quota/limit`; windows from `TOKENS_LIMIT`/`CREDIT_LIMIT` entries (`unit 3=hour, 6=week × number`), `TIME_LIMIT` ⇒ `MCP Tools` 30d; `valueLabel` in `used / total credits` (k-format ≥1000); `planLabel` = `data.level`. |
| `zhipuai-coding-plan` | GET `https://open.bigmodel.cn/api/monitor/usage/quota/limit`; `Tokens` + `MCP Tools` windows. |
| `wafer` | GET `https://pass.wafer.ai/v1/inference/quota`; 5 h default window; plan tier + `N / M left` + overage in the value label; overage unclamps usedPercent. |
| `opencode-go` | GET `https://opencode.ai/zen/go/v1/usage` with `x-opencode-session: openchamber-usage`; windows `5h` (rolling), `weekly`, `monthly` from `usage.{rolling,weekly,monthly}.{percent, resetsAt}`. |
| `cursor` | POST GetCurrentPeriodUsage (same as validation); window `billing_cycle` with `planUsage.totalPercentUsed` and `billingCycleEnd`. |
| `crof` | GET `https://crof.ai/usage_api/`; `credits` window with `$x.xx` value label. |
| `cline-pass` | GET `https://api.cline.bot/api/v1/users/me/plan/usage-limits`; windows `5h`, `weekly`, `monthly` (calendar month, windowSeconds null) from `data.limits[].{type, percentUsed, resetsAt}`. |
| `deepseek` | GET `https://api.deepseek.com/user/balance`; USD balance preferred, CNY fallback (¥ symbol); `credits_balance` window. |
| `hyper` | GET `https://hyper.charm.land/v1/credits`; windows `credits_balance` ($0.05/credit) + `credits` (raw). |
| `neuralwatt` | GET `https://api.neuralwatt.com/v1/quota`; subscription window keyed by plan name (in_overage ⇒ 100%), allowance window keyed by period (daily/weekly/monthly) with `min(limit, creditsRemaining + spent)` ceiling, blocked ⇒ 100%; credits-only fallback. |
| `xai` | POST `https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` as gRPC-web (`content-type: application/grpc-web+proto`, connect-es UA, empty 5-byte frame); token refreshed via `https://auth.x.ai/oauth2/token` (client id `b1a00492-...`, refresh-scheduled 2 min before expiry, single-flight, validates before write). Full gRPC-web frame parser (conservative protobuf scanner, ≤4 depth, fixed32 percent fields at paths `[1]`/`[1,1]` in 0–100, varint reset time at `[1,5,1]` preferred, no-usage-yet distinction via `[1,6]` presence), trailer status handling; single `billing_cycle` window. |

Webview surface (cross-ref 05 owns the usage UI): the quota routes are served locally —
`GET /api/quota/providers`, `GET /api/quota/:providerId`,
`GET|PUT /api/quota/credentials/:provider(/validate|import)` (`ollama-cloud|cursor`
only in VS Code). Doc 05 defines the UI around these.

---

## I. Theming & localization

### I.1 Theme pipeline

- `getThemeKindName(kind)` — Light/HighContrastLight ⇒ `'light'`; everything else
  `'dark'` (the shared UI has only light/dark variants).
- Kind shipped into the webview at boot (`window.__VSCODE_CONFIG__.theme`) and pushed on
  `themeChange` messages.
- **Shiki integration** (`shikiThemes.ts`): resolves the user's
  `workbench.colorTheme` (for the active variant) and
  `workbench.preferredLightColorTheme`/`preferredDarkColorTheme` (for the opposite),
  finds the matching contributed theme among `vscode.extensions.all` package.json
  `contributes.themes` (label normalized: trim, collapse spaces, lowercase, "Default …"
  prefix variant), reads the theme JSON via `vscode.workspace.fs` and parses **loosely**
  (JSONC stripper + trailing-comma stripper — theme files are JSONC). Names are
  uniquified with ` (Light)`/` (Dark)` suffixes. One-sided fallback: if only one side
  resolves, use it for both (never fall back to the built-in Flexoki in VS Code).
  Payload `{light?, dark?} | null`; the webview stores it on
  `window.__OPENCHAMBER_VSCODE_SHIKI_THEMES__` and re-dispatches
  `openchamber:vscode-shiki-themes`.
- Webview consumption: `readVSCodeThemePalette(kind)` + `buildVSCodeThemeFromPalette`
  from the shared adapter (doc 01/14) build the internal theme from VS Code CSS
  variables; the CSS variables update asynchronously around theme switches, so the
  palette recompute runs on two consecutive animation frames after each themeChange.
- Triggers: `onDidChangeActiveColorTheme` and a configuration-change listener for
  `workbench.colorTheme|preferredLightColorTheme|preferredDarkColorTheme` (the setting
  can land slightly after the event; that triggers the Shiki re-resolution).
- The splash uses VS Code CSS variables directly (editor background/foreground) so the
  very first paint matches the editor theme.

### I.2 Localization

Extension host: see B.5. Webview: the shared UI runs its own i18n with
`window.__OPENCHAMBER_HOST_LANGUAGE__` as the detection default and
`localStorage['openchamber.i18n.v1']` as the user choice. The splash has its own
hard-coded en/fr/tr message sets because it renders before the bundle loads
(startingApi/initializing/connecting/connected/connectionError/reconnecting/cliNotFound).

---

## J. Asset / CSP / security requirements

1. **CSP** (C.2) — `default-src 'none'`; `worker-src` is the only place `blob:` is
   allowed (Shiki/fflate workers started from blob URLs; each worker is emitted as one
   self-contained file because VS Code webviews cannot load module imports inside
   workers). `script-src` carries `cspSource` + `'unsafe-inline'` + `'unsafe-eval'`
   only (no blob). Local resources only via `webview.asWebviewUri` (cspSource).
2. **Serialization boundary** — the bridge never bypasses webview serialization:
   every payload crossing in either direction is JSON. Webview-side handlers therefore
   re-validate unknown-typed fields (string/number/array checks) instead of trusting
   cast shapes; the extension side must do the same for anything typed from a webview
   message (see the cast-then-narrow discipline in every runtime).
3. **Path authorization** — fs reads are authorized in the requested workspace path
   space **before** symlink resolution, and the returned canonical path is what the
   proxy serves; directly requested outside-workspace paths are denied (403). Directory
   availability probes have no endpoint (501) rather than leaking through OpenCode.
4. **Headers forwarded to upstream** are sanitized (`content-length`, `host`,
   `connection` dropped); response headers forwarded without hop-by-hop ones.
5. **Auth secrets** — harness basic password is generated per process (or supplied via
   env) and set on the child env; never logged. Provider secrets live in the harness
   auth file (0o600, backed up before write). Managed credentials dir 0o700/file 0o600.
   Secrets marked in the registry are never returned to webviews (write-only).
6. **Update telemetry** — only `reportUsage !== false` sends an `installId`; the id is a
   random UUID stored in a user-local file. No other identifiers leave the host.
7. **Notification dedupe** — `api:notifications:claim` is in-process only; claim map TTL
   10 s.
8. **Exec surface** — `api:fs:exec` executes commands with the user's shell in the
   webview's chosen cwd; cacheable commands are tightly allowlisted; timeouts enforced
   per command (300 s). Git env never allows terminal prompts.
9. **Model intent of the harness URL gate** — never forward API traffic before
   `waitForApiUrl` says connected (E.3).
10. **Windows drive letters** — always normalize (`normalizeWindowsDriveLetter`) when
    comparing paths or passing them to the harness; VS Code `fsPath` lower-cases,
    harness cwd upper-cases.
11. **No browser-navigation recovery** — `window.location.reload()` is unsupported in
    webviews; shared lazy-import retry logic retries chunk loads but must fail into the
    UI error boundary instead of attempting navigation recovery.
12. **Control stream absent** — no `/api/openchamber/events` connection; webview-side
    `subscribeOpenchamberEvents` is a no-op before it touches URLs (E.6).

---

## K. Packaging

- Build: `bun run --cwd packages/vscode build` =
  `build:extension` (esbuild CJS to `dist/extension.js`, `--external:vscode`,
  `--platform=node`, minified; workspace `packages/web/server/lib/...` re-exports are
  bundled in through the relative imports) + `build:webview` (`VITE_OPENCODE_URL=/api
  vite build`). Webview build emits to `dist/webview` with
  `entryFileNames: assets/[name].js` — the extension resolves
  `dist/webview/assets/index.js` explicitly.
- Package: `vsce package --no-dependencies` (anked `@vscode/vsce` ^3.2.1). VSIX name
  pattern for local install: `openchamber-*.vsix` (README: `code --install-extension
  packages/vscode/openchamber-*.vsix`).
- `.vscodeignore` excludes `src/**`, `webview/**`, tests, tsconfigs, vite config, maps;
  includes only `dist/**` plus manifest/assets/l10n/README/CHANGELOG.
- Marketplace metadata: publisher `fedaykindev`, qna links to
  `https://discord.gg/ZYRSdnwwKA`, repository, MIT license icon + keywords.
- `packages/vscode/CHANGELOG.md` and `changelog/index.json` are **generated** from
  `changelog/*.md` by `oc-dev create-release` — generated files are read-only; never
  edit them by hand. Extension release notes get written once in the maintainer's
  release pass.
- Dev loop: root `bun run vscode:dev` via `scripts/dev-vscode.mjs` (watchers + Extension
  Development Host; `OPENCHAMBER_VSCODE_BIN=<other>`, `OPENCHAMBER_VSCODE_DEV_WORKSPACE=
  <path>`, or a positional workspace arg). Webview HMR: `vite --host localhost --port
  5173 --strictPort` with `cors` + `Access-Control-Allow-Origin: *`, hmr ws on 5173;
  extension-host watch builds with sourcemaps.
- Type checking splits two tsconfigs: `tsconfig.json` (extension) and
  `tsconfig.webview.json`; lint runs ESLint over `src` + `webview`; tests run through
  the repo's isolated runner (`node ../../scripts/run-isolated-tests.mjs src webview`).

---

## L. Edge cases, invariants, and tests worth replicating

### L.1 Core invariants

- **Cached-state retry** (C.3): webview boot must not depend on a single postMessage.
  Delays [500,1500,3500,7000,12000,20000], connected-gated, target-checked.
- **Readiness gate** (E.3): URL handout requires `connected`; error fails fast; the
  timeout returns the current URL possibly null. Never route traffic to a URL before
  the health gate flips.
- **Worktree removal vs. bootstrap** (F.4): removal waits for the same directory's
  in-flight bootstrap; a create failure cleans up an empty non-attached directory.
- **Optimistic staging races** (F.5): per-path stage retry; partial failures must not
  erase completed sibling paths.
- **One broken layer must not poison siblings** (`opencodeConfig` merge + fail-closed
  writes) and one broken entity (unreadable preferences.json) must not seed over or
  rewrite.

### L.2 Registry-gate semantics (what breaks when stale)

`settings-registry.json` is generated from the UI package's settings registry (root
script `settings-registry:generate`). Semantics: the bridge write path drops keys the
gate does not list or marks `computed`/`local`/`owner:'desktop-shell'`; the read path
withholds `secret`. If the UI adds a key and the snapshot is not regenerated, that
setting saves silently fail (filter drops it) while other UI state keeps it in memory
until reload — implementers must wire the snapshot regeneration into their build/test
flow and never hand-maintain the JSON.

### L.3 SSE specifics

- Webview allocates stream ids and installs listeners before the start response (replay
  race).
- Stall watchdog 20 s closes a quiet upstream; reconnects are bounded 3/exp-backoff.
- `api:proxy` must reject `/event`/`/global/event` (mismatched paths otherwise silently
  downgrade to a non-streaming fetch).

### L.4 Localization completeness test

`localizationBundles.test.ts` asserts every locale file covers the full English key set
with the same `{0}` placeholders, for both `package.nls*.json` and `l10n/bundle.l10n*.json`.
Replicate this test whenever a new string lands.

### L.5 Windows specifics worth preserving

- Bash-shim launching via direct cmd.exe spawn (quoted args) — `shell:true` breaks on
  spaces (A.4/E.1).
- `core.longpaths` for worktree population (F.4) plus the helpful error text when
  that still fails.
- Drive-letter normalization on every path comparison (G.5, D.7 addFolder, working dir).
- `PATHEXT`-aware PATH scanning and `where opencode` fallback (E.1).
- Windows ARM64 upgrade block (E.4).

### L.6 Dead surface note (parity honesty)

Per the reachability map (src DOCUMENTATION.md), these bridge handlers have no
reachable caller in the VS Code webview because the surfaces that use them are not
mounted: commit/checkouts (`api:git/commit*`, checkout/reset/revert/cherry-pick write
paths), merge/rebase/conflict-details, push/pull/fetch UI, diff endpoints, PR
description, `api:git/identity`, `api:github/pr:create|merge|ready|update`, all
`api:fs:write|rename|delete|reveal|mkdir|exec` (Terminal API stub throws), and
`api:git/ignore-openchamber`. Reachable fs routes: `api:fs:read` (attachments),
`api:fs:search` (composer mentions), `api:fs:list`, `api:fs:stat`. Still implement them
unless you intentionally cut the same surfaces; they are the same contract the shared
UI expects on other runtimes.

### L.7 Test catalog (feature-complete parity tests to port)

Existing tests cover, in their own harness: cached-state retry scheduling (target
invalidation), active panel routing, delivery of queued line comments (drain list),
reconcile/false-snapshot semantics (`reconcileThreadFate`, `snapshotOwnsThread`),
inline comment target resolution + removal tombstones, settings two-file
marshal (parse/serialize/build/flatten/seed), registry gate filtering,
project-setup sanitization (commands/actions/starters/trust hash/plansDir) and shared
config patch round-trip, permission auto-accept serialization, exe-dev/ollama/cursor
quota parsing, `resolveWorkspaceFolders` dedup, `workingDirectoryChange` purity,
provider-env aliases parity, network defaults, localization bundles, opencode-ready
gating, upgrade capability/version comparison, worktree bootstrap + fetch-fallback
(gitService tests), path normalization (drive letters), harness binary validation
(desktop-app rejection), webview dev-server resolution, generated HTML (CSP +
bootstrap globals), git generation model choice, provider env aliases, opencodeConfig
JSONC layer parsing, skills discovery merge.

---

## M. Build checklist (feature-complete parity definition)

A rebuild is parity-complete when:

1. **Manifest contribution** — all 17 commands + 5 internal commands with identical ids,
   menus (submenu, thread menus with controller id gate, palette hides, explorer/title/
   view-title groups), the two configuration keys with default `""`, activation events
   limited to the three triggers, activity-bar container + webview view.
2. **Multi-host webview protocol** — three hosts, identical message envelope, command
   catalog (C.1), theme payload with Shiki extraction, cached-state retries, response
   ack/retry, SSE start/stop with webview-allocated ids, panel-provider holds for
   comments.
3. **Bridge routing** — delegation order and the full route catalog of D (incl. the
   GitHub-disabled family and explicit 501s), error envelope discipline.
4. **Harness lifecycle** — external-attach mode via `openchamber.apiUrl`, managed spawn
   with the exact CLI-resolution order and desktop-app rejection, health probe, basic
   auth, registry-backed orphan reaping, restarts with password rotation, upgrade
   capability/flow, `waitForApiUrl` gating, activity watcher.
5. **Git composition** — vscode.git + raw git composition, all F branches including
   worktree bootstrap phases, longpaths, post-checkout hook, fetch-fallback,
   index.lock recovery, upstream setup with config fallback.
6. **Settings parity** — two-file store, seeding/unreadable-file semantics, VS Code
   surface kind, registry gate + snapshot regeneration, derived fields, secret
   withholding, globalState migration.
7. **Project setup parity** — personal + shared merge rules, bounded file stem,
   chain-writes, trust hash.
8. **Quota stack** — provider matrix H (all 23 ids), coalescing, cooldowns, managed
   credential store, validation-before-write, import path for cursor.
9. **Theming/localization** — theme kind mapping, Shiki contributed-theme extraction
   with one-sided fallback, splash locale from saved preference/host language, NLS
   bundles + completeness test.
10. **Asset/CSP/security** — CSP exact (blob only in worker-src), fetch interception
    layer incl. the local route table with 501 stubs, auth sealing, Windows path rules.
11. **Diagnosis** — status output with probe table; restart command prefers webview
    reload flow.
12. **Packaging** — esbuild + Vite pipeline, `.vscodeignore` shape, vsce
    no-dependencies, generated changelog read-only.

---

## Appendix: quick cross-reference map

| Concern here | Canonical doc |
|---|---|
| `RuntimeAPIs` member implementations (webview/api/*) | 01 shared-UI adaptation layer |
| OpenCode API routes consumed (`/session`, `/event`, `/global/health`, `/config`) | 02 harness contract |
| OpenChamber server settings/projects routes this extension mirrors locally | 03, doc 14 |
| Chat containers, composer, tool UIs consuming commands | 05 |
| Agent Manager product behavior | 12 |
| Settings pages, theme tokens, i18n bundles | 14 |
| Session sync/message ordering (unchanged: extension passes records through) | 01 (sync) |

(End of document.)
