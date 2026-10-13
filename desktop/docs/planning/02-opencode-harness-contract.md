# NotNativeDesktop — Doc 02: OpenCode Harness Integration Contract

> **Reference status — 2026-10-01:** This document records OpenChamber behavior.
> Execute [the NND build guide](../build/PLAN.md) and its native-contract amendments.
> Reference auto-accept, managed-harness, TUI, and process-ownership details do not
> override NNA governance or the independent NNA/NND product boundary.
> Use the [document disposition audit](../build/EXECUTION/01-architecture-audit.md)
> and feature coverage guide before treating a reference requirement as executable work.


Status: cleanroom reference. Derived from OpenChamber at `@opencode-ai/sdk` **1.18.30** (root `package.json`). Source paths are cited as `(src: <repo path>)` for traceability only — the target team must implement from this document alone and must treat every table, enum, and default here as the contract.

Audience: engineers rebuilding OpenChamber's UI/UX on a **replacement agentic harness** ("the harness") that supplies the same capabilities OpenCode supplies today. Doc 04 (`04-sync-and-state-engine.md`) owns what the browser does with events; doc 03 (`03-server-and-api-reference.md`) owns the complete OpenChamber route table; doc 12 owns goals/multirun/scheduled orchestration. This document owns the **seam between UI, OpenChamber server, and the harness**.

Conventions used below:

- **OpenChamber server** = the Node/Bun HTTP server that hosts the UI, owns settings/projects/worktrees/terminal/notifications, and brokers everything the harness does.
- **Managed harness** = a harness process the OpenChamber server spawns and owns its lifecycle. **External harness** = a harness process started by the operator that the server merely attaches to.
- Routes written as `GET /session` are **harness routes** (what OpenCode serves on its own port). Routes written as `GET /api/...` are **OpenChamber routes** (what the server serves to the browser).
- "SDK" quotes the `@opencode-ai/sdk/v2` method surface the UI actually calls. A replacement kit must expose the same method names or map them, because the UI calls them directly.

---

## 0. How to read this document

| Section | Owns |
| --- | --- |
| 1 | Two-tier contract map (browser→server, server→harness) |
| 2 | Harness process lifecycle: who starts it, ports, env vars, health, restart, upgrade; full flow catalog LF-1 … LF-19 |
| 3 | Tier 1: browser UI → OpenChamber server transport/auth/proxy contract; every SDK call the browser makes |
| 4 | Tier 2: server → harness REST inventory (every call site, body, response, mode restrictions) |
| 5 | Event stream contract: SSE wire forms, all event types, browser-facing transports, reconnect semantics |
| 6 | Session/message/part/permission/question semantics the UI conditions on |
| 7 | Model/provider/variant/quota contract |
| 8 | Everything OpenChamber injects into the harness (tools, plugins, prompts, auto-accept) |
| 9 | Port catalog: the consumable boundary, split into contract ports (P-01…) |
| 10 | Managed vs external mode matrix |
| 11 | Correctness invariants the boundary enforces |
| 12 | Build checklist: minimal vs full harness compatibility |
| 13 | Cross-references |

### 0.1 Lexicon (shared vocabulary across doc 02/03/04)

| Term | Meaning in this document |
| --- | --- |
| harness | The agentic backend (OpenCode today; the replacement target) that runs agent loops, owns sessions/messages/parts, emits the event stream |
| managed / external | Harness process spawned by OpenChamber (lifecycle owned) vs attached to by env config (§2.3, §10) |
| directory | The absolute local path a session runs in; the universal scoping key for harness APIs (§3.5) |
| project | A directory OpenChamber has registered (OpenChamber settings) ≈ a harness `project` (git worktree root); IDs differ — OpenChamber maps directory ↔ its own projectId |
| session | A conversation thread: `sessionID`, directory-scoped, optional `parentID` (subagents/forks) |
| turn | One user prompt plus the assistant loop it starts; `prompt_async` starts one; idle/`session.idle` ends one |
| step / part | A step is one model round inside a turn (`session.next.step.*`); a part is one renderable content unit of a message (§6.3) |
| callID | Identifier of one tool invocation, stable across the tool lifecycle events (§6.3) |
| partID/messageID | Durable identifiers OpenChamber echoes (`messageID` may be client-generated pre-send; harness must echo it, §11 item 14) |
| snapshot | Git-state marker taken at turn boundaries (`step-start/finish`, `session.next.tool.*.snapshot`) backing revert (§6.1 `revert`) |
| control stream | OpenChamber-owned event channels (`/api/notifications/stream`, `/api/openchamber/events`, WS fanout) carrying only `openchamber:*` events (§5.3-4) |
| control service | The OpenChamber module turning `openchamber`-tool/CLI actions into harness calls (§8.1, LF-13) |
| url token | Short-lived `oc_url_token` for stream/asset URLs when headers cannot be attached (LF-18) |

### 0.2 Scope and validation status of this document

- **What was read at source**: the browser-side OpenCode client and transport (`packages/ui/src/lib/opencode/client.ts`, `runtime-fetch.ts`, `runtime-auth.ts`, `runtime-url.ts`, `runtime-switch.ts`, `smallModel*.ts`, `openCodeStatus.ts`, `deferredRestart.ts`, `provider-tracker.ts`, `sync/types.ts`, `sync/vscode-permission-auto-accept.ts`), the server composition and OpenCode modules (`packages/web/server/index.js`, `proxy-headers.js`, `realtime-proxy.js`, `lib/opencode/*` (lifecycle/env/network/auth/proxy/routes/session/watcher/server-utils/managed-plugin-config), `lib/event-stream/*`, `lib/agent-tool/*`, `lib/openchamber-control/*`, `lib/openchamber-sessions/routes.js`, `lib/permission-auto-accept/*`, `lib/system-prompt/*`, `lib/small-model/*` (index/routes + DOCUMENTATION), `lib/quota/DOCUMENTATION.md`, `lib/inherited-env.js`, `lib/browser-control/routes.js`), and the **exact type definitions of `@opencode-ai/sdk@1.18.30`** (`dist/v2/gen/types.gen.d.ts`, `sdk.gen.d.ts`, `client.js`, `dist/index.d.ts`).
- **Ground-truth precedence**: SDK type definitions > server code > server DOCUMENTATION.md > UI code. Where the SDK's generated body types omit a field the UI passes (`delivery`), this is flagged inline rather than silently normalized.
- **Not covered here** (deliberately): the full OpenChamber route table (doc 03), the client event reducers and stores (doc 04), goals/multirun/scheduled orchestration internals (doc 12), Electron/mobile/VS Code shell specifics (their docs) — only their harness-facing seams appear here.
- **Known unknowns** (told honestly): the exact OpenCode server implementation behind a few response fields marked "(open record)" (e.g. `models-dev.refreshed`, `reference.updated`, `lsp.updated` payload members) — these are pass-through residues that consumers treat as opaque; a replacement may emit them as `{}`-payload events without losing UI behavior. VS Code extension parity (its own spawn/proxy stack) is asserted at the level of "same env vars, separate process" — its internal parity work is doc-03/05 territory.

---

## 1. Two-tier contract map

The UI never talks to the harness directly. All traffic crosses OpenChamber's HTTP server, whose `/api` prefix is simultaneously (a) its own API namespace and (b) a reverse proxy into the harness for everything it does not own. This split-shell shape is load-bearing.

```
┌─────────────── browser / desktop / vscode / mobile shell ────────────────┐
│  shared UI                                                               │
│   └─ opencodeClient (SDK wrapper)  →  runtimeFetch  →  OpenChamber /api   │
│   └─ EventPipeline (WS /api/global/event/ws, dir WS /api/event/ws)        │
│   └─ RuntimeAPIs (terminal, git, files, settings, push … server-owned)    │
└─────────────────────── transport ─────────────────────────────────────────────┘
                                 │ HTTP + WS (same origin or relay tunnel)
                   ┌─────────────▼─────────────┐
                   │  OpenChamber server (:3000)│
                   │  ui-auth, settings, git,   │
                   │  fs, quota, tts, push,     │
                   │  sessions service, tools   │
                   └─────────────▼─────────────┘
                                 │ Basic auth, proxy hop-by-hop filter
                                 │ GET /session | POST /session/:id/prompt_async | …
                   ┌─────────────▼─────────────┐
                   │  Harness (OpenCode :random)│
                   │  REST + SSE  /global/event │
                   └───────────────────────────┘
```

Two tiers, exactly:

1. **Tier 1 — Browser → OpenChamber server.** The UI's SDK base URL is `/api` (resolvable to an absolute URL through the runtime URL resolver; `src: packages/ui/src/lib/opencode/client.ts:45`). Every SDK call to `/session`, `/agent`, … goes out as `/api/session`, `/api/agent`, … Routes OpenChamber owns are answered by OpenChamber; everything else is forwarded to the harness with a single prefix rewrite. Auth to OpenChamber is the UI session bearer; auth to the harness is added by the server, never by the browser.
2. **Tier 2 — OpenChamber server → harness.** The server calls the harness for lifecycle (health, spawn, restart), for session-side aggregation (the "control service"), and to attach one SSE reader for events. There is exactly **one** global upstream SSE reading `GET /global/event` shared by all server-side consumers plus browser fan-out (`src: packages/web/server/index.js:888`, `src: packages/web/server/lib/event-stream/global-hub.js`). Directory-scoped server reads use directory-scoped REST calls.

### 1.1 Why the split matters to the target team

- The harness never sees UI client credentials. The proxy strips `Authorization` from the browser and injects the harness's own Basic credential (`src: packages/web/server/proxy-headers.js:1`).
- The harness serves exactly the HTTP surface in §4/§9; OpenChamber assumptions about sessions, ordering, permissions, and events are the contract, not the UI's own code.
- A replacement harness must either (a) implement the same routes, or (b) shim them behind the same port behind a thin adapter, and in both cases speak the event stream of §5. Doc 04's reducer shapes are downstream of §5 and cannot be negotiated independently.

---

## 2. Harness process lifecycle and flow catalog (LF-1 … LF-19)

### 2.1 Environment variables and ports

Configuration is read by `resolveOpenCodeEnvConfig` (`src: packages/web/server/lib/opencode/env-config.js:24`). Exact semantics:

| Env var | Meaning | Values / defaults |
| --- | --- | --- |
| `OPENCODE_PORT` (alias `OPENCHAMBER_OPENCODE_PORT`, `OPENCHAMBER_INTERNAL_PORT`) | preferred harness listen port | integer > 0; if unset, the server allocates a fresh ephemeral port per launch |
| `OPENCODE_HOST` | attach to an existing harness at an explicit origin | must parse as `http://` or `https://` URL **with explicit port**, no path/query/hash (e.g. `http://hostname:4096`); overrides `OPENCODE_PORT` |
| `OPENCHAMBER_OPENCODE_HOSTNAME` | bind hostname for a managed harness | default `127.0.0.1`; IPv4/IPv6/hostname accepted, `0.0.0.0` allowed but connections always target `127.0.0.1` (`src: packages/web/server/lib/opencode/network-runtime.js:8`) |
| `OPENCODE_SKIP_START` (alias `OPENCHAMBER_SKIP_OPENCODE_START`) | never spawn; attach only | `true` requires an effective port/host |
| `OPENCODE_BINARY` | binary resolution override (VS Code sets it into the managed spawn; web prefers settings + discovery) | path |
| `OPENCODE_SERVER_PASSWORD` | harness Basic-HTTP password; also read back from the auth header builder | non-empty string; user-provided values are honored, otherwise the server generates/rotates one (`src: packages/web/server/lib/opencode/auth-state-runtime.js:61`) |
| `OPENCODE_SERVER_USERNAME` | harness Basic-HTTP username | default `opencode` |
| `OPENCODE_CONFIG_CONTENT` | inline harness config (JSON/JSONC object) injected into the managed process env; OpenChamber appends its plugins here | string |
| `OPENCODE_API_PREFIX` / `OPENCHAMBER_API_PREFIX` | **ignored, warned** (`src: packages/web/server/index.js:700`) | — |
| `OPENCHAMBER_OPENCODE_HEALTH_TIMEOUT_MS` | per health-probe timeout | default 5000 |
| `OPENCHAMBER_OPENCODE_HEALTH_CONSECUTIVE_FAILURES` | restart threshold | default 20 |
| `OPENCHAMBER_OPENCODE_HEALTH_INTERVAL_MS` | health monitor period override | default 0 (= server default 15000) |
| `OPENCHAMBER_OPENCODE_HEALTH_CACHE_MS` | health result cache window | default 750 |

Derived state: `effectivePort = OPENCODE_HOST?.port ?? OPENCODE_PORT`, `configuredOpenCodeHostname`, `configuredOpenCodeHost` `{origin, port}` (`src: packages/web/server/lib/opencode/env-config.js:72`).

Harness URL construction is `buildOpenCodeUrl(path, '')` = `base + path` where `base = openCodeBaseUrl ?? http://<hostname>:<openCodePort>`; it throws if the port is unknown (`src: packages/web/server/lib/opencode/network-runtime.js:86`). The API prefix is always empty in this build (`ensureOpenCodeApiPrefix` just flips `openCodeApiPrefixDetected=true`); the harness API lives at the root of its port.

### 2.2 LF-1: server starts a managed harness

`bootstrapOpenCodeAtStartup` → `startOpenCode` (`src: packages/web/server/lib/opencode/lifecycle.js:1122` and `:684`):

