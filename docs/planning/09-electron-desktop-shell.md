# NotNativeDesktop — 09: Electron Desktop Shell (Cleanroom Reference)

Complete, self-contained specification of the OpenChamber Electron desktop
shell: process architecture, in-process backend hosting, the full IPC/bridge
catalog, window and Mini Chat lifecycle, the embedded browser panel, SSH
flows, the update pipeline, tray/menus/OS integration, notifications and deep
links, autostart, packaging, security model, renderer recovery, and file
utilities — written so a team with ZERO access to the original repository can
re-implement it on their own agent harness (an OpenCode replacement).

Sources cited as `(src: packages/electron/...)` are for traceability only;
every channel name, payload shape, constant, and permission decision is
inline.

Ownership split across this reference set: #01 owns shell boot basics and the
runtime adaptation matrix; #08 owns relay/tunnel/pairing protocols and the
SSH UX model; #03 owns the server and CLI (this doc records how Electron
hosts and uses them); #04/#05 own renderer state and chat/session UI
semantics; #10/#11 own their packages; #14 owns settings and theme; #12 owns
scheduled-task tray/notification semantics. This doc owns every native
mechanism.

---

## 1. Process Architecture

(src: packages/electron/README.md; packages/electron/main.mjs; preload.mjs)

### 1.1 The four kinds of runtime pieces

1. **Electron main process** — runs `main.mjs` (packaged builds run the bundled `dist-bundle/main.mjs`). It hosts:
   - all window management, menus, tray, notifications, deep links, updater;
   - the SSH manager and its `ssh` child processes;
   - local tunnel listeners (dev-tunnel and the relay dev-tunnel bridge);
   - **the entire OpenChamber web server, in-process, as a dynamic ESM import.** There is NO sidecar subprocess. `main.mjs` does `await import('@openchamber/web/server/index.js')` and calls `startWebUiServer()`. The same Node process that runs Electron's main loop runs the server.
2. **Preload script** (`preload.mjs`) — runs once per document (sandbox off), exposes `window.__OPENCHAMBER_DESKTOP__` and other globals (11.2).
3. **Renderer** — the shared React UI (`packages/ui`), loaded from one of:
   - the **in-process server** at `http://127.0.0.1:<port>`;
   - a **Vite HMR dev server** at `http://127.0.0.1:<uiPort>` (dev default);
   - the **privileged packaged protocol** `openchamber-ui://app` (packaged builds, and dev with `OPENCHAMBER_ELECTRON_USE_BUNDLED_UI=1`);
   - a **remote instance URL** `http(s)://<host>/` when the window is switched to a remote OpenChamber server that serves its own UI.
