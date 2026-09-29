# OpenChamber — Server & Complete API Reference + CLI
## NotNativeDesktop cleanroom reference, document 03

This document specifies the OpenChamber **web server** (`@openchamber/web`): the Node/Express process that serves the browser UI, provisions and proxies the agent harness (an OpenCode-compatible server), and exposes every OpenChamber-owned API. It also specifies the CLI (`openchamber`) and all environment variables.

Audience: engineers with **zero access to the original repository**. Everything needed to implement the mechanism is inline. `(src: ...)` citations exist for traceability only. Cross-references to sibling documents:

| Document | Owns |
|---|---|
| 02 | The agent-harness (OpenCode) API contract itself: session lifecycle, prompts, event stream payload formats, auth of the harness server. This doc lists only the *proxy* of those routes. |
| 04 | Client-side sync, store projection, and how the UI consumes these routes. |
| 07 | Terminal deep spec (PTY protocol detail, decoration protocol, rendering). This doc lists the terminal routes/WS and constraints. |
| 08 | Relay transport, tunnels protocol depth, UI-auth token/link format depth. This doc lists those routes and invariants. |
| 12 | Scheduled tasks, message queue, session goal — feature depth. This doc lists their storage layout and route contracts. |
| 13 | Preview/dev-server semantics, preview proxy (13 owns `/api/preview/*`). |

Unless stated otherwise:

- All `/api/*` routes require authentication unless explicitly listed as public. The single auth gate and its exceptions are specified in Section 8.
- Base URL (installer default port 3000, bind 127.0.0.1) is written as `http://127.0.0.1:3000`.
- "Data dir" = `OPENCHAMBER_DATA_DIR` or `~/.config/openchamber` (Section 7).
- The **agent harness** is generically called "OpenCode" because the product ships a managed OpenCode server; a NotNativeDesktop implementation substitutes its own harness with the ported contract (02). Anything that launches, configures, or proxies OpenCode carries the **HARNESS PORTS** label.

---

# Table of contents

