# 13 — Preview, Inspection & Walkthrough (NotNativeDesktop cleanroom reference)

> **Reference status — 2026-10-01:** This document records OpenChamber behavior.
> Execute [the NND build guide](../build/PLAN.md) and its native-contract amendments.
> Reference auto-accept, managed-harness, TUI, and process-ownership details do not
> override NNA governance or the independent NNA/NND product boundary.
> Use the [document disposition audit](../build/EXECUTION/01-architecture-audit.md)
> and feature coverage guide before treating a reference requirement as executable work.


Scope: the dev-server preview surface (embedded browser), the agent browser-control
inspection protocol, user page annotation, the AI diff walkthrough, the dev-server
tunnel that makes remote previews truthful, and the celebration feedback effect.
Everything here is specified so a team with zero access to the original repository
can rebuild the mechanism on their own agent harness.

Citations `(src: …)` point at original files for traceability only; a
re-implementation carries the *behavior*, not the file names.

Companion volumes (referenced, not restated here):

| Ref | Volume |
|---|---|
| [02] | Agent harness: tool registration, tool-callback envelope, SSE plumbing |
| [03] | Global HTTP surface: route registration order, body-parser allowlists, fs grants |
| [05] | Chat/composer consumption of inspection payloads |
| [06] | Diff surfaces, plan views, git sources and comparison selectors |
| [07] | Terminal surfaces, PTY streams, preview URL extraction grammar |
| [08] | Relay/E2EE transport |
| [09] | Electron shell: IPC surface, webview task manager, lifecycle |
| [12] | Multi-run/history behaviors |
| [14] | Settings (tool toggles, walkthrough model override, injection controls) |

HARNESS PORT labels mark edges where preview/walkthrough mechanics connect to
*your* harness instead of the original one:

- `[HARNESS PORT SSM-1]` — small-model **generation** call.
- `[HARNESS PORT SSM-2]` — small-model **describe/readiness** call (no generation).
- `[HARNESS PORT AGENT-CALLBACK]` — how a finished inspection result reaches the agent session (managed tool callback route).
- `[HARNESS PORT COMPOSER]` — how user-produced payloads (annotation) reach the agent (through the chat composer, not a tool).

---

## A. Overview

### A.1 What the user can do

1. **Open a running dev server inside the app.** The panel lists what is actually listening on the host (`GET /api/dev-servers`) in its empty state, one click opens it; any http(s) address can be typed.
2. **Preview a remote dev server from the desktop app.** When the app talks to a server on another machine, a loopback URL is tunneled to a local port so the page is served from a real local origin (section H).
3. **Annotate the page.** An overlay injected *into* the previewed page: point at an element, drag a region, draw a stroke, comment, submit → structured text prompt + annotated screenshot attached to the chat composer (section D.7).
4. **Let the agent drive the page.** The `openchamber_web` tool opens, snapshots, clicks, types, scrolls, reads computed styles, walks history, resizes the viewport, and saves screenshots into the project (section D).
5. **Read a diff as a guided walkthrough.** The small/override model groups diff hunks into ordered "stops" and explains each; the panel interleaves prose with real diff hunks and marks staleness (F, G).
6. **Celebrate a successful push** with a firework overlay (I).

### A.2 Runtime feature matrix

| Capability | Web tab | Desktop | VS Code | Hosted mobile | Capacitor mobile |
|---|---|---|---|---|---|
| Real `<webview>` browser pane | No (iframe) | Yes | No | No | No |
| Browse same-machine dev server | Yes | Yes | Yes (iframe only) | Yes | Yes |
| Browse remote dev server via tunnel | No (stated, not offered) | Yes | No | No | No |
| Agent browser control (`openchamber_web`) | No — capability flag never set | Yes | No | No | No |
| User annotation overlay | No (Chromium-only) | Yes | No | No | No |
| Tunnels (local listener) | n/a | Yes | No | n/a | n/a |
| Panel opener fallback (agent creates the tab) | Yes (iframe) | Yes (webview) | No browser route | Yes | Yes |
| Walkthrough panel | Yes (tablet width and above) | Yes | No (git goes through the extension bridge) | No | No |

Derivations verified in code:

- The pane picks its transport once at mount: a Chromium `<webview>` when `window.__OPENCHAMBER_ELECTRON__` is truthy, otherwise a plain `<iframe>` (src: packages/ui/src/components/browser/BrowserPane.tsx).
- Agent-control capability belongs to the *SSE connection*, not a setting: the client appends `browser=1` to the event-stream URL only on a Chromium host; the server records `openchamberBrowserCapable` on that one connection and counts only capable clients when broadcasting. A browser tab displays a page but can never be driven (src: packages/ui/src/lib/openchamberEvents.ts, packages/web/server/index.js).
- Tunneling exists only in the desktop runtime; other runtimes pointed at a remote server *state* that instead of silently opening the wrong machine's content (src: packages/ui/src/components/browser/BrowserEmptyState.tsx).

---

## B. Dev-server detection and registration

### B.1 Principle

Discovery answers "**what is listening on this machine that I could preview**". The original explicitly rejected `package.json`-script guessing: scripts describe what *could* run, not what *is* running; socket enumeration is the truth and works no matter how the dev server was started (src: packages/web/server/lib/dev-servers/routes.js).

Discovery is **advisory with an honest failure**:

- A failed scan returns `{ ok: false, reason }`; it must never degrade to an empty list — "nothing is running" and "the scan broke" produce different UI, and clients render `unavailable` with a dedicated "discovery unavailable" line.
- Successes are cached **3000 ms** server-side (`CACHE_TTL_MS`); failures are not cached (the next attempt proceeds immediately).
- Each scan command is bounded by **2500 ms** (`SCAN_TIMEOUT_MS`).

### B.2 Scanner backends

`createDevServerScanner({ spawn, platform, readFile })`:

1. **Windows:** `netstat -ano -p TCP` → `parseNetstatListeners`.
2. **Else:** `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` → `parseLsofListeners`.
3. **Fallback (containers without `lsof`):** read `/proc/net/tcp` + `/proc/net/tcp6` → `parseProcNetTcpListeners`. Reading kernel files cannot be defeated by a missing binary or stripped PATH, and a deployed instance is exactly where discovery must work.
4. No data anywhere → `{ ok:false, reason:'netstat-unavailable' }` (Windows) or `{ ok:false, reason:'no-listener-source' }`.

Commands spawn with `windowsHide: true`, stdio `['ignore','pipe','ignore']`; on timeout the child is killed and the result is `null`.

**Shared parser semantics (re-implement exactly; pure text parsing):**

- **Loopback-or-wildcard only.** Bind host must be `127.0.0.1`, `localhost`, `[::1]`, `::1` (loopback) or `*`, `0.0.0.0`, `[::]`, `::` (wildcard). A socket bound only to a specific LAN address is excluded: `http://localhost:<port>` would not reach it.
- Ports are integers in 1..65535.
- **Dedupe by port** — the same port is often reported twice (IPv4+IPv6); the first record with a non-null `pid` wins.
- **Established-connection guard**: `lsof` `n` values containing `->` are skipped (ESTABLISHED, not LISTEN; the flag should filter them, the guard keeps a mixed invocation honest).
- **Parse shapes:** `lsof -F` is stateful — `p<pid>`/`c<command>` open a process record; following `n<address>` lines belong to it until the next `p`. Addresses: `*:5173`, `127.0.0.1:5173`, `[::1]:5173`. `netstat` rows are whitespace-split; col0 must match `/^tcp$/i`, col3 `/^LISTENING$/i`, local address col1, pid col4; `command` stays empty (no per-process name without a second call). `/proc/net/tcp[6]`: state col must be `0A` (LISTEN); local address `hexAddress:portHex` where the address (little-endian per word) must equal the wildcard (`00000000`, or 32 zeros) or loopback (`0100007F`, and `00000000000000000000000000000001` for ::1) encodings; no pid/command recovered.

Listener record `{ port, pid: number|null, command: string }`, sorted by port.

### B.3 Candidate selection (noise removal)

`selectDevServerCandidates(listeners, { ownPorts, ownPids })` drops:

- ports in `ownPorts` — pass the **app's HTTP listener port AND its harness port** (`getOwnPorts = () => [port, openCodePort]`); offering the app the user is already looking at is noise;
- listeners owned by the server's own `process.pid`;
- the ignored-port set: `22 ssh, 53 dns, 445 smb, 631 cups, 5432 postgres, 3306 mysql, 6379 redis, 27017 mongodb, 9229 node inspector`. Deliberately short — guessing too aggressively hides real dev servers.

Survivors become `{ port, pid, command, url: "http://localhost:<port>/" }`.

### B.4 HTTP endpoint

`GET /api/dev-servers` (route registered lazily inside the feature-routes runtime; [03] owns the table):

```json
{ "servers": [ { "port": 5173, "pid": 1234, "command": "node", "url": "http://localhost:5173/" } ] }
```

Failures (clients map to `unavailable`): `503 { "error": "Port discovery is unavailable", "reason": "netstat-unavailable" | "no-listener-source" }`, `500 { "error": "<message>" }`.

### B.5 Announced servers (paths a socket cannot reveal)

A socket reveals a port but **never the base path** an app is served under. Two other sources supply URLs:

1. **Project actions** (`autoOpenUrl`, [14]): after starting a command, its output is scanned for URLs (`extractProjectActionUrl`), stored via `setAnnouncedDevServers(directory, urls)` and may auto-open. Announcements are **memory-only, per directory** — a stored announcement is exactly the stale address that sends the panel to the wrong page (src: packages/ui/src/lib/browser/announcedServers.ts).
2. **Terminal output** ("Open preview" on a local address): active terminal streams are scanned; a candidate becomes a per-tab preview URL (`setTabPreviewUrl(directory, tabId, url, { locked:false, autoOpened:false })`) after an availability probe. Extraction grammar lives in [07]; scan-tail stitching and probe-generation invalidation in TerminalView `_311-350_` (src: packages/ui/src/components/views/TerminalView.tsx).

Discovery and announcements are **different responsibilities** — discovery decides which servers *exist*; announcements supply URLs/paths:

```ts
// packages/ui/src/lib/browser/devServers.ts
type DevServerCandidate = { url: string; port: number; announced: boolean };
mergeDevServerCandidates({ announced: string[], discovered: DiscoveredDevServer[] | null })
```

Merge algorithm: index announcements by port (first URL wins); if `discovered === null` the announcements stand **alone** (offering something unverified beats offering nothing); otherwise each discovered server takes the announced URL for its port if one exists, `announced:true` only when inherited; sort announced-first then by port; URLs whose port cannot be parsed do not participate. The socket remains ground truth because **terminals wrap long lines, and a URL split mid-port reads as a perfectly plausible address on a port where nothing runs.**

### B.6 Startup-state probe

A dev gateway answers while the app behind it is still starting (5xx page). To the webview that is a *successful* load — no navigation failure — and the only honest signal short of parsing contents is the HTTP status.

`POST /api/system/probe-url` (core route table; [03]): body `{ "url": "http://localhost:5173/" }`, **loopback only** (server rejects otherwise: `400 { ok:false, error:"Invalid loopback URL" }`), requires API auth; the server runs `GET` with `redirect:'manual'` and a **1500 ms** `AbortSignal.timeout`. Response `{ "ok": boolean, "status": number }`, `ok = status >= 200 && status < 600`; client failures return `{ ok:false, error:"<message>" }` with 200.

**No preview token bypasses authentication.** An earlier preview proxy/credential scheme was removed; unmapped `/api/*` goes to the harness proxy (F.13), and the URL-token allowlist still contains vestigial `/api/preview/proxy/` entries with no owning route (src: core-routes.test.js, ui-auth.js). Do not build a preview proxy; the tunnel (H) replaced it.

### B.7 Session dev-server ownership summary