4. **Webview guests** — `<webview>` elements used by the embedded browser panel in partition `persist:openchamber-browser`, plus any same-origin iframes the shared UI creates for session isolation (iframe handshake is #04/#05 territory; desktop-side facts are in 11.3).

The main process may also spawn: detached helper scripts (AppImage-safe
OpenCode killer, `cmd start` blocks), `open`/editors for open-in-app, SSH
processes, `sw_vers`/`reg.exe`/`where.exe`/login-shell probes.

**Invariant (hard rule):** the OpenChamber web backend is never a sidecar. It
starts in the Electron main process. `killSidecar()` (a legacy name) only kills
the *managed OpenCode CLI child* that the in-process server spawned; the server
itself dies with the Electron process. (src: README.md "How It Runs";
main.mjs `killSidecar`, `spawnLocalServer`.)

### 1.2 Startup constants and identity

| Constant | Value | Purpose |
|---|---|---|
| Deep-link protocol | `openchamber` | set as default protocol client at boot |
| Privileged UI protocol | `openchamber-ui` | registered privileged: `{ standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }` |
| AppUserModelId | packaged `dev.openchamber.desktop` / dev `dev.openchamber.desktop.dev` | Windows identity |
| App name | `OpenChamber` | `app.setName` before log init (log dir `~/Library/Logs/OpenChamber/`) |
| Linux desktop name | `openchamber.desktop` | `app.setDesktopName` on Linux |
| Background-start argv | `--background` | login-item launch argument |
| Dev user-data dir | `OpenChamber Dev` under `appData` | dev never overwrites packaged state |
| Default local port | `57123` | first candidate for the in-process server |
| Bind hosts | loopback `127.0.0.1` default; `0.0.0.0` when LAN access enabled (password required) | server bind |
| Min window / min restore | 800x520 / 900x560 | hard minimums |
| Mini Chat window | 520x760, min 360x480 | floating window |
| Max capture rect area | 4,000,000 px^2 | screenshot clamp |
| Local host id | `local` | reserved; never storable as a remote host |
| `desktop-local` client kind + dedupe `desktop-local` / `desktop` client kind | — | client-auth kind for the machine's own server / every other server |
| Env override host id | `__env` | identifies `OPENCHAMBER_SERVER_URL` target |
| Update install grace | 15,000 ms | window for `quitAndInstall()` |
| Installed-apps cache TTL | 86,400 s | `discovered-apps.json` freshness (cache version 2) |
| Linux desktop-entry cache TTL | 30,000 ms | in-memory FreeDesktop entries |
| OpenCode shutdown grace | 100 ms | TERM→KILL gap for the managed tree |
| UI password | `desktopUiPassword` | settings key, handed to the server as `OPENCHAMBER_UI_PASSWORD` |

`isDev` is `OPENCHAMBER_ELECTRON_DEV === '1' || !app.isPackaged`.

### 1.3 Boot flow (numbered)

Module load, before `app.whenReady()`:

1. `app.setName('OpenChamber')`; on Linux `app.setDesktopName`; when dev redirect `userData` to `OpenChamber Dev`; `app.setAppUserModelId`.
2. Chromium switch `--proxy-bypass-list=<-loopback>` (local requests never go through a system proxy).
3. `applyConnectAttemptTimeout()` — raise Node/undici happy-eyeballs connect timeout above the 250 ms default (distant LLM endpoints otherwise fail with "fetch failed"). No-op without the setter.
4. Register `openchamber-ui` as privileged (1.2).
5. `app.requestSingleInstanceLock()` — failure → `app.exit(0)` + `process.exit(0)`.
6. `process.chdir(os.homedir())` (best effort) — fallback cwd for child processes.
7. Initialize electron-log: file transport `info`, 5 MB rotation; console `debug` in dev, `warn` in packaged. **`Object.assign(console, log.functions)`** — the in-process server logs through plain `console.*`; without this bridge, server-side diagnostics never reach the log file.
8. Delete files in the log directory older than 7 days.
9. Register the `openchamber://` protocol client if not already default.
10. Read app metadata: locate the electron package.json (candidates: `__dirname`, parent dir, `app.getAppPath()`), require `name === '@openchamber/electron'`, read `version` (APP_VERSION). Also always `app.getVersion()` fallback for device metadata.

At `app.whenReady()`:

11. Startup-perf phase `electron.app.ready` (opt-in via `OPENCHAMBER_STARTUP_PERF=1`).
12. Read login-item settings; compute `isBackgroundStart` (`--background` in argv, or `wasOpenedAtLogin`/`wasOpenedAsHidden`).
13. Log app-start record: version, packaged, platform, arch, argv, isBackgroundStart, loginItemSettings.
14. `nativeTheme.themeSource = readThemeSource()` — persisted `themeMode` (`system|light|dark`) wins; `themeVariant` only when mode absent; per `readPreferencesValues` the **desktop surface** value of a preference key wins over its base value.
15. `registerPackagedUiProtocol()` — no-op unless packaged UI mode (6.3).
16. `hardenBrowserPanelSession()` (7.4).
17. `setupAutoUpdater()` — dev no-op; packaged configures feed + listeners (9.1).
18. Set application menu: `buildMacMenu()` on macOS; `buildAutoHiddenMenu()` on Windows/Linux (10.3).
19. `setupTray()` (10.1) — seeds an empty snapshot so the icon appears immediately.
20. Reconcile login items (packaged only):
    - macOS/Windows: `setLoginItemSettings({ openAtLogin: <persisted>, openAsHidden: <persisted> (mac), args / getLoginItemOptions (win) })`. Windows login item options: `{ path: process.execPath, args: ['--background'], name: APP_USER_MODEL_ID }`.
    - Linux: if the XDG autostart file exists, REWRITE it with the current launch executable (AppImage updates change the path).
21. If `isBackgroundStart`: run the full URL resolution (2.3), store `localOrigin/apiBaseUrl/clientToken/bootOutcome/requestHeaders`, set `state.startupResolved = !shouldSkipLocalServer()`, build the init script, log "started in background without window", return. NO window. Serverless background startup re-probes the remote when a window is eventually opened instead of trusting login-time reachability.
22. Otherwise: create the main window immediately with the SPLASH URL (`createBrowserWindow({ label: 'main', restoreGeometry: true, url: null })` → loads a `data:text/html` splash (4.2)), extract deep links from argv (`openchamber://…`) into the pending queue, then `await resolveInitialUrl()` and `await activateMainWindow(initialUrl, …)` which navigates the main window from splash to real application URL.
23. Register `powerMonitor.on('resume')` → emit `openchamber:system-resume { timestamp }` to every window (renderer reconnects SSE immediately instead of waiting for its heartbeat watchdog).
24. Startup failure → `log.error('[electron] startup failed:', error)` and `app.exit(1)`.

Splash dismissal is renderer-side: the shared UI waits for
`window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__` (injected via the dom-ready init
script) before showing chooser/recovery views, and additionally waits for app
initialization for the `main` view (2.5, and #01).

### 1.4 Dev boot vs packaged boot

**Dev** (`bun run electron:dev`, driven by `scripts/electron-dev.mjs`):

1. Electron binary self-check/repair (`ensure-electron.mjs`, fail-fast first): Electron's postinstall can silently unpack only the first zip entry under Node 24, leaving `dist/` without the binary. The check detects missing/stale/wrong-arch installs and repairs by re-running the postinstall under Bun (falls back to Node; resolves npm `bun.cmd` shims to `bun.exe` on Windows). `ELECTRON_SKIP_BINARY_DOWNLOAD=1` skips (CI).
2. Find free ports near the preferred HMR API port (`OPENCHAMBER_HMR_API_PORT`, default `3901`) and UI port (`OPENCHAMBER_HMR_UI_PORT`, default `5173`), scanning up to +50.
3. Spawn `node ./scripts/dev-web-hmr.mjs` with `OPENCHAMBER_ELECTRON_DEV=1` and `OPENCHAMBER_DISABLE_PWA_DEV=1` (Windows: npm `.cmd` shims run via `cmd /d /s /c call "…" "args…"`).
4. Spawn Electron (`bun x electron ./main.mjs`, cwd `packages/electron`).
5. Either child exiting tears down the other: SIGINT → 2.5 s wait → (Windows) `taskkill /PID <pid> /T /F` → SIGTERM → SIGKILL escalation.
6. Ctrl+C on the launcher bypasses Electron's quit flow, so `main.mjs` handles `SIGINT`/`SIGTERM`/`SIGHUP` itself: `shutdownBackgroundServices()` (kills the managed OpenCode tree, closes SSH) then `app.exit(0)` (1.7).

URL resolution in dev (2.3) probes the HMR API port (5 s) as the local
backend, else spawns the in-process server; the UI URL is the HMR UI server
(8 s wait), falling back to the server origin.

`bun run electron:dev:bundled` = dev launcher with
`OPENCHAMBER_ELECTRON_USE_BUNDLED_UI=1`: it first runs `build:web-assets`
(builds `packages/web`, stages into `resources/web-dist`), then Electron
loads packaged assets — use it to validate packaged behavior.

**Packaged**: `shouldUsePackagedUi()` returns `app.isPackaged` unless
`OPENCHAMBER_ELECTRON_LOAD_SERVER_UI=1` (force server-served UI) or
`OPENCHAMBER_ELECTRON_USE_BUNDLED_UI=1` (force bundled in dev). Window URL
`openchamber-ui://app/index.html`; `resourceRoot()` = `__dirname/resources`
dev, `process.resourcesPath` packaged.

### 1.5 User shell environment inheritance

(src: main.mjs `inheritUserShellEnv`/`loadShellEnv`/`loadWindowsEnv`; runs
before the server import so the server AND its children — managed OpenCode
CLI, git, editors — inherit login-shell env)

1. Clear AppImage `ARGV0` from `process.env` FIRST (zsh otherwise rewrites child argv[0] to the AppImage path, breaking integrated terminals).
2. Windows: read machine + user `PATH` via `reg.exe query` of `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment` and `HKCU\Environment`, expand `%VAR%` refs, append common tool dirs: `~/.opencode/bin`, `~/.bun/bin`, `~/.local/bin`, `%LOCALAPPDATA%\Programs\Microsoft VS Code\bin`, `%LOCALAPPDATA%\Programs\Cursor\resources\app\bin`, `%APPDATA%\npm`.
3. macOS/Linux: probe `$SHELL` (or `/bin/sh`; skip nushell) ONCE via `spawnSync(shell, ['-il'-then-'-l', '-c', 'env -0'])`, 5 s timeout, NUL-separated parse.
4. Merge: set any var not already present; merge `PATH` (shell PATH first) on Windows or when the current PATH does not look user-configured.

### 1.6 Settings, preferences, identity

Settings file: `$OPENCHAMBER_DATA_DIR/settings.json` when set, else
`~/.config/openchamber/settings.json` (all platforms). `preferences.json`
beside it holds the post-split profile store; each entry is
`{ value, updatedAt, surfaces? }` and the desktop resolves the
`surfaces.desktop` value first, then the base (theme mode is read this way).

Desktop-owned settings keys:

| Key | Meaning |
|---|---|
| `desktopLocalPort` | last in-process server port (seed for next boot) |
| `desktopLanAccessEnabled` | bind 0.0.0.0 (requires UI password) |
| `desktopUiPassword` | UI password handed to the server |
| `desktopHosts` | saved host list (schema 4.1) |
| `desktopDefaultHostId` | boot target host (`local` = local server) |
| `desktopInitialHostChoiceCompleted` | first-run chooser gate |
| `desktopLocalClientToken` | bearer minted for the local server |
| `desktopInstallId` | per-install UUID (client dedupe key) |
| `desktopWindowState` | `{ x, y, width, height, maximized, fullscreen }` |
| `desktopSplashColors` | `{ bgLight, fgLight, bgDark, fgDark }` for the next splash |
| `desktopMinimizeToTrayEnabled` | close-to-tray (Win/Linux); minimize itself NEVER hides |
| `desktopKeepAwakeEnabled` | powerSaveBlocker prevent-app-suspension |
| `desktopMacMenuBarEnabled` | macOS tray/menu-bar gate (default enabled) |
| `desktopSshInstances` | SSH instance list (8.2) |
| legacy `splashBgLight/splashFgLight/splashBgDark/splashFgDark` | pre-split flat splash colors read as fallback |

Read/write protocol:

- Read: whole-file JSON; ENOENT → `{}`; parse error → warn + `{}` (the file may be mid-rename; never treat as corruption).
- Write: serialized inside the process through a `settingsMutationChain` promise chain (concurrent read-modify-write pairs would otherwise be interleaved across awaits and lose updates; the chain survives failures). Atomic write: temp file (`0600`, dir `0700` on POSIX) + rename, with the Windows retry (12.4).
- `desktop_device_metadata()` for client records: `{ devicePlatform: 'macos'|'windows'|'linux', appVersion }` — display-only, never used for auth decisions.
- `desktopInstallId`: `crypto.randomUUID()` persisted on first use (race guard: keep an id another writer already persisted).

### 1.7 Shutdown paths

State flags: `quitRequested`, `quitConfirmed`, `quitInProgress`,
`quitConfirmationPending`, `backgroundShutdownComplete`, `installingUpdate`,
`sshShutdownPromise`.

- **Risk-gated quit** (`requestQuitWithConfirmation`, macOS `before-quit` path): refresh flags from `serverHandle.getQuitRiskStatus()`; fallback without a handle: GET `</api/openchamber/scheduled-tasks/status>` and `</api/openchamber/tunnel/status>` (2 s timeouts). Flags: `hasActiveTunnel` (tunnel.active), `hasRunningScheduledTasks`/ `hasEnabledScheduledTasks` + counts. Nothing at risk → quit immediately. Otherwise a native warning dialog `Quit OpenChamber?` with buttons `[Quit, Cancel]` (Cancel default) and detail naming the risks ("OpenChamber detected an active tunnel, N running scheduled tasks...") or the generic "Background processes (sidecar, SSH sessions) will be stopped.". A hidden window is shown/focused first so the dialog has an owner; the pending flag prevents double dialogs.
- `performConfirmedQuit()` → `prepareForQuit()` → `app.exit(0)`. `prepareForQuit({ installingUpdate })`: set flags; DESTROY the tray controller + remove its focus listener; persist main-window geometry immediately; stop keep-awake; with `installingUpdate: true` mark background shutdown complete and RETURN (the update path kills the OpenCode child itself right before install); else run `shutdownBackgroundServices()`.
- `shutdownBackgroundServices()` (idempotent): stop keep-awake; launch the detached managed-OpenCode killer (1.8); `setImmediate(() => shutdownSshSessions())` → `sshManager.shutdownAll()`.
- **Hard signals** SIGINT/SIGTERM/SIGHUP: `shutdownBackgroundServices()` then `app.exit(0)` (the startup reaper is the SIGKILL backstop).
- `window-all-closed`: macOS and not quitting → stay alive (Dock). Otherwise `installingUpdate ? app.quit() : performConfirmedQuit()`.
- `before-quit`: set `quitRequested`; close ALL dev tunnels (loopback listeners must not outlive their window); `installingUpdate` → return; macOS unconfirmed → preventDefault + confirmation; if background shutdown has not run → preventDefault + `performConfirmedQuit()`.
- Window close paths that HIDE instead of closing (5.4) never reach `window-all-closed`.

### 1.8 Killing the managed OpenCode tree

(src: main.mjs `launchDetachedOpenCodeKiller`; only `managed` trees, from
`serverHandle.getOpenCodeProcessInfo()` → `{ managed, pid?, port? }`)

- Windows: detached HIDDEN PowerShell `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand <base64-utf16le>`; script recursively stops the tree (`Get-CimInstance Win32_Process -Filter "ParentProcessId=…"` depth-first), `Stop-Process` soft, sleep 100 ms, `Stop-Process -Force`.
- macOS/Linux: immediate `process.kill(-pid, 'SIGTERM')` + `process.kill(pid)`, then a detached `/bin/sh -c <script> <pid> <port> <graceSecs>` helper that after `grace` seconds SIGKILLs `-$pid` and `$pid` and then kills anything still listening on the port via `lsof -tiTCP:<port> -sTCP:LISTEN` / `lsof -ti :<port>` (excluding itself).

`killSidecar()` clears `state.serverHandle`/`sidecarUrl`, then launches the
killer; failures are logged and swallowed. The killer survives the app
(by design — on Windows the server's death alone would not reap the child).

---

## 2. In-Process Server Hosting and Startup URL Resolution

### 2.1 Spawn: `spawnLocalServer`

(src: main.mjs)

1. Phase `electron.server.start`; re-run env inheritance.
2. Read settings: stored port, LAN access, keep-awake (start/stop blocker), UI password. **LAN access without a password is blocked**: bind loopback, warn, set `OPENCHAMBER_DESKTOP_LAN_ACCESS_BLOCKED_REASON=missing-password`.
3. Port candidates `[storedPort, 57123]`; `isPortFree(candidate, bindHost)` test-binds each; none free → `pickUnusedPort(bindHost)` (bind port 0, read assigned port). Selection happens BEFORE importing the server: module import wires global runtimes, and a retry after a listen failure would double-wire them.
4. Set server environment BEFORE the first import (module reads them at import time): `OPENCHAMBER_HOST` = bind host; `OPENCHAMBER_DESKTOP_LAN_ACCESS_ACTIVE` = 'true'|'false'; `OPENCHAMBER_DIST_DIR` = `resources/web-dist`; `OPENCHAMBER_RUNTIME` = 'desktop'; `OPENCHAMBER_OPENCODE_CWD` = `resolveManagedOpenCodeCwd` (opencode-cwd.mjs: env value wins, else homedir, else `process.cwd()` — userData would look like an empty workspace); `OPENCHAMBER_DESKTOP_NOTIFY` = 'true'; `OPENCHAMBER_UI_PASSWORD` set/deleted; `OPENCHAMBER_SKIP_API_COMPRESSION` default 'true'; `NO_PROXY`/`no_proxy` default 'localhost,127.0.0.1'.
5. `await import('@openchamber/web/server/index.js')`; `startWebUiServer({ port, host, uiPassword, attachSignals: false, exitOnShutdown: false, apiOnly: false, onDesktopNotification, getIsWindowFocused, getDesktopRuntimeConfig, desktopUpdater })`.

Handle contract (a cleanroom reimplementation must provide):
`getPort()`; `getOpenCodeProcessInfo()` (managed OpenCode pid/port for the
killer); `getQuitRiskStatus()` → `{ tunnel?: { active }, scheduledTasks?: {
hasEnabledScheduledTasks, hasRunningScheduledTasks,
enabledScheduledTasksCount, runningScheduledTasksCount } }`; callbacks:
`onDesktopNotification(payload)` → native notification pipeline (10.2)
(flat or wrapped `{ payload }`); `getIsWindowFocused()` → any live window
focused (server suppresses notifications while the user watches);
`getDesktopRuntimeConfig()` → `{ apiBaseUrl, requestHeaders }` (the host
the shell currently targets; server-side calls follow it); `desktopUpdater
= { check, install, restart }` routed internally to
`desktop_check_for_updates` / `desktop_download_and_install_update` /
`desktop_restart` with a null window, so an authenticated web client of the
embedded desktop host uses the native updater instead of a package-manager
command (#03/#14 own the routes).

6. After listen: phase `electron.server.ready`; persist `desktopLocalPort`; `state.serverHandle = handle; state.sidecarUrl = url`; return `http://127.0.0.1:<port>`. Readiness gating: `startWebUiServer` resolves after bind; the splash window navigates to the real URL only then (via `activateMainWindow`).

### 2.2 Health polling helper

`waitForHealth(url, timeoutMs = 20000, initialPollMs = 250, maxPollMs =
2000)`: poll `<url>/health` with `fetch` (per-request AbortSignal timeout
min(poll*4, 1500) ms), backoff up to `maxPollMs`, until OK or deadline.
Used ONLY for HMR probes in dev; the in-process server is awaited directly.

### 2.3 `resolveInitialUrl` — boot target selection

(src: main.mjs; startup-url-selection.mjs)

- HMR API/URL ports default 3901/5173.
- Probe plan (pure):
  - `probeHmrApi = development && !packagedUi && !skipLocalServer`;
  - `probeHmrUi  = development && !packagedUi`;
  - `ignoreLoopbackConnectionLimit = !(development && !packagedUi)` — the Chromium connection-limit lift applies only for bundled UI (NOT dev HMR: the module graph would flood Vite's transform pipeline and stall React mount for up to a minute behind the splash).
- `skipLocalServer` = `OPENCHAMBER_SKIP_LOCAL_SERVER === '1'` (env-inheriting read). With skip, the local server is NOT started; UI must come from bundled assets, HMR, or a reachable remote (else startup throws).

Flow:

1. `localUrl` = HMR API (if planned and healthy within 5 s) else `await spawnLocalServer()` (unless skipped → null).
2. `localUiUrl` = packaged `openchamber-ui://app/index.html` if packaged UI mode; else HMR UI within 8 s; else `localUrl`.
3. Defaults: `apiBaseUrl = localUrl`, `clientToken = readDesktopLocalClientToken()`, `requestHeaders = {}`.
4. **Env override** `OPENCHAMBER_SERVER_URL` (normalized http(s)): `apiBaseUrl = envTarget`, no token/headers; `initialUrl` = packaged UI when packaged mode, else the remote URL itself.
5. Else **saved default host** (if `desktopDefaultHostId` set, not 'local', host found with URL): `apiBaseUrl = host.apiUrl || host.url`, `clientToken`, sanitized headers; `initialUrl` = packaged UI (packaged mode) or `host.url`.
6. **Probe a remote apiBase** (`apiBaseUrl && apiBaseUrl !== localUrl`):
   - `probeHostWithTimeout(url, 2000, token, headers)` (2.6).
   - If `unreachable` AND the default host is NOT relay-capable → one retry with 10,000 ms.
   - If the final status is not `ok`:
     - relay-capable host (`sanitizeHostRelayForStorage(host.relay)` valid): boot the LOCAL UI with local runtime config. The renderer's relay restore owns transport selection for relay-capable hosts and must not be trapped on a recovery screen (the stored direct URL of a relay host is often the pairing creator's own loopback);
     - plain `unreachable`: add the URL to `state.unreachableHosts`, fall back to local UI + local token.
7. If `initialUrl` is still empty and `apiBaseUrl` exists and the probe was not unreachable → `initialUrl = apiBaseUrl` (remote serves its own UI).
8. No URL at all → throw `'OPENCHAMBER_SKIP_LOCAL_SERVER=1 requires bundled UI, a running desktop HMR UI, or a reachable remote instance.'`
9. `bootOutcome = computeBootOutcome(...)` (2.5).
10. Return `{ initialUrl, localOrigin, localUiUrl, bootOutcome, apiBaseUrl, clientToken, requestHeaders }`.

### 2.4 Main-window activation / reopen helpers

- `activateMainWindow(url, localOrigin, bootOutcome, runtimeConfig)`: sets `startupResolved`, stores localOrigin/apiBaseUrl/clientToken/headers/ bootOutcome into state, builds renderer runtime config + init script, syncs the live main window's `__ocInitScript`, then navigates the EXISTING main window (host switch; `allowAbort` so superseded navigations are not fatal) and shows it, or creates the window with `label 'main'` + geometry restore.
- `openMainWindow()`: after startup is resolved, resolve the default host:
  - relay-capable host → local UI + local runtime config (renderer restores relay);
  - else host URL, unless it is in `state.unreachableHosts` → local UI.
- `createAdditionalWindow(url, runtimeConfig)`: only after `startupResolved`; never restores geometry (fresh 1280x800). Host-aware variants: `desktop_new_window_for_host` boots relay-capable hosts as local UI with `relayHostId` injected (a fixed apiBaseUrl would strand the window when the direct leg is down); `desktop_new_window_at_url` takes an arbitrary URL.

### 2.5 Boot outcome (renderer-visible)

`computeBootOutcome({ envTargetUrl, probe, config, localAvailable })` produces:

```
DesktopBootOutcome =
  | { target: 'local',  status: 'ok' }
  | { target: 'remote', status: 'ok'; hostId: string; url: string }
  | { target: null,     status: 'not-configured' }
  | { target: 'local',  status: 'unreachable' }
  | { target: 'remote', status: 'unreachable';   hostId; url }
  | { target: 'remote', status: 'incompatible';  hostId; url }
  | { target: 'remote', status: 'wrong-service'; hostId; url }
  | { target: 'remote', status: 'missing';       hostId }
  every variant may carry `localAvailable?: boolean` (false only when false)
```

Rules: env target wins (hostId `__env`); no defaultHostId →
`not-configured`; `local` + `localAvailable` decides `ok|unreachable`; saved
host absent → `missing`; probe passthrough otherwise; **a relay-capable host
whose direct URL failed is reported `remote/ok`** (renderer re-selects
transport itself; never a recovery screen).

Renderer: `packages/ui/src/lib/desktopBoot.ts` validates the injected payload
from `window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__`:

- `getBootInjectionStatus()` → `not-injected` (absent/null: keep waiting), `malformed` (present but invalid — deterministic failure), `valid`.
- `resolveDesktopBootView({ isDesktopShell, bootOutcome })`: local ok → `{ screen: 'main' }`; remote ok → `{ screen: 'main', hostId, url }`; `not-configured` OR local unreachable → `{ screen: 'chooser' }`; remote unreachable/incompatible/wrong-service → `{ screen: 'recovery', variant: 'remote-unreachable'/'remote-incompatible'/'remote-wrong-service', hostId, url }`; remote missing → `{ variant: 'remote-missing', hostId }`; unknown or malformed → `null`.
- `canDismissInitialLoading({ isDesktopShell, isInitialized, bootOutcomeKnown, bootViewIsMain })`: non-desktop → `isInitialized` only; desktop → requires a valid injected outcome; chooser/recovery dismiss without app init (the backend may be legitimately unavailable); `main` requires `isInitialized`.
- `shouldRestartDesktopBootFlow({ isDesktopShell, isDesktopLocalOriginActive })` → true when desktop + local HTTP origin not active: packaged UI with no local server cannot reload itself or reach `/api/*`; callers restart the desktop (`desktop_restart`) instead.

The outcome reaches the renderer via the per-document init script (2.7).

### 2.6 Host probe (Chromium `net.fetch`, single deadline)

(src: electron-host-probe.mjs; host-probe-policy.mjs)

`probeHostWithTimeout(url, timeoutMs, clientToken, requestHeaders,
expectedServerId)` → `probeElectronHostWithDeadline({ url, timeoutMs,
clientToken, requestHeaders, expectedServerId, chromiumFetch:
electronNet.fetch, isReady: () => app.isReady() })`.

**Policy**: fast attempt 2,000 ms; ONLY `status === 'unreachable'` triggers
one retry at 10,000 ms. Any other status returns immediately.

**Result domain**: `ok | auth | unreachable | incompatible | wrong-service |
update-recommended`; `latencyMs` = the FINAL attempt's application-probe
duration only (never the failed first attempt, never raw ping).

Per attempt (one shared `AbortController` + deadline over EVERYTHING,
including JSON body reads):

1. App not ready → `unreachable`.
2. Build `<url>/api/version`, `<url>/auth/session`.
3. **Identity gate** (only when `expectedServerId` non-empty): GET `<url>/health`, `Accept: application/json`, **no bearer, no custom headers, `redirect: 'manual'`**. Manual redirect (3xx, `response.redirected`, or Electron 43's thrown `'Redirect was cancelled'`) → `wrong-service` BEFORE any bearer-bearing request; 200 with a different present `serverId` → `wrong-service`; absent serverId (older servers) → continue; other health failures (non-deadline) → continue (identity optional; the authenticated check is authoritative).
4. **Authenticated checks** share the deadline; headers = sanitize(headers)
   + `Accept: application/json` + `Authorization: Bearer <token>`:
   - `/api/version`: 401/403 → `auth`; not OK → `unreachable`; envelope `{ status: 'ok', compatibility: <object-or-array> }` shape mismatch → `wrong-service` (arrays historically classify as incompatible, not wrong-service, only via the capabilities check); then `compatibility.capabilities` must include `'api.runtime-url.v1'` → else `incompatible`; `compatibility.apiVersion !== 1 || compatibility.minClientApiVersion > 1` → `update-recommended`; else `ok`.
   - `/auth/session`: 401/403 → `auth` ("authentication required", never "offline"); not OK → `unreachable`; OK → `ok`.
5. Any thrown error (not the deadline) → `unreachable`.
6. Cleanup in `finally` (EVERY exit): abort the controller; `response.body.cancel()` EVERY captured response (including one whose JSON was never needed); then cancel the deadline timer. TLS stays verified.

### 2.7 Renderer runtime-config plumbing

`buildRendererRuntimeConfig(uiUrl, runtimeConfig)`:

- computes `{ apiBaseUrl, clientToken, requestHeaders, relayHostId }` (headers sanitized).
- **Dev same-origin proxy mode**: when `isDev && uiUrl && apiBaseUrl && !packaged Ui && !sameOrigin(uiUrl, apiBaseUrl) && isLocalRuntimeUrl(apiBaseUrl)` the config collapses to `apiBaseUrl: '', clientToken: '', requestHeaders: {}` (the Vite dev server proxies `/api`; renderer uses same-origin calls with no injected credentials).
- `isLocalRuntimeUrl(url)`: same origin as the local server OR same port with a machine-local hostname (`localhost|127.0.0.1|::1|0.0.0.0|::` or any `os.networkInterfaces()` address). A desktop bound to 0.0.0.0 reached via a LAN IP is still "local" and must receive the `desktop-local` client kind.
- `relayHostId`: non-empty tells the renderer (via the `__OPENCHAMBER_RELAY_HOST_ID__` global, local pages only) which saved relay host to reconnect at startup (#08 owns the tunnel protocol).

Window plumbing (every BrowserWindow):
- `webPreferences.additionalArguments`: `--openchamber-local-origin`, `--openchamber-api-base-url`, `--openchamber-client-token`, `--openchamber-runtime-headers` (JSON), `--openchamber-home`, `--openchamber-macos-major`, `--openchamber-tray-enabled`, and (main/add windows) `--openchamber-boot-outcome` (JSON), `--openchamber-relay-host-id`.
- Preload re-executes on every cross-origin navigation (sandbox:false, per-document) and reads these argv values (11.2).
- Per-document init script (`buildInitScript`, `executeJavaScript` on every `dom-ready`) re-injects the same values as `window.__OPENCHAMBER_*` globals, never clobbering values a remote page set, and additionally injects the boot outcome. Its gating:
  - computed flags inside the script: `__oc_is_packaged` = current origin equals `openchamber-ui://app`; `__oc_is_local` = origin equals local origin;
  - `__OPENCHAMBER_MACOS_MAJOR__`, `__OPENCHAMBER_LOCAL_ORIGIN__`, `__OPENCHAMBER_API_BASE_URL__`, and (conditional, non-empty) `__OPENCHAMBER_CLIENT_TOKEN__`, `__OPENCHAMBER_HOME__`, `__OPENCHAMBER_RUNTIME_HEADERS__` (the latter three only for local-or-packaged pages);
  - `__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__` whenever an outcome exists (writable; must stay writable so re-navigations refresh it — contextBridge globals are read-only, which is why injection is used).
- Packaged-UI HTML also embeds (`injectRuntimeConfigIntoHtml`) the three basic globals (`__OPENCHAMBER_LOCAL_ORIGIN__`, `__OPENCHAMBER_API_BASE_URL__`, `__OPENCHAMBER_CLIENT_TOKEN__`) guarded with `=== undefined` checks so even the first document render before dom-ready has them (6.4).

### 2.8 Hosts config schema (persisted)

(src: main.mjs `buildStoredHostEntry`, `sanitizeHostRelayForStorage`;
mirrored in ui/desktopHosts.ts)

```
DesktopHost = {
  id: string                      // trimmed; 'local' reserved
  label: string                   // fallback: url, or 'relay://<serverId>'
  url: string                     // sanitized http(s) URL without hash;
                                  // relay-only hosts: 'relay://<serverId>'
  apiUrl?: string                 // http(s) API origin for runtime config
  clientToken?: string            // non-empty after sanitize
  requestHeaders?: Record<string,string>   // sanitized; never Authorization
  relay?: { relayUrl: 'ws:'|'wss:' URL string;
            serverId: string;
            hostEncPubJwk: EC JWK (kty, crv, x required) }
}
DesktopHostsConfig = { hosts: DesktopHost[]; defaultHostId: string|null;
                       initialHostChoiceCompleted: boolean }
```

Sanitization: id required and not `'local'`; a host carries a direct
transport, a relay transport, or BOTH (multi-transport: direct at home,
relay away — mirrors the mobile model). Direct present → `url = sanitize
(url)`, `apiUrl = sanitize(apiUrl) || url`. Only relay → `url =
relay://<serverId>` (display-only pseudo-URL, never fetched). Relay JWK
shape-checked at storage time (`kty`, `crv`, `x` strings) so malformed
descriptors fail early rather than as tunnel-handshake errors. The relay
ADMISSION GRANT (one-time pairing artifact) is never persisted — steady-state
relay connects route by `serverId` alone, pinned by the public key.

`desktop_hosts_set`: rebuild every entry through the sanitizer; store `hosts`,
`defaultHostId`, `initialHostChoiceCompleted`; when the input carries the
`localClientToken` key add/delete `desktopLocalClientToken`; recompute
`state.bootOutcome` and re-sync the main window's init script.

### 2.9 Creating/refreshing a client record remotely

`loginRemoteAndIssueClientToken({ url, password, trustDevice, requestHeaders
})` (Command `desktop_remote_password_login`):

- POST `<url>/auth/session` (10 s timeout) with `{ password, trustDevice, issueClientToken: true, clientLabel: 'OpenChamber Desktop', clientKind, dedupeKey, devicePlatform, appVersion }` where the identity is `clientKind 'desktop-local'` + dedupeKey `'desktop-local'` for the machine's own server (`isLocalRuntimeUrl`) else `'desktop'` + `desktop:<installId>`.
- Response `clientToken` (string) → `{ ok: true, token }`; non-OK → `{ ok: false, status }`; if no token field, reuse the extracted `Set-Cookie` session to POST `<url>/api/client-auth/clients` with `{ label, ...identity }` (10 s timeout) and read `token`.
- Cookie extraction handles `headers.getSetCookie()` and a manual `set-cookie` header split, stripping attributes (first `;` segment).

---

## 3. IPC and Bridge Catalog (complete)

Renderer → main channels (registered in the main process):

| Channel | Payload | Gating | Returns |
|---|---|---|---|
| `openchamber:invoke` | `(command, args)` | sender gate (11.1): local pages unrestricted; remote pages only commands in `COMMANDS_SAFE_FOR_REMOTE` | per-command (3.1) |
| `openchamber:dialog:open` | `{ title?, defaultPath?, filters?: [{ name, extensions }], directory?: bool, multiple?: bool, returnGrant?: bool }` | **local-only** (native dialogs expose absolute local paths) | single path / `string[]` / `{ path, outsideFileGrant, expiresAt }` / array of those; `null` when canceled |
| `openchamber:file:grant-existing` | `filePath` | local-only | `{ path, outsideFileGrant, expiresAt }` via `mintOutsideFileGrant(path, { scopes: ['stat','read','raw'] })` (web-server lib) |
| `openchamber:emit` | main → renderer `{ event, detail }` | one-way notification | — (events in 3.2) |
| `openchamber:relay-dev-tunnel-connect` | main → renderer via `webContents.postMessage`, `{ connectionId, remotePort }` + transferred MessagePort | accepted only on LOCAL pages, requires `connectionId` string and `event.ports[0]` | renderer stores the port; protocol in 3.3 |

All three handler-style channels resolve into `ipcMain.handle`; every unknown
command rejects with `Unknown desktop command: <command>`.

### 3.1 `openchamber:invoke` command catalog

Per-command contracts. "G" column: **R** = in `COMMANDS_SAFE_FOR_REMOTE`
(remote pages may call), **L** = local senders only (11.1 list).

| Command | Args | Returns | G | Notes |
|---|---|---|---|---|
| `desktop_start_window_drag` | — | `null` | R | no-op placeholder for frameless drag |
| `desktop_focus_window` | — | `bool` | L | restore/show/focus the CALLING window (fallback: main), `app.focus({ steal: true })`; used when an MCP authorization completes in the system browser (a browser will not follow a custom-protocol link without a user gesture) |
| `desktop_is_window_fullscreen` | — | `bool` | R | calling window |
| `desktop_set_window_title` | `{ title }` | `null` | R | `window.setTitle` |
| `desktop_get_app_version` | — | `string` | R | electron package version |
| `desktop_get_launch_at_login` | — | `{ supported, enabled }` | L | Linux: XDG autostart file existence; mac/win: login-item `openAtLogin`; unsupported platforms `{ supported: false }` |
| `desktop_set_launch_at_login` | `{ enabled }` | `{ supported, enabled }` | L | Linux: write/remove `~/.config/autostart/openchamber.desktop` (Exec = AppImage or execPath + `--background`, `Terminal=false`, `X-GNOME-Autostart-enabled=true`, `StartupWMClass=openchamber`, desktop-entry quoting only when the arg contains space/tab/newline/quote/dollar/backslash); mac: `{ openAtLogin, openAsHidden }`; win: `{ openAtLogin, path, args: ['--background'], name, enabled }` |
| `desktop_get_minimize_to_tray` | — | `{ supported, enabled }` | L | supported on win32/linux; reads `desktopMinimizeToTrayEnabled` |
| `desktop_set_minimize_to_tray` | `{ enabled }` | status as above | L | persist + `setupTray()` ( ensures a tray exists to close into) |
| `desktop_get_keep_awake` | — | `{ supported: true, enabled, active }` | L | active = powerSaveBlocker running |
| `desktop_set_keep_awake` | `{ enabled }` | `{ supported: true, enabled, active }` | L | persist + start/stop `powerSaveBlocker('prevent-app-suspension')` |
| `desktop_dev_tunnel_open` | `{ baseUrl, port, relay?: true, targetKey?, requestHeaders?, clientToken? }` | `{ localPort, reused, url: 'http://127.0.0.1:<p>/' }` | **L (never in safe list)** | binds a loopback port piping to a remote dev server (7.7); `relay: true` opens the MessageChannel bridge keyed `webContentsId|targetKey|port` |
| `desktop_dev_tunnel_close` | `{ baseUrl, port }` | `{ closed }` | L | closes the direct HTTP dev tunnel |
| `desktop_relay_dev_tunnel_close_all` | — | `{ closed: <n> }` | L | closes all relay-bridge tunnels for the CALLING window |
| `desktop_browser_set_color_scheme` | `{ webContentsId, scheme: 'light'|'dark'|'system' }` | `{ scheme }` | L | debugger `Emulation.setEmulatedMedia` on the panel guest ONLY (session-membership check); attach failure → "Close DevTools for this page before changing its appearance"; `system` detaches |
| `desktop_browser_fetch_favicon` | `{ url }` | `{ dataUrl }` | L | http(s) only; fetched in the panel session; MIME allowlist `image/x-icon|image/vnd.microsoft.icon|image/png|image/jpeg|image/gif|image/webp|image/svg+xml`; ≤ 512 KB |
| `desktop_browser_clear_data` | `{ partition, cookies?, cache? }` | `{ cleared }` | L | partition must equal `persist:openchamber-browser` EXACTLY (prefix rejected); cookies → `clearStorageData(['cookies'])`; cache → `['localstorage','indexdb','websql','serviceworkers','cachestorage']` + `clearCache()` |
| `desktop_browser_capture_page` | `{ webContentsId }` | `{ mime: 'image/jpeg', base64, width, height }` | L | full-page JPEG (q82) of the panel guest; session-membership check |
| `desktop_capture_page_rect` | `{ x, y, width, height }` | `{ mime, base64, width, height }` | R | screenshot of the CALLING window's contents, clamped to content bounds, area ≤ 4,000,000 px² |
| `desktop_save_markdown_file` | `{ defaultFileName, content }` | path or `null` | L | native save dialog, `filters: [{ name: 'Markdown', extensions: ['md'] }]`; writes UTF-8 |
| `desktop_read_file` | `{ path }` | `{ mime, base64, size }` | L | 12.2 guard chain (home/tmp only; denied segments; 50 MB cap; MIME map) |
| `desktop_notify` | notification payload | `null` | L | native notification pipeline (10.2) |
| `desktop_tray_update` | `{ sessions, approvals, instanceName, usage, dockBadgeCount }` | `null` | R | tray snapshot (10.1); also drives `app.setBadgeCount(dockBadgeCount)` (macOS dock badge; 0 clears) |
| `desktop_clear_cache` | — | `null` | L | `session.defaultSession.clearStorageData()` + reload every window |
| `desktop_open_path` | `{ path, app? }` | `null` | L | `validateLocalPath` then mac `open [-a app] path`, else `shell.openPath` (app-specific open unsupported on win/linux for paths → the 12.5 unsupported error when an app is requested on those platforms) |
| `desktop_open_external_url` | `{ url }` | `null` | L | http(s) only → `shell.openExternal` |
| `desktop_reveal_path` | `{ path }` | `null` | L | directory → `shell.openPath`; file → `shell.showItemInFolder` |
| `desktop_open_in_app` | `{ projectPath, appId, appName }` | `null` | L | platform spec chains (10.4) |
| `desktop_open_file_in_app` | `{ filePath, appId, appName }` | `null` | L | file variant (open terminal in the file's directory) |
| `desktop_filter_installed_apps` | `{ apps: string[] }` | `string[]` | L | keep only installed apps (mac bundle lookup incl. `mdfind`; win `where.exe`/executable checks; linux FreeDesktop entry match) |
| `desktop_fetch_app_icons` | `{ apps: string[] }` | `[{ app, data_url }]` | L | mac: icns → sips PNG 32px → data URL; win: `app.getFileIcon(executable)` (Windows Terminal package path special-case); linux: FreeDesktop icon lookup → PNG data URLs only |
| `desktop_get_installed_apps` | `{ apps, force? }` | `{ apps: [{ name, iconDataUrl }], hasCache, isCacheStale }` | L | cached `discovered-apps.json` beside settings.json (TTL 24 h, cache version 2); stale/missing/force → background refresh + emit `openchamber:installed-apps-updated` with fresh results; unsupported platform → `{ apps: [], hasCache: false, isCacheStale: false, supported: false }` |
| `desktop_hosts_get` | — | `{ hosts, defaultHostId, initialHostChoiceCompleted, localOrigin }` | R | host switcher data |
| `desktop_hosts_set` | `{ input: { hosts, defaultHostId, initialHostChoiceCompleted, localClientToken? } }` | `null` | R← but local token write only meaningful on local pages | 2.8; recomputes bootOutcome + init script |
| `desktop_local_client_token_get` | — | token string | L | local server bearer |
| `desktop_install_id_get` | — | install id string | L (UI checks `hasDesktopInvoke` only) | per-install dedupe id |
| `desktop_host_probe` | `{ url, clientToken?, requestHeaders?, expectedServerId? }` | `{ status, latencyMs }` | R | 2.6 probe with fast/retry policy |
| `desktop_remote_password_login` | `{ url, password, trustDevice, requestHeaders? }` | `{ ok: true, token }` or `{ ok: false, status }` | L | 2.9 |
| `desktop_set_window_theme` | `{ themeMode?, themeVariant?, splash? { bgLight, fgLight, bgDark, fgDark } }` | `null` | R | persist splash colors (all four must be present); set `nativeTheme.themeSource` (mode wins over variant; `system` stays live-following); if titleBarOverlay were enabled, restyle it (currently disabled) |
| `desktop_check_for_updates` | — | `{ available, currentVersion, version, body, date }` | L | 9.3 |
| `desktop_download_and_install_update` | — | `null` | L | 9.4 |
| `desktop_restart` | — | hangs until quit/grace/failure on the apply path | L | 9.5 |
| `desktop_get_lan_address` | — | IPv4 string or `null` | R | UDP route lookup; fallback first non-internal IPv4 |
| `desktop_new_window` | — | `null` | R | additional window at the current default host (relay/unreachable-aware) |
| `desktop_new_window_for_host` | `{ hostId }` | `null` | R | 2.4 |
| `desktop_new_window_at_url` | `{ url, clientToken?, requestHeaders? }` | `null` | R | stored token from hosts when none provided; packaged UI mode wraps into the packaged origin |
| `desktop_open_session_mini_chat_window` | `{ sessionId, directory?, apiBaseUrl?, clientToken?, requestHeaders? }` | `null` | L | 4.6 |
| `desktop_open_draft_mini_chat_window` | `{ directory?, projectId? }` | `null` | L | 4.6 |
| `desktop_set_window_pinned` | `{ pinned }` | `{ pinned }` | L | mini chat only ("Pinning is only available for Mini Chat windows"); `setAlwaysOnTop('floating')`; unpin also clears macOS `setVisibleOnAllWorkspaces(false)` |
| `desktop_get_window_pinned` | — | `{ pinned }` | L | — |
| `desktop_focus_main_window` | `{ sessionId?, directory?, mode?, projectId? }` | `{ focused: true }` | L | raise main window; emit open-session/open-draft-session; dead main → queue pending deep link + `openMainWindow()` |
| `desktop_close_current_window` | — | `null` | R | — |
| `desktop_minimize_current_window` | — | `null` | R | ALWAYS a normal taskbar/dock minimize (never hide) |
| `desktop_toggle_current_window_maximized` | — | `{ maximized }` | R | — |
| `desktop_get_current_window_state` | — | `{ maximized }` | R | — |
| `desktop_show_app_menu` | `{ x?, y? }` | `null` | L | popup the application menu at coordinates |
| `desktop_ssh_instances_get` | — | `{ instances }` | L | raw (UI parses 13.6) |
| `desktop_ssh_instances_set` | `{ config: { instances } }` | `null` | L | 8.2 |
| `desktop_ssh_import_hosts` | — | `[{ host, pattern, source, sshCommand }]` | L | parse `~/.ssh/config` + `/etc/ssh/ssh_config` recursively following `Include` (with `~` expansion + glob), skip `!`/`*`, dedupe, sort |
| `desktop_ssh_connect` | `{ id }` | hangs until connected or error | L | 8.5 |
| `desktop_ssh_disconnect` | `{ id }` | `null` | L | 8.7 |
| `desktop_ssh_status` | `{ id? }` | `DesktopSshInstanceStatus[]` | L | defaults for unknown ids (`phase 'idle'`) |
| `desktop_ssh_logs` | `{ id, limit? }` | `string[]` | L | log ring tail (cap 1200 lines stored; default limit 200) |
| `desktop_ssh_logs_clear` | `{ id }` | `null` | L | — |

`COMMANDS_SAFE_FOR_REMOTE` (exact set, 17 entries — recheck against this
list when adding new commands): `desktop_hosts_get`, `desktop_host_probe`,
`desktop_new_window`, `desktop_new_window_at_url`,
`desktop_new_window_for_host`, `desktop_set_window_title`,
`desktop_set_window_theme`, `desktop_is_window_fullscreen`,
`desktop_start_window_drag`, `desktop_minimize_current_window`,
`desktop_toggle_current_window_maximized`, `desktop_close_current_window`,
`desktop_get_current_window_state`, `desktop_get_app_version`,
`desktop_get_lan_address`, `desktop_capture_page_rect`, `desktop_tray_update`.
Rejection: `throw new Error('IPC not available for this origin')` + a warn log
with the sender URL.

### 3.2 Main-process → renderer events

Delivered through `openchamber:emit` → preload fans out to BOTH registered
bridge listeners (`__OPENCHAMBER_DESKTOP__.listen(event, handler)`, invoked
with `{ payload: detail }`) and DOM `CustomEvent(event, { detail })` (or
plain `Event` when detail is undefined). Events are read-only notifications
and safe for any page in that webContents.

| Event | detail | Window scope |
|---|---|---|
| `openchamber:update-progress` | `{ event: 'Started'|'Progress'|'Finished', data: { contentLength? } | { chunkLength, downloaded, total } | {} }` | all windows |
| `openchamber:open-session` | `{ sessionId, directory? }` | primary window only (notification click, tray focus-session, deep link, focus-main-window) |
| `openchamber:open-draft-session` | `{ directory, projectId }` | primary/main window |
| `openchamber:open-mini-chat` | — | target window with context (menu/tray) |
| `openchamber:menu-action` | action string | menu target window (see 10.3; add-selection-to-chat / open-mini-chat delivered IPC-only, others also fan a DOM event) |
| `openchamber:check-for-updates` | — | all windows (IPC + DOM fan-out) |
| `openchamber:ssh-instance-status` | full `DesktopSshInstanceStatus` | all windows |
| `openchamber:tray-action` | `{ type: 'respond-permission', sessionId, id, response }` (renderer handles ONLY respond-permission; the rest are native) | main window |
| `openchamber:installed-apps-updated` | `[{ name, iconDataUrl }]` | all windows |
| `openchamber:system-resume` | `{ timestamp }` | all windows (powerMonitor resume) |
| `openchamber:deep-link-focus` | `{ reason }` | all windows |
| `openchamber:window-resized` | — | macOS, per-window (header relayout) |
| `openchamber:window-maximized-changed` | `{ maximized }` | per-window (in-app controls state) |

DOM-only events injected by `executeJavaScript`:
`openchamber:zoom` (details: menu action string `zoom-in|zoom-out|zoom-reset`),
`openchamber:menu-action`, `openchamber:check-for-updates`. The preload fans
IPC events into DOM events too — which is why zoom must NOT be delivered
through both paths (double application).

### 3.3 Relay dev-tunnel MessagePort protocol

(src: relay-dev-tunnel.mjs; preload.mjs) `desktop_dev_tunnel_open({ relay:
true, targetKey, port, … })` (main):
1. validate port 1-65535, targetKey required, webContents alive;
2. key = `<webContentsId>|<targetKey>|<port>`; existing → `{ localPort, reused: true }`;
3. bind `net.Server` on `127.0.0.1:0`; per accepted socket: `setNoDelay`, `pause`, `connectionId = randomUUID()`, `const { port1, port2 } = new MessageChannelMain()`, 15 s ready timeout;
4. `webContents.postMessage('openchamber:relay-dev-tunnel-connect', { connectionId, remotePort: port }, [port2])` — transfers port2;
5. preload (local pages only) stores the port by connectionId and notifies the renderer immediately with `{ type: 'connect' }` then on every port message with `{ connectionId, remotePort, message }`;
6. message domain: `{ type: 'ready' }` (renderer bridged; main resumes the socket), `{ type: 'data', data: Uint8Array }` both directions (main writes socket bytes into the port and port bytes into the socket), `{ type: 'close' }` (main destroys the socket; renderer removes a stale port when posting close);
7. cleanup: socket error/close, port1 close, timeout, webContents destroyed, `desktop_relay_dev_tunnel_close_all`, quit → all close.

The renderer side (UI, local page) connects the bytes to its existing E2EE
relay transport for relay-only instances (#08 owns the relay leg itself).

### 3.4 Preload bridge shape (`window.__OPENCHAMBER_DESKTOP__`)

```
{
  invoke: (cmd: string, args?: object) => Promise<unknown>
  openDialog: (options: object) => Promise<unknown>          // openchamber:dialog:open
  grantFileAccess: (filePath: string) => Promise<unknown>    // openchamber:file:grant-existing
  openExternal: (url: string) => Promise<unknown>            // routes to invoke('desktop_open_external_url')
  listen: (event: string, handler: (evt: { payload?: unknown }) => void)
    => Promise<() => Promise<void>>                          // deduped per event; returns unlisten
  // local pages ONLY:
  relayDevTunnelListen?: (handler: (evt: { connectionId, remotePort, message }) => void) => void
  relayDevTunnelPost?: (connectionId: string, message: object) => void
}
```

Preload also exposes (11.2 for the gating matrix):
`__OPENCHAMBER_ELECTRON__ { runtime: 'electron', arch, trayEnabled }`,
`__OPENCHAMBER_PLATFORM__` (process.platform),
`__OPENCHAMBER_LOCAL_ORIGIN__`, `__OPENCHAMBER_API_BASE_URL__` (any page),
`__OPENCHAMBER_CLIENT_TOKEN__`, `__OPENCHAMBER_RELAY_HOST_ID__`,
`__OPENCHAMBER_RUNTIME_HEADERS__`, `__OPENCHAMBER_HOME__` (local pages only),
`__OPENCHAMBER_MACOS_MAJOR__` (any page, numeric). The boot outcome is NOT
exposed via contextBridge (read-only there); it is injected by the init
script so re-navigations can refresh it.

---

## 4. Window Model

### 4.1 Main-window creation options

(src: main.mjs `createBrowserWindow`)

```
title 'OpenChamber'; show: false; backgroundColor '#151313';
width/height: restored or 1280x800; x/y from restored bounds;
minWidth 800; minHeight 520;
icon: win32 → resources/icons/icon.ico; linux → icon.png;
frame: false (win32|linux); autoHideMenuBar: true (non-mac);
titleBarStyle: 'hidden' (darwin|win32|linux) else 'default';
titleBarOverlay: false (feature flag off; in-app controls are DOM);
trafficLightPosition: { x: 16, y: 17 } (macOS);
webPreferences: {
  preload: <packages/electron/preload.mjs>,   // __dirname dev, app.getAppPath() packaged
  additionalArguments: […11 tokens…],
  backgroundThrottling: false,
  contextIsolation: true,
  nodeIntegration: false,
  webviewTag: true,
  sandbox: false,          // REQUIRED: preload needs Node's contextBridge/ipcRenderer
}
```

Geometry restore: saved `desktopWindowState` clamped to the display's work
area (`clampWindowBoundsToVisibleWorkArea`: restore minimum 900x560; clamp to
work area keeping ≥ 800x520; full-size windows re-anchored to work-area origin
edge); `maximized: true` re-maximizes after creation. Persistence:
- `writeWindowState` only for the MAIN window: `{ x, y, width: max(bounds, 800), height: max(bounds, 520), maximized, fullscreen }` via `mutateSettingsRoot`;
- debounced 300 ms with a per-window revision counter and timer map (`debounceWindowStatePersist`); `immediate = true` at close/quit/hide, before dialogs, and before update install.

Window annotations (main-process only): `__ocLabel` ('main' or
'main-<counter>'), `__ocRuntimeConfig`, `__ocInitScript`,
`__ocTitleBarOverlayEnabled`, `__ocMiniChat`, `__ocMiniChatSessionId`,
`__ocPinned`.

Per-window wiring:
- focus/blur maintain `state.focusedWindowIds`;
- `resize` → (macOS) emit `openchamber:window-resized`; (always) debounced persist; `maximize`/`unmaximize` → emit `openchamber:window-maximized-changed { maximized }` + persist; `move` → persist;
- `app-command`: prevent `browser-backward` (no swipe-back navigation);
- zoom: `setZoomFactor(1)` at attach and on every `zoom-changed` (the app zooms content through its own scaling; Chromium gestures are suppressed on the main pages);
- macOS traffic-light resilience: on `minimize`, `restore` (+250 ms), `show`, `focus` re-assert `setWindowButtonVisibility(true)` + `setTrafficLightPosition({16,17})` — AppKit loses them around the dock-restore animation under `titleBarStyle:'hidden'`;
- `dom-ready` → run `__ocInitScript`;
- `did-finish-load` → re-assert zoom 1; main window flushes pending deep links 400 ms later;
- `ready-to-show` → show + focus (windows are never shown before first paint);
- renderer-recovery attach (12.1);
- navigation guards (4.5);

macOS major version read at window creation via `/usr/bin/sw_vers
-productVersion` (10.x releases map to the minor); feeds
`__OPENCHAMBER_MACOS_MAJOR__` for header offsets.

### 4.2 Splash

`buildStartupSplashHtml()` — a `data:text/html` document with the app logo as
inline SVG; palette from `desktopSplashColors` (`bgLight #f5f5f4`,
`fgLight #1c1917`, `bgDark #0c0a09`, `fgDark #fafaf9` defaults) resolved
through `color-scheme: light dark` media queries. The window navigates
splash → real URL via `activateMainWindow` once `resolveInitialUrl` finishes
(this is the "readiness gating" visible to the user). Navigation aborts (-3,
ERR_ABORTED) are benign and ignored (`isBenignNavigationAbort`).

### 4.3 Window types / lifecycle commands

See the table in 3.1 (`desktop_new_window*`, mini chat commands, focus/close/
minimize/maximize/get-state). Additional-window default 1280x800, no geometry
restore, labels `main-N`. Tray/mini-chat-only items never count as "main".

### 4.4 Close behavior

Main window `close` handler:
1. Win/Linux close-to-tray: when `!state.quitRequested && trayController && !__ocMiniChat && desktopMinimizeToTrayEnabled` → persist geometry NOW, `preventDefault()`, `hide()`.
2. macOS, not quitting, and `remainingVisible (isVisible) <= 1` → persist + `hide()` (app stays in the Dock).
3. Otherwise persist and close. `closed` → clear focus id; if the main window → `state.mainWindow = null`; when no windows remain and NOT macOS → `installingUpdate ? app.quit() : performConfirmedQuit()`.

Mini Chat windows: no interception; `closed` removes the session dedupe key.
Minimize (from any surface) is ALWAYS a normal minimize; only CLOSE hands the
window to the tray.

### 4.5 Navigation guards

`isAllowedNavigationUrl(url)` (main + additional windows):
- `devtools:` → allow;
- `openchamber-ui:` → allow;
- non-http(s) → deny;
- same origin as the window's current URL → allow (Vite full-reload fallback);
- same origin as `state.localOrigin` or `state.sidecarUrl` → allow (our own UI);
- same origin as any saved host `url` → allow (remote instances);
- else deny.

`setWindowOpenHandler`: allowed → `{ action: 'allow' }` (a real new
Electron window); anything else → deny + `shell.openExternal(url)`.

`will-navigate`: allowed → proceed; else `preventDefault()` +
`shell.openExternal` (foreign content can never load inside the app's own
window).

Additional windows: mini chats deny ALL window-opens via
`shell.openExternal` and allow `will-navigate` only to the local/packaged UI
origin. Webview guests (browser panel popups) navigate their own guest in
place (7.1) via the global `web-contents-created` handler.

### 4.6 Mini Chat window

(src: main.mjs `createMiniChatWindow`; ui/components/mini-chat)

- BrowserWindow: title `'OpenChamber Mini Chat'`; 520x760, min 360x480; same chrome policy as main (frameless on win/linux, hidden titlebar + traffic-light fixes on macOS); `backgroundThrottling: false`; same `webPreferences` except the additionalArguments omit boot-outcome and relay-host-id.
- `__ocMiniChat = true`; `__ocPinned = false`; `__ocMiniChatSessionId = '<apiBaseUrl or local>\n<sessionId>'` in session mode. Dedupe: opening a session-mode mini chat for a known (runtime, sessionId) restores/shows/focuses the existing window (minimized → restore). Drafts are never deduped.
- URL: `${localUiBase}/mini-chat.html?mode=session|draft&sessionId=…&directory =…&projectId=…`; base = packaged `openchamber-ui://app/mini-chat.html` or the local UI origin. In HMR dev the Mini Chat loads from the resolved local UI origin, NOT the API origin. Throws `'Local UI is not available'` when no base exists.
- Runtime config (`resolveMiniChatRuntimeConfig(window, args)`): args override window config, which overrides the stored token/headers for that URL; empty args fall back to app state.
- Pinning floating-level `setAlwaysOnTop(true, 'floating')`; macOS unpin also clears `setVisibleOnAllWorkspaces(false)`.
- `ready-to-show` → show + focus.
- Renderer behavior: compact header; native zoom targets the focused window directly — composer focus adjusts the interface scale, terminal and file-editor focus adjust their own font sizes; new windows default to the managed Chats target; explicit project/worktree drafts retain their target; existing managed chat sessions reopen in their own directory; opening a managed draft back in the main window preserves that target; the compact header omits project/branch metadata for Chats sessions.

### 4.7 Focus and multi-instance

- Single instance lock; `second-instance` → deep links + focusForeground.
- `focusForegroundWindow()`: macOS `app.focus({ steal: true })` FIRST (a background app's window calls will not pull it forward), then restore/show/ focus/moveTop on main window, else a visible window, else the first.
- `activate` (macOS Dock): windows exist → restore/raise the remembered tray surface (mini chat included) or first visible; none → `openMainWindow()`.
- `emitToPrimaryWindow`: main window, else focused, else visible, else first — session navigation must land in exactly ONE window (broadcasting would hijack other windows' work).

---

## 5. Deep Links (`openchamber://`)

Registration (1.3): `app.setAsDefaultProtocolClient('openchamber')` unless
already default. Delivery: raw `openchamber://…` arguments on Windows/Linux
(first launch = the main process argv; later launches arrive via the
`second-instance` event), the `open-url` app event on macOS. Any link parsed
while the main window is still loading is queued in `pendingDeepLinks` and
flushed 400 ms after the main window's `did-finish-load` (a fresh window
cannot receive emits yet).

Parsing: `URL` with protocol exactly `openchamber:`; `type =
url.hostname` (empty → invalid); `value = decodeURIComponent(pathname
segments joined with '/')` (may be empty).

Type routing:

| type | Behavior |
|---|---|
| `connect` | pairing import via confirmation dialog → candidate probe → redeem → host import → switch (5.1) |
| `focus` | Raise the main (or first) window: restore, show, focus; emit `openchamber:deep-link-focus { reason }` to all windows. Sent by the MCP OAuth callback page after authorization completes in the system browser — the work is done server-side, the link only gives focus (browsers will not follow a custom-protocol link without a user gesture). |
| `session` | `emitToPrimaryWindow('openchamber:open-session', { sessionId })` — exactly ONE window (4.7). Also queued as a pending link when the main window must be created. |
| `host` | `switchToHostById(value)`: resolve `local` (packaged UI URL or local origin + local token) or a saved host (packaged UI or the host's URL + apiUrl/token/headers); missing host/URL → warn + stop; boot outcome `{ target: 'local', status: 'ok' }` or `{ target: 'remote', status: 'ok', hostId, url }`; then `activateMainWindow(...)` (navigates the existing main window). SSH-managed instances share the instance id (8.1), so `openchamber://host/<ssh-id>` works too. |
| unknown | logged, ignored |

### 5.1 `connect` pairing deep link (v2)

`parseConnectPairingDeepLinkPayload(raw)`:
- URL `openchamber://connect?…` with `searchParams.v === '2'`;
- `p` = base64url-decoded JSON: `{ v: 2, pairingId: string, secret: string, label?: string, fingerprint?: string, expiresAt?: string, candidates: [ { type: 'lan'|'tunnel'|'relay', url: string, priority?: number } ] }`;
- non-relay candidate URLs must normalize to http(s); `priority` defaults 100; candidates sorted ascending;
- `expiresAt` must parse and be in the future when present;
- requires at least one candidate.

Execution order (mandated by the consent invariant):
1. Show the visible window and a native warning dialog ("Connect to `<label[+ fingerprint]>`?" with detail "This will add `<previewUrl>` as a remote instance and route this app's activity through it. Only continue if you trust this server and started the connection yourself", buttons Connect/Cancel, Cancel default). **Nothing is written before consent.** The token is never displayed.
2. Probe candidates in priority order: GET `<url>/health` with a 3.5 s timeout each; first OK wins.
3. `POST <server>/api/client-auth/pairing/redeem` with `{ pairingId, secret, clientLabel: 'OpenChamber Desktop', clientKind: 'desktop', deviceName: 'OpenChamber Desktop', devicePlatform, appVersion, dedupeKey: desktop:<installId> }` (8 s timeout wrapper). Expect `{ clientToken }`.
4. `importConnectDeepLink`: normalize/merge the host (an existing host matching `url` or `apiUrl` reuses its id; new id `host-<timestamp>-<randomhex>`; `label` from the payload or server; `clientToken` set; `defaultHostId` set only if none yet; `initialHostChoiceCompleted = true`).
5. `switchToHostById(importedId)`.

Relay-transport-only candidates: the desktop deep-link path redeems over
direct candidates; a relay-only link is handled by the renderer's
`importDesktopHostPairing` (13.3, #08), which redeems over relay or direct
transport. (#08 owns relay semantics.)

---

## 6. UI Loading Modes

### 6.1 Modes decision

`shouldUsePackagedUi()`:
- `OPENCHAMBER_ELECTRON_LOAD_SERVER_UI=1` → serve UI from the local server (forced off packaged assets);
- `OPENCHAMBER_ELECTRON_USE_BUNDLED_UI=1` → bundled assets in dev;
- otherwise `app.isPackaged` decides (packaged → `openchamber-ui://`).

Consequences:
- dev HMR: UI from Vite (`http://127.0.0.1:<uiPort>`), API from the local server or dev proxy (2.7 same-origin mode);
- dev bundled: UI from the packaged protocol, API from the local server;
- packaged: UI from the packaged protocol, server serves only the API.

### 6.2 Startup probe plan (pure module)

(startup-url-selection.mjs; consumed in 2.3)

```
probeHmrApi = development && !packagedUi && !skipLocalServer    // 5 s wait
probeHmrUi  = development && !packagedUi                        // 8 s wait
ignoreLoopbackConnectionLimit = !(development && !packagedUi)
```

The `--ignore-connections-limit=127.0.0.1,localhost` Chromium switch is
appended at startup exactly when `ignoreLoopbackConnectionLimit` is true —
i.e. for packaged builds and dev-bundled mode, but NOT for dev HMR. Lifting
the per-host cap against the Vite transform pipeline floods it with the
module graph and leaves the HTML splash visible for up to a minute before
React mounts.

### 6.3 `openchamber-ui://app` protocol handler

`protocol.handle(UI_PROTOCOL, ...)` (registered only when packaged UI mode):

1. Parse `url.pathname`, `decodeURIComponent`; normalize with `path.normalize`, strip leading slashes.
2. Path-containment check: candidate must resolve INSIDE `<web-dist>` (`path.relative` must not start with '..' and must not be absolute); anything else falls back to `index.html`.
3. `stat` the candidate; regular file:
   - `.html` → read UTF-8, inject runtime config (6.4), respond `Content-Type: text/html; charset=utf-8` and **`Cache-Control: no-store`** — index.html names hashed bundles; a cached copy would keep a freshly installed build loading the previous version's UI from the renderer disk cache;
   - other files → `electronNet.fetch('file://…')` (serves with correct types from disk);
4. Missing file → serve `index.html` (SPA fallback) with injected config.

Scheme privileges (1.2): standard, secure, supportFetchAPI, corsEnabled —
the packaged origin behaves like an https origin for fetch/CORS
(`/api` requests go to the server origin; CORS on the server governs access;
#03 owns CORS).

### 6.4 HTML runtime-config injection

`injectRuntimeConfigIntoHtml(html)` inserts after `<head>` (or before
`</head>`, or prepends) a script injecting, only when `undefined`:
`__OPENCHAMBER_LOCAL_ORIGIN__` (local origin or server URL),
`__OPENCHAMBER_API_BASE_URL__` (apiBaseUrl or server URL),
`__OPENCHAMBER_CLIENT_TOKEN__` (only when a token exists). This covers the
very first document before the dom-ready init script executes. Same values
again via `buildInitScript` (2.7) on every future document.

---

## 7. Embedded Browser Panel

(src: main.mjs panel sections; ui/components/browser/*; #05 owns tab/UX
details; this section owns EVERY security and lifecycle decision.)

### 7.1 Guest construction

The panel requires a Chromium host (`window.__OPENCHAMBER_ELECTRON__`
present):

```
<webview src={initialSrc} partition="persist:openchamber-browser" allowpopups />
```

- `partition='persist:openchamber-browser'`: every page the user opens in the panel shares this PERSISTENT partition — a dev-server login survives restarts WITHOUT touching OpenChamber's own session storage. The panel's storage clears ONLY through the scoped clear-data command (7.6).
- The view is created with its FINAL URL already committed in `src`. A background tab renders hidden (an imperative navigation would be lost), and mutating `src` after attach is not reliably honored — both would strand the tab. `initialSrc === null` means "still resolving"; nothing renders until resolution completes (loopback dev URLs resolve through a dev tunnel, 7.7).
- Popups are intercepted on the MAIN side (`web-contents-created` for `type === 'webview'`): `setWindowOpenHandler` → `loadUrlInsideWebContents(contents, url)` (http(s) only; `contents.loadURL` in place) and `{ action: 'deny' }` — popups open in place; a detached window could escape the panel.
- Non-Chromium hosts degrade to a plain iframe: no navigation events, no annotation, no console capture; the toolbar hides controls that cannot work (src: BrowserPane `IframeBrowser`).
- Panel zoom: level −3…+4, step 0.5 (factor `1.2^level`), via `webview.setZoomLevel`; app-menu zoom acts on the webview only when it has focus (`openchamber:zoom` listener checks `document.activeElement`).
- Device bar: pin an emulated viewport (page measures at the pinned size, visually scaled via `transform: scale(...)`), force `prefers-color-scheme` per page (7.5; deliberately not the app-wide `nativeTheme`).

### 7.2 Navigation status integration (`useWebviewNavigation`)

Single authoritative `BrowserNavStatus` (`loading|ready|failed|idle`),
the panel's only state source:

- Only MAIN-frame `did-fail-load` produces `failed`; sub-resource failures ignored; code `-3` (`ERR_ABORTED`) is NOT a failure (navigation superseded). `about:blank` is never a real page URL (keeps the empty state).
- `did-start-loading` → loading; `did-stop-loading` → ready with `getTitle()` unless a terminal `failed` for the same URL must be kept (the trailing did-stop-loading must not overwrite it); `did-navigate`/`did-navigate-in-page` commit URL + history flags; `page-title-updated`, `page-favicon-updated` (feeds a favicon store).
- Crashes: BOTH `render-process-gone` and legacy `crashed` events run a bounded renderer-side reload budget (#05: a few delayed reloads inside a window) then terminal `failed { crashed: true }`.
- Webview event payloads sit directly on the event object in some versions and under `detail` in others — both shapes are read.

### 7.3 Dev-server friendliness

- Nothing listening (connection-refused class failures): auto-reload every 600 ms up to 40 s (`DEV_SERVER_WAIT_MS`) with a "Waiting for server" overlay.
- A 5xx-bearing loopback page (gateway up, app starting): within the first 20 s of the tab (`GATEWAY_WAIT_MS`, only before the first good load), probe the URL's status (SERVER-side loopback probe — probing via the local tunnel port fails and would falsely settle) and reload every 600 ms until a non-5xx; genuine build-error pages appear promptly after.
- Terminal failures show code/description or "crashed" overlays; toolbar reload/hard-reload remain available (the user's call).

### 7.4 Panel security policy

(src: browser-panel-security.mjs; main.mjs `hardenBrowserPanelSession`,
`resolveBrowserPanelContents`)

1. **Session hardening** (`hardenBrowserPanelSession`, run at ready):
   - `app.on('certificate-error')`: `shouldAllowBrowserPanelCertificateError({ url, error })` = the ONLY allowed combination is `error === 'net::ERR_CERT_AUTHORITY_INVALID'` AND `protocol === 'https:'` AND hostname ∈ { `localhost`, `127.0.0.1`, `[::1]` } (case-insensitive). Match → `event.preventDefault()`; `callback(true)`. EVERYTHING ELSE (other panel errors, other hosts, other sessions) → `callback(false)` (blocked). Self-signed loopback HTTPS dev servers work; certificate failures for external hosts and all other certificate errors remain blocked.
   - `panelSession.setPermissionRequestHandler` → DENY every permission (camera, microphone, geolocation, notifications, …), with a log line `{ permission, requestingUrl }`. Rationale: Electron grants by default when no handler is set; the panel loads whatever the user types, so the default would silently hand pages the camera/location. Deny, never silent-grant; a prompt is the right end state but silence is the one unforgivable outcome.
   - `setPermissionCheckHandler` → `false` (pages cannot even report the capability before asking).
   - `setDevicePermissionHandler` → `false` (serial/HID/USB pickers).
2. **webContentsId privilege check** (`resolveBrowserPanelContents(rawId)`): commands that take a renderer-supplied `webContentsId` (`desktop_browser_capture_page`, `desktop_browser_set_color_scheme`) resolve `webContents.fromId(id)` and require `target.session === session.fromPartition(BROWSER_PANEL_PARTITION)`. IDs are guessable — without this check a compromised renderer could aim capture or the debugger at ANOTHER window's contents. Membership of the panel's partition is the proof (nothing else in the app has it).
3. **Favicon isolation** (`desktop_browser_fetch_favicon`): icons are fetched in the panel's own session (page-logins resolve), never from the app origin (the app's origin never requests anything from a third-party host); http(s) only; MIME allowlist; ≤ 512 KB; response is a data URL so the renderer never fetches the icon itself.
4. **Fence policy summary**: no URL allowlist for the panel itself (it is a browser); the boundaries are the ones above (cert rule, permission deny, device deny, id check, partition scoping, popup-in-place, and the app's own windows' navigation guards in 4.5).

### 7.5 Color-scheme emulation

`desktop_browser_set_color_scheme { webContentsId, scheme }`:
- resolve the panel guest (7.4);
- `scheme ∈ 'light'|'dark'|'system'` (else 'system');
- attach debugger `'1.3'` if not attached; if attaching fails because DevTools owns the only debugger session → throw `'Close DevTools for this page before changing its appearance'`;
- `Emulation.setEmulatedMedia`: light/dark → `{ features: [{ name: 'prefers-color-scheme', value: scheme }] }`; system → `{ features: [] }` and DETACH the debugger (emulation only lives inside the session; detaching frees it for DevTools).
- App-wide `nativeTheme.themeSource` is deliberately NOT touched (it would drag OpenChamber's own appearance along).

### 7.6 Storage controls

- `desktop_browser_clear_data { partition, cookies, cache }` — exact partition match only; see 3.1 row. After clearing, the UI reloads the view (`reloadIgnoringCache`) so cleared storage is visible.
- OpenChamber's own storage (`session.defaultSession`) is reachable only through `desktop_clear_cache` (3.1), which never touches the browser partition.

### 7.7 Remote dev-server preview transports

Two transports for loopback dev URLs of a remote instance (#08 owns the
relay protocol; the shell owns the local plumbing):

a) **Direct-HTTP tunnel** (`desktop_dev_tunnel_open { baseUrl, port, requestHeaders?, clientToken? }`) for instances with an HTTP address: lazily `import('@openchamber/web/server/lib/dev-tunnel/client.js')` → `createDevTunnelClient({ logger })`; `client.open({ baseUrl, port, headers })` binds a loopback port and pipes to the remote with sanitized headers + `Authorization: Bearer <clientToken>` on setup. Response `{ localPort, reused, url: 'http://127.0.0.1:<localPort>/' }`. Close one via `desktop_dev_tunnel_close { baseUrl, port }`; all close on quit (1.7). The webview loads `http://127.0.0.1:<localPort>` while the ADDRESS BAR keeps the user-facing URL (a rewritten address is confusing and worse to copy).

b) **Relay-bridged tunnel** (`desktop_dev_tunnel_open { relay: true, targetKey, port }`) for relay-only instances: the shell binds a local `net.Server` (relay-dev-tunnel.mjs; key `<webContentsId>|<targetKey>|<port>` with reuse, 15 s ready timeout per socket) and hands each accepted socket to the renderer through a MessagePort pair (3.3). The renderer's existing E2EE relay transport carries the bytes; the page talks to a real origin. Close: `desktop_relay_dev_tunnel_close_all` (per webContents), webContents destroyed, or quit.

The renderer picks the transport per URL (`resolveBrowsableUrl`) and shows
`DevTunnelUnavailableError` as a "tunnel failed" overlay instead of
answering from the wrong machine.

---

## 8. SSH and Remote Machines (desktop flows)

(src: packages/electron/ssh-manager.mjs — `ElectronSshManager`; #08 owns the
SSH UX model and relay/tunnel protocols; this section specifies the manager
mechanics层 completely.)

The manager is constructed once at startup with
`{ settingsFilePath, appVersion: APP_VERSION, emit: (event, detail) =>
emitToAllWindows(event, detail) }` — every `setStatus` broadcasts an
`openchamber:ssh-instance-status` event to every window.

### 8.1 Feature set

- Import candidate hosts from `~/.ssh/config` AND `/etc/ssh/ssh_config`, recursively following `Include` tokens (`~` expansion, glob matching, cycle-safe visited set), skipping `!`-negations and the `*` wildcard, dedup by host, sorted by host. Each candidate: `{ host, pattern: <hasWildcard>, source: 'user'|'global' (path string), sshCommand: 'ssh <host>' }`.
- **OpenSSH ControlMaster on macOS/Linux** (`ssh -o ControlMaster=yes -o ControlPath=<sock> -o ControlPersist=300 -N`); **Windows uses independent hidden OpenSSH processes** for setup commands and EACH long-lived forward (`ControlMaster=no, ControlPath=none, StrictHostKeyChecking=accept-new`) because Win32 OpenSSH does not support ControlMaster reliably.
- Managed remote OpenChamber: enumerate → install/update `@openchamber/web` on the remote host (bun preferred; npm installs to a user-home prefix `$HOME/.openchamber/npm-global`, never the root-owned global), start `openchamber serve` with the RESOLVED remote `opencode` CLI via `OPENCODE_BINARY`; or connect to an external server (mode `external`).
- Main local forward `bindHost:localPort → 127.0.0.1:remotePort` with `ExitOnForwardFailure=yes`; user forwards: `-L` local, `-R` remote, `-D` dynamic (SOCKS proxy).
- Client-token issuance on the forwarded server (2.9 pattern, label `OpenChamber Desktop SSH`).
- Health monitor with backoff reconnects, per-instance log rings, and live status broadcast.

### 8.2 Instance schema (stored at `desktopSshInstances`)

```
DesktopSshInstance = {
  id: string                     // required, != 'local'
  nickname?: string
  sshCommand: string             // required
  sshParsed?: { destination: string; args: string[] }
  connectionTimeoutSec: number   // default 60, positive
  remoteOpenchamber: {
    mode: 'managed'|'external'   // default managed
    keepRunning: boolean         // default true
    preferredPort?: number
    bindHost: '127.0.0.1'|'0.0.0.0'    // 0.0.0.0 managed REQUIRES a UI password
    installMethod: 'auto'|'npm'|'bun'  // legacy values read as 'auto'
    uploadBundleOverSsh: boolean
  }
  localForward: { preferredLocalPort?: number;
                  bindHost: '127.0.0.1'|'localhost'|'0.0.0.0' }
  auth: {
    sshPassword?:        SecretStorage   // { enabled, value?, store:'settings'|'never' }
    openchamberPassword?: SecretStorage
  }
  portForwards: [ { id, enabled, type: 'local'|'remote'|'dynamic',
                    localHost?, localPort?, remoteHost?, remotePort? } ]
}
```

Sanitization: bind hosts restricted to the enumerated sets (unknown →
default); `local`/`remote` forwards require local+remote ports
(`remoteHost`/`localHost` default `127.0.0.1`); `dynamic` requires a local
port; duplicate forward ids rejected; secret `store` becomes `'settings'`
only when the input said so — otherwise `'never'` (secrets persist only
when the user explicitly enabled it).

`setInstances` write-back repairs the HOSTS config too: removes hosts whose
id belonged to a deleted SSH instance, adds/updates placeholder
`{ id, label, url: 'http://127.0.0.1/' }` for SSH instances (the real
forwarded URL replaces it on connect), and resets `desktopDefaultHostId` to
`'local'` when it pointed at a deleted instance. Ids stay consistent
between `desktopSshInstances` and `desktopHosts`.

**Secret invariant:** SSH/OpenChamber UI passwords are stored ONLY when
`store: 'settings'` is explicitly selected; never logged — error text is
scrubbed against the secret (8.4); remote command strings embed them only
via shell-quoted variables on the remote side (`OPENCHAMBER_UI_PASSWORD`
inside `sh -lc '…'`).

### 8.3 SSH command parsing (safety envelope)

`parseSshCommand(raw)` (shell-style word splitter honoring single/double
quotes and backslashes; unclosed quote → error):

- optional leading `ssh` token;
- exactly one destination = first non-flag token; trailing (post-destination) command arguments REJECTED;
- disallowed primary flags (ControlMaster/ControlPath/ControlPersist/ hijacks, backgrounding, version/debug, forwarded channels): `-M -S -O -N -t -T -f -G -W -v -V -q -n -s -e -E -g`;
- allowed plain flags: `-4 -6 -A -a -C -K -k -X -x -Y -y`;
- allowed with a REQUIRED value: `-B -b -c -D -F -I -i -J -l -m -o -P -p -R` (both `-o <value>` and `-o<value>` forms); `-o` VALUES with the `Control* |BatchMode|ProxyCommand` prefixes are rejected.

The manager re-parses (`sshCommand`) whenever it needs `sshParsed`.
All remote commands run as `sh -lc '<script>'` shell-quoted.

### 8.4 Process hygiene

- Every ssh spawn: `spawnProcess('ssh', args, { env: authEnvironment(parsed), ...windowsHide })` — Windows spawns are hidden (no console flash).
- Auth env when a stored SSH password exists: `SSH_ASKPASS_REQUIRE=force`, `SSH_ASKPASS=<session askpass path>`, `DISPLAY=1`, `OPENCHAMBER_SSH_ASKPASS_VALUE=<password>`.
- Askpass scripts, per session, in `<settingsDir>/ssh/<id>/` (mode 0700, deleted on disconnect): POSIX `askpass.sh` answers password/passphrase prompts from `OPENCHAMBER_SSH_ASKPASS_VALUE` when set, auto-answers `yes` for host-key (`yes/no`) prompts, else spawns a native macOS AppleScript dialog (`display dialog`, hidden input) so first-time host keys are confirmable without a terminal; Windows `askpass.cmd` → powershell `askpass.ps1` (echoes the env value only).
- Child diagnostics: stderr tail (2x2000 chars) + spawn errors tracked per process in a WeakMap; surfaced errors sanitized (control chars stripped, secret replaced with `[redacted]`, truncated). **No secrets in logs or the DOM.**

### 8.5 Connect pipeline (`connect(id)`)

Guard rails: `id` required (not `local`); concurrent connects for one id
share ONE promise ("Connection already in progress"); the stored instance is
re-sanitized for use; every attempt logs a separator
`attempt #<n> (manual|retry <k>)`.

Status ladder (each transition is also a log line, broadcast to all windows as
`openchamber:ssh-instance-status { id, phase, detail, localUrl, localPort,
remotePort, startedByUs, retryAttempt, requiresUserAction, updatedAtMs }`):
`idle → config_resolved → auth_check → master_connecting → remote_probe →
installing|updating → server_detecting → server_starting → forwarding →
ready` (unstable states `degraded`, `error`).

Steps:

1. `config_resolved` — `ssh -G <destination>`; parse `key value` lines into a map (target host, user, port, identity files); non-zero → sanitized stderr error.
2. Pre-connect teardown of a previous session WITHOUT reporting idle (control path `/tmp/ocssh-<hash>.sock`, `ControlPersist` 300 s).
3. `auth_check` — prepare `<settingsDir>/ssh/<id>/`, remove a stale control path, write askpass files (8.4). Non-Windows: spawn the master (`-o ControlMaster=yes -o ControlPath=<sock> -o ControlPersist=300 -N`, stdio ignore/in/in), poll `ssh -O check` every 250 ms → 2 s until ready or `connectionTimeoutSec`; early master exit / spawn error surfaces sanitized detail; deadline `'SSH ControlMaster connection timed out'`. Windows establishes connectivity with the first real command.
4. `remote_probe` — `uname -s` through the master must be `linux` or `darwin`, else `'Unsupported remote OS: <os>'`.
5. Remote OpenChamber provisioning (`ensureRemoteServer`):
   - `external` mode: `preferredPort` REQUIRED; probe it (8.6); `startedByUs = false`.
   - `managed` mode: enumerate candidate binaries (`$HOME/.openchamber/npm-global/bin/openchamber`, `$BUN_INSTALL|$HOME/.bun/bin/openchamber`, `command -v`) printing `<path>\t<version>`; version == APP_VERSION is used as-is; otherwise `updating`/`installing` status → install with bun (`bun add -g @openchamber/web@<version>`) or npm (`npm install -g --prefix $HOME/.openchamber/npm-global @openchamber/web@<version>`; npm is the `npm` installMethod order, bun the `bun`/`auto` order, the other tool is the fallback; last error surfaces); re-enumerate; missing → `'OpenChamber was installed on the remote host but no openchamber binary could be found'`.
   - `server_detecting` — a set preferredPort is probed; alive → reuse.
   - `server_starting` — resolve the remote `opencode` CLI by candidate probe (listed home locations + `command -v`; a login shell over SSH lacks home-installed tools on PATH); MISSING → `'The opencode CLI is not installed on the remote machine. Install it there, then connect again'` (`requiresUserAction`). Start with the resolved environment prefix `PATH=<remote opencode dirs>:$PATH OPENCODE_BINARY='<resolved>' OPENCHAMBER_RUNTIME=ssh-remote [OPENCHAMBER_UI_PASSWORD='<secret>']` and `<bin> serve --hostname <127.0.0.1|0.0.0.0> --port <preferredPort|hash-seeded 20000-49999>`; parse the printed port (first integer token). **Remote bind host `0.0.0.0` REQUIRES a configured UI password** (it publishes the remote UI to that machine's network). Confirm with the 8.6 probe; failure → `'Managed OpenChamber server failed to become reachable'`.
   - **Managed servers started by us stop on disconnect** unless `keepRunning`: `openchamber stop --port <port>` (the HTTP shutdown route sits behind UI auth and cannot stop a password-protected server, so the CLI owns the daemon lifecycle).
6. `forwarding` — local port = preferredLocalPort, or an ephemeral free port (preferred taken → ephemeral). Main forward (ControlMaster platforms): `-o ControlMaster=no -o ControlPath=<sock> -o ExitOnForwardFailure=yes -N -L <bindHost>:<local>:127.0.0.1:<remote>`; after 250 ms an exit code 0 on those platforms means "detached" (the master carries the forward — normal, logged); other early exits → sanitized error. Windows keeps the independent hidden process alive.
7. Extra forwards (enabled ones only): ControlMaster platforms run `ssh -O forward -L|-R|-D …` to completion (non-zero → error); Windows spawns a hidden independent process and treats an early exit/spawn error as failure. Local-type forwards get a TCP reachability probe of the listener after 100 ms; failures accumulate as warnings (`<id>: local listener … is not reachable`) — the connect still finishes as "ready with forward warnings: …".
8. `waitLocalForwardReady` — poll `http://127.0.0.1:<localPort>/health` for up to 30 s (250 ms → 2 s backoff); 200 OR 401 proves the forward AND the forwarded server are live; timeout → `'Timed out waiting for forwarded OpenChamber health'`.
9. Token issuance when an OpenChamber UI password is configured: POST `<localUrl>/auth/session` `{ password, trustDevice: true, issueClientToken: true, clientLabel: 'OpenChamber Desktop SSH' }` (10 s); rejection → `'Configured OpenChamber UI password was rejected by forwarded server (status <n>)'`; fallback via cookie + POST `/api/client-auth/clients`.
10. `updateHostRuntime(id, label, localUrl, clientToken)`: merge into `desktopHosts` `{ id, label, url: localUrl, apiUrl: localUrl, clientToken? }` — an SSH instance is ALWAYS a live forwarded host in the host list while connected, and keeps the last known URL while down. Persist the working local port as `preferredLocalPort` when it differs. Then `ready` (+warning suffix when extra-forward problems exist) and launch the monitor (8.7).

### 8.6 Remote server probe mechanism

`probeRemoteSystemInfo(parsed, controlPath, port, password)` runs a remote
`sh` script (curl preferred, wget fallback, neither → exit 127 → error):
- with a configured UI password: `POST /auth/session` first (cookie jar, 3 s max), expecting 200, then GET `/api/system/info` with the cookie; without: direct GET of `/api/system/info`; plus a `/health` liveness probe;
- prints `INFO_STATUS=<n>`, `AUTH_STATUS=<n>`, `HEALTH_STATUS=<n>` plus the info body; liveness = any 2xx/3xx or 401/403;
- password-configured authorization failures → "configured password was rejected" or "configure OpenChamber UI password"; other non-liveness → `Remote OpenChamber probe failed (info status N, health status N)`;
- returns the parsed info JSON (best effort, `{}` when unparseable).

### 8.7 Monitor, retry, disconnect

- Tick cadence: 2,000 ms until 5 consecutive healthy ticks, then steady 10,000 ms. Failure detection per tick (first hit wins): main forward exited (the benign ControlMaster handoff exit code 0 marks "detached" instead), spawn error, an extra forward died; when the main forward is "detached": cheap TCP probe of the local port, and only on failure an expensive `ssh -O check` (alive master but dead tunnel → notice only: `Local tunnel unreachable but ControlMaster is alive`).
- On failure: log WARN; disconnect internally (no idle status); increment `retryAttempt`; `> 5` → `error` with `requiresUserAction: true` and "Retry limit reached"; else `degraded` `"<reason>. Reconnecting"`, wait `min(2^(attempt-1) * 1000 + <0-700 ms jitter> + 100, 30 s)`, reconnect.
- Disconnect (`disconnectInternal(id, reportIdle)`): stop the monitor timer; managed server stop (when `startedByUs && !keepRunning`); `ssh -O exit` best-effort; SIGTERM all tracked children (master, main forward, extra forwards, askpass children); remove control path + askpass files; drop the auth context; clear the retry counter; `reportIdle` → `idle`.
- `shutdownAll()` disconnects everything (live sessions, in-flight connects, monitors) — called by every quit/signal path (1.7). Statuses are LIVE STATE ONLY, never persisted; after a restart all instances read `idle` until connected. The host list keeps the last forwarded URL (stale but harmless until reconnect).

### 8.8 Renderer/store contract

(packages/ui/src/lib/desktopSsh.ts; stores/useDesktopSshStore.ts) Types
mirror 8.2 (camelCase preferred; snake_case accepted on read for older
stores); phases mirror 8.5; import candidates
`{ host, pattern, source, sshCommand }`. Commands:
`desktop_ssh_instances_get/_set`, `_import_hosts`, `_connect`,
`_disconnect`, `_status`, `_logs`, `_logs_clear`; event
`openchamber:ssh-instance-status` via `listenDesktopSshStatus`. Store:
instances + `statusesById` + import candidates + flags (`isLoading`,
`isSaving`, `isImportsLoading`, `initialized`, `listenerReady`, `error`);
`load()` = instances + statuses then idempotent subscribe;
`setInstances()` writes whole lists; `removeInstance()` disconnects first;
statuses merge by `updatedAtMs` (newest wins).

---

## 9. Updates (End-to-End Pipeline)

### 9.1 Feed and configuration

(src: updater-feed.mjs; updater-channel.mjs; main.mjs `setupAutoUpdater`)

`setupAutoUpdater()` runs ONLY when `app.isPackaged` (dev: not configured at
all; every update capability check then throws). Flags:

```
autoUpdater.autoDownload = false;        // downloads are explicit
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.allowPrerelease = false;
autoUpdater.fullChangelog = true;
autoUpdater.disableWebInstaller = false;
autoUpdater.logger = electron-log;
```

Feed (`resolveUpdaterFeed({ environment, testBuild })`):
- PRODUCTION: GitHub provider `{ provider: 'github', owner: 'openchamber', repo: 'openchamber' }` (matches electron-builder `publish`).
- E2E override (loopback only): active only when BOTH `OPENCHAMBER_E2E === '1'` AND the binary carries `__OPENCHAMBER_UPDATER_E2E_BUILD__ === true` (set at bundle time via `OPENCHAMBER_UPDATER_E2E_BUILD=1`), AND `OPENCHAMBER_UPDATER_E2E_URL` parses to a LOOPBACK http(s) URL (`localhost`, `127.0.0.0/8`, `[::1]`; userinfo, search, and hash are rejected). Otherwise the production feed is returned. It is test infrastructure, never a user-configurable source.

Channel (`resolveUpdaterChannel({ platform, architecture })`):
`platform === 'win32' && architecture === 'arm64'` → `autoUpdater.channel =
'latest-arm64'`; every other combination → no channel override (default
`latest.yml`/`latest-mac.yml`/`latest-linux.yml`). This makes each Windows
installation resolve an architecture-matching installer.

Listeners at setup: `download-progress` → taskbar progress
(`setProgressBar(transferred/total)` on every window; early unknown →
0.01) AND emit `openchamber:update-progress { event: 'Progress', data: {
chunkLength: bytesPerSecond, downloaded, total } }` to all windows;
`update-downloaded` → taskbar clear (-1) + `state.pendingUpdate.downloaded
= true`; `error` → taskbar clear + error log.

### 9.2 Capability gating (`assertUpdaterCapability`)

No-op unless `platform === 'linux' && packaged`. On Linux the running app
MUST be a writable AppImage:
- `process.env.APPIMAGE` missing → `'Updates require the packaged Linux AppImage. Start OpenChamber from its .AppImage file, not an extracted or repackaged copy.'`
- not absolute → error with the value;
- stat missing/not a file → `'The running AppImage cannot be found at <path>. Start OpenChamber from a valid .AppImage file.'`
- not writable (`accessSync(W_OK)`) → `'The AppImage is not writable at <path>. Move it to a writable location or grant write permission before updating.'`

macOS/Windows: always capable when packaged. Linux in-app updates REPLACE
the AppImage in place — it must live on a writable path (FUSE note: keep
the AppImage outside unwritable mounts).

### 9.3 Check (`desktop_check_for_updates`)

1. `assertUpdaterCapability({ packaged })`.
2. `checkForDesktopUpdate({ autoUpdater, currentVersion: APP_VERSION, pendingUpdate, compareVersions })`:
   - `autoUpdater.checkForUpdates()`; on error matching `/404|ENOTFOUND|Cannot find (?:channel|latest)|latest-linux(?:-arm64)?\.yml|HttpError:\s*404|status code 404/i` → authoritative NO-UPDATE result (`{ available: false, updateInfo: null, updateResult: null, nextVersion = currentVersion, pendingUpdate: null }`). The release feed 404s before the first platform publish — that is "no update available", not an updater failure.
   - other errors → `Unable to check for updates: <message>. Check your network connection and try again.` (cause preserved).
   - `nextVersion = updateInfo.version || currentVersion`; `available = compareSemver(nextVersion, currentVersion) > 0` (`compareSemver`: strip leading `v`, per-segment numeric compare, missing segments = 0);
   - `pendingUpdate = available ? { version, electronUpdate: updateResult } : null`.
3. Notes body: `updateInfo.releaseNotes` (string, non-empty) wins; else `fetchUpdateNotes(fromVersion, toVersion, compareSemver)` (shipped changelog from the server lib) renders the relevant notes.
4. `state.pendingUpdate = pendingUpdate`. Return `{ available, currentVersion, version: available ? nextVersion : null, body: <string>|null, date: releaseDate|null }`.

### 9.4 Download (`desktop_download_and_install_update`)

1. Capability check; require `state.pendingUpdate` (`'No pending update'`); require `pendingUpdate.electronUpdate` (`'Electron updater metadata is not available for this build'`).
2. Emit `openchamber:update-progress { event: 'Started', data: { contentLength: null } }`; taskbar progress 0.01 (Windows; cleared -1 in `finally`).
3. If `!pendingUpdate.downloaded`: resolve via BOTH `autoUpdater .downloadUpdate()` (the AUTHORITATIVE signal; a cached payload re-emits no event, so an event-only wait left the promise pending and listeners attached on every retry) and the `update-downloaded`/`error` events; first settles the race; the other side's listeners are removed on settlement.
4. Unconditionally set `state.pendingUpdate.downloaded = true` (again: the downloaded event does not fire for already-cached payloads; otherwise a restart would relaunch without installing).
5. Emit `openchamber:update-progress { event: 'Finished', data: {} }`.

### 9.5 Apply / restart (`desktop_restart`)

`applyUpdate = Boolean(state.pendingUpdate?.downloaded && app.isPackaged)`.

- Apply path:
  1. capability check (`assertUpdaterCapability`) when `applyUpdate`;
  2. macOS additional gate: `app.isInApplicationsFolder()` must be true → else throw `'Desktop update requires OpenChamber.app to be installed in /Applications'` (the updater cannot replace a bundle elsewhere);
  3. set `quitRequested = true`, `installingUpdate = true`, `quitConfirmationPending = false`; persist the MAIN WINDOW geometry NOW (the app may quit before close handlers run);
  4. `installDownloadedUpdate()` — returns a promise that:
     - attaches `autoUpdater.on('error')` → REJECT (an installer failure — rejected code signature, Squirrel session disabled by an earlier failure — arrives asynchronously long after `quitAndInstall()` returns; the renderer dialog must see it);
     - rolls back (`quitRequested = false; installingUpdate = false`) on failure because the app stays up;
     - a 15 s GRACE timer (`UPDATE_INSTALL_GRACE_MS`): still running → RESOLVE(null) (the install is underway and the app is shutting down; release the pending IPC reply);
     - on `setImmediate` (let the invoke channel flush first): `killSidecar()` (managed OpenCode child must not survive the update), then `autoUpdater.quitAndInstall()`; synchronous throw → reject. The IPC call STAYS OPEN until quit, failure, or grace.
- Plain restart path (not applying): `setImmediate(() => { prepareForQuit(); app.relaunch(); app.exit(0); })` — deferred so the renderer's invoke reply flushes (a synchronous restart races the pending invoke and looks like the button did nothing); returns null immediately.

### 9.6 The authenticated web-client updater path

The in-process server receives `desktopUpdater = { check, install, restart }`
(2.1). An authenticated web client connected to the embedded Desktop Host
uses this same native check/download/restart flow instead of a
package-manager command; `install` internally resolves to check →
(if available) `desktop_download_and_install_update`. Capability error
messages surface verbatim on that route. (#03/#14 own the HTTP routes.)

### 9.7 Release-side manifest handling

(#03 owns CI; this is the consumer contract.)

- Windows x64: `latest.yml`; Windows arm64: `latest-arm64.yml`; macOS: one merged `latest-mac.yml` (arm64 + x64 file entries, base version/date); Linux x64: `latest-linux.yml`; Linux arm64: `latest-linux-arm64.yml`. `finalize-latest-yml` REQUIRES both Windows manifests and merges into per-channel files preserving `url/sha512/size/blockMapSize` verbatim; release date preserved.
- Client channel selection (9.1) picks the arm64 Windows manifest; `verifyUpdateCodeSignature: false` on the Windows target (an architecture-mismatched signature check must not kill the arm64 channel).
- Linux AppImages: FULL downloads (`blockmap` differential not used yet); each manifest is validated against its AppImage before upload (`verify-update-manifest` script).
- Updater QA fixture (`updater-e2e-fixture`): generates a loopback feed and N→N+1 AppImages for contributor QA; AppImage replacement/restart on real hardware remains a manual N-to-N+1 release test per architecture.

Renderer states (`useUpdateStore`, 13.7): `checking → available (toast/
dialog with version/body/date) → downloading (Started/Progress/Finished) →
downloaded → restartToUpdate (install errors kept for retry)`. On desktop
the renderer ALSO queries the server's `/api/openchamber/update-check`
(low priority, `appType=desktop-electron`, `instanceMode=local|remote`,
arch/platform/installId, reportUsage consent) to obtain
`nextSuggestedCheckInSec`; the authoritative desktop update stays the native
pipeline. OpenCode CLI update toasts are a separate server-mediated flow.

---

## 10. Tray, Menus, Notifications, OS Integration

### 10.1 Tray controller

(src: tray.mjs; main.mjs tray sections; ui/hooks/useTraySync.ts)

Platforms darwin | win32 | linux. Creation (`setupTray`):
- skipped when macOS and `desktopMacMenuBarEnabled === false` — while disabled the shell creates NO tray controller and the renderer runs NO tray subscriptions; the setting applies after restart;
- skipped (fatal, logged) when the idle icon file is missing;
- seeded immediately with an empty snapshot `{ sessions: [], approvals: [] }` so the icon appears before the renderer mounts;
- `app.on('browser-window-focus')` records `lastFocusedWindowId`;
- destroyed with the tray removed on the quit path (1.7).

Icon assets:
- macOS: template images (`setTemplateImage(true)`, tinted by the menu bar): `trayTemplate-idle.png` (plain outline), `trayTemplate-unseen.png` (statically filled), 16 eased "breathing" frames (`trayTemplate-breath-00..15.png`, `@2x` auto-picked), plus row status icons `busy|retry|error|unseen|blank.png` (`blank` reserves the left gutter so rows align);
- Windows/Linux: the packaged app icon for idle/unseen/busy (Linux icons resized to 22 px because StatusNotifier hosts drop oversized images).

Snapshot ingestion `desktop_tray_update { sessions, approvals, instanceName,
usage, dockBadgeCount }` (pushed by the renderer hook, 13.8; debounced 500
ms, JSON-deduped, 5 s safety poll):
- counts: busy = sessions with status `busy|retry`; error = `hasError`; unseen = sum of per-session unseen; approvals = list length;
- icon title: `◆ <approvals>` when approvals > 0; else `▲ <errors>` when errors > 0; else none (Geometric Shapes render monochrome on macOS and tint with the template image);
- icon state: any busy → animated breathing (16 frames, 75 ms interval, ping-pong); else any unseen > 0 → static filled; else plain outline;
- tooltip: `OpenChamber — N session(s) · awaiting approval xN, with errors xN, working xN, unread xN` (or `· idle`);
- context menu rebuilt only when a serialized signature changes.

Menu layout:
- header row: instance name (disabled);
- `Needs your attention` section (approvals, max 10, overflow into a `N more…` submenu): permission rows `⛔ <session 24ch> — <permission label 34ch>` with submenu `Allow once / Allow always / Deny / Open in app`; question rows `❓ …` click → open session;
- `Sessions` section (max 8 rows, overflow submenu): label = session title (40 chars, "Untitled session" fallback), left status icon per row (`busy|retry|error|unseen|blank`), mac `sublabel` = "project · branch" (48 chars); click → focus session;
- `Usage (Used|Remaining)` submenu — ONLY when the user enabled providers for the quota dropdown AND they report configured: dimmed rows `<provider name>`, optional status, `<window label> — <value>`; omitted entirely otherwise;
- fixed: `New Session`, `New Mini Chat`;
- Windows/Linux extra: `Show Window / Hide Window / Close (quit)`; macOS extra: `Show OpenChamber`, separator, `Quit OpenChamber`.

Click routing (`dispatchTrayAction`):
| action | behavior |
|---|---|
| `quit` | `app.quit()` |
| `hide-main-window` | main/focused window: persist geometry, hide |
| `toggle-main-window` | visible+not minimized → hide; else reveal |
| `show-main-window` | reveal main window (`revealMainWindow`: existing → restore/show/focus WITHOUT re-navigating; dead → `openMainWindow()`) |
| `respond-permission` | emit `openchamber:tray-action { type:'respond-permission', sessionId, id, response: 'once'|'always'|'reject' }` to the main window; no focus steal |
| `new-mini-chat` | `openchamber:open-mini-chat` to a window with context (resolveTraySurface: focused > lastFocused; fallback reveal main) |
| `focus-session` | tray surface is a MINI CHAT (sessionId given) → switch THAT window to the session in place; else `focusMainWindowWithSession` (live main → emit; dead → queue `{ type:'session', value }` and `openMainWindow()`) |
| `new-session` | reveal main; emit `openchamber:open-draft-session { directory: '', projectId: '' }` |

Surface routing helpers: `resolveTraySurface()` = focused window, else the
remembered `lastFocusedWindowId` window.

Non-mac click behavior: Windows LEFT-click shows the window; Linux
left-click TOGGLES show/hide. Double-clicks ignored.
`setIgnoreDoubleClickEvents(true)` on macOS.

Dock badge: `app.setBadgeCount(dockBadgeCount)` (macOS; 0 clears) —
count of root sessions with unseen activity, opt-out honored, subtask
rollup only when the user enabled subtask notifications (renderer-side
computation, 13.8).

Renderer gates: `isTrayPlatform()` (darwin/win32/linux) AND
`__OPENCHAMBER_ELECTRON__.trayEnabled !== false` AND
`canUseElectronDesktopIPC()`.

### 10.2 Native notifications

(src: main.mjs `maybeShowNativeNotification`)

Input normalization accepts `{ payload: {...} }` (renderer IPC path) or a
flat payload (in-process server path). Pipeline:

1. `requireHidden` (payload `requireHidden ?? require_hidden`): when true, skip if ANY window is focused (`getIsWindowFocused` closure from 2.1 handles the server-side suppression; the same flag protects the IPC path).
2. `Notification.isSupported()` gate.
3. Dedupe: claim key = payload `tag` (trimmed) else `sessionId|kind|title|body` of present string parts; claims expire in 5 s; duplicate within TTL → silent skip (protects against dual delivery through both the IPC and server paths).
4. `new Notification({ title (default 'OpenChamber'), body: ''|<string>, silent: false, ...(darwin: sound 'Glass') })`. Live references kept in a set until close/click/failed — on macOS a GC'd notification stops firing click events after ~1 minute.
5. click → `focusForegroundWindow()`; when `sessionId` present, ALSO emit `openchamber:open-session { sessionId, directory }` to the PRIMARY window (notification navigation lands in one window).
6. release on click/close/failed.

Entry points: renderer `desktop_notify <payload>`; server
`onDesktopNotification(payload)` (2.1).

### 10.3 Menus

Application menu templates (macOS `buildMacMenu`, others
`buildAutoHiddenMenu` — hidden menu bar, popup-able via
`desktop_show_app_menu`):

macOS accelerators: app menu (About; Check for Updates → fan-out, 10.3.1;
Settings `Cmd+,` → menu action `settings`; Reload Webview →
`webContents.reload()` of the target; Restart → `prepareForQuit()` +
`app.relaunch()` + exit; Command Palette `Cmd+P`; services/hide/quit
roles), File (`New Window Cmd+Shift+Alt+N`; `New Session Cmd+N` →
`new-session`; `New Worktree Cmd+Shift+N` → `new-worktree-session`;
`New Mini Chat Cmd+Alt+N` with `registerAccelerator: false` — the hint
shows but the RENDERER's customizable binding owns the key to avoid double
opens; `Add Workspace` → `change-workspace`; `Close` role), Edit (roles
undo/redo/cut/paste/selectAll + custom Copy that also
`webContents.copy()` + dispatches `copy`; `Add Selection to Chat Cmd+L`
unregistered), View (Toggle Right Sidebar `Cmd+B` →
`toggle-right-sidebar`; Open Git/Files Sidebar `Cmd+Shift+G/F`; Toggle
Terminal Dock `Cmd+J`/Expanded `Cmd+Shift+J`; Light/Dark/System Theme
radio items; Toggle Session Sidebar `Cmd+Alt+L` → `toggle-sidebar`;
Toggle Memory Debug `Cmd+Shift+D`; fullscreen role), Window (roles +
Zoom In/Out/Reset `Cmd+=|Cmd+-|Cmd+0`), Help (Keyboard Shortcuts
`Cmd+.` → `help-dialog`; Show Diagnostics `Cmd+Shift+L` →
`download-logs`; Toggle DevTools `Cmd+Alt+I`; Clear Cache; Report a Bug /
Request a Feature (GitHub issue URLs); Join Discord).

Windows/Linux: Ctrl accelerators, Quit role instead of Hide-services, a
`Go` menu (Back `Ctrl+[`, Forward `Ctrl+]`, Previous/Next Session
`Alt+Up|Down`, Previous/Next Project `Ctrl+Alt+Up|Down`), Reload and
Force Reload roles, same Help items.

Menu action strings handed to the renderer (app reactions owned by #01/
#14): `about, settings, command-palette, new-session,
new-worktree-session, change-workspace, copy, add-selection-to-chat,
toggle-right-sidebar, open-right-sidebar-git, open-right-sidebar-files,
toggle-terminal, toggle-terminal-expanded, theme-light, theme-dark,
theme-system, toggle-sidebar, toggle-memory-debug, help-dialog,
download-logs, go-back, go-forward, previous-session, next-session,
previous-project, next-project, zoom-in, zoom-out, zoom-reset`.

Delivery rules (`dispatchMenuAction` and friends):
- zoom actions go ONLY through the `openchamber:zoom` DOM event (the preload fans IPC events into DOM events too; dual delivery would apply the zoom twice);
- other actions are delivered BOTH as `openchamber:menu-action` IPC AND as an `executeJavaScript` DOM CustomEvent to the TARGET window (focused, else main, else first);
- append-style actions MUST be exactly-once: `add-selection-to-chat` and `open-mini-chat` are delivered via IPC ONLY;
- `dispatchCheckForUpdates` fans to ALL windows via IPC AND DOM events.

10.3.1 "Check for Updates" origin: menu (or its accelerator) →
`openchamber:check-for-updates` fan-out — the RENDERER reacts by calling
its update store (#14 owns the UI); nothing in main auto-checks on a
schedule.

### 10.4 Open-in-app chains, app opening, and installed-app discovery

App ids across platforms: `vscode, cursor, vscodium, windsurf, zed,
visual-studio (win), sublime-text (win/linux), terminal, finder` and (mac)
the JetBrains set `pycharm|intellij|webstorm|phpstorm|rider|rustrover|
android-studio`. CLI mapping: mac/linux `code|cursor|codium|windsurf|zed|
subl` resolved on PATH (`command -v`); Windows `*.cmd` shims via
`where.exe`. All target paths pass `validateLocalPath` (12.5) first;
failures enumerate candidates ("Failed to open in <app>: <spec>: <reason>;
…").

Launch chains (each spec tried until one succeeds):

- **macOS project**: finder → `open <path>`; terminal/iterm2/ghostty → `open -a <appName> <path>`; CLI app → `<cli> -n <path>`; JetBrains → `open -na <appName> --args <path>`; final fallback `open -a <appName> <path>`. File: finder → `open -R <file>` (reveal); terminal family → `open -a <appName> <parentDir>`; CLI app → `<cli> <file>`; fallback `open -a <appName> <file>`. Execution: `spawnSync(spec)` first success.
- **Windows**: finder (Explorer) → `explorer.exe <path>` / file `/select,<file>`; terminal = Windows Terminal (`wt.exe| WindowsTerminal.exe` — resolved through the Appx package path obtained from `Get-AppxPackage Microsoft.WindowsTerminal(Preview)` or the `WindowsApps` directory scan, args project `-d <path>`, file uses its parent directory), then `start "" pwsh|powershell -NoExit -Command "Set-Location …"`, then `start "" cmd /k cd /d <path>`; CLI apps via `cmd /d /s /c call "<cmd.cmd>" "<arg>"…` (verbatim args, detached, visible); plain `.exe` direct detached spawn. `shell.openPath` for the finder file case. Icon resolution (10.4.x for icons only): `.cmd`/`.bat` shims are scanned for `%~dp0`-relative `.exe` references; `app.getFileIcon(executable, { size: 'normal' })` produces taskbar-style data URLs; Windows Terminal prefers its package image `Square44x44Logo.targetsize-96_altform-unplated.png` (fallbacks `targetsize-96.png`, `StoreLogo.scale-200/100.png`).
- **Linux**: finder → `{ kind: 'default' }` = `shell.openPath` (file) / `shell.showItemInFolder`; terminals resolve in order: a `TerminalEmulator`-category or named desktop entry (Exec expansion below), `xdg-terminal-exec --working-directory <dir>`, `gnome-terminal --working-directory=`, `konsole --workdir`, `xfce4-terminal`, and `x-terminal-emulator` (file opens use the file's directory); CLI entries run `code|cursor|codium|windsurf|subl -n <path>` (zed without `-n`) when on PATH; every suspected app's `.desktop` entry is executed with FreeDesktop field codes substituted (`%f/%F/%u/%U` → target; `%c` → app name; `%k` → desktop file path; other codes removed; unquoted target appended when no field code). Spawns are detached (`spawnDetachedLinux`), errors collected per spec.
- **Installed-app discovery / icons** (drives the in-app picker, command rows in 3.1 and the cache in 1.6):
  - macOS: bundle candidates `/Applications`, `/System/Applications`, `/System/Applications/Utilities`, `~/Applications`, then `mdfind -name`; icon = first `.icns` in `Contents/Resources` → `sips -s format png -Z 32` (temp file cleanup) → base64 data URL.
  - Windows: presence via `where.exe` per executable list (finder always installed; terminal via the WindowsTerminal resolution above); icons via `app.getFileIcon` (+ the Terminal package image).
  - Linux: FreeDesktop entries from `$XDG_DATA_HOME/applications`, `$XDG_DATA_DIRS/applications` (+ `/usr/local/share/applications`, `/usr/share/applications`), recursive, skipping `Type!=Application`, `NoDisplay`, `Hidden`, dedupe by id, sort by name; matching normalizes case/punctuation and tests containment in both directions against name/id/filename/Exec (CJK-only names guarded: normalization to empty is dropped so such entries only match via a comparable field); the default file manager comes from `xdg-mime query default inode/directory` (1.5 s timeout), else a fixed fallback id list, else a `FileManager` category entry; the "terminal" row prefers a `TerminalEmulator` entry then ghostty, with icon fallbacks `utilities-terminal`, `org.gnome.Terminal`, `terminal`; icons resolve as: absolute icon paths, else theme dirs (`$XDG_DATA_HOME|XDG_DATA_DIRS|~/.icons|/usr/ share|local}/icons`, `hicolor` first) walking size dirs `48x48,48,32x32,32,64x64,64,24x24,24,22x22,22,16x16,16,128x128,128, 256x256,256,scalable` and categories `apps|places|status|devices|mimetypes|legacy`, PNG preferred over SVG, then `pixmaps` dirs (`.png|.svg|.xpm`); only PNG becomes a data URL (no SVG tooling). Legacy flat keys `splash…` for the splash palette never come from here — see 1.6.

### 10.5 Misc OS integration

- **Quit-risk surface** (1.7) and scheduled-task/tunnel gating: #12 owns the semantics; the shell polls `getQuitRiskStatus()`/HTTP equivalents.
- **LAN IP** (`desktop_get_lan_address`): UDP socket `connect('8.8.8.8', 80)` route lookup (no packet sent); fallback first non-internal IPv4 from `os.networkInterfaces()`.
- **Keep awake** `powerSaveBlocker('prevent-app-suspension')` toggle + status; persisted in settings.
- **System resume** → `openchamber:system-resume` (SSE reconnect hint).
- **Taskbar progress** (Windows): update downloads (9.1/9.4).
- **Clear app cache**: `desktop_clear_cache` (3.1).
- **Context menu**: `electron-context-menu({ showInspectElement: isDev, showSaveImageAs: true, showCopyImage: true, showCopyLink: true })` registered once globally.
- **Desktop restart from the menu**: `Restart` → `prepareForQuit()` + `app.relaunch()` + exit (order matters: state flags cleared first).
- **Window-state persistence**: `desktopWindowState` (4.1).

### 10.6 Launch at login / autostart

`desktop_get_launch_at_login` / `desktop_set_launch_at_login { enabled }`
(3.1 rows) with the semantics:
- **Linux**: XDG autostart — check/write/remove `<$XDG_CONFIG_HOME|$HOME/.config>/autostart/openchamber.desktop`. `readLinuxAutostartEnabled` = file exists; `setLinuxAutostartEnabled(enabled)` writes the entry when enabled, removes it when not. Entry (exact): `[Desktop Entry]`, `Type=Application`, `Name=<appName>`, `Exec=<quoted launch path>[ --background]`, `Terminal=false`, `X-GNOME-Autostart-enabled=true`, `StartupWMClass=openchamber`. Launch executable = absolute `$APPIMAGE` when present else `process.execPath`. Desktop-entry quoting applies ONLY to args containing space/tab/newline/quote/dollar/backslash. Packaged Linux REWRITES the entry at boot when it already exists (the AppImage path changes between updates); when it does not exist, boot does not create it (only the user's explicit toggle does).
- **macOS**: `app.getLoginItemSettings({})`; set `{ openAtLogin: enabled, openAsHidden: enabled }`.
- **Windows**: options `{ path: process.execPath, args: ['--background'], name: APP_USER_MODEL_ID }`; set `{ openAtLogin: enabled, ...options, enabled }`.
- Background-start detection (1.3): `--background` in argv OR login-item `wasOpenedAtLogin`/`wasOpenedAsHidden` → headless boot (1.3 step 21; no window; the server still starts unless `OPENCHAMBER_SKIP_LOCAL_SERVER=1`, in which case the remote is re-probed when a window eventually opens).

---

## 11. Permission Model and Security Invariants

### 11.1 IPC sender gate

`isLocalSender(webContents)` (exact rules):
- `openchamber-ui://app` → local;
- dev only: origin equals `http://127.0.0.1:<OPENCHAMBER_HMR_UI_PORT || '5173'>` → local (this HMR origin is trusted ONLY in dev);
- http(s) with origin equal to `state.localOrigin` or `state.sidecarUrl` → local;
- everything else (a remote OpenChamber server hosting the same React UI) → NOT local.

Command handling in `ipcMain.handle('openchamber:invoke', ...)`: reject non-
local senders whose command is not in `COMMANDS_SAFE_FOR_REMOTE`
(`throw 'IPC not available for this origin'` + warn log with the sender
URL); resolve the owning `BrowserWindow` and dispatch. The complete command
catalog with per-command gating (R/L) is 3.1; the exact safe-for-remote set
is listed there and is the load-bearing security list:

```
desktop_hosts_get, desktop_host_probe, desktop_new_window,
desktop_new_window_at_url, desktop_new_window_for_host,
desktop_set_window_title, desktop_set_window_theme,
desktop_is_window_fullscreen, desktop_start_window_drag,
desktop_minimize_current_window, desktop_toggle_current_window_maximized,
desktop_close_current_window, desktop_get_current_window_state,
desktop_get_app_version, desktop_get_lan_address,
desktop_capture_page_rect, desktop_tray_update
```

`openchamber:dialog:open` and `openchamber:file:grant-existing` are
ALWAYS local-only (native dialogs expose absolute local paths; "never grant
to remote").

Design principle: commands fall into two buckets by CAPABILITY, not by
origin: window/host-switcher operations (probe a URL, open a window, set a
title, read the hosts list) are safe for any renderer; filesystem, shell,
installed-app scans, app relaunch, dialogs, SSH, updates are local-only.
Remote pages can list/probe hosts and manage windows — everything needed by
the in-window host switcher — but can never touch the host machine.

### 11.2 Preload exposure matrix

| Global | Exposure | Content / risk note |
|---|---|---|
| `__OPENCHAMBER_ELECTRON__` | EVERY page (incl. cross-origin) | `{ runtime: 'electron', arch, trayEnabled }`; shell identity only, no capability. Remote UIs need it to render desktop affordances. |
| `__OPENCHAMBER_PLATFORM__` | every page | `process.platform` |
| `__OPENCHAMBER_LOCAL_ORIGIN__` | every page (when configured) | `http://127.0.0.1:<port>`; remote pages need it so `isDesktopLocalOriginActive()` and the host switcher know the Local entry URL. Not exploitable without the IPC channel; the local server's CORS prevents remote-origin fetches. |
| `__OPENCHAMBER_API_BASE_URL__` | every page (when configured) | active API base |
| `__OPENCHAMBER_CLIENT_TOKEN__` | LOCAL pages only | bearer token — never visible to a remote page |
| `__OPENCHAMBER_RELAY_HOST_ID__` | local pages only | which saved host this window reconnects (relay-capable path) |
| `__OPENCHAMBER_RUNTIME_HEADERS__` | local pages only | sanitized custom headers (JSON from argv) |
| `__OPENCHAMBER_HOME__` | local pages only | home directory (leaks the OS username) |
| `__OPENCHAMBER_MACOS_MAJOR__` | numeric > 0, any page | presentation only |
| `__OPENCHAMBER_DESKTOP__` | every page | the bridge (3.4); PRIVILEGED commands are gated in the MAIN process, never here |
| `bootOutcome` | init-script injection only | must stay WRITABLE from the main world so re-navigations (host switch via deep link) refresh it; a contextBridge global would be read-only, which is why it is injected |
| relay dev-tunnel members | local pages only | `relayDevTunnelListen`/`relayDevTunnelPost` + the connect port handoff (3.3) |

Other preload hard rules:
- The preload re-executes on EVERY cross-origin navigation (sandbox: false, per-document); local-only globals are re-derived from `location .origin` at that moment. `isLocalPage` = `openchamber-ui://app` OR exact match with the local origin.
- `openchamber:emit` from main is a READ-ONLY notification fan-out (`{ event, detail }`): events may be delivered to any page in the webContents (they grant no capability).
- `openchamber:relay-dev-tunnel-connect` is discarded for non-local pages.
- DOM-fanned events (prepended CustomEvents) follow the same rule.

### 11.3 Renderer/iframe boundaries (desktop facts)

Every window: `contextIsolation: true`, `nodeIntegration: false`,
`webviewTag: true`, `sandbox: false` (preload needs Node's contextBridge/
ipcRenderer; losing it would kill the desktop bridge), `backgroundThrottling:
false`. Session-chat iframes (same-origin, inside the UI) complete an
authenticated parent-frame handshake before creating their own SDK client;
the parent supplies its active in-memory endpoint and credentials; with
relay active it supplies the public relay descriptor WITHOUT any pairing
grant (Electron preload/IPC are unavailable inside the iframe); the iframe
establishes its own transport and rebinds its SDK. Credentials are NEVER
placed in iframe URLs; sibling child pages do not receive this runtime
state; additional windows keep their own per-window runtime bootstrap
(never overwritten by the main window's). (#04/#05 own the handshake
mechanics.) Navigation guards (4.5) keep foreign origins out of app windows
and push foreign popups to the system browser; a remote UI runs in an app
window intentionally (host switching) and is bounded by 11.1.

### 11.4 Header/token hygiene

`sanitizeRuntimeRequestHeaders(headers)`: drop empty name/value; name may
not contain CR/LF/`;`; value may not contain CR/LF; **`Authorization` is
always dropped** (the bearer travels as a separate, governed field).
Applied at every boundary: hosts storage, renderer runtime config,
init-script serialization, tunnels (direct dev tunnel setup), host probes.
This keeps custom per-host headers expressive without header-injection or
token laundering.

No secrets in logs/DOM invariants:
- SSH error surfaces are scrubbed against the secret (8.4); askpass files are 0700 and deleted on disconnect;
- client tokens never appear in URLs, never in remote pages (11.2), are stored only in `settings.json` (0600);
- the pairing grant is one-time and never persisted (2.8);
- device/install ids are not secrets (dedupe-only);
- `desktop-read-file` blocks credential stores (12.2).

### 11.5 External content rules

- The browser panel loads anything the user types; its boundaries are the functional ones in 7.4 (cert policy, permission/device denial, popup containment, contents-id membership check, partition-scoped storage).
- Electron permission handlers: the panel session denies everything BY DEFAULT (Electron's default is GRANT — silence would be a silent grant).
- Certificate failures: only self-signed LOOPBACK https is allowed; every other certificate error on every session is blocked.
- Updater: trusted pinned feed only (9.1); no user-configurable update source; capability gates per platform (9.2).

### 11.6 Invariants checklist (each must have a mechanism)

1. In-process backend, never a sidecar; the managed OpenCode child is reaped on quit/signals/install (1.7/1.8/9.5).
2. Privileged commands gated in the MAIN process (11.1), not in UI code.
3. External content never gains API access: window navigation allowlist + external-open (4.5); sender gate (11.1); panel membership checks and permission denial (7.4).
4. Updater only from the pinned feed, per-platform capability gated (9.1-9.2); installer failures must reach the renderer (9.5).
5. No secrets in logs, DOM, URLs (11.4, 7.4, 8.4).
6. Settings writes atomic + serialized; Windows rename retries (1.6, 12.4).
7. `openchamber://connect` requires explicit consent before any config write (5.1).
8. Renderer crash recovery is bounded and reason-filtered (12.1).
9. Host `webContentsId`-taking commands require panel-partition membership (7.4); the safe-for-remote command set is closed (11.1).
10. Every new IPC command must be classified for the sender gate at addition time (README "IPC Pattern" order: preload shape → main handler → gate → keep shared contracts in packages/ui and server/runtime APIs in packages/web unless inherently native).

---

## 12. Renderer Recovery and File Utilities

### 12.1 Renderer crash recovery

(src: renderer-recovery.mjs; attached to EVERY BrowserWindow via
`attachRendererRecovery(window, { log, label: 'window'|'mini chat' })`)

Policy per window:
- listen `webContents 'render-process-gone'`;
- recoverable reasons ONLY: `abnormal-exit`, `crashed`, `oom`, `memory-eviction` (e.g. `clean-exit` is ignored);
- budget: rolling 60 s window (`RECOVERY_WINDOW_MS`) — when the last reload happened at window start is beyond 60 s, the counter resets; max 3 reload attempts inside the window;
- reload after 100 ms (`RELOAD_DELAY_MS`) if the window still exists;
- log `{ label, surface, reason, exitCode }` at warn.

Depends on renderer bootstrap being reload-safe (sync engine re-bootstraps
on load, #04). The browser panel has its own renderer-side crash budget
(7.2).

### 12.2 `desktop_read_file` guard chain

(src: main.mjs)
1. Path required; `path.resolve`.
2. Under `$HOME` (inclusive of `$HOME` itself) OR `os.tmpdir()`; else `'File is outside the allowed workspace'`. (Defense in depth behind the IPC origin gate: even the app's own UI — or a prompt-injected agent — cannot read credential stores.)
3. Denied relative segments under home (exact or as a path prefix): `.ssh`, `.aws`, `.gnupg`, `.gpg`, `.config/gh`, `.config/openchamber/credentials`; basename checks: `.env`, `.env.<anything>`, `*.pem`, `*.key` → `'Access to this path is not allowed'`.
4. Size limit 50 MB (`'File is too large. Maximum size is 50MB.'`).
5. Read → `{ mime, base64, size }`; MIME map: png→image/png, jpg/jpeg, gif, webp, svg+xml, bmp, ico→image/x-icon, pdf, txt, md→text/markdown, json, js→text/javascript, ts/tsx→text/typescript(+jsx), jsx, html, css, py→text/x-python; default `application/octet-stream`.

### 12.3 `desktop_save_markdown_file`

Native save dialog with `defaultPath` and Markdown filter; write UTF-8;
returns the absolute path or `null` on cancel.

### 12.4 Atomic file replacement with Windows retry

`replaceFileWithRetry(source, target)` (windows-file-replace.mjs) — used
for EVERY atomic settings/preferences/hosts write (temp file + rename):
- retry ONLY on Windows and only for `EPERM|EACCES|EBUSY`;
- delay schedule: `[50, 100, 200, 400, 800, 1000, 1000]` ms, then throw;
- callers remove the temp file on failure.

### 12.5 Local path validation

`validateLocalPath(rawPath, label = 'Path')`: trim → required → resolve →
`stat` (ENOENT/ENOTDIR → `<label> does not exist: <path>`; EACCES/EPERM →
`<label> is not accessible: <path>`; other → ``<label> could not be
checked: <msg>``); directories require `R_OK|X_OK`, files `R_OK`; returns
`{ path, stats }`.

`unsupportedAppSpecificOpenError(kind, platform)` → `Opening <kind> in a
specific app is not supported on <Windows|Linux|raw platform name> yet.
Use the default open action instead.`

`resolveManagedOpenCodeCwd({ env, homedir })` (opencode-cwd.mjs):
configured `OPENCHAMBER_OPENCODE_CWD` wins; else homedir; else
`process.cwd()`.

---

## 13. Shared-UI Desktop Surface (bridge contracts)

(src: packages/ui/src/lib/desktop*.ts + desktopNative.ts;
components/desktop, components/mini-chat, components/browser;
stores/useDesktopSshStore.ts, useUpdateStore.ts; #01 owns the boot
adaptation matrix and chooser/recovery screens; #14 owns settings/theme.)

### 13.1 Capability predicates (lib/desktop.ts)

- `isElectronShell()` / `isDesktopShell()`: `__OPENCHAMBER_ELECTRON__ .runtime === 'electron'`.
- `isElectronPlatform()` via `__OPENCHAMBER_PLATFORM__`.
- `hasDesktopInvoke()` / `canUseElectronDesktopIPC()` (shell + bridge).
- `usesFramelessElectronChrome()`: shell AND platform win32/linux.
- `isDesktopLocalOriginActive()`: runtime key `local` → true; else compare the injected `__OPENCHAMBER_LOCAL_ORIGIN__` against the active runtime base (origin equality, or same-port loopback↔loopback pairs), then window.location-origin comparisons, else "current page is loopback". Gates every machine-touching call (dialogs, open/reveal, launch-at-login, tray minimize, keep-awake, LAN address).
- `isVSCodeRuntime()` / `isWebRuntime()` / `isBrowserClientRuntime (platform)` for the update-check path and runtime selection.

### 13.2 `lib/desktop.ts` function → command map

Every function no-ops (null/false) when the bridge is absent; machine-touching
ones additionally require `isDesktopLocalOriginActive()`.

| Function | Bridge call | Contract notes |
|---|---|---|
| `invokeDesktop(cmd, args?)` | `openchamber:invoke` | generic; null without bridge |
| `get/setDesktopLaunchAtLogin(enabled)` | `desktop_get/set_launch_at_login` | `{ supported, enabled }` |
| `get/setDesktopMinimizeToTray(enabled)` | `desktop_get/set_minimize_to_tray` | `{ supported, enabled }` |
| `get/setDesktopKeepAwake(enabled)` | `desktop_get/set_keep_awake` | `{ supported, enabled, active }` |
| `focusDesktopWindow()` | `desktop_focus_window` | bool |
| `canRequestNativeDirectoryAccess()` | predicate | shell + invoke + local origin |
| `requestDirectoryAccess(directoryPath)` | `openDialog({ directory: true, multiple: false, title: 'Select Working Directory', defaultPath? })` | `{ success, path }` / cancel; shared UI supplies `defaultPath` so confirmation is required before FS access is retried |
| `requestFileAccess({ filters?, defaultPath? })` | `openDialog({ directory: false, multiple: false, title: 'Select File', returnGrant: true, … })` | `{ success, path, outsideFileGrant?, expiresAt? }` |
| `requestExistingFileAccess(path)` | `grantFileAccess(path)` | validates `{ path, outsideFileGrant, expiresAt }` (zod) |
| `checkForDesktopUpdates()` | `desktop_check_for_updates` | errors PROPAGATE (capability/feed messages are actionable) |
| `downloadDesktopUpdate(onProgress?)` | `desktop_download_and_install_update` + `listen('openchamber:update-progress')` | progress `{ downloaded, total? }` from Started/Progress/Finished; unlistens in finally |
| `restartToApplyUpdate()` / `restartDesktopApp()` | `desktop_restart` | install failures REJECT and must reach the dialog (not collapse to false) |
| `getDesktopLanAddress()` | `desktop_get_lan_address` | local only |
| `openDesktopPath(path, app?)` / `revealDesktopPath(path)` | `desktop_open_path` / `desktop_reveal_path` | local only; reveal falls back to open |
| `saveDesktopMarkdownFile(name, content)` | `desktop_save_markdown_file` | path or null |
| `openDesktopProjectInApp(path, appId, appName)` / `openDesktopFileInApp(...)` | `desktop_open_in_app` / `desktop_open_file_in_app` | all three args required |
| `fetchDesktopInstalledApps(apps, force?)` | `desktop_get_installed_apps` | `{ apps: [{ name, iconDataUrl }], success, hasCache, isCacheStale }` |
| `startAccessingDirectory/stopAccessingDirectory` | none (web no-op) | parity stubs |
| `getDesktopHomeDirectory()` | none (global read) | `__OPENCHAMBER_HOME__` |
| `setDesktopWindowTheme(mode?, variant?, splash?)` (desktopNative.ts) | `desktop_set_window_theme` | splash colors are device state, never the shared settings doc |
| `setDesktopWindowTitle(title)`, `startDesktopWindowDrag()` (desktopNative.ts) | `desktop_set_window_title`, `desktop_start_window_drag` | shell-gated, swallow errors |
| `getDesktopAppVersion()` (desktopNative.ts) | `desktop_get_app_version` | null on failure |
| `listenForDesktopRelayDevTunnels(handler)` / `postDesktopRelayDevTunnelMessage(connectionId, message)` (desktopNative.ts) | preload MessagePort bridge | local pages only; protocol 3.3 |
| `invokeDesktopCommand(cmd, args)` (desktopNative.ts) | generic with `hasDesktopInvoke` guard | used by the browser panel |

### 13.3 Host libs (desktopHosts.ts, desktopCurrentHost.ts, desktopHostStatus.ts)

- IPC functions: `desktopHostsGet` (adds `localOrigin`), `desktopHostsSet`, `desktopLocalClientTokenGet`, `desktopInstallIdGet` (may be `''` outside desktop), `desktopHostProbe(url, { clientToken?, requestHeaders?, expectedServerId? })` (status enum in 3.1), `desktopOpenNewWindowAtUrl`, `desktopOpenNewWindowForHost` (relay-aware).
- `probeRelayDesktopHost(relay, { keepTunnel?, clientToken?, requestHeaders? })`: renderer-side throwaway E2EE tunnel; `/health`, then `/auth/session` with the saved bearer; per-attempt 8 s, whole-probe deadline 15 s, 400 ms retry gap THROUGH the tunnel's own reconnects; terminal tunnel state ends immediately; `keepTunnel` returns the live tunnel for adoption (skips a second connect + handshake); else closes it. A ghost relay registration must resolve to `unreachable`, never hang.
- `importDesktopHostPairing(link, hosts)`: renderer pairing redeem, relay candidates tried before direct ones (`createRelayTunnelClient`), `dedupeKey: desktop:<installId>`; host merge like 5.1; `relay://` display URL for relay-only hosts.
- Pure URL hygiene: `normalizeHostUrl` (http(s), strips fragment), `resolveDesktopHostUrl` (`/connect?t=` → persisted origin + redeem URL), `redactSensitiveUrl` (userinfo cleared; query keys matching `/^(t|.*(?:token|auth|secret|api).*)$/i` → `[REDACTED]`), `locationMatchesHost`, `relayHostDisplayUrl`, `getDesktopHostApiUrl`.
- `resolveCurrentDesktopHost(hosts)` (desktopCurrentHost.ts): names the ACTIVE instance — relay hosts identified by the runtime key `host:<id>`; local by origin/port-loopback matches; `openchamber-ui://` → Local; fallback label = redacted current URL.
- `desktopHostStatus.ts`: module-level reachability store (`useSyncExternalStore` semantics): `{ byHostId: { [id]: { status, latencyMs, via?: 'relay' } }, isProbing }`; run-ownership ordering (each run carries a sequence number; a stale slow run may not overwrite a fresh result); local probes use the local token; relay-capable hosts probe via `probeRelayDesktopHost` and tag `via: 'relay'`; startup warm-up probes every configured host before the UI asks.
- `desktopRelayRestore.ts restoreDesktopRelayRuntime(hostId?)` (2.4 partner): on desktop startup, for a saved relay-capable default host (or an explicit target for a host window): race the direct probe against a 1.5 s headstart; winner-ok → `switchRuntimeEndpoint({ apiBaseUrl, clientToken, requestHeaders, runtimeKey: 'host:<id>' })`; not-ok or headstart timeout → `switchRuntimeEndpoint({ relay })` (renderer opens the E2EE tunnel; #08 owns the wire format) and schedule the candidate refresh; a late direct success hot-switches back to direct (runtime key unchanged — transport-only swap, not an instance switch).
- `scheduleDesktopHostCandidateRefresh(hostId)` (5 s after a relay switch): fetch `/api/client-auth/connection/candidates` over the active runtime; verify the reported `serverId` equals the pinned relay serverId (identity gate; old servers without serverId ignored); never overwrite an `https://` apiUrl; an empty answer never erases a stored address; store a fresh LAN `apiUrl` when it moved; probe with `expectedServerId`; hot-switch to direct when reachable. This repairs DHCP lease drift by learning the address FROM the host over its pinned tunnel — no confirmation needed, trust is unchanged.

### 13.4 Window controls (components/desktop)

- `WindowsWindowControls.tsx`: visible when frameless chrome (win/linux); styles `classic` (square buttons; right side h-12 hit band, left side h-8) or `traffic-lights` (macOS-style 14 px circles #FF5F57/#FEBC2E/#28C940, glyphs revealed on cluster hover; theme-independent by design). Side preference `left|right` (legacy `auto` → right); order derived from side (left = close,min,max; right = min,max,close). Actions: commands `desktop_close_current_window`, `desktop_minimize_current_window`, `desktop_toggle_current_window_maximized` (awaited to update the restore/maximize glyph), `desktop_get_current_window_state` on mount, live state via the `openchamber:window-maximized-changed` DOM event.
- `OpenInAppButton.tsx`: the "open in app" affordance over the installed-apps pipeline (10.4): requires local-origin + desktop invoke, fetches the installed-apps cache, calls `desktop_open_in_app` / `desktop_open_file_in_app`.
- `DesktopHostSwitcher.tsx` (host switcher): uses `desktopHostsGet/Set`, `desktopHostProbe`, `probeRelayDesktopHost({ keepTunnel: true })` (adopting the probe tunnel on ok to skip a second handshake), `desktopOpenNewWindowForHost/AtUrl`, `desktop_remote_password_login` (add-host password flow), `desktopInstallIdGet` (pairing dedupe), `restoreDesktopRelayRuntime` for relay hosts, `switchRuntimeEndpoint` with runtime key `local` or `host:<id>`; key equality makes relay↔direct swaps transport-only. (First-run chooser/recovery screens: #01.)

### 13.5 Mini Chat surface

(components/mini-chat/MiniChatLayout.tsx; see 4.6 for the window)
- Reads `mode`/`sessionId`/`directory`/`projectId` from the URL; uses the shared sync stores for sessions/messages/status; renders the compact header (session title or "New Session"/"Session"; project + git branch resolution over the session directory, worktree metadata, or catalog; omitted for managed Chats contexts); context usage display.
- Pin: `desktop_get_window_pinned` / `desktop_set_window_pinned`.
- "Open in main window": `desktop_focus_main_window { sessionId?,… | mode: 'draft', directory, projectId }`.
- Window controls: 13.4; macOS header height shifts per `__OPENCHAMBER_MACOS_MAJOR__` (>=26 → shorter, <=15 → taller); traffics lights re-positioned by main (4.1).
- Native zoom behavior: composer focus adjusts the interface scale; terminal/file-editor focus adjust their own font sizes (renderer-owned).
- Managed-Chats targeting rules (4.6): default = Chats directory; explicit project/worktree drafts keep their target; existing managed sessions reopen in their own directory; opening a managed draft in the main window preserves the target.

### 13.6 SSH store/types

Summarized in 8.8 (types, commands, event, store shape); zod-gated parsing on
read with camelCase preferred and snake_case accepted.

### 13.7 Update store and update surfaces

- `useUpdateStore` (pipeline in 9.7): state `{ checking, available, downloading, downloaded, info, progress, error, runtimeType, lastChecked, nextCheckInSec }`; desktop check runs the native check AND the server's `/api/openchamber/update-check` in parallel (Promise.allSettled; the native result is authoritative for availability; server supplies `body` fallback and `nextSuggestedCheckInSec`); web/vscode/mobile use the server route (vscode always `available: false` — its update path is the extension host, #10).
- `downloadUpdate()` re-checks first (an "update detected, but the desktop package is not ready yet" retry hint), preserves the richer server changelog body over the bare updater note, downloads with progress, then `downloaded: true`.
- `restartToUpdate()` calls `desktop_restart`; installer failures are stored (`getUpdateInstallErrorMessage`) so the dialog shows the real cause and the button stays active.
- Components: `OpenCodeUpdateToast` + `openCodeUpdateDedup` (OpenCode CLI updates, server-mediated; NOT the desktop updater); `MobileAppUpdateToast` (Capacitor; #11).

### 13.8 Tray sync hook

`useTraySync` (native side in 10.1): gates on platform + trayEnabled +
desktop IPC; resolves the instance label ONCE per window load (Local
OpenChamber vs configured host label, redacted; fallback "Instance");
builds the snapshot: `sessions` root rows only (`MAX_SESSIONS = 20`; the
native menu clips to 8) with status rollup busy > retry > idle across the
root + subtask family, unseen/error counts from the notification index,
`subtitle` "project · branch", `approvals` from permission/question sync
state, `usage` from the quota store for enabled providers,
`dockBadgeCount` = root chats with unseen over the FULL list (opt-out and
subtask-notify rules honored); debounces 500 ms, JSON-dedupes, pushes via
`desktop_tray_update`; subscribes to every store that can change the
snapshot (sync child stores + registry, notification, global sessions,
projects, worktrees, git, UI prefs, global status map, ordering, pinned,
quota) with a 5 s fallback poll and a per-directory status poll
(`getSessionStatusForDirectory`) reconciling the cross-project status map;
listens for `openchamber:tray-action` and answers `respond-permission` via
the session-actions layer (toast on failure).

---

## 14. Packaging Matrix and Scripts

### 14.1 electron-builder configuration (`packages/electron/package.json "build"`)

| Key | Value |
|---|---|
| appId | `dev.openchamber.desktop` |
| productName | `OpenChamber` |
| files | `dist-bundle/main.mjs`, `preload.mjs` (only — helpers already bundled; web + native deps stay external) |
| extraResources | `resources/web-dist → web-dist`; `icons/icon.ico`; `icons/icon.png`; `icons/tray → icons/tray`; `resources/opencode-cli → opencode-cli` |
| afterPack | `scripts/after-pack.cjs` — macOS: copy the precompiled `Assets.car` icon catalog into `Contents/Resources` (packaging does not run actool) |
| artifactName | `${productName}-${version}-${arch}.${ext}`; mac `-mac-`, win `-win-`, linux `-linux-` variants |
| npmRebuild | false (native modules rebuilt by `rebuild:native`) |
| mac | category `public.app-category.developer-tools`; icon `icon.icns`; targets `dmg` + `zip` (zip = auto-update artifact); hardenedRuntime; entitlements `entitlements.mac.plist` (+inherit); notarize true; gatekeeperAssess false; `extendInfo.CFBundleIconName = 'AppIcon'` |
| win | icon `icon.ico`; target `nsis`; `verifyUpdateCodeSignature: false`; artifactName `-win-` |
| nsis | `oneClick: true`, `perMachine: false`, installer/uninstaller/header icons |
| linux | target `AppImage`; category `Development`; icon `icon.png`; `executableName: openchamber`; desktop entry `Name: OpenChamber`, `Comment: Desktop runtime for OpenChamber`, `Icon: openchamber`, `StartupWMClass: openchamber` (stable identity across architectures) |
| dmg | signed; title `${productName} ${version}`; background `#FFFCF0`; iconSize 100; iconTextSize 13; window 540x340; app at (180,140), /Applications link at (360,140) |
| publish | `{ provider: 'github', owner: 'openchamber', repo: 'openchamber' }` |

macOS entitlements (intentionally NOT App-Sandboxed; distributed outside
the Mac App Store): `allow-jit`, `allow-unsigned-executable-memory`,
`disable-executable-page-protection`, `disable-library-validation`,
`allow-dyld-environment-variables`, `device.audio-input` (dictation),
`network.client` + `network.server`, `files.user-selected.read-write`,
`inherit` (helpers).

 Signing:
- macOS: developer ID + notarization required for distribution; the dmg is signed; Xcode/build tools needed for icon catalog compilation in general (here precompiled `Assets.car` avoids it) and for notarization;
- Windows: NSIS via electron-builder; when neither `CSC_LINK` nor `WINDOWS_CSC_LINK` is set, `package.mjs` sets `CSC_IDENTITY_AUTO_DISCOVERY=false` (logs "Windows code signing disabled; building unsigned installer");
- Linux: no signing; AppImage for the NATIVE host arch only.

### 14.2 Package pipeline

`bun run electron:build` → `packages/electron` scripts in order:

1. `build:web-assets` — run `packages/web`'s build with the resolved Bun (Windows: `where.exe bun`, `.cmd` shims executed via `cmd /d /s /c call "…" "…"`; POSIX: `/bin/bash -lc command -v bun`), then stage `packages/web/dist` → `resources/web-dist` via a temp dir + rename (directory removal retried on `ENOTEMPTY|EBUSY|EPERM`).
2. `prepare:opencode-cli` — download and stage the pinned OpenCode CLI (14.5).
3. `bundle:main` — Bun-build `main.mjs` → `dist-bundle/main.mjs` (`target: 'node'`, `format: 'esm'`, minify off, sourcemap none, external: `electron`, `@openchamber/web`, `@openchamber/web/*`, `bun-pty`, `node-pty`; define `__OPENCHAMBER_UPDATER_E2E_BUILD__` from `OPENCHAMBER_UPDATER_E2E_BUILD=1`). External-ness is a HARD constraint: `bun-pty` has a top-level `import { dlopen } from "bun:ffi"`; inlined, Node's ESM loader crashes with `ERR_UNSUPPORTED_ESM_URL_SCHEME` before any runtime guard; keeping the web package external keeps its conditional `if (isBunRuntime) await import('bun-pty')` unreached under Electron.
4. `rebuild:native` — rebuild native modules against the Electron runtime (`@electron/rebuild` + `node-abi`).
5. `package.mjs` — resolve the target architecture (14.3), force `--x64`/`--arm64` for Linux when no arch arg was given, disable Windows signing discovery when env is missing, and run `bun x electron-builder` with passthrough args.

Output: `packages/electron/dist`. Artifacts: macOS `dmg` + `zip`; Windows
NSIS installer (x64 and arm64 builds); Linux `AppImage` (x64/arm64).

### 14.3 Architecture resolution

`resolveTargetArchitecture({ platform, hostArchitecture, environment,
builderArgs })`:
- precedence: `OPENCHAMBER_TARGET_ARCH` env > `ELECTRON_BUILDER_ARCH` env > builder args (`--x64|--arm64|--arch <a>|--arch=<a>`; exactly ONE architecture required) > host arch;
- aliases: `amd64|x86_64 → x64`, `aarch64 → arm64`; unknown → error listing supported values;
- **Linux: target MUST equal host arch** (`Linux AppImages must be built natively: host is <h>, target is <t>. Run this build on a <t> Linux host.`);
- the resolved target feeds electron-builder `--arch`, the OpenCode CLI artifact, and the native rebuild.

Post-package verification (`bun run --cwd packages/electron
verify:linux-appimage`): extracts the final AppImage and checks the ELF
architecture, desktop identity (executable `openchamber`,
`openchamber.desktop`, icon `openchamber`, `StartupWMClass`), the Electron
executable, the pinned OpenCode CLI version and architecture, and every
packaged native `.node` module.

Runtime prerequisites: macOS Xcode/build tools (notarized builds); Windows
NSIS; Linux native host + FUSE (`libfuse.so.2`; typically `libfuse2` /
`libfuse2t64`) to RUN AppImages, or `APPIMAGE_EXTRACT_AND_RUN=1`; keep the
AppImage on a writable path for in-app updates; desktop clears AppImage
`ARGV0` from `process.env` before shell probing (2.7/12.5 of env rules).

### 14.4 Update manifests and channels

- Windows x64 `latest.yml` / arm64 `latest-arm64.yml` (channel-selected at runtime); macOS merged `latest-mac.yml` (both arch entries); Linux `latest-linux.yml` + `latest-linux-arm64.yml`, each validated against its AppImage before upload (`verify-update-manifest`); Linux updates are FULL AppImage downloads (no blockmap yet).
- `finalize:latest-yml` (release-time): merges CI per-target YAML outputs — requires BOTH Windows manifests; writes into `$RUNNER_TEMP` for upload to the release tag `v<version>`; preserves `url`, `sha512`, `size`, `blockMapSize` verbatim and the release date.
- Authenticated web clients of the embedded desktop host reuse the desktop updater (9.6); a Linux `latest-linux*.yml` 404 before the first publish is "no update available" (9.3).

### 14.5 Bundled OpenCode CLI

- Version source: root `package.json` `dependencies['@opencode-ai/sdk']` MUST be pinned to an EXACT semver (the packaging contract) unless `OPENCHAMBER_OPENCODE_CLI_VERSION` overrides.
- Artifact mapping (target-arch aware): darwin arm64 `opencode-darwin-arm64.zip`; darwin x64 `opencode-darwin-x64-baseline .zip`; windows x64 AND arm64 → `opencode-windows-x64-baseline.zip` (TEMPORARY: native windows-arm64 opencode fails to dlopen under Bun FFI; x64-baseline runs under emulation; restore arm64 upstream when fixed); linux arm64 `opencode-linux-arm64.tar.gz`; linux x64 `opencode-linux-x64-baseline.tar.gz`.
- Download from the OpenCode GitHub release `releases/download/v<version>/<artifact>`; cached under `packages/electron/.cache/opencode-cli/<version>/<platform>-<arch>/`; extract (zip via PowerShell `Expand-Archive` on Windows else `unzip`; tar.gz via `tar`); find the binary recursively; stage into `resources/opencode-cli/opencode|opencode.exe` after clearing the dir (except `.gitkeep`); chmod 0755 on POSIX; verify `--version` matches the pinned version both after staging and (optionally) in the packaged app (`verify:opencode-cli` / `--packaged`).
- Managed local Desktop startup CLI preference order (web-side resolution; 1.5 supplies the env): `settings.opencodeBinary` → env overrides (`OPENCODE_BINARY`, `OPENCODE_PATH`, `OPENCHAMBER_OPENCODE_PATH`, `OPENCHAMBER_OPENCODE_BIN`) → bundled Desktop CLI in `process.resourcesPath/opencode-cli` → system installs on PATH → known npm/Bun/Homebrew/Scoop/Chocolatey locations → platform discovery (`where opencode` on Windows; a login shell otherwise). The configured path must point to the standalone CLI, not an app executable (that is a web-package resolution rule, #03).

### 14.6 Dev launcher and Electron install repair

- `ensure-electron.mjs` (`bun run --cwd packages/electron ensure:electron`): detects incomplete installs (missing binary, stale `dist/version`/`path.txt`, wrong-arch binary) and repairs by re-running Electron's postinstall under Bun (falls back to Node; resolves npm `bun.cmd` shims to `bun.exe` on Windows); `--best-effort` mode for the root postinstall, fail-fast for the dev launcher; `ELECTRON_SKIP_BINARY_DOWNLOAD=1` skips (CI without network).
- `electron-dev.mjs` — the full dev orchestration (1.4): port scan (up to +50 above preferred, warn on deviation), HMR dev server + Electron process pair with teardown escalation, `OPENCHAMBER_DISABLE_PWA_DEV=1`.
- Root `postinstall` runs the best-effort repair; the electron workspace package trusts Electron's install script (`trustedDependencies`) so `bun install` downloads the runtime in fresh checkouts/worktrees.

---

## 15. Build Checklist (desktop-parity feature-complete) and Cross-References

Desktop-parity is complete when ALL of the following exist and test:

1. In-process server boot (no sidecar): port selection (stored → 57123 → ephemeral), LAN-bind password gate, env setup-before-import, readiness before window navigation, splash → app navigation, headless `--background` boot, single-instance focus.
2. Dev HMR + dev bundled + packaged UI modes with the exact probe plan and connection-limit rule; packaged protocol with traversal guard, no-store HTML, SPA fallback, runtime-config injection.
3. The full IPC catalog (3.1) with the sender gate and the exact safe-for-remote set; dialog/grant channels local-only; relay MessagePort protocol behind a local-page fence.
4. Window model: geometry restore + clamps, close-to-tray (win/linux) and mac last-window hide, maximized/fullscreen persistence, zoom lock, traffic-light stabilization, per-window init script, deep-link queue flush, renderer recovery budget.
5. Mini Chat: sizing/pinning/session dedupe, URL scheme, runtime-config resolution, renderer header/controls/zoom rules.
6. Host model: schema + sanitizers; boot-outcome computation + renderer validation/view mapping; probe statuses incl. identity gate + wrong-service-before-bearer; relay-capable hosts never surfacing a recovery screen; unreachable-host memory; multi-window targeting.
7. Browser panel: partition, permission/device denial, cert policy (loopback self-signed only), transient dev-server retries, capture + capture-rect with the id membership check, favicon isolation, scoped clear-data, color-scheme emulation via debugger, popup containment, panel zoom.
8. SSH: import, command envelope, ControlMaster vs Windows modes, askpass flow, managed vs external servers, remote install/update/serve, forwards (main/local/remote/dynamic), health gating, token issuance, host-list consistency, monitor/retry/disconnect, quit-time shutdown.
9. Deep links: connect v2 pairing (consent-first), focus, session (single-window), host; queueing before readiness; per-platform registration.
10. Updater: per-platform capability gates (Linux AppImage checks, macOS /Applications gate), feed/channel rules, check normalization (404-no-update), download semantics (cached payloads), install IPC held open with failure rejection + grace, progress events + taskbar, web-client updater route.
11. Tray/menus/notifications: snapshot contract, icon state machine, menu with overflow, click routing, dock badge; notification dedupe + hidden gating + click routing; menu templates and delivery rules (zoom DOM-only, exactly-once append actions); context menu features.
12. Autostart: login items (mac/win with `--background`), Linux XDG entry with the exact fields + boot-time reconcile.
13. OS utilities: open/reveal/open-in-app chains + icon discovery, installed-apps cache, file-read guard chain, markdown save, keep-awake, LAN address, powerMonitor resume, clear-cache.
14. Packaging: bundle externals, native rebuild, platform matrix with signing rules, AppImage architecture enforcement + verifier, update manifest finalization, bundled CLI staging/verification, Electron install self-repair.
15. Security invariants 11.6 hold under adversarial test: a remote page can neither read files, spawn/list apps, open dialogs, nor touch SSH or updates; panel guest id confusion fails closed; a connect link writes nothing before consent; secrets absent from logs/DOM.

### Cross-references for implementers

| Topic | Doc |
|---|---|
| Shell boot screens (chooser/recovery copy), adaptation matrix, first-run flow | #01 |
| OpenCode harness contract | #02 |
| Server routes (`/health`, `/api/version`, `/auth/session`, `/api/client-auth/*`, `/api/openchamber/*`), CORS, CLI/OpenCode lifecycle + binary resolution, release wiring | #03 |
| Sync/state engine, iframe bootstrap handshake, notification store | #04 |
| Chat/session UI, tabs, browser annotation UX, worktrees | #05 |
| Settings document + theme system (themeMode surface semantics) | #14 |
| Relay/tunnel/pairing wire protocols (E2EE tunnel, admission grants, candidates), SSH UX screens | #08 |
| VS Code extension runtime/bridge | #10 |
| Capacitor mobile + update toast | #11 |
| Scheduled-task semantics (counts, wording), permission/question flow | #12 |

### Known gaps in this document

- The renderer's OpenCode-CLI update toast and web update-check route details are summarized only; #03/#14 own them.
- The SSH remote probe shell one-liners are described semantically (8.6), not verbatim; keep the STATUS/GATE semantics, choose your own quoting.
- Electron-version-specific quirks (Electron 43 redirect rejection, mac notification GC behavior, traffic-light re-assertion, AppKit dock-restore snapshot) were pinned to Electron 43; re-validate against your runtime.
- `restoreDesktopRelayRuntime`/`switchRuntimeEndpoint` semantics are given from the desktop perspective; the full runtime-switch machinery is #04.

(End of file.)