1. [Process model and server boot sequence](#1-process-model-and-server-boot-sequence)
2. [Middleware chain, in registration order](#2-middleware-chain-in-registration-order)
3. [Static/UI serving, PWA, api-only mode](#3-staticui-serving-pwa-api-only-mode)
4. [OpenCode upstream model (HARNESS PORTS)](#4-opencode-upstream-model-harness-ports)
5. [Complete route table](#5-complete-route-table)
6. [Per-module deep specs](#6-per-module-deep-specs)
7. [Data layout on disk](#7-data-layout-on-disk)
8. [Auth and security posture](#8-auth-and-security-posture)
9. [Environment variable reference](#9-environment-variable-reference)
10. [CLI specification](#10-cli-specification)
11. [Node runtime and PTY dependencies](#11-node-runtime-and-pty-dependencies)
12. [Build checklist](#12-build-checklist)
5.39/5.40 follow Section 5 (event catalog + upstream endpoint map; the end-to-end flows, numbered Section 13, sit after them and before Section 6).
13. [End-to-end flows (numbered)](#13-end-to-end-flows-numbered)
14. [Invariants appendix (success/failure semantics)](#14-invariants-appendix-successfailure-semantics-contract)
15. [CLI examples (canonical)](#15-cli-examples-canonical)
16. [Appendix A — full registration-order recap](#16-appendix-a--full-registration-order-recap)
17. [Appendix B — architecture data-flow map](#17-appendix-b--architecture-data-flow-map)
18. [Appendix C — request lifecycle walkthroughs](#18-appendix-c--request-lifecycle-walkthroughs)
19. [Appendix D — settings.json illustrative skeleton](#19-appendix-d--settingsjson-illustrative-skeleton)
20. [Appendix E — platform notes](#20-appendix-e--platform-notes-windows-wsl-container)
21. [Appendix F — supporting runtime modules](#21-appendix-f--supporting-runtime-modules)
22. [Appendix G — gaps and decisions](#22-appendix-g--gaps-caveats-and-what-the-reimplementation-must-decide)
23. [Appendix H — CLI control-plane deep contracts](#23-appendix-h--cli-control-plane-deep-contracts)

---

# 1. Process model and server boot sequence

## 1.1 Process model

- Single Node.js process (ESM, `"type": "module"`). Package `@openchamber/web`, binary `bin/cli.js` exposed as the `openchamber` command (src: `packages/web/package.json`).
- Express **5** (`express@^5.1.0`) over `http.createServer(app)` (not https — TLS is expected to terminate at a tunnel or reverse proxy; secure cookie behavior keys off `x-forwarded-proto`, src: `packages/web/server/index.js:1722`).
- Two launch modes from the CLI:
  - **daemon (default)**: CLI spawns the server as a detached child (`spawn(runtimeBin, [server/index.js, '--port', N, '--host', H], { detached: true, stdio: ['ignore', logFd, logFd, 'ipc'] })`); the child reports readiness over Node IPC with message `{ type: 'openchamber:ready', port }` (src: `packages/web/bin/lib/commands-serve.js:271-340`, src: `packages/web/server/lib/opencode/server-startup-runtime.js` sends `{ type: 'openchamber:ready', port: activePort }` over `process.send`). Logs → `<data-dir>/logs/openchamber-<port>.log`.
  - **foreground (`--foreground` / `--no-daemon`)**: the CLI imports the server module in-process and blocks forever; required for systemd `Type=simple`. Pid/instance files are still written so `status`/`stop`/`restart` discover it. `--json` is forbidden with `--foreground` (exit 2) (src: `packages/web/bin/lib/commands-serve.js:149-152`).
- Everything OpenChamber owns hangs off one data dir (Section 7). HMR-persistent state (desktop dev mode) survives Vite reloads via a `globalThis.__openchamberHmrState` bag holding the OpenCode child process/port/auth password; in production this is just normal module state (src: `packages/web/server/index.js:539-627`).
- Node version floor: **Node 22+** (documented prerequisite, src: `packages/web/README.md:19`). Unix installs run under **Bun** when available; the CLI chooses `bun` as the server runtime if `bun --version` succeeds, else `node` (src: `packages/web/bin/lib/commands-serve.js:104-105`, `cli.js:154-156`).
- Startup network tuning: every Node process entrypoint calls `net.setDefaultAutoSelectFamilyAttemptTimeout(5_000)` (happy-eyeballs per-attempt cap, fixes `fetch failed` to distant provider endpoints) (src: `packages/web/server/lib/network-defaults.js`).
- Constants (src: `packages/web/server/index.js:128-145`):

| Constant | Value |
|---|---|
| `DEFAULT_PORT` | 3000 |
| `HEALTH_CHECK_INTERVAL` | 15000 ms |
| `SHUTDOWN_TIMEOUT` | 10000 ms |
| `MODELS_DEV_API_URL` | `https://models.dev/api.json` |
| `MODELS_METADATA_CACHE_TTL` | 5 min |
| `CLIENT_RELOAD_DELAY_MS` | 800 ms |
| `OPEN_CODE_READY_GRACE_MS` | 12000 ms |
| `LONG_REQUEST_TIMEOUT_MS` | 4 min (generic proxied request deadline) |
| `TUNNEL_BOOTSTRAP_TTL_DEFAULT/MIN/MAX` | 30 min / 1 min / 24 h |
| `TUNNEL_SESSION_TTL_DEFAULT/MIN/MAX` | 8 h / 5 min / 30 days |

## 1.2 Server boot sequence (numbered)

`main(options)` in `server/index.js:1511` — options surface: `port`, `host`, `uiPassword`, `apiOnly`, `tryCfTunnel`, `tunnelProvider/tunnelMode/tunnelConfigPath/tunnelToken/tunnelHostname`, `attachSignals`, `exitOnShutdown`, `onTunnelReady`, `onDesktopNotification`, `getIsWindowFocused`, `getDesktopRuntimeConfig`, `desktopUpdater`. The server module itself parses `--port/--p, --host, --ui-password, --api-only, --try-cf-tunnel, --tunnel-* [, --tunnel <configPath>]` when run as a CLI process (src: `packages/web/server/lib/opencode/cli-options.js`, env fallbacks: `OPENCHAMBER_UI_PASSWORD`/`OPENCODE_UI_PASSWORD`, `OPENCHAMBER_API_ONLY`, `OPENCHAMBER_TUNNEL_*`).

1. `applyConnectAttemptTimeout()` (happy-eyeballs cap, above).
2. Read `OPENCHAMBER_VERSION` from `package.json` (fallback `'unknown'`).
3. Build cleanup/normalization runtimes: settings normalization (path normalization incl. `~` expansion, project list sanitization, signal catalogs, model refs), tunnel managed-remote config store, settings helpers (PWA name/orientation normalization, request sanitization).
4. **LAN unauthenticated-refusal gate**: if the effective bind host is loopback (`127.*`, `::1`, `localhost`) refuse to start **unless** a UI password is set — throw `getUnauthenticatedLanErrorMessage(host)`. Escape hatch: `OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN=true` (src: `packages/web/server/lib/security/bind-host.js`).
5. One-time migration of user folders (`projects/`, `themes/`, `speech-models/`) from the legacy root (`~/.config/openchamber`) into the configured data dir — copy (never move), only when the target does not exist and source does; a failed copy removes the partial copy and continues (src: `packages/web/server/lib/data-dir-migration.js`).
6. Create runtimes for projects config, project context, agent memory, theme (custom theme JSON, 512 KiB limit), notification templates (fetches "free zen models" from OpenCode Zen with a 5-min cache), push (VAPID), APNs, and the TTS capability probe (macOS `say -v "?"` runs concurrently and never blocks boot).
7. Create the Express app. `app.set('trust proxy', true)`.
8. Register, in order (see Section 2 for the full chain): `X-Robots-Tag` middleware, `/robots.txt`, CORS allow-list middleware (packaged/dev origins, preflight 204), `compression` with filter, then **base routes** (`bootstrapRuntime.setupBaseRoutes`):
   1. Create UI auth controller (`createUiAuth`) — cookie sessions when `--ui-password` set, otherwise pass-through issuance.
   2. `registerServerStatusRoutes` (health/version/system/system info/dev shutdown, free-port, probe-url).
   3. `registerCommonRequestMiddleware` (per-prefix JSON body parsing — see 2.6).
   4. Agent-tool route registration (`POST /api/openchamber/agent-tool`).
   5. `registerAuthAndAccessRoutes` (auth/session, url-token, passkeys, auth reset, client devices + pairing, `/connect`, probe-url, and the **global `/api` auth gate** at the end).
   6. `registerTtsRoutes` (voice token, tts speak/status, say-speak, text summarize, stt transcribe).
   7. `registerNotificationRoutes` (push subscribe/unsubscribe, APNs tokens, visibility, notification SSE stream, session-activity/snapshot/status/attention, view/unview/message-sent, auto-accept mirror).
   8. `registerOpenChamberRoutes` (update-check, update-install, models-metadata, zen models).
9. Attach the **realtime proxy** (`/api/openchamber/realtime-proxy/sse|ws`) — desktop shell forwarding bridge (Section 5.16).
10. Wire tunnels: `tunnelWiringRuntime.initialize(app, port)` registers `/api/openchamber/tunnel/*` routes and creates the tunnel service; a `tunnelRuntimeContext` holder keeps active port/tunnel URL lazily resolvable by `/api/system/info`.
11. Create + register the **private relay service** (`/api/openchamber/relay/status|enable|disable`), with a per-machine host claim file `<data-dir>/relay-host.lock`; reconcile timer every 60 s (unref'd) re-evaluates relay demand.
12. Register browser control routes (`POST /api/browser-control/claim`, `POST /api/browser-control/result`).
13. Create the dev-server scanner (lsof/netstat//proc — Section 6.22) and the dev-tunnel runtime (WS upgrade handler for `/api/dev-tunnel`; feature routes filtering).
14. `featureRoutesRuntime.registerRoutes(app, {...})` — all feature modules listed in Section 5 (git, fs, projects, scheduled tasks, openchamber sessions, openchamber control, message queue, permission-auto-accept, skills, plugins, config entities, providers, MCP OAuth pending store, icons, quota, small-model, walkthrough, goals, session folders, session knowledge, project context, project setup, agent memory, magic prompts, dev-servers, markdown-image-grants).
15. Startup pipeline (src: `packages/web/server/lib/opencode/startup-pipeline-runtime.js`):
    1. Create terminal runtime (PTY sessions + `/api/terminal/*` + `/api/terminal/ws` upgrade).
    2. Create dictation runtime (WS `/api/dictation/ws` + status/models routes).
    3. Create message-stream WS runtime (`/api/global/event/ws`, `/api/event/ws` upgrades).
    4. `setupProxy(app)` — the OpenCode proxy (Section 4). Registered **after** all OpenChamber feature routes so their routes win.
    5. Static routes: if `apiOnly` → `registerApiOnlyFallbackRoutes` (Section 3.3); else `registerStaticRoutes` (dist assets + `manifest.webmanifest` + SPA fallback).
16. Bind listener: `server.listen(port, bindHost)`; effective port (0 → auto-assigned, reported via `openchamber:ready` IPC and returned). Optional startup tunnel request (CLI/env `OPENCHAMBER_TUNNEL_*` or `--try-cf-tunnel` → quick Cloudflare tunnel) is started after listening. `tunnelRuntimeContext.setActivePort(activePort)`.
17. `scheduleOpenCodeApiDetection()` and `bootstrapOpenCodeAtStartup()`:
    - Resolve the harness (**HARNESS PORTS**): internal resolution order — `OPENCODE_BINARY` env, settings `opencodeBinary`, PATH → if not found and on Windows, WSL fallback (launch via `wsl.exe`). UI password → generate a random auth password for the managed OpenCode process (Bearer auth between OpenChamber and OpenCode).
    - If `OPENCODE_SKIP_START=true` or `OPENCHAMBER_SKIP_OPENCODE_START=true` → skip spawn; attach to external host per `OPENCODE_HOST`/`OPENCODE_PORT` (Section 4.1).
    - Else spawn managed OpenCode (landscape: kill anything on the target OpenCode port first with `lsof` SIGTERM/SIGKILL; wait for port release; spawn `opencode serve` with generated env incl. helper agent tools via a registered OpenCode plugin; readiness poll).
    - Start OpenCode health monitoring loop every 15 s; on failure restart the managed process (new port possible).
    - Start the **global event watcher** which attaches to OpenCode's SSE event stream and feeds the shared hub (Section 4.4).
    - Warm up MRU directories (settings `lastDirectory` + projects sorted by `lastOpenedAt`) against OpenCode so the first UI request does not pay cold init (src: `index.js:1197-1212`).
18. `scheduledTasksRuntime.start()` (loads schedules, arms crons).
19. `relayService.reconcile()` (relay on/off by demand) + the 60 s reconcile interval.
20. Signal handlers (`SIGINT`/`SIGTERM`/`SIGQUIT` → `gracefulShutdown`). Graceful shutdown stops: event watchers, session uploads, terminal sessions (SIGTERM then destroy), dictation worker, WS servers, tunnel process + revokes tunnel artifacts, health check interval; stops the managed OpenCode process unless external (`OPENCODE_SKIP_START`), waits `SHUTDOWN_TIMEOUT` 10 s, closes Express server (src: `packages/web/server/lib/opencode/shutdown-runtime.js`).

## 1.3 Health monitoring of OpenCode (HARNESS PORTS)

- Poll `GET {openCodeBase}/global/health` every 15 s with the OpenCode auth headers.
- `isOpenCodeReady` flips false when health fails or there are no sessions/agents present; during a restart the flag is set explicitly.
- If a health check fails while OpenCode should be running, the lifecycle restarts the managed process (kill port → wait port release → respawn). A restart may move OpenCode to a **new port**; on restart completion:
  - message-stream WS/SSE upstream readers are rebound to the new port (`rebindUpstream()`),
  - sessions that had busy in-flight work are interrupted and a notification `opencode-restart-interrupted` is broadcast ("Chat interrupted... Send a message to continue", src: `index.js:1219-1245`).
- External OpenCode (`OPENCODE_SKIP_START=true`) is never restarted or killed by OpenChamber; `/api/openchamber/...` restart/status surfaces report it accordingly (`managed=false`; pid/port structurally withheld so a desktop-side port killer cannot kill a foreign server, src: `index.js:2066-2079`).

---

# 2. Middleware chain, in registration order

Exact registration order of the Express app (src: `packages/web/server/index.js:1674-2110` and the runts it delegates to). Order matters for auth/parse behavior.

1. `app.set('trust proxy', true)` — `req.ip`/`req.hostname` honor `X-Forwarded-For/Host/Proto`.
2. **`X-Robots-Tag: noindex, nofollow`** on every response (src: `index.js:1688-1691`). Rationale: the app shell loads before the password prompt, so password-protected instances must not be indexed.
3. **`GET /robots.txt`** → `User-agent: *\nDisallow: /\n` (src: `index.js:1692-1694`).
4. **CORS middleware** (src: `index.js:1695-1713`). Applies **only** to origins in:
   - packaged client origins: `openchamber-ui://app`, `capacitor://localhost`, `http://localhost`, `https://localhost`;
   - local dev origins matching `^https?://(localhost|127.0.0.1):\d+$`.
   
   For these it emits: `Access-Control-Allow-Origin: <origin>` (reflected), `Access-Control-Allow-Credentials: true`, `Access-Control-Allow-Methods: GET,POST,PUT,PATCH,DELETE,OPTIONS`, `Access-Control-Allow-Headers: Content-Type,Authorization,Accept,X-Requested-With,Cache-Control,X-OpenCode-Directory,X-OpenCode-Directory-Encoding,Ngrok-Skip-Browser-Warning,X-OpenChamber-Surface`, `Access-Control-Expose-Headers: x-next-cursor`, `Vary: Origin`. `OPTIONS` → **204 and stop**. All other origins get CORS headers only if the origin check middleware elsewhere (WS origin policy, Section 8.6) allows them; the genericpolicy for same-origin browsing is "no CORS headers" (same-origin pages need none).
5. **Compression** (`compression@1`, threshold 1024 bytes) with custom filter `shouldSkipCompression` (src: `index.js:147-197, 1714-1720`):
   - Always skip when `OPENCHAMBER_RUNTIME === 'desktop'` (or `OPENCHAMBER_COMPRESS_API=false` / skip flags — full policy in 2.8).
   - Skip when the request `Accept` includes `text/event-stream`.
   - Skip by path (deterministic fallback for clients that omit `Accept`: the filter runs before route handlers, so `Content-Type` is not yet set): `/api/event`, `/api/global/event`, `/api/notifications/stream`, `/api/openchamber/events`, `/api/openchamber/realtime-proxy/sse`.
6. **Base routes** (Section 1.2 step 8) — most importantly `registerCommonRequestMiddleware` JSON parsing (2.6) and `registerAuthAndAccessRoutes` which ends with the **global `/api` auth gate** (2.5). Note the gate runs *before* feature routes are registered — because Express executes middleware in registration order, later-registered feature routes are all behind the gate; the gate's own `next()` falls through into routes registered afterward.
7. Realtime proxy GET route (auth + origin gated; listed as public only through UI auth: it is behind `ensureSessionToken`, not the `/api` gate).
8. Tunnel routes, relay routes, browser-control routes, dev-tunnel WS, feature routes — all behind the `/api` gate (they were registered after it).
9. OpenCode proxy (Section 4) — readiness hold, worktree bootstrap hold, session-list sanitizer, SSE forwards, then `http-proxy-middleware` catch-all `app.use('/api', apiProxy)`.
10. Static serving + SPA fallback (Section 3) — last registered, so it catches everything not matched above (non-`/api` GETs serve `index.html`).

### 2.5 The global `/api` auth gate

`registerAuthAndAccessRoutes` ends with (src: `packages/web/server/lib/opencode/core-routes.js:986-992`):

```js
app.use('/api', async (req, res, next) => { await requireApiAuth(req, res, next); });
```

where `requireApiAuth` classifies the request first (src: `core-routes.js:592-598`):

- Request scope is `tunnel` (request host equals the active tunnel hostname) or `unknown-public` (no active tunnel host match, non-local request) → **tunnel session cookie required** (`requireTunnelSession`; 401 `{ error:'Tunnel authentication required', locked:true, tunnelLocked:true }`). Password login is disabled over tunnel scope by design — the tunnel bootstrap link is the only entry (Section 8.5).
- Otherwise → **UI auth** (`uiAuthController.requireAuth`): valid `oc_ui_session` JWT cookie, OR a valid remote-client bearer token `Authorization: Bearer oc_client_...`, OR a one-time URL token (`?oc_url_token=oc_url_...`) for specific read paths (Section 8.4). 401 body: `{ error:'UI authentication required', locked:true }` (JSON if `Accept` includes JSON or path starts `/api`, else plain text "Authentication required").

Because this middleware was registered before the feature routes yet after the system/auth/public routes (Section 1.2 ordering), the effective public set (correct, enumeration-complete) is:

- `/health`, `/api/version`, `/api/system/info`, `/api/system/dev-shutdown`(origin-checked dev only), `/api/system/shutdown` (has its own shutdown auth), `/api/system/free-port`, `/api/system/probe-url` (has own requireApiAuth), `/robots.txt` — public.
- All `/auth/*` endpoints (session status/create, url-token, passkey flows) — public by design (login).
- `/connect` — public (one-time tunnel bootstrap exchange).
- `/api/client-auth/pairing/redeem` — public, rate-limited (pairing redeem-before-auth), everything else `/api/*` requires auth.
- `/mcp/oauth/callback`, `/linear/oauth/callback` — non-`/api` and registered without gate.
- `/api/openchamber/agent-tool` — behind the gate but re-checks with its own `authorize` (UI session or a dedicated agent token?) — specifics: it authorizes "UI-session-shaped credentials" (invariant: the plugin calls with the server-issued agent tool token minted by `agentToolRuntime` during managed OpenCode env preparation; the route validates via the UI auth session/"ensureSessionToken"-equivalent path) (src: `packages/web/server/lib/agent-tool/runtime.js:335`; outer gate + inner `authorize(req)`).

### 2.6 JSON body parsing policy (critical invariant)

There is **no global JSON body parser**. `registerCommonRequestMiddleware` (src: `core-routes.js:1040-1095`) parses per path-prefix so the OpenCode proxy keeps an unread request stream where needed:

| Path prefix | Body limit |
|---|---|
| `/api/behavior` | 1 MB (rejects early with 413 `{error:'Content exceeds maximum size of 1048576 bytes'}` when `Content-Length` exceeds it) |
| `/api/config/agents`, `/api/config/commands`, `/api/config/mcp`, `/api/config/snippets`, `/api/config/settings`, `/api/config/skills`, `/api/config/plugins`, `/api/projects`, `/api/fs`, `/api/git`, `/api/magic-prompts`, `/api/prompts`, `/api/terminal`, `/api/opencode`, `/api/push`, `/api/notifications`, `/api/permission-auto-accept`, `/api/message-queue`, `/api/provider`, `/api/session-folders`, `/api/small-model`, `/api/walkthrough`, `/api/goals`, `/api/text`, `/api/voice`, `/api/tts`, `/api/openchamber/tunnel` | 50 MB (`express.json({ limit: '50mb' })` — this is why message-queue attachments, scheduled task payloads and skills install bodies can be large) |
| other `/api/*` | **not parsed here** (routes that need bodies attach `express.json` per route; see per-module specs — this is an invariant: "A route that forgets this sees `req.body` as undefined") |
| non-`/api` requests | 50 MB JSON + `express.urlencoded({ extended: true, limit: '50mb' })` globally after the JSON middleware |

Verbose request logging via `OPENCHAMBER_VERBOSE_REQUEST_LOGS=true` prints `<ISO date> - <METHOD> <path>` for every request (src: `core-routes.js:1089-1094`).

### 2.7 Request deadline middleware (proxy)

`applyProxyResponseDeadline` (src: `packages/web/server/lib/opencode/proxy.js:442-459`) is registered as `app.use('/api', ...)`: every OpenCode-proxied request gets a 4-minute deadline (`PROXY_REQUEST_TIMEOUT_MS = LONG_REQUEST_TIMEOUT_MS`); on expiry the client gets 504 `{ error: 'OpenCode upstream timed out' }` and the socket is destroyed after finish. Exception: **interactive OAuth** — `POST /api/provider/:providerID/oauth/callback` and `POST /api/mcp/:name/auth/authenticate` get **15 min** instead (provider sign-in latency; GitHub device codes ~15 min) (src: `proxy.js:419-431, 984-988`).

### 2.8 Compression policy compile summary

`shouldSkipApiCompression()` (src: `index.js:226-231`):

| Condition | Result |
|---|---|
| `OPENCHAMBER_SKIP_API_COMPRESSION` = `true`/`1` | skip `/api/*` compression |
| `OPENCHAMBER_COMPRESS_API` = `true` | enable (overridden only by SKIP flag) |
| `OPENCHAMBER_COMPRESS_API` = `false` | disable |
| `OPENCHAMBER_RUNTIME === 'desktop'` (default) | disable |
| otherwise | enable |

`OPENCHAMBER_RUNTIME === 'desktop'` short-circuits **all** compression (not just `/api`). SSE paths and `text/event-stream` Accept headers always skip. Threshold 1024 bytes (responses below that are never compressed anyway).

---

# 3. Static/UI serving, PWA, api-only mode

## 3.1 Built UI assets

- Dist directory: `OPENCHAMBER_DIST_DIR` env override, else `<repo>/dist` (`server/../../dist` resolved from the server module dir) (src: `packages/web/server/lib/opencode/static-routes-runtime.js:18-24`).
- If dist exists: `express.static(distPath)` registered **last** (after the OpenCode proxy). Special header rule: `**/sw.js` service worker gets `Cache-Control: no-store` (iOS sensitivity) (src: `static-routes-runtime.js:29-38`).
- The Vite build produces three HTML entries (src: `packages/web/vite.config.ts:134-137`):
  - `index.html` → main SPA (served at `/` and every SPA fallback path).
  - `mobile.html` → the hosted-mobile surface (PWA/web shell for phones; the Capacitor shell bundles this same surface and talks to a remote server).
  - `mini-chat.html` → a minimal chat entry point (lightweight panel surface for quick-view usage).
  - All three are regular static files under `/`; direct hits are served by `express.static` before the fallback regex sees them.
- `GET /manifest.webmanifest` is generated dynamically (src: `packages/web/server/lib/opencode/pwa-manifest-routes.js`). Response: `application/manifest+json`, `Cache-Control: no-store, must-revalidate`. Fields:
  - `name`/`short_name`: settings `pwaAppName` (query overrides `pwa_name`/`app_name`/`appName` win; default `OpenChamber`; short_name truncated at 30).
  - `orientation` from settings `pwaOrientation` (query `orientation`): `portrait` → `portrait-primary`, `landscape` → `landscape-primary`, else omitted.
  - `description: "Web interface companion for OpenCode AI coding agent"`, `id: "/"`, `start_url: "/"`, `scope: "/"`, `display: "standalone"`, `display_override: ["window-controls-overlay"]`, `background_color: "#151313"`, `theme_color: "#edb449"`.
  - `icons`: `/pwa-192.png`, `/pwa-512.png`, `/pwa-maskable-192.png`, `/pwa-maskable-512.png` (purpose `any maskable` on maskable ones), `/apple-touch-icon-180x180.png`, `/apple-touch-icon-152x152.png`, `/favicon-32.png`, `/favicon-16.png`.
  - `shortcuts`: first `Appearance Settings` (`/?settings=appearance`), then up to 3 recent-session shortcuts — directory-scoped session list from OpenCode (`GET /session?directory=...` upstream; Windows path separators replaced; 2.5 s timeout, 5 s cache per directory) — with `url: /?session=<id>`, `short_name` truncated at 32 (src: `pwa-manifest-routes.js:25-175`).
- `categories: ["developer","tools","productivity"]`, `lang: "en"`.

## 3.2 SPA fallback

```js
app.get(/^(?!\/api|\/linear|.*\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map)).*$/, ... → sendFile(distPath/index.html))
```
(src: `static-routes-runtime.js:50-52`). i.e. every GET that is not `/api*`, not `/linear*` (Linear OAuth callback lives there), and not a static-asset extension serves the SPA (client-side routing incl. `/?session=...` and `/?settings=...` deep links handled by the UI).

If dist is missing (not built): the same regex answers `404 "Static files not found. Please build the application first."`.

## 3.3 `--api-only` mode

Triggered by `--api-only` or `OPENCHAMBER_API_ONLY=true` (src: `index.js:1623`). API routes register normally; browser assets are never served. Fallback (src: `static-routes-runtime.js:62-259`):

```js
app.get(/^(?!\/api|\/auth|\/health|\/linear|.*\.(js|css|...)).*$/, ...)
```
answers `200` with content negotiation:
- `text/html`: a self-contained page: logo, "OpenChamber is running in headless mode", "This server is ready. Open it from the OpenChamber desktop or mobile app", and a copy-able code block with `openchamber connect-url --help`.
- `application/json`: `{ ok: true, mode: 'api-only', message: 'OpenChamber is running in API-only mode' }`.
- default: text `OpenChamber is running in API-only mode`.

Note it is **200**, not 404 — the instance is healthy, only headless.

---

# 4. OpenCode upstream model (HARNESS PORTS)

This section is the wiring contract. The OpenCode API surface itself (paths, payloads, event shapes) is owned by **document 02**; here we specify how OpenChamber selects, launches, addresses, authenticates, and proxies that upstream.

## 4.1 Upstream selection (launch vs attach)

Env decisions made at boot (src: `packages/web/server/lib/opencode/env-config.js`):

| Env | Meaning |
|---|---|
| `OPENCODE_PORT` (aliases `OPENCHAMBER_OPENCODE_PORT`, `OPENCHAMBER_INTERNAL_PORT`) | External OpenCode port → implies "attach, don't launch" |
| `OPENCODE_HOST` | Full base URL (`http(s)://host:port`, no path/query/hash; must include explicit port) → **overrides** `OPENCODE_PORT` |
| `OPENCODE_SKIP_START` = `true` (or `OPENCHAMBER_SKIP_OPENCODE_START=true`) | Skip launching; use external |
| `OPENCHAMBER_OPENCODE_HOSTNAME` | Bind hostname for a **managed** OpenCode (default `127.0.0.1`; validated: IPv4/IPv6/hostname syntax; invalid → logged warning + loopback fallback) |
| `OPENCODE_BINARY` | Explicit harness binary path; invalid → warning, fall back to PATH |
| `OPENCODE_CONFIG_DIR` | OpenCode config dir passed through to the harness |
| `OPENCODE_CONFIG_CONTENT` | Extra config JSON content the harness may accept; merged with settings-injected content |

- **Managed**: spawn `opencode serve` (or the custom binary) on a chosen free port. The port is dynamic; OpenChamber kills any previous occupant (`lsof -t -iTCP:<port> -sTCP:LISTEN`, SIGTERM then SIGKILL after 1.2 s — unix only, src: `core-routes.js:166-205` equivalent in lifecycle) and waits for release. Auth: a random password is generated and handed to the harness; every request to it carries `Authorization: Bearer <openCodeAuthPassword>` (`getOpenCodeAuthHeaders()`). If the user supplied `OPENCODE_SERVER_PASSWORD`-style credentials (HMR `ensureUserProvidedOpenCodePassword`) that password is used instead of generating (src: `index.js:541-618`).
- **External attach**: base URL from env; auth headers still sent — external harnesses that need a bearer supply it via `OPENCODE_SERVER_PASSWORD`/their own means; connection security is assumed or upgraded by the harness. `isExternalOpenCode=true` ⇒ never killed, never restarted, no agent-tool injection.
- **WSL fallback (Windows)**: if no `opencode` binary found on PATH and a WSL distro has one, spawn through `wsl.exe` (`useWslForOpencode=true`); snapshot exposed on health payload (`opencodeViaWsl`, `opencodeWslBinary`, `opencodeWslPath`, `opencodeWslDistro`).
- **Login shell env snapshot**: before spawning, a login shell (`$SHELL -l -c env` / `getconf`-based) is executed and its env (`PATH` etc.) merged so provider tokens and tool PATHs behave as in the user's shell (src: `opencode/env-runtime.js`, applied via `applyLoginShellEnvSnapshot`).
- **Managed OpenCode env additions** (src: `index.js:1246-1262`): the agent-tool plugin env (`prepareManagedOpenCodeEnv`) injects OpenChamber-native tools (`openchamber` control tool, web tool) into the harness plugin chain when `agentControlToolEnabled`/`agentWebToolEnabled` (default on) / `agentMemoryToolEnabled` (default off) are on in settings. `optimizeSystemPrompt=true` adds a managed system-prompt optimizer config (`systemPromptRuntime.prepareManagedOpenCodeEnv`). None of these apply for external OpenCode.

## 4.2 Addressing and API prefix

- Base URL helper `buildOpenCodeUrl(path, directoryQuery)` → `http://127.0.0.1:<port>/api/prefix...` style; the prefix detection tries a few known OpenCode API prefixes and records `openCodeApiPrefix`; env-configured prefixes (`OPENCODE_API_PREFIX`/`OPENCHAMBER_API_PREFIX`) are **ignored with a warning** — "API runs at root" (src: `index.js:700-706`). Health payload always reports `openCodeApiPrefix: ''`, `openCodeApiPrefixDetected: true` (root).
- Readiness path: `waitForReady` polls the harness port gateway until the API answers; readiness deadline `OPEN_CODE_READY_GRACE_MS` 12 s.

## 4.3 Auth headers to upstream (HARNESS PORTS)

`getOpenCodeAuthHeaders()` returns `{ Authorization: 'Bearer <openCodeAuthPassword>' }` when the managed harness requires it; empty when no password (external public harness). These headers are attached to (a) every proxy request, (b) every server-side fetch to OpenCode (`buildOpenCodeUrl(...)` + headers), and (c) SSE producers' fetches. The proxy explicitly **strips the client's `Authorization` header** so OpenChamber UI tokens never leak upstream (Section 4.4; src: `server/proxy-headers.js`).

## 4.4 The `/api` proxy pipeline (src: `packages/web/server/lib/opencode/proxy.js`)

Registered route pipeline on `/api` (in order; all mounted before the OpenCode proxy catch-all):

1. **Prefix ensure**: `app.use('/api', ensureOpenCodeApiPrefix; next)`.
2. **Readiness hold** (src: `proxy.js:726-779`): skip-listed paths (below) pass; otherwise, while OpenCode is starting/restarting (`isStillWaiting`), the middleware *holds* the request, polling every 75 ms up to `min(OPEN_CODE_READY_GRACE_MS=12s, 6s)`, letting warm-up requests simply succeed instead of 503-looping. On timeout → `503 { error: 'OpenCode is restarting', restarting: true }`. Client disconnect aborts silently. Held-scoped per route class: `session-messages` (`/session/:id/message*`), `session`, `events` (`/event`, `/global/event`), `other`. Skip-listed (pass immediately, never held): `/api/themes/custom*`, `/api/push*`, `/api/config/agents*`, `/api/config/opencode-resolution*`, `/api/config/settings*`, `/api/config/skills*`, `/api/config/reload`, `/api/health`. (These are OpenChamber-owned or harness-read-only paths that must answer while OpenCode boots.)
3. **Worktree bootstrap hold** (src: `proxy.js:784-809`): for requests carrying `directory` (`?directory=` query or `x-opencode-directory` header), hold until the directory's worktree bootstrap status is `ready` / `git-ready` / `setup-ready` (poll every 75 ms up to `WORKTREE_READY_TIMEOUT_MS` 5 min), so a directory-scoped read cannot initialize OpenCode's per-directory project state before the bootstrap finishes; `failed` → `503 { error }` with the bootstrap error; timeout → `503 { error: 'Timed out waiting for worktree checkout' }`. `x-opencode-directory` with the companion header `x-opencode-directory-encoding: uri` is URL-decoded and the encoding header removed (src: `proxy.js:132-149`).
4. **Windows cross-directory session merge** (src: `proxy.js:812-889`, only `process.platform === 'win32'`): `GET /api/session` *without* `directory=` is answered by merging the global `/session` list plus `/session?directory=<projectDir>` lists for each configured project (path-separator variants tried: raw, `/`→`\`, `\`→`/`), deduped by `id`, sorted by `time_updated` desc; per-request 10 s timeouts; if the global list failed and zero project reads succeeded → `504 { error: 'OpenCode session list timed out' }`.
5. **`GET /api/session` and `GET /api/experimental/session`** (src: `proxy.js:891-900`): fetched via undici with `accept-encoding: identity`, then **sanitized**: only the field allowlist is returned per session item — `id, slug, projectID, workspaceID, directory, path, parentID, title, agent, model, version, time, cost, tokens, share, metadata, project` — with `summary.diffs` removed (can be huge) and `revert` trimmed to `{ messageID, partID }` (src: `proxy.js:213-274`). Non-JSON or unparseable upstream payload passes through verbatim. This keeps the session list payload bounded for a phone client.
6. **SSE forwards** (src: `proxy.js:461-617`): `GET /api/global/event` and `GET /api/event` are forwarded with a hand-rolled streaming fetch (not http-proxy):
   - headers: collected from client (minus request-filter list), OpenCode auth injected, `Accept: text/event-stream`, `Cache-Control: no-cache` defaults; `x-opencode-directory(-encoding)` normalized before sending;
   - response: upstream status; connection headers set (Content-Type passthrough, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`), `socket.setNoDelay(true)`; sequential writes ordered through a write queue with backpressure (`res.write` false → wait for `drain`);
   - **heartbeat** `:heartbeat\n\n` every `SSE_HEARTBEAT_INTERVAL_MS` (default 20 s), emitted only at an SSE event boundary (a trailing-4 KB byte tracker ensures we never split an event);
   - **upstream stall watchdog**: `DEFAULT_UPSTREAM_STALL_TIMEOUT_MS = 20_000` when ≤1 concurrent session, `UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS = 60_000` when multiple active sessions; no bytes within the window → abort upstream and **end the client stream cleanly** (not a 503);
   - upstream/emit errors before headers → `503 { error: 'OpenCode service unavailable' }`.
7. **Response deadline** (2.7) then:
8. **`POST /api/provider/:providerID/oauth/callback`** and **`POST /api/mcp/:name/auth/authenticate`** forwarded through the same proxy mechanics with the 15-minute `interactiveOAuthProxy` (Section 2.7).
9. **Catch-all `app.use('/api', apiProxy)`** via `http-proxy-middleware` (src: `proxy.js:910-989`):
   - `target`/`router` resolved per request from the current OpenCode port/base (`resolveProxyTarget`); fallback `http://127.0.0.1:3902` when unknown;
   - `changeOrigin: true`, `pathRewrite: { '^/api': '' }` (OpenCode serves its API at root; OpenChamber namespaces it under `/api`);
   - per-scheme pooled http/https agent: `keepAlive: true`, `keepAliveMsecs: 30_000`, `maxSockets: Infinity`, `maxFreeSockets: 256`, `timeout: 60_000` (idle socket eviction; prevents ephemeral-port exhaustion under `agent:false`'s per-request churn) (src: `proxy.js:18-106`);
   - `proxyReq`: inject upstream `Authorization`; normalize `x-opencode-directory(-encoding)`; force `accept-encoding: identity` on upstream; replay the parsed body (`express.json` already consumed the stream — the middleware re-serializes `req.body` per content-type and re-sets `content-length`) (src: `proxy.js:921-946`);
   - `proxyRes`: strip hop-by-hop and dangerous response headers via `shouldForwardProxyResponseHeader` (src: `server/proxy-headers.js` — request-side filtered set: `authorization, host, connection, content-length, transfer-encoding, keep-alive, te, trailer, upgrade, accept-encoding`; response-side: `connection, content-length, transfer-encoding, keep-alive, te, trailer, upgrade, www-authenticate, content-encoding`);
   - `error`: timeout → 504 `OpenCode upstream timed out`, else 503 `OpenCode service unavailable`.
   - A `?directory=` canonicalization middleware (registered just before deadlines) rewrites `directory` values through a cached `fs.realpath` so symlinked project paths resolve to the same upstream value OpenCode stores (src: `proxy.js:971-981`, `108-130`, TTL-capable realpath cache, `fallbackOnError: true`).

**Event delivery into OpenChamber internals (HARNESS PORTS)**: a server-side "global watcher" (src: `packages/web/server/lib/opencode/watcher.js`) subscribes to the upstream grid (`global/event` SSE behind the same auth) and demultiplexes into the shared **global message stream hub** (src: `server/lib/event-stream/global-hub.js`). Subscribers:
- notification trigger (push/desktop/…), session info cache,
- **session runtime** (activity/attention state powering `/api/sessions/*` + cross-tab broadcast, owner: doc 04/notifications),
- session assist (queued UI assists), session-goal, context-obligatory, linear session status — all `processPayload(payload, directory)` per event,
- message queue dispatch loop, permission-auto-accept processor, walkthrough digest etc.
Upstream enrichment: each event envelope carries `{ directory }` when the hub could derive it. Forwarded events are re-broadcast to UI clients as `openchamber:session-status` / `openchamber:session-activity` synthetic events via the OpenChamber event stream (src: `index.js:955-1006`).

**OpenChamber event streams to UI clients** (full inventory; these are the OpenChamber-owned channels, NOT the OpenCode proxy channels):

| Channel | Transport | Purpose |
|---|---|---|
| `/api/global/event` | SSE (proxied upstream) | Global OpenCode event stream (02 owns payload format) |
| `/api/event` | SSE (proxied upstream, directory-scoped) | Per-directory OpenCode events |
| `/api/event/ws` and `/api/global/event/ws` | **WebSocket bridge** | Same payloads over WS: JSON frames `{ type:'event', payload, eventId?, directory? }`; heartbeat every 15 s; server pings clients; slow clients (buffered > 16 MB) get close 1013 'Message stream client is too slow', one-shot `backpressure` warning frame at > 12 MB buffered (src: `event-stream/protocol.js`); `lastEventId` query resumes; directory sockets rebuild on upstream restart with `Last-Event-ID` |
| `/api/notifications/stream` | SSE | OpenChamber notification/UI events (`openchamber:notification-stream-ready`, notifications, synthetic status events); heartbeat 20 s; initial `uiToken` |
| `/api/openchamber/events` | SSE | OpenChamber control-plane events: `openchamber:event-stream-ready { connectedAt }`, `openchamber:heartbeat { timestamp }` every 25 s, `openchamber:session-created`, `openchamber:scheduled-task-ran`, `openchamber:worktree-changed { directories, at }`, `openchamber:agent-memory-changed { scope, projectId? }`, `openchamber:message-queue.updated { revision, session }`, `openchamber:browser-control-request { requestId, action, parameters }`. Query `?browser=1` marks the connection as browser-view capable (drives browser-control routing) (src: `scheduled-tasks/routes.js:141-185`) |

SSE event envelope on OpenChamber-controlled streams: `event: <type>\ndata: <JSON envelope>\n\n` where the JSON envelope is `{ type, properties, id? }` and the writer is `writeSseEvent` (src: `notifications/emitter-runtime.js`).

## 4.5 OpenCode lifecycle events surfaced to users

- Restart during response → UI notification `opencode-restart-interrupted` listing (title 'Chat interrupted', body 'OpenCode restarted during a running response. Send a message to continue.') (src: `index.js:1229-1241`).
- Config wiring: settings changes that affect the harness (provider/model/agent defaults, skills, behavior AGENTS.md) call `refreshOpenCodeAfterConfigChange(reason)` — a managed restart with client reload broadcast; for **external** OpenCode the mutation routes answer with the "deferred restart" shape instead (Section 6.5).

## 4.6 Harness upgrade (HARNESS PORTS)

- `GET /api/opencode/upgrade-status`: current from `GET /global/health` (`version`), latest from npm registry `https://registry.npmjs.org/opencode-ai/latest` + GitHub releases `https://api.github.com/repos/anomalyco/opencode/releases/latest` (10 s timeouts each, best version wins), compare semver (prerelease below release). Unsupported when OpenCode is managed by Desktop (`bundled`) → `{ available:false, upgrade: { supported:false, reason:'bundled' } }`.
- `POST /api/opencode/upgrade` (single-flight 409 `OPENCODE_UPGRADE_IN_PROGRESS`): target = body `target` or resolved latest; POSTs upstream `/global/upgrade { target }`, then restarts OpenCode (`refreshOpenCodeAfterConfigChange('OpenCode upgrade')`); failure body passthrough semantics (OpenCode rejects with `{ name, data:{ message, kind } }` — error message extracted from `error|data.message|message`) (src: `packages/web/server/lib/opencode/routes.js:236-332`).
- `GET /api/opencode/health` `{ healthy: boolean }`; `GET /api/opencode/version` `{ version }`.

---

# 5. Complete route table

Notation: every route row lists **auth class** where:
- **pub** = reachable with no/any credential (listed in 2.5),
- **gate** = behind the global `/api` auth gate (2.5),
- **sess** = additionally requires a *browser UI session* (JWT cookie or equivalent RESTful `requireSessionAuth`; client bearer tokens rejected),
- **manage** = session-auth **or** client-token auth with management-appropriate scoping,
- **tun** = tunnel-scope requests require a tunnel session cookie (this is the normal gate under `classifyRequestScope`, noted where behavior differs specially).

All request field names and response shapes below are exact. Errors follow the convention `{ error: string }` (plus per-route extras), unless a shape is explicitly listed.

## 5.1 Server status / system (src: `packages/web/server/lib/opencode/core-routes.js:27-350`)

| METHOD+PATH | Auth | Request | Response | Side effects |
|---|---|---|---|---|
| GET `/health` | pub | – | `{ status:'ok', timestamp, openchamberVersion, runtime, compatibility: { apiVersion:1, minClientApiVersion:1, capabilities:[ 'api.health.v1','api.runtime-url.v1','api.raw-file.v1','realtime.sse.v1','realtime.websocket.global-events.v1','terminal.websocket.v1' ] }, serverId?, ...healthSnapshot }` where healthSnapshot includes `openCodePort, openCodeRunning, openCodeSecureConnection, openCodeAuthSource, openCodeApiPrefix:'', openCodeApiPrefixDetected:true, isOpenCodeReady, lastOpenCodeError, lastOpenCodeLaunchDiagnostics, lastOpenCodeHealthFailure, lastManagedOpenCodeProcess, lastOpenCodeRestartDiagnostics, opencodeBinaryResolved, opencodeBinarySource, opencodeLaunchBinary, opencodeLaunchArgs, opencodeLaunchWrapperType, opencodeViaWsl, opencodeWslBinary, opencodeWslPath, opencodeWslDistro, nodeBinaryResolved, bunBinaryResolved, desktopNotifyEnabled, planModeExperimentalEnabled, apiOnly` | `serverId` = hash of the relay signing key (stable server identity, present when the relay identity exists) |
| GET `/api/version` | pub | – | `{ status:'ok', openchamberVersion, runtime, startedAt, compatibility, serverId? }` | – |
| POST `/api/system/shutdown` | gate + tunnel session when tunnel-scoped | – | `200 { ok:true }` then process exits | Graceful shutdown (stops harness unless external), exit |
| POST `/api/system/dev-shutdown` | pub (dev only) | JSON `{ previewUrls?: string[] }` | 403 `{ ok:false, error:'Dev shutdown is disabled' }` unless `OPENCHAMBER_DEV_SHUTDOWN=true` then same-origin checked (`Origin` host === `Host` header) | Kills supplied loopback preview ports (`lsof`) and the dev process group (unix); exits |
| GET `/api/system/info` | pub | – | `{ openchamberVersion, runtime, pid, startedAt, port (active port incl tunnel), tunnelUrl (public URL or null) }` | – |
| GET `/api/system/free-port` | pub | – | `{ port }` (ephemeral loopback TCP port; race note in response text) | – |
| POST `/api/system/probe-url` | gate | `{ url }` — **loopback only** (`http(s)://localhost|127.0.0.1|::1|0.0.0.0`); 16 KB body | `{ ok: boolean, status?: number }` or `{ ok:false, error }` | GET-fetches the URL (redirect manual, 1.5 s timeout) |

## 5.2 Auth / session / passkeys (src: `core-routes.js:352-932`, `packages/web/server/lib/ui-auth/ui-auth.js`)

Full token rules in Section 8. Routes:

| METHOD+PATH | Auth | Request | Response | Side effects |
|---|---|---|---|---|
| GET `/auth/session` | pub | – | No password: `{ authenticated:true, disabled:true }`. With password & valid cookie: `{ authenticated:true }`. Client bearer: `{ authenticated:true, scope:'client' }`. Tunnel scope with valid tunnel cookie: `{ authenticated:true, scope:'tunnel' }`. Else `401 { authenticated:false, locked:true }` (+`clientAuthRequired:true` in client-auth-only mode, `tunnelLocked:true` in tunnel scope, cookie cleared) | Clears session cookie on failure |
| POST `/auth/session` | pub (but **403 over tunnel scope** `{ error:'Password login is disabled for tunnel scope', tunnelLocked:true }`) | `{ password, trustDevice?: boolean, issueClientToken?: boolean, clientLabel?, clientKind?, dedupeKey?, deviceName?, devicePlatform?, deviceModel?, appVersion? }` | `200 { authenticated:true, clientToken?, client? }` + session cookie; `401 { error:'Invalid credentials' }`; `429 { error:'Too many login attempts, please try again later', retryAfter }` (+`X-RateLimit-*` headers set) | Sets `oc_ui_session` cookie (HttpOnly; SameSite=Strict; Secure over https; TTL 12 h, 7 d with `trustDevice`); optional client token mint |
| POST `/auth/url-token` | pub | – | `{ token: 'oc_url_...', expiresAt: epochms }` (60 s TTL); `401` without session/client | In-memory URL token bound to session (Section 8.4); `Cache-Control: no-store` |
| GET `/auth/passkey/status` | pub (tunnel scope returns `{ enabled:false, hasPasskeys:false, passkeyCount:0, rpID:null, tunnelLocked:true }`) | – | `{ enabled, hasPasskeys, passkeyCount, rpID }` | – |
| POST `/auth/passkey/authenticate/options` | pub (403 `{error,'tunnelLocked':true}` over tunnel) | – | WebAuthn options | – |
| POST `/auth/passkey/authenticate/verify` | pub (same tunnel 403) | WebAuthn assertion + `trustDevice?`, `issueClientToken?`, device fields | `{ authenticated:true, clientToken?, client? }` + cookie | Session issued |
| POST `/auth/passkey/register/options` | sess (tunnel 403) | `{ label? }` | WebAuthn registration options | – |
| POST `/auth/passkey/register/verify` | sess (tunnel 403) | WebAuthn attestation | stored passkey record | Adds passkey |
| GET `/api/passkeys` | sess (tunnel 403) | – | `{ passkeys: [ { id, label, ... } ] }` | – |
| DELETE `/api/passkeys/:id` | sess (tunnel 403) | – | `{ ... revoked passkey }` | Removes passkey |
| POST `/api/auth/reset` | sess (tunnel 403) | – | `{ cleared:true, clearedPasskeys:number, signedOutEverywhere:true }` | Rotates the JWT secret (invalidates ALL sessions+url tokens), clears all passkeys, clears cookie |

Login rate limiting (per IP, in-memory): window 5 min; normal max attempts = `OPENCHAMBER_RATE_LIMIT_MAX_ATTEMPTS` (default **10**), no-IP max = `OPENCHAMBER_RATE_LIMIT_NO_IP_MAX_ATTEMPTS` (default **3**), lockout 15 min, cleanup sweep hourly (src: `ui-auth.js:14-18`).

## 5.3 Remote clients (paired devices) & pairing (src: `core-routes.js:728-932`; stores in `client-auth/remote-clients.js`, `client-auth/pairing.js`; link format depth in doc 08)

Token format: client token `oc_client_<32 base64url bytes>`; stored **hashed** (sha256 hex) in `remote-clients.json`. Pairing id `pair_<12 hex bytes>`; pairing secret 32 bytes base64url (shown once); fingerprint 4 bytes hex `AAAA-BBBB`.

| METHOD+PATH | Auth | Request | Response | Side effects |
|---|---|---|---|---|
| GET `/api/client-auth/clients` | manage | – | `{ clients: [ {id,label,createdAt,lastUsedAt,revokedAt,expiresAt,clientKind,authMethod,pairingId,deviceName,devicePlatform,deviceModel,appVersion,usesRelay,lastTransport} ] }`. A non-desktop client token sees only itself | – |
| POST `/api/client-auth/clients` | **session** only (a client token of kind `desktop-local` may also create); 403 `{ error:'Client tokens cannot create remote clients' }` for other kinds | `{ label?, clientKind?, dedupeKey? }` (≤64 KB) | `201 { client, token }` (`Cache-Control: no-store`) | Mints token; dedupeKey replaces the prior record for that device (label preserved) |
| DELETE `/api/client-auth/clients/:id` | manage (non-desktop tokens may only revoke themselves — else 403 `{ revoked:false, error:'Client tokens can only revoke themselves' }`) | – | `{ revoked:true, client }` or `404 { revoked:false, error:'Client not found' }` | Revokes; relay demand re-evaluated |
| DELETE `/api/client-auth/clients` | manage | – | `{ purged: number }` | Purges revoked records (non-desktop tokens 403) |
| GET `/api/client-auth/connection/candidates` | manage (`Cache-Control: no-store`) | – | `{ label:<machine hostname>, serverId?, candidates: [ {type:'lan'|'tunnel', url, priority:10} | {type:'relay', ...relayPayload, priority:30} ] }` | The refreshed reachable-URL list (LAN IPs first, then relay when enabled) |
| GET `/api/client-auth/pairing/transports` | session/client-create | – | `{ local: 'http://127.0.0.1:<port>', lan: 'http://<lanIp>:<port>' \| null, relayAvailable: true }` | LAN derived from bind + interface scan |
| GET `/api/client-auth/pairing/sessions` | session/client-create | – | `{ pending: [ pairing public sessions ] }` (no secrets) | – |
| POST `/api/client-auth/pairing/sessions` | session/client-create | `{ serverUrl?, includeRelay?: boolean, includeDirect?: boolean, label?, allowedClientKinds?: ('mobile'\|'desktop')[] }` (≤64 KB) | `201 { ...pairing session(id, fingerprint, allowedClientKinds, createdAt, expiresAt, label, usesRelay), secret, server: { label, candidates } }` | Creates one-time pairing (10 min TTL), enables relay when requested |
| DELETE `/api/client-auth/pairing/sessions/:id` | session/client-create | – | `{ cancelled:true, pairing }` or `404 { cancelled:false, error:'Pairing session not found' }` | Cancels |
| POST `/api/client-auth/pairing/redeem` | **pub** — rate limited per (IP, pairingId): window 5 min, 10 attempts (`X-RateLimit-Limit/Remaining/Reset`, `Retry-After`; 429 same safe error) | `{ pairingId, secret, clientLabel?, clientKind?, deviceName?, devicePlatform?, deviceModel?, appVersion?, dedupeKey? }` | `200 { ok:true, server: { label, url:<request origin>, fingerprint }, client, clientToken }`; errors → `400 { error:'Invalid or expired pairing session' }` | Consumes session; mints client token (authMethod 'pairing'); relay reconcile |

Rate-limit counters are keyed by socket remote address (not `req.ip`) plus pairing id; the per-IP attempt window and lock are in-memory only.

## 5.4 Tunnel bootstrap link (dst: one-time connect links; full protocol in doc 08)

| METHOD+PATH | Auth | Request | Response |
|---|---|---|---|
| GET `/connect?t=<bootstrapToken>` | pub | query `t` | No tunnel active / bad token / expired / already used → `401 text 'Connection link is invalid or expired.'`; rate-limited (`CONNECT_RATE_LIMIT` window 5 min, max 20 per IP / 5 without IP, lock 10 min) → `429 text 'Too many attempts...'` with `Retry-After`. Success: sets `oc_tunnel_session` cookie (HttpOnly, SameSite=**Lax**, TTL = settings `tunnelSessionTtlMs`), `302 → /` |

## 5.5 OpenChamber platform routes (src: `packages/web/server/lib/opencode/openchamber-routes.js`)

| METHOD+PATH | Auth | Request | Response | Side effects |
|---|---|---|---|---|
| GET `/api/openchamber/update-check` | gate | query `appType?, deviceClass?, platform?, arch?, instanceMode?, currentVersion?, installId?, reportUsage?, updateStatus?` | Update channel payload from `packages/web/server/lib/package-manager.js` (`checkForUpdates`) or the desktop updater; on desktop web-update failure with `updateStatus=true` → `503 { code:'DESKTOP_UPDATE_RESTART_FAILED', error }`. Update check endpoint default `https://api.openchamber.dev/v1/update/check` (env `OPENCHAMBER_UPDATE_API_URL`); installs get a per-scope `install-id-<scope>` UUID (`install-id` files in the data dir) | (persists an `installId` per app type: `install-id-web`, `install-id-desktop-electron`, `install-id-vscode`, `install-id-mobile-capacitor`) |
| POST `/api/openchamber/update-install` | gate | – | Response acknowledged **before** the work: `{ success:true, message, version, packageManager, autoRestart, restartManager?, jobId? }`. Containerized → detached shell runs the package manager update (server stays online). systemd foreground (`launchMode:'foreground'` + `OPENCHAMBER_SYSTEMD_UNIT`) → systemd-run transient job updates + restarts the unit (`409` if systemd-run unavailable). Daemon or plain foreground-without-systemd → detached script updates then re-spawns `openchamber serve --port [host] [ui-password] [--api-only]`, logs to `<data-dir>/update-install.log`, process exits | Updates self; instance options read from run file `<data-dir>/run/openchamber-<port>.json` |
| GET `/api/openchamber/models-metadata` | gate | – | models.dev metadata (full JSON of provider/model metadata), `Cache-Control: public, max-age=300` (or 60 for cache hits); upstream `https://models.dev/api.json`, TTL 5 min; timeout/abort → `504`/`502 { error:'Failed to retrieve model metadata' }` | – |
| GET `/api/zen/models` | gate | – | `{ models:[...] }` free OpenCode Zen models; 5-min cache; failure serves cached copy (`max-age=60`) else `502/504` | – |
| POST `/api/openchamber/agent-tool` | gate + internal authorization | `{ action, input, contextDirectory? }` (1 MB) | Agent-tool result envelope `{ ok, action?, data?, error? { message, kind } }` (tool surface for the injected OpenChamber harness tool; 401 when authorization fails) | Executes control actions (same service as `/api/openchamber/control`) |

## 5.6 Settings & config utilities (src: `packages/web/server/lib/opencode/routes.js:212-434`, `core-routes.js:995-1038`)

| METHOD+PATH | Auth | Request | Response | Notes |
|---|---|---|---|---|
| GET `/api/config/settings` | gate | – (surface header `X-OpenChamber-Surface` may scope per-surface settings profile) | full persisted settings object (Section 7.2 lists groups) | `{ surface }` resolution: `settingsSurfaceOf(req)` |
| PUT `/api/config/settings` | gate | partial settings patch (`sanitizeSettingsUpdate` normalizes: paths via `~`-expansion + realpath, projects, skill catalogs, tunnel values, PWA name/orientation, arrays) | the merged persisted settings | Atomic write 0600; side effects: per-key wiring (e.g. theme broadcast, worktree config refresh, `refreshOpenCodeAfterConfigChange` for harness-affecting keys) |
| GET `/api/config/themes` | gate | – | `{ themes: [custom theme JSONs] }` from `<data-dir>/themes` (512 KiB limit per file) | – |
| POST `/api/config/reload` | gate | – | Managed harness: `{ success:true, requiresReload:true, message:'Configuration reloaded successfully. Refreshing interface…', reloadDelayMs: 800 }`. External harness: non-error response `{ ...deferred-restriction... }` = `{ success:false? no — external answer: { requiresReload:false, requiresRestart:true, message:'Configuration is saved on disk. Restart your connected OpenCode server to apply the changes.' } }` (exact shape: `buildExternalManualRestartResponse`, src: `packages/web/server/lib/opencode/config-mutation-response.js`) | Manual config reload |
| GET `/api/config/opencode-resolution` | gate | – | Resolution snapshot: which binary would be used, from where (`settings`/`env`/`PATH`/WSL), node/bun/git binaries, WSL distro/path | – |
| POST `/api/opencode/directory` | gate | `{ path, create?: boolean }` | `{ success:true, restarted:false, path:<validated dir>, settings }` — validates directory (realpath, exists, is-dir), adds/activates project record `{ id (sha-of-path id), path, addedAt, lastOpenedAt }`, sets `activeProjectId` + `lastDirectory` in settings | `create:true` mkdirs first |
| GET `/api/behavior/agents-md` | gate | – | `{ content, exists, path }` — global AGENTS.md at `<OpenCode config dir>/AGENTS.md` | – |
| PUT `/api/behavior/agents-md` | gate | `{ content }` (1 MB) — bigger → `413 { error:'Content exceeds maximum size of 1048576 bytes' }` | `{ ...buildDeferredRestartResponse('AGENTS.md saved. Restart OpenCode to apply.') }` = `{ requiresReload:true, requiresRestart:false, message, ... }` | Writes AGENTS.md |

**The deferred-restart response shape** (used by every config mutation; src: `config-mutation-response.js`): either
- `{ requiresReload: true, requiresRestart: false, message, reloadDelayMs: 800 }` (managed harness restarted by the server — UI reloads), or
- `{ requiresReload: false, requiresRestart: true, message: '<change> is saved on disk. Restart your connected OpenCode server to apply.' }` (external harness; no server-side restart possible).

## 5.7 Provider config (OpenCode providers) (src: `opencode/routes.js:598-756`, `opencode/providers.js`, `opencode/auth.js`)

| METHOD+PATH | Auth | Request | Response | Notes |
|---|---|---|---|---|
| GET `/api/provider/:providerId/source` | gate | optional `x-opencode-directory` header or `?directory=` | `{ providerId, sources: { ... file-based source descriptors ..., auth: { exists } } }` (`auth.exists` false unless `claude-code` (Claude CLI status) or stored provider auth) | – |
| PUT `/api/provider` | gate | `{ providerID|providerId, config (object), scope: 'user'|'project'|'custom' }` | deferred-restart response + `{ providerId, path, config }` | For `project` scope the active/project directory is required (400 when missing) |
| DELETE `/api/provider/:providerId/auth` | gate | query `scope`: `auth` (stored token), `user`, `project`, `custom`, `all` | `{ success:true, removed, requiresReload... }` or `{ success:true, removed:false, requiresReload:false, message:'Provider was not connected' }` | Removes stored credential and/or config scopes |

## 5.8 Config entities (src: `packages/web/server/lib/opencode/config-entity-routes.js`)

All under the gate; all use the active/project directory (header `x-opencode-directory` or `?directory=`); project-scoped files resolve per OpenCode conventions (`.opencode/…`). Responses for mutations use the deferred-restart shape.

**Agents**
| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/config/agents/:name` | – | `{ name, sources: { md: { exists, scope, path?, dir? }, json: { exists, scope, path? } }, scope, isBuiltIn }` |
| GET `/api/config/agents/:name/config` | – | agent config info `{ ...config, source? }` |
| POST `/api/config/agents/:name` | `{ scope, ...config }` | deferred restart, agent created (md or json per scope) |
| PATCH `/api/config/agents/:name` | partial updates | deferred restart |
| DELETE `/api/config/agents/:name` | `{ scope? }` | deferred restart |

**Commands** — same 4 routes as agents (`GET /:name` returns `{ name, sources, scope, isBuiltIn }`; `GET /:name/config` **not** present for commands).
| METHOD+PATH |
|---|
| GET/POST/PATCH/DELETE `/api/config/commands/:name` |

**MCP servers** (snapshot: list/create/update/delete with immediate persistence; OpenCode restart deferred)
| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/config/mcp` | – | `{ [name]: config }` for user + project scopes |
| GET `/api/config/mcp/:name` | – | config or `404 { error:'MCP server "<name>" not found' }` |
| POST `/api/config/mcp/:name` | `{ scope, ...config }` | `{ ...deferred, message:'MCP server "<name>" created. Restart OpenCode to apply.' }` |
| PATCH `/api/config/mcp/:name` | partial updates | deferred; `404` when unknown |
| DELETE `/api/config/mcp/:name` | – | deferred |

**Snippets** (text expansion; managed as `<config>/snippets` files)
| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/config/snippets` | – | `{ snippets }` list |
| GET `/api/config/snippets/:name` | – | snippet or 404 |
| POST `/api/config/snippets/:name` | `{ scope?: 'global', ...snippet }` | `{ success:true, snippet }`; 409 exists |
| PATCH `/api/config/snippets/:name` | partial | `{ success:true, snippet }` |
| DELETE `/api/config/snippets/:name` | – | `{ success:true }` |
| POST `/api/config/snippets/expand` | `{ text }` | `{ text: expanded }` |

## 5.9 Plugins (src: `packages/web/server/lib/opencode/plugin-routes.js`)

Plugin entries live in OpenCode config (`config.json#plugin` entries, spec = npm or path) plus a `plugin/` directory of loose files. Ids are encoded `config:<scope>:<spec>` / `file:<scope>:<name>`.

| METHOD+PATH | Request | Response | Notes |
|---|---|---|---|
| GET `/api/config/plugins` | – | `{ entries: [...], files: [...] }` | – |
| GET `/api/config/plugins/registry?specs=<csl>&refresh=true` | – | `{ results: [ { kind:'npm-ok', spec, name, currentVersion, latestVersion, versions, hasUpdate } | { kind:'npm-missing-version', ... } | { kind:'npm-missing-package', ... } | { kind:'npm-network', ... } | { kind:'npm-malformed', ... } | { kind:'path-ok', spec, absolutePath } | { kind:'path-missing' } | { kind:'path-unreadable' } ] }` | max 100 specs (400 `{error:'too many specs'}`) |
| GET/POST/PATCH/DELETE `/api/config/plugins/entry(\/:id)?` | POST `{ spec, options?, scope }`; PATCH `{ spec?, options? }` | deferred restart; errors mapped by code → 409 exists / 404 / 400 invalid | – |
| GET/POST/PUT/DELETE `/api/config/plugins/file(\/:id)?` | POST `{ fileName, content, scope }`; PUT `{ content }` | deferred restart; 409 exists on create when file exists | Loose plugin source files |

## 5.10 Skills (src: `packages/web/server/lib/opencode/skill-routes.js`)

Skills live in OpenCode global dir, `~/.opencode`, `~/.claude/skills`, `~/.agents/skills`, `~/.agents/skills` in-project (`.opencode`, `.claude/skills`, `.agents/skills` under project ancestors up to the worktree root), plus built-ins.

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/config/skills` | – | `{ skills: [ { name, path, scope, source, description, content?, sources, renamable } ], externalSkills: { claudeDisabled, allDisabled } }` — merged from the harness's own skill endpoint (`client.app.skills`, 8 s timeout) **and** a local filesystem scan; `claudeDisabled` = `OPENCODE_DISABLE_CLAUDE_CODE`/`_SKILLS` env truthy; `allDisabled` = `OPENCODE_DISABLE_EXTERNAL_SKILLS` truthy |
| GET `/api/config/skills/catalog` | – | `{ ok:true, sources: [ curated + custom catalog sources with stars/repoUpdatedAt ], itemsBySource: {} }` (list of source repos; GitHub repo metas fetched) |
| GET `/api/config/skills/catalog/source?sourceId&refresh` | – | `{ ok:true, items: [ { sourceId, ...skill item, gitIdentityId, installed: { isInstalled, scope?, source? } } ] }`; auth failures 401 with identities list |
| POST `/api/config/skills/scan` | `{ source, subpath?, gitIdentityId? }` | `{ ok:true, items }` (shallow scan; 401 `{ ok:false, error: { kind:'authRequired', identities } }`, 400 other errors) |
| POST `/api/config/skills/install` | `{ source, subpath?, gitIdentityId?, scope: 'user'|'project', targetSource?, selections, conflictPolicy, conflictDecisions }` | `{ ok:true, installed, skipped, requiresReload, message }`; conflicts → `409 { ok:false, error:{ kind:'conflicts' } }`; auth → 401 | one sparse clone per request; bounded request fields and skill trees; reachable cross-target conflicts prechecked; symlinks rejected; no batch rollback |
| GET `/api/config/skills/:name` | – | `{ name, sources, scope, source, exists }` |
| POST `/api/config/skills/:name` | `{ scope, source?, ...config }` (project scope requires directory) | deferred restart |
| PATCH `/api/config/skills/:name` | updates or `{ renameTo }` (rename → immediate **full** reload `{ success:true, name, requiresReload:true, message:'Skill renamed to <new> successfully. Reloading interface…', reloadDelayMs }`) | deferred restart for edits |
| DELETE `/api/config/skills/:name` | – | deferred restart |
| GET/PUT/DELETE `/api/config/skills/:name/files/*filePath` | GET → `{ path, content }`; PUT `{ content }`; DELETE | success messages; `isUnsafeSkillRelativePath` rejects traversal (400 `{error:'Invalid file path'}`); EACCES → 403 `{error:'Access to file denied'}` |

## 5.11 Markdown image grants (src: `packages/web/server/lib/markdown-image-grants/routes.js`)

| METHOD+PATH | Auth | Request | Response | Notes |
|---|---|---|---|---|
| POST `/api/openchamber/sessions/:sessionId/markdown-image-grants` | gate (32 KB) | `{ messageId, sources: string[1..12], directory }` | `{ results: [ { source, status:'ready', path, outsideFileGrant?, expiresAt? } | { source, status:'missing'\|'pruned'\|'oversized'\|'unsupported'\|'error' } ] }`; 400 `{ error:'sessionId, messageId, and 1-12 sources are required' }`; 404 `{ error:'Assistant message not found' }`; 503 `{ error:'Failed to prepare session images' }` | Only paths **actually referenced** by the assistant message's markdown get grants (assistant text fetched upstream is authoritative); images in the OpenCode `/tmp` root are materialized (`approvedTempRoot`), outside-workspace files get a 10-minute path-bound raw-only grant (Section 6.1 outside grants) |

## 5.12 Project icons (src: `packages/web/server/lib/opencode/project-icon-routes.js`)

Stored under `<data-dir>/project-icons/project-<sha1(projectId)>.<ext>`; formats png/jpg/svg/webp/ico; max **5 MB**; SVG may be re-themed per request.

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/projects/:projectId/icon?theme&iconColor` | – | binary icon, `Cache-Control: public, max-age=31536000, immutable`; SVG `?theme=light|dark` or `?iconColor=#rgb|rgba|rrggbb|rrggbbaa` injects a color override `<style>`; 404 `{error:'Project icon not found'}` / `{error:'Project not found'}` |
| PUT `/api/projects/:projectId/icon` | `{ dataUrl: 'data:<mime>;base64,...' }` (PNG/JPEG/SVG only) | `{ project, settings }` (`iconImage: { mime, updatedAt, source:'custom' }`); 400 invalid dataUrl/format/size (`'Icon exceeds size limit (5 MB)'`) |
| DELETE `/api/projects/:projectId/icon` | – | `{ project, settings }` (iconImage null) |
| POST `/api/projects/:projectId/icon/discover` | `{ force?: boolean }` | `{ project, settings, discoveredPath }` — searches project files for `favicon.(ico|png|svg|jpg|jpeg|webp)` (fs fuzzy search, limit 200); skips custom icon unless `force`; 404 `'No favicon found in project'`; 415 unsupported format |

## 5.13 Git routes (src: `packages/web/server/lib/git/routes.js` — complete, 68 routes)

All under the gate. Unless stated, `directory` is a **required query parameter** (`?directory=<path>`); mutations usually read it from the query too. Common errors: `400 { error:'directory parameter is required' }`; 500 on git failure with git stderr in `error`; several status-shaped routes return a **"non-repo payload"** instead of failing when the path is not a git repo (`{ isGitRepository:false, files:[], branch:null, ahead:0, behind:0 }`).

Identity profiles persist in `~/.config/openchamber/git-identities.json` (src: `git/identity-storage.js`) — note this file ignores `OPENCHAMBER_DATA_DIR` (details in 7.3).

| # | METHOD+PATH | Request | Response / notes |
|---|---|---|---|
| 1 | GET `/api/git/identities` | – | profile list `{ profiles: [...] }`-shaped JSON of saved identities ({ id, name, userName, userEmail, sshKey? }) |
| 2 | POST `/api/git/identities` | `{ id, name, userName, userEmail, sshKey? }` | created profile; 400 on duplicate/missing |
| 3 | PUT `/api/git/identities/:id` | partial profile | updated profile |
| 4 | DELETE `/api/git/identities/:id` | – | `{ success:true }` |
| 5 | GET `/api/git/global-identity` | – | `{ userName, userEmail, sshCommand? }` from global git config |
| 6 | GET `/api/git/discover-credentials` | – | discovered credentials descriptor (ssh agent, credential helpers) |
| 7 | GET `/api/git/check` | `?directory` | `{ isGitRepository: boolean }` |
| 8 | GET `/api/git/remote-url` | `?directory&remote=origin` | `{ url }` |
| 9 | GET `/api/git/current-identity` | `?directory` | `{ identity }` (local, fallback global) |
| 10 | GET `/api/git/has-local-identity` | `?directory` | `{ hasLocalIdentity }` |
| 11 | POST `/api/git/set-identity` | query `?directory`; body `{ profileId }` | `{ success:true, profile }`; 404 `'Global identity is not configured'` / `'Profile not found'` — applies user.name/user.email (+ssh) to the repo |
| 12 | GET `/api/git/status` | `?directory&mode=light` | full status `{ isGitRepository, branch, ahead, behind, files:[...diff entries...], tracking?, merge?/rebase? state }`; non-repo → isGitRepository:false payload; triggers `observeWorktreeTopology` side-effect notification (never delays) |
| 13 | GET `/api/git/primary-root` | `?directory` | `{ projectID, primaryWorktree, worktreeRoot }` (path of the main worktree for this dir) |
| 14 | GET `/api/git/toplevel` | `?directory` | `{ worktreeTopLevel }` |
| 15 | POST `/api/git/commit-summaries` | `?directory`; body `{ shas: [...] }` | summaries for the given commits |
| 16 | POST `/api/git/integrate/plan` | body plan input (worktree + target) | integrate plan (cherry-pick whole set) |
| 17 | POST `/api/git/integrate/conflict-details` | `{ tempWorktreePath }` | conflict files detail |
| 18 | POST `/api/git/integrate/cherry-pick-status` | `{ tempWorktreePath }` | `{ inProgress }` |
| 19 | POST `/api/git/integrate/run` | `{ plan }` | run result |
| 20 | POST `/api/git/integrate/abort` | `{ state }` | aborted state |
| 21 | POST `/api/git/integrate/continue` | `{ state }` | continued state |
| 22 | GET `/api/git/diff` | `?directory&path&staged='true'&context` | `{ diff }` (contextLines default 3) |
| 23 | GET `/api/git/file-diff` | `?directory&path&staged` | `{ original, modified, path, isBinary }` |
| 24 | GET `/api/git/range-diff` | `?directory&base&head&path?&context&includeWorkingTree='true'` | `{ diff }`; base = merge-base comparison; `includeWorkingTree` compares against the checked-out branch's live files; ref names are **literal** (no remote-resolution, failures fail) |
| 25 | GET `/api/git/branch-base` | `?directory&branch` | creation source from reflog or `null` |
| 26 | GET `/api/git/range-files` | `?directory&base&head&includeWorkingTree` | `{ files }` |
| 27 | POST `/api/git/revert` | `?directory`; body `{ path, scope?: 'all'\|'working' }` | `{ success:true }` |
| 28 | POST `/api/git/stage` | `?directory`; body `{ path }` or `{ paths: [...] }` | `{ success:true }` |
| 29 | POST `/api/git/unstage` | same as stage | `{ success:true }` |
| 30 | POST `/api/git/apply-hunk` | `?directory`; body `{ path, patch, action: 'stage'\|'unstage'\|'discard' }` | `{ success:true }`; patch must exactly match one 3-line-context hunk; `git apply --check` first |
| 31 | POST `/api/git/pull` | `?directory`; body passthrough | pull result |
| 32 | POST `/api/git/push` | `?directory`; body passthrough (auto-sets upstream if needed) | push result |
| 32a | POST `/api/git/sync` (NND implementation) | `?directory`; explicit user action and clean worktree required; existing upstream or unambiguous remote for a new branch | fetch upstream remote, rebase behind commits, push only the current branch; a first push creates upstream tracking only when no same-named remote branch exists; `{ synced, branch, pulled, pushed, createdUpstream? }`, or actionable 409/502 error |
| 33 | GET `/api/git/stashes` | `?directory` | `{ stashes: [ { ref, message, time, hash } ] }` |
| 34 | POST `/api/git/stashes/file-counts` | `?directory`; body `{ refs: [...] }` | `{ counts }` |
| 35 | POST `/api/git/stash` | `?directory`; body options (message) | stash result — always includes untracked |
| 36 | POST `/api/git/stash/apply` | `?directory`; `{ ref }` | apply result (stash kept) |
| 37 | POST `/api/git/stash/pop` | `?directory`; `{ ref }` | pop result (drop only after successful apply) |
| 38 | POST `/api/git/stash/drop` | `?directory`; `{ ref }` | drop result |
| 39 | POST `/api/git/fetch` | `?directory`; body passthrough | fetch result |
| 40 | GET `/api/git/remotes` | `?directory` | `[ { name, url } ]`-shaped remote list |
| 41 | DELETE `/api/git/remotes` | `?directory`; body `{ remote }` | removal result (origin refused) |
| 42 | POST `/api/git/rebase` | `?directory`; body `{ target? }` | rebase start result |
| 43 | POST `/api/git/rebase/abort` | `?directory` | abort result |
| 44 | POST `/api/git/rebase/continue` | `?directory` | continue result |
| 45 | POST `/api/git/merge` | `?directory`; body `{ branch? }` | merge result |
| 46 | POST `/api/git/merge/abort` | `?directory` | abort result |
| 47 | POST `/api/git/merge/continue` | `?directory` | continue result |
| 48 | GET `/api/git/conflict-details` | `?directory` | `{ operation, files, diffs }` conflict info |
| 49 | POST `/api/git/commit` | `?directory`; `{ message, addAll?, files?, stageFiles? }` | commit result `{ success, hash? ... }`; 400 `{ error:'message is required' }` |
| 50 | GET `/api/git/branches` | `?directory` | `{ current, local..., remote..., ...}` branch list (remote only active branches) |
| 51 | POST `/api/git/branch-push-status` | `?directory`; `{ branches: string[] }` (400 otherwise) | unpushed counts (≤5 branches, local refs only) |
| 52 | POST `/api/git/branches` | `?directory`; `{ name, startPoint? }` | create & checkout result |
| 53 | DELETE `/api/git/branches` | `?directory`; `{ branch, force? }` | delete result |
| 54 | PUT `/api/git/branches/rename` | `?directory`; `{ oldName, newName }` | rename result (upstream tracking preserved) |
| 55 | DELETE `/api/git/remote-branches` | `?directory`; `{ branch, remote }` | delete remote branch result |
| 56 | POST `/api/git/checkout` | `?directory`; `{ branch }` | `{ branch: <actually checked out> }` — remote-tracking names resolve to local branch (created with `--track`); result reports the real branch |
| 57 | POST `/api/git/checkout-commit` | `?directory`; `{ hash }` (7-40 hex) | detach result; 400 `'Invalid commit hash'` |
| 58 | POST `/api/git/cherry-pick` | `?directory`; `{ hash }` (validated) | cherry-pick result |
| 59 | POST `/api/git/revert-commit` | `?directory`; `{ hash }` (validated) | revert result |
| 60 | POST `/api/git/reset-to-commit` | `?directory`; `{ hash, mode: 'soft'\|'mixed'\|'hard', force?: boolean }` | reset result |
| 61 | GET `/api/git/worktrees` | `?directory` | worktree list; empty list only when not a repo; **500** on real failure (callers keep last topology); triggers topology observe |
| 62 | POST `/api/git/worktrees/validate` | `?directory`; body (mode `new`/`existing`, branchName, startRef, upstream config) | validation result |
| 63 | POST `/api/git/worktrees` | `?directory`; body same as validate | created worktree — runs `post-checkout` hook once after population (missing/non-executable hook skipped, hook failure only logged); fetch fallback semantics: remote start ref fetch failure → local branch + `sourceFetchFailed` flag for the checked-out branch flow |
| 64 | POST `/api/git/worktrees/preview` | `?directory`; body | preview: path candidates/branch resolution without creating |
| 65 | GET `/api/git/worktrees/bootstrap-status` | `?directory` | `{ status: 'ready'\|'pending'\|'failed', phase?, error? }` used by the proxy hold (4.4 #3) |
| 66 | DELETE `/api/git/worktrees` | `?directory`; `{ directory: <worktree path>, deleteLocalBranch?: boolean }` | `{ success: boolean }` |
| 67 | GET `/api/git/worktree-type` | `?directory` | `{ linked: boolean }` (linked vs primary worktree) |
| 68 | GET `/api/git/log` | `?directory&maxCount&from&to&file&all='true'` | commit list with stats |
| + | GET `/api/git/commit-files` (counted with log block) | `?directory&hash` | files of commit relative to first parent (empty tree for root); NUL-delimited paths preserve whitespace; renames give `path`+`previousPath` |
| + | GET `/api/git/commit-diff` | `?directory&hash&path?&previousPath?&context` | `{ diff }` committed objects only |
| + | GET `/api/git/commit-file-diff` | `?directory&hash&path&binary='true'` | `{ original, modified, isBinary }`; hash regex-validated |
| + | POST `/api/git/validate-directory` | body `{ directory, worktreeRoot }` | worktree layout validation |
| + | POST `/api/git/canonicalize-worktree-state` | body `{ directory }` | canonicalization result |

(Every git write route funnels through an index-mutation queue in the service; applies/commits race safely.)

## 5.14 Filesystem routes (src: `packages/web/server/lib/fs/routes.js` — complete, 17 routes)

Two authorization modes:
1. **Workspace-bound**: the target path must resolve inside the active workspace directory (from the request's `directory` scope), OR inside a **managed root** (the OpenChamber data config root, or the managed chats root `<data-root>/chats` / `OPENCHAMBER_CHATS_DIR`), OR inside the active project's **worktrees** (worktree-root fallback). The request-flow details (symlink retry against the raw requested base) are in src: `fs/routes.js:256-302`.
2. **Exact-path grants** (`allowOutsideWorkspace=true` + `outsideFileGrant=<token>`): only for read-family routes (`stat`, `read`, `raw`); the grant is minted by `mintOutsideFileGrant(path, scopes)` (exported; used by markdown image grants) with **TTL 10 minutes**, canonical path + scopes (`stat|read|raw`); the token is an opaque UUID; every check re-resolves the realpath and demands exact equality with the granted canonical path. `mkdir`/`exec`/writes **cannot** get outside-workspace access this way (rejected outright with 403 `'Outside workspace directory creation requires a grant'` / skip).

OS `EACCES`/`EPERM` errors map to `403 { error, reason: 'os-permission' }` (stable marker; distinguishable from policy denials which omit `reason`).

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/fs/home` | – | `{ home, chatsRoot }` (chatsRoot = managed chats root; clients must not join home+segment) |
| POST `/api/fs/mkdir` | `{ path, allowOutsideWorkspace? (always rejected — no grant mechanism) }` | `{ success:true, path }` |
| POST `/api/fs/clone` | `{ remoteUrl, destinationPath, gitIdentityId? }` | `{ success:true, path, output }`; destination may end with `/` (derive repo name from URL) or be an existing dir (derive name); existing target → `409 {error:'Destination path already exists'}`; git env `GIT_TERMINAL_PROMPT=0`; optional ssh identity via `core.sshCommand` (path escaped/validated; 400 `'SSH key path contains invalid characters: ...'`); local identity applied post-clone |
| GET `/api/fs/directory-stat` | `?path` (any path; same policy as list) | `{ isDirectory:true }`; 404 `{ error:'Directory not found', reason:'not-found' }`; 400 `{ reason:'not-directory' }` |
| GET `/api/fs/stat` | `?path&optional='true'&allowOutsideWorkspace&outsideFileGrant` | `{ path:<canonical>, isFile:true, size, mtimeMs }`; optional → `200 { path, exists:false }` when missing (404 otherwise) |
| GET `/api/fs/read` | `?path&optional` | `text/plain` body; **empty-read retry** (up to 3 retries at 50/100/150 ms) when stat saw size>0 but read got empty (concurrent-write O_TRUNC window); optional ENOENT → 200 empty |
| GET `/api/fs/raw` | `?path&download='true'&allowOutsideWorkspace&outsideFileGrant` (scope `raw`) | binary with MIME from extension (image/pdf list) else `application/octet-stream`; `download=true` sets `Content-Disposition: attachment` (RFC 5987 `filename*`); `Cache-Control: no-store`; granted responses add `Referrer-Policy: no-referrer` |
| GET `/api/fs/serve/*path` (regex `^\/api\/fs\/serve\/(.+)$`) | path from URL; `?allowOutsideWorkspace` **rejected 403** `'{ error:'allowOutsideWorkspace is not permitted for this endpoint' }'` | binary with per-extension MIME (html/css/js/... map; src: `fs/routes.js:117-145`), max size 100 MB (413 `'File too large to serve'`), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` |
| POST `/api/fs/write` | `{ path, content }` | `{ success:true, path }`; no-op when content unchanged; **atomic tmp+rename write**; canonical containment check (symlink escape → 403 `{error:'Access denied'}`) |
| POST `/api/fs/upload` | query `?path&overwrite='true'`; body raw `application/octet-stream` (**415** otherwise); default cap 100 MiB (`OPENCHAMBER_FS_UPLOAD_MAX_BYTES`), pre-checked on Content-Length (413 `'File exceeds maximum size of N bytes'`) and streamed (abort on overrun) | `{ success:true, path }`; temp file `.upload-<uuid>` then atomic commit: `rename` on overwrite, `link`+`unlink` (no-replace) otherwise; existing without overwrite → `409 { error:'File already exists', reason:'already-exists' }`; dir target → 400; canonical parent containment enforced |
| POST `/api/fs/delete` | `{ path }` | `{ success:true, path }` — `rm -rf` semantics (`recursive: true, force: true`); 404 missing |
| POST `/api/fs/rename` | `{ oldPath, newPath }` | `{ success:true, path }`; **both must share one workspace base** (`'Source and destination must share the same workspace root'`) |
| POST `/api/fs/reveal` | `{ path }` (any path; only existence checked) | `{ success:true, path }`; opens Finder/`explorer /select`/`xdg-open` (detached), 404 missing |
| POST `/api/fs/exec` | `{ commands: string[], cwd, background? (must be absent/false; explicit **400** `'Background command execution is not allowed'`), }` | **synchronous** `{ jobId, status:'done', success, results: [ { command, success, exitCode, stdout, stderr, error? } ] }`. cwd must be in workspace/managed roots (403 with boundary error); runs commands sequentially through `$SHELL -c` (win: `cmd.exe /c`), windowsHide, env PATH augmented; **timeout default 5 min** (`OPENCHAMBER_FS_EXEC_TIMEOUT_MS`) → `error:'Command timed out after <ms>ms (SIGKILL)'`; jobs kept in memory with TTL 30 min |
| GET `/api/fs/exec/:jobId` | – | job status/result (404 unknown/expired) |
| GET `/api/fs/list` | `?path (default: home)&respectGitignore='true'` | `{ path:<requested>, entries: [ { name, path:<requested path space>, isDirectory, isFile, isSymbolicLink } ] }`; gitignore via `git check-ignore` (2.5 s default timeout, `OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS`); `ENOENT` → 404 `{reason:'not-found'}` **except** when the path is a project plans dir (`.../.opencode/plans`) → empty `{ path, entries: [] }` (plans dir is created lazily); symlinked targets stat'ed for `isDirectory`; responses stay in the caller's path space (symlink transparency) |
| GET `/api/fs/git-dirs` | `?path` | `{ path, repositories: [ { path, name } ] }` — shallow walk: depth ≤ 3 (`GIT_DIRS_MAX_DEPTH`), ≤ 100 visited dirs (`GIT_DIRS_MAX_DIRS`), skip list `node_modules,dist,build,.venv,target,.next`, repo boundary (any `.git` entry) stops descent; root itself not listed |

Git read plumbing cache (`/api/fs/exec` only): commands matching `git rev-parse --absolute-git-dir|--git-common-dir|--show-toplevel` are cached per (cwd, normalized command) with TTL `OPENCHAMBER_GIT_READ_CACHE_TTL_MS` (default **30 s**, 0 disables); single-flight; LRU caps 500 entries / 1 MB (src: `fs/routes.js:173-199`).

## 5.15 Projects & per-project config (src: `packages/web/server/lib/projects/routes.js`, `project-context/routes.js`, `agent-memory/routes.js`)

| METHOD+PATH | Request | Response | Notes |
|---|---|---|---|
| GET `/api/projects/:projectId/config` | – | project setup JSON (worktree setup commands, project actions, draft starters) | file `<data-dir>/projects/<projectId>.json` |
| PUT `/api/projects/:projectId/config` | object | saved setup | user-owned part |
| PUT `/api/projects/:projectId/config/shared` | object | saved setup | team-shared file inside the checkout (shared checkout path), lock-shared with scheduled-task writers |
| GET `/api/project-context/:projectId` | – | full project context `{ notes, todos, plans }` | notes/todos inline in `<data-dir>/projects/<projectId>.json` |
| PUT `/api/project-context/:projectId/todos` (1 MB) | `{ todos: [ { id, text, completed?, createdAt? } ] }` | saved context | shape-validated, 400 otherwise |
| POST `/api/project-context/:projectId/notes` (1 MB) | `{ body, source?: 'manual'|'selection'|'agent', origin? (object) }` | `201 { note, context }` | |
| PATCH `/api/project-context/:projectId/notes/:noteId` | `{ body?, pinned? }` | saved or `404 { error:'Note not found' }` | |
| DELETE `/api/project-context/:projectId/notes/:noteId` | – | context after delete or 404 | |
| PATCH `/api/project-context/:projectId/plans/:planId` (1 MB) | `{ pinned }` | updated plan or 404 | |
| GET `/api/project-context/:projectId/plans/:planId` | – | plan `{ id, title, pinned, raw?, path? }` or 404 | |
| PUT `/api/project-context/:projectId/plans/:planId` | `{ raw }` | updated plan or 404 | |
| POST `/api/project-context/:projectId/plans` | `{ body, title? }` | `201 { plan, context }` | |
| POST `/api/project-context/:projectId/plans/:planId/share` and `/unshare` | – | moved plan (user folder ↔ team shared folder) or 404 | |
| DELETE `/api/project-context/:projectId/plans/:planId` | – | context after delete or 404 | |
| GET `/api/agent-memory?scope=global` | gate | – | `{ memories: [...] }` global memory store |
| GET `/api/agent-memory?scope=project&projectId=<id>` | gate | – | project-scope memories; missing projectId → 400 `{ error:'projectId is required for project scope' }` |
| GET `/api/agent-memory/all?projectId?` | gate | – | `{ global: {...}, project: {...} }` both scopes |
| PATCH `/api/agent-memory/:memoryId?scope=...` (1 MB) | `{ title?, body?, type?: 'fact'|'preference'|'reference' }` | updated memory; 404 unknown; 404 `{ error:'Agent memory is disabled', disabled:true }` when the feature is off; 503 `{ error:'Agent memory availability is unknown' }` when settings unreadable | |
| DELETE `/api/agent-memory/:memoryId?scope=...` | – | `{ deleted:true }` or 404 | |
| GET `/api/projects/:projectId/icon` family | see 5.12 | | |

Validation: unknown/unsupported characters in ids produce 400 (`is required` / `unsupported characters` classification); memory feature gate is one switch (`agentMemoryToolEnabled === true` + feature flag env presence) (src: `agent-memory/feature-flag.js`).

## 5.16 Scheduled tasks (src: `packages/web/server/lib/scheduled-tasks/routes.js`; feature depth in doc 12)

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/projects/:projectId/scheduled-tasks` | – | `{ tasks: [...] }` (404 invalid project; 400 missing projectId) |
| PUT `/api/projects/:projectId/scheduled-tasks` | `{ task }` (upsert) | upserted task |
| DELETE `/api/projects/:projectId/scheduled-tasks/:taskId` | – | `{ tasks }` after removal |
| PATCH `/api/projects/:projectId/scheduled-tasks/:taskId/loop-file` | `{ enabled }` | `{ task }` (loop-file enabled flag) |
| DELETE `/api/projects/:projectId/scheduled-tasks/:taskId/loop-file` | – | `{ tasks }` |
| POST `/api/projects/:projectId/scheduled-tasks/:taskId/run` | – | `{ ok:true, ...run result }` (creates/dispatches the run; emits `openchamber:scheduled-task-ran` SSE) |
| GET `/api/openchamber/scheduled-tasks/status` | – | scheduler status `{ ...running state, next runs }` |
| GET `/api/openchamber/events` | gate (SSE) | OpenChamber control event stream (4.4 table); `?browser=1` marks browser-capable client |

## 5.17 Session orchestration — OpenChamber services (src: `packages/web/server/lib/openchamber-sessions/routes.js`, `openchamber-control/routes.js`)

These compose OpenCode calls (create session, worktree from "chat" root, prompt dispatch). Input/output envelopes are the **control error** convention: on failure `{ error, partial?, partialAction?, sessionId?, directory? }` with 4xx/5xx status. Feature depth in doc 12 (session goals) and doc 04 (client sync).

| METHOD+PATH | Request | Response | Notes |
|---|---|---|---|
| POST `/api/openchamber/sessions` (1 MB) | `{ directory?, projectID?, title?, prompt?, model?, agent?, worktree? ... }` | created session descriptor (`{ sessionID, directory, ... }`) — emits `openchamber:session-created` `{ sessionId, directory, createdAt, promptDispatched, dispatchedAsCommand, projectId?, title? }` | validates directory (`validateDirectoryPath`), creates chat worktree under the managed chats root when requested, optional prompt dispatch |
| POST `/api/openchamber/sessions/archive` (1 MB) | `{ sessionIds? }` | archive result | archived = parented away in OpenCode |
| POST `/api/openchamber/sessions/:sessionId/send` (1 MB) | `{ text/parts, model?, agent? ... }` | send receipt | injects project knowledge block (session-knowledge runtime) before forwarding upstream |
| POST `/api/openchamber/sessions/:sessionId/fork` (1 MB) | fork input | forked session receipt | |
| POST `/api/openchamber/control` (1 MB) | `{ action, input?, contextDirectory?, ... }` | action result (same envelope family as agent-tool) | The **whole OpenChamber control plane** for external drivers (CLI `session`/`schedule` commands use this) |

## 5.18 Message queue (src: `packages/web/server/lib/message-queue/runtime.js:812-883`; storage § 7.4; behavior § doc 12)

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/message-queue` | – | full snapshot `{ revision, sessions }` (public snapshots strip `dataUrl`/`context` payloads; `contextPreview` ≤ 100 chars) |
| POST `/api/message-queue/sessions/:sessionId/items` | `{ directory, item }` | `{ revision, session, itemId }` and arms dispatch |
| POST `/api/message-queue/sessions/:sessionId/take` | – | all non-in-flight items in order (full payloads) |
| PUT `/api/message-queue/sessions/:sessionId/order` | `{ itemIds }` (complete permutation required) | reordered snapshot |
| PUT `/api/message-queue/sessions/:sessionId/hold` | `{ held: boolean, ttlMs? }` (default hold 5 min, cap 10 min) | updated session hold |
| DELETE `/api/message-queue/sessions/:sessionId` | – | cleared queue (in-flight item survives) |
| POST `/api/message-queue/sessions/:sessionId/items/:itemId/take` | – | removed item full payloads; 404 unknown, 409 in-flight |
| DELETE `/api/message-queue/sessions/:sessionId/items/:itemId` | – | removed; 409 while in flight |

Errors: TypeError-class validation → 400; unknown ids → 404-ish per routes (`error.message`); station-wide broadcast `openchamber:message-queue.updated` on **every** mutation (4.4 channels table). Limits: 20 items/session, 50 sessions (oldest evicted, never one with in-flight item), 200 000 chars content.

## 5.19 Permission auto-accept (src: `packages/web/server/lib/permission-auto-accept/runtime.js:249-266`)

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/permission-auto-accept` | – | current policy snapshot `{ defaultPolicy?, sessions: { [sessionId]: { enabled, ... } }, records }`-shaped persisted state |
| PUT `/api/permission-auto-accept/sessions/:sessionId` | `{ enabled?: boolean, directory? }` | updated policy snapshot |
| POST `/api/notifications/auto-accept` | `{ sessionId, enabled }` | `{ success:true, sessionId, enabled }` — quick-set from the client (mirrors client-side state so the notification suppressor agrees) |

The runtime watches permission-request events from the hub, auto-responds when policy permits, and keeps pending-response reconciliation; state persists in settings (Section 7.2 `permissionAutoAccept`) and broadcasts OpenChamber events on changes.

## 5.20 Session goal (src: `packages/web/server/lib/session-goal/routes.js`; depth in doc 12)

| METHOD+PATH | Request | Response |
|---|---|---|
| PUT `/api/goals/objective/:sessionId` | `{ content }` (1 MB via allowlist) | `{ ok:true }` — writes the goal objective file |
| GET `/api/goals/objective/:sessionId` | – | `{ content }` or `404 { error:'objective not found' }` |
| DELETE `/api/goals/objective/:sessionId` | – | `{ ok:true }` |

Goal objective files: `<data-root>/goals/<sessionId>.md` (flat file per session; in-memory content clamp 5 000 chars; sessionId must match `^[A-Za-z0-9_-]{4,128}$`); goal metadata rides session metadata (`objectiveFile:true` flag; statusReason/note tokens etc. — details doc 12). Goal settle notification: uses `notifyOnCompletion` toggle and tags `goal-<sessionId>` (title `Goal complete`/`Goal reached its token budget`/`Goal blocked`; body = objective ≤140 chars — detail ≤240 chars) (src: `index.js:814-847`).

## 5.21 Session knowledge (src: `packages/web/server/lib/session-knowledge/routes.js`)

| METHOD+PATH | Request | Response | Notes |
|---|---|---|---|
| GET `/api/session-knowledge?directory&sessionId?` | – | `{ text, signature }` to attach (empty text = already carried) | never errors on failure: `{ text:'', signature:'', unavailable:true, reason }` |
| GET `/api/session-knowledge/summary?directory&sessionId?` | – | `{ notes, plans, memory: { global, project } }` counts for the work-status panel; missing directory → the empty shape | |
| POST `/api/session-knowledge/pin` (1 MB) | `{ sessionId, directory, kind:'note'|'plan', id, pinned }` | `{ pins }` | |
| POST `/api/session-knowledge/delivered` (1 MB) | `{ sessionId, directory, signature }` | `{ recorded:true }`; failure → `{ recorded:false, reason }` (**never** a 500 — the message is already out) | separates "give me the text" from "record it was sent" |

## 5.22 Session folders (src: `packages/web/server/lib/session-folders/routes.js`)

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/session-folders` | – | `{ version:1, foldersMap, collapsedFolderIds, updatedAt, exists:true }`-shaped snapshot or `{ version:1, exists:false }` when none; malformed → `500 { error:'Stored session folders have an invalid shape' }` / `'{ error:'Stored session folders are malformed' }'` |
| POST `/api/session-folders` (4 MB cap; body itself in the 50 MB allowlist? — the route file caps at `MAX_BODY_BYTES` 4 MiB *after* parse; invalid → 400/413) | full snapshot `{ version:1, foldersMap: { [key]: [ { id, name, sessionIds: string[], createdAt, parentId? } ] }, collapsedFolderIds: string[], updatedAt }` | `{ success:true }`; **last-writer-wins by `updatedAt`**: an older `updatedAt` than stored returns `{ success:true, ignored:true }`; serialized write queue (atomic tmp+rename); payload > 4 MiB → `413 { error:'Payload too large' }` |

## 5.23 GitHub integration (src: `packages/web/server/lib/github/routes.js` — 19 routes)

Token storage: device-flow OAuth token + scope + user (saved per account id; multiple accounts supported; gh-CLI token source supported). Env: `OPENCHAMBER_GITHUB_CLIENT_ID` (required; 400 `{ error:'GitHub OAuth client not configured. Set OPENCHAMBER_GITHUB_CLIENT_ID.' }` otherwise). `directory`/`branch` params drive repo lookup from the local worktree when `owner/repo` is not supplied.

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/github/auth/status` | – | `{ connected, user?, scope?, accounts: [ { id, user, current, source } ] (source: 'oauth'\|'gh-cli'), ghCli: { available, disabled, active, user? } }` (401-shaped clearing on invalid token) |
| POST `/api/github/auth/gh-cli` | `{ disabled: boolean }` | `{ disabled }` — enable/disable the gh-CLI account source |
| POST `/api/github/auth/start` | – | device flow `{ deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval, scope }` |
| POST `/api/github/auth/complete` | `{ deviceCode }` | `{ connected:true, user, scope, accounts }` or `{ connected:false, status, error }` for provider errors (`slow_down`/`authorization_pending` surfaced as `status`) |
| POST `/api/github/auth/activate` | `{ accountId }` | switches the active account (gh-CLI id = `GH_CLI_ACCOUNT_ID`); `{ connected, user, accounts, ghCli, scope? }`; 404 unknown account |
| DELETE `/api/github/auth` | – | `{ success:true, removed }` |
| GET `/api/github/me` | – | `{ login, id, avatarUrl, name, email }`; 401 with auto-clear when expired |
| GET `/api/github/pr/status?directory&branch` | – | PR state for the branch (open PR, checks, review state; LRU cache ~cached per key) |
| POST `/api/github/pr/create` | `{ directory, title, head, base?, body?, draft? }` | created PR |
| POST `/api/github/pr/update` | `{ directory, number, title?, body? }` | updated PR |
| POST `/api/github/pr/merge` | `{ directory, number }` | merge result |
| POST `/api/github/pr/ready` | `{ directory, number }` | ready-for-review result |
| GET `/api/github/repo/upstream?directory` | – | upstream repo info (owner/repo, default branch) |
| GET `/api/github/repo/branches?owner&repo` | – | branch list of that repo |
| GET `/api/github/issues/list?directory&page&query` | – | issue page (search) |
| GET `/api/github/issues/get?directory&number` | – | issue detail |
| GET `/api/github/issues/comments?directory&number` | – | comments |
| GET `/api/github/pulls/list?directory&page&query` | – | PR page (search) |
| GET `/api/github/pulls/context?directory&number` | – | PR context payload (diff/files/commits for review surfaces) |

## 5.24 Linear integration (src: `packages/web/server/lib/linear/routes.js` — 14 routes)

OAuth with known clientId from env (`LINEAR_CLIENT_ID_MISSING` 400), workspaces (multi-org), refresh tokens, session-status comments posting (feature: doc 12/agent status). Callback page mirrors the MCP one (`openchamber://focus/linear-auth` return link).

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/linear/oauth/callback?code&state&error...` | pub | self-contained HTML page ("Authorization Complete"/"Failed"); 400 unknown state/missing code/denied; 502 exchange failures |
| GET `/api/linear/auth/status` | gate | `{ connected, ...toLinearPublicStatus }` (user, organization, workspaces, scope, expiresAt); also completes broker-driven flows (device polls) |
| POST `/api/linear/auth/start` | `{ origin?: 'desktop' }` (16 KB) | authorization start payload (URL/state) |
| POST `/api/linear/auth/activate` | `{ organizationId }` | switches active workspace; `toLinearPublicStatus`; 404 unknown workspace |
| DELETE `/api/linear/auth` | gate | `{ success:true, removed }` (token revoked server-side first) |
| GET `/api/linear/issues/list?query&cursor&status&assignee&teamId&priority` | gate | issue page/result |
| GET `/api/linear/issues/get?id` | gate | issue (400 when id missing) |
| GET `/api/linear/issues/states?teamId` | gate | workflow states (400 `teamId is required`) |
| POST `/api/linear/issues/update` | `{ id, stateId }` | update result |
| GET `/api/linear/mapping` | gate | `{ connected, teams: [...], mapping }` merged view |
| PUT `/api/linear/mapping` | mapping object | saved mapping view; 400 invalid |
| POST `/api/linear/session-status` | `{ kind, sessionId, issueIdentifier, sessionOrigin }` | posted status/comment result; 400 invalid |
| GET `/api/linear/preferences` | gate | `{ sessionComments: boolean }` |
| PUT `/api/linear/preferences` | `{ sessionComments: boolean }` | `{ sessionComments }` |

## 5.25 Markdown-rendering-adjacent text / TTS / STT (src: `packages/web/server/lib/tts/routes.js`, `packages/web/server/lib/text/summarization.js`)

| METHOD+PATH | Request | Response | Notes |
|---|---|---|---|
| POST `/api/voice/token` | – | `{ allowed:true, provider:'openai', message }` when `OPENAI_API_KEY` is set; else `503 { allowed:false, error:'OpenAI voice service not configured. Set OPENAI_API_KEY environment variable.' }` | legacy gate for the browser voice feature |
| POST `/api/tts/speak` | `{ text, voice='nova', model='gpt-4o-mini-tts', speed=0.9, instructions?, apiKey?, baseURL? }` | audio/mp4 buffer (`Content-Type` from service, `Content-Length`), `Cache-Control: no-cache`; 400 `'Text is required'`; 503 when neither server-configured nor client key nor custom base URL; 500 `{ error, detail: { model, voice, hasBaseURL } }` | server-side OpenAI TTS ("speech stream" generated then returned as one buffer); custom base URL must be an OpenAI-compatible host (`normalizeCustomOpenAIBaseURL` validation) |
| POST `/api/text/summarize` | `{ text, threshold?=200, maxLength?=500, mode?: 'tts'\|'note' }` | `{ summary, summarized, reason? }` — heuristic compression (no model) | on internal error returns sanitized fallback with `summarized:false` (never 500s the caller) |
| GET `/api/tts/status` | – | `{ available, voices: [alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar] }` | |
| GET `/api/tts/say/status` | – | `{ available, voices:[ { name, locale, ... } ] }` (macOS `say` probe; awaited startup probe result) | |
| POST `/api/tts/say/speak` | `{ text, voice='Samantha', rate=200, language?, languageSample? }` | audio/mp4; `X-Speech-Voice`; `X-Speech-Language` when language auto-detect ran; 503 off macOS | temp `say` invocation (`-o file --data-format=aac`), m4a read + unlinked |
| POST `/api/stt/transcribe` | raw audio body (`audio/*`, ≤ **20 MB** raw parser) + headers `X-Base-URL` (required), `X-Model` (default `deepdml/faster-whisper-large-v3-turbo-ct2`), `X-Language?`, `Authorization: Bearer (optional)` | `{ transcript }` | server-side proxy to an OpenAI-compatible transcription endpoint |

## 5.26 Dictation (src: `packages/web/server/lib/dictation/runtime.js`; deep spec doc 07/12)

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/dictation/status?provider&localModel` | – | per-provider status (local sherpa-onnx model file presence, openai compatibility) |
| POST `/api/dictation/tts/speak` (1 MB) | `{ text, model?, speakerId?, speed?, language?: 'auto', languageSample? }` | WAV bytes (`X-Speech-Model`, `X-Speech-Language`); not ready → `503 { error, retryable:true, reasonCode }` |
| POST `/api/dictation/models/:modelId/download` | – | `{ ok:true, ... }` or `400 { error }` |
| DELETE `/api/dictation/models/:modelId` | – | `{ ok:true }` or `400 { error }` |
| WS `/api/dictation/ws` | frames per src header comment (start/chunk/finish/cancel/ping → ready/ack/partial/finish_accepted/final/error/pong) | max payload 512 KB; heartbeat ping 30 s; UI-auth + origin gates on upgrade |

## 5.27 Terminal (src: `packages/web/server/lib/terminal/runtime.js:429-551`; protocol depth doc 07)

Constants: **MAX_SESSIONS = 20** (`'Maximum terminal sessions reached'` → 429), history cap 512 KB/session, input cap 65 536 chars, IDLE_TIMEOUT 30 min (swept every 5 min: unattached + idle → killed with reason `IDLE_TIMEOUT`), resize caps 1000 cols / 500 rows, WS max payload per `TERMINAL_WS_MAX_PAYLOAD_BYTES`, heartbeat 15 s, input-rebind window 128/60 s.

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/terminal/shells` | – | `[ { id, name, supportsLogin } ]` |
| GET `/api/terminal/sessions?cwd` | optional cwd filter | `{ sessions: [ { sessionId, cwd, status, createdAt, mode, purpose } ] }` (mode: interactive vs command; purpose: e.g. task ids) |
| POST `/api/terminal/touch` | `{ sessionIds: [...] }` | `{ touched: number }` (activity bump) |
| POST `/api/terminal/create` | `{ cwd, cols, rows, shell?, loginShell?, mode?, purpose?, themeMode?, terminalBackground?, terminalForeground? }` | `{ sessionId, cols, rows, status, mode, purpose }`; 429 `'Maximum terminal sessions reached'`; 400 invalid cwd/args |
| POST `/api/terminal/:sessionId/resize` | `{ cols, rows }` | `{ success:true, cols, rows }`; 404 unknown; 400 `'Invalid terminal dimensions'` |
| POST `/api/terminal/:sessionId/appearance` | appearance payload | `{ success:true }` |
| POST `/api/terminal/:sessionId/restart` | `{ cwd?, cols?, rows?, themeMode?, terminalBackground?, terminalForeground?, shell='auto', loginShell? }` | `{ sessionId, cols, rows, status }`; command-mode sessions rejected 400; restarts serialized per session |
| DELETE `/api/terminal/:sessionId` | – | `{ success:true }` (cancellation aware for pending creates) |
| POST `/api/terminal/force-kill` | `{ sessionId? , cwd? }` | `{ success:true, killedCount, killedSessionIds }` |
| WS `/api/terminal/ws` | PTY wires (07) | UI-auth + origin gates on upgrade; auth token rebind flooding capped (128/60 s) |

## 5.28 Quota/credential providers (src: `packages/web/server/lib/quota/routes.js`)

Provider ids served: `exe-dev`, `ollama-cloud`, `cursor` (credential managers; these keep *credentials* for usage/quota display), plus any OpenChamber-registered quota provider list.

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/quota/providers` | – | `{ providers }` configured list |
| GET `/api/quota/credentials/:providerId` | – | status `{ configured, ... }`; 404 `{ code:'UNSUPPORTED_PROVIDER' }` |
| PUT `/api/quota/credentials/:providerId` (16 KB) | credential fields (normalized per provider) | saved status (validated remotely first); 400 `{ code:'INVALID_CREDENTIAL' }` |
| POST `/api/quota/credentials/:providerId/validate` | – | `{ valid:true }` / 400 `INVALID_CREDENTIAL` / 404 `{ code:'NOT_CONFIGURED' }` |
| POST `/api/quota/credentials/:providerId/import` | – | cursor-only import (`404 { code:'IMPORT_UNAVAILABLE' }` otherwise) |
| DELETE `/api/quota/credentials/:providerId` | – | `{ configured:false }` |
| GET `/api/quota/:providerId` | – | usage payload from the provider fetcher; 500 on failure |

## 5.29 Small model (src: `packages/web/server/lib/small-model/routes.js`)

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/small-model?directory?&providerID?&modelID?` | – | `{ available, model, authenticatedProviders }` |
| POST `/api/small-model/generate` (1 MB/50 MB allowlist) | `{ prompt, system?, maxOutputTokens?, model?, directory?, sessionID?, preferredProviderID?, preferredModelID?, restrictToPreferredProvider? }` | `{ text, model, ... }`-shaped generation; 404 when no small model configured (`'No small model is available'`), 4xx otherwise with message `'The selected Small Model could not complete this action. Choose another model in Settings → Sessions → Small Model and try again.'` |

## 5.30 Walkthrough (src: `packages/web/server/lib/walkthrough/routes.js`)

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/walkthrough?directory&source?&model?&language?` (source JSON-encoded) | – | walkthrough `{ ... }` from cache/queued generation (diffs vs model) |
| GET `/api/walkthrough/pr-diff?directory&source` | – | full PR patch as **text/plain** (source must be kind `pr`) |
| POST `/api/walkthrough/generate` | `{ directory, source?, force?, model?, language? }` | generation result or accepted/pending marker; **not** aborted on client disconnect (deliberate; job survives and caches) |
| GET `/api/walkthrough/progress?directory&source` | – | `{ stage }` memory-only poll |
| POST `/api/walkthrough/cancel` | `{ directory, source }` | cancellation result |
| GET `/api/walkthrough` errors carry `{ code?, model?, requiredChars?, availableChars? }` | | |

## 5.31 Magic prompts (src: `packages/web/server/lib/magic-prompts/routes.js`, `runtime.js`)

Prompt overrides for generated prompts (each id matches `^[a-z0-9._-]{1,160}$`; ids ending `.visible` are display-visible; per-file version 1; store `magic-prompts.json` `{ version, overrides: { [id]: text } }`; max text 200 000 chars).

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/magic-prompts` | – | `{ version, overrides }` |
| PUT `/api/magic-prompts/:id` | `{ text }` | state; 400 on invalid id/empty/overlong |
| DELETE `/api/magic-prompts/:id` | – | state (override removed) |
| DELETE `/api/magic-prompts` | – | state (all reset) |

## 5.32 Dev server discovery (src: `packages/web/server/lib/dev-servers/routes.js`)

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/dev-servers` | – | `{ servers: [ { port, pid, command, url } ] }` — **listening sockets** of the machine (lsof → netstat(Win) → /proc/net/tcp*), own ports excluded (`[webPort, openCodePort]`), own pid excluded, URL `http://localhost:<port>/`; scan timeout 2.5 s, 3 s cache; failure → `503 { error:'Port discovery is unavailable', reason: 'netstat-unavailable'\|'no-listener-source' }` (never an empty list, invariant) |

Preview semantics (start/stop/proxy of these servers) belong to **doc 13** (`/api/preview/*`).

## 5.33 Browser control (src: `packages/web/server/lib/browser-control/routes.js`)

| METHOD+PATH | Request | Response | Notes |
|---|---|---|---|
| POST `/api/browser-control/claim` (4 KB) | `{ requestId }` | `{ granted }` | claim before acting; multiple surfaces race to own a browser action |
| POST `/api/browser-control/result` (2 MB) | `{ requestId, ok, data?, error? }` | `{ matched }` (unknown id still `200 { matched:false }`) | resolution callback for `openchamber:browser-control-request` events |

## 5.34 Tunnels (src: `packages/web/server/lib/tunnels/routes.js` — protocol depth in doc 08; one tunnel per instance)

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/openchamber/tunnel/check?provider` | – | `{ available, provider, version? , dependency?, installCommand?, installUrl?, platform, message? }` |
| GET/POST `/api/openchamber/tunnel/doctor?provider&mode&*` (+body) | – | `{ ok:true, provider, providerChecks: [...], modes: [ { mode, checks: [ { id,label,status,detail } ], summary:{ ready, failures, warnings }, ready, blockers } ] }` (400 `{ ok:false, error, code }` for `provider_unsupported`/`mode_unsupported`) |
| GET `/api/openchamber/tunnel/providers` | – | `{ providers: [ capability descriptors (modes, requires) ] }` |
| GET `/api/openchamber/tunnel/status` | – | `{ active, url?, mode, provider, providerMetadata, hasManagedRemoteTunnelToken, managedRemoteTunnelHostname?, managedRemoteTunnelPresets: [ { id,name,hostname } ], managedRemoteTunnelTokenPresetIds, hasBootstrapToken, bootstrapExpiresAt?, policy:'tunnel-gated', activeTunnelMode, activeSessions:[...], localPort, ttlConfig:{ bootstrapTtlMs, sessionTtlMs } }` |
| PUT `/api/openchamber/tunnel/managed-remote-token` | `{ presetId, presetName, managedRemoteTunnelHostname, managedRemoteTunnelToken }` | `{ ok:true, managedRemoteTunnelTokenPresetIds }`; 400 missing fields |
| POST `/api/openchamber/tunnel/start` | `{ provider?, mode?, intent?, configPath?, token?/tunnelToken?/managedRemoteTunnelToken?, hostname?/tunnelHostname?/managedRemoteTunnelHostname?, managedRemoteTunnelPresetId?, managedRemoteTunnelPresetName?, connectTtlMs?, sessionTtlMs? }` | `{ ok:true, url, mode, provider, providerMetadata, managedRemoteTunnelHostname?, managedRemoteTunnelTokenPresetIds, connectUrl: '<publicUrl>/connect?t=<one-time bootstrap token>', bootstrapExpiresAt, replacedTunnel, replaced?: { mode, provider, url }, revokedBootstrapCount, invalidatedSessionCount, policy:'tunnel-gated', activeTunnelMode, activeSessions, localPort, ttlConfig }` — replaces active tunnel & revokes prior artifacts; `422` on unsupported provider/mode; `400` missing dependency |
| POST `/api/openchamber/tunnel/stop` | – | `{ ok:true, revokedBootstrapCount, invalidatedSessionCount }` |

## 5.35 Private relay (src: `packages/web/server/lib/relay/service.js:320-354`; protocol in doc 08)

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/openchamber/relay/status` | gate | `{ state: 'enabled'\|'disabled'\|'standby'\|..., lastError?, connectedClients, relayUrl, serverId? }`-shaped status |
| POST `/api/openchamber/relay/enable` (16 KB) | `{ relayUrl? }` (ws/wss URL; default `wss://relay.openchamber.dev/ws`; env `OPENCHAMBER_RELAY_URL` pins/locks it) | status after forced start (claims the machine host lock) |
| POST `/api/openchamber/relay/disable` | – | status |

## 5.36 Realtime proxy (desktop shell bridge) (src: `packages/web/server/lib/realtime-proxy.js`)

| METHOD+PATH | Request | Response |
|---|---|---|
| GET `/api/openchamber/realtime-proxy/sse?url=<target>` | UI session + origin gate + desktop runtime config present | streams the SSE target (paths allowed: `/api/event`, `/api/global/event`, `/api/openchamber/events`, `/api/notifications/stream`); target must match the configured `apiBaseUrl` origin; headers sanitized (Authorization replaced by the runtime's configured headers) |
| WS `/api/openchamber/realtime-proxy/ws?url=<target>` | same gates | bidirectional WS pipe (allowed targets: `/api/event/ws`, `/api/global/event/ws`, `/api/terminal/ws`) |

Available only when a `getDesktopRuntimeConfig()` returns `{ apiBaseUrl, requestHeaders }` (desktop shell runtime; web runtime returns 404 `{ error:'Realtime proxy is unavailable' }`).

## 5.37 Session status / attention / activity chips (src: `packages/web/server/lib/notifications/routes.js`)

| METHOD+PATH | Request | Response | Notes |
|---|---|---|---|
| GET `/api/push/vapid-public-key` | gate | `{ publicKey }` | VAPID keys generated once and persisted (`push-subscriptions.json` store) |
| POST `/api/push/subscribe` | `{ endpoint, keys: { p256dh, auth }, origin?, platform? }` | `{ ok:true }` | requires a UI session/client token; also records `settings.publicOrigin` from `origin` when first seen |
| DELETE `/api/push/subscribe` | `{ endpoint }` | `{ ok:true }` | |
| POST `/api/push/apns-token` | `{ token, platform: 'ios'|'android', environment: 'sandbox'|'production' }` | `{ ok:true }` | native iOS APNs device tokens (Capacitor), scoped to the UI session |
| DELETE `/api/push/apns-token` | `{ token }` | `{ ok:true }` | |
| POST `/api/push/visibility` | `{ visible: boolean, platform? }` | `{ ok:true }` | drives push suppression and badge resets |
| GET `/api/push/visibility` | UI token | `{ ok:true, visible }` | |
| GET `/api/notifications/stream` | UI token (ensureSessionToken) | SSE: `openchamber:notification-stream-ready { uiToken }` then notification events; heartbeat 20 s | – |
| GET `/api/session-activity` | gate | activity snapshot (cross-tab activity map) | – |
| GET `/api/sessions/snapshot` | gate | `{ statusSessions, attentionSessions, serverTime }` | – |
| GET `/api/sessions/status` | gate | `{ sessions, serverTime }` | – |
| GET `/api/sessions/:id/status` | gate | `{ sessionId, ...state }` or `404 { error:'Session not found or no state available' }` | – |
| GET `/api/sessions/attention` | gate | `{ sessions, serverTime }` | – |
| GET `/api/sessions/:id/attention` | gate | `{ sessionId, ...state }` or 404 | – |
| POST `/api/sessions/:id/view` | gate | `{ success:true, sessionId, viewed:true }` (also clears pending push badge) | – |
| POST `/api/sessions/:id/unview` | gate | `{ success:true, sessionId, viewed:false }` | – |
| POST `/api/sessions/:id/message-sent` | gate | `{ success:true, sessionId, messageSent:true }` (badge reset) | – |

## 5.38 OpenCode-proxied passthrough surface (HARNESS PORTS; payload contract in doc 02)

Everything under `/api/...` not matched by an OpenChamber route flows to the harness (path `/api` prefix stripped). Of note:

- `GET /api/session`, `GET /api/experimental/session` (sanitized list, 4.4),
- `GET /api/event`, `GET /api/global/event` (SSE proxy),
- `POST /api/provider/:providerID/oauth/callback`, `POST /api/mcp/:name/auth/authenticate` (15-min deadline), plus upstream MCP OAuth start endpoints proxied as-is,
- `GET /api/health` (OpenCode health, skip-listed from holds),
- `?directory=` canonicalized on the wire; `x-opencode-directory[-encoding]` header contract honored,
- `/api/themes/custom*` (the harness plugin's dynamic theme endpoint, skip-listed from holds),
- `/api/prompts*` (allowlisted for large bodies; served upstream),
- harness session CRUD (`/api/session/...`), message send endpoints (`prompt_async`, `command`), agents/providers/models/config reads, `/api/config/*` (upstream) for anything not intercepted, `debug/*` etc.

The full passthrough list is "everything else under `/api`" — implementers must treat `/api` plumbing as an **open reverse proxy to the harness with the transformations above**.

---


---

# 5.39 OpenChamber event catalog (SSE + WS consumers)


---

# 5.39 OpenChamber event catalog (SSE + WS consumers)

SSE envelope: `event: <type>\nid?: <id>\ndata: { type, properties, ... }\n\n` (writer `writeSseEvent`; UI listens by `type`). WS frames: `{ type:'event', payload, eventId?, directory? }` (4.4).

| Event `type` | Emitted on | `properties` |
|---|---|---|
| `openchamber:notification-stream-ready` | connect on `/api/notifications/stream` | `{ uiToken }` |
| `openchamber:event-stream-ready` | connect on `/api/openchamber/events` | `{ connectedAt }` |
| `openchamber:heartbeat` | every 25 s on `/api/openchamber/events` | `{ timestamp }` |
| `openchamber:session-created` | after openchamber sessions `create` (SSR service) | `{ sessionId, directory, createdAt, promptDispatched, dispatchedAsCommand, projectId?, title? }` |
| `openchamber:scheduled-task-ran` | scheduled task fired | `{ projectId, taskId, ranAt, status, sessionId? }` |
| `openchamber:worktree-changed` | worktree topology change observed | `{ directories: string[], at }` |
| `openchamber:agent-memory-changed` | agent memory tool wrote memory | `{ scope: 'global'\|'project', projectId? }` |
| `openchamber:message-queue.updated` | any queue mutation | `{ revision, session: { sessionId, directory } }` |
| `openchamber:browser-control-request` | an agent/harness action requests a browser surface | `{ requestId, action, parameters }` (only to browser-capable clients when an action needs a browser view) |
| `openchamber:session-status` | synthetic from forwarded `session.status` (4.4) | `{ sessionID, status, timestamp, metadata: { attempt?, message?, next? }, needsAttention:false }` |
| `openchamber:session-activity` | synthetic from forwarded status | `{ sessionId, phase: 'busy'\|'idle' }` |
| notification payloads | notification triggers/goal settle/restart interruptions | `{ title, body, tag, kind, sessionId?, directory? }` — kinds observed: default session-notify, `goal`, `opencode-restart-interrupted`; `desktopNotificationDelivered` flag present when a platform notification already fired |

Upstream-forwarded (proxied, not produced by OpenChamber): all `session.*` events on `/api/event|/api/global/event` — owner: doc 02.

# 5.40 Observed upstream (harness) endpoints used by OpenChamber internals (HARNESS PORTS; payload authority: doc 02)

These are the paths OpenChamber itself calls through `buildOpenCodeUrl(path, ...)`. A harness replacement must implement these (list is path-level only):

| Upstream call | Used by (OpenChamber side) |
|---|---|
| `GET /global/health` | lifecycle health, version reads, upgrade-status |
| `POST /global/upgrade { target }` | harness upgrade |
| `GET /session`, `GET /session?directory=`, `GET /experimental/session` | sanitized list proxy, PWA shortcuts, Windows merge |
| `GET /session/:id/message` (list) | session knowledge / walkthrough digest consumers |
| `POST /session/:id/message` family, `POST /session/:id/prompt_async`, `POST /session/:id/command` | message queue delivery, openchamber sessions send/dispatch (doc 12/02 own the shapes) |
| `POST /session/:id/...` permission/abort/command endpoints | permission-auto-accept processor |
| `GET /event`, `GET /global/event` (SSE) | global watcher (hub), directory-scoped streams |
| `POST /provider/:providerID/oauth/callback`, `POST /mcp/:name/auth/*` | OAuth proxies (15-min deadline) |
| `GET /provider`, `GET /agent`, `GET /config/*` harness reads | model/agent pickers via passthrough proxy |
| `GET /app/skills?directory=` | skills list merge (SDK `client.app.skills`, 8 s timeout) |
| `POST /mcp/:id/auth/callback { code }` | MCP OAuth callback completion |

---

---

# 13. End-to-end flows (numbered)

## 14.1 Flow A — Unauthenticated browser onboarding (no UI password)

1. Browser GET `/` → static `index.html` (3.2); `X-Robots-Tag: noindex, nofollow` header present.
2. SPA probes `GET /auth/session` → `{ authenticated:true, disabled:true }` (auth is off).
3. SPA calls gated `/api/config/settings` — the `/api` gate can require no credential when no password is configured; push subscription mint (`POST /auth/url-token`) issues `oc_url_*` for embedded-media paths when needed.
4. UI stays on local-origin fetches; SSE/WS subscription (4.4) rides the same-origin cookies.

## 14.2 Flow B — Password-protected onboarding

1. `GET /auth/session` → `401 { authenticated:false, locked:true }`.
2. UI shows inline login (the app shell loads without auth; that is why robots noindex exists).
3. `POST /auth/session { password, trustDevice? }` → rate-limited (2.5), on success sets `oc_ui_session` cookie; optional `issueClientToken:true` mints a device token in the same response.
4. Passkey path: `GET /auth/passkey/status` → options/verify endpoints — same cookie outcome.
5. All `/api/*` calls now pass the gate; WS upgrades pass the origin+auth checks.

## 14.3 Flow C — Tunnel onboarding (one-time link)

1. Operator starts a tunnel (UI `POST /api/openchamber/tunnel/start` or CLI `tunnel start`) — response includes `connectUrl = <publicUrl>/connect?t=<bootstrap>`.
2. Remote browser opens `connectUrl`: rate-limit check → token hash compare (single-use) → `oc_tunnel_session` cookie set → `302 → /`.
3. All requests through the tunnel host now classify as `tunnel` scope; password/passkey logins and passkey management return 403 `tunnelLocked`.
4. `GET /auth/session` answers `{ authenticated:true, scope:'tunnel' }`.
5. Tunnel stop/replace → `revokeTunnelArtifacts` invalidates sessions + bootstrap; remote browsers get 401s on next check.

## 14.4 Flow D — Device pairing (mobile/desktop app)

1. Operator (UI session) `POST /api/client-auth/pairing/sessions { label?, allowedClientKinds?, includeRelay?, serverUrl? }` → response `{ pairing, secret, server: { label, candidates } }`; the UI renders the `openchamber://connect?v=2&p=<payload>` QR (payload = base64url pairing id + secret + candidates).
(The CLI path, 10.1 `connect-url`, calls the same server API directly.)
2. Device scans; client races candidates (direct URL first, then relay), `POST /api/client-auth/pairing/redeem { pairingId, secret, ...device meta, dedupeKey }` (rate-limited 10/5 min per IP+pairingId).
3. Success → `{ ok, server: { label, url, fingerprint }, client, clientToken }`; device stores `oc_client_...` token; store updated (`pairing.usedAt`, `client.dedupeKey = pairing:<id>`); relay demand re-evaluated; the pairing secret is burned (one-time).
4. Subsequent calls: `Authorization: Bearer oc_client_...` → hashed lookup; `desktop-local` tokens get management powers; others are self-scoped.
5. Revocation: UI/CLI `DELETE /api/client-auth/clients/:id` → 401s everywhere; `DELETE /api/client-auth/clients` purges.

## 14.5 Flow E — Upstream read during worktree bootstrap (why `/api` holds)

1. Session create in a new chat worktree triggers a bootstrap job (git clone/checkout + setup).
2. A client `GET /api/session?directory=<worktree>` passes the OpenChamber gate (5.2), enters the proxy pipeline, carries the directory; the worktree-hold middleware polls `GET /api/git/worktrees/bootstrap-status`-equivalent state and holds until ready.
3. On `failed` → 503 with the bootstrap error; after 5 min → timeout 503.
4. Meanwhile other (non-directory) requests are unaffected; doc 04 describes the client retry UX.

## 14.6 Flow F — Restart of the harness (managed)

1. Health check fails/restart requested → kill port → wait release → spawn new process (possibly new port).
2. `onOpenCodeRestarted`: provider cache reset; message-stream `rebindUpstream()` (global hub restarts; directory sockets closed with 1012 so clients reconnect with `Last-Event-ID`); busy sessions interrupted and the affected users are notified (`opencode-restart-interrupted`).
3. In-flight proxy requests on the old port drain/fail with 503 (`OpenCode service unavailable`) — no partial-content masking.

## 14.7 Flow G — Queued message delivery (summary; owner: doc 12)

1. `POST /api/message-queue/sessions/:sid/items` (client cannot deliver while busy) → persisted (§7), broadcast.
2. Hub event `session.status=idle` → 150-500 ms quiet timer coalesces → tick: verify idleness upstream → mark in-flight → deliver `/prompt_async` (or `/command` for slash commands without context) with parts order: text, files, captured context, skill note, pending project knowledge, agent mention.
3. Success → item removed, persisted, broadcast, notification "user message sent" marked. Failure → item kept, 2 s → 60 s exponential per-item backoff.
4. Holds (`PUT .../hold { held, ttlMs? }`) suppress dispatch (auto-review loops); hold TTL default 5 min, cap 10 min.

---

# 6. Per-module deep specs (high-value invariants)

## 6.1 fs (files, workspace boundaries, uploads)

- Workspace resolution (src: `fs/routes.js:199-302`): `path.resolve()` the target → containment check against (a) the active workspace directory derived per request, (b) managed roots = OpenChamber config root + managed chats root, (c) worktrees of the active project. Symlinked workspace roots retry against the *requested* (non-canonical) base so the file tree stays addressable; writes/exec always re-check canonical containment (`realpath` of target inside `realpath` of base).
- Outside-workspace read grants (`mintOutsideFileGrant`): token = UUID, bound to the **canonical** path (re-verified per request), scopes subset of `{ stat, read, raw }`, TTL **10 min**; only the `stat/read/raw` family accepts `allowOutsideWorkspace=true&outsideFileGrant=...`. `serve` rejects the mechanism; `mkdir` rejects outside entirely.
- Uploads: single raw body (`application/octet-stream` only), cap default **100 MiB** (`OPENCHAMBER_FS_UPLOAD_MAX_BYTES`), streamed to a sibling temp file then atomically committed (`rename` for overwrite; `link`+`unlink` = no-clobber for new); 409 conflicts without overwrite; symlink-escape via parent resolution blocked.
- Writes: temp+rename atomic; identical content short-circuits success.
- Exec: sequential shell commands (`$SHELL -c` / `cmd.exe /c`), 5-min per-job timeout default (`OPENCHAMBER_FS_EXEC_TIMEOUT_MS`), PATH augmented with known tool dirs; background mode refused; job store in-memory TTL 30 min; only whitelisted `git rev-parse` reads are cached (30 s TTL, 500 entries/1 MB cap).
- `/api/fs/list` treats a missing `.../.opencode/plans` as empty success (plans dir created lazily by OpenChamber surfaces).
- `/api/fs/home` response `{ home, chatsRoot }` — clients must use `chatsRoot`, never `home + '/chats'` (root may relocate via `OPENCHAMBER_CHATS_DIR`).

## 6.2 git

- Service = wrapper around `simple-git` + direct spawns with SSH env (`SSH_AUTH_SOCK` resolution), identity profiles in `~/.config/openchamber/git-identities.json` (legacy path; see 7.3).
- Index mutations serialized (stage/unstage/apply-hunk/commit share one queue); apply-hunk verifies patch matches exactly one current 3-context hunk and passes `git apply --check`.
- Worktree topology change detection: no watcher; observed (a) after server-created worktree ops, (b) opportunistically during `/api/git/status` and `/api/git/worktrees` calls; fingerprint = `worktrees` dir mtime+entries under the common git dir; LRU caps 500 dirs / 200 repos / 100 dirs-per-repo; notifies via SSE `openchamber:worktree-changed { directories, at }`.
- `checkout` reports the actually-checked-out branch; remote-tracking names become local `--track` branches.
- Pull/push/fetch support identity profiles via `core.sshCommand` and `ssh -i` with strict argument escaping; clone validates SSH key paths (`400 'SSH key path contains invalid characters: ...'`) and sets `GIT_TERMINAL_PROMPT=0`.
- Status semantics for non-repos: `{ isGitRepository:false, files:[], branch:null, ahead:0, behind:0 }` (200, not error) — callers enumerating projects/sessions never break.

## 6.3 Notifications (web push, APNs, desktop, SSE)

- Desktop notifications: enabled when `OPENCHAMBER_DESKTOP_NOTIFY=true` or `OPENCHAMBER_RUNTIME=desktop` or process name contains `openchamber-server` (src: `index.js:641-653`); emitted via prefixed console protocol `[OpenChamberDesktopNotify] <json>` for the parent (Electron) to consume; broadcast to SSE + WS clients as notification events with `desktopNotificationDelivered` flag so clients avoid duplicates.
- Web push: VAPID keys generated once, stored; subscriptions (per UI session token) stored in `<data-dir>/push-subscriptions.json`; delivery suppressed while any interactive client visible; badge counter cleared on become-visible/view/message-sent.
- APNs: device tokens in `<data-dir>/apns-tokens.json` with an `environment` field distinguishing sandbox/production; HTTP/2 provider via `node:http2`.
- Trigger eval lives in `notifications/runtime.js` (generates via **small model** when configured — title/body templates with variables; falls back to Zen cached models) but payload-shape ownership is doc 04/UI. Notification delivery races (suppressed auto-accept permissions) prevented by the server-side auto-accept mirror loop.
- Notification settings toggles (e.g. `notifyOnCompletion`) live in settings.json and are consulted by trigger + goal notifications.

## 6.4 text/summarization & tts pipelines

- `POST /api/text/summarize` is heuristic-only (no model): mode `tts` sanitizes for speech (strips markdown/code), mode `note` sanitizes for importability. It never fails the caller.
- OpenAI TTS server pipeline: settings/server key or client key or custom OpenAI-compatible base URL; returns whole audio buffer (stream internally, buffer out).
- macOS `say` pipeline: capability probe cached at boot; speak runs `say -v <voice> -r <rate> -o <tmp>.m4a --data-format=aac`, reads file, deletes it; `language:'auto'` swaps voices by detected language when needed.
- STT pipeline (`/api/stt/transcribe`): raw audio ≤ 20 MB → OpenAI-compatible `/audio/transcriptions`-style endpoint, `X-Base-URL` required, default model `deepdml/faster-whisper-large-v3-turbo-ct2`.
- Dictation: local models via sherpa-onnx-node workers in `<data-root>/speech-models`; WS protocol documented in 5.26/header of `dictation/runtime.js` (frames enumerated exactly there).

## 6.5 GitHub & Linear

- GitHub device flow: client id from `OPENCHAMBER_GITHUB_CLIENT_ID`; multi-account store (active + gh-cli source toggle); octokit calls wrapped; PR cache LRU.
- Linear: OAuth via `startAuthorization` (web/desktop origin), callback page (self-contained HTML; `openchamber://focus/linear-auth` deep link from desktop), broker-poll for device-anchored flows on every `auth/status` read; refresh flow (`getValidLinearAccessToken`), token revoke on disconnect; team→project mapping persisted (`readStoredLinearMapping`); optional session status comments per session (`session-status` route; runtime status processor `createLinearSessionStatusRuntime` reacts to hub events in-process and posts updates when `sessionComments` enabled).
- Token storage: `linear-auth` in the OpenChamber config dir (multi-workspace record set, 0600). Tokens never logged.

## 6.6 markdown-image-grants

- Assistant-message markdown images (`![...](...)`) are resolved to real files on disk; the route mints **10-minute raw-only** path-grants for files outside the workspace (or in the OpenCode-approved temp root) so a browser can render them without giving away the whole FS. Sources limited to 1–12; other statuses: `missing`, `pruned`, `oversized`, `unsupported`, `error`.

## 6.7 permission-auto-accept persistence

- Settings-backed (`permissionAutoAccept` group) + in-memory session map; event-driven processor answers permission requests (via upstream session API) when enabled globally or per session; broadcasts OpenChamber events on policy changes; notifications suppressed for auto-accepted permissions (per-session mirror API `POST /api/notifications/auto-accept` keeps the client and server agreeable).

## 6.8 magic-prompts

- Overrides ship into notification/goal template generation and (doc 12) prompt builders; file format `{ version:1, overrides:{ [id<=160 chars]: text<=200k } }`; delete-all supports reset-to-default.

## 6.9 context-obligatory

- Server-side processor that "obligates context" for each sent message: routes that dispatch prompts (openchamber sessions send, message queue dispatch, scheduled task runs) consult `sessionKnowledgeRuntime` and attach pending project knowledge (notes/plans/memory) before hitting upstream; delivery is recorded only after success; failures never break the send. No routes of its own (wraps session-knowledge routes + hub events).

## 6.10 OpenChamber sessions service (managed chats)

- Creates sessions with optional **chat worktree** under the managed chats root (`<data-root>/chats` or `OPENCHAMBER_CHATS_DIR`); validates directories via `validateDirectoryPath` (must exist / be dir / realpath-resolve; rejects traversal); optional immediate prompt dispatch (with knowledge block); emits `openchamber:session-created`.
- `create`/`archive`/`send`/`fork` share the control error envelope; agent-tool and `/api/openchamber/control` reuse it.

---

# 7. Data layout on disk

Everything OpenChamber owns hangs off one root:

- `OPENCHAMBER_DATA_DIR` (default `~/.config/openchamber`). Constants (src: `index.js:276-326`, `cli-paths.js`):

```
<data-root>/
  settings.json                      ← master config + runtime state (0600, atomic tmp+rename)
  jwt-secret                         ← UI session JWT signing secret (0600; generated once; overwritten by /api/auth/reset)
  push-subscriptions.json            ← web push subscriptions per UI session
  apns-tokens.json                   ← APNs device tokens
  remote-clients.json                ← paired device records (tokenHash only)
  client-pairing-sessions.json       ← pending pairing sessions
  cloudflare-managed-remote-tunnels.json  ← v1 managed-remote tunnel presets (id,name,hostname,token)
  cloudflare-named-tunnels.json      ← legacy named-tunnel store
  magic-prompts.json                 ← prompt overrides { version, overrides }
  message-queue.json                 ← queued messages { version, revision, sessions: { [sid]: { directory, items } } }; corrupt files move to message-queue.json.corrupt-<ts>
  sessions-directories.json          ← session folders snapshot { version, foldersMap, collapsedFolderIds, updatedAt }
  relay-host.lock                    ← { pid } per-machine relay host claim
  git-identities.json                ← git identity profiles (legacy home path, see below)
  install-id-web / install-id-desktop-electron / install-id-vscode / install-id-mobile-capacitor
  update-install.log                 ← self-update logs
  projects/
    <projectId>.json                 ← per-project: setup commands, actions, draft starters, notes, todos, scheduled tasks, pinned dirs
    ... (shared plan mirror lives in the project checkout; see project-context)
  themes/                            ← custom theme JSON files (≤512 KiB each)
  speech-models/                     ← local dictation/STT models (sherpa-onnx)
  chats/                             ← managed chat worktrees (OPENCHAMBER_CHATS_DIR relocates)
  goals/<sessionId>/objective.md     ← session goal objectives
  project-icons/project-<sha1(projectId)>.<ext>
  logs/openchamber-<port>.log        ← daemon logs (rotated: .1, .2 suffixes)
  run/openchamber-<port>.json        ← instance registry: { port, host, launchMode: 'foreground'|'daemon', uiPassword?, apiOnly? } + pid file openchamber-<port>.pid
  tunnel-profiles.json               ← CLI tunnel profiles (redacted on output)
  tunnel-cli-state.json              ← CLI tunnel UI state (lastManagedLocalConfigPath)
```

- Relay identity + config live in `settings.json` (`privateRelay: { enabled, relayUrl }`, identity keys/signing material per `relay/identity.js`) — one relay identity per data dir.
- **Legacy-path exception**: `git-identities.json` uses `~/.config/openchamber` unconditionally (src: `git/identity-storage.js`), i.e. it does not follow `OPENCHAMBER_DATA_DIR`. Replicate or fix deliberately.
- `migrateLegacyUserDirs` copies `projects/`, `themes/`, `speech-models/` from the default root into the configured root once at boot (copy, not move; failure removes partial copy) (src: `data-dir-migration.js`).

## 7.2 settings.json groups (observed keys)

Sanitization and merge are strict (unknown keys preserved; known keys normalized). Groups (src: `settings-normalization-runtime.js`, `settings-helpers.js`):

- Navigation/projects: `projects: [ { id, path (canonical), addedAt, lastOpenedAt, iconImage?: { mime, updatedAt, source: 'custom'|'auto' } } ]`, `activeProjectId`, `lastDirectory`, `homeDirectory`, `pinnedDirectories`.
- Appearance/theme: `themeId, themeVariant ('light'|'dark'), useSystemTheme, lightThemeId, darkThemeId, splashBgLight, splashFgLight, splashBgDark, splashFgDark, pwaAppName, pwaOrientation ('portrait'|'landscape'|'system')`.
- Session defaults/UI: `showReasoningTraces, collapsibleThinkingBlocks, inputHistoryScope, workStatusPanelEnabled, workStatusHiddenSectionsExplicit`, per-surface settings (`X-OpenChamber-Surface`).
- Harness env: `opencodeBinary` (path), `AGENT-related toggles agentControlToolEnabled (default true), agentWebToolEnabled (default true), agentMemoryToolEnabled (default false), optimizeSystemPrompt (default false)`.
- Scheduler/tasks: `notifyOnCompletion` + task schedules under projects' files.
- Tunnel: `tunnelProvider ('cloudflare'|'ngrok'), tunnelMode ('quick'|'managed-local'|'managed-remote'), managedLocalTunnelConfigPath, managedRemoteTunnelHostname, managedRemoteTunnelToken, managedRemoteTunnelPresets?, tunnelBootstrapTtlMs (null=instant-expire semantics; else 1m..24h), tunnelSessionTtlMs (5m..30d)`.
- Skills: `skillCatalogs: [ { id, label, source, subpath, gitIdentityId } ]`.
- Permissions: `permissionAutoAccept` (policy + per-session).
- Desktop app prefs: `desktopLanAccessEnabled, desktopKeepAwakeEnabled, desktopMinimizeToTrayEnabled, desktopMacMenuBarEnabled, desktopWindowControlsPosition, desktopWindowControlsStyle`, `desktopLocalPort`, `desktopLocalClientToken`.
- Web push: `publicOrigin` (recorded from first web-push subscribe), VAPID keys.
- Relay: `privateRelay { enabled, relayUrl }` + identity keys.
- Message queue/other runtimes read settings sparingly.

Writes: read-modify-write with `sanitizeSettingsUpdate`, atomic (tmp+rename, 0600), strict readers available (`readSettingsFromDiskStrict`) that **throw** on corrupt payload — certain flows (relay identity, CLI settings accessors) deliberately refuse to proceed on corrupt state rather than regenerating keys (a generated replacement would change `serverId` and orphan devices).

## 7.3 Migration strategy

- `data-dir-migration.js`: one-time **copy** of user folders (above). No schema migrations for JSON stores beyond per-file `version`/normalizers: each store module `normalizeStore()`s unknown/corrupt payloads into the current shape and drops invalid entries (message-queue being the exception: corrupt → move aside, start empty).
- Legacy flags in CLI: removed flags (`--try-cf-tunnel`, `--tunnel-*` on serve) hard-error with remediation text; tunnel profile migration promotes `cloudflare-managed-remote-tunnels.json` → `tunnel-profiles.json` on first tunnel command (CLI, with file-permission warnings).

---

# 8. Auth and security posture

## 8.1 Threat model summary

- The server is addressed by: (a) loopback browsers, (b) LAN clients (only when bound non-loopback; requires UI password), (c) **tunnel** URLs (public hostname), (d) paired **client apps** (desktop shell, mobile) via direct URLs or the relay, and (e) the local machine. Auth is per-scope:

| Scope (classifyRequestScope) | Determined by | Required credential |
|---|---|---|
| `local` | Host header is localhost/loopback/private IP **and** socket remote IP is loopback/private | UI session cookie, client bearer, or (read-only paths) URL token |
| `tunnel` | Host header equals the active tunnel's host | Tunnel session cookie (`oc_tunnel_session`) — or client bearer |
| `unknown-public` | Not tunnel, not local | Tunnel session cookie or client bearer (same as tunnel; password login disabled) |

## 8.2 UI password (browser sessions)

- Configured via `--ui-password` or `OPENCHAMBER_UI_PASSWORD`. Stored **in RAM only** (scrypt sync, 64-byte hash, random 16-byte salt, timingSafeEqual). Not persisted by the server itself (the CLI persists it into the run-file for restart flows; 0600).
- Session: JWT (HS256) signed with a 32-byte secret; secret order: `OPENCODE_JWT_SECRET` env → `<data-root>/jwt-secret` file → generated+persisted (0600). Cookie `oc_ui_session` (encodeURIComponent'd), HttpOnly, SameSite=**Strict**, Path=/, Secure when TLS (direct or `x-forwarded-proto:https`), TTL **12 h** (7 d with `trustDevice:true`).
- Login rate limiting: per-IP keys (XFF first hop), window 5 min (10 attempts default / 3 without IP), lockout 15 min, X-RateLimit headers, hourly sweep. Passkeys (WebAuthn via `@simplewebauthn/server`) follow the same gates; password binding key derives from the JWT secret + password so passkeys invalidate when the secret rotates.
- Reset (`POST /api/auth/reset`): rotates JWT secret (all sessions die), clears passkeys + cookie. Not allowed while `OPENCODE_JWT_SECRET` env is set (400).
- URL tokens (`oc_url_*`, 60 s TTL, in-memory): minted by authenticated callers (`POST /auth/url-token`) to hand *read-only/WS-allowlisted* paths to e.g. a QR-scanned preview: allowed paths — `GET /api/event`, `/api/global/event`, `/api/openchamber/events`, `/api/openchamber/realtime-proxy/sse`, `/api/notifications/stream`, `/api/fs/raw`, `/api/fs/serve(/...)`, `/api/preview/proxy/*`, `/api/projects/:id/icon`; WS: `/api/event/ws`, `/api/global/event/ws`, `/api/openchamber/realtime-proxy/ws`, `/api/terminal/ws`, `/api/dictation/ws`, `/api/dev-tunnel`, `/api/preview/proxy/*` (src: `ui-auth.js:294-315`). Sweep in-memory; nothing persisted.

## 8.3 Client tokens (paired devices)

- Format `oc_client_` + 32 random bytes base64url (~43 chars). Stored hashed (sha256 hex) in `remote-clients.json` (0600, atomic write, mutation-serialized). Record fields incl. `clientKind` (`desktop`, `mobile`, `desktop-local`), `authMethod` (`password`|`passkey`|`pairing`), device metadata, `usesRelay`, `lastTransport`, `expiresAt`.
- Auth: `Authorization: Bearer oc_client_...`; constant-time hash compare; expiry respected; `lastUsedAt` throttle 60 s (immediate write when transport flips direct↔relay). Desktop-local client (`clientKind: 'desktop-local'`) is the trusted operator (device management, client creation); other tokens are scoped to themselves.
- Transport signal: relay-forwarded requests carry `x-openchamber-relay-connection` (stamp added by the relay host client); `usesRelay` self-heals on observed relay traffic (sticky) and feeds relay demand.

## 8.4 One-time connect links & tunnel sessions (short format spec; full protocol in doc 08)

- Bootstrap token: 32 random bytes base64url; only **one** live bootstrap token per active tunnel (minting revokes the previous); stored hashed; single-use (`usedAt`), TTL = `tunnelBootstrapTtlMs` (default 30 min, min 1 min, max 24 h); link form: `<publicUrl>/connect?t=<token>`.
- Tunnel session cookie `oc_tunnel_session`: 32 random bytes base64url, HttpOnly, SameSite=**Lax**, TTL `tunnelSessionTtlMs` (default 8 h, min 5 min, max 30 d). Revoked on tunnel stop/replace (`revokedBootstrapCount`, `invalidatedSessionCount` reported by start/stop routes).
- Rate limit on `/connect`: window 5 min, 20 attempts/IP (5 without IP), lock 10 min.
- Pairing redeem rate-limit: see 5.3. Device pairing link format: `openchamber://connect?v=2&p=<base64url payload>` where payload = one-time `{ pairingId, secret, serverLabel, candidates[] }` (candidates incl. relay) — the **QR itself is the secret**; no embedded token (src: `bin/lib/DOCUMENTATION.md:55-58`).

## 8.5 Trusted-proxy handling

- `app.set('trust proxy', true)`: `req.ip/hostname` honor `X-Forwarded-*`, EXCEPT where the code deliberately reads the raw socket instead — pairing redeem rate limiting and tunnel scope classification use `req.socket.remoteAddress`/headers directly (anti-spoof: unauthenticated paths never trust the client-printed IP, src: `core-routes.js:473-477`).
- `x-forwarded-proto` decides Secure cookies; `x-openchamber-relay-connection` decides relay transport classification; `Ngrok-Skip-Browser-Warning` is in the CORS allowlist (ngrok interstitial bypass).

## 8.6 Origin policy (CSRF/WS)

- WS/SSE upgrades and realtime routes require **Origin match**: `isRequestOriginAllowed` (src: `security/request-security.js`) — packaged app origins pass; otherwise the Origin's host must equal the Host header (or `X-Forwarded-Host`), or one of the derived candidate origins (`protocol://host` incl. localhost↔127.0.0.1↔[::1] aliases and settings `publicOrigin`). Failures rejected with 403 (`WebSocket upgrade` path: raw HTTP 403 then socket destroy).
- Same-origin SPA needs no CORS; the CORS middleware (2) only whitelists packaged/dev origins. `Options` preflight answered 204.
- Tunnel scope: password/passkey login & passkey management & auth reset are **hard-blocked** (403 `tunnelLocked`) — the tunnel bootstrap link is the only way in; probe/shutdown route differences listed per row in Section 5.

## 8.7 Path traversal defenses (inventory)

- FS routes: `normalizeDirectoryPath` (`~` expansion; resolve; reject empty), containment re-checks incl. `realpath` canonicalization for writes/uploads (symlink escape → 403), uploads stat the resolved parent, `serve`/`raw` resolve symlinks then stat (must be file).
- Skill files: `isUnsafeSkillRelativePath` (dot-segments, absolute, backslash patterns) → 400.
- Directory validation (`validateDirectoryPath`) for project/harness directories: realpath, exists, is-dir.
- Clone destinations: basename validated (no `.`/`..`); destination parent must exist/createable; existing target → 409.
- Git worktree ops: names cleaned of `refs/` prefixes; ref validation by git itself; commit hashes regex-validated `^[0-9a-fA-F]{7,40}$`.
- `/api/system/probe-url`: strictly loopback URL policy (hostname in `localhost|127.0.0.1|::1|0.0.0.0`, http/https only).
- Managed roots rule: FS writes inside the OpenChamber data root and chats root are always legal targets even without an active workspace (chat worktree files) — but never the contrary (workspace ops can't leave the workspace).

## 8.8 CORS / other

- `X-Robots-Tag: noindex, nofollow` + robots.txt (3).
- Response body limit at the JSON-parser level only (per-prefix policy, 2.6); upload/stream bodies bounded by route code.
- Token hygiene invariant: client Authorization header is stripped before any upstream forward (`proxy-headers.js` filtered request headers; realtime-proxy header sanitizer drops `Authorization` too and merges only the desktop runtime's configured headers).

## 8.9 Failure semantics (invariants carried)

- One failed entity never erases unrelated ones (worktree endpoint 500 vs empty-list semantics; dev-servers 503 not empty; message-queue corrupt file → file moved aside, runtime starts empty; relay demand check failure → reconcile throws, relay state preserved).
- Read failures are never silent-empty for discovery surfaces described above.
- Store writes 0600 + 0700 dirs; atomic tmp+rename with cleanup on failure; serialized mutation queues per store (clients, pairing, settings via runtime, session folders saveQueue, message-queue write chain, git index queue).

---

# 9. Environment variable reference (complete)

| Variable | Default | Meaning |
|---|---|---|
| `OPENCHAMBER_HOST` | `127.0.0.1` | Bind host for the web server (overridden by `--host/--lan`) |
| `OPENCHAMBER_PORT` | 3000 (CLI) | Target port; set by the serving CLI when spawning the daemon (not read by the server itself — the CLI passes `--port`) |
| `OPENCHAMBER_UI_PASSWORD` | unset | UI password; empty disables browser auth (LAN bind then refuses unless `OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN=true`) |
| `OPENCODE_UI_PASSWORD` | unset | Alias read by the server module (`OPENCHAMBER_UI_PASSWORD` wins) |
| `OPENCHAMBER_API_ONLY` | `true|1` | Start API-only (no UI assets) |
| `OPENCHAMBER_DATA_DIR` | `~/.config/openchamber` | OpenChamber data root (Section 7) |
| `OPENCHAMBER_CHATS_DIR` | `<data-root>/chats` | Managed chat worktree root (for separate-user harness deployments) |
| `OPENCHAMBER_RUNTIME` | `web` | Runtime name (`desktop` for the Electron shell; changes compression policy, desktop notify, desktop-update plumbing) |
| `OPENCHAMBER_VERBOSE_REQUEST_LOGS` | off | Per-request log line for every HTTP request |
| `OPENCHAMBER_SKIP_API_COMPRESSION` | off | Disable gzip for `/api/*` |
| `OPENCHAMBER_COMPRESS_API` | desktop→off, else on | Force (`true`) or disable (`false`) `/api/*` compression |
| `OPENCHAMBER_FS_UPLOAD_MAX_BYTES` | 104857600 (100 MiB) | Upload cap (`/api/fs/upload`) |
| `OPENCHAMBER_FS_EXEC_TIMEOUT_MS` | 300000 (5 min) | Per-`/api/fs/exec` job timeout |
| `OPENCHAMBER_GIT_READ_CACHE_TTL_MS` | 30000 (0 disables) | Cache TTL for whitelisted `git rev-parse` exec plumbing |
| `OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS` | 2500 | `git check-ignore` timeout in `/api/fs/list` |
| `OPENCHAMBER_RATE_LIMIT_MAX_ATTEMPTS` | 10 | Login attempts per IP per 5-min window |
| `OPENCHAMBER_RATE_LIMIT_NO_IP_MAX_ATTEMPTS` | 3 | Attempts when the client IP is unresolvable |
| `OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN` | off | `true` permits LAN bind without UI password (explicit risk acceptance) |
| `OPENCHAMBER_DIST_DIR` | `<repo>/dist` | UI asset dir override |
| `OPENCHAMBER_DESKTOP_NOTIFY` | off | Enable desktop-notify stdout protocol in web runtime |
| `OPENCHAMBER_DEV_SHUTDOWN` | off | Enables `POST /api/system/dev-shutdown` (dev only) |
| `OPENCHAMBER_UPDATE_API_URL` | `https://api.openchamber.dev/v1/update/check` | Update channel endpoint |
| `OPENCHAMBER_SYSTEMD_UNIT` | `openchamber.service` | Unit restarted after foreground update (pattern `^[A-Za-z0-9:_.@-]+\.service$`) |
| `OPENCHAMBER_GITHUB_CLIENT_ID` | unset | GitHub OAuth device-flow client id (required for GitHub connect) |
| `OPENCHAMBER_RELAY_URL` | `wss://relay.openchamber.dev/ws` | Pins/locks the private relay endpoint (overrides the setting) |
| `OPENCHAMBER_RELAY_HOST` | unset | `off` disables passive relay hosting; `on` overrides dev suppressions |
| `OPENCHAMBER_ELECTRON_DEV` | off | `1` marks the dev Electron shell (suppress passive relay hosting) |
| `OPENCHAMBER_TERMINAL_SHELL` | platform default | Preferred terminal shell for the Auto option (before platform defaults) (README) |
| `OPENCHAMBER_OPENCODE_HOSTNAME` | `127.0.0.1` | Bind host for the managed harness (validated; invalid → warn + loopback) |
| `OPENCHAMBER_OPENCODE_PORT`, `OPENCHAMBER_INTERNAL_PORT` | unset | Aliases for `OPENCODE_PORT` |
| `OPENCHAMBER_SKIP_OPENCODE_START` | off | Alias for `OPENCODE_SKIP_START` |
| `OPENCHAMBER_TRY_CF_TUNNEL` | off | Legacy env for one-shot Cloudflare quick tunnel at boot |
| `OPENCHAMBER_TUNNEL_MODE` / `OPENCHAMBER_TUNNEL_PROVIDER` | unset | Startup tunnel (`quick`/`managed-local`/`managed-remote`, provider `cloudflare`/`ngrok`) |
| `OPENCHAMBER_TUNNEL_CONFIG` | unset | Managed-local config path at boot |
| `OPENCHAMBER_TUNNEL_TOKEN`, `OPENCHAMBER_TUNNEL_HOSTNAME` | unset | Managed-remote token/hostname at boot |
| `UI_PASSWORD` | unset (Docker compose convention) | Docker-readme convenience alias; the server reads `OPENCHAMBER_UI_PASSWORD` |
| `OPENCODE_HOST` | unset | External harness base URL (must be `http(s)://host:port` exactly; overrides port) |
| `OPENCODE_PORT` | unset | External harness port (attach mode) |
| `OPENCODE_SKIP_START` | off | Attach to external harness, don't launch |
| `OPENCODE_BINARY` | unset | Explicit harness/cli binary path (invalid → warn, PATH fallback) |
| `OPENCODE_API_PREFIX`, `OPENCHAMBER_API_PREFIX` | unset | **Ignored** with a console warning ("API runs at root") |
| `OPENCODE_JWT_SECRET` | unset | Fixed JWT secret (disables `/api/auth/reset` rotation; passkey binding key derives from it) |
| `OPENCODE_CONFIG_DIR` | unset | Harness config dir passthrough |
| `OPENCODE_CONFIG_CONTENT` | unset | Harness inline config content (merged with plugin-injected content) |
| `OPENCODE_EXPERIMENTAL_PLAN_MODE`, `OPENCODE_EXPERIMENTAL` | off | Surfaces `planModeExperimentalEnabled` on health |
| `OPENCODE_DISABLE_EXTERNAL_SKILLS`, `OPENCODE_DISABLE_CLAUDE_CODE`, `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` | off | Reported via `/api/config/skills.externalSkills` (harness reads them) |
| `OPENAI_API_KEY` | unset | Enables `/api/voice/token` gating and server-side OpenAI TTS |
| `BUN_BINARY`, `BUN_INSTALL` | unset | CLI bun resolution (BUN_INSTALL/bin/bun[.exe]) |
| `OPENCHAMBER_PORT` (CLI child env) | – | Passed to the spawned daemon by `serve` (server reads `--port` argv primarily) |

HARNESS PORTS label: everything named `OPENCODE_*` or `OPENCHAMBER_OPENCODE_*`/`OPENCHAMBER_SKIP_OPENCODE_START` configures or attaches the agent harness.

---

# 10. CLI specification

Binary: `openchamber` (`bin/cli.js`; shebang `#!/usr/bin/env node`). Framework: `@clack/prompts` for human output. Global behavior rules (src: `bin/lib/cli-output.js`, `bin/lib/DOCUMENTATION.md`):

- **Output modes** (per command): normal human (TTY decorations), `--quiet` (concise essentials), `--json` (a single JSON document on stdout, no other output). If both `--json` and `--quiet`: `--json` wins.
- Human decorations disabled when: `!process.stdout.isTTY`, or `NO_COLOR=1`, or `--plain`.
- Prompts (spinner/progress/confirm) only when `shouldRenderHumanOutput(options) && isTTY` (`canPrompt`); a piped stdin (e.g. `--token-stdin`) disables prompts.
- JSON status normalization: `status` field coerced to `ok|warning|error` from `messages[].level` when absent. Unknown command → error + Levenshtein suggestion (≤3 edits), exit 2.
- Exit codes (src: `bin/lib/cli-errors.js`): `0` success; `1` general error; `2` usage error; `3` missing dependency; `4` auth/config error; `5` network/runtime error. `SIGINT` → 130 (CLI-side), foreground server shutdown: SIGINT 130, SIGQUIT 131, SIGTERM 143.
- Modes: background/daemon default. All mode-sensitive outputs listed per command below.

## 10.1 Command inventory & flags

Flags are parsed by the shared parser (`bin/lib/cli-args.js`); long or `--foo=value` forms both accepted. Common flags: `-p/--port <port>` (1–65535; negative numbers surface a range error rather than "unknown option"), `--host <address>` (alias `--hostname` outside tunnel commands), `--lan` (host:=0.0.0.0), `--ui-password [password]` (empty generates one and prints it once), `--api-only`, `--foreground` (alias `--no-daemon`), `-d/--daemon` accepted as no-op, `--json`, `--plain`, `-q/--quiet`, `-h/--help`, `-v/--version`, removed flags (`--try-cf-tunnel`, `--tunnel-qr`, `--tunnel-password-url`, `--tunnel`, `--tunnel-provider`/`--tunnel-mode`/`--tunnel-config`/`--tunnel-token`/`--tunnel-hostname` on top level) hard-error with remediation text; unknown options error identically.

| Command | Subcommands | Flags | Behavior |
|---|---|---|---|
| `openchamber` (= `serve`) | – | above + port/host/ui-password/api-only/foreground | Start server. Refuses when an instance already runs on the port (`status`/`stop` hint), or when the port is a Desktop-managed runtime. Picks a free port when `--port` omitted/explicit-0. Daemon: detached child; readiness via IPC `openchamber:ready` (30 s timeout); writes pid + instance files. Foreground: in-process; blocks; cleans pid on exit; `--json` forbidden (exit 2). |
| `stop` | – | `-p/--port`, `--all`, `--json`, `-q` | Stops discovered instances (registry + probes). Desktop-managed ports refused (`reason:'desktop-managed'` + WARNING message). Unmanaged probed instances get a shutdown request (`POST /api/system/shutdown`) plus process-tree termination; port-busy → partial warning `SHUTDOWN_PARTIAL`. Human: clack intro/outro; `--json { stoppedCount, results:[{port,stopped,reason?,runtime?}] }`; `--quiet` prints `stopped <port>`/`failed <port> <reason>`/`none` lines on stdout/stderr. |
| `restart` | – | same as stop/serve | stop (unless desktop-managed) then re-`serve` with the stored instance options (port/host/uiPassword/apiOnly) |
| `status` | – | `--json`, `-q`, `-p` | Lists instances (pid, port, launch mode, protection, registry-confirmed vs probe), tunnel readiness. `--json { instances: [...] }`; `--quiet`: `port` + ` mode:<launch>` + ` pass:<generated-only>` lines style (`instance.port mode:...`). |
| `logs` | – | `-p`, `--all`, `--follow` (default true)/`--no-follow`, `--lines <n>` (default 200) | Tails `<data-root>/logs/openchamber-<port>.log` of the latest/selected instance; follows when TTY unless `--no-follow`. |
| `update` | – | `--json`, `-q` | Checks package-manager (npm/pnpm/yarn/bun detection), optional stopping of CLI-managed instances, runs `pm update`, restarts instances with stored options. `--json { currentVersion, latestVersion, updated }` and error JSON; `--quiet { }` minimal lines (`up-to-date <version>`). |
| `connect-url` | – | `-p`, `--host/--hostname`, `--lan`, `--server/--server-url <url>`, `--relay`, `--name <label>`, `--ui-password <value>`, `--api-only`, `--qr/--no-qr`, `--json`, `-q` | Finds or **starts** a server on the port, then creates a **pairing v2** session (`POST /api/client-auth/pairing/sessions` server-side store write, secret returned) and prints `openchamber://connect?v=2&p=<base64url {pairingId, secret, label, server url, candidates[]}>` (URL saved via `--server`, LAN IP advertised automatically when `--lan/0.0.0.0` bound). `--relay` builds a **relay-only** link (single candidate, relay must be enabled on the host; endpoint: `OPENCHAMBER_RELAY_URL`/setting/default). `--qr` prints a QR (qrcode-terminal). `--json { url (the openchamber link), qr?, ... }`; `--quiet` prints only the link. |
| `tunnel` | `help`(default), `providers`, `ready`, `doctor`, `status`, `start`, `stop`, `profile`, `completion` | see below | Tunnel lifecycle (see 10.2). |
| `startup` | `status`(default), `enable`, `disable` | `-p`, `--host`, `--ui-password`, `--api-only`, `--no-env-snapshot`, `--json`, `-q` | Installs the native user-login service (launchd user agent/systemd user service/Windows startup), **snapshotting the current environment** (PATH, provider tokens, SSH agent) into the service definition; `--no-env-snapshot` for a minimal env. |
| `schedule` | `status`,`list`,`create`,`run`,`delete`,`enable`,`disable`,`help` | `--project <id>`, `--task <id>`, `--name/--title`, `--prompt`, `--daily <HH:mm>`, `--weekly <0,1,2>`, `--once <ISO>`, `--time`, `--cron <expr>`, `--timezone`, `--agent`, `--variant`, `--model`, `--directory`, `--disabled`, `--goal`, `--goal-token-budget <n>`, `--json`, `-q`, `-p`, `--ui-password <pw>` | Mapping to `POST /api/openchamber/control` actions; actions are rendered by `schedule ... help`. |
| `session` | `create`,`send`,`fork`,`list`,`status`,`messages`,`help` | `--project`, `--directory`, `--title`, `--prompt/--message`, `--session <id>`, `--model`, `--agent`, `--variant`, `--role`, `--wait`, `--timeout <s>`, `--last`, `--last-assistant`, `--with-status`, `--goal`, `--goal-token-budget`, `--json`, `-q`, `-p`, `--ui-password` | Control-plane session ops. `messages` projection = Markdown-export semantics: ordered text parts only (no tool/reasoning/file parts). `--wait` polls task completion; partial failures surface `partial` markers. |
| `models` | – (help) | `--json`, `-q`, `-p`, `--ui-password` | Prints default/favorite/recent models from settings (via control endpoint). |
| `projects` | – | `--json`, `-q`, `-p`, `--ui-password` | Prints configured projects: `{ id, label/path }` pairs. |
| `control` | `help` only | – | Prints the control-plane help listing (`status session models projects schedule tunnel logs`). |

### 10.2 Tunnel subcommand detail

- `tunnel help` — the help text in `cli-args.js`.
- `tunnel providers [--json]` — provider capability list (server `/api/openchamber/tunnel/providers`, fallback to built-in capability table when no server reachable).
- `tunnel ready [--provider <id>] [--json]` — dependency availability check.
- `tunnel doctor [--provider] [--mode] [`--config path` | `--token-file` | `--token` | `--hostname` | `--connect-ttl` | `--session-ttl`] [--all] [--json]` — deep diagnostics; `--all` across instances (default). Validates required fields per mode; displays check table (human) or `checks[]` payload (json).
- `tunnel status [--json]` — active tunnel + sessions/ttl config.
- `tunnel start [--provider cloudflare|ngrok] [--mode quick|managed-local|managed-remote] [--profile <name>] [--config [path]] [--token <tok>|--token-file <path>|--token-stdin] [--hostname <host>] [--connect-ttl <30m|24h|1d>] [--session-ttl <8h|24h|1d>] [--qr/--no-qr] [--dry-run] [--show-secrets] [--json] [-q]` — starts tunnel (auto-starts a server if none). One active tunnel per instance; replacing revokes old links/sessions (shows counts). QR shown when human+TTY unless `--no-qr`. `--dry-run` validates only. Secrets redacted unless `--show-secrets`.
- `tunnel stop [-p <port>] [--all] [--json]` — stops the tunnel (server keeps running).
- `tunnel profile list|show|add|remove` — saved managed-remote profiles (`tunnel-profiles.json`): `add --provider --mode managed-remote --name <n> --hostname <h> [--token | --token-file | --token-stdin] [--force]`, `remove --name [--provider]`, `list [--provider] [--json] [--show-secrets]`, `show --name`. Token persistence: tokens stored in the file (redacted in output; unsafe file permissions warn).
- `tunnel completion bash|zsh|fish` — prints the completion script.

### 10.3 Non-TTY/JSON semantics highlights

Validation and policy run in **every** mode (no mode short-circuits safety checks). `--json` prints one document with `status` + domain payload + `messages: [{ level, code, message }]` for warnings/errors; `--quiet` prints compact deterministic lines (e.g. `serve --quiet` → `<port>` or `<port> pass:<generatedPassword>`; `stop --quiet` → `stopped <port>` lines; `update --quiet` → `up-to-date <v>`); `connect-url --quiet` → the link only.

### 10.4 Startup service natives

`openchamber startup enable` (src: `bin/lib/cli-startup.js`, `commands-startup.js`):
- macOS: LaunchAgent user plist (gui domain), run-at-load + keepalive off; env dictionary snapshot.
- Linux: `systemctl --user` unit (`openchamber.service`); lines honor `--foreground`; `%t` runtime dir for SSH agent socket.
- Windows: Startup shortcut/scheduled task invoking the CLI with the stored options (`serve --port ... --ui-password ...`).
- `startup status` reports installed/pid/port; `--json` shape `{ installed, platform, ... }`.
- `envSnapshot` default true — the entire environment (minus obvious chaff) is embedded so the service sees provider tokens, PATH and SSH agents.

### 10.5 Update mechanism

`OPENCHAMBER_UPDATE_API_URL` (default `https://api.openchamber.dev/v1/update/check`); per-scope install id; package-manager detection order and `getUpdateCommand` per PM (npm/pnpm/yarn/bun); GitHub release APK resolution for mobile (asset regex `OpenChamber-...-android.apk`); changelog/update notes fetched from `server/lib/changelog/update-notes.js`.

---

# 11. Node runtime and PTY dependencies

Runtime deps of `@openchamber/web` (src: `packages/web/package.json`):

| Dependency | Version | Used for |
|---|---|---|
| `express` | ^5.1.0 | HTTP app (Section 2) |
| `http-proxy-middleware` | ^3.0.5 | OpenCode catch-all proxy |
| `compression` | ^1.8.1 | gzip/deflate |
| `ws` | ^8.18.3 | all WebSocket servers (terminal, message stream, dictation, dev-tunnel, realtime proxy) |
| `node-pty` | 1.2.0-beta.12 | PTY sessions on Node (terminal; cross-ref 07) |
| `bun-pty` | ^0.4.5 | PTY backend when the server runs under Bun |
| `jose` | ^6.1.3 | UI session JWT sign/verify |
| `@simplewebauthn/server` | 13.3.1 | passkey (WebAuthn) registration/authentication |
| `web-push` | ^3.6.7 | VAPID web push |
| `node:http2` (stdlib) | – | APNs push provider |
| `simple-git` | ^3.36.0 | git operations |
| `@octokit/rest` | ^22.0.1 | GitHub API |
| `@opencode-ai/sdk` | 1.18.30 | official OpenCode SDK client (shared UI calls `@opencode-ai/sdk/v2`; server helpers use the client for skills discovery/app endpoints) |
| `cron-parser` | ^4.9.0 | scheduled tasks crons |
| `luxon` | ^3.5.0 | date/time math (schedules/preview) |
| `jsonc-parser`, `yaml` | ^3.3.1 / ^2.8.1 | OpenCode/config parsing |
| `openai` | ^4.79.0 | OpenAI-compatible TTS/STT calls |
| `sherpa-onnx-node` | 1.12.28 | local dictation STT models |
| `qrcode-terminal` | ^0.12.0 | CLI QR output |
| `@clack/prompts` | ^1.1.0 | CLI UX |
| `reflect-metadata` | ^0.2.2 | imported at server boot (decorator metadata for SDK) |

Node version: **22+** recommended (README prerequisite). Windows note: `lsof`-based port cleanup and `dev-shutdown` are unix-only (gracefully skipped on win32). `OPENCHAMBER_SKIP_OPENCODE_START`+external-host mode is the supported way to serve against a remote harness.

---

# 12. Build checklist (implementer's acceptance list)

1. **Boot**: express app with the exact middleware order (Section 2); LAN gate refuses unauthenticated public binds; robots/CORS/compression policies as specified; `trust proxy`.
2. **Auth**: UI password sessions (scrypt + JWT + cookie + rate limit + passkeys + reset rotation), URL tokens (60 s read-only/WS allowlist), client tokens (`oc_client_`, hashed store), pairing v2 (one-time secret, redeem rate-limit), tunnel bootstrap (single-use bootstrap token → `oc_tunnel_session` cookie), scope classification (local/tunnel/unknown-public; tunnel locks password login), origin enforcement on WS/virtual routes.
3. **API surface**: all routes in Section 5 present with matching request validation, response shapes, and status codes; the deferred-restart envelope for config mutations; per-route JSON body limits (2.6).
4. **FS/Git**: workspace-bound fs ops with the exact grant mechanism and upload/write invariants; 68 git routes incl. worktree bootstrap status and topology SSE.
5. **Harness (HARNESS PORTS)**: launch/attach semantics (env table), auth header injection with client-credential stripping, readiness hold + worktree hold + directory canonicalization + session-list sanitization + SSE proxy with heartbeats/stall watchdog/backpressure + pooled agent + 4 min/15 min deadlines; external attach via `OPENCODE_HOST`/`OPENCODE_PORT`; lifecycle restarts rebind streams and interrupt busy sessions.
6. **Event plumbing**: `/api/global/event`+`/api/event` (+WS twins) and OpenChamber channels `/api/openchamber/events`, `/api/notifications/stream` with the enumerated heartbeats and event names.
7. **Storage**: data-dir layout (Section 7), settings.json semantics (sanitize/merge/strict read/0600/atomic), store normalizers, legacy-dir copy migration, corrupt-file quarantine for message-queue.
8. **Static/PWA**: three HTML entries, dist static + sw no-store + manifest route + SPA/API-only fallbacks.
9. **Integrations**: GitHub (device flow, multi-account, gh-cli source) and Linear (oauth callback page, workspaces, mapping, session comments) per spec.
10. **Voice surfaces**: tts/stt/say/dictation/text-summarize/voice-token contracts.
11. **CLI**: every command/flag (Section 10), output-mode contracts, exit codes, startup service natives, update flow, tunnel lifecycle/profile store with redaction.
12. **Env**: Section 9 table implemented (typed parse + documented fallbacks).
13. **Cross-doc wiring**: 02 (upstream payload contract), 04 (client sync consumers), 07 (terminal), 08 (relay/tunnel protocols), 12 (scheduled tasks/message queue/goals), 13 (preview).

Verification suggestions for the reimplementation team: contract tests per route family (Section 5 tables double as checklists), an integration boot test exercising `serve` + attach mode with a stub harness, and CLI golden-output tests per command in `--json`, `--quiet`, and human modes.

---

# 14. Invariants appendix (success/failure semantics contract)

The reimplementation must honor these semantics exactly — they are load-bearing for the UI's behavior in the shared repo's maintenance history:

| Area | Invariant |
|---|---|
| Discovery surfaces (`/api/worktrees`, `/api/dev-servers`, `/api/git/status` non-repo) | A failed scan is **not** an empty success: worktrees → 500 keeps client topology; dev-servers → `503 { reason }`; git status on non-repo → explicit `isGitRepository:false` payload |
| Relay demand reconcile | A store read failure must not equal "no demand": reconcile throws and leaves relay state untouched; only trustworthy reads may enable/disable |
| Message queue store | Corrupt file → moved aside (`*.corrupt-<ts>`), runtime starts empty; **never** silently treated as empty-then-overwritten |
| Strict settings readers | Corrupt/unreadable settings must block flows that would **mint replacement keys** (relay identity, desktop-local token) — replacing keys would change `serverId`/tokens and orphan devices |
| Knowledge delivery | "Get text" and "record delivered" are separate calls; recording failure is 200 `{ recorded:false }` — never 5xx — because the message already went out |
| Message-queue idleness | A failed upstream idleness check is "unknown, never idle": re-arm with backoff; `prompt_async` into a running turn is explicitly avoided |
| Notification suppression | Auto-accepting a permission server-side and mirroring via `/api/notifications/auto-accept` prevents leaked notifications (500 ms race) |
| Session list sanitize | `summary.diffs` is stripped (payload size); `revert` trimmed to `{ messageID, partID }` — client copies relying on those fields must not exist |
| SSE stability | Heartbeats only at event boundaries; upstream stall ends the client stream cleanly (no phantom error frames); slow WS clients get `backpressure` warning then close 1013 |
| Uploads/atomicity | All persisted writes are tmp+rename with cleanup-of-temp-on-failure; queued session-folder saves serialize; the final store always parses |
| Response envelopes | Errors `{ error }` (+ extras per route); config mutations carry the deferred-restart shape (`requiresReload` vs `requiresRestart`); control failures carry `partial` markers rather than dropping completed work |
| Race containment | one-time credentials (bootstrap token, pairing secret) burn on first use; single-flight locks on upgrade/restart/store mutations; provider upgrade operates synchronously locked |
| Token hygiene | Client `Authorization` never reaches the harness upstream; clipboard/password surfaces print credentials once (`serve` generated password) |

# 15. CLI examples (canonical)

```bash
# Start
openchamber                                   # daemon, auto port, welcome summary
openchamber --port 8080                       # fixed port
openchamber --lan --port 3000                 # 0.0.0.0 bind (requires --ui-password or override env)
openchamber serve --ui-password               # generates a password, prints it once
openchamber serve --foreground --port 3000 --host 0.0.0.0 --ui-password your-password   # systemd
OPENCODE_PORT=4096 OPENCODE_SKIP_START=true openchamber   # attach to external harness
OPENCODE_HOST=https://myhost:4096 OPENCODE_SKIP_START=true openchamber
OPENCHAMBER_OPENCODE_HOSTNAME=0.0.0.0 openchamber --port 3000   # managed harness on LAN

# Lifecycle
openchamber status                            # human table
openchamber status --json                     # { status, instances: [...] }
openchamber stop --port 3000
openchamber restart
openchamber logs --no-follow --lines 50
openchamber logs -p 3000                      # follow latest

# Tunnels
openchamber tunnel help
openchamber tunnel providers
openchamber tunnel ready --provider cloudflare
openchamber tunnel doctor --provider cloudflare --mode quick
openchamber tunnel status
openchamber tunnel start --qr
openchamber tunnel start --profile prod-main
openchamber tunnel start --provider cloudflare --mode managed-remote \
    --token-file ~/.secrets/cf-token --hostname app.example.com
openchamber tunnel start --provider cloudflare --mode managed-local \
    --config ~/.cloudflared/config.yml
echo "$TOKEN" | openchamber tunnel profile add --provider cloudflare \
    --mode managed-remote --name prod-main --hostname app.example.com --token-stdin
openchamber tunnel stop --port 3000

# Connect another app
openchamber connect-url --port 3000
openchamber connect-url --port 3000 --qr
openchamber connect-url --port 3000 --json
openchamber connect-url --port 3000 --name "Workstation"
openchamber connect-url --relay --name "My laptop"
openchamber connect-url --port 3000 --api-only --lan \
    --server http://workstation.local:3000 --qr --ui-password your-password

# Startup integration
OPENCHAMBER_UI_PASSWORD=secret openchamber startup enable   # env snapshot into the service
openchamber startup status
openchamber startup disable

# Control plane
openchamber projects
openchamber models
openchamber session --help
openchamber schedule --help
openchamber update
```

---

# 16. Appendix A — Full registration-order recap

For implementers this is the canonical mount order (auth gate placement is what makes the ordering critical). Route modules are grouped by registration phase in `main()`; `(src: ...)` gives the module file.

| Phase | Registered surface | Source | Auth class at request time |
|---|---|---|---|
| 1 | `X-Robots-Tag`, `/robots.txt` | `server/index.js` | public |
| 2 | CORS (packaged/dev origins) + OPTIONS | `server/index.js` | public (headers only) |
| 3 | compression | `server/index.js` | – |
| 4 | UI auth controller created; `/health`, `/api/version`, `/api/system/*` | `opencode/core-routes.js` (registerServerStatusRoutes) | public (shutdown with own auth) |
| 5 | body-parse middleware + verbose logs | `core-routes.js` (registerCommonRequestMiddleware) | – |
| 6 | `/api/openchamber/agent-tool` | `agent-tool/runtime.js` | gate |
| 7 | `/auth/*` session/url-token/passkeys, `/api/passkeys`, `/api/auth/reset`, `/api/client-auth/*`, `/connect`, `/api/system/probe-url`, and **the `/api` gate last** | `core-routes.js` (registerAuthAndAccessRoutes) | see table above; everything later is gated |
| 8 | `/api/voice/token`, `/api/tts/*`, `/api/text/summarize`, `/api/stt/transcribe` | `tts/routes.js` | gate |
| 9 | `/api/push/*`, `/api/notifications/stream`, `/api/notifications/auto-accept`, `/api/session-activity`, `/api/sessions/*` | `notifications/routes.js` | gate (push routes use session tokens) |
| 10 | `/api/openchamber/update-*`, `/api/openchamber/models-metadata`, `/api/zen/models` | `opencode/openchamber-routes.js` | gate |
| 11 | `/api/openchamber/realtime-proxy/sse` + ws | `lib/realtime-proxy.js` | session token + origin + desktop config |
| 12 | `/api/openchamber/tunnel/*` | `tunnels/routes.js` (tunnelWiring) | gate |
| 13 | `/api/openchamber/relay/*` | `relay/service.js` | gate |
| 14 | `/api/browser-control/*` | `browser-control/routes.js` | gate |
| 15 | dev-tunnel WS (`/api/dev-tunnel`) | `dev-tunnel/runtime.js` | session + origin |
| 16 | feature routes (below) | `opencode/feature-routes-runtime.js` | gate |
| 16a | settings utility + permission-auto-accept + message-queue + OpenCode settings routes + project icons + scheduled tasks + openchamber sessions/control + markdown image grants + config entities + plugins + skills + git + fs + projects + project-context + agent-memory + session-knowledge + session folders + goals + walkthrough + github + linear + quota + small-model + magic-prompts + dev-servers | per-module files (5.x) | gate |
| 17 | terminal routes + `/api/terminal/ws`, dictation routes + `/api/dictation/ws`, message-stream WS (`/api/event/ws`, `/api/global/event/ws`) | `startup-pipeline-runtime.js` → terminal/dictation/event-stream runtimes | gate + origin on upgrades |
| 18 | OpenCode proxy (readiness hold → worktree hold → Windows merge → session sanitize → SSE forwards → deadline → catch-all `app.use('/api', apiProxy)`) | `opencode/proxy.js` | already behind the /api gate (phase 7) |
| 19 | static/PWA/SPA or api-only fallback | `opencode/static-routes-runtime.js` | public |

# 17. Appendix B — Architecture data-flow map

```
                       ┌────────────────────────────────────────────────────────┐
                       │                    Browser / PWA shell                  │
                       │   index.html SPA + mini-chat.html + mobile.html        │
                       └──────────┬───────────────────────────┬─────────────────┘
                                  │ HTTP (same-origin)        │ SSE / WS
 ┌────────────┐  Bearer oc_client_│                           │
 │ Paired apps│───────────────────┤                           ▼
 │ desktop/   │                   │                ┌────────────────────────┐
 │ mobile     │──────┐            │                │  OpenChamber Express   │
 └────────────┘      │            │                │  (Section 2 order)     │
                     │            │                ├────────────────────────┤
                     │            └───────────────►│ /auth, /api gate       │
                     │                             │ feature routes (5.x)   │
                     │      /connect?t=…           │ OpenCode proxy (4.4)   │
                     │      tunnel session cookie  ├────────────────────────┤
                     │                             │ WS: terminal/message   │
                     │                             │     stream/dictation   │
                     │                             └───┬───────────┬────────┘
                     │                                 │           │
                     │             openchamber:// pair │           │ /api passthrough (path = /api stripped)
                     │                                 ▼           ▼
                     │                        ┌─────────────┐ ┌──────────────────┐
                     │                        │ harness     │◄┤ health monitor / │
                     │                        │ (OpenCode)  │ │ lifecycle restart│
                     │                        └─────────────┘ └──────────────────┘
                     │                                 ▲
                     ▼                                 │ SSE /global/event (watcher → hub)
              ┌──────────────────┐                     │
              │ relay (wss)      │────────────┐   ┌────┴────────────┐
              │ (doc 08)         │            └──►│ global hub      │
              └──────────────────┘                 │ → notifications │
                                                   │ → session state │
                                                   │ → msg queue     │
                                                   │ → auto-accept   │
                                                   └─────────────────┘

 Event streams to clients:  /api/global/event, /api/event (+ /ws twins)  — harness forward
                            /api/openchamber/events                 — openchamber control plane
                            /api/notifications/stream                — notifications
```

# 18. Appendix C — Request lifecycle walkthroughs

**Example 1: `GET /api/git/status?directory=/home/u/proj` (password-protected server)**

1. compression filter: JSON API path, not a skip-listed prefix — compressible (threshold 1 KB).
2. `/api` gate: `oc_ui_session` JWT verified (`jwtVerify` with data-dir secret) → `next()`.
3. Body parse middleware: `/api/git` prefix → `express.json({ limit: '50mb' })` (GET with no body: no-op).
4. Feature routes: `registerGitRoutes` handler — `resolveDirectoryQuery` → git lib lazy import → `isGitRepository(dir)`; concurrently `observeWorktreeTopology(dir)` (never blocks).
5. Not a repo → 200 `{ isGitRepository:false, files:[], branch:null, ahead:0, behind:0 }`. Repo → full status JSON. Git stderr → 500 `{ error }`.
6. Because the request never matched an OpenChamber proxy skip-list, no upstream call happens; **route order matters**: the git route was registered before the proxy catch-all, so it wins.

**Example 2: `POST /api/session/<id>/message` (harness passthrough)**

1. Gate passes; body parser: `/api/session/...` is not in the OpenChamber prefix list → body **not parsed** (`req.body` undefined) — irrelevant: proxy replays the raw body? No — the catch-all proxy must forward the original stream. The proxy therefore *skips* replay (`serializeParsedBody` returns null for unparsed bodies) and http-proxy pipes the untouched request stream upstream.
2. Proxy middleware stack enforces readiness/worktree holds if applicable, rewrites `/api/` → `/`, injects harness `Authorization`, forces `accept-encoding: identity`, sets the 4-min deadline.
3. Harness answer is filtered (response header allowlist) and returned 1:1.

**Example 3: `GET /api/notifications/stream`**

1. Gate: needs a session/client token; `ensureSessionToken` may mint the cookie automatically when auth is off (anonymous-cookie mode) — this is why even password-less servers can subscribe.
2. Route adds the `res` to `uiNotificationClients`, writes `openchamber:notification-stream-ready`, heartbeat 20 s; compression middleware never compresses this path (SSE skip list).

# 19. Appendix D — settings.json illustrative skeleton

Shape only — every field is optional; unknown fields are preserved:

```json
{
  "projects": [
    { "id": "<hash-of-path>", "path": "/abs/path", "addedAt": 1699999999999,
      "lastOpenedAt": 1700000000000,
      "iconImage": { "mime": "image/svg+xml", "updatedAt": 1700000000000, "source": "custom" } }
  ],
  "activeProjectId": "<hash-of-path>",
  "lastDirectory": "/abs/path",
  "themeId": "openchamber-dark", "themeVariant": "dark", "useSystemTheme": false,
  "pwaAppName": "OpenChamber", "pwaOrientation": "portrait",
  "tunnelProvider": "cloudflare", "tunnelMode": "quick",
  "tunnelBootstrapTtlMs": 1800000, "tunnelSessionTtlMs": 28800000,
  "skillCatalogs": [ { "id": "catalog-1", "label": "Team skills", "source": "https://github.com/org/skills", "subpath": "skills", "gitIdentityId": "profile-1" } ],
  "agentControlToolEnabled": true, "agentWebToolEnabled": true, "agentMemoryToolEnabled": false,
  "optimizeSystemPrompt": false,
  "permissionAutoAccept": { "defaultPolicy": { "enabled": false } },
  "notifyOnCompletion": true,
  "publicOrigin": "https://oc.example.com",
  "privateRelay": { "enabled": false, "relayUrl": "wss://relay.openchamber.dev/ws" },
  "workStatusPanelEnabled": true, "showReasoningTraces": true, "collapsibleThinkingBlocks": true,
  "inputHistoryScope": "global", "showOnboarding": false
}
```

# 20. Appendix E — Platform notes (Windows, WSL, container)

- **Windows**: no SIGTERM-to-PGID, no `lsof` cleanup paths; port discovery uses `netstat -ano -p TCP`; `cmd.exe /c` shell for fs exec; WSL fallback launches the harness through `wsl.exe` when no native binary exists; session merge middleware (4.4 step 4) exists because OpenCode stores per-directory sessions differently on Windows path semantics.
- **Containers**: `/.dockerenv`/`CONTAINER`/`container=docker` detection changes `update-install` to detached+no-restart semantics; dev-server discovery ships a `/proc/net/tcp*` fallback when `lsof` is absent.
- **systemd**: foreground launch + `OPENCHAMBER_SYSTEMD_UNIT` (default `openchamber.service`) makes `update-install` queue a transient `systemd-run --user` job that updates then restarts the unit; missing systemd-run → `409` instructing CLI update.
- **Desktop/Electron runtime**: `OPENCHAMBER_RUNTIME=desktop` — compression off, desktop notify enabled by default, updater via `desktopUpdater` (electron-updater) instead of package manager, `openchamber-ui://` origin in CORS/origin allowlists.

# 21. Appendix F — Supporting runtime modules

## 21.1 dev-tunnel (raw byte tunnel to host dev servers)

`WS /api/dev-tunnel?port=<1..65535>` (src: `packages/web/server/lib/dev-tunnel/runtime.js`):
- Purpose: a remote/desktop client binds its own local port and pipes raw TCP bytes through this WS to a dev server **running on the OpenChamber host**; the page is then served from its real origin (absolute URLs, cookies, HMR sockets work unchanged). Nothing is inspected or rewritten (deep semantics: doc 13).
- Reachability policy: the requested port must appear in the same dev-server discovery list the UI offers (`discoverDevServers` minus OpenChamber's own ports). An authenticated client must not be able to dial arbitrary loopback services (DBs, admin panels, the harness API).
- Auth: with an `Origin` header (browser context) the normal origin check applies; **without** Origin the request must carry client-token auth or a short-lived `oc_url_*` token (URL-token allowlist is limited to this path).
- Limits: `MAX_CONCURRENT_SOCKETS = 64` per instance, connect timeout 5 s, TCP connect then raw duplex pipe, both ends torn down together.

## 21.2 path-realpath-cache

`createRealpathCache({ realpath, successTtlMs = 600_000, failureTtlMs = 60_000, maxEntries = 256, fallbackOnError = false })` (src: `packages/web/server/lib/path-realpath-cache.js`):
- LRU (insertion-order) map keyed by the input path, storing resolved value **or** the error.
- Successful resolutions live 10 min; failures 1 min. File-tree listing (`/api/fs/list`) uses the default (`fallbackOnError: false` — errors propagate); the OpenCode proxy directory canonicalizer uses `fallbackOnError: true` (pass the input through on failure).
- callers: workspace resolution in fs routes and the proxy `?directory=` canonicalizer.

## 21.3 changelog/update-notes (release notes for the update dialog)

- Fetches `https://raw.githubusercontent.com/openchamber/openchamber/main/changelog/index.json` (newest first; `{ version, date, title, intro, app: { new[], improvements[], fixes[], misc[] } }`).
- Renders Markdown between installed version (exclusive) and offered version (inclusive): `## [x.y.z] - YYYY-MM-DD`, bold title, intro, then New/Improvements/Fixes/Misc bullet groups.
- Any failure yields `null` — the update is still offered, minus notes (src: `packages/web/server/lib/changelog/update-notes.js`).

## 21.4 Global event hub (event-stream/global-hub.js + upstream-reader.js)

- One SSE reader per upstream channel configuration; re-dials `buildOpenCodeUrl(path, '')` on each (re)connect; `Last-Event-ID` propagated; reconnect delay 250 ms (`DEFAULT_UPSTREAM_RECONNECT_DELAY_MS`).
- Stall timeout parameterized by active session count: 20 s idle-browsing, 60 s with >1 active session (guarding long agent turns) (src: `event-stream/upstream-reader.js:3-4`).
- Subscribers receive envelopes `{ directory, payload }`; the hub deduplicates nothing — it is a fan-out. Rebinding after harness restart re-dials with the current port (4.3 invariants).

## 21.5 openchamber-sessions storage clarifier

The service holds no independent store: sessions are created in the harness (doc 02 owns the session record); chat worktrees live under the managed chats root (`<data-root>/chats`); the OpenChamber-side trace of a session (folders, goal objective, message queue) lives in the files enumerated in Section 7. `openchamber:session-created` is the only broadcast the create path emits.

## 21.6 Terminal WS input economy (summary; full protocol: doc 07)

- The data channel is a single WS per client with attachment multiplexing (`{ t, v, s (seq), d }` frames); input messages capped at 65 536 chars; resize validated; appearance/theme control sequences are intercepted server-side (theme mode + background/foreground negotiation, doc 07 owns the protocol tables).
- History replay: each session keeps a rolling ≤512 KB text history plus the PTY size it was captured at; re-attach replays history then live output.
- Auth token rebinding flood control: ≤128 reinstalls per 60 s window per socket; heartbeat 15 s.

# 22. Appendix G — Gaps, caveats, and what the reimplementation must decide

1. **Harness compatibility**: OpenChamber assumes a harness that (a) serves an HTTP API at root behind an optional bearer, (b) streams a global + directory SSE, (c) accepts per-directory initialization (`directory`/`x-opencode-directory`), (d) exposes `/global/health` + `/global/upgrade`. Document 02 teaches the exact shapes; if the target harness deviates, the proxy skip-lists, sanitizers, and holds must be re-derived, not copy-pasted.
2. **Version skew**: `@opencode-ai/sdk` 1.18.30 pinned; skills discovery uses `client.app.skills`; a different sdk major may alter only that call.
3. **The `git-identities.json` legacy path** is a known wart; a clean reimplementation should store it under the data root — but preserve a migration note for parity.
4. **settings.json surface** is intentionally kept descriptive (Appendix D); exact key parity is not required for server function — only the key groups consumed by the routes in Section 5 are contractual.
5. **Ports/labels**: documents 07/08/13 own deeper protocols; where this doc and those overlap, the owning document dominates.

# 23. Appendix H — CLI control-plane deep contracts

## 23.1 How CLI control commands reach the server

`requestControlAction(port, action, input, options)` (src: `bin/lib/cli-control.js`) sends:

```
POST http://<host>:<port>/api/openchamber/control
{ "action": "<action>", "input": { … }, "contextDirectory": <dir when provided> }
```

Auth (src: `bin/lib/cli-http.js`): 
- **Desktop-targeted** invocations (`cli-api-target.js` prefers the desktop runtime unless `-p` is explicit) attach `Authorization: Bearer <settings.desktopLocalClientToken>` (`desktopLocalClientToken` in settings.json, minted by the desktop shell; CLI reads it from the data dir).
- **Managed CLI instances** run with a UI password; on `401` the CLI retries with `Authorization: Bearer <instance uiPassword from the run-file>`.
- A plain running instance without a password accepts unauthenticated control calls (matching the server's no-password mode).
HTTP failure mapping (cli-control): 401 → exit 4 with auth guidance; 404 unknown action → exit 2; 5xx → exit 5; the shared control envelope `{ error, partial?, partialAction?, sessionId?, directory? }` is surfaced verbatim in `--json` and as status lines otherwise. Partial results (goal aborts, batch partials) are still printed with the `partial` marker — never swallowed.

Target resolution (`cli-api-target.js`): explicit `-p/--port` wins; else prefer the desktop-managed instance (`settings.desktopLocalPort`), else the newest CLI-managed instance; errors when nothing is running.

## 23.2 `openchamber session` — exact contract (src: `bin/lib/commands-session.js`)

```
openchamber session list [--dir <path>] [--limit <count>] [--with-status] [--all] [--json|-q] [-p]
openchamber session create (--dir <path> | --project <projectId>) [--title <title>] [--worktree <name> [--branch <name>] [--start-ref/--base <ref>] [--upstream/--no-upstream]] [--prompt <text>] [--model <provider/model>] [--agent <id>] [--variant <id>] [--goal [--goal-token-budget <n>]] [--wait [--timeout <s>] [--last-assistant]] [OPTIONS]
openchamber session send --session <id> --dir <path> --prompt <text> [--model <provider/model>] [--agent <id>] [--variant <id>] [--goal [...]] [--wait [...]] [OPTIONS]
openchamber session fork --session <id> --dir <path> --prompt <text> [--message <id>] [same options]
openchamber session status --session <id> --dir <path> [OPTIONS]
openchamber session messages --session <id> --dir <path> [--role all|user|assistant] [--all | --last | --limit <n>] [--wait [--last-assistant]] [OPTIONS]
```

Validation (exit 2): `--dir` XOR `--project` (both or neither error); `--model` must be `provider/model`; `--goal` requires `--prompt`; `--timeout`/`--last-assistant` require `--wait`; `--message` valid only with `fork`; `messages` flag exclusions: `--all` vs `--last`/`--limit`, `--last` vs `--limit`, `--last-assistant` forces role `assistant` and forbids other roles; `--timeout` with `--wait` only; wait timeout default 600 s, max 86 400 s; goal token budget 1 000–100 000 000.

Control actions (Section 23.1) and inputs:

| CLI action | Control `action` | `input` |
|---|---|---|
| `session list` | `session.list` | `{ directory?, limit (default 10, ≥1), all, withStatus }` |
| `session create` | `session.create` | `{ directory?|projectId?, title?, worktree (name; control payload uses `worktree`, `branch`, `startRef`), prompt?, model?, agent?, variant?, goal?, goalTokenBudget?, setUpstream?, wait?, timeout?, lastAssistant? }` |
| `session send` | `session.send` | `{ sessionId, directory, prompt, messageId? (fork only), model?, agent?, variant?, goal?, goalTokenBudget?, wait?, timeout?, lastAssistant? }` |
| `session fork` | `session.fork` | same as send + `messageId` |
| `session status` | `session.status` | `{ sessionId, directory }` |
| `session messages` | `session.messages` | `{ sessionId, directory, role ('all'|'user'|'assistant'), all, last, limit?, wait?, timeout?, lastAssistant }` |

Output modes:
- `--json`: the raw control result `{ ...result, sessionStatus?, lastAssistantMessage? }` (message projection = ordered text parts only; tool/reasoning/file parts omitted).
- `--quiet`: create/send/fork → `<sessionId>` (plus last assistant text when present); `status` → `<status.type>`; `messages` → texts joined by blank lines; `list` → formatted session lines.
- human: clack intro/outro with status lines (`worktree: <branch> <path>`, `initial prompt dispatched`, `goal mode active budget: <n>`, `session status: <type>`) and a Markdown-formatted last assistant text when requested.

`list` line format (human/quiet): `- \`<title>\` — \`<provider/model>\`, \`<agent>\`[\, \`<variant>\`] — status:<type> — \`<directory>\`` (title falls back to slug → id → "untitled"; model from `model.providerID/model.id`).

## 23.3 `openchamber schedule` — exact contract (src: `bin/lib/commands-schedule.js`)

```
openchamber schedule status [OPTIONS]                        → action `schedule.status`
openchamber schedule list (--project <id> | --dir <path>)    → `schedule.list` { projectId?|directory? }
openchamber schedule create (--project|dir) --name <n> --prompt <p> --model <provider/model>
    (--daily <HH:mm> | --weekly <0,1,2> --time <HH:mm> | --once <YYYY-MM-DD> --time <HH:mm> | --cron <expr>)
    [--timezone <IANA>] [--agent <id>] [--variant <id>] [--goal [...]] [--disabled]  → `schedule.create`
openchamber schedule run    (--project|dir) --task <id>      → `schedule.run`    { taskId }
openchamber schedule delete (--project|dir) --task <id>      → `schedule.delete` { taskId } → { deleted:true, tasks }
openchamber schedule enable/disable (--project|dir) --task <id> → `schedule.toggle` { taskId, disabled }
```

Schedules: `daily` = times array; `weekly` = weekdays (0=Sun) + times; `once` = date + time; `cron` = expression; timezone optional (IANA). Goal options mirror `session create` (budget 1 000–100 000 000, requires `--goal`; wait semantics doc 12).

Output modes:
- `status` → json `{ ...resolver status (enabledScheduledTasksCount, runningScheduledTasksCount, hasEnabledScheduledTasks, hasRunningScheduledTasks) }`; quiet `enabled:<n> running:<n>`.
- `list` → json `{ tasks }`; quiet per task `<id> enabled:yes|no goal:yes[budget:<n>]|no status:<lastStatus|idle> <schedule:str> <name>`; human clack list.
- `create` → json `{ task, created }`; quiet `<task.id>`; log line `id, goal, schedule`.
- `run` → json `{ task, sessionId }`; quiet `<sessionId>`.
- `delete` → json `{ deleted, tasks }`; quiet `deleted <taskId>`.
- `enable/disable` → json `{ task, enabled }`; quiet `<taskId> enabled:yes|no`.

## 23.4 `openchamber models` / `projects`

- `models` → control action `models.list`, inputs `{ providerID?, modelID? }` passthrough of `--*` shape; prints default/favorite/recent models; `--json` prints the control body; `--quiet` prints a compact `default:<provider/model>` style summary.
- `projects` → `projects.list`; prints `{ id, label/path }` per project; `--json` prints the control body.

## 23.5 CLI http helpers recap

- Health probing: `GET /api/system/info` and `/health` for instance discovery with short timeouts; server-side shutdown via `POST /api/system/shutdown` (best-effort with wait).
- Auth headers as per 23.1; `ApiError` mapping to `TunnelCliError` with the documented exit codes; managed-instance restart uses stored run-file options (`launchMode`, `uiPassword`, `apiOnly`, `host`, `port`).

## 23.6 `openchamber status` payload (JSON contract)

`--json` shape (fields per instance row; src: `bin/lib/commands-status.js` + `cli-lifecycle.js`):

```json
{
  "instances": [
    { "port": 3000, "pid": 12345, "launchMode": "daemon", "source": "registry|probe",
      "runtime": "web|desktop", "protection": "password|none|client-auth", "uiPasswordGenerated": false,
      "tunnel": { "active": false, "ready": false, "url": null } }
  ],
  "messages": [ { "level": "info", "code": "...", "message": "..." } ]
}
```

Human/quiet rendering summarizes the same rows (`port mode:<launchMode> pass:<only-when-generated>`); desktop-managed instances are listed but marked unstoppeable. Tunnel readiness appears when the instance answers `/api/openchamber/tunnel/status`.

# 24. Appendix I — Custom theme JSON schema (served by `/api/config/themes`)

Custom themes live as JSON files in `<data-root>/themes/*.json` (≤ 512 KiB each; duplicates by id skipped; invalid files skipped with a log). Structure (src: `packages/web/server/lib/opencode/theme-runtime.js`):

```json
{
  "metadata": {
    "id": "my-theme",            // required, non-empty, unique
    "name": "My Theme",          // required
    "description": "",           // optional
    "version": "1.0.0",          // optional, default 1.0.0
    "variant": "dark",           // required: 'light' | 'dark'
    "tags": ["portfolio"]        // optional string[]
  },
  "colors": {
    "primary": { "base": "…", "foreground": "…" },
    "surface": { "background": "…", "foreground": "…", "muted": "…", "mutedForeground": "…",
                 "elevated": "…", "elevatedForeground": "…", "subtle": "…" },
    "interactive": { "border": "…", "selection": "…", "selectionForeground": "…",
                     "focusRing": "…", "hover": "…" },
    "status": { "error": "…", "errorForeground": "…", "errorBackground": "…", "errorBorder": "…",
                "warning": "…", "warningForeground": "…", "warningBackground": "…", "warningBorder": "…",
                "success": "…", "successForeground": "…", "successBackground": "…", "successBorder": "…",
                "info": "…", "infoForeground": "…", "infoBackground": "…", "infoBorder": "…" },
    "syntax": {
      "base": { "background": "…", "foreground": "…", "keyword": "…", "string": "…", "number": "…",
                "function": "…", "variable": "…", "type": "…", "comment": "…", "operator": "…" },
      "highlights": { "diffAdded": "…", "diffRemoved": "…", "lineNumber": "…" }
    }
  }
}
```

Every listed color slot must be a non-empty string or the file is rejected. The response of `GET /api/config/themes` is `{ themes: [full normalized theme JSON] }`; the UI additionally reads built-in themes from its own bundle.

# 25. Appendix J — Wire examples (derived from the contracts above)

These JSON sketches are **derived from this document's tables** to serve as implementation targets; where a field is optional it is marked with a comment.

## 25.1 Start a tunnel

```json
POST /api/openchamber/tunnel/start
{ "provider": "cloudflare", "mode": "managed-remote",
  "token": "eyJh…", "hostname": "app.example.com",
  "managedRemoteTunnelPresetId": "prod-main", "connectTtlMs": 1800000 }

→ 200 { "ok": true, "url": "https://app.example.com",
        "mode": "managed-remote", "provider": "cloudflare",
        "providerMetadata": { "version": "2024.8.3" },
        "connectUrl": "https://app.example.com/connect?t=AbCdEf…",
        "bootstrapExpiresAt": 1737012345678,
        "replacedTunnel": false, "replaced": null,
        "revokedBootstrapCount": 1, "invalidatedSessionCount": 3,
        "policy": "tunnel-gated", "activeTunnelMode": "managed-remote",
        "activeSessions": [ { "sessionId": "…", "tunnelId": "…", "mode": "managed-remote",
                              "publicUrl": "https://app.example.com",
                              "createdAt": 1737000000000, "lastSeenAt": 1737000600000,
                              "expiresAt": 1737028800000, "status": "active",
                              "inactiveReason": null } ],
        "localPort": 3000,
        "ttlConfig": { "bootstrapTtlMs": 1800000, "sessionTtlMs": 28800000 } }
```

## 25.2 Pairing a device

```json
POST /api/client-auth/pairing/sessions        // with a UI session cookie
{ "label": "Ops iPad", "allowedClientKinds": ["mobile"], "includeRelay": true }
→ 201 { "pairing": { "id": "pair_1a2b3c…", "createdAt": "…", "expiresAt": "…",   // +10 min
        "fingerprint": "A1B2-C3D4", "allowedClientKinds": ["mobile"],
        "label": "Ops iPad", "usesRelay": true },
        "secret": "Hx8…base64url…",                       // shown once
        "server": { "label": "workstation-1",
                    "candidates": [ { "type": "tunnel", "url": "https://app.example.com", "priority": 10 },
                                    { "type": "relay", "relayUrl": "wss://relay.openchamber.dev/ws",
                                      "serverId": "8f31…", "priority": 30 } ] } }

POST /api/client-auth/pairing/redeem          // from the device (public, rate-limited)
{ "pairingId": "pair_1a2b3c…", "secret": "Hx8…", "clientKind": "mobile",
  "deviceName": "iPad Air", "devicePlatform": "ios", "appVersion": "1.0.0",
  "dedupeKey": "capacitor-device-42" }
→ 200 { "ok": true, "server": { "label": "workstation-1",
        "url": "https://app.example.com", "fingerprint": "A1B2-C3D4" },
        "client": { "id": "a1b2c3d4e5f6…", "label": "Ops iPad", "clientKind": "mobile",
                    "authMethod": "pairing", "usesRelay": true },
        "clientToken": "oc_client_xK9…" }
```

## 25.3 Queue a message

```json
POST /api/message-queue/sessions/ses_42/items
{ "directory": "/home/u/proj",
  "item": { "id": "q1", "createdAt": 1737000000000, "content": "Next: fix flaky test",
            "text": "Next: fix flaky test",
            "attachments": [],
            "context": [ { "kind": "context", "text": "linked #214", "metadata": { "type": "github-issue", "number": 214 } } ],
            "sendConfig": { "providerID": "anthropic", "modelID": "claude-…", "agent": "build" } } }
→ 200 { "revision": 17, "session": { "sessionId": "ses_42", "directory": "/home/u/proj", "items": 1 },
        "itemId": "q1" }

// broadcast on /api/openchamber/events + WS:
event: openchamber:message-queue.updated
data: { "type": "openchamber:message-queue.updated",
        "properties": { "revision": 17, "session": { "sessionId": "ses_42", "directory": "/home/u/proj" } } }
```

## 25.4 Git status of a repository

```json
GET /api/git/status?directory=/home/u/proj
→ 200 { "isGitRepository": true, "branch": "main", "ahead": 1, "behind": 0,
        "files": [ { "path": "src/a.ts", "staged": false, "untracked": false, "deleted": false,
                     "insertions": 12, "deletions": 3 } ],
        "tracking": { "remote": "origin/main" } }
// (exact file-entry fields per git service; a non-repo answers the canonical empty payload instead)
GET /api/git/status?directory=/home/u/plain-dir
→ 200 { "isGitRepository": false, "files": [], "branch": null, "ahead": 0, "behind": 0 }
```

## 25.5 Boot the managed harness (server console path)

```text
applyConnectAttemptTimeout()
→ [server] Starting OpenChamber on port 3000
→ Serving static files from …/dist
→ Setting up OpenCode API gate (OpenCode not started yet)
→ launch: resolveOpenCodeCliPath → env → settings → PATH → (win: WSL)
→ spawn: <augmentedPath> opencode serve --port <chosen> … env: OPENCODE_BINARY, harness auth password, agent-tool plugin env, OPENCODE_CONFIG_DIR/CONTENT
→ ipc: { type: 'openchamber:ready', port: 3000 }   // to the serving CLI
→ health poll every 15s → watcher subscribes /global/event → hub
```

# 26. Appendix K — Diagnostics: what to log and where

- Server stdout (captured to `<data-root>/logs/openchamber-<port>.log` in daemon mode) logs: boot banners (`Starting OpenChamber on port`), static dir resolution, proxy target setup, harness launch diagnostics (`lastOpenCodeLaunchDiagnostics`, exposed on `/health`), tunnel lifecycle lines, update-install preamble, session-assist hub start.
- Verbose per-request line only with `OPENCHAMBER_VERBOSE_REQUEST_LOGS=true` (2.6).
- The `/health` snapshot is the primary runtime introspection surface (all harness binary/WSL/auth diagnostics included, 5.1).
- Proxy/SSE errors are logged with `[proxy]` prefixes; harness restart reconciliation logs `[OpenCode]`-family lines (restart, interrupted sessions).
- Update log: `<data-root>/update-install.log` (self-update preamble lines, 5.5).
- Store mishaps log `[themes] Skip …`, `[JWT] …`, `[WebPush]`/`[Push]` warnings; message-queue corruption moves the file and logs; relay ops log lifecycle (`relay/DOCUMENTATION.md` documented codes: standby, claim taken/lost, `Control replaced`).

# 27. Appendix L — Two more numbered flows

## 13.8 Flow H — Scheduled task fires

1. `scheduledTasksRuntime.start()` loads crons per project config at boot (Stage 16/18 of the boot sequence); schedule kinds: `daily` (times), `weekly` (weekdays+times), `once` (date+time), `cron` (expression + optional IANA timezone).
2. At fire time it calls the control-service run path: resolve project → ensure harness ready → create (or reuse) a session in the project directory → dispatch the task prompt (via the same prompt-dispatch pipeline as 5.17, including knowledge block and optional goal mode with token budget).
3. Success → SSE event `openchamber:scheduled-task-ran { projectId, taskId, ranAt, status, sessionId? }`; the run status is persisted in the task record (`state.lastStatus`).
4. Errors set status and retry policy per task config (doc 12 owns retry/loop-file semantics).

## 13.9 Flow I — Self-update (non-desktop)

1. UI polls `GET /api/openchamber/update-check` (channels: update API default + GitHub releases); user clicks install.
2. `POST /api/openchamber/update-install`: response returns immediately; a detached script updates the global package via the detected package manager, then re-spawns `openchamber serve` with the stored run-file options (or queues a systemd restart for foreground services).
3. The current server process exits (graceful shutdown), ports freed; the new process re-reads `run/openchamber-<port>.json`; UI reconnects (server port may stay the same).
4. Failure path: log to `<data-root>/update-install.log`; the old process is already gone — an operator restarts with the same command (this is why run-file options are persisted).

# 28. Appendix M — Terminology map (OpenChamber → NotNativeDesktop)

| OpenChamber term | Definition | Reimplementation guidance |
|---|---|---|
| Harness / OpenCode | The agent server process (spawned or attached) behind `/api` proxying | Your agent runtime; keep the `/api` proxy contract (Section 4) and doc 02's wire format |
| Managed chats root | `<data-root>/chats` worktree root for disposable "chat" sessions | Keep a relocatable worktree root (`OPENCHAMBER_CHATS_DIR`) |
| Project | A registered workspace directory (`projects[]` in settings) with id = hash-of-path | Same; drives per-project config, scheduled tasks, memory scope |
| Worktree bootstrap | Git clone/checkout + setup-script pipeline feeding a directory to the harness | Implement `GET /api/git/worktrees/bootstrap-status` statuses used by the proxy hold |
| Session goal | File-backed objective per session driving completion detection | `<data-root>/goals/<sessionId>.md` + doc 12 semantics |
| Tunnel scope | Requests arriving via the tunnel hostname | Same classification + `tunnelLocked` semantics |
| Client token | `oc_client_…` bearer for paired devices | Same format & hashed store |
| URL token | `oc_url_…` 60 s read-only/WS token | Same allowlist (8.2) |
| Magic prompts | Server-owned prompt override store | `magic-prompts.json`, id pattern + length limits |
| Small model | A cheap harness model used for summarization/goal/notifications | `GET /api/small-model*` semantics; resolution helpers `describeSmallModel`, `generateSmallModelText` |
| Deferred restart | Config-mutation response when a harness restart cannot be automatic | `{ requiresReload|requiresRestart, message }` envelope |
| Relay | Private E2EE transport (host + worker) | Doc 08; this doc only lists `/api/openchamber/relay/*` and the demand-driven lifecycle |
| Integration surfaces | GitHub + Linear feature apps | Route tables 5.23/5.24; token stores in the data root |
| Desktop shell runtime | `OPENCHAMBER_RUNTIME=desktop` behaviors | Compression off, updater swap, realtime-proxy pairing |

This closes document 03. Canonical cross-references remain: **02** (harness wire payloads), **04** (client sync/state projection), **07** (terminal protocol), **08** (relay/tunnel/auth protocols), **12** (scheduled tasks/message queue/goals), **13** (preview & dev-server semantics).

# 29. Appendix N — Route inventory summary (what "complete" means)

Counts by family as implemented in Section 5 (register-time enumeration; `use`-level middleware excluded except listed pipelines):

| Family | Routes | Source module |
|---|---|---|
| server status/system + service status/info | 7 (+`/health`) | `opencode/core-routes.js` (registerServerStatusRoutes) |
| auth/session/url-token/passkeys | 12 | `opencode/core-routes.js` (registerAuthAndAccessRoutes) |
| remote clients + pairing + tunnel connect + probe | 11 | `core-routes.js` + `client-auth/*` + `opencode/tunnel-auth.js` (`/connect`) |
| OpenChamber platform (update/zen/models-metadata/agent-tool) | 5 | `opencode/openchamber-routes.js`, `agent-tool/runtime.js` |
| settings/config utilities + provider config + behavior + opencode ops | 13 | `opencode/routes.js`, `core-routes.js` (registerSettingsUtilityRoutes) |
| config entities (agents/commands/mcp/snippets) | 19 | `opencode/config-entity-routes.js` |
| plugins | 10 | `opencode/plugin-routes.js` |
| skills | 12 | `opencode/skill-routes.js` |
| git | 68 | `git/routes.js` |
| fs | 17 | `fs/routes.js` |
| project setup/config + icons | 7 | `projects/routes.js`, `opencode/project-icon-routes.js` |
| scheduled tasks (project routes + global) | 8 | `scheduled-tasks/routes.js` |
| openchamber sessions + control | 5 | `openchamber-sessions/routes.js`, `openchamber-control/routes.js` |
| message queue | 8 | `message-queue/runtime.js` |
| permission auto-accept | 2 | `permission-auto-accept/runtime.js` |
| goals | 3 | `session-goal/routes.js` |
| session knowledge | 4 | `session-knowledge/routes.js` |
| session folders | 2 | `session-folders/routes.js` |
| project context | 11 | `project-context/routes.js` |
| agent memory | 4 | `agent-memory/routes.js` |
| github | 19 | `github/routes.js` |
| linear | 14 (+ OAuth callback page route off-`/api`) | `linear/routes.js` |
| quota credentials/usage | 7 | `quota/routes.js` |
| small model | 2 | `small-model/routes.js` |
| walkthrough | 5 | `walkthrough/routes.js` |
| magic prompts | 4 | `magic-prompts/routes.js` |
| markdown image grants | 1 | `markdown-image-grants/routes.js` |
| dev-servers | 1 | `dev-servers/routes.js` |
| browser control | 2 | `browser-control/routes.js` |
| tunnels | 8 | `tunnels/routes.js` |
| relay | 3 | `relay/service.js` |
| realtime proxy | 1 (+WS) | `lib/realtime-proxy.js` |
| notifications/push/session status | 16 | `notifications/routes.js` |
| tts/voice/text/stt | 7 | `tts/routes.js` |
| dictation | 4 (+WS) | `dictation/runtime.js` |
| terminal | 9 (+WS) | `terminal/runtime.js` |
| PWA manifest + robots + MCP OAuth callback + static/SPA | 5 registered + fallback regexes | `opencode/pwa-manifest-routes.js`, `static-routes-runtime.js`, `index.js` |
| OpenCode proxy pipelines | 2 SSE routes + 2 sanitize routes + Windows merge + catch-all | `opencode/proxy.js` |
| **Total/OpenChamber-owned** | **≈ 253** | |

Any reimplementation must match this enumeration; adding routes is fine, dropping one is a spec violation unless this document is amended.