1. **Reap orphans.** Before anything, the server reaps harness processes it spawned in a *previous* run and orphaned by a crash. The registry is a pid-tagged file (`managed-process-registry.js`); only pids owned by this data dir are touched.
2. **HMR reuse check.** If a previously spawned child of this process family is still alive and `/global/health` says `healthy`, reuse it (`state.openCodeProcess`, `openCodePort` survive dev HMR via `globalThis.__openchamberHmrState`).
3. **External modes** (LF-2) take precedence in this order: (a) skip-start + effective port → attach, (b) effective port answers health → attach, (c) otherwise spawn.
4. **Port.** `OPENCODE_PORT` if set, else bind a probe socket on `127.0.0.1` to allocate an ephemeral port, close it, and hand the number to the child (port 0 never reaches the child; the observed port comes from stdout).
5. **Binary.** resolution order is: settings-persisted CLI → env override `OPENCODE_BINARY` → bundled Desktop CLI (only under `OPENCHAMBER_RUNTIME=desktop`) → PATH → known install locations → login-shell discovery. Windows unwraps package-manager shims to `node <script>`/`bun` wrappers (`resolveManagedOpenCodeLaunchSpec`).
6. **Password.** `ensureLocalOpenCodeServerPassword({ rotateManaged: true })` — user-provided password wins; else a fresh 256-bit base64url value is generated **for every managed spawn** and set into the child env as `OPENCODE_SERVER_PASSWORD` (also mirrored into the server's own `process.env` for header generation).
7. **Path.** `buildManagedOpenCodePath()` merges login-shell PATH + process PATH (+ Windows toolchain dir list) into the child PATH.
8. **Injection env.** `getManagedOpenCodeEnv()` (`src: packages/web/server/index.js:1246`):
   - agent tools: when `agentControlToolEnabled !== false` or `agentWebToolEnabled !== false` or (`agentMemoryToolEnabled === true` and feature available) → materialize the plugin file `<dataDir>/agent-tool/openchamber-plugin.js` (chmod 0600) and produce a **new** `OPENCODE_CONFIG_CONTENT` with the plugin appended (merge rule: Appendix B), plus `OPENCHAMBER_AGENT_TOOL_URL` / `OPENCHAMBER_AGENT_TOOL_TOKEN` (fresh random 32-byte base64url per child).
   - system-prompt optimizer: when settings `optimizeSystemPrompt === true`, append its plugin to the (possibly already-modified) `OPENCODE_CONFIG_CONTENT` (§8.4).
9. **Provider env aliases.** `applyProviderEnvAliases` copies unset Gemini/Google credential aliases (`GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`) from any present sibling; existing non-empty values are never overwritten.
10. **ARGV0 strip.** Linux AppImage `ARGV0` (and `NODE_CHANNEL_FD`) is removed from the child env before spawn (`src: packages/web/server/lib/inherited-env.js:24`).
11. **Spawn.** exact argv: `<binary> serve --hostname <hostname> --port <port>` (`args = ['serve', '--hostname', hostname, '--port', String(port)]`, `src: packages/web/server/lib/opencode/lifecycle.js:383`), `detached: true` on non-Windows (own process group; tree-signal on stop), `windowsHide: true`, stdio `['ignore','pipe','pipe']`.
12. **URL parse.** The server waits on the child's stdout for a line beginning `opencode server listening` and extracts the URL via `/on\s+(https?:\/\/[^\s]+)/` — **this line is a hard contract**; a harness that prints its listening URL differently breaks managed startup (the error names "Failed to parse server url from output"). The 30-second-startup timeout produces `Timeout waiting for OpenCode to start after 30000ms`; an early exit produces `<exited reason>… Binary used: <binary> <captured stdout/stderr>`.
13. **Register.** The child pid is registered for orphan reaping with `runtime = OPENCHAMBER_RUNTIME || 'web'`.
14. **Readiness.** `waitForReady(url, 10000)` polls `GET /global/health` (3 s per-probe timeout, 100 ms cadence) until `{"healthy": true, "version": …}`. On success the server sets `openCodePort` (from the parsed URL), `openCodeApiPrefix=''`, `isOpenCodeReady=true`, `openCodeNotReadySince=0`.
15. **Startup retries.** `startOpenCode` retries once (2 attempts total) on any failure except `OPENCODE_BINARY_INVALID`, with 750 ms × attempt backoff, re-allocating a port.
16. **After bootstrap.** The server (a) starts periodic health monitoring if managed, (b) starts the global event watcher (LF-3), (c) emits one terminal startup-perf record `opencode.bootstrap.ready|error`, (d) warms recently used directories: sequential `GET /session/status?directory=<dir>` for up to 4 directories (`WARMUP_DIRECTORY_LIMIT` = `lastDirectory` + newest projects deduped, sorted by `lastOpenedAt`), best-effort, 30 s timeout each (`src: packages/web/server/lib/opencode/lifecycle.js:1154`), because the harness initializes each directory lazily on the first directory-scoped request.

### 2.3 LF-2: external attach (skip-start / OPENCODE_HOST / auto-detect)

- Attach requires explicit opt-in: `OPENCODE_SKIP_START=true` + effective port, or `OPENCODE_HOST`, or (ONLY when an effective port was configured) a successful health probe of that port. The server never probes a default port blindly (comment and rationale at `src: packages/web/server/lib/opencode/lifecycle.js:1100`).
- On attach: `state.isExternalOpenCode = true`, `openCodeBaseUrl = configured origin ?? null`, port set from env/probe. The external process never receives OpenChamber tool/plugin injection, never gets its password rotated, and is never restarted automatically except by explicit user action or external-mode "re-probe" (LF-4 in external form: probe health; if unhealthy, fail the requested operation, never spawn).
- `shutdown` skips stopping the harness when skip-start or external (`src: packages/web/server/index.js:1488`).

### 2.4 LF-3: event streaming subscription (server side)

One global upstream reader (the hub) attaches to `GET /global/event` on the harness (`src: packages/web/server/lib/event-stream/global-hub.js:75` via `createUpstreamSseReader`):

- Request: `GET /global/event`, headers `Accept: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `Authorization: Basic …` (when password present), `Last-Event-ID: <lastEventId>` when resuming.
- Subscription lifecycle: waits for OpenCode port, auto-reconnects after close/stall with the last event id, reconnect delay 250 ms, stall timeout 20 s default and 60 s when >1 session is active (`UPSTREAM_STALL_TIMEOUT_CONCURRENT_MS = 3 × 20000`).
- Health checks are only triggered by *initial* connect failure or explicit upstream-unavailable responses — never by ordinary stall recovery on an established stream (`src: packages/web/server/lib/event-stream/DOCUMENTATION.md:48`).
- Consumers of the hub: `openCodeWatcherRuntime` (sessions/notifications side effects), session-assist, session-goal, context-obligatory, linear status, message queue, permission auto-accept, the global WS bridge (browser fan-out). One reader, many subscribers.
- Directory-scoped server reads do **not** keep a persistent directory SSE; the server subscribes through the global stream, and the directory WS bridge (browser side) opens one upstream `GET /event?directory=<dir>` per connecting browser client (`src: packages/web/server/lib/event-stream/DOCUMENTATION.md:45`).

### 2.5 LF-4: restart

`restartOpenCode(reason)` (`src: packages/web/server/lib/opencode/lifecycle.js:818`):

1. Serializes concurrent restarts via `currentRestartPromise`; no-op while shutting down.
2. **Managed:** snapshot restart diagnostics (reason, last health failure `class` ∈ `timeout | connection_refused | connection_reset | invalid_response | error`, process snapshot `{pid, exitCode, signalCode, stderrTail ≤32 KiB, alive}`, busy session count, timestamp) into `lastOpenCodeRestartDiagnostics`; `/health` exposes it afterwards — success does not clear it.
3. Terminate the child (`SIGTERM`→2.5 s→`SIGKILL`→1 s; Windows `taskkill /t` then `/f /t`), kill any other process on the old port (lsof/`Get-NetTCPConnection`), wait for port release (5 s deadline, 150 ms socket probes).
4. Reuse `OPENCODE_PORT` if configured; otherwise allocate a new ephemeral port; clear the API-prefix detection state.
5. `startOpenCode()` again (full LF-1 pipeline from step 6 on). Because the new port can differ, `onOpenCodeRestarted` rebinds all event readers to the current port (`messageStreamRuntime.rebindUpstream()`), then `interruptBusySessionsAfterRestart()` (`src: packages/web/server/lib/opencode/session-runtime.js:297`) settles every session whose authoritative status is `busy`/`retry` or whose activity phase is busy: broadcasts `openchamber:session-status` idle and a harness-shaped `session.error` (`{name:'MessageAbortedError', message:'The running turn was interrupted when OpenCode restarted.'}`) and, when any session was interrupted, one `openchamber` UI notification `opencode-restart-interrupted`.
6. **External:** only re-probes `/global/health` (default port 4096 when unset); on health it re-runs `setupProxy()` and marks ready; otherwise raises and records `lastOpenCodeError`.

Restart triggers: explicit `POST /api/config/reload` after deferred config writes (LF-11), OpenCode upgrade (LF-5), health-monitor thresholds (20 consecutive failures ≈ 5 min; immediate if the process exited; skipped while sessions are busy unless stale-busy > 2 min; `src: packages/web/server/lib/opencode/lifecycle.js:1196`), and transport-triggered immediate checks (`triggerHealthCheck`) which share the periodic failure accounting: rapid WS-reconnect callbacks cannot exhaust the restart threshold using one cached unhealthy result (probe result cache 750 ms, single-flight probe promise).

### 2.6 LF-5: upgrade

`POST /api/opencode/upgrade` (`src: packages/web/server/lib/opencode/routes.js:236`):

1. Capability check is authoritative and fails closed: bundled runtimes (reason `bundled`, code `OPENCODE_UPGRADE_MANAGED_BY_OPENCHAMBER`), external/unresolved (code `OPENCODE_UPGRADE_UNSUPPORTED`), and an in-flight upgrade (code `OPENCODE_UPGRADE_IN_PROGRESS`) → 409.
2. `GET /api/opencode/upgrade-status` returns `{available, currentVersion, latestVersion, upgrade: {supported, manager, reason}}` — version availability from `GET /global/health` (strips a leading `v`) plus the latest GitHub release; when unsupported it still returns `upgrade` capability.
3. The upgrade itself delegates to the harness: `POST /global/upgrade` with body `{"target": "<version>"}`; the harness self-upgrades (200 `{success:true, version}` or `{success:false, error}`). The server then restarts the managed process (`refreshOpenCodeAfterConfigChange('OpenCode upgrade')`), optionally waiting for a specific agent's presence (`waitForAgentPresence`, `GET /agent` polls every 300 ms up to 15 s).

### 2.7 LF-6: shutdown ordering

Graceful shutdown (`src: packages/web/server/lib/opencode/shutdown-runtime.js` composition, constants at `src: packages/web/server/index.js:133-139`): stop watcher/assist/goal/queue runtimes → close WS + SSE clients → clear health interval → close terminal sessions → dispose message stream → stop harness (skip when external/skip-start; `killProcessOnPort` + port-release wait as backstop) → unregister managed process → close tunnel+relay → close HTTP server (10 s SHUTDOWN_TIMEOUT) → optional process exit.

### 2.8 Flow index (every nontrivial harness flow, LF-1 … LF-19)

Flows use these labels throughout the document. Steps are ordered; "harness" = the OpenCode process (or its replacement).

**LF-1 Managed start** — operator runs OpenChamber → server binds listener *first* → spawns harness (§2.2 steps 1-16). The listener publishes its port before spawn so the managed tool gets an authoritative loopback callback URL at injection time (LF-15).

**LF-2 External attach** — `OPENCODE_SKIP_START`/`OPENCODE_HOST`/auto-detect on a configured port → three-attempt ladder in §2.2 step 3 → probe `GET /global/health` → `isExternalOpenCode=true`; no injection, no monitor, no restarts (§10).

**LF-3 Event-stream subscribe (server)** — harness ready → one reader connects to `GET /global/event` → subscribers attach in priority order: watcher (sessions/notifications), auto-accept, message queue, session-assist, session-goal, context-obligatory, linear status, WS bridge fan-out. Reconnect policy: `Last-Event-ID` + 250 ms delay; stall 20 s (60 s when >1 active session); health checks only on initial failure (§2.4, §5.5).

**LF-4 Restart (managed)** — explicit trigger or health threshold → terminate child → kill port → reallocate port → re-spawn (LF-1 from step 6) → rebind readers → interrupt busy sessions → synthetic `session.error` + `openchamber` notification (§2.5).

**LF-5 Upgrade** — `POST /api/opencode/upgrade` → capability gate (409 on unsupported/in-progress) → `POST /global/upgrade {target}` → managed restart via `refreshOpenCodeAfterConfigChange` → optional `waitForAgentPresence` (§2.6).

**LF-6 Shutdown** — §2.7 ordering; external/skip-start harnesses are never stopped.

**LF-7 Browser session create (interactive)** — composer New Chat → UI calls `POST /api/openchamber/sessions` (project-scoped, server-dispatch flow, LF-13) **or**, for the local "chat" surface, `opencodeClient.createSession` → proxied `POST /session` → SSE `session.created` reconciles the store. Draft mode: the UI may create with no prompt and dispatch on first send (draft session = session without user message).

**LF-8 Message send + parts streaming** — optimistic local message (client-generated `msg_…` id) → `POST /api/session/{id}/prompt_async` (browser) → user-message echo event swaps the optimistic record in place (id-keyed) → `session.next.*` deltas stream text/reasoning/tool states → `message.part.updated` per part boundary → assistant message completes with cost/tokens → `session.status idle` + 2 s cooldown → activity idle. Failure paths: `session.next.step.failed`, `session.error`, retry events with `attempt`/`next` (`src: packages/ui/src/lib/opencode/client.ts:858` for the send side; doc 04 owns the reduction).

**LF-9 Permission ask / approve** — harness tool call requires approval → `permission.asked` (v1) and/or `permission.v2.asked` arrive on the stream → UI raises a card in the session (list also restored by `GET /permission` / `GET /api/session/{id}/permission` on resync) → user replies `once|always|reject` via `POST /permission/{requestID}/reply` (v1, per-directory) or v2 `POST /api/session/{sessionID}/permission/{requestID}/reply` → `permission.replied`/`v2.replied` removes the card; 404 on reply means the request was already settled (treat as success, never resurface). If auto-accept is on for the session lineage, the server replies `"once"` before the user sees a card (LF-14).

**LF-10 Question flow (ask tool)** — harness asks → `question.asked` with `questions[]` (header ≤30 chars, options with label/description, `multiple`/`custom` flags) → UI renders the card (custom option = free-text answer) → `POST /question/{requestID}/reply {answers: string[][]}` (one array per question; empty array = "none") or `/reject` → `question.replied|rejected` clears pending state. Resync merges the global list against per-directory lists, dedup by id, throw-on-error (never clear on network failure).

**LF-11 Config edit → deferred restart** — agent/command/MCP/skill/provider writes go to OpenChamber config-file APIs (doc 03), each response `{requiresReload:false, requiresRestart:true, restartDeferred:true}`; the UI accumulates a pending-restart badge; `POST /api/config/reload` applies: managed ⇒ restart harness (LF-4) and refresh stores; external ⇒ `{requiresManualRestart:true}` and the UI delivers manual-restart guidance and clears the badge. Skills installs may answer `{requiresReload:true, reloadFailed?:boolean, warning?, message?, reloadDelayMs?}` (`src: packages/ui/src/lib/opencode/deferredRestart.ts`).

**LF-12 File access model** — three layers, in priority order:
1. **OpenChamber files API** (`RuntimeAPIs.files`): `/api/fs/list·read·write·mkdir·stat·raw·search·delete·rename·upload` — the primary local-file surface, with outside-workspace request/grant flow (`allowOutsideWorkspace` + `outsideFileGrant` query params; the UI requests and the server records one-time grants).
2. **Harness file APIs** (`GET /file`, `/file/content`, `/file/status`, `/find*`): used for project-row reads in chat (session file summaries) and symbol search; directory-scoped.
3. **Desktop native files** (`isDesktop && files`): the Electron shell can answer `listDirectory` locally, bypassing HTTP; identical shape.
Never derive file-truth from the harness where OpenChamber's API can answer (the harness has no notion of grants and `/path` cannot stat deleted directories — §3.3).

**LF-13 Server-side dispatch with dispatch confirmation** (the "observed dispatch" rule; provider = `openchamber-sessions/routes.js` + control service): waitForOpenCodeReady(10 s) → validate requested model/agent/variant against the directory's own `/config/providers` + `/agent` **before** any artifact creation → optional git worktree create + bootstrap wait (60 s) → `POST /session?directory=` → capture baseline last-user-message id → (optional) session-goal create → `POST /session/{id}/prompt_async?directory=` with parts `[knowledge? (synthetic), prompt, goalIntro? (synthetic)]` → `waitForPromptLanded` polls `GET /session/{id}/message?limit=100` for a new user message (5 s, 150 ms poll) → result `{promptDispatched: boolean, promptError?}` and, for tool callers, `wait: lastAssistant` loop `waitForIdle` (500 ms poll; status busy/retry ⇒ activity; idle after observed activity ⇒ done; timeout is a failure) (`src: packages/web/server/lib/openchamber-sessions/routes.js:465`, `openchamber-control/service.js:222`).

**LF-14 Permission auto-accept loop** — policy in OpenChamber settings (`permissionAutoAccept.sessions[sessionId]`, revision++) → hub hooks `permission.asked` (plus reconcile on connect and on enable) → lineage walk over `parentID` (parent toggle covers subagent sessions) → v1 reply `{"reply":"once"}` (retries 0/250/1000 ms, 5 s timeout, 404 = settled) → policy change broadcast `openchamber:permission-auto-accept.updated {sessions, revision}`; notification suppression consults `isSessionAutoAccepting` (§8.5).

**LF-15 Managed-tool callback** — model calls `openchamber`/`openchamber_web`/`openchamber_memory` → harness executes the tool with `{input, context:{directory, abort, metadata}}` → plugin posts `http://127.0.0.1:<openchamberPort>/api/openchamber/agent-tool` `Authorization: Bearer <per-child token>` `{input, contextDirectory, tool}` → OpenChamber resolves the action inside the *calling tool's* action set → executes through the shared control service (same code path as the CLI's HTTP adapter, LF-13/LF-9/LF-14 for sessions) → `{"schemaVersion":1, ok, action, data|error}` back to the plugin → plugin returns `{title, output: <json string>, metadata:{openchamber:{...ok}}}` to the harness (§8.1).

**LF-16 Browser-handled browser-panel round trip** (`browser.*` actions): control service validates the input → `openchamber:browser-control-request {requestId, action, parameters}` to connected UI clients (capable ones unless `browser.open`) → the client owning the browser panel claims and answers (`POST /api/browser-control/claim`, then `POST /api/browser-control/result` with `{requestId}`, 2 MB limit — exact paths from `packages/web/server/lib/browser-control/routes.js`) → for `capture` the server saves the file and returns path + hint (§8.1); timeouts: 45 s open, 20 s others.

**LF-17 Provider OAuth through OpenChamber** — UI requests `POST /api/provider/{id}/…`? No: the UI calls the SDK (`client.provider.oauth.authorize`) through the proxy; OpenChamber only special-cases the callback deadline (15 min) and MCP's `authenticate` helper; device-code/loopback flows block pending the browser; result `ProviderAuthAuthorization {url, method:"auto"|"code", instructions}`; success lands in harness `auth.json` and the UI refetches `GET /provider` (§3.2 interactive-OAuth timeout; §7.3).

**LF-18 Auth token minting (browser)** — session-less transports (EventSource/WS/img) need `oc_url_token`: `POST /auth/url-token` (bearer or cookie) → `{token, expiresAt}` → proactive refresh at expiry−15 s while consumers exist; restore after relay activation (`switchRuntimeEndpoint`) before the first WS/SSE attach (§3.1).

**LF-19 UI recovery after harness restart** — restart (LF-4) → readers rebound → sessions interrupted synthetically → browser sees upstream reconnect edge → WS bridge `ready` frames (possibly `replayReset:true`) → doc 04's resync from authoritative snapshots (`/session/status` snapshot omits=idle; documents refetched), never from replayed partial truth (§5.3, §11.13).

### 2.9 What OpenChamber itself owns (explicitly NOT harness work)

- **git** (status, diff, worktrees, commits, push/pull/stash, identities) — `lib/git/*` on the `git` binary; the harness never runs OpenChamber's git commands.
- **Project files** — `/api/fs/*` with outside-workspace grants.
- **Settings, pairing, remote clients, tunnels/relay, push/APNs, TTS/dictation, terminal PTY, quota, notifications, session folders/knowledge/project context, agent memory store, scheduled-task scheduler, walkthrough** — all OpenChamber server features (docs 03/12).
- The harness replacement must NOT be given any of these (§9.3).

---

## 3. Tier 1: browser UI → OpenChamber server

### 3.1 Transport primitives

This subsection is the complete transport contract; a replacement must reimplement it or keep it byte-compatible, because every UI surface calls it.

**runtimeFetch** (`src: packages/ui/src/lib/runtime-fetch.ts`):

- Input classes: relative strings starting `/api/`, `/api`, `/auth/`, `/auth`, `/health` are resolved through the runtime URL resolver (`getRuntimeUrlResolver()`); absolute URLs equal to the current window origin and under those path prefixes are rewritten too (`isCurrentWindowUrl` + `shouldResolveApiPath`); anything else goes to the network untouched.
- Resolver functions (`src: packages/ui/src/lib/runtime-url.ts:140`): `api(path, query)` builds from the configured/injected API base; `auth(path)`; `health()` → `/health`; `authenticatedAsset(path)` appends `oc_url_token=<short-lived url token>`; `rawFile(path, {download, allowOutsideWorkspace, outsideFileGrant})` → `/api/fs/raw?...`; `sse(path, query)` and `websocket(path, query)` additionally (a) append `oc_url_token`, (b) route through the desktop realtime proxy when custom runtime headers exist (`/api/openchamber/realtime-proxy/sse|ws?url=<target>` with the *local* origin token; `src: packages/ui/src/lib/runtime-url.ts:121`).
- Auth headers (`buildRuntimeAuthHeaders`): `Authorization: Bearer <token>` from the runtime credential provider **unless the app has a UI session cookie** (cookie-based auth is the default on web; bearer is used by desktop/paired devices) — implemented as: extra runtime headers are merged first, then Authorization is set only if not already present (`src: packages/ui/src/lib/runtime-auth.ts:422`).
- URL-token store: `POST /auth/url-token` mints `{token, expiresAt}` (single-flight, proactive refresh 5 s before expiry-minus-10 s skew, consumer-count-driven so nothing polls when idle; replacement implies re-browse for token-bearing assets; `src: packages/ui/src/lib/runtime-auth.ts:220-420`).
- Injection points: `window.__OPENCHAMBER_API_BASE_URL__` (base URL), `__OPENCHAMBER_CLIENT_TOKEN__` (bearer), `__OPENCHAMBER_RUNTIME_HEADERS__` (extra headers; `authorization` is filtered out), `__OPENCHAMBER_LOCAL_ORIGIN__` (desktop local origin for the realtime proxy).
- Runtime endpoint switching (`switchRuntimeEndpoint`, `src: packages/ui/src/lib/runtime-switch.ts:149`): sets the same window globals, reconfigures the URL resolver, activates/deactivates the relay E2EE tunnel **before** re-minting the token (the mint rides the tunnel in relay mode), then fires `openchamber:runtime-endpoint-will-change` / `openchamber:runtime-endpoint-changed` CustomEvents with `{apiBaseUrl, previousApiBaseUrl, runtimeKey, previousRuntimeKey}`. Runtime keys: `'local'` when the API base is same-origin with the local origin, else `url:<normalized origin>`; transient keys `''`, `url:default`, `mobile-disconnected` are never cache keys.
- GET read coalescing: concurrent identical GETs to `~/api/(config|path|app/agents|agent|project|command)(\b|/|\?|$)` are shared (never event streams, never abortable callers), each caller gets `response.clone()` (`src: packages/ui/src/lib/runtime-fetch.ts:249`). Purpose: cold start fires the same identity reads from two layers; the harness is a single process and must not be saturated.
- Header hygiene: non-Latin-1 header values are `encodeURIComponent`-ed; if the encoded header is `x-opencode-directory` the request also adds `x-opencode-directory-encoding: uri`; the server decodes and strips the marker (`src: packages/web/server/lib/opencode/proxy.js:132`). ngrok hosts get `ngrok-skip-browser-warning: openchamber`.
- In relay mode (E2EE tunnel) HTTP paths ride `relay.fetch(path, init)` with identical paths/headers; `window.fetch` is bridged (`installRuntimeFetchBridge`) so third-party code inherits the same routing.

### 3.2 URL namespaces and the proxy contract

- Browser SDK base `/api` (or `VITE_OPENCODE_URL`, or the runtime resolver's absolute base). `ensureAbsoluteBaseUrl` resolves relative bases against `window.location` (`src: packages/ui/src/lib/opencode/client.ts:141`).
- Proxy rules (`src: packages/web/server/lib/opencode/proxy.js:276`):
  - Generic: everything under `/api` not matched by an OpenChamber route → `http-proxy-middleware` with `pathRewrite {'^/api': ''}`, `changeOrigin: true`, dynamic `router: () => resolveProxyTarget()`, timeout `LONG_REQUEST_TIMEOUT_MS` = **4 min** (elapsed-deadline middleware returns `504 {"error":"OpenCode upstream timed out"}` and destroys the request; middleware errors produce `503 {"error":"OpenCode service unavailable"}`).
  - Interactive OAuth bypass of the 4-minute deadline: `POST /api/provider/:providerID/oauth/callback` and `POST /api/mcp/:name/auth/authenticate` get **15 min** (`INTERACTIVE_OAUTH_TIMEOUT_MS`) because upstream blocks for the whole browser sign-in.
  - Header injection: `Authorization: Basic <base64(opencode + ':' + password)>` when a harness password exists; `accept-encoding: identity` forced; `x-opencode-directory-encoding: uri` decoded in-flight.
  - Hop-by-hop / credential filtering request-side: `authorization, host, connection, content-length, transfer-encoding, keep-alive, te, trailer, upgrade, accept-encoding` are dropped from the browser request; response-side drop: `connection, content-length, transfer-encoding, keep-alive, te, trailer, upgrade, www-authenticate, content-encoding` (`src: packages/web/server/proxy-headers.js`).
  - Target resolution order: `buildOpenCodeUrl('/', '')` when a port is known → else `state.openCodeBaseUrl` → else the last-resort fallback `http://127.0.0.1:3902` (a marker value, not a guarantee). HTTP vs HTTPS agent chosen per resolved target scheme, keep-alive agent: `keepAliveMsecs 30000, maxSockets Infinity, maxFreeSockets 256, timeout 60s` (`src: packages/web/server/lib/opencode/proxy.js:29`).
  - Middleware ordering: OpenChamber routes are registered **before** the proxy (`main()` registers core+feature routes; the startup pipeline runs `setupProxy(app)` last, then statics; `src: packages/web/server/lib/opencode/startup-pipeline-runtime.js:104`). Anything OpenChamber owns shadows the same path; anything else falls through.
  - **Readiness gate**: while the harness is starting/restarting/port-unknown, `app.use('/api')` *holds* requests instead of 503-ing: poll `isStillWaiting` every 75 ms; deadline = min(`OPEN_CODE_READY_GRACE_MS`=12 s, 6 s hard cap); classification `session-messages | session | events | other` recorded; on timeout `503 {"error":"OpenCode is restarting","restarting":true}`. Exempt (OpenChamber-owned, never held): paths starting `/themes/custom`, `/push`, `/config/agents`, `/config/opencode-resolution`, `/config/settings`, `/config/skills`, `/config/reload`, `/health` (`src: packages/web/server/lib/opencode/proxy.js:696-779`).
  - **Worktree bootstrap gate**: before any directory-scoped proxied request (`directory` query or `x-opencode-directory` header), hold until the git worktree bootstrap reaches `ready | git-ready | setup-ready`; `failed` → `503 {"error": <reason>}`; deadline `WORKTREE_READY_TIMEOUT_MS` = 5 min → `503 {"error":"Timed out waiting for worktree checkout"}`. Git readiness must pre-date OpenCode caching a new worktree's project identity/config (`src: packages/web/server/lib/opencode/proxy.js:784`). The VS Code extension keeps its own separate git/proxy implementation — parity there is doc-03's concern.
  - **Directory query canonicalizer**: `?directory=` values are pre-resolved through `fs.realpath` (cached) so symlink paths stop producing duplicate identities downstream; best-effort, per-request, non-blocking (`src: packages/web/server/lib/opencode/proxy.js:108`, applied to the session-list forwarders and as a URL rewrite on the generic path).
  - **Session list sanitation + Windows merge**: OpenChamber intercepts `GET /api/session` (all platforms) to sanitize, and on Windows additionally merges the global list with per-project-directory lists from settings when the request carries no `directory` (`src: packages/web/server/lib/opencode/proxy.js:812`). Sanitization keep-list: `id, slug, projectID, workspaceID, directory, path, parentID, title, agent, model, version, time, cost, tokens, share, metadata, project` — plus `summary` minus `diffs`, and `revert` reduced to `{messageID, partID?}`. `GET /api/session` and `GET /api/experimental/session` both go through it.
  - SSE forwarders: `GET /api/global/event` and `GET /api/event` are handled by a dedicated forwarder (not the WS bridge): same upstream Fetch, `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`, TCP `setNoDelay(true)`, downstream heartbeats `:heartbeat\n\n` every 20 s (only at an SSE boundary), an **upstream-only** stall watchdog (load-aware timeout) that aborts the upstream fetch mid-stream so the *browser reconnects* instead of trusting synthetic heartbeats, backpressure-aware write queue (`src: packages/web/server/lib/opencode/proxy.js:461-617`).
  - Directory `?directory=` readiness interplay: the readiness gate uses route classes, so a `POST /api/session/:id/message` (long-streaming) and a `GET /api/session` get the same hold behavior.

### 3.3 Browser-side SDK wrapper (`OpencodeService`)

`src: packages/ui/src/lib/opencode/client.ts` — the single class the UI uses (`export const opencodeClient`). Contracts a replacement must reproduce:

- Built by `createRuntimeOpencodeClient(config)` → `createOpencodeClient({...})` with a custom `fetch`:
  - **SSE and POST go straight to `runtimeFetch`** (no timeout wrapper; `isEventStreamUrl` = url contains `/event`).
  - Other (read) requests get a **30-second** timeout (`OPENCODE_REQUEST_TIMEOUT_MS`), composed with any caller-provided AbortSignal (`AbortSignal.any` or manual composition), and a distinct timeout error ("OpenCode request timed out after 30000ms"). Without this, a half-open socket keeps the bootstrap slot busy forever (issue #2470).
  - Health uses a separate 4 s window (`OPENCODE_HEALTH_TIMEOUT_MS`).
- Error unwrapping helpers: `unwrapSdkData` (throws with `${operation} failed (${status}): …`, never returns null-data as success), `unwrapSdkOptional` (OK to be undefined). HeyApi-style `{data,error,response}` result shapes are preserved.
- Directory handling: `setDirectory`, `withDirectory` (serialized through a promise queue), `getScopedApiClient(directory)` builds a per-directory SDK client (normalized path: backslash→slash, drive letter uppercase, trailing slash trimmed; `D:\a` and `d:\a\` collapse). Directory selection is a **core scoping key** for stores and caches.
- Sending: `sendMessage` is `session.promptAsync` with the client-generated message id (`msg_<12 hex encodes epoch×4096+counter>_<14 base62>` via `ascendingId("msg")`) so the SSE echo reconciles in place; parts are built from preface text (`synthetic:true` by default), main text, files (MIME-normalized: text-ish mimes → `text/plain`, HEIC/HEIF → JPEG via `heic2any`), `additionalParts` (queued batch), `agentMentions` (`agent` parts with source ranges). Requires ≥1 part. Never retries after a transport failure: the send outcome is ambiguous — a lost response cannot be distinguished from a prompt that never reached the server, and re-sending after ambiguity could double-dispatch a running turn (`markAmbiguousTransportFailure`). Per-provider circuit breaker (`provider-tracker.ts`): 3 consecutive retryable failures (429/502/503/504) open a circuit for 30 s (doubling to a 128 s cap per open), blocking new sends with "Provider … temporarily unavailable".
- `sendCommand` = `session.command` (command name, arguments, `model: "providerID/modelID"` string form, optional file parts, message id echo).
- `abortSession` = `session.abort` with `throwOnError: true`.
- Permission surface: `replyToPermission(requestId, 'once'|'always'|'reject', {message})` → v1 `POST /permission/{requestID}/reply`; `listPendingPermissions({directories})` merges unscoped + per-directory v1 lists, throws on error (resync callers must distinguish failure from empty); `fetchPermission(sessionId, requestId, directory)` → **v2** `GET /api/session/{sessionID}/permission/{requestID}` returning `{state:"ok"|"resolved"|"unknown"}` — 404 ⇒ `resolved`, anything else (incl. network) ⇒ `unknown`; `createPermission(...)` → v2 `POST /api/session/{sessionID}/permission` returning `{id, effect}` or null on any failure. The v1 pending list (global + per-directory) and the v2 session-owned authority are **separate maps on stable runtimes**; a UI preflight against v2 must not gate a v1-list-derived reply (issue #3259; `src: packages/ui/src/sync/vscode-permission-auto-accept.ts:111-120`).
- Questions: `replyToQuestion(requestId, answers, directory)` normalizes to `string[][]`, `rejectQuestion(requestId)`, `listPendingQuestions({directories})` (same merge and throw-on-error discipline as permissions).
- Config: `getConfig(directory?)` cached 10 s per directory (single-flight, generation-bumped invalidation); `updateConfig(fullConfig)` = v1 `PATCH /config` **with no directory** (global mutation), then cache clear; `updateConfigPartial` = GET-modify-PATCH (deprecated for agent config in favor of `/api/config/agents/*` file routes).
- Providers: `getProviders`/`getProvidersForConfig(directory)` = `GET /config/providers` (single-flight per directory) → `{providers: Provider[], default: {providerId: modelId}}`.
- Agents: `listAgents(directory)` = `client.app.agents` → `GET /agent`, with an explicit fallback to raw `runtimeFetch('/api/agent')` because some runtimes return an empty list from the SDK path; **throws on failure** so callers can retry rather than clear their cache.
- Commands: `listCommandsWithDetails(directory)` = `GET /command` → surfaces `{name, description?, agent?, model?, source?, template?}`.
- Tools: `listToolIds` = `GET /experimental/tool/ids`, filters to strings, drops `invalid`, returns `[]` on failure.
- File search: `searchFiles(query, {directory, limit, dirs, type})` = `GET /find/file` (`dirs: 'true'|'false'`), path normalization to absolute local form.
- `getSystemInfo()`: candidate derivation order for home/user directory: `GET /path` (`directory|worktree|state` candidates) → `GET /project/current` (`worktree`) → session list `directory` fields → current directory → `localStorage.lastDirectory|homeDirectory` → `process.cwd()`; then `deriveHomeDirectory` heuristics (`Users/<user>`, `<drive>/<userA>/<userB>`). Harness contract: `/path` returns `{home, state, config, worktree, directory}`.
- Directory existence is **not** asked of the harness: `getDirectoryAvailability` calls OpenChamber `GET /api/fs/directory-stat?path=…` and yields `available | missing | unknown`; `/path` cannot answer this (it echoes the directory and swallows git discovery errors). Transport failure must stay `unknown` (`src: packages/ui/src/lib/opencode/client.ts:611`).
- `checkHealth()`: `GET /api/opencode/health` (server-enriched) → `{healthy: boolean}`; non-/api bases use `<base>/opencode/health`.
- `getWebServerSessionActivity()`: `GET /api/session-activity` (server-tracked activity; survives SSE outage) → map `sessionId → {type}` or null on failure.
- `setOpenCodeWorkingDirectory(path)`: `POST /api/opencode/directory {path}` → `{success, restarted, path, agents?, providers?, models?}` (OpenChamber validates/persists the active project; route detail in doc 03).
- `getFilesystemHome()/getFilesystemHomeInfo()`: `GET /api/fs/home` → `{home, chatsRoot?}` (both absolute; `chatsRoot` optional in older servers).

### 3.4 Complete inventory of SDK (browser → harness-through-proxy) call sites

Rows marked **(v1)** map 1:1 onto harness routes (§4); **(v2)** map onto the harness's `/api/...` v2 surface (survives the proxy double-prefix trick; worked mapping in Appendix A). All paths below are written browser-side; collapse `/api/<p>` → `<p>` for the harness.

| # | UI call site (`packages/ui/...`) | SDK method | Wire | Purpose | Body / params | Response |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `lib/opencode/client.ts:535` | `client.path.get` | `GET /path` | home/worktree identity | `?directory` | `{home, state, config, worktree, directory}` |
| 2 | `client.ts:550` | `client.project.current` | `GET /project/current` | active project | `?directory` | `Project` (§6.8) |
| 3 | `client.ts:629` (many stores) | `client.session.list` | `GET /session` | session list | `?directory&limit&search&roots&start&scope&path` | `Session[]` (sanitized, §3.2) |
| 4 | `client.ts:637`, server control service | `client.session.create` | `POST /session` | create session | `{directory?, parentID?, title?, metadata?}` (+ optional `agent`, `model{id,providerID,variant}`, `permission` ruleset, `workspaceID`) | `Session` |
| 5 | `client.ts:648` | `client.session.get` | `GET /session/{sessionID}` | one session | `?directory` | `Session` |
| 6 | `client.ts:657` | `client.session.delete` | `DELETE /session/{sessionID}` | delete (irreversible, includes children) | `?directory` | `boolean` |
| 7 | `client.ts:675` (rename/archive) | `client.session.update` | `PATCH /session/{sessionID}` | `{title?, metadata?, permission?, time.archived?}` (archive = `time:{archived: <ms>}`; unarchive = patch `time` without `archived`) | `?directory` | `Session` |
| 8 | `client.ts:685` | `client.session.messages` | `GET /session/{sessionID}/message` | ordered `[{info: Message, parts: Part[]}]` | `?directory&limit&before` | array (§6.2) |
| 9 | `client.ts:695` | `client.session.todo` | `GET /session/{sessionID}/todo` | todo list | `?directory` | `Todo[]` |
| 10 | `client.ts:975` (`sendMessage`) | `client.session.promptAsync` | `POST /session/{sessionID}/prompt_async` | fire-and-forget turn; returns immediately | `{messageID?, model:{providerID,modelID}, agent?, variant?, tools?, format?, system?, delivery?, parts: [TextPartInput\|FilePartInput\|AgentPartInput\|SubtaskPartInput]}`; `?directory` | **204 void**; later failure surfaces only via events — hence `promptDispatched` confirmation flows (§11 item 4, LF-13). `delivery` note: the UI passes `delivery: "steer"` (steering follow-ups, `src: packages/ui/src/stores/messageQueueStore.ts`: OpenCode supports only `"steer" | "queue"`, defaulting to queue); the SDK 1.18.30 generated body type omits the field (types drift), so treat it as an optional harness extension accepted on `prompt`/`prompt_async` |
| 11 | `client.ts:1063` (`sendCommand`) | `client.session.command` | `POST /session/{sessionID}/command` | run a named command template | `{messageID?, agent?, model:"p/m", arguments, command, variant?, parts?: FilePartInput[]}`; `?directory` | 200 `{info: AssistantMessage, parts}` |
| 12 | `client.ts:1080` | `client.session.abort` | `POST /session/{sessionID}/abort` | interrupt | `?directory` | `boolean` |
| 13 | `client.ts:1101` | `client.session.shell` | `POST /session/{sessionID}/shell` | run shell as part of session (409 `SessionBusyError` when busy) | `{messageID?, agent, model{providerID,modelID}, command}`; `?directory` | 200 `{info, parts}` |
| 14 | `client.ts:1114` | `client.session.revert` | `POST /session/{sessionID}/revert` | revert to message boundary | `{messageID, partID?}`; `?directory` | `Session` (with updated `revert`) |
| 15 | `client.ts:1125` | `client.session.summarize` | `POST /session/{sessionID}/summarize` | force compaction | `{providerID?, modelID?, auto?}`; `?directory` | `boolean` |
| 16 | `client.ts:1135` | `client.session.unrevert` | `POST /session/{sessionID}/unrevert` | restore | `?directory` | `Session` |
| 17 | `client.ts:1144` (fork) | `client.session.fork` | `POST /session/{sessionID}/fork` | fork at message | `{messageID?}`; `?directory` | new `Session` |
| 18 | `client.ts:1171` (status snapshots) | `client.session.status` | `GET /session/status` | **authoritative** session idleness map; omitted sessions are idle once a snapshot succeeds | `?directory` (omit for global) | `{[sessionID]: SessionStatus}`; null/`{}` distinction is load-bearing (§11) |
| 19 | `client.ts:1228` | `client.tool.ids` | `GET /experimental/tool/ids` | tool id list | `?directory` | `string[]` |
| 20 | `client.ts:1243` | `client.permission.reply` | `POST /permission/{requestID}/reply` | approve/deny | `{reply: "once"\|"always"\|"reject", message?}`; `?directory` | `boolean` (404 `PermissionNotFoundError` when settled) |
| 21 | `client.ts:1362` | `client.permission.list` | `GET /permission` | pending permissions (v1 global authority) | `?directory` | `PermissionRequest[]` (§6.6) |
| 22 | `client.ts:1280` | `client.v2.session.permission.create` | `POST /api/session/{sessionID}/permission` | programmatic permission probe (create if approval required) | `{id?, action: string, resources: string[], save?: string[], metadata?, source?: {type:"tool",messageID,callID}, agent?}` | 200 `{data: {id, effect: "allow"\|"deny"\|"ask"}}` (v2 body) |
| 23 | `client.ts:1319` | `client.v2.session.permission.get` | `GET /api/session/{sessionID}/permission/{requestID}` | V2 pending state (404 ⇒ resolved) | — | 200 `{data: PermissionV2Request}` (§6.6) |
| 24 | `client.ts:1415` | `client.question.reply` | `POST /question/{requestID}/reply` | answer the ask tool | `{answers: string[][]}` (one array of labels per question); `?directory` | `boolean` |
| 25 | `client.ts:1424` | `client.question.reject` | `POST /question/{requestID}/reject` | reject the ask tool | `?directory` | `boolean` |
| 26 | `client.ts:1441` | `client.question.list` | `GET /question` | pending questions (global) | `?directory` | `QuestionRequest[]` (§6.7) |
| 27 | `client.ts:1508` | `client.config.get` | `GET /config` | merged effective config | `?directory` | `Config` (§7.1) |
| 28 | `client.ts:1534` | `client.config.update` | `PATCH /config` | **global** config write; never carry `directory` | `{config: <full Config>}` | `Config` |
| 29 | `client.ts:1577` | `client.config.providers` | `GET /config/providers` | picker source of truth | `?directory` | `{providers: Provider[], default: {[providerId]: modelId}}` |
| 30 | `client.ts:1630` | `client.app.agents` | `GET /agent` | agent list | `?directory` | `Agent[]` |
| 31 | `client.ts:1668` | `client.command.list` | `GET /command` | command palette | `?directory` | `Command[]` |
| 32 | `client.ts:1882` | `client.find.files` | `GET /find/file` | project file search (ripgrep-backed) | `?directory&query&dirs&limit&type` | `string[]` (relative paths) |
| 33 | SDK SSE (`sync/event-pipeline.ts` via `createOpencodeClient`'s `global.event`) | `client.global.event` | `GET /global/event` | event stream | — | SSE `GlobalEvent` (§5) |
| 34 | `sync/event-pipeline.ts` (dir streams) | `client.event.subscribe` | `GET /event?directory=…` | directory-scoped stream | `?directory` | SSE of raw events |
| 35 | health (`client.ts:1692`) | (not SDK) | `GET /api/opencode/health` (OpenChamber) | enriched health | — | `{healthy}` (§4.1) |
| 36 | provider auth flows (`useProviderAuth…`/routes) | `client.provider.list/auth/oauth.authorize/oauth.callback` | `GET /provider`, `GET /provider/auth`, `POST /provider/{providerID}/oauth/authorize`, `POST /provider/{providerID}/oauth/callback` | provider + auth methods + OAuth | authorize `{method: number, inputs?: {key:string}}`; callback `{method, code?}` | authorize → `{url, method:"auto"\|"code", instructions}`; callback → `boolean` |
| 37 | MCP settings surfaces | `client.mcp.status/add/connect/disconnect/auth.*` | `GET /mcp`, `POST /mcp`, `POST /mcp/{name}/connect`, `POST /mcp/{name}/disconnect`, `POST /mcp/{name}/auth`, `DELETE /mcp/{name}/auth`, `POST /mcp/{name}/auth/callback`, `POST /mcp/{name}/auth/authenticate` | MCP lifecycle | `POST /mcp {name, config: McpLocalConfig|McpRemoteConfig}`; statuses `{[name]: McpStatus}` (§6.9) | `McpStatus` maps |
| 38 | worktree UI (VS Code path / SDK parity) | `client.worktree.list/create/remove/reset` | `GET/POST/DELETE /experimental/worktree`, `POST /experimental/worktree/reset` | sandbox worktree ops (OpenChamber web UI uses its **own** git worktree API instead, `RuntimeAPIs.git`; treat as optional harness surface) | inputs `{name?, startCommand?}` / `{directory}` | `Worktree{name, branch?, directory}` |
| 39 | settings write-back of OpenCode config pieces | `client.tui.*` (not used by shared UI; reserved) | `POST /tui/...` | TUI compat surface | — | — |

Remaining per-session REST surface the SDK exposes (rows 40-46; OpenChamber's UI uses these selectively — implement them all for full compatibility):

| # | Wire | Purpose / response |
| --- | --- | --- |
| 40 | `GET /session/{sessionID}/children` | child sessions of a parent → `Session[]` |
| 41 | `GET /session/{sessionID}/diff?messageID=` | file changes attributable to one user message → `SnapshotFileDiff[] {path,status,additions,deletions,patch}` |
| 42 | `GET /session/{sessionID}/message/{messageID}` / `DELETE /session/{sessionID}/message/{messageID}` | one message / delete message **with parts** but no file revert |
| 43 | `POST /session/{sessionID}/message` (v1 `client.session.prompt`) | synchronous turn: 200 `{info: AssistantMessage, parts: Part[]}`; only the SDK path exists today — keep implemented |
| 44 | `PATCH/DELETE /session/{sessionID}/message/{messageID}/part/{partID}` | update/replace or delete one part (inline edits, edit-mode) |
| 45 | `POST /session/{sessionID}/share` / `DELETE /session/{sessionID}/share` | share link create/remove (`{url}` / boolean) |
| 46 | `POST /session/{sessionID}/init {modelID, providerID, messageID}` | AGENTS.md bootstrap turn → boolean |
| 47 | `GET /session/ses_x/todo` vs `GET /session/{id}` interplay | todo is addressed only by the session-scoped route (row 9); no global todo route |

Notes:

- The UI never calls `client.session.prompt` (the synchronous streaming form, `POST /session/{sessionID}/message` → 200 `{info, parts}`), even though it exists; turns are consumed via `prompt_async` + events. A harness that drops `prompt_async` but keeps `prompt` breaks the message pipeline.
- v2 endpoints (`/api/session/...`) ride through OpenChamber as double-prefixed browser paths (`/api/api/session/...`) → single-strip → harness `/api/session/...` (`src: packages/web/server/lib/opencode/proxy.js:916`). A replacement harness must therefore serve its v2 surface under `/api` on its own origin, or the UI adapter must rewrite.
- `GET /session/status` responses omit idle sessions (server-side omission ⇒ "authoritatively idle"). Empty map vs failed fetch is different (§11).

### 3.5 Directory scoping conventions (canonical rules)

The harness keys all directory-scoped work by an absolute local path. OpenChamber normalizes on every hop; replicate each rule:

| Rule | Exact behavior | Where |
| --- | --- | --- |
| Client normalization | `path.replace(/\\/g,'/')`; Windows drive letter upper-cased (`.replace(/^([a-z]):/, c=>c.toUpperCase()+':')`); trailing slashes trimmed (with the `'/'+...` exception for the root); trim whitespace; empty ⇒ null | `client.ts:412` (`normalizeCandidatePath`) |
| Client key | The normalized path is the store/cache/scoped-client key throughout the UI | `client.ts:400` |
| Transport A — query param | `?directory=<raw path>` (URL-encoded by the browser) — what the SDK emits by default; the proxy canonicalizes symlinks via cached `fs.realpath` before forwarding (§3.2) | `proxy.js:108` |
| Transport B — header | `x-opencode-directory: <percent-encoded path>`; header values must be Latin-1-safe, so non-ASCII (and in the SDK's case **all**) paths are `encodeURIComponent`-ed; the browser layer adds `x-opencode-directory-encoding: uri` when it had to encode a value beyond the SDK's default, and the proxy decodes + strips the marker in flight. Server→harness fetches percent-encode explicitly (OpenCode rejects non-ASCII header values) | `client.ts:122` / `openchamber-sessions/routes.js:85` / `proxy.js:132` |
| Worktree gate | Any directory-scoped proxied request holds until git bootstrap `ready|git-ready|setup-ready` (5 min) — the harness may lazily initialize a directory's project identity/config, but OpenChamber guarantees file-population first | `proxy.js:784` |
| Existence probe | `GET /api/fs/directory-stat?path=` ⇒ `available/missing/unknown`; never use the harness `/path` for existence | `client.ts:611` |
| Fresh directory cost | First directory-scoped request may take seconds (lazy init); the server warms up to 4 recently used directories after readiness (§2.2 step 16) | `lifecycle.js:1154` |

### 3.5a SDK directory-header mechanics (exact, SDK 1.18.30)

`createOpencodeClient(config & {directory?, experimental_workspaceID?})` (`src: sdk@1.18.30 dist/v2/client.js`) — the ground truth a replacement adapter must reproduce:

1. When `directory` is configured, **every** outgoing request (any method) gets the header `x-opencode-directory: <encodeURIComponent(directory)>`. `experimental_workspaceID` likewise sets `x-opencode-workspace: <raw>`.
2. A request interceptor then rewrites GET/HEAD requests only: if such a header is present its value is moved into the query string — key `directory` when the URL path does not start with `/api/`, keys `directory` **and** `location[directory]` variants when it does (v2 nesting), same treatment for `workspace`/`location[workspace]` — and the header is deleted. The header value is de-duplicated against an already-present identical query value (`pick` in the SDK sources).
3. POST/PATCH/DELETE/SSE keep the header on the wire (the harness and OpenChamber both read it from the header on body-carrying methods where query duplication is awkward).
4. Per-directory scoped clients (`getScopedApiClient`) are cached per normalized directory in the UI; the base client stays unscoped and passes `directory` explicitly as an options parameter where the SDK supports per-call `directory` (session/config/provider/agent/command calls take it as an SDK parameter that lands in the same header/query machinery).

Net effect the harness must accept: `?directory=<raw>` on reads, `x-opencode-directory` (percent-encoded) on everything, and optionally `location[directory]=` on v2 URLs. Non-ASCII must survive all three forms.

### 3.6 Diagnostics surfaces the UI probes on the harness (status dialog facts)

The in-app status report (`src: packages/ui/src/lib/openCodeStatus.ts`) defines what "the harness looks healthy" means operationally; each row is a probe with a per-probe budget. Keep them working to keep the support pipeline usable:

| Probe (browser path) | Budget | Healthy shape |
| --- | --- | --- |
| `GET /api/opencode/health` (via OpenChamber) | 5 s | `{healthy:true}` |
| `GET /health` (server) | 5 s | server snapshot incl. `openCodePort/openCodeRunning/openCodeSecureConnection/openCodeAuthSource/lastOpenCodeError/lastManagedOpenCodeProcess…` |
| `GET /api/global/health` | 6 s | 200 JSON `{healthy:true,version}` |
| `GET /api/config?directory=` | 6 s | `Config` object |
| `GET /api/config/providers?directory=` | 6 s | `{providers, default}` |
| `GET /api/agent?directory=` | **12 s** | `Agent[]` |
| `GET /api/command?directory=` | 10 s | `Command[]` |
| `GET /api/project/current?directory=` | 6 s | `Project` |
| `GET /api/path?directory=` (`cache: no-store`) | 5 s | `Path` (its `home` anchors the on-disk log-path hints) |
| `GET /api/session?directory=` | **12 s** | `Session[]` |
| `GET /api/session/status?directory=` | 6 s | status map |
| `GET /api/config/opencode-resolution` | 7 s | resolution snapshot |

The report also surfaces the managed-process stderr tail (sanitized, ≤32 KiB), the harness log location (`<home>/.local/share/opencode/log` or `$XDG_DATA_HOME/opencode/log` — XDG data dir, not AppData, on every platform), and recent client-side session errors / rejected sends. A replacement harness that renames these probe paths breaks diagnostics, not just support tooling.

---

## 4. Tier 2: OpenChamber server → harness REST inventory (call sites + purpose)

Server-side consumers use both the raw fetch helpers (`buildOpenCodeUrl(path, '')` + `getOpenCodeAuthHeaders()` + `abortsignal.timeout`) and a dedicated SDK client (`createOpencodeClient({baseUrl: buildOpenCodeUrl('/','').replace(/\/$/,''), headers: getOpenCodeAuthHeaders()})` — carries Basic auth as a header, not cookies).

| # | Server call site (`packages/web/server/...`) | Harness call | Purpose | Contract notes |
| --- | --- | --- | --- | --- |
| S-01 | `opencode/lifecycle.js:589,647,944`, `opencode/network-runtime.js:49` | `GET /global/health` | readiness + periodic health | 200 `{healthy: true, version: string}`; non-2xx/unparseable = unhealthy; version used for upgrade-status |
| S-02 | `opencode/lifecycle.js:997`, `opencode/config-entity-routes.js` (agent presence) | `GET /agent?directory=…` | agent presence wait after restart | `Agent[]` |
| S-03 | `opencode/routes.js:275` | `POST /global/upgrade {target}` | self-upgrade | `{success:true, version}\|{success:false, error}` |
| S-04 | `opencode/server-utils-runtime.js:201-203` | `GET /agent`, `GET /provider`, `GET /model` | server-side snapshots for agent/settings flows | arrays |
| S-05 | `openchamber-sessions/routes.js:100-122` | `GET /config/providers?directory=`, `GET /agent?directory=`, `GET /config?directory=` | resolve defaults before dispatch | `--directory` header set + query |
| S-06 | `openchamber-sessions/routes.js:179-197` | `POST /session/{sessionID}/prompt_async?directory=` | dispatch turns for tool-created sessions | body: `{model:{providerID,modelID}, agent?, variant?, parts: [synthetic knowledge text?, prompt text, goal intro?]; synthetic flagged}`; `x-opencode-directory` header **percent-encoded** (harness matches SDK wire format) |
| S-07 | `openchamber-sessions/routes.js:199-224` | `POST /session?directory=` | create session | body `{directory, title?}` → `Session`; accept both `id` and `data.id` topologies |
| S-08 | `openchamber-sessions/routes.js:226,631-672` | SDK `session.fork`, `session.messages`, `session.update {time:{archived}}` | fork + one-at-a-time archive batches (≤500) | partial failure reported `failedIds` |
| S-09 | `openchamber-sessions/routes.js:340-370` | `session.messages limit:100` | `waitForPromptLanded` — confirm a new user message appeared ≤5 s after prompt_async (150 ms polls); lookup failure is NOT evidence of loss | gates `promptDispatched` |
| S-10 | `openchamber-control/service.js:40-63,209-220` | SDK `session.status {directory}`, `session.messages` | control service read-only actions (`session.list/status/messages`) | messages filtered to ordered `text` parts only (§9.1 P-04) |
| S-11 | `openchamber-control/service.js:172-178` | `createOpencodeClient` ready-gated | every control-service action | `waitForOpenCodeReady(10000, 250)` first |
| S-12 | `permission-auto-accept/runtime.js:98-125` | `GET /session/{id}?directory=`, `GET /permission?directory=`, `POST /permission/{id}/reply {reply:'once'}` | server-side auto-accept (V1) | retries 0/250/1000 ms; 5 s timeout; 404 treated as settled; lineage walks `parentID` (LF-14) |
| S-13 | `opencode/watcher.js` + `event-stream/*` | `GET /global/event` (SSE) | one shared upstream reader | §5 |
| S-14 | `small-model/runtime-providers.js` | hooks into the managed process runtime | plugin-provider credentials & endpoints only exist inside the running harness; the runtime snapshot is reset on every restart | `GET /api/small-model` never answers "empty" for unreachable — `null` (§11) |
| S-15 | `small-model/call.js` | per-provider **direct HTTP** (NOT via harness) | small-model wire formats | uses stored credentials from `~/.local/share/opencode/auth.json` + models.dev catalog; OpenCode-hosted providers get `x-opencode-session` header (real session id for session-backed features, dedicated opaque id otherwise) (§7.4) |
| S-16 | `session-assist/runtime.js:109-141` | SDK client + small model | session assist generations via `buildOpenCodeUrl` client; reads sessions/messages through official APIs | sibling doc |
| S-17 | `quota/*` | **none** (provider HTTP APIs direct) | quota signals | not a harness port; git-adjacent server feature |
| S-18 | `opencode/routes.js:758+` (`POST /api/opencode/directory`) | validates local dir, activates project | may trigger harness restart so new project config is picked up | returns `{success, restarted, path, agents?, providers?, models?}` |
| S-19 | `message-queue/runtime.js` | `prompt_async` / `/session` reads | deliver queued follow-ups server-side | reuses sessionKnowledge + prompt-line checks |
| S-20 | `session-goal/*` | SDK session reads + `POST /session/{id}/prompt_async` | goal loop turns | doc-12 domain |
| S-21 | `git/*` | **none** | git worktrees are OpenChamber/`git` binary work — explicitly *not* harness work | cross-ref doc 03 |

### 4.1 Enriched OpenChamber routes that wrap harness calls (in-scope subset)

These routes are OpenChamber-owned (browser calls them) but every handler's real job is a harness call. Exact responses matter because the UI parses them:

| Route | Handler behavior (wrap of harness call) | Response shape |
| --- | --- | --- |
| `GET /api/opencode/health` | forwards `GET /global/health`, normalizes errors | 200 `{healthy: boolean}`; upstream status preserved with `{healthy:false, error}`; 503 `{healthy:false, error}` on transport failure (`src: packages/web/server/lib/opencode/routes.js:380`) |
| `GET /api/opencode/version` | forwards `/global/health`, strips a leading `v` | `{version: string\|null, error?}` |
| `GET /api/opencode/upgrade-status` | capability + `GET /global/health` + latest-GitHub-release lookup | `{available: boolean\|null, currentVersion, latestVersion, upgrade: {supported, manager, reason}}` |
| `POST /api/opencode/upgrade` | LF-5 | 200 `{success:true, restarted:true, ...}`; 409 `{success:false, code: "OPENCODE_UPGRADE_MANAGED_BY_OPENCHAMBER"\|"OPENCODE_UPGRADE_UNSUPPORTED"\|"OPENCODE_UPGRADE_IN_PROGRESS"\|"OPENCODE_UPGRADE_TARGET_UNRESOLVED", error}`; 500 `{success:false, error, upgraded?: true}` |
| `POST /api/opencode/directory` | validate + activate project directory; `{create:true}` creates it | `{success, restarted, path, agents?, providers?, models?}` (restart happens when project config must be re-read) |
| `GET /api/config/opencode-resolution` | binary resolution snapshot | `{configured, resolved, resolvedDir, source, detectedNow?, detectedSourceNow?, launchBinary, launchArgs, launchWrapperType, node, bun}` |
| `GET /api/session-activity` | server-tracked activity phases (survives SSE outage) | `{[sessionId]: {type: "busy"\|"idle"...\|"cooldown"}}` — read via `getWebServerSessionActivity` |
| `GET /api/openchamber/models-metadata` | models.dev catalog fetch (5 min TTL), **not** harness data | catalog record |
| `GET /api/zen/models` | OpenCode zen free-models list from the shared catalog | model list (may error upstream) |

---

## 5. Event stream contract

### 5.1 Upstream wire (harness → server)

Two endpoints:

1. `GET /global/event` — global stream. **Envelope per SSE frame**:

   ```
   id: <eventId>\n
   data: {"directory":"<dir>","payload":{"id":"<eventId>","type":"<event.type>","properties":{...}}}
   \n\n
   ```

   Type source: `GlobalEvent` in `@opencode-ai/sdk@1.18.30/dist/v2/gen/types.gen.d.ts:553`. `directory` is the project directory scoping the event (may be absent/`global`); `payload.id` is the durable event id used for `Last-Event-ID` and replay.
2. `GET /event?directory=<dir>` — directory-scoped stream. Frames carry the same JSON but unwrap rules are tolerant: the parser accepts an outer `{directory, payload:{id,type,properties}}` **or** a bare `{id,type,properties}` (deriving `directory` from the payload's `info.directory` when present) (`src: packages/web/server/lib/event-stream/protocol.js:14`). SSE guidelines: multi-line `data:` joined with `\n`; `id:` line optional but required to participate in replay/resume.

Reconnect/resume: reconnect with `Last-Event-ID: <lastEventId>` header; the harness is expected to replay from that id (event ids are the cursor). Stall ⇒ abort and reconnect (same header). No client-side synthesis beyond the OpenChamber heartbeats (§5.3) — heartbeats never substitute for upstream truth.

### 5.2 Complete event type table (SDK 1.18.30)

All types below are `GlobalEvent.payload` inner `type` values with exact `properties`. Any replacement harness must emit these names and shapes; consumers (doc 04 reducer) are built on them.

| Event type | properties (exact fields) |
| --- | --- |
| `models-dev.refreshed` | (open record) |
| `integration.updated` | (open record) |
| `integration.connection.updated` | `integrationID: string` |
| `catalog.updated` | (open record) |
| `session.created` / `session.updated` / `session.deleted` | `sessionID: string`, `info: Session` |
| `message.updated` | `sessionID`, `info: Message` |
| `message.removed` | `sessionID`, `messageID` |
| `message.part.updated` | `sessionID`, `part: Part`, `time: number` |
| `message.part.removed` | `sessionID`, `messageID`, `partID` |
| `message.part.delta` | `sessionID`, `messageID`, `partID`, `field: string`, `delta: string` |
| `session.next.agent.switched` | `timestamp`, `sessionID`, `messageID`, `agent: string` |
| `session.next.model.switched` | `timestamp`, `sessionID`, `messageID`, `model: ModelRef{id,providerID,variant?}` |
| `session.next.moved` | `timestamp`, `sessionID`, `location: {directory, workspaceID?}`, `subdirectory?` |
| `session.next.prompted` | `timestamp`, `sessionID`, `messageID`, `prompt: {text, files?: PromptFileAttachment[], agents?: PromptAgentAttachment[]}`, `delivery: "steer"\|"queue"` |
| `session.next.prompt.admitted` | same shape as `prompted` |
| `session.next.context.updated` | `timestamp`, `sessionID`, `messageID`, `text` |
| `session.next.synthetic` | `timestamp`, `sessionID`, `messageID`, `text` |
| `session.next.shell.started` | `timestamp`, `sessionID`, `messageID`, `callID`, `command` |
| `session.next.shell.ended` | `timestamp`, `sessionID`, `callID`, `output` |
| `session.next.step.started` | `timestamp`, `sessionID`, `assistantMessageID`, `agent`, `model: ModelRef`, `snapshot?` |
| `session.next.step.ended` | `timestamp`, `sessionID`, `assistantMessageID`, `finish: string`, `cost: number`, `tokens: {input,output,reasoning,cache{read,write}}`, `snapshot?`, `files?: string[]` |
| `session.next.step.failed` | `timestamp`, `sessionID`, `assistantMessageID`, `error: {type:"unknown", message} \| ApiError` |
| `session.next.text.started` / `.delta` / `.ended` | `timestamp`, `sessionID`, `assistantMessageID`, `textID`, `delta?` (delta only) / `text?` (ended only) |
| `session.next.reasoning.started` / `.delta` / `.ended` | same as text but `reasoningID`; `.started`/`.ended` carry optional `providerMetadata` |
| `session.next.tool.input.started` | `timestamp`, `sessionID`, `assistantMessageID`, `callID`, `name: string` |
| `session.next.tool.input.delta` | `timestamp`, `sessionID`, `assistantMessageID`, `callID`, `delta` |
| `session.next.tool.input.ended` | `timestamp`, `sessionID`, `assistantMessageID`, `callID`, `text` |
| `session.next.tool.called` | `timestamp`, `sessionID`, `assistantMessageID`, `callID`, `tool: string`, `input: object`, `provider: {executed: boolean, metadata?}` |
| `session.next.tool.progress` | `timestamp`, `sessionID`, `assistantMessageID`, `callID`, `structured: object`, `content: [{type:"text",text}\|{type:"file",uri,mime,name?}]` |
| `session.next.tool.success` | as progress + `outputPaths?: string[]`, `result?: unknown` |
| `session.next.tool.failed` | `timestamp`, `sessionID`, `assistantMessageID`, `callID`, `error`, `result?: unknown`, `provider` |
| `session.next.retried` | `timestamp`, `sessionID`, `attempt: number`, `error: {message, statusCode?, isRetryable, responseHeaders?, responseBody?, metadata?}` |
| `session.next.compaction.started` / `.delta` / `.ended` | `timestamp`, `sessionID`, `messageID`, `reason: "auto"\|"manual"`; delta adds `text`; ended adds `text`, `recent: string` |
| `session.next.revert.staged` | `timestamp`, `sessionID`, `revert: {messageID, partID?, snapshot?, diff?, files?}` |
| `session.next.revert.cleared` | `timestamp`, `sessionID` |
| `session.next.revert.committed` | `timestamp`, `sessionID`, `messageID` |
| `session.diff` | `sessionID`, `diff: [{path, status:"added"\|"modified"\|"deleted", additions, deletions, patch}]` |
| `session.error` | `sessionID?`, `error?: ProviderAuthError\|UnknownError\|MessageOutputLengthError\|MessageAbortedError\|StructuredOutputError\|ContextOverflowError\|ContentFilterError\|ApiError` (shapes in §6.2) |
| `installation.updated` / `installation.update-available` | `version: string` |
| `file.edited` | `file: string` |
| `reference.updated` | (open record) |
| `permission.v2.asked` | `id`, `sessionID`, `action: string`, `resources: string[]`, `save?: string[]`, `metadata?`, `source?: {type:"tool",messageID,callID}` |
| `permission.v2.replied` | `sessionID`, `requestID`, `reply: "once"\|"always"\|"reject"` |
| `plugin.added` | `id: string` |
| `project.directories.updated` | `projectID` |
| `file.watcher.updated` | `file`, `event: "add"\|"change"\|"unlink"` |
| `pty.created` / `pty.updated` | `info: Pty{id,title,command,args,cwd,status:"running"\|"exited",pid,exitCode?}` |
| `pty.exited` | `id`, `exitCode` |
| `pty.deleted` | `id` |
| `question.v2.asked` | `id`, `sessionID`, `questions: QuestionV2Info[]`, `tool?: {messageID, callID}` |
| `question.v2.replied` | `sessionID`, `requestID`, `answers: string[][]` |
| `question.v2.rejected` | `sessionID`, `requestID` |
| `todo.updated` | `sessionID`, `todos: Todo[]` |
| `lsp.updated` | (open record) |
| `permission.asked` (v1) | `id`, `sessionID`, `permission: string`, `patterns: string[]`, `metadata: object`, `always: string[]`, `tool?: {messageID, callID}` |
| `permission.replied` (v1) | `sessionID`, `requestID`, `reply: "once"\|"always"\|"reject"` |
| `tui.prompt.append` | `text`; `tui.command.execute` `command`; `tui.toast.show` `{title?, message, variant:"info"\|"success"\|"warning"\|"error", duration?}`; `tui.session.select` `sessionID` |
| `mcp.tools.changed` | `server: string`; `mcp.browser.open.failed` `{mcpName, url}` |
| `command.executed` | `name`, `sessionID`, `arguments`, `messageID` |
| `project.updated` | `id`, `worktree`, `vcs?: "git"`, `name?`, `icon?: {url?,override?,color?}`, `commands?: {start?}`, `time: {created, updated, initialized?}`, `sandboxes: string[]` |
| `session.status` | `sessionID`, `status: SessionStatus` (§6.5) |
| `session.idle` | `sessionID` |
| `question.asked` (v1) | `id`, `sessionID`, `questions: QuestionInfo[]`, `tool?: {messageID, callID}` |
| `question.replied` (v1) | `sessionID`, `requestID`, `answers: string[][]` |
| `question.rejected` (v1) | `sessionID`, `requestID` |
| `session.compacted` | `sessionID` |
| `vcs.branch.updated` | `branch?: string` |
| `workspace.ready` / `workspace.failed` | `name` / `message` |
| `workspace.status` | `workspaceID`, `status: "connected"\|"connecting"\|"disconnected"\|"error"` |
| `worktree.ready` / `worktree.failed` | `{name, branch?}` / `{message}` |
| `server.connected` | (open record) |
| `global.disposed` | (open record) |
| `server.instance.disposed` | `directory` |
| `sync` | wrapper: `{type:"sync", id, syncEvent: {type:"<name>.1", ...}}` — durable-channel echo class (SDK emits alongside; UI reducers treat the unwrapped channel as primary) |

Ordering guarantees the UI relies on (doc 04 implements, harness must provide):

- Within a session, events arrive in causal order; `message.part.updated` for a part id appears exactly once as a "part created" boundary, further updates by `field` arrive via `message.part.delta` keyed `(messageID, partID, field)`.
- `session.status` is *idempotently keyed* per session (later wins); a successful full `GET /session/status` snapshot makes omission authoritative idle (`sessionStatusReady`).
- Stream ids are total-order per stream; gaps are healed by `Last-Event-ID` replay (server-side hub buffer) or by document resync, never by overnight guessing.

### 5.2.0 The durability wrapper (`sync` events and durable fields)

SDK 1.18.30 also defines a v2 event envelope (`V2Event` = `{id, metadata?, type, durable?: {aggregateID, seq, version}, location?: {directory, workspaceID?}, data: …}`) and a `sync` wrapper type `{type:"sync", id, syncEvent: {type:"<base type>.1", id, ...}}` for the durable event channel (`GET /api/session/{sessionID}/event`, `POST /sync/history|start|replay|steal`). OpenChamber's shared UI does **not** consume the durable channel: the primary ingestion is the v1 SSE surface of §5.1 plus the WS bridge. Rules for a replacement:

- Emitting only the §5.1/§5.2 vocabulary is sufficient and expected.
- If the harness emits the durable fields (`durable`, `location`) inside the §5.2 shapes (they are optional there), OpenChamber must tolerate them; consumers never require them.
- `GET /api/session/{id}/event` (v2 per-session stream) and `POST /sync/*` are implemented by the SDK client (`client.v2.session.events`, `client.sync.*`) but unused by OpenChamber today — treat as optional parity surface (§9.1 P-23), not a dependency.

### 5.2.1 Worked wire examples (exact JSON a harness must emit)

1. **Global SSE frame for a session create:**

   ```
   id: 4711
   data: {"directory":"D:/repo","payload":{"id":"4711","type":"session.created","properties":{"sessionID":"ses_a1b2","info":{"id":"ses_a1b2","slug":"fix-login","projectID":"prj_x","directory":"D:/repo","title":"New session","version":"1.18.x","time":{"created":1726300000000,"updated":1726300000000},"permission":[]}}}}

   ```

2. **Text streaming** (three frames of a turn):

   ```
   data: {"directory":"D:/repo","payload":{"id":"t1","type":"session.next.step.started","properties":{"timestamp":1726300001000,"sessionID":"ses_a1b2","assistantMessageID":"msg_x","agent":"build","model":{"id":"claude-sonnet-4","providerID":"anthropic"}}}}
   data: {"directory":"D:/repo","payload":{"id":"t2","type":"session.next.text.started","properties":{"timestamp":1726300001100,"sessionID":"ses_a1b2","assistantMessageID":"msg_x","textID":"prt_1"}}}
   data: {"directory":"D:/repo","payload":{"id":"t3","type":"session.next.text.delta","properties":{"timestamp":1726300001200,"sessionID":"ses_a1b2","assistantMessageID":"msg_x","textID":"prt_1","delta":"Looking "}}}
   ```

   and the final materialization:

   ```
   data: {"directory":"D:/repo","payload":{"id":"t9","type":"message.part.updated","properties":{"sessionID":"ses_a1b2","time":1726300003000,"part":{"id":"prt_1","sessionID":"ses_a1b2","messageID":"msg_x","type":"text","text":"Looking at the failing test…","time":{"start":1726300001000,"end":1726300002900}}}}}
   ```

   The reducer's model: `*.started/.delta/.ended` are live-transcription; `message.part.updated` is the durable part (the same object the REST history returns). A missed delta is healed by the next `updated`/snapshot, not by re-synthesis.

3. **Tool lifecycle** (`read` tool):

   ```
   data: {...,"type":"session.next.tool.input.started","properties":{"sessionID":"s","assistantMessageID":"m","callID":"call_1","name":"read"}}
   data: {...,"type":"session.next.tool.input.delta","properties":{"sessionID":"s","assistantMessageID":"m","callID":"call_1","delta":"{\"path\":\"src/a"}}
   data: {...,"type":"session.next.tool.input.ended","properties":{"sessionID":"s","assistantMessageID":"m","callID":"call_1","text":"{\"path\":\"src/a.ts\"}"}}
   →  ToolPart state "pending" appears (message.part.updated) with state.input (parsed) and state.raw (the raw string)
   data: {...,"type":"session.next.tool.called","properties":{"sessionID":"s","assistantMessageID":"m","callID":"call_1","tool":"read","input":{"path":"src/a.ts"},"provider":{"executed":true}}}
   →  "running" state; title/metadata may stream in via message.part.delta (field = "state.metadata.*" selects)
   data: {...,"type":"session.next.tool.success","properties":{"sessionID":"s","assistantMessageID":"m","callID":"call_1","structured":{"lines":120},"content":[{"type":"text","text":"export const x = 1…"}],"provider":{"executed":true}}}
   →  "completed" with output/title/metadata/time{start,end}
   ```

   Errors mirror with `session.next.tool.failed {error}` ⇒ `"error"` state `{error: string}`.

4. **Permission ask (v1):**

   ```
   data: {"directory":"D:/repo","payload":{"id":"p1","type":"permission.asked","properties":{"id":"perm_1","sessionID":"s","permission":"bash","patterns":["npm test*"],"metadata":{},"always":["npm test"]}}}
   ```
   (v2 twin: `{"type":"permission.v2.asked","properties":{"id":"pv2_1","sessionID":"s","action":"execute","resources":["npm test"],"save":["npm test"],"source":{"type":"tool","messageID":"m","callID":"call_1"}}}`)

5. **Question ask:**

   ```
   data: {"directory":"D:/repo","payload":{"id":"q1","type":"question.asked","properties":{"id":"qq_1","sessionID":"s","tool":{"messageID":"m","callID":"call_2"},"questions":[{"question":"Use PORT 3000 or 5173?","header":"Port","options":[{"label":"Use 3000","description":"matches the server config"},{"label":"Use 5173","description":"Vite default"}],"multiple":false,"custom":true}]}}}
   ```

6. **Session status retry:**

   ```
   data: {"directory":"D:/repo","payload":{"id":"st1","type":"session.status","properties":{"sessionID":"s","status":{"type":"retry","attempt":2,"message":"Provider overloaded","next":1726300005000,"action":{"reason":"rate_limit","provider":"anthropic","title":"Rate limited","message":"Retrying in 5s","label":"Retry"}}}}}
   ```
   and the turn's terminal failure:
   ```
   data: {"directory":"D:/repo","payload":{"id":"e1","type":"session.error","properties":{"sessionID":"s","error":{"name":"APIError","data":{"message":"429 from provider","statusCode":429,"isRetryable":false,"responseBody":"rate-limited"}}}}}
   ```

7. **Server-interrupted turn (OpenChamber-synthesized after restart, harness-shaped):**

   ```
   data: {"directory":"global","payload":{"id":"sse-1726300010000","type":"session.error","properties":{"sessionID":"s","error":{"name":"MessageAbortedError","message":"The running turn was interrupted when OpenCode restarted."}}}}
   ```
   Note the shape difference from a real harness abort: the *synthetic* restart error carries `message` directly on the error object (as OpenChamber emits it; compare example 6's `data.message` from the harness itself). A random harness tool abort nests under `data` — both forms exist on the stream and the reducer tolerates both. A harness that renames `MessageAbortedError` breaks the UI's interrupted-turn rendering.

### 5.3 Browser-facing transports

1. **WS global** `GET /api/global/event/ws` (constants `src: packages/web/server/lib/event-stream/protocol.js:1-12`):
   - Frame from server: `{type:"event", payload:<inner GlobalEvent.payload>, eventId?, directory?}` serialized once per wire format for all clients; `ready` frame on connect (with `replayReset: true` and no partial replay when the requested cursor is unknown → client retires its cursor and requests authoritative repair).

     Worked frames a browser receives (query carried `lastEventId=4710`):
     ```json
     {"type":"ready","replayReset":true}                                              // cursor unknown → gap; repair via snapshots
     {"type":"event","eventId":"4711","directory":"D:/repo","payload":{"id":"4711","type":"session.idle","properties":{"sessionID":"ses_x"}}}
     {"type":"event","directory":"global","payload":{"type":"openchamber:session-activity","properties":{"sessionId":"ses_x","phase":"idle"}}}
     {"type":"event","payload":{"type":"openchamber:heartbeat","properties":{}}}        // heartbeat cadence, only while upstream attached
     {"type":"backpressure","bufferedBytes":12834560,"maxBytes":16777216}              // one-shot warning frame
     ```
     Note the two shapes on one socket: harness events carry an inner `{id,type,properties}` (replayable, `eventId` set); synthetic OpenChamber events are a bare `{type:"openchamber:*", properties}` (not replayable, no eventId in the frame).
   - Replay: bounded 2048 events / 8 MiB, retained as encoded frames; `replayAfter(eventId)` returns the suffix after that id, `[]` when it is the newest, `null` when the cursor is unknown (gap) → bridge sends `ready {replayReset:true}`.
   - Heartbeats: `openchamber:heartbeat` emitted only while an upstream stream is attached (WS heartbeat interval 15 s; silently no-op otherwise).
   - Backpressure: close with code 1013 ("client too slow") past 16 MiB buffered; one-shot `backpressure` warning frame at 12 MiB.
   - Post-reconnect `ready` frames are also sent to already-ready clients when the shared upstream reconnects after being ready — this edge drives scoped state repair without closing the browser socket.
   - Synthetic `openchamber:*` events ride the same socket (global hub fan-out) — they are interleaved with the raw payload frames.
2. **WS directory** `GET /api/event/ws?directory=…`: one upstream `GET /event?directory=…` reader per connection, otherwise same frame protocol and heartbeats.
3. **SSE legacy** `GET /api/global/event` and `GET /api/event` (§3.2 SSE forwarder): raw SSE passthrough with heartbeats and upstream-stall watchdog; used by non-WS clients and tests.
4. **OpenChamber control stream** (separate from the harness stream; doc 03 owns the routes): SSE `GET /api/notifications/stream` and `GET /api/openchamber/events` + the WS fan-out set, carrying only OpenChamber-owned events (§5.5).

### 5.4 `openchamber:*` synthetic event inventory (server → UI)

Emit only on the control stream and the global WS bridge (not on `GET /api/global/event` SSE, which is pure harness passthrough):

| event type | properties | producer |
| --- | --- | --- |
| `openchamber:session-status` | `{sessionID, status, timestamp, metadata: {attempt?, message?, next?}, needsAttention}` | session runtime (`src: packages/web/server/lib/opencode/session-runtime.js:151`), also synthesized on restart interruption |
| `openchamber:session-activity` | `{sessionId, phase: "busy"\|"idle"\|"cooldown"}` | session runtime (2 s idle→cooldown handoff) |
| `openchamber:notification` | `{title?, body?, tag?, kind?, sessionId?, directory?, requireHidden?}` | notification emitter |
| `openchamber:heartbeat` | `{}` | event-stream bridges |
| `openchamber:event-stream-ready` | `{}` | stream bridges/upgrade paths |
| `openchamber:session-created` | `{sessionId, directory, createdAt, promptDispatched, dispatchedAsCommand, projectId?, title?}` | openchamber-sessions (`src: packages/web/server/index.js:1314`) |
| `openchamber:scheduled-task-ran` | `{projectId, taskId, ranAt, status, sessionId?}` | scheduled-tasks |
| `openchamber:agent-memory-changed` | `{scope, projectId?}` | agent-memory actions |
| `openchamber:browser-control-request` | `{requestId, action, parameters}` | browser-control broker |
| `openchamber:message-queue` | (queue snapshot envelope) | message-queue runtime |
| `openchamber:worktree-changed` | (worktree change notice) | feature routes |
| `openchamber:permission-auto-accept.updated` | `{sessions: {sessionId: boolean}, revision}` | permission auto-accept |
| `openchamber:ready` | `{}` | desktop startup rail |

### 5.5 Server-side reconnect semantics (summary; client reduction is doc 04)

- Upstream reconnect delay 250 ms, unbounded retries; stall timeouts 20 s (1 active session) / 60 s (>1).
- Event id tracking: the reader keeps the last `id:` seen and resumes with `Last-Event-ID` on every next attempt; a missing id in the stream means that event is not replayable.
- On hub re-attach after a harness restart (new port), `messageStreamRuntime.rebindUpstream()` rebuilds readers (LF-4 step 5).
- The browser may rely on (a) `ready` frames, (b) `backpressure` frames, (c) `heartbeat` frames, (d) exactly-once `payload` frames — nothing else is protocol.

### 5.6 Server-side consumer wiring (who swallows which event)

One global hub, many consumers; a replacement must preserve the *effect* each consumer produces, because the UI depends on the side effects, not on OpenChamber internal names:

| Consumer (module) | Subscribes to | Effect |
| --- | --- | --- |
| `opencodeWatcherRuntime` (`opencode/watcher.js`) | all payloads | notification trigger evaluation, session-info caching, `sessionRuntime.processOpenCodeSsePayload` (status/attention/activity machine → `openchamber:session-status` / `:session-activity`) |
| `permissionAutoAcceptRuntime` | `permission.asked`, `permission.v2.asked` (v2 gating when both are valid), `session.created/updated` (lineage cache), status reconnects | auto-replies `"once"` per policy; `openchamber:permission-auto-accept.updated` on policy change (LF-14) |
| `messageQueueRuntime` | queue triggers (session completion/idle + directory messages) | delivers queued follow-ups via `prompt_async`; emits `openchamber:message-queue` |
| `sessionAssistRuntime` | session lifecycle payloads (+ directory from envelope) | assist generations (small-model) for titles/recaps — sibling doc |
| `sessionGoalRuntime` | session payloads + directory | goal-loop bookkeeping and settle notifications (doc 12) |
| `contextObligatoryRuntime` | session payloads | context-obligation reminders |
| `linearSessionStatusRuntime` | session payload | Linear status comments |
| global WS bridge | everything + synthetic events | browser fan-out (§5.3-1) |
| `notificationTriggerRuntime` (via watcher) | message/session events | push/APNs/desktop notifications per templates + visibility rules (sibling doc for notification rules) |

Envelope traversal: the hub emits `{event: <raw SSE envelope>, payload: <inner event>, directory, eventId, serialize()}`; consumers receive the normalized record (hub `normalizeEvent`), and most unwrap `payload.payload` defensively (some legacy paths emit double-wrapped payloads). A replacement event bus only has to reproduce the normalized record semantics.

---

## 6. Session semantics the harness must honor

All type shapes below are SDK 1.18.30 (`dist/v2/gen/types.gen.d.ts`, line refs in parentheses). Every field the UI renders or conditions on is listed; if the replacement harness omits one, the corresponding UI surface degrades or breaks.

### 6.1 `Session` (line 64)

```json
{
  "id": "ses_...",
  "slug": "string (URL-ish per-session slug)",
  "projectID": "string",
  "workspaceID": "string?",
  "directory": "absolute project directory (scoping key)",
  "path": "string?",
  "parentID": "string? (subagent session's parent)",
  "summary": {"additions": n, "deletions": n, "files": n, "diffs": [{"file","status","additions","deletions","patch"}=[]]},
  "cost": "number? (aggregate session cost)",
  "tokens": {"input": n, "output": n, "reasoning": n, "cache": {"read": n, "write": n}},
  "share": {"url": "string?" },
  "title": "string",
  "agent": "string?",
  "model": {"id": "modelID", "providerID": "string", "variant": "string?"},
  "version": "string (harness/app version marker)",
  "metadata": "object? (OpenChamber stores own keys here, e.g. UI metadata)",
  "time": {"created": ms, "updated": ms, "compacting": ms?, "archived": ms?},
  "permission": [{"permission": string, "pattern": string, "action": "allow"|"deny"|"ask"}],
  "revert": {"messageID": string, "partID"?: string, "snapshot"?: string, "diff"?: string}
}
```

UI conditioning: `time.archived` toggles Archive view; `directory` is the store scoping key; `parentID` builds lineages (permission auto-accept walks it; goal multirun groups); `title/metadata` rename/reorder; `revert` drives the revert banner; `summary.diffs` is deliberately stripped by the proxy for lists (§3.2); `cost`/`tokens` feed usage displays.

### 6.2 `Message` (line 128/213)

**UserMessage**: `{id, sessionID, role:"user", time:{created}, format?: {type:"text"}|{type:"json_schema", schema, retryCount?}, summary?: {title?, body?, diffs}, agent: string, model: {providerID, modelID, variant?}, system?: string, tools?: {[name]: boolean}}`. `time.created` is the single ordering key used client- and server-side (OpenChamber sorts messages by `info.time.created`).

**AssistantMessage**: `{id, sessionID, role:"assistant", time:{created, completed?}, error?, parentID (the user message id), modelID, providerID, mode, agent, path:{cwd, root}, summary?: boolean, cost: number, tokens:{total?, input, output, reasoning, cache{read,write}}, structured?: unknown (json_schema output), variant?, finish?: string}`.

**Error union** (assistant `error`, and `session.error` events):

```json
ProviderAuthError      {"name":"ProviderAuthError","data":{"providerID","message"}}
UnknownError           {"name":"UnknownError","data":{"message","ref?"}}
MessageOutputLengthError {"name":"MessageOutputLengthError","data":{...}}
MessageAbortedError    {"name":"MessageAbortedError","data":{"message"}}
StructuredOutputError  {"name":"StructuredOutputError","data":{"message","retries"}}
ContextOverflowError   {"name":"ContextOverflowError","data":{"message","responseBody?"}}
ContentFilterError     {"name":"ContentFilterError","data":{"message"}}
ApiError               {"name":"APIError","data":{"message","statusCode?","isRetryable":bool,"responseHeaders?","responseBody?","metadata?"}}
```

`name` strings are exact (`APIError` with capital letters). The retry surface keys off `isRetryable`; the busy/retry status carries `attempt` + `next` timestamps; `ProviderAuthError` triggers re-login flows.

### 6.3 `Part` union (line 248-474) — the rendering spine

All parts carry `{id, sessionID, messageID, type}` then:

| type | fields |
| --- | --- |
| `text` | `text`, `synthetic?: boolean`, `ignored?: boolean`, `time?: {start, end?}`, `metadata?: object` |
| `subtask` | `prompt`, `description`, `agent`, `model?: {providerID, modelID}`, `command?` |
| `reasoning` | `text`, `metadata?`, `time: {start, end?}` |
| `file` | `mime`, `filename?`, `url`, `source?: {type:"file", path, text:{value,start,end}} \| {type:"symbol", path, range, name, kind, text} \| {type:"resource", clientName, uri, text}` |
| `tool` | `callID`, `tool: string`, `state: ToolState`, `metadata?: object` |
| `step-start` | `snapshot?: string` |
| `step-finish` | `reason: string`, `snapshot?`, `cost`, `tokens` |
| `snapshot` | `snapshot: string` |
| `patch` | `hash`, `files: string[]` |
| `agent` | `name`, `source?: {value, start, end}` |
| `retry` | `attempt`, `error: ApiError`, `time:{created}` |
| `compaction` | `auto: boolean`, `overflow?: boolean`, `tail_start_id?: string` |

`ToolState` machine (line 337-388):

```json
{"status":"pending","input":{},"raw":"<raw tool-call json string>"}
{"status":"running","input":{},"title"?: string,"metadata"?: object,"time":{"start": ms}}
{"status":"completed","input":{},"output":"string","title":"string","metadata":{},"time":{"start": ms,"end": ms,"compacted"?: ms},"attachments"?: FilePart[]}
{"status":"error","input":{},"error":"string","metadata"?: object,"time":{"start": ms,"end": ms}}
```

`pending` → `running` → (`completed` | `error`); `metadata` increments during running via `message.part.delta` (`field` = e.g. `state.metadata.*` selected by the delta path). Metadata conventions the UI knows (examples used by renderers): OpenChamber tool results (`openchamber` tool native metadata, §8.1), file-path lists, token counts, etc. Unknown metadata must be tolerated, never dropped by the harness.

### 6.4 `Todo` (line 490)

`{content: string, status: string("pending"|"in_progress"|"completed"|"cancelled"), priority: string("high"|"medium"|"low")}` — delivered via `todo.updated` events and `GET /session/{id}/todo`.

### 6.5 `SessionStatus` (line 504)

```json
{"type":"idle"}
{"type":"busy"}
{"type":"retry","attempt":n,"message":string,"action"?: {"reason","provider","title","message","label","link"?},"next": epoch-ms}
```

`next` = when the retry fires (used for countdown). `attempt`/`message`/`next` are mirrored into `openchamber:session-status.metadata`. Busy/retry ⇒ active-session counting, attention states, and "interrupted after restart" reconciliation (LF-4).

### 6.6 Permissions

**v1 `PermissionRequest`** (line 2032): `{id, sessionID, permission: string (e.g. "bash","edit","webfetch"), patterns: string[], metadata: object, always: string[], tool?: {messageID, callID}}`. Reply choices: `once | always | reject`; `always` implies the harness saves a rule (surfaced through `always`/saved-permission APIs). Replies return `boolean`; 404 `PermissionNotFoundError` means already settled.

**v2 `PermissionV2Request`** (line 4177): `{id, sessionID, action: string, resources: string[], save?: string[], metadata?, source?: {type:"tool", messageID, callID}}`. v2 `effect` values: `"allow" | "deny" | "ask"`. v2 `asked` event carries the same fields. The v2 authority is per-session-scoped and its endpoints live under `/api/session/...` on the harness origin (§3.4 rows 22-23). OpenChamber's server-side auto-accept uses the **v1** path with `reply:"once"` (§8.5); the client-side VS Code auto-accept verifies v2 state before replying when both exist. A replacement harness must keep both maps distinct and consistent with their own events.

### 6.7 Questions

**v1 `QuestionRequest`**: `{id, sessionID, questions: QuestionInfo[], tool?: {messageID, callID}}` where `QuestionInfo = {question: string, header: string(≤30 chars), options: [{label(1-5 words), description}], multiple?: boolean, custom?: boolean}`, `QuestionAnswer = string[]`, reply body `answers: string[][]` (one answer array per question; empty array list = answered "none"), reject has no body. Same shapes under `question.v2.*` event names. UI renders headers/labels verbatim; `custom: true` means a free-text answer is allowed (delivered as the only element of the answer array).

### 6.8 Project / directory identity

- `Project` (line 1994): `{id, worktree: string (abs path), vcs?: "git", name?, icon?: {url?, override?, color?}, commands?: {start?: string}, time: {created, updated, initialized?}, sandboxes: string[]}`.
- `GET /path` → `{home, state, config, worktree, directory}` — `directory` and `worktree` seed OpenChamber's home-directory derivation (§3.3).
- The harness keys sessions by absolute directory; OpenCode instance initialization is lazy per directory (first request costs seconds; hence warmup LF-1 step 16 and the worktree gate §3.2).
- `project.updated` / `project.directories.updated` events keep icons/commands fresh.
- OpenChamber implements worktrees on **git**, not harness worktrees, but harness sandbox/worktree events (`worktree.ready|failed`) remain supported for SDK-parity runtimes (§3.4 row 38).

### 6.9 MCP / LSP / VCS surfaces (per-directory)

- `McpStatus`: `{"status":"connected"} | {"status":"disabled"} | {"status":"failed","error":string} | {"status":"needs_auth"} | {"status":"needs_client_registration","error":string}` — surfaced verbatim in the settings UI and McpDropdown; `mcp.tools.changed` per server name.
- `LspStatus`: `{id, name, root, status:"connected"|"error"}`.
- `VcsInfo`: `{branch?, default_branch?}`; diff/status APIs per §3.4 rows (vcs.*).

### 6.10 Worktree ↔ session relationship (OpenChamber's git worktrees)

OpenChamber creates worktrees itself (`POST /api/openchamber/sessions {worktree:{...}}` → server `createWorktree`), waits for its bootstrap (`git-ready`), then creates the session **in the new directory**. Sessions therefore carry a directory anywhere inside the project root; the UI groups by `projectID`/worktree root and archives sessions with the worktree (`POST /api/openchamber/sessions/archive`, ≤500 ids, one-by-one `PATCH /session/{id} {time:{archived}}`). The harness requirement is only: sessions are directory-scoped, and directory-scoped requests to a fresh directory are allowed to pay a lazy-init cost (gated server-side).

### 6.11 Field-by-field consumer matrix (what breaks per missing field)

A replacement harness must treat this as a regression checklist; each row = a UI surface that reads the field.

| Object.field | Consumed by (surface / behavior) | Missing ⇒ |
| --- | --- | --- |
| `Session.id/slug` | sidebar rows, deep links, share UI | rows unkeyable |
| `Session.directory` | every directory-scoped cache store; presence re-render | global collapse, wrong scoping |
| `Session.projectID`(+`workspaceID`) | project grouping; global session map | sidebar un-grouped |
| `Session.parentID` | subagent trees, permission auto-accept lineage, goal/multirun grouping | auto-accept stops covering subagents |
| `Session.title` | sidebar, tabs, PWA manifest shortcuts | "(untitled)" everywhere |
| `Session.time.created/updated` | ordering ("most recently updated"), freshness | wrong sort; stale detection breaks |
| `Session.time.archived` | Archive view + exclusion from main list; unarchive = patch time without archived | archive cleanup impossible |
| `Session.time.compacting` | compaction banner during summarize | compaction UX degraded |
| `Session.cost`, `Session.tokens` | usage/budget screens; goal token budgets (doc 12) | budget UI empty |
| `Session.summary.{additions,deletions,files,diffs?}` | session list "changed files" chips | chips absent (proxy already strips `diffs` for lists) |
| `Session.share.url` | share menu | share disabled |
| `Session.model{id,providerID,variant}` + `Session.agent` | per-session picker restore; send/fork selection reuse (LF-13) | defaults mis-resolved |
| `Session.permission[]` | per-session permission display/edit | permission editor empty |
| `Session.revert{messageID,partID}` | revert banner + unrevert button | revert state invisible |
| `Session.version` | server-status reporting (status dialog §3.3) | diagnostics degrade |
| `UserMessage.model/time.created/agent` | ordering, "sent with model X" chip, selection reuse | LF-9/13 selection restore fails |
| `UserMessage.format` | structured-output request echo | json_schema turns can't be identified |
| `AssistantMessage.agent/modelID/providerID/variant` | model chip, fork/branch rendering | attribution wrong |
| `AssistantMessage.time.completed` | turn completion detection — also control-service wait baseline (LF-13) | waits never complete |
| `AssistantMessage.tokens{input,output,reasoning,cache}` | token meter, compaction reasoning | meter empty |
| `AssistantMessage.cost` | cost display | missing cost |
| `AssistantMessage.parentID` | pairing a user prompt with its assistant answer (title turn collection) | turns unpaired |
| `AssistantMessage.error.*` (union) | failure lines; `ProviderAuthError` ⇒ re-login CTA; retryable flag | opaque errors |
| `AssistantMessage.finish` | "why stopped" line | missing finish reason |
| `Part.type` union | render switch (§6.3) | unknown parts dropped — must render as null-op, never crash |
| `ToolPart.callID/tool/state` | tool cards, interrupted-turn tools recovery | cards broken |
| `ToolState.metadata` | per-tool summaries (lines read, files changed, exit codes…) | cards content-empty |
| `ToolStatePending.raw` | speculative preview of in-flight args | preview absent |
| `TextPart.synthetic/ignored` | hiding system-injected text from history; "ignored" shows placeholder | synthetic context text rendered as user speech |
| `ReasoningPart.time` | thinking indicator durations | pulse stuck |
| `FilePart.source` | jump-to-source for attached context | citation linking off |
| `CompactionPart.auto/overflow` | compaction explanations | banner missing |
| `Todo.status/priority/content` | todo panel + progress | todo list empty |
| `SessionStatus.type/attempt/message/next/action` | status chip, retry countdown, retry action CTA/link | chip static; retry not actionable |
| `PermissionRequest.permission/patterns/always` | card title ("edit src/x", "bash npm test"), Always-allow targets | card unreadable |
| `QuestionInfo.header/options/multiple/custom` | question card buttons + free text | card unusable |
| `McpStatus.status` variants | MCP settings rows incl. OAuth CTA for `needs_auth` | MCP rows stuck unknown |
| `Project.worktree/vcs/commands.start` | project identity, init button, worktree ops | projects can't initialize |
| `Path.{home,state,config,worktree,directory}` | home dir derivation, config path display | onboarding defaults wrong |
| `VcsInfo.branch` | branch chip; `vcs.branch.updated` events keep it live | branch chip empty |

---

## 7. Model/provider contract

### 7.1 `Config` relevant subset (line 1520)

Fields the UI reads/conditions on: `$schema, shell, logLevel, server{host,port?}, command{...}, skills{paths?,urls?}, watcher.ignore, snapshot, plugin (string | [name, options][] — OpenChamber's injection point), share:"manual"|"auto"|"disabled", autoshare, autoupdate, disabled_providers, enabled_providers, model (default "providerID/modelID"), small_model, default_agent, subagent_depth, username, mode/agent (AgentConfig maps incl. built-units `build`,`plan`,`general`,`explore`,`title`,`summary`,`compaction`), provider{[id]: ProviderConfig}, mcp{[name]: McpLocalConfig|McpRemoteConfig|{enabled}}, formatter, lsp, instructions[], layout, permission (PermissionConfig), tools{[name]: boolean}, attachment.image{enabled?, max_size?, max_height?, max_base64_bytes?}, enterprise.url, tool_output{max_lines?, max_bytes?}, compaction{auto?,prune?,tail_turns?,preserve_recent_tokens?,reserved?}, experimental{...}"`.

`GET /config?directory=` returns the **merged** effective config (user + project + inline `OPENCODE_CONFIG_CONTENT`); `PATCH /config {config}` (no directory, global) writes global config; read-modify-write is the pattern (`updateConfigPartial`).

External mode: OpenChamber persists agent/command/MCP/provider writes **directly to config files** (`$XDG_CONFIG_HOME/opencode/opencode.json` → `~/.config/opencode`, project `.opencode/opencode.json`, custom `OPENCODE_CONFIG`), because a live external harness caches config at process start and config-API writes would not be picked up until restart — hence LF-11.

### 7.2 Provider/Model shapes

`Provider` (line 1733): `{id, name, source: "env"|"config"|"custom"|"api", env: string[], key?, options: object, models: {[modelId]: Model}}`.

`Model` (line 1653): `{id, providerID, api: {id, url, npm}, name, family?, capabilities: {temperature, reasoning, attachment, toolcall, input: {text,audio,image,video,pdf}, output: {...}, interleaved}, cost: {input, output, cache{read,write}, tiers?, experimentalOver200K?}, limit: {context, input?, output}, status: "alpha"|"beta"|"deprecated"|"active", options: object, headers: {k:v}, release_date: string, variants?: {[variantId]: object}}`.

Worked example (helps pinning every field; `GET /config/providers` entry):

```json
{
  "id": "anthropic",
  "name": "Anthropic",
  "source": "api",
  "env": ["ANTHROPIC_API_KEY"],
  "options": {},
  "models": {
    "claude-sonnet-4": {
      "id": "claude-sonnet-4",
      "providerID": "anthropic",
      "api": {"id": "anthropic", "url": "https://api.anthropic.com/v1", "npm": "@ai-sdk/anthropic"},
      "name": "Claude Sonnet 4",
      "capabilities": {"temperature": true, "reasoning": true, "attachment": true, "toolcall": true,
        "input": {"text": true, "audio": false, "image": true, "video": false, "pdf": true},
        "output": {"text": true, "audio": false, "image": false, "video": false, "pdf": false},
        "interleaved": false},
      "cost": {"input": 3, "output": 15, "cache": {"read": 0.3, "write": 3.75}},
      "limit": {"context": 200000, "output": 64000},
      "status": "active",
      "options": {},
      "headers": {},
      "release_date": "2025-02-24",
      "variants": {"max": {}, "high": {}, "low": {}}
    }
  }
}
```

What the UI reads from these: `variants` keyset = thinking-level picker (`modelVariants.ts`); `limit.context/output` = small-model budgets and overflow warnings; `cost` fields = usage math; `capabilities.reasoning` = reasoning-stream UI; `capabilities.attachment` + input flags = attach-menu gating; `status` = deprioritized badges; `release_date` = small-model family scan ordering (§7.4 step 2); `source` = provider-config UI ("env"-sourced providers show env-key guidance).

Model selection contract (`resolveDefaultSelection` in `openchamber-sessions/routes.js:124`): settings `defaultModel` (validated against providers) → selected agent's `model` → config `model` → fallback `{providerID:"opencode", modelID:"big-pickle"}` → first provider's first model. Variants are the model's `variants` keyset (`src: packages/ui/src/lib/modelVariants.ts`); a variant is sent only when it exists for that model.

The catalog (models.dev) is fetched by OpenChamber itself (`GET /api/openchamber/models-metadata`, `https://models.dev/api.json`, 5 min TTL; free zen models `GET /api/zen/models`) — the harness is not intermediating this.

### 7.3 Quotas

`GET /api/quota/:providerId` etc. are OpenChamber-owned (§4 S-17). Quota is *surfaced* into model/provider rows but **not** fetched through the harness — replacements keep the provider-registry table (`providerId`, `providerName`, `aliases`, auth alias sets) only if they want quota parity. Harness relevance: auth entries live in the harness's credential file:

- Harness credential file: `~/.local/share/opencode/auth.json` (path constant `AUTH_FILE`; `src: packages/web/server/lib/opencode/auth.js`). Entry shapes (`Auth = OAuth | ApiAuth | WellKnownAuth` in the SDK types):

  ```json
  {
    "anthropic": {"type": "api", "key": "sk-ant-..."},
    "openai":    {"type": "oauth", "access": "at-...", "refresh": "rt-...", "expires": 1726300000000, "accountId": "acct-..."},
    "github-copilot": {"type": "oauth", "access": "gho_...", "expires": 0}
  }
  ```

  All keys are provider IDs; unknown extra keys are tolerated but preserved on write (the file is written with an automatic backup). The SDK's `expires` field may carry numeric timestamps; treat non-numeric spellings (including the types' `"NaN"`/`"Infinity"` sentinels) as "unknown/none", never as timestamps. OpenChamber reads it directly for the small model and quota (server-side, never the browser), with read/write helpers and backups. If the replacement harness stores credentials elsewhere, the small-model module's auth resolution is the one integration point to shim.
- Harness auth store API: `PUT /auth/{providerID} {auth}` sets a credential (used by OpenChamber's custom-provider route; secrets never flow through OpenChamber settings), `DELETE /auth/{providerID}` removes it.
- Provider OAuth flows: `POST /provider/{providerID}/oauth/authorize {method: number, inputs?}` → `{url, method:"auto"|"code", instructions}`; `POST /provider/{providerID}/oauth/callback {method, code?}` (15-minute proxy budget §3.2). `GET /provider/auth` → `{[providerId]: ProviderAuthMethod[]}` with `prompts` (text/select with `when` conditions) driving the interactive UI.
- OpenChamber may also perform **claude-cli auth** imports (`claude-cli-auth.js`) and provider env alias mirroring — these read the same credential file, not the harness API.

### 7.4 Small-model module (server-side, reuses harness credentials)

`POST /api/small-model/generate {prompt, system?, maxOutputTokens?, model?, directory?, sessionID?, preferredProviderID?, preferredModelID?, restrictToPreferredProvider?}` → `{text, providerID, modelID, source, inputTruncated?}`. `GET /api/small-model?directory=&providerID=&modelID=` → `{available, model: {...resolved, hasLogin, inputCharBudget, contextTokens, contextKnown, outputTokens, structuredOutput, outputTokenLimit}, authenticatedProviders: string[]}`.

Harness coupling (must be replicated against the replacement):

1. **Credential source** = the harness's `auth.json` + config-layer `provider.<id>.options.apiKey` (with `{env:NAME}`/`{file:PATH}` substitution) + the running harness's plugin-registered runtime credential/endpoint snapshot (only exists inside the harness process; reset on every harness restart; answered as `null` (not `[]`) when the harness is unreachable).
2. **Resolution chain** (mirrors harness-internal `getSmallModel`): OpenChamber settings override (`smallModelUseDefault=false` → `smallModelOverride` `provider/model`) → harness config `small_model` → family scan within the session provider then other authenticated providers (`gemini-flash` → `gpt-nano` → `claude-haiku`, newest `release_date`) → Copilot hidden utility models → session's own model. `claude-code` provider always refused (spawns Claude Code CLI).
3. **Context budgeting**: input clamp `~4 chars/token` against catalog `limit.context` minus the output reserve; `onOverflow: 'truncate' | 'error'` (413 `{code:'context-too-small', requiredChars, availableChars}`); output capped at catalog `limit.output`; reserve == requested or the two drift (doc strings at `src: packages/web/server/lib/small-model/DOCUMENTATION.md`).
4. Wire formats: OpenAI chat-completions (base URL from config `options.baseURL` → `https://api.openai.com/v1` → runtime endpoint → catalog `api`), OpenAI Responses (ChatGPT-plan OAuth backend), Anthropic `/messages` (`x-api-key`; base honored without inserting `/v1`), Google `generateContent` (`x-goog-api-key`, `thinkingLevel`/`thinkingBudget: 0`), Copilot (device-OAuth bearer, endpoint from authenticated `/models` metadata, prefer Anthropic→Responses→ChatCompletions), OpenCode-hosted providers (sentinel `apiKey:"public"` refused ⇒ `zen` excluded without a real login). Structured output per format (`response_format json_schema` / `text.format` / forced tool call / `generationConfig.responseSchema`); `structured-output-unsupported` and `output-exhausted` are explicit error codes; missing credential ⇒ 401 `{code:'no-provider-login'}`.

This module is optional for a replacement UI, but the pickers/walkthrough/goal-audit/dictation surfaces depend on it — if kept, resolve against the replacement credential store.

### 7.5 Model/agent selection precedence (decision table)

Where a model/agent/variant selection comes from, in check order, everywhere OpenChamber resolves one (`src: packages/web/server/lib/openchamber-sessions/routes.js:124`, `openchamber-control/service.js`):

| Order | Source | Conditions |
| --- | --- | --- |
| 1 | Explicit request (`model`, `agent`, `variant` inputs) | validated against the directory's own `GET /config/providers` + `GET /agent` **before** side effects: unknown model ⇒ 400 `Unknown model '<p>/<m>' for <dir>`; unknown agent ⇒ 400 `Unknown agent '<a>' for <dir>`; subagent-mode agent ⇒ 400 `Agent '<a>' is a subagent and cannot receive a prompt directly`; unknown variant ⇒ 400 `Unknown variant '<v>' for model ...`; empty provider/agent lists (failed lookup) never validate-against — fail-open (§11 item 6) |
| 2 | Target session's last user message (`reuseSessionSelection`) | for `session.send`/`session.fork` only: `GET /session/{id}/message?limit=20` scanning backwards for the newest user message with a `model`; reuse its `model` + `agent` + `variant` before any default |
| 3 | OpenChamber settings `defaultModel`/`defaultAgent`/`defaultVariant` | model must exist in the directory's provider list; agent must be a primary-mode agent (`mode` absent/`primary`/`all`) and not `hidden` |
| 4 | Harness config `default_agent` (`defaultAgent` alias) + config `model` | same validation; config `model` is `providerID/modelID` |
| 5 | Agent's own `model`/`variant` (primary agents) | picked from resolved agent |
| 6 | Fallback model `opencode/big-pickle` | only if that provider/model exists in the directory's list |
| 7 | First provider's first model | last resort; 400 `No model is configured or available for the requested directory` when nothing resolves |

Variant handling: `variant` is honored only when the chosen model's `variants` object contains that key (`resolveVariant`); a mismatch silently drops to undefined (it is not an error).

Browser pickers mirror this: favorites/recents live in OpenChamber settings (`models.list` action exposes them), the authoritative candidate list is `GET /config/providers` (§3.4 row 29), and the *session picker* restores from that session's last user message (row 2). The UI never guesses a model: an empty providers list renders the picker empty rather than defaulting silently (§11 item 2).

---

## 8. Injections into the harness (what OpenChamber adds)

Only for **managed** harness runs (OpenChamber owns the child process env). Injection composes by appending to `OPENCODE_CONFIG_CONTENT`'s `plugin` array through `appendManagedPlugin` — parse `OPENCODE_CONFIG_CONTENT` as JSONC (trailing commas allowed, must be a JSON object, `plugin` must be an array if present), drop any prior entry of the same `file://` URL, append the new one, serialize as JSON (`src: packages/web/server/lib/opencode/managed-plugin-config.js`). Multiple injections chain in order (agent tools first, then system prompt; the second sees the first's output). PATH and `OPENCODE_SERVER_PASSWORD` are **lifecycle-owned** and cannot be overridden by injected env.

### 8.1 The `openchamber` control tool (+ `openchamber_web`, `openchamber_memory`)

Injection unit: one plugin source file `<dataDir>/agent-tool/openchamber-plugin.js`, `mode 0600`, exporting `OpenChamberPlugin = async () => ({ tool: { <tool entries> } })`. Tool entries registered per capability: `openchamber` (control) when `agentControlToolEnabled !== false`; `openchamber_web` when `agentWebToolEnabled !== false`; `openchamber_memory` when `agentMemoryToolEnabled === true` and the memory feature gate is on. If all three are off, no plugin is injected at all.

Callback: the plugin `execute` posts `POST {OPENCHAMBER_AGENT_TOOL_URL}` = `http://127.0.0.1:<openchamber-port>/api/openchamber/agent-tool` with `Authorization: Bearer <OPENCHAMBER_AGENT_TOOL_TOKEN>` (fresh per child), `Content-Type: application/json`, body `{input: <resolved args>, contextDirectory: <OpenCode's authoritative session directory>, tool: <tool name>}`, `signal: context.abort`. The route accepts **loopback-only** requests and compares the bearer timing-safe; aborts propagate into the control service. Action resolution namespacing: inputs may sit beside `action` or inside `parameters` (explicit `parameters` wins); bare names resolve within the calling tool's own action set, never outside it; unresolvable names answer with the tool's action list (`resolveAgentToolAction`, `src: packages/web/server/lib/openchamber-control/actions.js:110`).

Result envelope (versioned; both success and failure):

```json
{"schemaVersion": 1, "ok": true,  "action": "<name>", "data": {...}}
{"schemaVersion": 1, "ok": false, "action": "<name>", "error": {"message": "...", "kind": "usage"|"runtime"}, "data"?: {"partial": true, "partialAction": "fork-created"|"goal-configured", "sessionId", "directory"}}
```

`kind:"usage"` for 4xx-class input problems, `"runtime"` otherwise (derived from `statusCode` 400-499). Native tool metadata (`context.metadata`) carries `{title, metadata: {<toolName>: {schemaVersion:1, action, description, ok?}}}`.

**Tool args schema** (identical template for all three): `args = { action: {type:"string", enum:[<actions>], oneOf:[{const:<action>, description:<agent-facing blurb>}], description:"OpenChamber action to perform"}, parameters: {type:"object", properties: <per-tool properties>, additionalProperties:false, description:"Inputs for the action; use an empty object when none are needed"} }`.

`openchamber` (control) description text (exact, `src: packages/web/server/lib/agent-tool/runtime.js:111`):

> "Control OpenChamber projects, sessions, and scheduled tasks on the user's behalf. Sessions and scheduled tasks you create are for the user to follow and interact with; never use this tool to delegate parts of your own current task. Use one action per call. Scope with projectId or directory; omit both to use the current session directory. Session dispatches return immediately by default and you receive no notification when a dispatched session finishes, so never promise to report back on it; the user follows it in OpenChamber; a dispatched session needs no follow-up from you. If the user later asks how it went, use session.messages (add wait to block until it is idle, lastAssistant for just the final answer) — session.send always sends a NEW prompt and never just waits. Set wait only when the user asks or the next step requires the completed result. Session and worktree deletion are unavailable."

Control action list (agent-exposed; `schedule.status` is CLI-only, `agentExposed:false`). Titles are native-tool presentation; `description` values are verbatim:

| action | title | agent-facing description |
| --- | --- | --- |
| `projects.list` | List configured projects | "List configured projects; no parameters" |
| `models.list` | Show model preferences | "Show default, favorite, and recent model preferences; no parameters" |
| `session.list` | List sessions | "List sessions; optional directory, limit (default 10), all, or withStatus" |
| `session.create` | Create a session | "Create a session in the current directory by default; prompt is optional" |
| `session.send` | Send a prompt | "Send a new prompt to sessionId; scope with projectId or directory" |
| `session.fork` | Fork a session | "Fork sessionId; messageId selects the boundary; prompt is optional" |
| `session.status` | Check session status | "Check sessionId status; directory defaults to the current session" |
| `session.messages` | Read session messages | "Read text-only messages and current sessionStatus for sessionId; directory and limit 10 are defaults" |
| `schedule.list` | List scheduled tasks | "List tasks and scheduler status; scope with projectId or directory" |
| `schedule.create` | Create a scheduled task | "Create task; requires name, prompt, model, and one schedule selector" |
| `schedule.run` | Run a scheduled task | "Run taskId; scope with projectId or directory" |
| `schedule.delete` | Delete a scheduled task | "Delete taskId; scope with projectId or directory" |
| `schedule.toggle` | Enable or disable a scheduled task | "Enable or disable taskId; requires the disabled boolean" |

Control parameter properties (exact strings):

```json
{
  "projectId":  {"type":"string","description":"Configured project ID; do not combine with directory"},
  "directory":  {"type":"string","description":"Absolute checkout or session directory; defaults to the current session directory"},
  "sessionId":  {"type":"string"},
  "messageId":  {"type":"string","description":"Optional fork boundary message ID"},
  "taskId":     {"type":"string"},
  "title":      {"type":"string"},
  "prompt":     {"type":"string"},
  "model":      {"type":"string","description":"Model in provider/model format. When the user names no model: for session.create pick a suitable one from models.list favorites or recents (omit if there are none); for send and fork omit it — the session reuses its previous model"},
  "agent":      {"type":"string","description":"OpenCode agent name; new sessions default to the build agent and existing sessions keep their previous one. Set only when the user explicitly requests a different agent"},
  "variant":    {"type":"string","description":"Model variant; use only when the user explicitly requests it"},
  "worktree":   {"type":"string","description":"New worktree name for session.create. Omit by default; use only when the user explicitly asks for an isolated worktree. Uncommitted changes do not carry over into a new worktree"},
  "branch":     {"type":"string","description":"Branch name for the new worktree"},
  "startRef":   {"type":"string","description":"Git ref used to create the new worktree"},
  "setUpstream": {"type":"boolean","description":"Make the new worktree branch track its upstream"},
  "goal":       {"type":"boolean","description":"Run the dispatched prompt in Goal Mode; use only when the user explicitly requests it"},
  "goalTokenBudget": {"type":"integer","minimum":1000,"maximum":100000000,"description":"Goal token budget; requires goal"},
  "wait":       {"type":"boolean","description":"Wait for current session activity to become idle. Omit by default; use only when the user asks or the next step requires the completed result"},
  "timeout":    {"type":"integer","minimum":1,"maximum":86400,"description":"Wait timeout in seconds (default 600); requires wait"},
  "lastAssistant": {"type":"boolean","description":"Return the last assistant text; create/send/fork require wait"},
  "limit":      {"type":"integer","minimum":1,"description":"Maximum sessions or messages to return (default 10)"},
  "all":        {"type":"boolean","description":"Include archived sessions or all messages, depending on the action"},
  "last":       {"type":"boolean","description":"Return only the last matching session message"},
  "withStatus": {"type":"boolean","description":"Include authoritative status in session.list"},
  "role":       {"type":"string","enum":["all","user","assistant"],"description":"Message role filter"},
  "name":       {"type":"string"},
  "daily":      {"type":"string","description":"Daily run time in HH:mm format"},
  "weekly":     {"type":"string","description":"Comma-separated weekdays; 0=Sunday and 6=Saturday"},
  "once":       {"type":"string","description":"One-time run date in YYYY-MM-DD format"},
  "time":       {"type":"string","description":"Weekly or one-time run time in HH:mm format"},
  "cron":       {"type":"string","description":"Cron expression"},
  "timezone":   {"type":"string","description":"IANA timezone"},
  "disabled":   {"type":"boolean","description":"true disables and false enables; required for schedule.toggle"}
}
```

(`title` is shared with the memory tool, which overrides its description there.)

`openchamber_web` description:

> "Look at and interact with a web page in OpenChamber's browser panel, so you can check your own work rather than describing what you expect. Use one action per call. Open a page, snapshot it to read its text and its interactive elements, then click, type or scroll using the selectors the snapshot returned; snapshots also report any errors the page logged. Pass a selector to browser.snapshot to read one part of a long page. browser.inspect returns computed styles when the question is how something renders. Set viewport to check a layout at mobile, tablet or desktop size. The page runs with the user's real logins, so treat what you see as their live session."

Web actions: `browser.open` ("Open url in the in-app browser panel; use it to look at the running app. Set viewport to mobile, tablet or desktop to lay the page out at that size"), `browser.snapshot` ("Read the open page: url, title, visible text, and interactive elements with the selectors the other browser actions accept. Pass selector to read only that part of a long page. Reports any errors the page logged"), `browser.click` ("Click an element; give selector, or text to match a link or button by its visible label"), `browser.type` ("Type value into the field matched by selector; set submit to press Enter afterwards"), `browser.scroll` ("Scroll the page; direction is up, down, top, or bottom, or pass selector to bring one element into view"), `browser.back` ("Return to the previous page in this tab; no parameters"), `browser.forward` ("Move forward again in this tab; no parameters"), `browser.inspect` ("Read the computed styles of the element matched by selector — colours, fonts, spacing, borders — as the page actually renders them"), `browser.capture` ("Save what is currently visible in the browser panel as an image file in the project and return its path, so a change can be shown rather than described. Pass label to name it (for example before-fix); the result reports the page, layout and path to reference in your answer"), `browser.resize` ("Lay the open page out at a different size; viewport is mobile, tablet, desktop, or fill to use the whole panel"). Web parameter names: `url, selector, text, value, submit, direction, viewport("mobile"|"tablet"|"desktop"|"fill"), label`.

`openchamber_memory` description:

> "Keep what you learn across sessions, so the user does not have to explain the same thing twice. Use one action per call. The session already lists the titles of what is stored. A title is an abbreviation, not the memory: read the entry with memory.read before acting on it, because titles leave out the conditions and exceptions that decide how the memory applies, and the ones that look self-explanatory hide them most often. Save something only when it will still be true in a later session — a stable preference, a project convention, a decision and its reason, or a hard-won pointer. Do not save one-off task state, anything you can read from the code, secrets or credentials, or anything the user asked you not to keep. Choose the scope deliberately: global is about the user and reaches every project, so put a project's conventions in project scope. What you save is shown to the user as unreviewed until they confirm it, so save plainly and say what you saved when it matters."

Memory actions: `memory.read` ("Read the full text of one memory listed in the session index. The index shows titles only, and a title omits the conditions that decide how the memory applies, so read before acting rather than working from the title. Requires title (as the index spells it) or memoryId; scope is optional and both stores are searched without it"), `memory.list` ("List stored memory titles when the session index is missing or stale; scope is global, project, or both (default)"), `memory.save` ("Store a durable fact, preference, or reference; requires title and body, plus scope global (about the user) or project (about this codebase). Restating something already stored updates it. Do not store secrets, one-off task state, or anything the user asked you not to keep"), `memory.delete` ("Delete a memory that turned out to be wrong or obsolete; requires memoryId and scope"). Memory-only parameters: `body` ("Full text of the memory; state it so it still makes sense in a session that has none of this conversation"), `scope` (global|project|both + semantics), `memoryId`, `type` (`fact|preference|reference`), and its own `title` description ("The memory's title, exactly as the session index lists it. Use this to read an entry you can already see; use memoryId only when a result gave you one").

Server-side execution of the control actions (`src: packages/web/server/lib/openchamber-control/service.js`): session validations (`timeout requires wait`, `lastAssistant requires wait`, `limit` positive int, wait 1..86400 s default 600, poll 500 ms), one directory status lookup per directory never erases other results, wait never treats an initial idle as completion (requires observed busy/retry or a newly completed assistant message), `promptDispatched` only after a fresh user message lands (LF-13), send/fork reuse the target session's last user-message selection before defaults, explicit scope (projectId|directory) takes precedence over contextDirectory. `browser.capture` writes the PNG/JPEG **server-side** to `<projectDir>/.openchamber/screenshots/` (label reduced to a filename fragment, never a path) and returns `{path, hint: "Write ![](<path>) in your reply to show this image to the user; it is rendered under your message.", url?, title?, viewport?, width?, height?}` — the `hint` string is verbatim with the returned path substituted (§11).

#### 8.1.5 Exact success payloads (`data`) per control action

Every action returns through the §8.1 envelope (`data` key). Exact keys (from `src: packages/web/server/lib/openchamber-control/service.js` + `openchamber-sessions/routes.js`):

| action | `data` payload |
| --- | --- |
| `projects.list` | `{"projects": [{"id", "path" (abs), "label"}]}` |
| `models.list` | `{"defaultModel"?, "defaultVariant"?, "defaultAgent"?, "favoriteModels": [], "recentModels": []}` |
| `session.list` | `{"sessions": [Session & {"status": SessionStatus\|{"type":"unknown"}}], "limit", "directory", "archived": "included"\|"excluded"}` — archived sessions included only with `all:true`; directory lookup failure ⇒ `status:{"type":"unknown"}` for that session only; status lookup results are cached-per-directory within one call |
| `session.create` | `{"sessionId", "directory", "projectId"?, "title"?, "worktree"?: {…created worktree…}, "model"?: {"providerID","modelID"}, "agent"?, "variant"?, "promptDispatched": bool, "promptError"?, "dispatchedAsCommand": bool, "goalEnabled"?, "goalTokenBudget"?, ("sessionStatus", "lastAssistantMessage"?) when `wait`}` |
| `session.send` / `session.fork` | `{"action", "sessionId", "directory", "sourceSessionId"? (fork), "title"? (fork), "model": {providerID, modelID}, "agent"?, "variant"?, "promptDispatched", "promptError"?, "dispatchedAsCommand", "goalEnabled"?, "goalTokenBudget"?, ("sessionStatus", "lastAssistantMessage"?) when `wait`}` — the internal `baselineAssistantMessageId` (completed-assistant marker used by the wait loop) is always stripped from public results. A failure after fork/goal creation succeeds throws a partial: `{"partial": true, "partialAction": "fork-created"\|"goal-configured", "sessionId", "directory"}` on the error envelope |
| `session.status` | `{"sessionId", "directory", "sessionStatus": SessionStatus}` (absent session ⇒ `{type:"idle"}`) |
| `session.messages` | `{"sessionId", "directory", "role", "sessionStatus", "messages": [{"id", "role": "user"\|"assistant", "createdAt", "completedAt", "model": "providerID/modelID"\|null, "text"}]}` — ordered oldest→newest by `createdAt`; `text` = concatenation of the message's `text` parts; last N by `limit`, exactly one with `last`, all with `all` (incompatible combos are usage errors) |
| `schedule.list` | `{"scheduler": <scheduler status record>, "tasks": [...]}` |
| `schedule.create` | `{"task": <task>, "created": bool}` |
| `schedule.run` / `schedule.delete` / `schedule.toggle` | task-run result / `{"deleted": true, "tasks": [...]}` / `{"task", "enabled"}` (task record shapes: doc 12) |
| `browser.*` (except capture) | backend-defined snapshot/click/etc result objects (browser-panel doc) |
| `browser.capture` | `{"path" (project-relative), "hint" (exact text in §8.1), "url"?, "title"?, "viewport"?, "width"?, "height"?}` |
| `memory.*` | agent-memory action results (sibling doc; degrade to error envelope when memory service absent: 503) |

Wait semantics common to create/send/fork/session.messages-with-wait: `wait: true` activates a poll loop (500 ms, `GET /session/status?directory=`) requiring `timeout` (1..86400 s, default 600) and recording observed activity before accepting idle completes; `lastAssistant:true` then attaches `lastAssistantMessage` (optional). On timeout/cancel the error is a failure (500/499), never `{"sessionStatus": {"type":"idle"}}`.

### 8.2 Project knowledge injection (dispatch-time harness payload)

When the control service/scheduled-task service dispatches a prompt, the harness receives via `prompt_async` the parts array (§4 S-06) with an optional **first** synthetic part containing the project's standing knowledge (session knowledge runtime; content + signature tracked, marked delivered only after the prompt is accepted; re-attached on the next dispatch if the previous one was rejected). Normal prompt part is second; goal intro third (doc 12). Synthetic parts are `{type:"text", synthetic:true}`.

### 8.3 Goal intro part

`buildGoalIntroText(tokenBudget)` (module `session-goal/create.js`) produces the third synthetic part when `goal: true` — content is doc-12's domain; the harness contract is only: a synthetic `text` part before/after the user prompt, never blocking.

### 8.4 System-prompt optimizer plugin

Enabled by settings `optimizeSystemPrompt === true`, injected only with the harness OpenChamber owns. Plugin source (exact, `src: packages/web/server/lib/system-prompt/runtime.js:7`):

```js
const PROVIDER_PROMPT_BOUNDARY = "You are powered by the model named"
const MINIMAL_IDENTITY = "You are OpenCode, a coding agent."
export const OpenChamberSystemPromptPlugin = async () => ({
  "chat.message": async (input, output) => {
    if (!input.sessionID) return
    const agent = output?.message?.agent ?? input.agent
    if (agent === "build" || agent === "plan") { optimizedSessions.set(input.sessionID, agent); return }
    optimizedSessions.delete(input.sessionID)
  },
  event: async ({ event }) => {
    if (event?.type === "session.deleted") optimizedSessions.delete(event.properties?.info?.id)
  },
  "experimental.chat.system.transform": async (input, output) => {
    if (!input.sessionID || !optimizedSessions.has(input.sessionID)) return
    const prompt = output.system.join("\n")
    const boundary = prompt.indexOf(PROVIDER_PROMPT_BOUNDARY)
    if (boundary < 0) return
    output.system.length = 0
    output.system.push(MINIMAL_IDENTITY + "\n\n" + prompt.slice(boundary))
  },
})
```

Hook names the harness plugin API must expose: `chat.message` (payload `{sessionID, agent?}`, output `{message:{agent}}`), `event` (harness events), and the system-transform hook `experimental.chat.system.transform` (input `{sessionID}`, output `{system: string[]}`). Boundary marker string is exact; absence of the boundary leaves the prompt untouched. Other agents are never transformed; plan-mode restrictions/synthetic reminders are re-injected by the harness after the transform.

### 8.5 Permission auto-accept (server side, LF-14)

Policy: settings key `permissionAutoAccept` = `{sessions: {[sessionId]: boolean}, revision: n}`; UI toggle `PUT /api/permission-auto-accept/sessions/:sessionId {enabled, directory?}`; `GET /api/permission-auto-accept` reads; every change broadcasts `openchamber:permission-auto-accept.updated {sessions, revision}` on the control stream.

Behavior (`src: packages/web/server/lib/permission-auto-accept/runtime.js`):

1. Trigger set: `permission.asked` (v1) events from the shared hub, plus reconcile on (re)connect and after a toggle is enabled.
2. Eligibility walks the session's `parentID` lineage (cached session infos; `GET /session/{id}?directory=`) — the toggle on a parent covers subagents.
3. Reply is **always `"once"`** through v1 `POST /permission/{requestID}/reply {reply:"once"}?directory=`; never `always` (the saved-rules machinery is the harness's, not OpenChamber's). Retries 0/250/1000 ms with 5 s timeout each; 404 counts as settled/success.
4. Reconcile merges v1 `GET /permission` for unscoped + each known project directory, dedupes by id, processes each with the same retry envelope; one directory's fetch failure skips only that directory.
5. Server-side effect: a busy-looping auto-accepted session keeps running without the user's card; notifications are suppressed for auto-accepting sessions (notification trigger consults `isSessionAutoAccepting`).

Client-side parity (VS Code/dual-runtime) replayed through `createVSCodePermissionAutoAcceptRuntime` (retry delays [0,250,1000], lineage walk, v2 state preflight only when the same authority backs the list; §3.4 note).

### 8.6 What OpenChamber writes to the config **files** (not the run)

For agent/command/MCP/skill CRUD, OpenChamber writes `~/.config/opencode/opencode.json`, `<project>/.opencode/opencode.json`, agent/command/skill directories (`~/.config/opencode/agent/…` etc. per `shared.js` constants) and answers `{requiresReload:false, requiresRestart:true, restartDeferred:true}` (deferred apply) or `{requiresManualRestart:true}` when the harness is external. `POST /api/config/reload` applies: managed ⇒ restart harness (LF-1 with `waitForAgentPresence` optionally); external ⇒ `requiresManualRestart: true` (the operator must restart it manually). Full route table: doc 03.

---

## 9. Harness port catalog

Section structure: each port is a nameable seam the replacement harness must satisfy. "Provider" = what satisfies it in OpenChamber today. Ports without a P-id are OpenChamber-internal and belong to doc 03.

### 9.1 Core ports

| Port | Consumer | Contract | Current provider (OpenCode call/route/event) | Replacement notes |
| --- | --- | --- | --- | --- |
| **P-01 Process lifecycle** | OpenChamber lifecycle runtime | Start as `serve --hostname H --port P`; print `opencode server listening on <URL>` on stdout; exit on SIGTERM/`SIGKILL`; support `POST /global/upgrade {target}`; expose `GET /global/health` → `{healthy:true, version}` | `lifecycle.js` LF-1…LF-6 | Keep the stdout line or adapt the parser; keep self-upgrade or return `success:false` (server then reports unsupported); password via `OPENCODE_SERVER_PASSWORD` |
| **P-02 HTTP proxy surface** | OpenChamber proxy | Serve the REST surface in rows 1-39 (§3.4) on its root, plus tolerate `x-opencode-directory` header (percent-encoded OK), `?directory=` query, and `Last-Event-ID` on SSE | `proxy.js` | Header/query conventions and sanitization must match so directory scoping and list hygiene stay correct |
| **P-03 Basic-auth credential** | proxy + all server fetches | Accept `Authorization: Basic base64(<username>:<password>)`; honor env password | `auth-state-runtime.js` | Empty password ⇒ no auth header; keep behavior |
| **P-04 Session CRUD** | UI stores, control service | `GET/POST /session`, `GET/PATCH/DELETE /session/{id}`, `POST /session/{id}/fork\|abort`, `GET /session/{id}/children`, `GET /session/status`, message/part granular ops (§3.4 rows 40-46: single message get/delete, part patch/delete, share/unshare, init) | §4 S-06..S-10 | `GET /session/status` omission semantics + `Session[]` sanitation contract are load-bearing |
| **P-05 Turn execution** | browser send + control service + scheduled tasks | `POST /session/{id}/prompt_async` (204) accepting `{model, agent?, variant?, messageID?, delivery?, format?, parts[]}`; `POST /session/{id}/command`; `POST /session/{id}/shell`; `POST /session/{id}/message` streaming (optional); `POST /session/{id}/init`; `GET /session/{id}/message` | §4 S-06, browser rows 10-13 | prompt delivery via events only; `waitForPromptLanded` depends on a `session.created`-echo of user messages with `time.created`; synthetic parts must be accepted and re-emitted as `synthetic: true` |
| **P-06 Event stream (SSE)** | global hub, dir WS bridge, SSE forwarder | `GET /global/event` (envelope §5.1), `GET /event?directory=…`, `id:` lines for resume, replay from `Last-Event-ID` | §5 | Keep ids stable across close/reconnect; keep the `{directory,payload:{id,type,properties}}` envelope |
| **P-07 Session status authority** | session runtime, UI stores | `session.status` events (idle/busy/retry with attempt/message/next/action) + `GET /session/status` snapshot; omission ⇒ idle; `session.idle` event also emitted on empty turn end | §5.2, §6.5 | Status transitions must be event-broadcast even during long-running turns |
| **P-08 Permission authority (v1+v2)** | permission UI, server auto-accept, client auto-accept | v1 `GET /permission`, `POST /permission/{requestID}/reply`; v2 `GET/POST/PUT /api/session/{sessionID}/permission...`; events `permission.asked/replied`, `permission.v2.asked/replied` | §6.6, §8.5 | 404-settled convention, `always` persistence rules, `save` semantics |
| **P-09 Question flow** | ask-tool UI | `GET /question`, `POST /question/{requestID}/reply {answers: string[][]}`, `POST /question/{requestID}/reject`; events `question.asked/replied/rejected` (+v2 twins) | §6.7 | `header ≤30 chars`, `label 1-5 words` conventions |
| **P-10 Config API** | UI settings, providers UI | `GET /config`, `PATCH /config` (global), `GET /config/providers` | §3.4 rows 27-29 | PATCH must merge/replace per OpenChamber's GMW pattern; config cache invalidation hooks |
| **P-11 Provider + credentials** | provider auth UI, small model, quota adjacent | `GET /provider`, `GET /provider/auth`, OAuth authorize/callback, `PUT/DELETE /auth/{providerID}`, `auth.json` file at `~/.local/share/opencode/auth.json` | §7.3 | Keep the file path or shim the small-model auth resolver; plugin-runtime credential snapshot is optional but improves pickers |
| **P-12 Agents / commands / skills / tools** | agents store, command palette, tool pickers | `GET /agent`, `GET /command`, `GET /skill`, `GET /experimental/tool`, `GET /experimental/tool/ids` | §3.4 | `/agent` empty-vs-error distinction (UI fallback tries the raw route next) |
| **P-13 Project/file system layer** | directory pickers, file editor | `GET /path`, `GET /project/current`, `POST /project/git/init`, `PATCH /project/{id}`, `GET /project/{id}/directories`, `GET /file`, `GET /file/content`, `GET /file/status`, `GET /find`, `GET /find/file`, `GET /find/symbol` | §3.4 rows 1-2, 32 | The web UI prefers OpenChamber's own `/api/fs/*` for local files; `/file*`+`/find*` back the chat renderers' file reads and symbol search |
| **P-14 MCP** | MCP settings | `GET /mcp`, `POST /mcp`, connect/disconnect, OAuth incl. `POST /mcp/{name}/auth/authenticate` (15-min budget), statuses; events `mcp.tools.changed` | §6.9 | `needs_client_registration`/`needs_auth` statuses must be preserved |
| **P-15 VCS surface** | project panel | `GET /vcs`, `GET /vcs/status`, `GET /vcs/diff?mode=&context=`, `GET /vcs/diff/raw`, `POST /vcs/apply {patch}`; events `vcs.branch.updated` | §6.9 | Web UI primarily uses OpenChamber git API; harness vcs.* is for snapshot/summary within session views |
| **P-16 PTY (optional)** | SDK parity only | `GET/POST /pty`, `/pty/{id}`, connect WS, `pty.*` events | §3.4 row 38 | OpenChamber's terminal uses its own `/api/terminal` runtime — harness PTY is not consumed by the web UI |
| **P-17 Global ops** | upgrade UI, diagnostics | `GET /global/health`, `POST /global/upgrade`, `POST /global/dispose`, `GET/PATCH /global/config`, `server.instance.disposed` event | LF-5 | `/global/config` is the authoritative global write; PATCH shape = `{config}` |
| **P-18 Plugin/tool injection surface** | agent-tool runtime, system-prompt runtime | Config `plugin` array (string or [name,options] tuples), plugin module exporting tool hooks with `execute(input, context{directory, abort, metadata})` and lifecycle hooks `chat.message`, `event`, `experimental.chat.system.transform` | §8.1, §8.4, `managed-plugin-config.js` | If the replacement has no plugin system, implement the two injections natively behind the same flags and keep the schema/envelope (§9.2) |
| **P-19 Prompt content-injection points** | openchamber sessions/scheduled/goal | Synthetic `text` parts (knowledge, goal intro) with `synthetic: true` accepted in `parts[]` | §8.2-8.3 | Parts must flow through to the message and be visible to the renderer as synthetic |
| **P-20 Directory identity scoping** | everything | `directory` query/header everywhere; lazy per-directory init acceptable; realpath collisions resolved server-side | §3.2 | Windows path normalization (case-insensitive drive, backslash) must work end-to-end |
| **P-21 `x-opencode-session` semantics** | small-model direct calls | OpenCode-hosted providers accept session id header for provider-side rate accounting | §7.4 | Optional; drop only if the replacement wins nothing from provider-side session tagging |
| **P-22 Managed-process port freedom** | lifecycle | Harness may land on ANY free port per launch (env-fixated port must still be honored) and may print an https URL | LF-1, LF-4 | Port must be re-readable from stdout; restart rebinding depends on it |
| **P-23 Durable channel (optional)** | none today (reserved parity) | `POST /sync/history|start|replay|steal`, v2 `GET /api/session/{id}/event` SSE with `durable{aggregateID,seq,version}` fields | §5.2.0 | Unconsumed by OpenChamber — implement only if you want forward parity |
| **P-24 Session extras (low-frequency)** | share UI, inline edit | `POST/DELETE /session/{id}/share`, `PATCH/DELETE /session/{id}/message/{mid}/part/{pid}`, `GET /session/{id}/diff` | §3.4 rows 40-47 | Shapes small but exact; keep absent-territory warnings accurate |

### 9.2 Host-agnostic injection checklist

If the target harness lacks OpenCode's exact plugin hooks, the replacement kit must still provide, behind the same settings flags, at minimum:

1. A way to register custom tools with (name, description, JSON-schema args) whose execute context receives a **directory** and an abort signal (P-18).
2. A system-prompt transform hook keyed by agent (`build`/`plan` only) with a single string replacement behavior (P-18) — or ship none and document the feature as unsupported.
3. Acceptance of synthetic parts in prompts (P-19).

### 9.3 Ports deliberately NOT harness ports (OpenChamber-owned; doc 03)

`/api/fs/*` (list/read/write/search/stat/raw/clone/home/directory-stat), `/api/git/*`, `/api/settings` (`/api/config/settings`), `/api/quota/*`, `/api/tts/*`, `/api/terminal`, `/api/notifications/*`, `/api/openchamber/*` (sessions service, agent-tool route, browser control), `/api/small-model/*`, `/api/auth/*` (ui session/url-token/passkeys/pairing), tunnels/relay. *Git is OpenChamber server-side by design — never offload to the harness.*

### 9.4 Transport frame vocabulary (exact bytes should be reimplemented faithfully)

HTTP compression exclusions (SSE paths are never compressed; `src: packages/web/server/index.js:168`): `/api/event`, `/api/global/event`, `/api/notifications/stream`, `/api/openchamber/events`, `/api/openchamber/realtime-proxy/sse`; also anything under `OPENCHAMBER_RUNTIME=desktop` or `Accept: text/event-stream`. (`OPENCHAMBER_SKIP_API_COMPRESSION`, `OPENCHAMBER_COMPRESS_API` env flags override API compression.)

WS frames (global + directory bridges):

| frame | shape | meaning |
| --- | --- | --- |
| event | `{"type":"event","payload":<inner event>,"eventId"?:string,"directory"?:string}` | harness event (inner `GlobalEvent.payload`) or synthetic `openchamber:*` |
| ready | bridge-defined envelope (`{"type":"ready", ...}` incl. `replayReset?: true`) | upstream attached; possible replay |
| heartbeat | `{"type":"openchamber:heartbeat",...}`-shaped event frame | emitted only while upstream attached |
| backpressure | `{"type":"backpressure","bufferedBytes":n,"maxBytes":n}` | one-shot warning at 12 MiB; hard close 1013 at 16 MiB |

SSE frames (passthrough + control streams): `id:` line (replay cursor), `data:` JSON lines joined with `\n`, blank line terminates; server heartbeat token `:heartbeat\n\n` (20 s); response headers forced `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`, `setNoDelay(true)`.

Desktop realtime proxy (`src: packages/web/server/lib/realtime-proxy.js`): `GET /api/openchamber/realtime-proxy/sse` and `/ws?url=<target>` — only reachable when runtime headers exist, target must match the runtime base origin and one of the allowed paths (`/api/event`, `/api/global/event`, `/api/openchamber/events`, `/api/notifications/stream` for SSE; `/api/event/ws`, `/api/global/event/ws`, `/api/terminal/ws` for WS); `authorization` never forwarded from config headers. This exists because EventSource/WebSocket cannot carry custom auth headers — the replacement must provide an equivalent escape hatch.

---

## 10. Managed vs external harness mode matrix

| Capability | Managed (OpenChamber spawns) | External (`OPENCODE_HOST` / skip-start / auto-detach detection) | Why |
| --- | --- | --- | --- |
| Automatic start / restart on failure | yes (LF-1/LF-4, health thresholds) | no (operator owns the process; restart only re-probes) | child ownership |
| Password (`OPENCODE_SERVER_PASSWORD`) | generated/rotated per spawn; user-provided env value honored | none injected; server uses env value if present on probe requests | injection point is the child env |
| Tool injection (`openchamber`, `openchamber_web`, `openchamber_memory`) | injected when flags on | **never** (no env control) | env ownership; setting silently no-ops |
| System-prompt optimizer plugin | injected when `optimizeSystemPrompt` | never | same |
| `OPENCODE_CONFIG_CONTENT` plugin merge | yes | n/a (inline config is the child env's) | — |
| Provider env aliases, ARGV0 strip, managed PATH | yes | n/a | — |
| Config-entity writes (agents/commands/MCP/skills) | deferred apply + `POST /api/config/reload` → restart | written to disk; `requiresManualRestart: true` | external process caches config at start |
| `POST /api/opencode/upgrade` | supported only for a managed non-bundled binary (capability gates; bundled/external/unresolved ⇒ 409) | 409 unsupported | upgrade delegation must be lifecycle-owned |
| Warmup of directories | yes after readiness | skipped (no readiness ceremony on attach beyond the health probe) | lazy-init cost is worth paying once; external servers manage themselves |
| Directory-related gates (worktree bootstrap) | identical in both modes | identical | gate is data-side, not lifecycle-side |
| Event streaming, sessions, permissions, small model | identical | identical | read paths are mode-agnostic (same routes, same auth behavior) |
| `interruptBusySessionsAfterRestart` | runs after every restart | never triggered (no restarts) | — |
| Health monitor | 15 s cadence, restart thresholds, busy-session skip | off | nothing to heal |
| Orphan reaping + managed registry | yes | no registry | — |

---

## 11. Correctness invariants at the harness boundary

These are the rules the OpenChamber codebase defends in code and tests; the replacement must defend the same ones.

1. **Authoritative over heuristic.** `GET /session/status` is authoritative; a successful snapshot makes absence=idle. Event-derived status is a cache that a snapshot can overrule. Never let a heuristic (activity timers) override an authoritative idle/busy.
2. **Never mask fetch failure as empty success.** `listAgents`, `listPendingPermissions`, `listPendingQuestions`, `fetchProviders` throw on failure; `getSessionStatusForDirectory` returns `null` on failure vs `{}` on success; `getWebServerSessionActivity` returns null; small-model runtime providers answer `null` (not `[]`) when the harness is unreachable; `getDirectoryAvailability` distinguishes `missing` from `unknown`. Implement the same distinction for every new port.
3. **External-mode restriction: injection only for managed servers.** No tool/system-prompt injection, no password rotation, no upgrades, no automatic restarts for an external harness (§10). The pattern generalizes: anything that mutates the harness's running state requires owning the process.
4. **`promptDispatched` is observed, not accepted.** A 204 from `prompt_async` never counts as dispatch; confirm by a new user message appearing (`waitForPromptLanded` 5 s); report `promptDispatched:false` + `promptError` instead of a phantom success. A failed lookup is not evidence of loss (never fail the confirmation because it couldn't be checked).
5. **Wait semantics.** Control-service waits never treat an initial idle response as completion; they require observed activity (busy/retry) or a newly completed assistant message after the baseline id; timeout and cancellation are failures, never synthesized idles.
6. **Validation before side effects.** Explicit model/agent/variant are validated against the *directory's own* agent/provider lists **before** any session/worktree/goal is created (a rejected selection must leave no orphan artifacts); an empty lookup result never turns a valid selection into a rejection (fail-open on lookup, fail-closed on confirmed mismatch).
7. **Partial results and one-failed-entity rules.** Archive batches return `failedIds` while the rest still archive; wait-window partial result data `{partial, partialAction, sessionId, directory}`; one directory's failed status lookup produces `unknown` for only that directory. One failure never erases siblings.
8. **Transport failure ≠ server refusal.** A missing HTTP response from a send is a transport failure; tagging "dispatched, outcome unknown" (ambiguous transport failure) prevents re-sends of a running prompt. Never fabricate a status for a lost response (never invent `500` from a network exception).
9. **Destructive capability is scoped.** Session/worktree deletion and project-path registration are excluded from the agent tool contract (`openchamber` tool) even though the server can do them; the browser does them through OpenChamber routes.
10. **Loopback-only privileged callbacks.** The managed-tool route accepts loopback addresses only + per-child bearer token (timing-safe); tokens are never persisted, logged, or returned to the UI; no arbitrary CLI/shell/route forwarding from tools.
11. **Never log secrets.** Launch/health diagnostics sanitize bearer tokens, URLs with basic-auth, `token=…`-shaped params; stderr tails are bounded (32 KiB) and sanitized; health failure detail ≤256 chars. The same discipline applies to anything the replacement adds.
12. **Heartbeats are diagnostics, not state.** Downstream heartbeats exist to keep intermediaries alive; absence of upstream data still closes downstream (stall watchdog) so clients reconnect and resync from authoritative sources rather than trusting synthetic quiet.
13. **Replay boundedness.** The global hub replays ≤2048 events / 8 MiB; oversized live events clear the retained suffix instead of creating cross-gap replay; unknown cursor ⇒ `replayReset` and authoritative repair, never partial-truth replay.
14. **Session/message ordering.** Sorting uses `time.created` seeds on both tiers (UI render, server extract). Message ids are monotonic per client clock (`ascendingId`), which the harness echoes verbatim (`messageID` passthrough) — replacements must accept caller-supplied message ids and echo them in events, or SSE reconciliation rewrites the optimistic message.
15. **V1/V2 permission authorities are separate maps.** A v1-list-derived pending item must not be gated by a v2 state check (404 ≠ resolved across authorities) — #3259. Any replacement must either implement one authority perfectly or keep the dual-map distinction honest.
16. **Files are verified before trust.** Config file parses distinguish layer errors (`INVALID_JSONC`), never rewrite a broken file, and lock writes against occupied broken layers; auth.json writes take backups. (Shared.js / auth.js conventions.)
17. **Busy sessions gate destructive lifecycle.** Health-triggered restarts skip while sessions are busy (unless stale-busy >2 min) so a load-induced timeout cannot kill a live turn.

---

## 12. Build checklist

### 12.1 Minimally compatible harness (the chat loop works)

1. HTTP server with Basic auth honoring `OPENCODE_SERVER_PASSWORD` + `OPENCODE_SERVER_USERNAME` (P-03).
2. `opencode serve …`-equivalent launch contract incl. the stdout listening line (`http[s]://host:port`) OR an alternate contract the OpenChamber fork points at one place (P-01/P-22).
3. `GET /global/health` → `{healthy:true, version}` (P-01).
4. Sessions: list/create/get/patch/delete/fork/abort/status (P-04) with exact `Session` fields (§6.1).
5. Messages: `GET /session/{id}/message` ordered `[{info, parts}]`, `prompt_async` (204) + `command` + `shell` (P-05).
6. Event stream: `GET /global/event` + `GET /event?directory` with the §5.1 envelope, `id:` lines, `Last-Event-ID` replay (P-06).
7. Events: at minimum `session.created/updated/deleted`, `message.updated/removed`, `message.part.updated/delta/removed`, `session.status`, `session.idle`, `permission.asked/replied`, `question.asked/replied/rejected`, `todo.updated`, `session.error`, `file.edited` (P-06/P-07).
8. `GET /session/status` snapshot with omission=idle semantics (P-07).
9. Permissions v1 (list/reply) and questions v1 (list/reply/reject) with event parity (P-08/P-09).
10. Config: `GET /config`, `PATCH /config` (global), `GET /config/providers` (P-10).
11. `GET /path`, `GET /project/current` (P-13).
12. Providers listing + `PUT/DELETE /auth/{providerID}` for the settings write paths (P-11).
13. Directory scoping everywhere via `?directory=` and `x-opencode-directory` (P-20).

### 12.2 Fully featured harness (everything in doc 02 behaves)

Everything in 12.1 plus:

14. v2 permission surface under `/api/session/...` with `PermissionV2Request/replied` events and the create/get/reply endpoints (P-08).
15. Agents/commands/skills/tools endpoints (P-12) incl. `GET /experimental/tool/ids`.
16. `format: {type:"json_schema"}` support in prompts and `structured` on assistant messages; `assistant.error` union with exact `name` strings (§6.2).
17. Full part state machine incl. tool `metadata` deltas via `message.part.delta` (P-05/§6.3); `reasoning` parts; `compaction`/`patch`/`retry` parts.
18. Model variants and `default` model map; `small_model` config honored, chain-resolution parity for the small-model module (P-10/P-11/§7.4).
19. Provider OAuth (`oauth/authorize` + `callback`, incl. 15-min blocking callbacks) and `GET /provider/auth` prompts (P-11).
20. MCP lifecycle + statuses incl. needs_auth/needs_client_registration (P-14); `mcp.tools.changed`.
21. File/find surfaces (`/file`, `/find`, `/find/file`, `/find/symbol`) for chat renderers (P-13); vcs.* endpoints for session-level summaries (P-15).
22. Plugin hooks: config `plugin` array, tool registration with directory/abort context, `chat.message`/`event`/`experimental.chat.system.transform` hooks (P-18) — or a native replacement behind the same settings flags (§9.2).
23. Synthetic text parts in `prompt_async.parts[]` (knowledge injection, goal intro) (P-19).
24. `x-opencode-session` provider tagging for OpenCode-hosted providers (P-21) if those are kept.
25. `POST /global/upgrade` with target, honoring capability gating; `server.instance.disposed` event; `PATCH /global/config`.
26. `workspace.*`/`worktree.*` events and (optionally) the SDK worktree endpoints (P-16/P-17 parity).
27. Full event vocabulary of §5.2 (including `tui.*`, `pty.*`, `lsp.updated`, `reference.updated`, `installation.*`, `catalog.updated`, `models-dev.refreshed`) — emit them as no-ops where inapplicable rather than dropping names, since doc 04's reducer dispatches by type.
28. Busy-status events during long tool calls, and `next` timestamps on retries honored by the UI countdowns (P-07).

### 12.3 Test hinge points (cannot be faked)

- Kill the harness between a `prompt_async` 204 and its message echo: the control service must report `promptDispatched:false` (LF-13/§11.4).
- Rotate ports across a restart and ensure UI live-stream never loses its reader (rebind, §2.5).
- Present a v1 permission while v2 says 404: reply must still land (§11.15).
- Saturate one provider with 3×429: sends pause for 30 s with a clear error (§3.3).
- Feed a directory equal to a symlink: cached realpath canonicalization upstream (§3.2).
- Abort a turn mid-tool (`POST /session/{id}/abort` while a part is `running`): the part must land in `error` state (or the tool flow reporting an abort), never freeze as `running` after an idle `session.status`.
- Disconnect and reconnect during a question card: resync must restore the pending question from `GET /question` with the same `id`, and `custom` free-text answers must survive a `string[][]` round-trip.
- Archive 5 sessions in one `POST /api/openchamber/sessions/archive` where the 3rd fails: 4 archive, 1 appears in `failedIds`, and a later `GET /session` reflects exactly that (§11 item 7).

### 12.4 Harness-side failure-mode catalog (QA matrix for the replacement)

| Harness failure | Required behavior | Invariant |
| --- | --- | --- |
| Dies mid-turn | OpenChamber restart synthesizes idle + `MessageAbortedError`; no client-side hang | §11.1/17, LF-19, Appendix C |
| Never opens the event stream | Bootstrap proceeds degraded; `/api/session/status` snapshots still settle state; UI shows stream status, never stalls silently | §11.2 |
| Returns 200 with an empty list on a broken provider fetch | NOT accepted as truth — UI throws and retries (listAgents contract) | §11.2 |
| Doesn't echo caller `messageID` | Optimistic send never reconciles — treat as contract violation | §11.14 |
| Persists visibility of `synthetic:true` parts as separate user prompts | Reducer treats them as context; do not count them into titles/last-user selection | §8.2 |
| Emits `session.status busy` then idles without `session.idle` | Fine: status event alone is authoritative; `session.idle` is an extra signal, not the only one (LF-8) | §6.5 |
| Blocks a directory's first request for 30 s | Acceptable once (lazy init); recurring slowness shows as hold-throughs — warmup exists to absorb it (§3.5) | P-20 |

---

## Appendix D — Minimal SDK facade (what a replacement kit must export so the shared UI runs unmodified)

If the target team ports the shared UI verbatim, the kit must provide a module equivalent to `@opencode-ai/sdk/v2` with this surface (per §3.4; constructor semantics per §3.5a):

1. `createOpencodeClient(config: {baseUrl, fetch?, headers?, directory?, experimental_workspaceID?})` → client; directory handling must implement §3.5a (header on all methods, GET/HEAD rewrite to `?directory=`/`location[directory]=`).
2. Namespaces with the exact method names and parameter names used in §3.4:
   - `path.get`, `project.current`, `project.list`, `project.update`, `project.initGit`, `project.directories`
   - `session.{list,create,get,delete,update,children,todo,diff,messages,prompt,message,deleteMessage,fork,abort,init,share,unshare,summarize,promptAsync,command,shell,revert,unrevert,status}`
   - `permission.{list,reply}`, `v2.session.permission.{list,create,get,reply}`, `question.{list,reply,reject}`, `v2.question.request.list`, `v2.permission.request.list`, `v2.permission.saved.{list,remove}`
   - `config.{get,update,providers}`, `global.{health,event,config.get,config.update,dispose,upgrade}`
   - `app.{agents,skills,log}`, `command.list`, `skill.list`, `tool.{list,ids}` (v1) plus the v2 twins `v2.command.list`, `v2.skill.list`, `v2.fs.{read,list,find}`, `v2.reference.list`
   - `find.{text,files,symbols}`, `file.{list,read,status}`, `instance.dispose`, `vcs.{get,status,diff,diff2,apply}`
   - `provider.{list,auth,oauth.{authorize,callback}}`, `mcp.{status,add,connect,disconnect,auth.*}`
   - `agent.list`, `model.list` (v2), `navigator.*` n/a
   - Result type: `{data?, error?, response?: {status?}}` with **no throw on non-2xx by default** (a throw-on-error opt-in like `{throwOnError:true}` used by `abortSession` is reproduced by the UI's options argument).
   - SSE: `global.event()` and `event.subscribe()` return a `ServerSentEventsResult` (async-iterable of parsed GlobalEvent) — used only where the WS bridge is not the transport.
3. Types exported at minimum: `Session, Message (UserMessage|AssistantMessage), Part (12-member union incl. inputs), Todo, SessionStatus, PermissionRequest, PermissionV2Request/Effect/Source, QuestionRequest/Info/Option, Provider, Model, Config, Agent, Command, Path, Project, McpStatus, LspStatus, VcsInfo, SnapshotFileDiff, Worktree, McpLocalConfig/McpRemoteConfig, ProviderAuthMethod/Authorization, AgentPartInput, TextPartInput, FilePartInput` — and the ~60 `GlobalEvent` payload members of §5.2 (doc 04 imports them by name).
4. If the replacement keeps different URLs, the adapter must translate at the fetch layer INSIDE this facade — never by rewriting UI call sites. The facade must reproduce the error/typing behavior (no fabricated statuses) because UI logic (unwrapSdkData, ambiguous-failure tagging) keys off it (§11.2, §11.8).

A facade thinner than this drops UI features silently (each namespace maps to visible behavior in doc 05); a thicker one is harmless. When in doubt, keep the name and return the documented `error` payload.

---

## Appendix E — Reverse checklist: deleting OpenCode entirely

Work down this list when removing the OpenCode dependency instead of porting it:

1. Managed spawn → replace with the replacement process contract (P-01, P-22); keep the stdout line parsing in ONE module.
2. `OPENCODE_*` env names are baked into install scripts, VS Code extension, desktop shell, tests, and doc copy across the suite — rename centrally or keep the names.
3. The config file layout (`~/.config/opencode/opencode.json`, project `.opencode/opencode.json`, agent/command/skill directories) is written by OpenChamber's own file CRUD — either keep the layout or teach the settings/agents/MCP/skills stores both layouts (doc 03).
4. `auth.json` moves with P-11; the small-model module is the only OpenChamber consumer that parses its shapes.
5. The `openchamber server listening` line, `opencode serve` argv shape, and `GET /global/health`'s `{healthy, version}` are the three facts the lifecycle cannot survive losing (P-01).
6. Doc 04's reducer must re-run against §5's table when any event type is dropped — that is the only client-side contract that hard-fails at runtime rather than degrading.

## 13. Cross-references

- **Doc 03 (`03-server-and-api-reference.md`)** owns the full OpenChamber route table (fs, git, settings, quota, tts, notifications, terminal, openchamber sessions/control, auth/passkeys, tunnels) — this doc covers only routes that proxy or enrich OpenCode per §3.2/§9.3.
- **Doc 04 (`04-sync-and-state-engine.md`)** owns client-side event reduction, bootstrap/resync, optimistic sends & queues, and how the §5 event tables become stores; any change to event names/shapes requires updating both.
- **Doc 12 (goals/multirun/scheduled orchestration)** consumes the control-service session-create/send/fork contracts (§8.1, LF-13) and goal parts (§8.3); it defines the orchestration layers above this harness line.
- Sibling docs for browser-control, session-assist, agent memory, linear integrations, desktop shell (Electron), mobile: their harness usage is limited to the §4 call rows; their domain logic is out of scope here.

Source index (for grep-ability; do not re-derive): `packages/ui/src/lib/opencode/client.ts`, `packages/ui/src/lib/runtime-fetch.ts`, `packages/ui/src/lib/runtime-url.ts`, `packages/ui/src/lib/runtime-auth.ts`, `packages/ui/src/lib/runtime-switch.ts`, `packages/ui/src/lib/opencode/provider-tracker.ts`, `packages/ui/src/lib/opencode/deferredRestart.ts`, `packages/ui/src/lib/smallModel.ts`, `packages/ui/src/lib/smallModelRequest.ts`, `packages/ui/src/lib/openCodeStatus.ts`, `packages/ui/src/sync/types.ts`, `packages/ui/src/sync/vscode-permission-auto-accept.ts`, `packages/web/server/index.js`, `packages/web/server/proxy-headers.js`, `packages/web/server/lib/realtime-proxy.js`, `packages/web/server/lib/opencode/{lifecycle,env-config,auth-state-runtime,network-runtime,proxy,routes,session-runtime,watcher,server-utils-runtime,managed-plugin-config}.js`, `packages/web/server/lib/event-stream/{protocol,upstream-reader,global-hub}.js`, `packages/web/server/lib/agent-tool/runtime.js`, `packages/web/server/lib/openchamber-control/{actions,service}.js`, `packages/web/server/lib/openchamber-sessions/routes.js`, `packages/web/server/lib/permission-auto-accept/runtime.js`, `packages/web/server/lib/system-prompt/runtime.js`, `packages/web/server/lib/small-model/{index,routes}.js`, `packages/web/server/lib/inherited-env.js`, `node_modules cache @opencode-ai/sdk@1.18.30 dist/v2/gen/{types,sdk}.gen.d.ts`.

---

## Appendix A — Browser path → harness path mapping

The proxy rewrite is uniform: OpenChamber strips the first `/api` of anything it does not own. Worked examples (browser request as the SDK builds it, then the harness receives):

| Browser (SDK on base `/api`) | OpenChamber route? | Harness receives |
| --- | --- | --- |
| `GET /api/session?directory=D:/repo` | no (proxy) | `GET /session?directory=D:/repo` (list sanitized by OpenChamber first) |
| `POST /api/session` | no (proxy) | `POST /session?directory=…` |
| `POST /api/session/ses_x/prompt_async` | no (proxy) | `POST /session/ses_x/prompt_async` (4-min deadline) |
| `POST /api/session/ses_x/abort` | no (proxy) | `POST /session/ses_x/abort` — with readiness hold for `/session/...` routes while restarting |
| `GET /api/session/status?directory=D:/repo` | no (proxy) | `GET /session/status?directory=…` |
| `GET /api/permission?directory=` | no (proxy) | `GET /permission?directory=` |
| `POST /api/permission/perm_1/reply` | no (proxy) | `POST /permission/perm_1/reply` |
| `GET /api/question` | no (proxy) | `GET /question` |
| `POST /api/question/qq_1/reply` | no (proxy) | `POST /question/qq_1/reply` |
| `GET /api/config?directory=` | no (proxy) | `GET /config?directory=` |
| `PATCH /api/config` | no (proxy) | `PATCH /config` `{config}` (global) |
| `GET /api/config/providers` | no (proxy) | `GET /config/providers` |
| `GET /api/agent?directory=` | no (proxy) + UI fallback hits OpenChamber's identical passthrough URL | `GET /agent?directory=` |
| `GET /api/command?directory=` | no (proxy) | `GET /command?directory=` |
| `GET /api/experimental/tool/ids` | no (proxy) | `GET /experimental/tool/ids` |
| `GET /api/find/file?query=…&dirs=false&type=file` | no (proxy) | `GET /find/file?...` (relative paths back) |
| `GET /api/path?directory=` | no (proxy) | `GET /path?directory=` |
| `GET /api/project/current?directory=` | no (proxy) | `GET /project/current?directory=` |
| `GET /api/provider` / `GET /api/provider/auth` | no (proxy) | `GET /provider` / `GET /provider/auth` |
| `POST /api/provider/anxious/oauth/authorize` | no (proxy) | `POST /provider/{id}/oauth/authorize` (ordinary deadline) |
| `POST /api/provider/anxious/oauth/callback` | **interactive-deadline wrapper** (15 min) | `POST /provider/{id}/oauth/callback` |
| `POST /api/mcp/myserver/auth/authenticate` | **interactive-deadline wrapper** (15 min) | `POST /mcp/myserver/auth/authenticate` |
| `GET /api/global/event` | SSE forwarder (raw passthrough + heartbeats) | `GET /global/event` |
| `GET /api/global/event/ws` | WS bridge (OpenChamber protocol §9.4; OpenChamber owns the WS dialect) | upstream `GET /global/event` via the shared hub |
| `GET /api/event/ws?directory=` | WS bridge (one upstream reader per connection) | `GET /event?directory=…` |
| `GET /api/api/session/ses_x/permission` (v2 SDK call `client.v2…`) | no (proxy; double prefix collapses to one) | `GET /api/session/ses_x/permission` (**v2 surface lives under `/api` on the harness origin**) |
| `POST /api/api/session/ses_x/permission` | no (proxy) | `POST /api/session/ses_x/permission` |
| `GET /api/api/session/ses_x/permission/perm_1` | no (proxy; 404 ⇒ "settled") | `GET /api/session/ses_x/permission/perm_1` |
| `GET /api/opencode/health` | **OpenChamber-owned** (§4.1) | `GET /global/health` (enriched) |
| `POST /api/opencode/directory` | **OpenChamber-owned** (§4.1) | validation/maybe-restart |
| `GET /api/fs/*`, `/api/git/*`, `/api/config/settings`, `/api/quota/*`, `/api/small-model/*`, `/api/auth/*`, `/api/notifications/*`, `/api/terminal/*`, `/api/openchamber/*`, `/api/openchamber/sessions*`, `/api/browser-control/*` | **OpenChamber-owned** (never proxied) | — |

Failure translation at the proxy: timeout ⇒ `504 {"error":"OpenCode upstream timed out"}`; middleware/connect failure ⇒ `503 {"error":"OpenCode service unavailable"}`; readiness timeout ⇒ `503 {"error":"OpenCode is restarting","restarting":true}`; worktree gate fail/timeout ⇒ `503 {"error": <reason|>"Timed out waiting for worktree checkout"}`. Everything else (harness status codes/bodies) passes through unchanged except filtered headers.

---

## Appendix B — Managed child environment: exact merge order (LF-1 step 8-10)

The spawn call merges four sources into one env object; later wins, then two lifecycle-owned keys are re-imposed:

```
merge(  getManagedOpenCodeShellEnvSnapshot()      // login-shell PATH/keys snapshot (env-runtime)
      , process.env                               // the OpenChamber server process env
      , managedOpenCodeEnv                        // agent-tool + system-prompt overlays
      )
then overlay:
  PATH                     = buildManagedOpenCodePath()   // login-shell PATH ∪ process PATH ∪ Windows toolchain dirs
  OPENCODE_SERVER_PASSWORD = ensureLocalOpenCodeServerPassword({rotateManaged:true})
then strip: ARGV0 (AppImage), fill provider aliases (GEMINI_API_KEY → GOOGLE_GENERATIVE_AI_API_KEY / GOOGLE_API_KEY, never overwriting non-empty)
```

`managedOpenCodeEnv` contents per launch (only current-generation hooks; user plugins in config files are untouched):

| Key | Set by | Value |
| --- | --- | --- |
| `OPENCODE_CONFIG_CONTENT` | agent-tool runtime, then system-prompt runtime (chaining: the second sees the first's output) | merged inline config JSON with each plugin appended to `plugin` |
| `OPENCHAMBER_AGENT_TOOL_URL` | agent-tool runtime | `http://127.0.0.1:<openchamber-port>/api/openchamber/agent-tool` |
| `OPENCHAMBER_AGENT_TOOL_TOKEN` | agent-tool runtime | fresh 32-byte base64url per child; loopback + timing-safe bearer only |

Worked `OPENCODE_CONFIG_CONTENT` append (`appendManagedPlugin`):

```
user-provided (JSONC allowed):  { "model": "anthropic/claude-sonnet-4", "plugin": ["file:///usr/lib/mine.js",] }
after agent-tool injection:     {"model":"anthropic/claude-sonnet-4","plugin":["file:///usr/lib/mine.js","file://<dataDir>/agent-tool/openchamber-plugin.js"]}
after system-prompt (chained):  {"model":"anthropic/claude-sonnet-4","plugin":["file:///usr/lib/mine.js","file://<dataDir>/agent-tool/openchamber-plugin.js","file://<dataDir>/system-prompt/openchamber-system-prompt-plugin.js"]}
```

Failure modes that refuse to spawn (fail loudly, never silently drop the injection): `OPENCODE_CONFIG_CONTENT` set but not a JSON object; `plugin` present but not an array; at least one tool must be enabled to materialize the agent-tool plugin; the OpenChamber listener port must be known (a `port: 0` bind is resolved before spawn so the callback URL is authoritative). Duplicate `file://` entries for the same URL are dropped instead of re-registered.

## Appendix C — Terminal-event shape for the harness restart interruption (LF-4)

What a browser client observes when an OpenChamber restart interrupts a live turn, in order:

```json
// 1. session status flips idle (synthetic, server-authored)
{"type":"openchamber:session-status","properties":{"sessionID":"ses_x","status":"idle","timestamp":1726300000000,"metadata":{"message":"Interrupted by OpenCode restart","reason":"opencode-restart"},"needsAttention":false}}
// 2. an OpenCode-shaped error event is broadcast on the global stream (NOT on the raw /api/global/event SSE — that one is pure passthrough; it rides the WS bridge / control hub)
{"id":"opencode-restart-1726300000000","type":"session.error","properties":{"sessionID":"ses_x","error":{"name":"MessageAbortedError","message":"The running turn was interrupted when OpenCode restarted."}}}
// 3. one OpenChamber UI notification (deduped by tag)
{"type":"openchamber:notification","properties":{"title":"Chat interrupted","body":"OpenCode restarted during a running response. Send a message to continue.","tag":"opencode-restart-interrupted","kind":"opencode-restart-interrupted","sessionId":"ses_x"}}
```

Note the ensemble: the synthetic event pair is OpenChamber-authored (the harness knows nothing of the restart), while `session.error` must look harness-shaped because doc 04's reducer treats it identically to a real harness abort. One shape nuance to copy exactly: the synthetic restart error carries `message` at the top of the error object, while a *real* harness abort's `MessageAbortedError` nests it under `data.message` (§5.2.1 example 6). A replacement that stops mid-turn has this same obligation in its restart path.