- Ownership belongs to whoever has evidence: the *user's terminal or project-action run* (announced, per directory, per run) or the *host's socket table* (discovered). There is no persistent registry. Announcements are cleared when the user answers the offer or the run ends.
- The tunnel never picks a target — the browser panel does (devTunnel.ts); the host end dials **only** ports discovery currently reports (H.2), so tunnel ownership is delegated to the same evidence the user's list is built from.
- Eager detection invariant: there is **no background scan outside the user-visible 3 s cached discovery**; nothing scans or announces anything the user did not start (J.7 #3).

---

## C. Preview UX

### C.1 Panel and tab model

The browser is a tab type in the per-directory context panel (single, resizable; [09] for shell placement).

- `openContextBrowser(directory, url?, { reveal? })` opens/reuses a tab `mode:'browser'`, `targetPath: url`, `dedupeKey: url || 'browser'` — duplicate URLs reuse the tab (src: useUIStore.ts `_1545-1555_`).
- The webview owns its history from creation; the tab's `targetPath` updates on every successful navigation (`setContextPanelTabTargetPath`) with the **display** URL (post-tunnel mapping, C.9), so reload restores what the user asked for, not an ephemeral local port.
- `registerBrowserOpener((url) => openContextBrowser(dir, url))` lets `browser.open` create a tab when none exists; the panel is revealed because Electron will not composite a zero-width webview and `capturePage()` fails otherwise (src: ContextPanel.tsx `_462-470_`, BrowserPane.tsx `_343-349_`).
- VS Code: `openContextBrowser` is a no-op.

### C.2 Layout and chrome (both transports)

Row 1 — `BrowserToolbar`: back/forward/reload/open-external, address input with per-directory history suggestions (visits recorded on `ready` **with the page title**; an address that failed never enters history), annotate toggle, DevTools, hard reload, zoom, clear-cookies/clear-cache, device-bar toggle. **Chromium-only controls are hidden entirely in the iframe transport, not shown disabled** (they are conditional on the callbacks being provided).

- Reload doubles as stop (calls `stop()` while `loading`).
- Zoom: level −3..4, step 0.5, Chromium factor `1.2^level`; events arrive as `window` CustomEvent `openchamber:zoom` with detail `zoom-in|zoom-out|zoom-reset`; controls hide at 100%.
- Popups open in place on desktop (`new-window` → `preventDefault()` + load in the same view); a detached window would escape the panel.

Row 2 (toggle) — `BrowserDeviceBar`: preset `<select>` (responsive + 8 presets), numeric width/height inputs (clamped 240..3840, commits as custom), rotate (preset → custom swapped; a rotated iPhone is no longer that preset and must not claim to be), color scheme `system|light|dark` (Chromium-only, per-page debugger emulation in the shell, [09]), applied scale display.

### C.3 The two transports

```ts
// packages/ui/src/lib/browser/contract.ts — shared vocabulary
type BrowserNavStatus =
  | { kind: 'idle' }
  | { kind: 'loading'; url: string }
  | { kind: 'ready';   url: string; title: string }
  | { kind: 'failed';  url: string; code: number; description: string; crashed?: boolean };
```

Navigation is a tagged union carrying the URL it describes, so a late event from a superseded navigation is discardable.

**Chromium transport (`WebviewBrowser`):**

- `<webview>, partition="persist:openchamber-browser", allowpopups`. The view is created with its final URL already in `src` (`initialSrc`), never navigated into place afterwards: a background tab renders hidden where an imperative navigation is lost, and mutating `src` after attach is not reliably honored — both leave a panel that never loads. `initialSrc === null` means "still resolving (tunnel)"; the view is not rendered yet.
- `useWebviewNavigation` translates lifecycle events (`did-start-loading`, `did-stop-loading`, `did-navigate`, `did-navigate-in-page`, `page-title-updated`, `page-favicon-updated`, `did-fail-load`, `render-process-gone`/`crashed`):
  - `about:blank` is the resting state, never a page (excluded so the empty state stays visible);
  - `did-fail-load` with `isMainFrame === false` ignored; `code === -3` (`ERR_ABORTED`, superseded) is **not** a failure;
  - `did-stop-loading` must not overwrite a terminal failure for the same URL;
  - `readEventPayload` reads `<detail>` if present else the event object itself (Electron versions disagree where the payload lives; reading only `detail` yields failures with no code);
  - **crash recovery** (lib/browser/crashRecovery.ts): 30 s window, max 3 attempts, delay `250ms * 2^attempts`; reload resolves a lost renderer (nothing else in the lifecycle reports it); attempts exhausted → `failed.crashed` with its own message. State survives view re-attach so a crash-loop cannot restart its own budget.
- Favicons: `page-favicon-updated` → favicon store keyed by current URL.

**Iframe transport (`IframeBrowser`), all non-Chromium runtimes:**

- `<iframe sandbox="allow-scripts allow-forms allow-same-origin allow-popups">` re-keyed `` `${loadedUrl}|${reloadNonce}` `` for forced reloads.
- The page is opaque: no navigation events, no title, no annotation, no console. Back/forward is the panel's own history array (splice on navigate). `isLoading` is always false; history records *what was asked for*.

### C.4 Address input rules (src: lib/browser/url.ts)

- `normalizeBrowserUrl(value)`: trim; schemeless input gets `https://` **except** loopback authorities (`localhost,127.0.0.1,0.0.0.0,::1,[::1]`) which get `http://` (defaulting `localhost:5173` to HTTPS would turn the most common address in this panel into a connection error). Non-http(s) protocols → `about:blank` (`BLANK_URL`), which is also the empty-state trigger.
- `isLoopbackUrl(url)`: hostname in the set above (case-insensitive). `browserUrlLabel(url)`: `URL.host` for labels.

### C.5 Dev-server startup wait (Chromium)

A page opened the moment its dev server launched fails "twice over": first nothing is listening, then a gateway answers 5xx while the app behind it boots. Both are waited out; neither is an error the user can act on (src: BrowserPane.tsx `_660-738_`, url.ts `_62-88_`).

Parameters: `DEV_SERVER_WAIT_MS = 40_000` (per URL run), retry delay 600 ms, `GATEWAY_WAIT_MS = 20_000` (applies only before the first good load), console problem cap 20.

- **Failed load** on a loopback URL with a retryable Chromium code → "waiting for server" overlay (title + hint), reload after 600 ms, until the 40 s budget for that URL expires, then the real failure. Retryable codes: `-2 FAILED, -7 TIMED_OUT, -101 CONNECTION_RESET, -102 CONNECTION_REFUSED, -104 CONNECTION_FAILED, -109 ADDRESS_UNREACHABLE, -118 CONNECTION_TIMED_OUT, -324 EMPTY_RESPONSE`. Loopback-only: retrying a public site that refused us is hammering someone else's server, and a remote dev server is reached through a local tunnel port anyway.
- **Ready on loopback, before the first good load:** `probeLoopbackStatus` (B.6) against the **host** (the check runs on the server, where the panel's ephemeral tunnel port means nothing — probing the local port failed every time and read as "settled"). `status >= 500` → same overlay + reload loop, until 20 s from open-time. A manual reload clears the per-URL retry set but not the gateway wait.
- The first load that is not a starting-up failure (`servedOk`) disables all waiting behavior permanently for the tab.
- Mid-navigation the previous decision's state holds, so a retry does not flash the page behind the overlay.
- The probe is decided by HTTP status, never by reading page contents — guessing from error-page shapes is exactly the trap this panel exists to avoid.

### C.6 Empty state and dev-server list

`BrowserEmptyState` shows: logo, headline, and a live list of **what is actually running** — polls `GET /api/dev-servers` every 2000 ms while visible (one-shot snapshots hide servers appearing seconds apart), merges announced servers for the directory, and renders each candidate as a button labeled `host:port` with the base path on the right. Clicking clears the announcements and opens the URL. The header says "Just started" when announcements exist. If the runtime is remote and the shell is not Electron (`isUnreachableFromHere`), a line states the servers are on the other machine — the desktop app is what can reach them. When discovery failed: a "discovery unavailable" line instead of a silent empty list.

### C.7 Reload / reconnect surfaces

| Surface | Trigger | Behavior |
|---|---|---|
| Toolbar reload | user | `reload()` (or `stop()` while loading) |
| Renderer crash | `render-process-gone` | auto-reload ≤3 attempts / 30 s window, else `failed(crashed)` |
| Starting server | failed load (retryable, loopback) | overlay + 600 ms reload until 40 s per URL |
| Gateway 5xx | loopback page ready, no good load yet | host-side probe, overlay + reload until 20 s |
| Manual address submit | user | clears tunnel retarget set; loads |
| Tunnel failure | `DevTunnelUnavailableError` | blank view + explicit failure panel — never a wrong page (H.4) |

### C.8 Viewport sizing (Chromium)

The page lays out at the chosen `width×height` CSS px; a `transform: scale(<scale>)` shrinks it visually to fit. Scale is **visual only and downward only** (enlarging would misrepresent the tested layout); the stage size is measured with a `ResizeObserver` because the panel is resizable (src: lib/browser/viewport.ts).

The agent's vocabulary is four modes only — `mobile|tablet|desktop|fill` — mapped to presets `iphone-14` (390×844), `ipad-mini` (768×1024), `desktop` (1440×900), `fill`. `viewportSummary()` reads dimensions back in that vocabulary (`custom` otherwise). Every snapshot/inspect result states which layout it describes.

### C.9 Tunnel mapping in the address bar

The panel always displays and persists the URL the user *asked for*; the tunnel port is a transport detail. `toDisplayUrl(url)` maps `127.0.0.1:<localPort>` back to the remembered origin (H.4); `loadUrl()` feeds `resolveBrowsableUrl()` first (H.4), then either `webview.loadURL(target)` or sets `initialSrc` when not yet attached.

### C.10 Clearing browser data

Toolbar actions clear cookies or cache for the `persist:openchamber-browser` partition via `desktop_browser_clear_data { partition, cookies, cache }`, toast success/failure, then `reloadIgnoringCache()` — cleared storage only shows in a page that reloads without it. [09] owns the shell implementation.

---

## D. Browser-control inspection protocol

### D.0 Topology

The browser lives in a **renderer**; the server can never act on a page. The chain (src: server/lib/browser-control/DOCUMENTATION.md):

```
agent tool (openchamber_web browser.*)
  → openchamber-control service (validated browserAction)      [HARNESS PORT AGENT-CALLBACK]
    → broker.request(action, parameters, {signal, timeoutMs})
      → emitRequest: SSE broadcast "openchamber:browser-control-request"
        → every connected client that can serve it receives the envelope
          → controlClient: claims via POST /api/browser-control/claim
            → only the granted client runs the action (injected page script)
              → result via POST /api/browser-control/result
                → broker settles the pending promise → service returns data
                  → agent tool callback envelope → agent session
```

### D.1 SSE envelope (server → clients)

Written to the OpenChamber event stream (`/api/openchamber/events`; [02]):

```
data: {"type":"openchamber:browser-control-request","properties":{
  "requestId":"browser-<uuid>", "action":"browser.snapshot", "parameters":{ "selector":"#submit" } }}
```

`emitRequest` returns the number of clients actually reached: `browser.open` needs **any** client (opening a tab is what creates a view); every other action counts only clients whose connection declared `browser=1` (recorded server-side as `openchamberBrowserCapable`). The flag lives and dies with the connection — no setting, no restart, nothing to remember; this is the **opt-in inspection right** (J). A write error drops the client. Clients keep the EventSource alive only while a controller or opener is registered (src: controlClient.ts `releaseIfIdle`).

### D.2 Broker (server/lib/browser-control/broker.js)

- `DEFAULT_TIMEOUT_MS = 20_000`, `MAX_TIMEOUT_MS = 120_000` (minimum accepted 1 000 ms; `browser.open` uses 45 000 from the control service).
- `request(action, parameters, { timeoutMs, signal })`:
  - publishes via `emitRequest`; **zero** clients reached → reject immediately with `BrowserControlError(503)` whose message describes where the capability exists (the desktop app drives a page; a web tab displays but cannot be driven; "nothing was changed"). Reacting fast is the point: a blocked wait followed by a timeout is indistinguishable from a hung page.
  - otherwise parks the request (`claimed:false`) with a timer — timeout rejection 504, message `The in-app browser did not respond within <N>s`.
  - abort signal → immediate settle `{ ok:false, status:499 }`.
- `claim(requestId)`: first caller wins `true`; a second claim, or a claim for a settled/unknown id, is `false`.
- `resolve(requestId, { ok, data, error })`: settle; unknown ids return `matched:false` — a client answering after a timeout behaved correctly and must not be an error.
- `rejectAll(message)`: everything in flight fails with 503 (used when the owning client disconnects).
- Request id: `browser-<randomUUID>`.

### D.3 HTTP callbacks (server/lib/browser-control/routes.js)

- `POST /api/browser-control/claim` — body limit **4 kb**, `{ requestId }` → `200 { granted: bool }` (400 without requestId).
- `POST /api/browser-control/result` — body limit **2 mb**, sized for a page snapshot (visible text + every interactive element), not a control message. Body `{ requestId, ok, data?, error? }` → `200 { matched: bool }`.
- **Both routes parse their own JSON bodies.** This server attaches parsers per route; a missing one silently turned every result into a 20-second agent-visible timeout.

### D.4 Client half (packages/ui/src/lib/browser/controlClient.ts)

- The **most recently mounted** browser view registers `registerBrowserController({ run })`; unregistering only clears the registry when it still points at the caller (a stale unmount cannot detach a newer view).
- On `browser-control-request`: if no controller, only `browser.open` with a registered opener continues; **claim first** (`POST /claim`) — a refusal is the normal outcome for a client that lost the race, and acting without a grant is what this exists to prevent; then run and `postResult({ requestId, ok, data, error })`.
- `browser.open` without a controller: call the opener, then — no `viewport` or `'fill'` → `{ url, opened:true }` immediately; otherwise poll for a controller **2 s** (50 ms steps) and return `{ url, opened:true, viewportApplied:true|false, viewport?, note? }`; the false case's note says "The panel had no browser view yet, so the viewport was not applied. Call browser.resize now that one exists."
- A dropped/failing `postResult` is **warned, not swallowed**: a dropped result is indistinguishable from an unreachable browser on the agent's side.

### D.5 Action validation (server/lib/openchamber-control/service.js)

Validation happens server-side, *before* waking any client, so a bad call returns as a usage error without a round trip:

| Action | Required | Validation / notes |
|---|---|---|
| `browser.open` | `url` | absolute URL; protocol restricted to `http:`/`https:`; normalized string sent; optional `viewport`; timeout **45 s** |
| `browser.snapshot` | — | optional `selector` |
| `browser.click` | `selector` xor `text` | error if neither |
| `browser.type` | `selector`, `value` | `value` must be string; optional `submit` |
| `browser.scroll` | `direction` or `selector` | direction ∈ `up,down,top,bottom` |
| `browser.back` / `browser.forward` | — | panel throws "There is nothing to go back/forward to in this tab" when history has no entry |
| `browser.inspect` | `selector` | required |
| `browser.resize` | `viewport` | ∈ `mobile,tablet,desktop,fill` |
| `browser.capture` | — | optional `label`; needs `directory` or the session context directory to save |

All others default 20 s. The service passes the abort `signal` through.

### D.6 Injected page scripts (packages/ui/src/lib/browser/pageActions.ts)

Each action compiles a **self-contained expression** evaluated in the page's own realm (`webview.executeJavaScript(script, true)`). Inputs are embedded via `JSON.stringify` — that is what keeps a selector or typed value from terminating the expression and becoming code. Every script resolves to `{ ok:true, ...result }` or `{ ok:false, error }` instead of throwing.

Shared caps and helpers: `MAX_ELEMENTS = 120`, `MAX_TEXT_CHARS = 6000`, `MAX_LABEL_CHARS = 80`; `visible(el)` (rect ≥ 1×1, not `visibility:hidden`, not `display:none`, opacity ≠ 0); `label(el)` ordina `aria-label` → text (≤80) → `value` → `placeholder`; `cssPath(el)` builds an identity-first selector: unique `#id` → unique attribute selector `[data-testid|data-test-id|data-test|name|aria-label="…"]` (values containing `"` skipped) → unique `tag.class` → positional chain `tag:nth-of-type(n) > …` (≤6 levels, `#id` shortcut at top), uniqueness checked with `querySelectorAll(sel).length === 1`; `accessibleName(el)` (aria-label → aria-labelledby target → title → alt → text → value); `findByText(needle)` sweeps `a, button, [role=button], [role=link], input[type=submit|button], summary, label` (visible only, exact before partial).

**`browser.snapshot`** result:

```json
{
  "ok": true, "url": "http://localhost:5173/", "title": "My App", "scope": "document",
  "scrollY": 0, "maxScrollY": 520,
  "text": "<visible body text, ≤6000 chars, blank runs collapsed>",
  "elements": [
    { "selector": "#save", "tag": "button", "bounds": {"x":12,"y":300,"width":88,"height":34},
      "inViewport": true, "type": "submit", "role": "button", "label": "Save",
      "disabled": true, "missingAccessibleName": false }
  ],
  "textTruncated": false, "textTotalChars": 2140,
  "elementsTruncated": false, "interactiveElementsOnPage": 87,
  "consoleProblems": [{ "level": "error", "message": "...", "source": "src/App.tsx:12" }],
  "viewport": { "mode": "desktop", "width": 1440, "height": 900 }
}
```

- Sweep: `a[href], button, input, select, textarea, [role=button], [role=link], [role=tab], [contenteditable=true]`.
- Empty/default fields are omitted, not serialized as `""`/`false`.
- `inViewport` only when the element intersects the window (`bottom > 0 && top < innerHeight`) — the list covers the whole document so anything can be clicked without scrolling first.
- `missingAccessibleName:true` flags clickables with no accessible name (a defect worth naming; per-element names cost more than they tell).
- **Truncation is always reported** — a capped list that reports only its own length reads as the whole page, and the agent acts as if it had seen everything.
- Optional `selector` scopes every query to one subtree (`scope` echoes it) — scoped asks are the answer to long pages, not retuned caps.
- `consoleProblems`/`viewport` are attached by the panel wrapper (D.8), not the page.

**`browser.click`:** target by `selector` or `findByText(text)`; refuse `disabled`; `scrollIntoView({block:'center',inline:'center'})`; `click()`; returns `{ ok, clicked: cssPath, label, url }`. After: 150 ms pause + `waitForIdle` (≤8 s poll of `isLoading` at 120 ms) so the next snapshot sees the page the action produced.

**`browser.type`:** input/textarea/contenteditable only; refuse `disabled`/`readOnly`; focus; set value via the **native prototype setter** (`HTMLInputElement`/`HTMLTextAreaElement` descriptor) so React-style value tracking observes the change; dispatch `input` **and** `change` (bubbling). With `submit`: synthetic Enter keydown/keyup (`keyCode/which: 13`) and `form.requestSubmit()` when inside a form. Returns `{ ok, selector: cssPath, url }`; submit waits 150 ms + idle.

**`browser.scroll`:** `direction` via `window.scrollTo` or `scrollIntoView` on `selector`, all `behavior:'instant'` (the page's own smooth scrolling would otherwise still be animating when the next action runs). Readback after double-`requestAnimationFrame`: `{ ok, scrollY, maxScrollY, atTop: scrollY<=1, atBottom: scrollY>=maxScrollY-1, direction|scrolledTo }`. Readback exists because position read immediately after a smooth scroll reports the *pre-scroll* position and `scrollY: 0` from a successful scroll teaches a superstition.

**`browser.inspect`:** reads computed styles for `color, background-color, background-image, opacity, font-family, font-size, font-weight, line-height, letter-spacing, text-align, border-radius, border-width, border-style, border-color, box-shadow, display, position, width, height, padding, margin, gap, flex-direction, justify-content, align-items, z-index, overflow, visibility`, plus bounds/center. Returns `{ ok, selector, tag, label, bounds, inViewport, styles }`. Computed styles come from the live page — a colour reported here is the colour on screen, and unlike a screenshot it is readable by an agent that cannot see images.

**`browser.back`/`forward`:** no script — `goBack()/goForward()`, refuse when `canGoBack/Forward` is false, wait 150 ms + idle, return `{ url: toDisplayUrl(getURL()), title }`.

**`browser.open` (panel):** apply viewport if given (and reveal the device bar so the user sees which layout the agent chose); `loadUrl`; 150 ms; `waitForIdle(25_000)`; returns `{ url: normalized, title, opened:true, settled, viewport }`. `settled:false` means still fetching, **not** failure — the agent can snapshot and decide.

**`browser.resize`:** apply viewport, wait 200 ms + idle (so a following snapshot describes the *new* layout), returns `{ viewport }`, and reveals the device bar.

**`browser.capture` (full contract):** reveal the existing browser tab (`openContextBrowser(directory, currentURL)`), wait for the composited surface to have stable width (≤1.2 s, two stable 50 ms samples; Chromium removes a zero-width webview's surface when its panel is closed — `capturePage()` then fails with `UnknownVizError`), double-`requestAnimationFrame`, `waitForIdle`, then `desktop_browser_capture_page { webContentsId } → { mime, base64, width, height }`; returns `{ ...capture, url: displayUrl, title, viewport }`.

### D.7 User annotation end-to-end (numbered)

Entry: toolbar annotate button (Chromium only). Exit: toggle again, or Escape (captured at the window level with an IME-composition guard).

1. The panel resolves the overlay theme (light/dark variant → resolved primary/soft/faint/contrast/surface/glass/border colors, concrete strings) and translated labels `select|marquee|draw|commentPlaceholder|submit` (src: useAnnotationAttach.ts, overlayTheme.ts).
2. `cancelAnnotationSession` runs a teardown script removing anything a previous session left: host element `[data-openchamber-annotation]`, the `#openchamber-annotation-cursor` style, and the `window.__openchamberBrowserAnnotationActive` flag.
3. `buildAnnotationOverlayScript(theme, labels)` is one self-contained script injected with `executeJavaScript(..., true)`:
   - a single host `div` `position:fixed; inset:0; z-index: 2147483646; pointer-events:none` with a **closed shadow root** — page CSS cannot restyle it, page scripts cannot walk into it;
   - chrome: tools pill (top center: select/marquee/draw), hover box + follows element under cursor, marquee rectangle, SVG layer for regions/strokes, comment editor that follows the last marked target (below it, or above when out of room, never offscreen);
   - select: hover highlights; click selects (clicking the same element again deselects — a misclick costs one click, not starting over) via `elementFromPoint` filtered to ignore overlay nodes;
   - the overlay **blocks page interaction** while active: capture-phase `click, auxclick, dblclick, mousedown, mouseup, contextmenu` preventDefault+stopPropagation — blocking `mousedown` alone is not enough, the follow-up click still fires (marking a button would press it; marking a link would navigate away);
   - marquee: normalized dragged rect; a region marks **an area, not the elements inside it** (expanding into a selection would make the result depend on the page's markup rather than on what was drawn); min rect 3×3;
   - draw: free-hand SVG path (stroke 2.5, round caps), ≥2 points, bounds computed;
   - comment textarea: grows to content (measure only while visible — hidden elements measure 0; min 32 px, max 104 px); Enter (non-shift, IME-safe via `keyCode 229`) submits, Escape cancels; typed keys stop propagation so the page never receives them as shortcuts;
   - submit resolves with the payload; **zero or one element** (uniform shape downstream);
   - **teardown-before-resolve**: listeners removed, chrome removed, then two `requestAnimationFrame`s before resolving — the host capture that follows must contain the page and none of our UI.
4. The result is validated with `isBrowserAnnotationPayload` — every field a consumer dereferences is validated here (annotation payloads cross a trust boundary: produced by a script running inside a page we do not control; a partially-valid payload would otherwise throw far from its origin, at prompt-formatting or screenshot-crop time) (src: contract.ts `_138-191_`).
5. `readViewport` re-reads `window.innerWidth/innerHeight`.
6. `capturePage()` via `desktop_browser_capture_page` (`{ mime, base64, width, height }`).
7. `renderAnnotationScreenshot` paints the capture into a canvas scaled by the **measured ratio** `capturePixels/cssPixels` (never `devicePixelRatio` — the page may be zoomed), draws element/region rectangles (translucent accent fill + accent outline, outline width scaled with the image so it survives downscale) and strokes, clamps width to 1600 px, exports JPEG q0.85 as a `File` named `browser-annotation-<now>.jpg`. The image is the **whole visible page, not a crop**: a tight crop destroys "where is it and what is next to it", usually the more useful half of pointing. The accent fill must be a resolved color, never a hex-alpha-suffixed derivative — an invalid value leaves canvas opaque black, painting over the very element the screenshot shows.
8. Attach to the composer: requires an active session or an open draft; **the screenshot is attached first** (`addAttachedFile`), then the text — a failed image upload must not leave a prompt claiming an attachment that never arrived; the text states what actually happened. An inline comment draft is added `{ source:'preview-annotation', fileLabel: pageUrl|'browser', code: formatBrowserAnnotationPrompt(...) }`. `[HARNESS PORT COMPOSER]`: the agent receives this as ordinary composer text plus the image as a chat attachment — not through a tool ([05]).
9. The prompt body is **always English** (model input, not UI copy); only the intro line is translated:

```
Pointed at the page:                 ← translated intro
Page: <title or url>
URL: <pageUrl>                       ← only when a title exists
Viewport: 1440x900, DPR 2
Screenshot: attached                 ← or "not attached"
Comment: <user comment>              ← only when non-empty

Element 1: button
- Text: Save changes
- Selector: #save
- Path: div#root > main > form > button#save
- Ancestry: div#root > main.container > form.deposit > button#save
- Attributes: id="save" type="submit" aria-label="Save changes"
- Bounds: x=12, y=300, width=88, height=34
- Styles: display=inline-block; position=relative; font=600 14px / 20px Inter;
  color=rgb(255,255,255); background=rgb(18,18,18)

Region 1: x=40, y=120, width=180, height=60
Drawing 1: 27 points over x=10, y=5, width=300, height=80
```

### D.8 Console problem capture

There is no cross-page "error overlay"; the equivalent is the panel-side console record: `console-message` events with level ≥ 2 (2=warning, 3=error) are recorded `{ level:'error'|'warning', message (≤400 chars), source:"<sourceId>:<line>" }`; the record **resets on `did-start-loading`** — each page gets its own record (carrying the last one over would blame a new page for the previous page's failures); capped at 20; attached to every `browser.snapshot` result so the agent sees errors without being asked to hunt for them ("a page that looks right and is throwing looks identical to one that is fine").

### D.9 `browser.capture` → project file

The image never returns to the agent as base64; the control service writes it next to the code it documents (src: openchamber-control/screenshots.js). Target: `<project-directory>/.openchamber/screenshots/<slug>-<stamp>.<ext>`. `slug = screenshotSlug(label)`: lowercase, `[^a-z0-9]+ → '-'`, trimmed, max **48** chars, fallback `page`; everything outside the safe set is **dropped, not escaped** — `..`, separators, and leading dots cannot survive; a label is a name, never a path. `stamp`: ISO date-time with `:`/`.` replaced by `-`, trailing `Z` removed (sorts chronologically, reads as a date). Extensions: `image/jpeg→.jpg, image/png→.png, image/webp→.webp` (default jpg). The reported path uses **forward slashes** — it is written into Markdown and commit messages, where a Windows backslash is an escape character; the absolute path is returned too.

Agent-visible result:

```json
{ "path": ".openchamber/screenshots/before-fix-2026-05-02T10-33-11-123.jpg",
  "hint": "Write ![](<path>) in your reply to show this image to the user; it is rendered under your message.",
  "url": "http://localhost:5173/", "title": "My App",
  "viewport": { "mode": "desktop", "width": 1440, "height": 900 },
  "width": 1440, "height": 900 }
```

The hint exists because chat collects image paths written in a finished answer and renders them below the message — saving the file is only half of showing it ([05]; src: openchamber-control/DOCUMENTATION.md).

### D.10 Numbered agent flows

**Flow 1 — inspect a page it did not open:** `openchamber_web browser.snapshot {}` → callback route → control service `browserAction` → broker → SSE broadcast → capable clients claim → grantee runs the script → result posted → broker resolves → envelope `{ schemaVersion:1, ok:true, action:'browser.snapshot', data }`. Zero capable clients → immediate 503 whose message is passed verbatim in `error.message` (it describes *when the capability exists*; the environment decision stays with the caller). Agent then `browser.click { selector }` (panel waits for the post-click page), snapshots again to verify, and may `browser.capture { label }`.

**Flow 2 — check how an element renders:** `browser.inspect { selector }` for computed styles; combine with `browser.resize { viewport:'mobile' }` → snapshot (snapshots carry `viewport`, so states cannot be confused) → `browser.capture { label:'before-fix' }` for visual evidence.

### D.11 Wire types (packages/ui/src/lib/browser/contract.ts)

```ts
type BrowserRect = { x:number; y:number; width:number; height:number };
type BrowserPoint = { x:number; y:number };
type BrowserElementAncestor = { tag:string; id?:string; className?:string; selectorPart:string };
type BrowserElementTarget = {
  tag: string; text: string;            // textContent collapsed, ≤400
  selector: string; path: string;       // "#save" | chain incl. self
  bounds: BrowserRect; center: BrowserPoint;
  attributes: Record<string, string>;   // id, class, name, type, href, src, alt, title,
                                        // role, placeholder, aria-label, data-testid (≤200)
  computedStyle: Record<string, string>; // 21 lowerCamel props (D.6 list)
  ancestry: BrowserElementAncestor[];    // ≤4 ancestors
};
type BrowserAnnotationElement = { id:string; element: BrowserElementTarget };
type BrowserAnnotationRegion  = { id:string; rect: BrowserRect };
type BrowserAnnotationStroke  = { id:string; points: BrowserPoint[]; bounds: BrowserRect };
type BrowserAnnotationPayload = {
  id: string;                           // "annotation-<Date.now()>"
  pageUrl: string; pageTitle: string;
  viewport: { width:number; height:number }; devicePixelRatio: number;
  comment: string;
  elements: BrowserAnnotationElement[]; // zero or one
  regions: BrowserAnnotationRegion[]; strokes: BrowserAnnotationStroke[];
};
```

`annotationTargetCount(p) = elements + regions + strokes`. Validators (`isBrowserElementTarget`, `isBrowserAnnotationPayload`, …) are total: structural validity is established at the boundary, not discovered downstream.

---

## E. Electron embedded browser — differences from the iframe surface

[E09] owns the shell; this section fixes the *contract* the panel depends on.

| Aspect | Contract (payload) |
|---|---|
| Transport decision | `window.__OPENCHAMBER_ELECTRON__` truthy ⇒ `<webview>` |
| Page capture | `desktop_browser_capture_page { webContentsId } → { mime, base64, width, height }` (agent capture and annotation) |
| Script eval | `webview.executeJavaScript(code, userGesture)` in page context |
| Color scheme | `desktop_browser_set_color_scheme { webContentsId, scheme:'light'|'dark'|'system' }` — per-page emulation via a debugger session (`1.3`); fails ("Close DevTools for this page…") when DevTools owns the only debugger session; emulation resets when the session detaches, so it must stay attached |
| Clear data | `desktop_browser_clear_data { partition, cookies, cache }` (partition `persist:openchamber-browser`) |
| DevTools / zoom | `webview.openDevTools()`; `setZoomLevel(level)`, factor `1.2^level`, level −3..4 |
| Tunnels | `desktop_dev_tunnel_open/_close`, `desktop_relay_dev_tunnel_close_all` — **excluded from any "safe for remote pages" IPC set**: a remote page must never open local listeners (src: electron/main.mjs `_3897-3935_`) |
| Persistence | one `persist:openchamber-browser` profile across browser tabs — pages keep the site's cookies/sessions, which is why the web tool tells the agent "the page runs with the user's real logins; treat what you see as their live session" |

---

## F. Walkthrough — server pipeline

Shape: the **small model** (or a user-chosen model) reads a *digest* of the diff — files + hunks aliased `h1..hN` — and returns JSON grouping those aliases into chapters and ordered "stops"; the server resolves aliases back to content-hashed hunk ids, normalizes, caches content-addressed, and hands the client both the narrative and the *current* hunk index; the client matches ids to ids, so staleness is proof, not a heuristic.

### F.1 Sources

`parseSource(raw)` validates an untrusted source descriptor (src: walkthrough/sources.js):

| kind | fields | validation |
|---|---|---|
| `working-tree` | `scope: 'all'|'staged'|'working'` (default `all`) | scope in set |
| `branch` | `baseRef`, `headRef` | both non-empty |
| `commit` | `hash` | **full object id only** (40 or 64 hex; moving refs rejected — cache keys must not move) |
| `pr` | `number`; optional `sourceRepo {owner, repo}` | number > 0; owner `/^[a-zA-Z0-9-]+$/`, repo `/^[a-zA-Z0-9_.-]+$/` |

`sourceKey(source)` — stable persisted keys (pointer keys, part of cache keys; do not change shape casually): `working-tree:<scope>` · `branch:<baseRef>...<headRef>` · `commit:<hash>` · `pr:<number>` or `pr:<owner>/<repo>:<number>`.

`loadSourceSections` resolves a source into `[{ scope, patch }]`:

- `working-tree/all` → `staged` section (`git diff --staged`) **and** `working` section (unstaged diff + **untracked files**; `git diff` omits untracked files entirely, so a brand-new file would be invisible — they are fetched per file through a batch helper that resolves the repository once and bounds diff concurrency). `staged|working` → single section of that scope.
- `branch` → one `branch` section: `getRangeDiff` with `includeWorkingTree:true` — merge-base vs current files, committed and local work in one net diff.
- `commit` → `getCommitDiff` (selected commit vs first parent; root commits vs empty tree).
- `pr` → GitHub's published three-dot diff (below); scope `pr:<number>` (per-file scope labels are omitted from the digest for branch/PR scopes).

PR diff access (src: walkthrough/pull-request.js): `getOctokitOrNull()` required (else 401 `github-not-connected`); repo from `sourceRepo` or the directory's remote (else 400 `no-github-remote`); `GET /repos/{owner}/{repo}/pulls/{pull_number}` with `accept: application/vnd.github.v3.diff`; response must match `/^(?:diff --git |\s*$)/`; normal generation refuses empty PRs (404 `empty-diff`) while the raw comparison endpoint allows empty (F.12).

Scope separation exists because one review can hold byte-identical code in two places: staged and unstaged versions of the same lines live under distinct scopes, so a stop written against staged code never silently re-anchors onto an unstaged edit.

### F.2 Hunks and identity

`parseDiffFiles(patch, scope)` splits a unified diff into files and hunks (src: walkthrough/hunks.js). File header regex `^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$`; hunk header `^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$`. Per-file: status (added/deleted/renamed/modified from `new file mode`/`deleted file mode`/`rename from`), binary (from `Binary files ` / `GIT binary patch`), `oldPath` on rename.

**Hunk id** — one owner of this algorithm; the client is never given it:

```
id = "<scope>:<path>:<sha1(header + '\n' + body), first 8 hex>["-2"|"-3"… for repeat occurrences]
```

- The digest covers header **and** body: any edit, even one preserving line numbers, changes the id. A stop whose anchor no longer resolves is therefore *proof* the code changed — staleness without heuristics.
- A file can legitimately contain byte-identical hunks (boilerplate edits): occurrence suffixes keep ids unique without making ids positional.
- The scope keeps `staged`/`working` apart (F.1).
- Helpers: `indexHunks(files)` → Map id→hunk(+path/status); `listHunkIds(files)` → ordered ids (uncovered-tail computation).

### F.3 Digest

`buildDigest(sections)` (src: walkthrough/digest.js) → the full client-side `files` array (generated files *excluded, not hidden*: parsed, returned, part of the uncovered tail), the model-facing `digest` (`{ path, oldPath?, status, scope? ], binary?, hunks: [{ alias, header, oldLines: "a-b", newLines: "a-b", added, deleted, patch: body }] }` per non-generated file), alias maps `idByAlias`/`aliasById` — **aliases are request-local** (`h1, h2, …`), far cheaper in tokens than real ids and impossible for a model to plausibly invent for hunks that do not exist — and counts `hunkCount` (all reviewable hunks), `fileCount`, `generatedFileCount`, `generatedPaths`.

### F.4 Generated-file exclusion

`isGeneratedArtifact(path)` — by **name, never size** (a lockfile larger than the whole change around it carries no intent and wastes context real code needs). Lockfile basenames: `bun.lock, bun.lockb, package-lock.json, npm-shrinkwrap.json, yarn.lock, pnpm-lock.yaml, composer.lock, Gemfile.lock, Pipfile.lock, poetry.lock, uv.lock, Cargo.lock, go.sum, mix.lock, pubspec.lock, flake.lock, gradle.lockfile, packages.lock.json, deno.lock`. Regexes: `\.min\.(js|css)$`, `\.(js|css)\.map$`, `\.generated\.[^/]+$`, `\.gen\.[^/]+$`, `(^|/)generated/`, `\.pb\.(go|ts|js)$`, `_pb2(_grpc)?\.py$`, `\.pb\.cc$|\.pb\.h$`, `(^|/)__snapshots__/`, `\.snap$`. The matcher is deliberately conservative (`src/lock.ts`, `src/generator.ts` are authored code): a false positive silently drops real code from a review — the exact failure the feature exists to prevent.

### F.5 Prompt

System prompt (version-tracked, `PROMPT_VERSION = 3`), verbatim:

```
You are writing a guided review of a code change for the engineer who is about to read it.

Your job is to impose a reading order the diff itself does not have. A diff is ordered by file path, which is almost never the order in which the change makes sense. Group related hunks — across files — into stops, and order the stops so that each one is understandable given the ones before it.

What a good stop says:
- what this code now does differently, in terms of behavior, not syntax
- why the surrounding hunks belong together
- what a reviewer should check or be suspicious about, when there is something

What a bad stop says:
- "Renamed X to Y", "Added a parameter", "Updated the imports" — restating the diff in prose is worthless; the reader can already see it
- speculation about intent you cannot support from the code

Rules:
- Anchor every stop to hunk aliases from the digest, exactly as given (h1, h2, …). Never invent an alias.
- Anchor each hunk at most once, in the stop where it matters most.
- You do not have to cover every hunk. Mechanical changes are better left out than padded into a stop; whatever you omit is still shown to the reader separately.
- Order stops so the reader builds understanding: entry points and data shape before the code that consumes them.
- importance: "critical" for changes that carry real risk or drive the rest, "context" for supporting changes, "normal" otherwise.
- Stop titles name the thing the stop is about, not the act of reviewing it. "Hardware keyboard bridge" and "Overflow menu removed" tell a reader scanning the contents what they will find; "Exercise the boundaries" and "Describe the contract" do not.
- Write prose as plain sentences. No markdown, no bullet lists, no code fences.

Respond with a single JSON object and nothing else. (Some providers refuse a structured-output request unless the word "json" appears in the request, which is why this is stated explicitly.)
```

Non-English requests append (the language named in **English** — an instruction in the prompt's own language is more reliable; `DEFAULT_LANGUAGE='en'` adds nothing):

```
Write all prose in <Language>: the walkthrough title, the focus line, chapter titles and blurbs, and stop titles and prose. The reader of this review reads <Language>.

Keep these in English exactly as given, regardless of the prose language: hunk aliases (h1, h2, …), the "icon" values, and the "importance" values. Keep identifiers, file paths, and API names as they appear in the code — never translate them.
```

(Only prose translates; aliases are keys the server resolves, and icon/importance are validated against fixed English enums — a translated value is silently dropped by the normalizer. Tags mirror the UI locale union exactly, enforced by a source-level equality test the server can make because it cannot import UI code: `en, de, fr, zh-CN, zh-TW, uk, es, pt-BR, ko, pl, ja, tr`. Unknown/malformed/absent resolves to English with case/underscore tolerance — refusal would be worse than a readable review.)

User prompt:

```
Reviewing: <source line>

This change has <fileCount> file(s) and <hunkCount> reviewable hunk(s).

Aim for about <targetStops> stop(s) across about <targetChapters> chapter(s); never exceed 16 stops, 6 chapters, or 14 hunks in one stop. Fewer, denser stops beat many thin ones.

Chapter titles render in a narrow column: at most 24 characters, one or two words.
[<previous-walkthrough section when regenerating>]
Change digest:
<JSON.stringify(digest)>
```

Sizing: `targetStops = clamp(1, round(hunkCount/2.5) || 1, 16)`; `targetChapters = hunkCount ≤ 4 ? 1 : clamp(1, ceil(stops/3), 6)`. Source lines: working-tree `Uncommitted local changes (staged and unstaged|staged|working).` · branch `All work on branch "<head>" that is not in "<base>". Changes merged in from <base> are already excluded.` · commit `Only the changes introduced by commit <hash>, relative to its first parent (or the empty tree for a root commit).` · pr `Pull request #<n>.`

Regeneration section (re-authored, never spliced — partial narrative splices produce stops that contradict each other, invisibly):

```
A previous walkthrough of an earlier state of this change is below. The code has moved on since it was written, so its anchors are gone — deliberately, so you re-anchor everything against the current digest.

Keep the stops that are still accurate and phrased well, revise the ones whose code changed, drop the ones whose code no longer exists, and add stops for work that is new. Do not preserve its structure out of loyalty; preserve it only where it still fits.

Previous walkthrough — "<title>":
- <chapter title>[ — blurb]
  - <stop title>: <prose>
```

Schema-fallback instruction (only when a provider rejects structured output):

```
Return ONLY a JSON object, with no prose around it and no markdown fences, in exactly this shape:
{"title": string, "focus": string, "chapters": [{"title": string, "icon": "bug"|"wrench"|"path"|"flask"|"doc"|"gear", "blurb": string, "stops": [{"title": string, "hunks": [string], "importance": "critical"|"normal"|"context", "prose": string}]}]}
```

### F.6 Response schema and normalization

`WALKTHROUGH_VERSION = 1`, `PROMPT_VERSION = 3` (bumping the prompt version invalidates every cached entry — intended). Caps: `MAX_CHAPTERS 6, MAX_STOPS 16, MAX_HUNKS_PER_STOP 14, MAX_CHAPTER_TITLE_CHARS 24`; icons `bug|wrench|path|flask|doc|gear`; importance `critical|normal|context`.

`responseSchema` is a strict JSON Schema (required `title/focus/chapters`; chapters require `title/icon/blurb/stops`; stops require `title/hunks/importance/prose`; `additionalProperties:false` everywhere), sent as structured output where supported.

`normalizeWalkthrough(raw, idByAlias)`:

- drops unknown aliases (counted `droppedAnchors`); enforces one-anchor-per-hunk (a duplicate alias in a later stop is silently ignored); enforces caps; requires ≥1 resolved hunk + non-empty prose per stop (else the stop is dropped), non-empty chapter (else chapter dropped), ≥1 chapter overall (else error `invalid-walkthrough`);
- validates `icon`/`importance` against the fixed enumerations with fallbacks (`doc`, `normal`); truncates chapter titles to 24 chars; trims all strings; assigns ids `chapter-<n>`, `stop-<c>-<i>`; bare-title fallbacks `Part n` / `Step n`;
- **the model is trusted only for prose and grouping: every anchor is re-resolved against the digest here** — nothing it invents renders as a broken stop.

`parseModelJson(text)`: strip one leading ``` / ```json fence and trailing fence; `JSON.parse`; on failure find the outermost `{` and shrink from the right (`lastIndexOf('}')` loop) trying `JSON.parse` — tolerant parsing for providers that wrap JSON in prose.

### F.7 Model resolution and budgets

Resolution chain (most specific first):

1. request's `model` (`provider/model`) — a per-review choice, stored nowhere;
2. feature setting `walkthroughModelOverride` (Settings → Sessions; set = used, unset = small-model chain; **choosing a model is the opt-out** — the default chain is the fallback, and clearing the picker restores it) [14];
3. small-model chain: settings `smallModelOverride` (when `smallModelUseDefault === false`) → `opencode.json` `small_model` → catalog/auth-derived default. The separation exists because small-model callers want cheap/fast (recaps, commit messages) while this feature needs schema-shaped output and a whole diff of context; one setting serving both would degrade one feature to fix the other.

`resolveModel` = `[HARNESS PORT SSM-2] describeSmallModel({ directory, outputReserveTokens: walkthroughOutputTokens, overrideModel })` → `{ providerID, modelID, source, hasLogin, inputCharBudget, contextTokens, contextKnown, outputTokens, structuredOutput (tri-state: true|false|null), outputTokenLimit }`. Reasoning: the reserve must match the reserve the request uses; passing a *function* lets the caller compute the reserve from the model's limits, so request and reserve cannot drift.

**Output token ask** (derived, never flat): `min(96k, max(24k, floor(context * 0.25)))`, then capped by catalog `limit.output` (a model whose limit is below the floor gets its limit — asking above it is rejected outright by some providers, silently ignored by others). The **same number is reserved from the input allowance**: ask for more than was reserved and a large diff overruns context mid-answer (a truncation bug, not a budgeting one); a flat 24k was the same number for a 64k-context model and one with 384k output tokens — and on the latter it was the only reason generation failed. The budget exists for what comes *before* the answer: reasoning models spend the allowance thinking and return nothing when it runs out, which is a bill for no answer.

Timeout: a hang guard, not a pace-setter — `min(15 min, 120 s + 1 s per hunk)`; the schema fallback can consume the deadline twice (two attempts). Errs long on purpose: losing a nearly-finished generation costs real money; an over-long deadline holds only a job slot.

`[HARNESS PORT SSM-1]`: `generateSmallModelText({ prompt, system, directory, sessionID: "openchamber-walkthrough-<cacheKey>", model: "provider/model", responseSchema, onOverflow: 'error', timeoutMs, maxOutputTokens, signal }) → { text, providerID, modelID, source }`. In the original it calls provider APIs directly with the OpenCode auth store (`auth.json`), provider-specific wire formats, and OAuth token refresh — a re-implementation defines its own equivalent. Contract to preserve:

- `onOverflow:'error'` — a diff that does not fit is **refused, never clipped**; error carries `context-too-small, requiredChars, availableChars` (walkthrough maps to 409). A walkthrough written against a silently clipped diff is confidently wrong in a way no reader can detect.
- sessionID namespaced per walkthrough so harness-side session artifacts don't collide.
- `maxOutputTokens` equals the derived ask.
- Errors distinguish `context-too-small`, `output-exhausted`, `no-provider-login`, and provider 4xx (the schema-refusal signal).
- Facade providers that spawn an interactive CLI per request are **always** refused for small-model work, unconditionally — a Claude-Plugin-style façade spends the user's subscription rate limit per review.

### F.8 Structured-output refusal handling

- `structured_output === false` in the catalog blocks generation up front; a *missing* field does **not** block (the catalog omits it for ~half of all models; treating unknown as unsupported hides working models).
- Providers without the capability sometimes reject the schema at request time (plain 400, or Alibaba/Qwen "messages must contain the word 'json'"). A rejected **request shape is not a dead end**: exactly one retry with the schema moved into the prompt (`JSON_SHAPE_INSTRUCTION`) + tolerant parser. Only if that yields no usable JSON is `structured-output-unsupported` reported — then it is real.
- The refusal is remembered **per `provider/model` for the process lifetime** (`schemaRefusedBy`): never pay again for a known-failing call, but a restart retries once — a provider that ships structured-output support should not need a settings change. The system prompt already contains the word "json", satisfying request scanners on the fast path.

### F.9 Caching and pointers

Storage root `OPENCHAMBER_DATA_DIR` or `~/.config/openchamber`, under `walkthroughs/` (src: walkthrough/store.js):

- **Entries** `entries/<sha256>.json` — immutable, content-addressed. Cache key input: `{ walkthroughVersion, promptVersion, repoRoot, sourceKey, providerID, modelID, language, files: [{ path, status, hunkIds[] }] sorted by path }`. A hit means the walkthrough was written about *exactly this code + model + language*: there is no freshness question — staleness is a miss — and returning the working tree to an earlier state resurrects the review for free.
- **Pointers** `pointers/<sha256(repoRoot + '\0' + sourceKey)>.json` — mutable `{ cacheKey, generatedAt, repoRoot, sourceKey }`, answering what the cache cannot: which walkthrough was last shown here, and has the code moved since. It feeds the previous walkthrough into regeneration.
- Reads enforce size ≤ 4 MB and validate version → corrupt file = miss, never a crash (a bad cache file must not break the feature). Writes are tmp+rename atomic.
- **Eviction** after a write crossing limits (200 entries / 50 MB), LRU by atime, only on writes. Pointers are never evicted for size; a pointer to an evicted entry truthfully reads as "no walkthrough" and the next generation overwrites it.
- **Pruning** of pointers whose repository is *provably gone*: async and deferred off the request path (module-load `setTimeout(...).unref()`), capped at 500 per run, deleting only on a definite `ENOENT` — unreachable is not gone (an unplugged drive or dead share must not cost the user their walkthroughs). This runs inside an Electron main process in the desktop app: a synchronous loop there stalls IPC and the window, not one request, and the paths are user repositories where a single existence check can hang for seconds.

**Read-ordering subtlety** (the "Ukrainian" bug): a read first builds the key for *what was asked* (model+language) and answers from it when it exists — before consulting the pointer, which records only "what was generated here last" and would otherwise keep the English review on screen under a Ukrainian picker while the Ukrainian one sat unused in the cache. Serving an entry moves the pointer. When nothing exists in the requested language the pointer wins — an English review beats an empty panel, and the result reports the language it is in so the panel can say so (G.5). Attaching to a running job ignores the second request's language: the job already has one.

### F.10 Generation lifecycle (jobs)

- Jobs live in a module-level `Map` keyed by `repoRoot\0sourceKey`. A second `generate` for the same source **attaches to the running job** (returns its promise) — a user who refreshed and pressed the button again wants the answer, not two bills.
- Generation **outlives its request**: the HTTP handler deliberately does not abort on client disconnect (`res.writableEnded || res.destroyed` only suppresses the *response*). A dropped connection and a deliberate cancel are indistinguishable at the socket; tying the work to the request meant an accidental refresh threw away minutes of paid-for work. The returning client sees `generating:true` from the read and re-attaches (G.3).
- Stopping is explicit: `POST /api/walkthrough/cancel` aborts that job's `AbortController`. Nothing else does. The cost of outliving requests: a job everyone abandoned keeps spending until it finishes — the scaled timeout bounds it.
- Stages — coarse, only phases a person can wait on: `collecting` (diff read; a PR is seconds of network), `asking`, `retrying` (schema fallback; **never shown** — from outside it is the same wait, and naming our fallback only invites the question of what it is), `assembling`. Digest building and cache reads take single-digit ms and get no rows (naming them implies progress that is not happening).
- `GET /api/walkthrough/progress` reads **memory only** (job stage or `null`) — pollable once a second; the full read re-runs the whole git pipeline and must never be polled.
- Forced regeneration passes the previous walkthrough into the prompt (F.5); the previous entry comes from the pointer when its cacheKey differs from the current one.

### F.11 Readiness

`computeReadiness` is folded into the read endpoint — both answers need the same diff, and a separate readiness endpoint meant every panel open ran the whole git pipeline twice:

```
no-model                        → ready:false
hunkCount === 0                 → 'only-generated' (files>0 && all generated) | 'empty-diff'
hasLogin === false              → 'no-provider-login' (model omitted from the result:
                                   offering an unauthenticated selection in the picker
                                   is what made the old raw auth error feel like a bug)
structuredOutput === false      → 'structured-output-unsupported'
prompt+system > inputCharBudget → 'context-too-small' { requiredChars, availableChars }
else ready { model, requiredChars, availableChars, hunkCount, fileCount }
```

Readiness is computed **with the request's language**: the instruction is part of the prompt, so a readiness answer without it would measure a request nobody sends.

### F.12 Walkthrough HTTP API

Registered lazily from the feature-routes runtime; JSON body parsing applies to POSTs ([03]). Errors: `{ error, code?, model?, requiredChars?, availableChars? }` with mapped status.

| Route | Semantics |
|---|---|
| `GET /api/walkthrough?directory&source&model?&language?` | last walkthrough + current hunk index + staleness + readiness; **never generates**. `source` is a JSON string. Runs the git pipeline (untracked paths via `listUntrackedPaths` not `getStatus` — the latter costs ~180 ms of ahead/behind/stat work this answer discards). |
| `POST /api/walkthrough/generate { directory, source, force?, model?, language? }` | generates (cache-hit when not `force`); joins a running job; survives client disconnects. |
| `GET /api/walkthrough/progress?directory&source` | `{ stage }` or `{ stage: null }`; memory-only. |
| `POST /api/walkthrough/cancel { directory, source }` | `{ cancelled: bool }`; aborts a running generation. |
| `GET /api/walkthrough/pr-diff?directory&source(pr only)` | GitHub's complete published diff as `text/plain`; **no** readiness checks, generated-file filtering, or local-tree reads; empty patches are 200 (`allowEmpty:true`). Used by the diff comparison view [06]. |

There is deliberately **no delete route** — regeneration covers the need, and an endpoint nothing calls rots untested.

### F.13 A server without these routes (client detection)

An unmapped `/api/*` path is proxied to the harness/OpenCode, which answers unknown paths with its embedded web UI — **HTML with status 200**. A client newer than its server parses `<!doctype` as JSON and shows `Unexpected token '<'`, which names neither the cause nor the remedy. The client checks `Content-Type` first: a non-JSON answer on **2xx or 404** becomes `code:'server-unsupported'` (rendered as "this server is older than the app; update it"); a non-JSON **5xx** keeps its own failure — a server that answered badly is not a server missing the feature, and telling someone to upgrade would send them after the wrong thing (src: packages/ui/src/lib/walkthrough/api.ts).

### F.14 Runtime availability

Web, desktop, and hosted mobile reach the routes normally. VS Code serves git through its own bridge → not offered there; the surface is gated to tablet width and above.

---

## G. Walkthrough — UI and state

### G.1 Types mirrored from the server (packages/ui/src/lib/walkthrough/types.ts)

```ts
type WalkthroughSource = { kind:'working-tree'; scope:'all'|'staged'|'working' }
  | { kind:'branch'; baseRef:string; headRef:string }
  | { kind:'commit'; hash:string }
  | { kind:'pr'; number:number; sourceRepo?:{owner:string; repo:string} };
interface WalkthroughStop { id; title; hunkIds: string[]; importance:'critical'|'normal'|'context'; prose }
interface WalkthroughChapter { id; title; icon:'bug'|'wrench'|'path'|'flask'|'doc'|'gear'; blurb; stops: WalkthroughStop[] }
interface Walkthrough { title; focus; chapters: WalkthroughChapter[] }
interface WalkthroughHunk { id; path; oldPath|null; status:'added'|'deleted'|'modified'|'renamed';
  scope; header; newStart; added; deleted; patch /* standalone patch incl. file header */ }
interface WalkthroughResult {
  source; walkthrough: Walkthrough|null; model?; language?: string|null; generatedAt?; fromCache?;
  hunks: WalkthroughHunk[]; hunkCount;
  isStale?; missingHunkIds?; staleStopIds?; uncoveredHunkIds?; readiness?; generating?;
}
type WalkthroughStage = 'collecting'|'asking'|'retrying'|'assembling';
type WalkthroughBlockedReason = 'no-model'|'no-provider-login'|'empty-diff'|'only-generated'
  |'context-too-small'|'structured-output-unsupported'|'output-exhausted';
// + client-concluded 'server-unsupported'
class WalkthroughError extends Error { code?; model?; requiredChars?; availableChars? }
```

Hunk ids are opaque on the client by design: the server owns identity; the client only matches ids to ids.

### G.2 View model (packages/ui/src/lib/walkthrough/model.ts)

`buildWalkthroughView(result)` flattens into the ordered stream: per stop, resolved `hunks` (id → look-up in the handed-down index), `missingHunkIds`, `isStale`, global 1-based `position`, chapter back-reference; plus `uncoveredHunks` (appearance order), `staleStopCount`, `isStale`. Resolution is pure id matching — a stop whose hunks are missing is not a bug to paper over, it is a stop whose code changed.

Rendering helpers: `groupHunksByFile(hunks)` — consecutive same-file hunks render as one diff block (a stack of one-hunk cards reads worse); `mergeRunPatch(hunks)` — merge bodies under one kept header (all hunks of a run share the file header; original `@@` lines preserved so inline comments capture **real** line numbers, not offsets into an excerpt); `summarizeHunkFiles` — TOC file rows with ± sums. Hunk runs render through the shared diff viewer (`fileDiffFromPatch` → Pierre-style viewer, side-by-side/inline, wrap option, language by extension, inline comments on).

### G.3 The store (packages/ui/src/stores/useWalkthroughStore.ts)

Zustand store keyed by `` `${runtimeKey} ${directory} ${sourceKey}` `` — the runtime key prevents one runtime's walkthrough being shown for another's code. Per key:

```ts
{ status:'idle'|'loading'|'generating'|'ready'|'error', stage: WalkthroughStage|null,
  result: WalkthroughResult|null, readiness|null,
  error: { message, code?, model?, requiredChars?, availableChars? }|null }
```

Cross-cutting maps: `requestedSource[directory]` — entry points outside the surface ([06] diff toolbar, PR panel) ask the surface to open with a given source; consumed on mount, replaced by the user's choice. `selectedModel[key]` / `selectedLanguage[key]` — panel state, **deliberately not persisted**: the model/language that produced what is on screen is stored with the result, and that is the better default on reopen.

Actions:

- `load(dir, source, { language? })` — read-only GET; `loading` state. **Never overwrites an entry whose status is `generating`** (a background load must not clobber a running generation's state). Aborts the previous in-flight read per key. On a response with `generating:true` — a job is running server-side; the user refreshed — **re-attaches** by calling `generate` (the job already has its own language; this only decides what a request that does *not* attach would ask for). A failed read keeps whatever was on screen (`status:'error'` while preserving `result`) — a failed read is not evidence the walkthrough is gone.
- `generate(dir, source, { force?, language? })` — `generating` + optimistic `stage:'collecting'`; polls `GET .../progress` every **1 s**, updating `stage` (a missed poll is not surfaced; the next one recovers); completion → `ready`; the request's own abort (navigate away) ends silently — client dismissal of the *connection*, not of the job.
- `cancel(dir, source)` — **explicit** `POST /api/walkthrough/cancel` (server work outlives the connection; dropping it is not stopping) + aborts the in-flight request + sets `status` to `ready` (result present) or `idle`.
- `reset()` — aborts everything (runtime switch).

`AbortController`s and poll timers live **outside** the store: aborting state is not render state.

### G.4 Client API glue (packages/ui/src/lib/walkthrough/api.ts)

`fetchWalkthrough` (GET, query `directory`, JSON-stringified `source`, optional `model`/`language`/`signal`) · `generateWalkthrough` (POST `{ directory, source, force, model?, language? }`) · `cancelWalkthroughGeneration` (POST `{ directory, source }`) · `fetchWalkthroughStage` (GET progress → stage). Error mapping per F.13, preserving `code/model/requiredChars/availableChars`; declared-JSON-but-unparseable bodies become a malformed-response error.

### G.5 WalkthroughView (packages/ui/src/components/views/walkthrough/WalkthroughView.tsx)

Nesting: resolves nested repositories first (root not a repo → resolution states / picker; `directory` used throughout is the resolved git directory). Panel width drives layout via `ResizeObserver` (the surface resizes independently of the window).

**Header.** All controls share the informational tint `WALKTHROUGH_ACTION_CLASS` (info-status background/border/text) — the walkthrough is informational, not primary/destructive, and must not compete with Review/Merge next to it; no sparkle iconography ("this is AI" is not what the button does):

1. **Source selector** dropdown, grouped: "Working tree" group label + scopes (`All uncommitted | Staged | Unstaged`), then `This branch`, `Commit`, `Pull request`. The grouping exists so "everything" visibly means *uncommitted work only* — on its own next to "This branch" it read as "all changes that exist", the opposite of what it selects.
2. Scope selectors when active: branch → `BranchComparisonSelector` (base override; changes and walkthrough share the explicit base choice and reflog detection, [06]); commit → `CommitComparisonSelector` (latest 50 commits reachable from the checked-out branch with subject/author/date/short hash; selection changes the comparison, never the checkout; full object ids are handed to the server); PR → `PullRequestComparisonSelector` (same searchable paginated selector as Changes; the list loads only while visible; a resolved repository is forwarded so cache/job keys qualify as `pr:<owner>/<repo>:<n>`).
3. PR mode: a "Diff" button opening the diff surface with `diffScope:'pr'` ([06]).
4. Help button (external guide; the guide answers "are these marks review findings?" — the first question users asked — so it is reachable from the surface itself).
5. **Language picker** (globe): per-review; resolution explicit pick → language of the walkthrough on screen → interface locale.
6. **Model selector**: per-review; resolution explicit pick → model that produced what is on screen → settings/small-model chain. Hides models whose catalog metadata says `structured_output: false` and providers without a usable login (`GET /api/small-model → authenticatedProviders`; authenticated providers fetched but unknown providers *during load are offered*); while the auth list loads, **no provider is selectable** — a flash of an unauthenticated selection was a real bug.
7. Prev/Next arrows once a walkthrough exists (keeps shortcuts fast on a narrow panel).
8. **Cancel** while generating / **Generate**/**Regenerate** otherwise (`Regenerate = force:true`). Disabled when no source is resolved, no usable model, or readiness is not ready.

**Banners** (between header and body, all `shrink-0`): generating-over-existing (spinner + stage name; the stream keeps showing old content, so this banner is the only signal); **missing language/model** — picker vs. what is on screen, shown only *after the read has settled* (claiming something is missing while still looking for it is the same flicker in another place) with a non-forced Generate (a forced run would refuse the cache it might find); **stale** — "{count} stops no longer match" + Regenerate (disabled mid-generation: re-clicking aborts the running job and starts another — the same answer paid for twice); generic error bar (`line-clamp-2`, full text on title).

**Body priority chain:** PR-needs-selection (centered empty + picker) → commit-needs-selection (spinner/error) → branch-needs-base (loading or "base branch required") → `WalkthroughBlocker(reason)` → stage list (only when the generation started from an **empty panel**; regenerating over an existing walkthrough keeps the stream + banner — hiding readable content to show progress is a downgrade) → TOC + stream → empty état (spinner while loading; icon+title+description otherwise).

**Layout numbers:** contents column only at panel width ≥ **720 px**; user-resizable (pointer drag + keyboard arrows, persisted, **clamped on read** — a remembered 400 px must not swallow a newly narrow panel; max 50% of panel; min 180 px); below 720 the stream takes the panel and header arrows navigate. Compact header below **680 px** hides control text (all controls carry identifying icons; uniform 32 px control height — three heights in one row read as misalignment, not hierarchy). A new `generatedAt` resets visited stops and the active stop — a new walkthrough is a new reading path; keeping old progress would mark stops visited that the user has never seen.

### G.6 Stages display and pacing

Rendered rows: `collecting`, `asking`, `assembling` only (`retrying` folds into `asking` from the client too). `useWalkthroughStageProgress(stage, active)` holds each step **450 ms** before revealing the next, including the final all-done state — assembling takes milliseconds and would otherwise flicker past unseen; telling the user about a step they never observe is worse than not naming it. `holding:true` keeps the list on screen briefly after completion; a run restarting at an earlier step falls back immediately (pretending the later stage still runs is a lie). The list costs well under a second at the end of a wait measured in minutes. No durations: a stopwatch on a step nobody can hurry adds pressure, not information.

### G.7 Stream (WalkthroughStream) and stops

- One continuous scroll: each stop = header (position badge, title, importance pill + tooltip, prose, staleness line) then its code. Importance is carried by **weight and outline, never status color** — a red pill reads as a *finding*, and a walkthrough hands out no verdicts (the tooltip states the axis outright).
- The file header inside a run is **sticky** — the path is the main orientation cue in a long stream, and as a plain caption it scrolled straight past.
- A stop whose hunks all fail to resolve renders an explanatory line; a stop with no hunks at all still renders (with a "no code" line).
- **Uncovered tail**: a collapsible section at the end of the stream + a count line in the TOC — the reader can always answer "have I seen everything that changed"; nothing disappears silently. Contents include post-generation edits, hunks the model judged routine, and generated files.
- **Active-stop tracking** via IntersectionObserver rooted at the scroll container with `rootMargin:'0px 0px -70% 0px'` (a stop becomes active when its header reaches the upper 30% band — prevents flicker back and forth through long diffs). TOC clicks set a navigation mute so the observer's pass-through stops cannot yank the highlight (sidebar showing step 5 while the stream shows step 6); the mute releases on arrival or a 250 ms timeout (an already-visible target may not fire at all after the jump). Jumps are `scrollIntoView({ behavior:'auto', block:'start' })` — instant on purpose (picking a step is a jump to a known destination; a long animation is a window for the highlight to drift through everything in between).
- No virtualizer: only visible stops mount their diff viewers, each stop is its own element — the DOM is the index, nothing to translate between index space and pixel space.

### G.8 TOC (WalkthroughToc)

Focus line (the model's one-line "what this change is about") at top; chapters with icons (`bug→bug, wrench→tools, path→compass, flask→flask, doc→file-text, gear→settings`); stops as rows: position pill (visited = check, success-tinted; active = inverted tint; a pill rather than a fixed circle because two-digit steps were cramped in a square), title, staleness icon (aria-labelled), up to 3 file paths + "+N more" (`summarizeHunkFiles`). `aria-current="step"` on active; `scrollIntoView({ block:'nearest' })` on active change (keeps the move minimal; clicking a visible row must not jolt the list). Uncovered count pinned at the bottom.

### G.9 WalkthroughBlocker (a refusal the user can act on)

Rendered for `context-too-small / structured-output-unsupported / output-exhausted / no-model / empty-diff / only-generated / server-unsupported`. For the "this small model cannot do this job" trio, the remedy is **in place**: a model picker (same filtering rules) whose change **writes `walkthroughModelOverride` to settings** (scoped to this feature — fixing the walkthrough must not quietly change the model behind commit messages) and reloads. Refusal texts name the model actually tried (the unnamed variant is a defensive fallback, not the norm; `context-too-small` reports required/available chars). `empty-diff`, `only-generated`, `server-unsupported` render a Refresh button. `no-provider-login` is **not** a blocker: hide the unusable model and disable Generate instead of explaining a raw provider error.

### G.10 Entry points and handoff

- Opened from the right-rail icon or the "AI walkthrough" buttons in Changes and PR panels — both just *open the panel*; nothing generates until Generate (always-user-initiated invariant).
- From Changes/PR, the selected source is carried into `requestedSource[directory]`; later selections in either toolbar update both comparisons ([06]). Walkthrough does not generate on commit selection; selecting a commit only changes the comparison.
- Status refreshes invalidate the visible branch comparison even when file names and ± counts stay the same; walkthrough refreshes its hunk index while visible (staleness shows live), regeneration stays user-initiated.
- The in-panel blocked walkthrough picker writes the feature setting (G.9); the interactive header picker does not (per-review state only).

---

## H. Dev tunnel mechanics

### H.1 Purpose

Carries **raw TCP bytes** between a desktop client and a dev server on the OpenChamber host so a remote dev server can be opened in the browser panel **without anything being rewritten**. The page is served from a real origin at the root of its own host: absolute URLs resolve, cookies scope correctly, HMR sockets connect, DevTools behaves as locally. Nothing is inspected or modified — the earlier rewriting proxy was fragile per framework and is gone (src: server/lib/dev-tunnel/DOCUMENTATION.md).

Two transports:

```
A. directly reachable runtime (http(s)):
   page → 127.0.0.1:<localPort>                    (renderer loads a real origin)
        → net.createServer in Electron main (client.js, web package)
        → WebSocket ws(s)://<hostBase>/api/dev-tunnel?port=<P>
          Authorization: Bearer <clientToken> (+extra headers)
        → host WebSocketServer → net.connect(127.0.0.1:<P>) → dev server

B. relay-only runtime (E2EE relay active):
   page → 127.0.0.1:<localPort>
        → net.createServer in Electron main (relay bridge)
        → per-connection MessageChannelMain port → trusted renderer
        → renderer opens the virtual WS through the relay tunnel
          (URL carries a short-lived url-token)
        → relay → host /api/dev-tunnel → dev server
```

The panel decides when to tunnel; the module never chooses a target (devTunnel.ts).

### H.2 Host end (runtime.js)

- Upgrade path exactly `/api/dev-tunnel?port=<1..65535>` — the URL-token allowlist accepts the path itself, **not subpaths**.
- Concurrency cap **64** open sockets, **per host** (one page load opens many sockets; a per-page cap misfires on an SPA with many connections).
- A stalled connect times out at **5 s**; while the WS is pending, upstream reads pause when `socket.bufferedAmount > 1_000_000` (a fast response against a slow client must not buffer a body in memory) and resume on a 20 ms poll.
- Closing either end closes the other — a half-open pipe leaves the page waiting on bytes that never arrive.
- **Reachability re-checked on every upgrade** (never cached): dial allowed only when dev-server discovery *currently* reports that port — a dev server that stops listening stops being reachable, and the reachable set is exactly what the user's list is built from, never "any loopback port". Refusals are logged with the port (`refused port <P>: not reported by dev-server discovery`) and returned 403 "That port is not an available dev server" (an empty response in the panel with nothing anywhere explaining why is what the log prevents).

**Auth matrix** (src: runtime.js `_131-175_`):

| Incoming WS upgrade | Requirement |
|---|---|
| Has `Origin` header (browser context) | normal origin allowlist — a CSRF defence: a hostile page can make a browser open a WebSocket carrying ambient cookies, and the origin is what exposes it |
| No `Origin`, auth context `type === 'client'` | allowed (the desktop main process, bearer token) |
| No `Origin`, `auth.type !== 'client'` | 403 "Client authentication required" |
| No `Origin`, short-lived **URL token** | allowed only for the exact allowlisted path `/api/dev-tunnel` (trusted renderer through the relay; H.3) |

Auth disabled on the server → no auth requirement (local single-user behavior).

### H.3 Relay branch (Electron; [08] E2EE, [09] shell)

`packages/electron/relay-dev-tunnel.mjs` — bridge in Electron main:

- `open({ targetKey, remotePort, webContents })` binds loopback ephemeral (`port 0`), keyed `webContentsId|targetKey|port` (reuse on repeat open); tunnels close when the webContents dies; `closeForWebContents(id)` and `closeAll()` on endpoint switch/quit.
- Each accepted socket is **paused immediately**; a `MessageChannelMain` pair is created; one port is handed to the trusted renderer via `webContents.postMessage('openchamber:relay-dev-tunnel-connect', { connectionId, remotePort }, [port2])`.
- Port-message protocol: `ready` (renderer socket open → `socket.resume()`), `data` (`Uint8Array`), `close`. A connection not ready within **15 s** is closed.
- Renderer side (devTunnel.ts): on `connect`, refreshes the short-lived URL token (`refreshRuntimeUrlAuthToken(getRuntimeApiBaseUrl())`), opens the virtual WS through the relay tunnel client with URL `…/api/dev-tunnel?port=<P>`, and pipes port bytes ⇄ socket bytes; errors/closes propagate `close` to the bridge. Handling relay credentials in the **renderer keeps encryption in its existing owner** instead of duplicating it in Electron main.

Panel-side cache invalidation: `subscribeRuntimeEndpointChanged → resetDevTunnelCache()` clears local-port maps and pending relay connections and calls `desktop_relay_dev_tunnel_close_all` — cached *ports* keyed by base URL would still resolve arithmetically, but the shell's listeners belong to the previous endpoint; holding their ports would keep resolving URLs to a host the user has left.

### H.4 Panel-side decision logic (devTunnel.ts)

- `resolveBrowsableUrl(url)`: (1) non-desktop, non-loopback, or empty → unchanged; (2) runtime base URL local or equal to `window.__OPENCHAMBER_LOCAL_ORIGIN__` → unchanged (tunneling a local runtime only adds a hop); (3) loopback port (implicit 80/443 counted) + cache key `` `${baseUrl}|${port}` `` → reuse mapped local port; (4) `desktop_dev_tunnel_open { baseUrl, port, relay, targetKey, clientToken, requestHeaders }` → `{ localPort, reused }`; map `http://localhost:<P>` → `http://127.0.0.1:<localPort>` (same path), remember original origin; (5) **failure throws `DevTunnelUnavailableError` — never falls back to the plain URL.** On a remote instance that substitution changes which machine answers and would show local content under the address the user asked for; the refusal is often authoritative (discovery unavailable / port not offered / auth rejected) and must not look like a page. The panel renders a dedicated failure overlay (C.7).
- `shouldTunnelLoopbackUrl(url)`: same guards **plus** skip when the port is already a tunnel port (`originByLocalPort`) — a page sending the view to another local port on the *host* (a docs server behind a dev gateway, an API on its own port) must be retargeted; the tunnel's own ephemeral port is *this machine*, deliberately. Used in `will-navigate` (prevention) and one-shot `did-fail-load` recovery per URL (server redirects cannot be caught before they happen); the user submitting an address resets the recovery budget; automatic retries do not.
- `toDisplayUrl(url)`: `127.0.0.1:<mappedPort>` → original origin + path/query/hash. Without this the tunnel's random local port would show in the address bar and be persisted as the tab's target — a port that means nothing after a restart.

### H.5 Direct-transport client details (client.js, web package)

Lives in the web package because it needs a WebSocket client the package already depends on; the Electron shell imports it dynamically on first tunnel use ([09]). Keyed `baseUrl|port` (reuse returns `{ localPort, reused:true }`). Per connection: the local socket is **paused during the WS handshake** and its bytes buffered, bounded at **256 kb** (enough for a request with generous headers, far short of a body worth holding — a local process could otherwise keep writing into a stalled handshake and grow the desktop app's memory without limit); handshake timeout **15 s**; overflow destroys *that* connection only (one failed connection cannot take the tunnel down). `toWebSocketUrl` rejects base URLs whose protocol is not http(s) *before* converting: the WHATWG URL silently ignores a protocol assignment crossing from a non-special scheme (relay-virtual URLs, app protocols) to `ws:`, and the stale scheme surviving into `new WebSocket(...)` throws inside the connection handler — an uncaught exception that would crash the whole process; converting a relay-virtual URL silently keeps the stale scheme otherwise. Binds `127.0.0.1` ephemeral; listener errors are logged, not fatal.

### H.6 Contract summary

| Message | Direction | Meaning |
|---|---|---|
| `openchamber:relay-dev-tunnel-connect {connectionId, remotePort} [+port2]` | main → renderer | new relay-tunneled TCP connection, port transferred |
| `{ type:'ready' }` | renderer → main | virtual socket open; resume local socket |
| `{ type:'data', data: Uint8Array }` | both | tunnel bytes |
| `{ type:'close' }` | both | connection gone |
| `desktop_dev_tunnel_open { baseUrl, port, relay, targetKey, clientToken, requestHeaders } → { localPort, reused, url }` | renderer IPC → main | direct or relay branch |
| `desktop_dev_tunnel_close { baseUrl, port } → { closed }` | renderer IPC → main | direct branch |
| `desktop_relay_dev_tunnel_close_all → { closed }` | renderer IPC → main | endpoint switch |

---

## I. Celebration feedback (fireworks)

- **Trigger:** a commit-and-push flow that ends with a successful push fires `triggerFireworks()` (src: packages/ui/src/components/views/GitView.tsx `_1259-1262_`, after the "pushed to upstream" toast). Pushing without the commit action does not.
- **Provider:** `FireworksProvider` wraps the app shell (web app and VS Code app) exposing `useFireworksCelebration() → { triggerFireworks, dismissFireworks }` (src: contexts/FireworksContext.tsx).
- `useFireworks({ durationMs = 3400 })`: `isActive` + monotonic `burstKey` (cycle counter) to remount the animation per trigger (overlapping triggers restart cleanly); auto-dismiss after 3.4 s; unmount-safe timer cleanup.
- `FireworksAnimation` + `styles/fireworks.css`: full-screen `pointer-events-none` `aria-hidden` overlay; **3 bursts** (left 22%,58% delay 0 radius 120 `--status-success`; center 50%,42% delay 120 ms radius 150 `--primary-base`; right 78%,55% delay 200 ms radius 130 `--status-info`); **12 particles** per burst, evenly on the circle, 18 ms stagger; colors are theme CSS variables (particle sparkle via `::after`), per-burst duration via `--fireworks-duration-ms` (default 900 ms, `firework-pop` ease-out forwards); `data-muted="true"` variant reduces the effect. Pure CSS + transforms (no canvas, no layout reads).

---

## J. Security model

Enforced in core/runtime logic, not only in UI visibility (src: AGENTS.md always-on constraints).

### J.1 The previewed page is a guest, not privileged

- Previewed pages render in the dedicated Chromium partition `persist:openchamber-browser` inside `<webview>` or a sandboxed iframe (`allow-scripts allow-forms allow-same-origin allow-popups`). The app's own origin, cookies, and auth are not the page's.
- Pages run with **the target site's real logins** (the partition persists). The web tool's description says so to the agent: "The page runs with the user's real logins, so treat what you see as their live session." No OpenChamber credential of any kind is reachable from a previewed page, and **no UI credential is ever injected into one** (invariant J.7 #1).
- Popups are absorbed into the same view.

### J.2 Inspection capability is connection-scoped and opt-in

- A client drives a page **only** if its SSE stream declared `browser=1`, which only a Chromium host sets; the flag lives and dies with the connection — no setting, no restart, nothing to remember to disable (src: browser-control DOCUMENTATION.md).
- The agent-facing tool is separately toggled (`agentWebToolEnabled`, Settings → General → OpenCode CLI; on by default; applies on next managed harness restart; [14]). Disabling removes the tool **and its parameters** from the schema, so a disabled capability leaves no visible half-lit inputs.
- `browser.open` needs any connected client; everything else needs a capable one. Broadcast + claim guarantees at most one client acts, even with two desktop clients connected — the losing client must do nothing, and a client cannot act before its grant.

### J.3 What the injected inspection script can access

Both the page-action scripts and the annotation overlay execute in the **page's own realm** with page privileges — the same capabilities the page itself has. Bounds:

- Inputs are JSON-stringified into the script text: a selector or typed value can never terminate the expression and become code.
- The annotation overlay keeps its UI in a **closed shadow root** on one fixed host; page CSS cannot restyle it and page scripts cannot walk into it. While active it blocks the page's own input events; it reads only what its interaction needs (element under cursor, bounds, computed styles — the same data the browser-action scripts read).
- Scripts make no calls back into OpenChamber (no bindings to the panel; results travel as the single `executeJavaScript` return value) and nothing of OpenChamber's origin leaks into them.
- Screenshots are per-tab guest captures; no window titles, host paths, or app state ride along.

### J.4 Dev-tunnel restrictions

- The reachable set equals the discovery list, **re-validated at every upgrade** — an authenticated client can never dial an arbitrary local service (a database, an admin panel, the harness API) through the tunnel. `ownPorts` (app + harness ports) are excluded from discovery, so the harness endpoint itself is unreachable by construction.
- Auth per the H.2 matrix: browser-originated upgrades must pass the origin allowlist (CSRF defence against ambient-cookie WebSocket forgery); non-browser clients need the client token; relay-virtual sockets carry a short-lived URL token honored **only** for the exact path `/api/dev-tunnel` (subpaths rejected).
- The tunnel is deliberately absent from the "safe for remote pages" IPC set — a remote page can never open a local listener.
- Concurrency is capped per host (64); connect and handshake stalls are bounded; buffer backpressure prevents memory growth from a stalled peer.

### J.5 Screenshot writes and the filesystem

`browser.capture` writes only under `<project-directory>/.openchamber/screenshots/`; the agent-supplied `label` becomes a slug of `[a-z0-9-]`, ≤48 chars — `..`, separators, and leading dots cannot survive, because the value reaches the filesystem (D.9). The returned path is project-relative; who can fetch the file back is governed by the image-grant serving subsystem ([03]/[05]), not by the tool.

### J.6 Walkthrough data safety

- Model input = the diff digest only: hunk bodies from the working tree, paths, statuses, line ranges. No environment, workspace secrets, or grant tokens in the prompt. Generated files are excluded from model input but still counted and rendered client-side.
- The system prompt demands a single JSON object; the schema + alias resolution mean model text can never introduce anchors; model prose is rendered as text, never executed.
- Cache/pointer files live under the user data dir; atomic writes; corrupt reads are misses; pruning deletes only pointers whose repo is provably gone.

### J.7 Security invariants (acceptance checklist)

1. Preview never leaks host credentials to the inspected page.
2. Inspection rights exist only while a capable connection exists (connection-scoped, opt-in, never persisted) *and* the tool is enabled in settings.
3. Eager dev-server detection never false-positives: sockets are ground truth; announcements are gated by availability probes and per-run lifetime; infrastructure and own ports are excluded; no scan or announcement happens for anything the user did not start.
4. Walkthrough cancellation is explicit; orphan generations are bounded by the scaled deadline; jobs outlive abandoned clients by design and write results for later re-attach.

---

## K. Edge cases and invariants (consolidated)

1. A failed discovery scan is never rendered as an empty list (B.1).
2. Discovery never offers the app's/harness's own ports or the ignore list ports (B.3).
3. A tunnel that cannot open is stated, never replaced by the plain loopback URL (H.4).
4. A loopback URL typed against a remote server resolves through the tunnel to the *host's* machine; the address bar always names the machine the user means (H.4).
5. A tunnelled page navigating to a new loopback port retargets to the host; server redirects that evade `will-navigate` are recovered once per URL from `did-fail-load`; a genuinely dead port still fails honestly (H.4).
6. `browser.open` may create the tab; every other action must act only after a claim (D.2–D.4).
7. Nobody listening ⇒ immediate descriptive 503 — never a blocked wait dressed as a page hang (D.2).
8. A client that accepted and vanished still times out; a late result is `matched:false`, not an error (D.2–D.3).
9. Snapshot caps are reported (`textTruncated`, `elementsTruncated`, `interactiveElementsOnPage`) — a partial answer never reads as complete (D.6).
10. Console problems are per page load, capped, and attached to snapshots only (D.8).
11. Sub-frame failures and `ERR_ABORTED` never surface as errors (C.3).
12. Startup waits cover both "nothing listening" and "gateway 5xx", bounded and loopback-only (C.5).
13. Crash recovery is bounded (3 / 30 s / doubling delay) and survives re-attach (C.3).
14. Screenshot filenames cannot carry paths or traversal (D.9, J.5).
15. `capturePage()` on a hidden/zero-width webview is pre-empted by revealing the tab and waiting for a stable composited width (D.6).
16. Resize applies before its result reports, and snapshots carry the viewport so before/after states cannot be confused (D.6, C.8).
17. Annotation payloads are validated at the boundary; the screenshot keeps the whole page (D.7).
18. Composer ordering: image attached before text; the text claims only what actually attached (D.7).
19. Walkthrough input truncation is refused (`context-too-small`), never clipped; output budget equals the input reserve (F.7).
20. Hunk ids are server-owned; the client never recomputes them — two drifting id algorithms would mis-anchor every stop forever (F.2, G.1).
21. The cache is content-addressed on the current diff; staleness is a miss; switching model/language and back returns the earlier review without a model call (F.9).
22. Regeneration re-authors (previous walkthrough as prose, anchors stripped) — splicing was rejected for producing contradictory, invisible seams (F.5).
23. Generation outlives the request; re-generate attaches instead of restarting; only explicit cancel aborts (F.10, G.3).
24. Progress polling is memory-only; the full read is never polled (F.10, F.12).
25. `retrying` is folded into `asking` in the UI; stage floors make each step observable (F.10, G.6).
26. The picker never offers models lacking structured output or provider logins; during auth-list load no provider is treated as authenticated (G.5, G.9).
27. A non-JSON 2xx/404 means "server too old" and says so; a non-JSON 5xx keeps its own error (F.13).
28. Pointers are pruned only on provable repo removal, asynchronously and capped, never on the request path (F.9).
29. The dev tunnel dials only currently-discovered ports, capped, with bounded stalls and backpressure (H.2).
30. Tunnel caches/listeners are torn down on runtime endpoint change (H.3–H.4).
31. The webview's initial navigation rides in `src` at creation, so background tabs load (C.3).
32. Scrolls read back after settling and report the limits; `scrollY: 0` from a working scroll is never emitted (D.6).

---

## L. Build checklist

Ordered so each layer is testable as it lands; named tests are the equivalents the original ships beside its sources.

**Platform/protocol (server):**

1. Listening-socket enumeration + the three parsers with the shared filter semantics (B.2). Tests: table-driven parse cases — grouped `lsof` records, IPv6 brackets, wildcard binds, `->` guard, ignore list, own-port/pid exclusion.
2. Scan failure serialization (`{ok:false, reason}`), TTL caching of successes only, 2.5 s scan timeout, `GET /api/dev-servers` with caller-provided own ports.
3. `POST /api/system/probe-url`: loopback-only parse, auth gate, 1.5 s timeout, redirect-manual, `ok = 200..599` (assert it sits **before** the global `/api` auth middleware is *not* the case — it gates internally, and must).
4. Browser-control broker: pending map, claim exclusivity (first wins; claims on settled ids refused), `matched:false` for late results, `rejectAll`, zero-listener 503, bounded timeouts, abort ⇒ 499. Both callbacks with 4 kb / 2 mb per-route body limits and their own JSON parsing.
5. `emitRequest` capability counting (`browser.open` any; others `browser=1`), SSE envelope, client drop on write error.

**Harness integration (`[HARNESS PORT AGENT-CALLBACK]`):**

6. `openchamber_web` tool for your platform: ten actions (D.5), parameter schema restricted to `url, selector, text, value, submit, direction, viewport, label`, per-child loopback-only bearer callback, envelope `{ schemaVersion:1, ok, action, data|error }`, action-set-scoped bare-name resolution, abort propagation. [02], [14].
7. Control-service `browserAction` validations (D.5) + capture→file writer (D.9) + hint string; 45 s for open, 20 s otherwise.

**Client (browser surface):**

8. URL/viewport primitives + tests: `normalizeBrowserUrl` (loopback→http), `isLoopback`, labels; presets, fit/scale downward-only, mode vocabulary, `viewportSummary`.
9. Navigation status machine + crash-recovery policy as pure functions with tests; webview/iframe transports; toolbar/device bar/empty state.
10. Startup-wait logic (retryable-code set, gateway probe, budgets, `servedOk` latch) with a fake probe.
11. Control client (claim-before-act, opener fallback attach-poll) with tests including "loser does nothing" and "open-then-resize attach window".
12. Page-action script builders: string-level tests asserting embedded JSON, caps, and selector-builder shape; runtime scripts against DOM fakes.
13. Annotation: overlay script (a source-scan test pins the teardown-before-resolve two-frame order — the original's test re-reads the component source for exactly this invariant), payload validators, screenshot compositor (ratio-scaling cases; clamped width; accent fill must be pre-resolved), prompt formatter snapshots, composer attach order.
14. Console problem capture (reset per load, cap 20, level mapping).

**Dev tunnels:**

15. Host runtime: auth matrix (H.2), path parse, 64-socket cap, discovery-gated dial re-checked per upgrade, backpressure, teardown symmetry — tests with a fake WS + TCP server.
16. Direct client: bind/reuse/close, 256 kb pending buffer, 15 s handshake, scheme-conversion guard, per-connection failure isolation.
17. Relay branch: bridge open/reuse/`closeForWebContents`, 15 s readiness budget, `ready/data/close` protocol; renderer wiring incl. endpoint-change invalidation.
18. Panel decision logic `resolveBrowsableUrl / shouldTunnelLoopbackUrl / toDisplayUrl` + `DevTunnelUnavailableError` surface (local-runtime no-op, cache reuse, implicit-port mapping, retarget skip for tunnel ports, no-fallback-on-failure).

**Walkthrough:**

19. Hunk parser + id derivation (repeat-occurrence suffix, scope prefix) — golden patch tests. Stub `[HARNESS PORT SSM-1/SSM-2]` for tests.
20. Digest builder + generated-file matcher (name-only; conservative table tests).
21. Prompt builder (sizing, source lines, language instruction, previous-walkthrough outline) + schema/normalizer (unknown-anchor drops, cap enforcement, enum fallbacks, fence-tolerant JSON parse, invalid → `invalid-walkthrough`).
22. Store: cache key composition, eviction (200/50 MB LRU on write), pointer semantics, atomic writes, corrupt-read-as-miss, ENOENT-only async capped prune.
23. Orchestrator: model chain, the seven readiness reasons, budgets (context-share derivation, catalog output cap), schema-fallback retry + `schemaRefusedBy` memory, job registry attach/cancel/stages, scaled timeout — all against a fake model port.
24. Routes (F.12) + client content-type detection (`server-unsupported`).
25. Client store + view model + panel (G.2–G.9): id matching, stale counting, stage pacing (450 ms floors), TOC/stream scroll interplay, blocker reasons, attach-on-`generating`, cancel semantics.
26. Wire routes into your route table with the JSON-body allowlist ([03]); add a source-level test that the server language tags equal the UI locales (the silent-wrong-language failure mode F.5 guards).

**Effects:** fireworks provider/animation with burst config; unit-test the `useFireworks` timer cycle (dismiss, remount key).

**Final security pass:** walk J.1–J.7 as acceptance criteria.

---

## Cross-reference recap

- [02] Agent harness: tool registration, callback envelope, per-child token, action-set resolution, SSE sources.
- [03] Global routes: `/api/dev-servers`, `/api/system/probe-url`, walkthrough routes, JSON body-parser allowlist, fs/grant boundaries.
- [05] Composer consumption: annotation drafts, image attachments, how `![](path)` renders under an answer.
- [06] Diff surface: shared sources and comparison selectors, plan/diff surfaces carrying inspection payloads.
- [07] Terminal: URL extraction grammar (`extractTerminalPreviewUrl`, `extractProjectActionUrl`), announced-tail handling, probe behavior.
- [08] Relay: E2EE tunnel client, URL-token minting and duration, virtual WebSocket URLs.
- [09] Electron shell: webview task manager, capture/IPC commands, debugger color-scheme emulation, tunnel IPC exclusion from the remote-safe set.
- [14] Settings: `agentWebToolEnabled`, `agentControlToolEnabled`, `walkthroughModelOverride`, project actions `autoOpenUrl/openUrl`.

**Known gaps in this document (v1):** exact i18n copy for the walkthrough and browser surfaces (the semantics of every message is specified inline; implementors write their own strings); exact CSS of the TOC resize handle; the Pierre diff viewer internals (owned by the diff volume); relay URL-token mint mechanics (owned by [08]); Windows `netstat` pid-name resolution (the original leaves `command` empty on Windows); per-provider small-model wire formats (owned by [02]); extending the generated-file matcher to other ecosystems (do it conservatively, per F.4).
