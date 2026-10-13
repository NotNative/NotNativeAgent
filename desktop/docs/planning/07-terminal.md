# 07 — Terminal

> **Reference status — 2026-10-01:** This document records OpenChamber behavior.
> Execute [the NND build guide](../build/PLAN.md) and its native-contract amendments.
> Reference auto-accept, managed-harness, TUI, and process-ownership details do not
> override NNA governance or the independent NNA/NND product boundary.
> Use the [document disposition audit](../build/EXECUTION/01-architecture-audit.md)
> and feature coverage guide before treating a reference requirement as executable work.


Cleanroom re-implementation specification for OpenChamber's terminal subsystem: server-side PTY
management, the binary WebSocket transport, the browser-side libghostty-vt emulator/render stack, the
tab/dispatch UI, cross-device reattach, and project actions executed in terminals. Everything needed
to rebuild this subsystem on a different agent harness is in this document.

Audience: engineers with **zero access to the OpenChamber repository**. Every protocol byte, constant,
message shape, and timing value is spelled out inline. `(src: ...)` citations are for traceability
only — do not rely on them for semantics.

Cross-notation: numbers without units are exactly as implemented. "Seq" is the per-terminal
monotonically increasing event sequence. "PTY size" always means `{cols, rows}`.

## 0. Ownership and cross-references

This document OWNS:

- Terminal session mechanics: create/attach/detach/write/resize/restart/close/idle/force-kill.
- The terminal wire protocol (frames, heartbeat, sequence semantics, snapshot replay rules).
- PTY spawn choices per runtime/platform (node-pty vs bun-pty, Windows ConPTY), env construction,
  shell discovery and fallback chains.
- The emulator/renderer stack (libghostty-vt via a browser adapter), fonts, theme mapping.
- Terminal UI: tabs, viewport, keyboard/IME/clipboard/selection/scroll, mobile differences.
- Project ActionTerminal execution flow: how a project-defined command is run in a terminal, watched,
  stopped, and how its exit is captured (the actions *list/inventory UI* is 12's).

This document DOES NOT own:

- Server route registration, auth middleware list, global rate limits, relay hosting (03).
- The agent harness contract itself (02). Terminal never talks to the harness — see §1.
- Mobile touch UX detail (11): this doc states the mechanisms; 11 owns gesture feel.
- Theme tokens (14): the mapping *into* terminal colors is here; tokens come from 14.
- Browser/dev-server preview pane (13): URL *extraction* from terminal output is here; the preview
  surface is 13.
- Project actions inventory/settings UI (12).

| Document | Shares with this doc |
|---|---|
| 02 harness | cwd/project-directory provenance; where agent activity comes from instead |
| 03 server | `/api/terminal/*` route registration, auth gates, WS allowlists |
| 11 mobile | touch-gesture parameters, keyboard behavior |
| 12 actions UI | action definition/editing UI, inventory |
| 13 preview | preview browser pane consuming URLs found here |
| 14 theme | token values (the terminal color table consumes them) |

## 1. Harness boundaries (MUST KEEP)

Label every boundary so a team swapping OpenCode for their own harness preserves the architecture:
**the terminal subsystem has no dependency on the agent harness, and the harness has no dependency on
the terminal.**

1. **PTYs are OpenChamber-owned, not harness-owned.** A terminal session is a plain PTY running a
   user shell (or a one-shot command). The agent harness never reads, writes, or spawns these PTYs.
2. **Agent command execution is separate.** When the agent runs commands (build/dev/tools), it uses
   its own exec mechanism (harness tool). Do not route harness commands through the terminal WS; do
   not project harness tool output into terminal sessions and vice versa. Terminal output is never
   parsed to decide what the *agent* is doing.
3. **"Session working" state never derives from terminals.** Live agent activity is derived from live
   harness/agent event channels only (SSE in the reference design; see 04). Terminal observability
   (`/api/terminal/sessions`, §F) exists only to drive the terminal tab UI and a "project action
   running" indicator — never agent status.
4. **The only permitted couplings** (all one-directional UI context, never state):
   - The terminal's `cwd` is the effective project directory the rest of the app shows (session
     context directory, or an explicit target directory).
   - A terminal text selection can be attached as "inline comment draft" context to the chat composer
     (§Flow 5). It travels in the *user message payload*, not the agent state.
   - Project actions (§G) are user-initiated; the check "is an action running" polls terminal session
     listings. This indicator is UI-only.

If your harness runs commands itself inside one of OpenChamber's terminal sessions: do not. Keep the
RX/TX channel and process ownership separate exactly as specified here; only the project-directory
value crosses.

## 2. A. Architecture

### 2.1 Three layers

```
Browser/renderer                    Server (Node or Bun or Electron host)         OS
─────────────────                   ─────────────────────────────────────         ──
GhosttyTerminalCore  (WASM VT)  ◄──  session registry + history trimmer  ◄──  PTY child
GhosttyTerminalSurface (canvas) ──► WebSocket /api/terminal/ws (v3 JSON)  ──►  shell (login/user shell)
TerminalViewport (React host)   ──►  HTTP command plane /api/terminal/*            or `shell -c "command"`
useTerminalStore (tabs/buffers) ──►  session observer (HTTP poll /sessions)
TerminalTransport (single WS)   ──►  command plane: create/resize/...
```

- **One WebSocket per client**, shared by every concurrently attached terminal on the device; many
  attachments per socket; writes are addressed by session id (no per-socket single-terminal state).
- **HTTP is the command plane** (create, resize, appearance, restart, close, force-kill, shells,
  session list, touch). There is no SSE output channel and no HTTP input channel — output and input
  go only through the WS.
- Route registration, auth middleware ordering, and the server allowlists are 03's, but the
  terminal-specific gates are restated in §H because they are protocol-critical.

### 2.2 Module map (what to build, in what package)

| Module | Responsibilities | Reference position (src) |
|---|---|---|
| `terminal/PTY manager` (server) | session registry,.create/restart/close/idle, history trim, sanitizer, theme-query answering, publish fan-out, snapshot | web/server/lib/terminal/runtime.js |
| `terminal/shells` (server) | shell id allowlist, discovery, auto fallback chain, argv build for interactive/command/login modes | web/server/lib/terminal/shells.js |
| `terminal/history sanitizer` (server) | strip VT query/reply sequences from replay bytes; carry incomplete sequences across chunks | web/server/lib/terminal/history.js |
| `terminal/theme-response` (server) | answer OSC 10/11 color queries, Mode 2031 negotiation, DA1 fallback, mode-report on theme change | web/server/lib/terminal/theme-response.js |
| `terminal/ws protocol` (server+client) | frame tag/JSON envelope, 64 KiB cap, path constant | web/server/lib/terminal/terminal-ws-protocol.js |
| `inherited env sanitizer` (server) | strip `ARGV0`, `NODE_CHANNEL_FD`, `ELECTRON_RUN_AS_NODE`, `BASH_ENV`, `ENV`, `BASH_XTRACEFD`; POSIX `env -u` launch wrapper | web/server/lib/inherited-env.js |
| `terminalApi transport` (client) | one WS, subscribe/attach, projection cache, reconnect policy, write path, HTTP commands | ui/src/lib/terminalApi.ts |
| `TerminalViewport` (client) | React host of the surface: chunk replay, context menu, touch gestures, clipboard races | ui/src/components/terminal/TerminalViewport.tsx |
| `useTerminalStore` (client) | directory → tabs, buffers, project-action lifecycle, persisted tab strip | ui/src/stores/useTerminalStore.ts |
| `TerminalView` (client) | panel component: tab strip, quick keys, create/attach orchestration, restart, preview scan | ui/src/components/views/TerminalView.tsx |
| `ghostty adapter` (client) | single WASM runtime; per-terminal core; canvas surface: DOM, input, selection, links, scrollbar | ui/src/lib/ghostty/*.ts |
| `terminalSessionObserver` (client) | 5 s polling loop over `GET /api/terminal/sessions` with dedupe per adapter | ui/src/lib/terminalSessionObserver.ts |
| `projectActionTerminal` (client) | command normalization, create-with-purpose, stop (Ctrl+C → wait → force-kill), authority reconcile | ui/src/lib/projectActionTerminal.ts |
| `terminalPreview` (client) | loopback URL extraction from output + availability probe | ui/src/lib/terminalPreview.ts |
| runtime adapter TerminalAPI | per-runtime façade implementing the shared `TerminalAPI` contract | web/src/api/terminal.ts; vscode/webview/api/index.ts |

`TerminalAPI` is the shared contract the UI consumes (it must exist on every runtime):

```ts
interface TerminalAPI {
  listShells?(): Promise<TerminalShellOption[]>;          // { id, name, supportsLogin }
  listSessions?(cwd: string): Promise<TerminalServerSession[]>; // cwd "" = all dirs
  touchSessions?(sessionIds: string[]): Promise<void>;
  createSession(options: CreateTerminalOptions): Promise<TerminalSession>;
  connect(sessionId: string, handlers): Subscription;     // stream events
  sendInput(sessionId: string, input: string): Promise<void>;
  resize(payload: { sessionId, cols, rows }): Promise<void>;
  updateAppearance?(sessionId: string, appearance): Promise<void>;
  close(sessionId: string): Promise<void>;
  restartSession?(currentSessionId: string, options): Promise<TerminalSession>;
  forceKill?(options: { sessionId?; cwd? }): Promise<void>;
}
```
(src: packages/ui/src/lib/api/types.ts:116)

Runtime behavior is explicit, not incidental:

- **web** (browser + the desktop app's local server + phone driving a web server): full implementation
  (src: packages/web/src/api/terminal.ts:23).
- **desktop (Electron)**: the server runs in-process in the Electron host; the UI uses the same web
  adapter over the loopback URL — same auth gates, same WS path (see 03 for the packaging).
- **VS Code**: unsupported by design. Every method throws "unsupported"; `TerminalView` is not
  mounted (src: packages/vscode/webview/api/index.ts:16, packages/vscode/src/DOCUMENTATION.md:167).

## 3. B. Wire protocol specification

### 3.1 Endpoint and framing

- Path: **`/api/terminal/ws`** (exact string; allowlisted for WS in the URL-token auth gate and the
  private-relay tunnel) (src: terminal-ws-protocol.js:1, ui-auth.js:311, relay/tunnel-host.js:33).
- Protocol version: **`v: 3`** on every frame. A frame whose `v !== 3` is dropped as invalid.
- Transport frame format (BOTH directions): a **binary WebSocket message** whose first byte is
  `0x01` (JSON tag) followed by UTF-8 JSON.
  - Client must reject/handle text frames and tag != 1 by sending a non-fatal error frame
    `{t:"error", code:"BAD_FRAME"}` (server) or ignoring (client). (src: runtime.js:362,
    terminalApi.ts:109)
  - Maximum WS payload: **65,536 bytes** both directions (`maxPayload` on the server WS; input cap
    below). (src: terminal-ws-protocol.js:3)
- The client must open the socket through the runtime URL/WS helper (resolver + short-lived
  URL-scoped token `oc_url_token` in the query string on the browser; raw `new WebSocket` is
  forbidden — it breaks the authenticated-asset and relay transports; see 03 §auth).

### 3.2 Server → client messages

| `t` | Purpose | Fields |
|---|---|---|
| `hello` | sent immediately on connection accept | — |
| `snapshot` | authoritative state; ALWAYS the first event for a terminal after `attach`, and after re-connect | `s`, `q` (current seq), `history` (bounded replay text), `cols`,`rows` (PTY size the history was drawn for), `status` (`running`/`exited`/`error`), `exitCode?`, `signal?`, `mode?`, `purpose?`, `runtime?` (`node`/`bun`), `ptyBackend?` |
| `output` | live PTY bytes | `s`, `q`, `d` (raw bytes as a JS string, lossy-UTF8-safe), optional `r` = replay-safe variant with VT query exchanges removed (present only when different from `d`) |
| `exit` | PTY process ended | `s`, `q`, `exitCode` (number or absent), `signal` (number or absent) |
| `restarted` | interactive restart completed; screen resets | `s`, `q`, `history: ""` |
| `error` | protocol or per-session error | `s?` (session id; absent = socket-level), `code?`, `message?`, `fatal?` (true → attachment is unusable) |
| `pong` | response to client `ping` | — |

Error codes the client responds to (exact strings):

| code | fatal | Client behavior |
|---|---|---|
| `SESSION_NOT_FOUND` | yes | terminal id unknown → reset tab to idle (interactive tabs) or mark exited (action tabs) |
| `BAD_FRAME`, `BAD_INPUT`, `NOT_RUNNING`, `WRITE_FAILED` | no | shown/ignored per surface; NOT a teardown |
| `CLOSED` | yes | terminal deleted by explicit close |
| `KILLED` | yes | force-killed |
| `IDLE_TIMEOUT` | yes | idle-reaped server-side |
| `SUPERSEDED` | yes | replaced by a new run of the same project action (client treats as benign: exit silently) |

(src: runtime.js:179–388, TerminalView.tsx:449–467)

### 3.3 Client → server messages

| `t` | Fields | Semantics |
|---|---|---|
| `hello` | — | client greeting; server ignores |
| `ping` | — | answered with `pong`; app-level keepalive |
| `attach` | `s` | register this connection as a viewer of terminal `s`; server replies with `snapshot` then buffered events (§3.5). One socket may attach many terminals; attach is idempotent per socket |
| `detach` | `s` | remove only this attachment; other viewers unaffected; socket stays open |
| `write` | `s`, `d` | raw UTF-8 bytes for the PTY; 1 ≤ len ≤ 65536; only when `status=running`; refreshes session `lastActivity` |

Server validations (src: runtime.js:361–386): non-binary or non-JSON or wrong version → `BAD_FRAME`
(non-fatal). `write` without session id → `BAD_FRAME`. `write` to unknown session → fatal
`SESSION_NOT_FOUND`. `write` while not running → `NOT_RUNNING`. Failed PTY write → `WRITE_FAILED`.

### 3.4 Sequence and replay rules (normative)

- Every `output`/`exit`/`restarted` event increments the session's **sequence** `q` by 1, starting at
  1. `snapshot.q` equals the last applied sequence; the snapshot itself is not an increment.
- A client NEVER renders an event with `q ≤ lastSequence` for the same subscription (dedupe even when
  attached twice or on tab switch replay).
- The server history (§C.5) plus each event's `r` field define the **full authoritative replay text**:
  `history + Σ r` (using `r` when present, else `d`) reproduces the emulator state as the shell left
  it, without printer-visible query exchanges.
- `snapshots` and `output.r` are clean of: OSC `10`/`11`/`12` query+reply exchanges, DSR/DA/CPR
  (`CSI n`, `CSI ... R`, `CSI c`) exchanges, and Mode-2031 (DECRQM) query, report, and set/reset
  sequences (`CSI ? 2031 h/l`, `CSI ? 2031 $p`); **incomplete control sequences spanning chunk
  boundaries are carried over** so a sequence is never stripped half-cut or left duplicated. Live
  bytes `d` remain byte-for-byte unchanged. (src: history.js:1–83)

### 3.5 Attach/snapshot barrier (normative)

On `attach`, the server forms the attachment in `initializing` state **before** capturing the
snapshot; concurrent events get buffered; then it sends `snapshot`; then it flushes buffered events
whose `q > snapshot.q` (earlier ones are already represented in the snapshot); then the attachment is
live. This yields exactly-once delivery across the barrier. (src: runtime.js:197–206, 372–379)

### 3.6 Heartbeat and reconnection timings (exact values)

| Constant | Value | Side | Meaning |
|---|---|---|---|
| Server WS ping | **15 s** interval | server | protocol-level PING on every open socket |
| Client app ping | **45 s** interval | client | `{t:"ping"}` frames while socket open |
| Connect timeout | **10 s** | client | give up dialing; triggers reconnect |
| Reconnect backoff | **500 ms · 2^(n−1), cap 8 s** | client | n = consecutive failures |
| Slow-path backoff | **60 s** | client | when `document.hidden` or `navigator.onLine === false` |
| Wake triggers | `online`, `visibilitychange` | client | an interrupted backoff fires immediately when the page is visible and online again |
| Idle socket hold | **15 s** | client | zero subscribers: keep a healthy socket briefly (tab switches reuse it) |
| Idle session sweep | **5 min** interval | server | see §C.7 |
| Session idle age | **30 min** | server | lastActivity threshold for reaping (unattached only) |
| Keepalive touch | **10 min** interval | app-lifetime client loop | `POST /api/terminal/touch` for unique non-exited tab session ids across every visited directory; panel switching must not stop the lease. Server refreshes only still-running records, so stale tabs cannot preserve exited records indefinitely. |
| Kill grace | **1 s** | server | SIGTERM before SIGKILL |
| Resize settle | **150 ms** debounce | client | surface → PTY resize notification |

On WS close or error **before the initial `open`** the client must invalidate the cached URL-scoped
auth token before retrying (a stale token otherwise makes every retry hit 401 and burn to the 8 s
cap). (src: terminalApi.ts:297–345)

### 3.7 HTTP command plane (exact contracts)

All routes are JSON, same auth as the rest of the API. Errors: `400` with body
`{ error: string, code?: string }` (the code is present only for the recoverable cwd case). (src:
runtime.js:429–551)

| Route | Method | Body | Response | Notes |
|---|---|---|---|---|
| `/api/terminal/shells` | GET | — | `[{id, name, supportsLogin}]` | discovered on the server, using the same augmented PATH as spawns |
| `/api/terminal/sessions` | GET | query `cwd?` | `{sessions: [{sessionId, cwd, status, createdAt, mode, purpose}]}` | `cwd` empty = all; listings NEVER include command text |
| `/api/terminal/create` | POST | see §C.1 | `{sessionId, cols, rows, status, mode, purpose}` | dedupe rules §C.2; `429` when cap reached |
| `/api/terminal/:id/resize` | POST | `{cols, rows}` | `{success, cols, rows}` | live PTY → `resize(cols,rows)`; also records size for exited sessions |
| `/api/terminal/:id/appearance` | POST | `{themeMode?, terminalBackground?, terminalForeground?}` | `{success}` | answers OSC and 2031 notify (§C.6) |
| `/api/terminal/:id/restart` | POST | `{cwd?, cols?, rows?, themeMode?, shell?, loginShell?}` | `{sessionId, cols, rows, status}` | interactive only; command mode → `400` |
| `/api/terminal/:id` | DELETE | — | `{success}` | SIGTERM→SIGKILL; fatal `CLOSED` broadcast |
| `/api/terminal/force-kill` | POST | `{sessionId?}` or `{cwd}` | `{success, killedCount, killedSessionIds}` | immediate SIGKILL; fatal `KILLED` |
| `/api/terminal/touch` | POST | `{sessionIds: string[]}` | `{touched}` | refresh `lastActivity` |

Create-request body type (client `CreateTerminalOptions`, mirrored by the server):

```ts
{ cwd: string; sessionId?: string; cols?: number; rows?: number;
  themeMode?: 'light'|'dark'; terminalBackground?: string; terminalForeground?: string;
  shell?: 'auto'|'bash'|'zsh'|'sh'|'fish'|'pwsh'|'powershell'|'cmd'|'dash'|'ksh'|'nu';
  loginShell?: boolean;
  purpose?: { type: 'terminal' } | { type:'project-action'; actionId: string; executionId: string };
  // mode-specific:
  mode?: 'interactive';                       // default
  mode: 'command'; command: string;           // exact-command launch
}
```

Special error: if `cwd` fails `stat` with `ENOENT`/`ENOTDIR`, the 400 body carries
`code: "TERMINAL_CWD_MISSING"` — the only 400 the client treats as recoverable-by-moving (deleted
worktree). (src: runtime.js:246–257, terminalApi.ts:115–137)

## 4. C. PTY lifecycle

### 4.1 Session identity

- Session ids are client-provided or `randomUUID()`; length ≤ 128. An existing id cannot be reused
  for another cwd or another purpose (see §C.2).
- Each session carries: id, cwd, cols, rows, themeMode/terminalBackground/terminalForeground, shell,
  loginShell, mode (`interactive`/`command`), command (command mode only), purpose
  (`terminal` default, or `project-action` with `actionId`, `executionId`, each ≤ 128 chars after
  trim), status (`running`/`exited`), exitCode/signal, sequence, history, lastActivity, backend name.
  (src: runtime.js:15–60)

### 4.2 Create semantics and dedupe (normative)

1. Validate dims `1..1000` cols / `1..500` rows; `loginShell` boolean; shell id in allowlist or
   `auto`; mode/command; purpose ids (`type:'terminal'` default; action ids non-empty ≤ 128 chars).
2. **Existing running session with same id**: if resolved cwd or purpose mismatches → error. If
   purpose is a project action → return the existing session (actions are adopted, never duplicated).
   Interior: mode/command must match for plain terminals.
3. **Another running session with same resolved cwd + actionId** (project-action purpose only) →
   return that session (its execution identity travels in the response purpose).
4. **Pending create with same id**: single-flight when cwd, shell, login mode, mode, and command all
   match (actions only need cwd+actionId) → await same promise.
5. **Pending create with same (cwd, actionId)** → await it; adopt.
6. `MAX_SESSIONS = 20` live records (pending creates count; sessions that a new action run is about
   to replace — i.e., exited records for the same resolved cwd+action — do NOT count, and are retired
   only AFTER the new PTY starts successfully; failed create preserves the old record's output).
7. Create is cancelled via the delete route while pending: a tombstone marks cancellation; when the
   PTY arrives late it is terminated immediately, never registered, and the create rejects; the
   delete still answers `success`.
8. cwd is validated with a real `fs.stat`; must be an existing directory.

A deliberate behavior for a same-id remount during create: a UI may create before its renderer
mounted (initial size from container/font, fallback **80×24**), then resize after the surface fits.
Shell startup and renderer init deliberately overlap. (src: runtime.js:270–354, DOCUMENTATION.md:30)

### 4.3 Spawn options (per platform)

Resolved shell is tried head-first through its executable list; first success wins. Data/exit
listeners are wired in the same synchronous turn the PTY object arrives (both backends expose the
object before dispatching, but a backend that fired exit earlier would be unrecoverable — keep the
ordering).

```js
options = { name: 'xterm-256color', cwd, cols, rows, env }
on win32: options.useConpty = true      // ConPTY; PseudoConsole API
on posix: launch is wrapped with `env -u ARGV0 -u NODE_CHANNEL_FD <shell> <args…>`
          (uses /usr/bin/env or /bin/env; no-op on Windows or when no env binary exists)
```
(src: runtime.js:119–142, inherited-env.js:69–81)

Environment for the PTY child (base = server `process.env`, then):

| Operation | Values |
|---|---|
| set | `PATH = buildAugmentedPath()`, `TERM=xterm-256color`, `COLORTERM=truecolor`, `COLORFGBG` = `"15;0"` (dark) or `"0;15"` (light) |
| delete | `NODE_CHANNEL_FD`, `BASH_XTRACEFD`, `BASH_ENV`, `ENV`, `ELECTRON_RUN_AS_NODE`, `ARGV0` |

Rationale (do not skip): `NODE_CHANNEL_FD` even empty makes Node CLIs warn `Failed to parse IPC
channel number` at exit; exported AppImage `ARGV0` makes zsh rewrite argv[0] for every child (breaks
Python venv detection etc.); `bun-pty` merges the OS native environ back in, so JS-side `delete` is
not enough — hence the `env -u` wrapper on POSIX.

`buildAugmentedPath()` = merge (deduped) of: the host process PATH and the **login-shell PATH**
(a cached probe of the user's shell), ordering by which looks "user-configured". (src:
server-utils-runtime.js:127–136)

**bun-pty patch (replicate its effect if you vendor bun-pty)** — the repo ships a local patch
package for `bun-pty@0.4.8` (src: bun-patches/bun-pty@0.4.8.patch). bun-pty's `spawn` resolves
asynchronously to its own Rust-side read loop, so output can be decoded BEFORE the TS layer attaches
its first data listener; unpached, that output (typically the complete first prompt) is dropped. The
patch:

1. Adds `_initialOutput` buffering: data emitted while `_hasDataSubscriber === false` accumulates,
   hard-capped by keeping only the trailing **512 KiB** (a JS string slice from the END).
2. The `onData` getter wraps subscription: on the FIRST listener it flushes `_initialOutput` once
   and forwards subsequent emits directly.
3. Preserves bun-pty's streaming UTF-8 `TextDecoder` semantics across chunk boundaries (multi-byte
   characters split between reads must not become replacement chars).

`node-pty` needs no such patch (its data callbacks register synchronously). The other patch files in
the same directory (`@tanstack/virtual-core`, `@legendapp/list`) concern list virtualization on
mobile, not the terminal. If your runtime does not use bun-pty, keep the "wire data and exit
listeners in the same turn" rule (§4.3) and drop the patch.

### 4.4 Shell selection

Shell ids (exact): `auto | bash | zsh | sh | fish | pwsh | powershell | cmd | dash | ksh | nu`.
Preference is normalized lowercased/trimmed; anything else (except `auto`) is rejected. The
env-var override is **`OPENCHAMBER_TERMINAL_SHELL`** (a candidate path, not an id).

`GET /api/terminal/shells` discovery order (candidates resolved by `PATH`-search or direct path, exec
bit checked, deduped by executable):

- non-Windows: `[OPENCHAMBER_TERMINAL_SHELL, $SHELL, .../etc/shells entries, all allowlist ids as
  names, /bin/zsh, /bin/bash, /bin/sh]`
- Windows: `[OPENCHAMBER_TERMINAL_SHELL, $SHELL, %ComSpec%, %SystemRoot%\System32\WindowsPowerShell\
  v1.0\powershell.exe, pwsh.exe, powershell.exe, cmd.exe, ...]`
- `auto` = first default-chain hit; each entry reports `supportsLogin` per the table below.

**`auto` fallback chain** for actually spawning (interactive):

- non-Windows: `OPENCHAMBER_TERMINAL_SHELL`, `$SHELL`, `/bin/zsh`, `/bin/bash`, `/bin/sh`, then name
  search for `zsh`, `bash`, `sh` on PATH.
- Windows: `OPENCHAMBER_TERMINAL_SHELL`, `$SHELL`, `%ComSpec%`, full path to powershell.exe,
  `pwsh.exe`, `powershell.exe`, `cmd.exe`.

If the preference is an explicit id that is not available → create fails (`Terminal shell "<id>" is
not available`) — never silently substitute a different shell. Preference changes affect new
sessions and explicit restarts, never running PTYs. (src: shells.js:44–117)

Login-mode args (opt-in `loginShell: true`) — only built-in args:

| Shell | Login arg | Supported? |
|---|---|---|
| bash, zsh, ksh | `-l` | yes |
| fish, nu | `--login` | yes |
| pwsh (non-Windows) | `-Login` | yes |
| pwsh (Windows), powershell, cmd, sh, dash | — | no (login request errors) |

Command-mode argv (launch so the PTY exits when the command exits):

| Shell family | argv |
|---|---|
| nushell | `[...login, -c, command]` |
| pwsh / powershell | `[...login, -Command, command]` |
| cmd.exe | `[/d, /s, /c, command]` |
| everything else (POSIX incl. sh, bash, fish) | `[...login, -i, -c, command]` |

Interactive launch = the executable plus login args only (no shell rc gymnastics).
(src: shells.js:20–42)

### 4.5 History retention (server)

- Cap **512 KiB per session** (UTF-8-safe trim: cut at a byte boundary that is not a UTF-8
  continuation). Sanitized bytes only (§3.4). Live caches mirror the same trim.
- When keeping the buffer, `lastActivity` only moves on output or write, not on attach/resize.

### 4.6 Appearance and theme query answering (server side)

Because a terminal that no renderer has attached yet still must answer queries (Fish polls DA1 at
startup and would otherwise block ~10 s):

- On create the server knows the UI appearance (`themeMode`, terminal background/foreground CSS
  colors).
- While draining output, the server scans for and answers:
  - `OSC 10 ; ? BEL/ST` and `OSC 11 ; ? ...` (fg/bg query) → `OSC <code>;rgb:rrrr/gggg/bbbb ST`
    computed from the stored CSS color.
  - `CSI 5 n`-style DSR, DA1 (`CSI c` / `CSI 0 c`) → `CSI ? 1 ; 2 c` (conservative VT100 — specific
    purpose: Fish's startup query).
  - `CSI ? 2031 h/l` → tracks whether the program enabled Mode 2031 (dark/light notification).
  - `CSI ? 2031 $p` → `CSI ? 2031 ; <1|2> $ y`.
  - `CSI ? 996 n` / `CSI ? 997 n` (theme reports) → `CSI ? 997 ; 1 n` (dark) / `CSI ? 997 ; 2 n`
    (light).
  - Incomplete sequences carry over across chunks (same style as the history sanitizer but
    independent state, so a query answer is never missing because of a chunk split).
- When the UI appearance changes, each running session with Mode 2031 enabled receives
  `CSI ? 997 ; 1|2 n` so subscribing TUIs can recolor. Answered queries are stripped from
  history/replay (§3.4) but the responses themselves are injected directly into the PTY (never
  published as output).

(src: theme-response.js:1–98; runtime.js `applyAppearance`, `drainEvents`)

### 4.7 Resize, restart, close, kill, idle

- **Resize**: HTTP only; bounds re-checked; live sessions → `pty.resize(cols, rows)`; exited
  sessions just record the size. The renderer's debounce (§5) is the only resize channel in the
  other direction.
- **Restart**: per-session serialized (if one is in flight, the next chains after it). Spawns the
  replacement **before** terminating the old process; on success: clear history/pending state, wire
  new PTY, terminate old, publish `restarted {history:""}`. Command-mode sessions reject restart
  (HTTP 400) rather than turning into interactive shells with stale action metadata. Shell preference
  for restart defaults to `auto` unless the caller passes one.
- **Close (DELETE)**: SIGTERM with bounded SIGKILL escalation (1 s), POSIX kills the **process
  group** (`-pid`). Removes the session, broadcasts fatal `CLOSED`. A delete arriving while create is
  pending leaves the cancellation tombstone (§C.2 step 7).
- **Force-kill**: `POST /api/terminal/force-kill { sessionId? }` or kill **everything under one cwd**
  — immediate SIGKILL of process groups where supported; fatal `KILLED` broadcast; ids returned.
- **Idle reaper**: every 5 min, sessions with **zero attachments** and `now - lastActivity > 30 min`
  are deleted (fatal `IDLE_TIMEOUT`, force-killed). **Attached sessions are never considered idle** —
  this is why background tabs (which hold no WS attachment) touch the server via the 10-min
  keepalive loop that lists every non-exited tab's session id.
- **Exited sessions remain attachable** until explicit close, idle cleanup, or successful
  replacement by a new action run. Clients can replay final output after process death.

(src: runtime.js:144–172, 481–561)

### 4.8 Server shutdown (must implement)

Remove the upgrade handler, stop the idle sweep, await pending restarts (allSettled), force-kill all
PTY processes, clear the registry, await in-flight terminations, `ws.close()` with a 1 s race-fallback,
drop the WS server. (src: runtime.js:563–577)

## 5. D. Renderer specification (libghostty-vt adapter)

The emulator is **libghostty-vt** (Ghostty's VT core) compiled to WebAssembly, adapted from T3 Code's
browser adapter (MIT). The renderer is **Canvas 2D**, not xterm.js and not WebGL.

### 5.1 Integration model

- **One WASM instance per page** (lazy singleton; every terminal owns and frees its own handles
  inside it; the instance is never torn down while the page lives). (src: ghostty/runtime.ts:251–260)
- The artifact is a vendored `.wasm` built from a pinned upstream commit (recorded in a `VERSION`
  file next to it). Struct layouts are **not hardcoded**: on load the adapter reads the C-ABI layout
  table (`ghostty_type_json` export) and all `runtime.setField/readField/layout(name)` calls resolve
  against it. Rebuilding the artifact against a new revision requires reconciling option ids and
  enum values (replicate `runtime.test.ts` which fails when embedded build metadata and `VERSION`
  disagree).
- **PTY write callback**: the WASM module has no stage-2 import wiring by itself; the adapter
  instantiates a **121-byte hand-built trampoline module** whose exported function
  `ghostty_write_pty(terminal, userdata, ptr, len)` forwards to the host import
  `openchamber_write_pty`, and installs it into the module's indirect function table
  (`table.grow(1)` then `table.set(index, fn)` — grow-then-set, NOT `grow(1, fn)`; WebKit bug caches
  broken type info otherwise). The terminal is configured with option `0` = writer id (opaque
  integer), option `1` = table function index. Every VT state change that a real terminal program
  would send back to the PTY (device-status replies, mode reports, etc.) is delivered through this
  callback to → `onData` → `TerminalView.onInput` → WS `write`. (src: ghostty/runtime.ts:33–40,
  218–240)

### 5.2 Per-terminal core (GhosttyTerminalCore) — ABI notes you must replicate

- Creation: `ghostty_terminal_new` with `GhosttyTerminalOptions { cols, rows, max_scrollback }`;
  `max_scrollback = 10 000` rows. After creation set the **embedder default cursor blink** (option
  `23 = 1`); re-apply it after every reset/replay because RIS restores Ghostty's built-in steady
  cursor.
- Writes: `ghostty_terminal_vt_write(ptr, len)`; byte-wise (UTF-8).
- `resetAndWrite(data)` (history replay): `ghostty_terminal_reset`, re-apply blink default, then
  write the history with the PTY writer **detached** first (so historical query exchanges never
  reach the live shell), re-attached after.
- Resize: `ghostty_terminal_resize(cols≤65535, rows≤65535, cellW, cellH)`.
- Theme: option `11` fg, `12` bg, `13` cursor (3 bytes RGB); option `14` palette = 256×3 bytes
  (indices 16–255 keep the standard xterm 6×6×6 cube [0,95,135,175,215,255] and 24-step gray ramp
  8..238; indices 0–15 = theme ANSI; `NULL` restores built-in table while keeping per-index OSC 4
  overrides a program set); option `21` selection (`GhosttySelection{start,end}` grid refs).
- Snapshot: `ghostty_render_state_new` + `ghostty_render_state_update(terminal)` per frame; read
  fields: global (cols u16, rows u16, dirty u32 [0=none,1=some,2=all], fg/bg, cursor color/visible/
  blink/style/x/y and in-viewport flag), row iterator (dirty rows only), per-row (cells iterator,
  wrap flags: `wraps-to-next`, `is-wrap-continuation`), per-cell (text `graphemes[]` u32 codepoints,
  wide state 0=narrow/1=wide/2=spacer-tail/3=spacer-head, fg/bg, `selected`, style
  inverse/faint/bold/italic/invisible/strikethrough/overline/underline). Inverse swaps fg/bg; faint =
  61%-fg blend into bg; row cache is reused and only dirty rows are re-read.
- Point conversion between viewport (tag 1) and screen (tag 2) coordinate spaces:
  `ghostty_terminal_grid_ref(point)` → `ghostty_terminal_point_from_grid_ref(ref, tag)`.
- Scroll: `ghostty_terminal_scroll_viewport` with `tag 2` = scroll by delta rows, `tag 1` = jump to
  bottom. Scrollbar state: `terminal_get option 9` → `{total, offset, len}`.
- Queries: alternate screen (`get 6`), Kitty keyboard flags (`get 8`), mouse tracking (`get 11` =
  normal/button mode tracking), any-event motion (DECRQM `1003`), viewport active (`get 32`).
- Selection ops: `select_word(col,row)`, `select_line(col,row)` (both return screen+viewport ranges
  and commit the selection), `select_all`, `clear` (option 21 = null), formatted text via
  `ghostty_terminal_selection_format_buf` with an options struct of size 16 bytes
  (`[0]=16, [4]=0, [8]=1, [9]=1, [12]=0`).
- Keyboard encoding: per-terminal `ghostty_key_encoder_setopt_from_terminal` (the VT decides legacy
  vs Kitty encoding); event fields: `action` (0 release / 1 press / 2 repeat), `key` (GhosttyKey —
  W3C `KeyboardEvent.code` mapped 1:1 by an enum mirror table), `mods` (shift 1, ctrl 2, alt 4, meta
  8, caps 16, num 32), `consumed_mods` (mods the browser already applied to produce the text),
  `composing`, `unshifted_codepoint` (from `navigator.keyboard.getLayoutMap()` when available), and
  `utf8 text` (when `event.key.length === 1`). Output via two-phase size probe
  (`ghostty_wasm_alloc_usize` scratch, encode with 0-buffer → `-3 OUT_OF_SPACE` + size → allocate →
  encode again). Release codes are emitted ONLY when the running program enabled Kitty
  report-event-types; legacy sessions encode nothing on keyup.
- Paste encoding: consult bracketed-paste mode (`DECRQM 2004`) and
  `ghostty_paste_encode(ptr, len, bracketed, out, cap, written)` (two-phase probe; malformed is
  caller-problem: escaped iff bracketed).
- Mouse encoding: per-terminal mouse encoder `setopt_from_terminal`; `GhosttyMouseEncoderSize`
  struct (screen w/h, cell w/h, four paddings) via option `2`; option `3` = any-button-pressed bit;
  option `4` = 1 (modern reporting); event: action press/release/motion, button (DOM button → 1=left,
  2=middle, 3=right, 4=wheel-up, 5=wheel-down; null clears), mods (no caps/num), position
  (`GhosttyMousePosition{f32 x,y}`). Same two-phase output probe. SGR/motion dedupe:
  motion is dropped when identical to the previous motion; tracking-mode change resets the dedupe
  state.

(src: ghostty/core.ts:22–76, 280–730, 542–700; keyCodes.ts)

### 5.3 The surface (DOM layer)

Components per terminal: `canvas.oc-terminal-canvas` (aria-hidden), `textarea.oc-terminal-input`
(hidden, aria-label = localized "terminal input"; `autocapitalize/correct/complete` off, no
spellcheck), `div.oc-terminal-scrollbar [role=scrollbar]` + thumb (hidden when no scrollback).

- **Canvas rules you must copy** (each prevents a concrete class of bug):
  1. Create with `getContext('2d', { alpha: false, willReadFrequently: true })`. `alpha:false`
     avoids compositing overhead; `willReadFrequently` pins the **software** rasterizer (Gecko
     otherwise per-canvas hardware-accelerates and its GPU text path on macOS skips CoreText
     smoothing → thin "pencil" glyphs for canvases created after page load).
  2. Pre-size the backing store to mount size × DPR **before first compositing paint** (fill theme
     background first so the setup window never flashes a black box); a canvas whose intrinsic size
     changes later while the CSS box stays put shows a stretched first image in Gecko otherwise.
  3. On every fit: `canvas.width/height = round(clientSize × DPR)`; `setTransform(DPR, …)`;
     render synchronously (ResizeObserver fires before paint) so the compositor never shows a stale
     stretched frame.
  4. Track DPR via a `resolution: <dpr>dppx` media query, re-armed after each change (it fires once).
- **Cell metrics**: measure `'M'` width and `'Mg'` actual ascent/descent;
  `height = max(1, round(1.35 × fontSize), ceil(ascent+descent))`;
  `baseline = round((height − glyphHeight)/2 + ascent)`. Never size the grid from faces that have not
  loaded (§5.6) and re-measure on later `document.fonts` `loadingdone` events with an epoch guard so
  overlapping async font changes resolve newest-wins.
- **Fit/resize flow**: `ResizeObserver` on the mount → `fit()` → compute grid = floor((w−8)/cellW)
  × floor((h−8)/cellH), padding constant **4** CSS px; local grid reflows immediately;
  **`onResize(cols,rows)` is the only PTY resize channel**, debounced **150 ms** ("settled
  dimensions"); the **first successful fit always notifies** even if equal to construction size;
  on dispose the pending debounce flushes final dimensions. Hook the container size 0 case: parse
  output, answer queries, but paint nothing (hidden terminals stay live; §6.5).
- **Rendering** (Canvas 2D, dirty-row incremental):
  - Invalidation: full repaint when canvas resized, theme/font/DPR change, session reset, selection
    change, origin shift, or `refresh()`; otherwise only rows in `dirtyRows` plus the previous and
    current cursor rows.
  - Per row: background rects for runs of equal background/selection (selection overlay drawn on
    top), then text runs (contiguous equal fg/bold/italic/invisible cells, skipping wide-spacer
    tails), each run drawn inside a per-run clip rect; decorations drawn per cell afterwards
    (underline at `height−2`, strikethrough at `0.55·height`, overline at `+1`, all 1 px, plus
    hovered-link underline on the link's rectangle).
  - **Box drawing / block elements / powerline arrows** (`U+2500–U+257F`, `U+2580–U+259F`,
    `U+E0B0–U+E0B3`) are drawn procedurally to the exact cell — never through the font, whose glyphs
    stop at the em box and leave a 1-line seam at 1.35 em line height. Snap to whole CSS pixels so
    neighboring cells meet. When the block cursor sits on such a cell, draw the glyph in background
    color over the filled cursor.
  - Cursor: style `0` = bar (2 px left), `1` (default) = block (fill cell, then draw the cell's
    glyph in background color — font or box-drawing), `2` = underline (bottom 2 px), `3` = hollow
    (stroked rect); **unfocused = hollow always**. Blink = 500 ms half-cycle timer, enabled only
    when `focused && snapshot.cursorBlinking && cursorVisible && !prefers-reduced-motion`; every
    write restarts the cycle from the visible phase (a cursor never sits invisible during a flood of
    output).
  - The IME textarea is positioned at the cursor cell (`left = 4 + cursorX·cellW`, `top = originY +
    cursorY·cellH`) so composition candidates appear where the user types.
- **Grid origin Y**: top-anchored (`padding`) while content is shorter than the viewport; once
  scrollback exists anchor to the **bottom** (the sub-row remainder moves above row 0). Origin
  change forces a full repaint (partial dirty composites at a shifted origin would tear).

### 5.4 Input handling (surface)

- **Keydown** (on the hidden textarea): skip when IME-composing (incl. `keyCode === 229` browsers
  that report it late); the copy/paste shortcuts own their chords when a selection exists (§5.5);
  otherwise encode via the Ghostty encoder and `preventDefault + stopPropagation` + `onData`.
  A `beforeKey(event) -> false` hook lets the host consume keys (app shortcuts) and matching **keyup
  suppressions** are tracked by physical `code` so Kitty sessions never receive a release for a press
  the shell never saw (same suppression set also covers macOS word-shortcut translations and AltGraph
  events whose text arrives via the composition/input path).
- **macOS word navigation** (only: plain unshifted Option, macOS, not alternate screen, no Kitty
  flags): Option+Left/Right → `ESC b` / `ESC f`; Option+Backspace → `0x17` (Ctrl+W).
- **Mouse**: when the program enables mouse reporting (DEC 1000/1002/1003 + SGR) and no
  Shift/Ctrl/Meta pressed: presses/releases/motions/wheel buttons are encoded and sent, pointer
  captured; otherwise normal selection. Wheel without reporting: alternate screen translates wheel
  rows into arrow-key sequences (application cursor keys choose `ESC O A/B` vs `CSI A/B`, repeated);
  normal screen scrolls the viewport. Wheel accumulation keeps fractional row remainders; `deltaMode`
  lines/pages normalized to pixels.
- **Selection**: click sequence (`≤500 ms`, `≤4 px`) advances cell → word (2nd) → line (3rd+);
  drag extends with the anchor **pinned in screen coordinates** (streaming output cannot shift the
  origin of a drag); drag past edges autoscrolls every 80 ms; click-no-drag clears. Word/line modes
  re-anchor smartly around the base. Selection persists across scrolling and output: anchors are
  kept in screen coordinates, and the highlight ranges ride on the painted rows rather than the
  DOM.
- **Scrolling**: scrollbar thumb (drag; min thumb height 18 px; pointer offset preserved), track keys
  (Up/Down 1, PageUp/Down = viewport, Home/End extremes), wheel (above), touch host API
  (`scrollLines(deltaRows)`), all clamped to `[0, total−len]`.
- **IME lifecycle**: `compositionstart` clears any primed copy; `compositionend` emits the committed
  string once and parks a suppression token (the trailing `input` event carrying the same text is
  swallowed, 100 ms window); non-composing `input` events flush the textarea value as normal input.
  Safari's `keyCode 229` keydowns never reach the encoder (would double-commit).
- **Context menu**: the surface decides whether a right-click belongs to the app (mouse reporting on
  → encode event, no menu); only unclaimed right-clicks are forwarded to the host via
  `onContextMenu(event)` — the host's context-menu trigger must accept only that exact native event.
- **Links**: hover detection = Cmd (mac) / Ctrl (other); underlines the match region; activation on
  the same-modifier gesture press/release pair; explicit OSC 8 hyperlinks win over heuristics;
  heuristic matches are `https?://…` spans joined across soft-wrapped rows of one logical line, with
  trailing punctuation/unclosed brackets trimmed; a match truncated at the viewport edge (its head
   wrapped above or tail wraps below the viewport) is not clickable. Hover/activation is suppressed
   while that pointer's press is already being reported to a mouse-reporting application (a claimed
   drag can never become a link activation). (src: terminalLinks.ts; surface.ts:1956–2001)
- **Copy/paste races**: clipboard writes/reads claim and bump a token; the synchronous native
  copy/paste event wins when it actually carries data; failed async fallback writes are forgotten if
  superseded. Cmd/Ctrl+C with a selection copies (and on non-mac plain Ctrl+C also clears the
  selection afterwards so the next press reaches the shell as SIGINT; Shift/Cmd+C keep the
  selection); Ctrl+Shift+C synthesized via `execCommand('copy')` where the browser binds it to
  devtools. Cmd/Ctrl+V (Ctrl+Shift+V on non-mac) and Shift+Insert race the native paste; all pastes
  go through bracketed-paste encoding. (src: surface.ts:329–407, 1123–1350)

### 5.5 Hidden-textarea copy priming

Native copy (and Electron's menu Copy) reads the focused textarea, which is normally empty. Before
any copy event can fire, park the selection text into the textarea and `.select()` it; afterwards
blank it only if it still holds exactly the primed selection (never clobber an IME candidate).

### 5.6 Fonts

- Default stack: `"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", "Symbols Nerd
  Font Mono", "Symbols Nerd Font", "JetBrainsMono Nerd Font", "JetBrainsMono NF", "FiraCode Nerd
  Font", "Hack Nerd Font", "MesloLGS NF", "CaskaydiaCove Nerd Font", "PowerlineSymbols", monospace`.
- A **symbols-only Nerd Font (MIT)** ships in the bundle (woff2, loaded once per page): prompt
  glyphs render even without a locally installed Nerd Font, without CDN fetches, and (carrying no
  text glyphs) without changing metrics of the text face.
- Custom faces (settings) must pass a **monospace probe** (same advance for
  `i M W 0 @ # . space` across normal/700/italic variants, tolerance 0.01) — proportional faces are
  refused (cursor raggedness). Names are normalized into canvas-safe shorthand (quoted, generic
  keywords like `ui-monospace`/`system-ui` dropped — Chromium's canvas parser rejects those and an
  invalid shorthand silently no-ops).
- Before creating (or re-measuring after font change) `document.fonts.load()` is invoked for the four
  variants (`normal|700|italic|700-italic`) against the full stack with probe text `'iMW0@# .'`;
  the viewport additionally waits ≤ 2 s for the selected face before constructing the surface; later
  `loadingdone` re-measures. A stalled/failed font load falls back to whatever is available — the
  terminal still opens.

### 5.7 Theme source (client mapping)

UI theme → terminal colors (14 owns token values; this owns the mapping):

| Terminal color | Theme token |
|---|---|
| background / cursorAccent | `surface.background` |
| foreground / white | `syntax.base.foreground` (repeat for the 16-color `white` slot) |
| cursor | `interactive.cursor` |
| selectionBackground | `interactive.selection`; selectionInactive = same + `50` alpha |
| black | `surface.muted` |
| red / brightRed | `status.error` |
| green / brightGreen | `status.success` |
| yellow / brightYellow | `status.warning` |
| blue / brightBlue | `syntax.function` |
| magenta / brightMagenta | `syntax.keyword` |
| cyan / brightCyan | `syntax.type` |
| brightBlack | `syntax.comment` |
| brightWhite | `surface.elevatedForeground` |

Hex (#rgb/#rrggbb, alpha digits ignored) or rgb()/rgba() parse; per-entry parse failure falls back to
white/black rather than sending garbage. The same three appearance scalars
(`themeMode`, `terminalBackground`, `terminalForeground`) are sent to the server at create and on
change (`/appearance`) so PTY children and TUI queries answered server-side match the UI (§4.6).

(src: lib/terminalTheme.ts)

## 6. E. Client architecture: transport, store, components

### 6.1 TerminalTransport (one per runtime instance)

Holds at most one socket. Per session it keeps a **projection** (`sequence, history, cols, rows,
status, mode, purpose, exitCode, signal, runtime, ptyBackend`) capped at **512 KiB** (UTF-8-safe
trim) so a later subscriber (tab switch, remount, second subscribe) gets an instant snapshot replay
without touching the server.

- `subscribe(sessionId, handlers)`: adds a subscriber; if a projection exists it is delivered
  immediately as a synthetic `snapshot`; otherwise the socket must connect first. When the number of
  subscribers for a session returns to 0 the transport sends `detach` and drops the projection.
  When ALL subscriptions go away: cancel reconnect, reset failure state, and either hold a healthy
  socket for 15 s (tab-switch case) or abandon any in-flight dial.
- `write(sessionId, data)`: ensure connected; on send failure close + reconnect once; second failure
  throws (the UI surfaces "send failed" without corrupting local state — note: input is NOT
  locally echoed; the shell echo path is the only truth).
- `handleMessage`: validated with a zod schema mirroring §3.2 (unknown → drop); dedupe by `q` per
   subscriber; projections advance; error frames route to the session target or to all subscribers
  when no session id.
- Reconnect: §3.6 table. Emits synthetic `reconnecting { attempt, maxAttempts: ∞ }` events to all
  subscribers (UI shows a non-fatal "reconnecting" state).
- `noteResize(sessionId, cols, rows)` records the server-accepted PTY size into the projection so
  later replay carries the right size.
- Runtime switch: `disposeTerminalInputTransport()` + fresh instance; the terminal store is cleared
  on runtime switch (§Flow 6). (src: terminalApi.ts)

### 6.2 useTerminalStore (state model)

Visible state (never persisted: buffers):

```
sessions: Map<directoryKey, { tabs: TerminalTab[], activeTabId }>
buffers:  Map<`${directory}\0${tabId}`, TerminalBuffer>
```

`directoryKey` = the project/worktree directory normalized (trailing slash stripped). One directory
is independent of another; VS Code shows only the first tab of its directory; web/desktop/mobile
support a full tab strip.

| TerminalTab field | Meaning |
|---|---|
| id | `tab-<uuid>`; for adopted server sessions the tab id EQUALS the session id |
| terminalSessionId | current PTY session id or null |
| lifecycle | `idle` → `starting` → `running` → `stopping` → `exited` (project-action tabs use these; plain tabs use idle/running/exited) |
| purpose | `{ type:'terminal' }` or `{ type:'project-action', actionId, executionId: string|null }` |
| label / iconKey | user- or action-labeled; icon from action icon key |
| isConnecting | spinner state |
| previewUrl / previewAutoOpened / previewUrlLocked | detected dev-server URL state (13 owns the pane) |

`TerminalBuffer = { chunks: [{id, data, replayData?, byteLength, size?}], byteLength, lastSequence }`
— capped at **512 KiB** with UTF-8-safe trimming of OLDEST chunks; each chunk carries the sequence
that produced it; **snapshot chunks carry `size`** (the PTY size the replay was laid out for) plus
their replay-safe text. Buffers live OUTSIDE the persisted tabs (streaming output must not rerender
the tab strip or rewrite storage).

- Persistence: `sessionStorage` (per browser tab) holds only tab metadata (id, label, icon, createdAt,
  purpose type+actionId — NOT executionId) + `nextTabId`; hydration is awaited before tabs spawn
  anything (`hasHydrated` gate). The buffer map is rebuilt from server snapshots after reload.
- Execution guards: every mutation that could belong to a stale project-action run accepts an
  `expectedExecutionId`; it applies only when the tab still matches (`undefined` = unguarded).
- `actionMutationRevisions` (Map of `directory\0actionId` → revision): transactions around
  async creates/stops; a reconcile result that started before a user mutation is dropped if the
  revision moved meanwhile (prevents a stale server listing from erasing a tab the user just
  started/stopped).
- Default tab labels: `"Terminal"`, `"Terminal 2"`, … numbered from the highest existing default
  suffix, surviving reloads without a counter.
- `reconcileServerSessions(directory, serverSessions, { startedActionMutationRevisions })`:
  the ONLY writer that adopts server truth (§F). A singleton idle placeholder tab is replaced by the
  first adopted session; per-action dedupe keeps the authoritative record for each actionId
  (status running first, then newest createdAt, then highest sessionId); tabs whose action is no
  longer running and not being started are marked exited with `executionId: null`.

### 6.3 TerminalView (panel component)

Props: `visible: boolean`, `directory?: string | null` (falls back to the session-context directory).

Render states:

| Condition | UI |
|---|---|
| no active chat session and no draft | centered empty text |
| no directory resolvable | text + Retry button |
| tab idle/connecting | viewport mounted-hidden; spinner on tab icon |
| `reconnecting` | viewport stays; banner suppressed (input is ignored while replay pending) |
| fatal error | bottom error banner (touch devices: "Hard restart" button) |
| session exited | localized "process exited (code N)" line appended into the buffer; lifecycle `exited` |

Controls (desktop + mobile aware):

- **Tab strip** (draggable/sortable; owned-by-03 tab component): each tab shows action icon
  (spinner while `starting|running|stopping` for actions), close button, plus "+" new-tab button.
- **Restart** (interactive tabs only; disabled on action tabs and while restarting).
- **Attach selection** (to chat context, §Flow 5).
- **Copy selection** (toolbar mirror of the keyboard shortcut; mainly for touch).
- **Preview open** (appears when a dev-server URL was detected and probed: §G "URL opening") opens
  the preview pane (13).
- **Quick keys row**: `Esc | Tab | Ctrl | Alt | ← | ↓ | ↑ | → | Enter` (see keyboard table §6.4);
  rendered as a bottom strip on touch devices and (opt-in setting) as a second row on desktop.
- Inactive tabs stay MOUNTED but visually hidden (instant tab switch without rebuilding WASM/font
  atlas/history); only the active tab holds the live stream; switching replays its stored buffer
  into the still-mounted emulator.
- Viewport identity key = `directory::tabId` — **never the session id** (keying on session id would
  rebuild the whole emulator the moment create resolves and doubles every open cost; session swaps
  ride the chunk-replay path instead).

### 6.4 Keyboard & input

Desktop: the ghostty surface owns the keyboard (§5.4). Application-level shortcuts may `beforeKey`
-veto. Terminal focus management: when the panel becomes visible the surface re-fits and refocuses
via rAF with 220/400 ms refits (fonts settling); focusing only happens while the document has focus;
touch-input surfaces NEVER steal focus (the soft keyboard).

Modifier+quick-key semantics (library `terminalInput.ts`, exact):

| Key (modifier armed) | Sequence sent |
|---|---|
| Esc | `ESC` |
| Tab | `TAB` |
| Enter | `CR` |
| Arrow Up/Down/Left/Right | `CSI A` / `CSI B` / `CSI D` / `CSI C` |
| Arrow + Ctrl armed | `CSI 1;5A|B|C|D` |
| Arrow + Alt armed | `CSI 1;3A|B|C|D` |
| Char under Ctrl armed | C0 control char mapped to the letter (`A..Z & 0x1F`) |
| Char under Alt armed | `ESC` prefix (single chars only) |

When a modifier is armed (quick keys active), a WINDOW-level keydown listener intercepts plain keys
(the grouped shortcut set: Tab/Enter/arrows/Esc, or A–Z with Ctrl) so the shell receives the chord
even though the soft/hidden input does not have focus; the modifier flips back off and focus returns
to the terminal after each intercepted chord.

### 6.5 Visibility & focus pausing (client-side obligations)

- A hidden surface (`setVisible(false)` — tab switched away or panel closed) keeps: parsing output,
  answering VT queries, buffering scrollback. It stops: rAF painting, cursor blink timer, scrollbar
  updates. On reveal: full repaint + fit.
- Unmounted tabs (directory left): buffer kept in store only; stream detached.
- Polling observers pause while `document.hidden || !navigator.onLine`; WS reconnect waits 60 s on
  the slow path but wakes instantly on visible/online.
- Clipboard reads are invalidated when the session/tab/visibility changes (lifetime counter) so a
  browser clipboard read landing after a switch can't write into the wrong terminal context.

### 6.6 Mobile differences (mechanisms; UX detail owned by 11)

- `useTouchTerminalInput = (isMobileDevice || isTablet || touchOnlyPointer) && platform === 'web'`
  (i.e. browser + hosted-mobile web surfaces; the {$} desktop window and VS Code never use touch
  input). (src: TerminalView.tsx:106–108)
- Surface is constructed with `handleTouchPointer: false` — the surface ignores touch pointers and
  the compatibility mouse events following them (a tap must not summon the keyboard implicitly).
- The React gesture layer owns: scroll (pointer drag; row = max(12px, round(fontSize×1.35))
  quantization with fractional remainder), tap-to-focus (gesture = down+up < 8 px movement →
  surface.focus() → soft keyboard appears; on Android additionally `Capacitor Keyboard.show()` is
  invoked — Android only raises the keyboard on native tap-focus, and this tap is
  pointer-captured/scripted), long-press ≥ 350 ms → word-select at that cell, drag during selection
  → extend.
- Refit on keyboard transitions: window event `oc:keyboard-settled` (dispatched by the mobile
  chrome when the keyboard finishes opening/closing) triggers a rAF refit.
- Dispose path quirk: before removing a focused editable mid-IME-composition, blur it — removing a
  focused editable during composition wedges Android WebView input dispatch entirely; on Android
  also explicitly `Keyboard.hide()`.
- Hardware-keyboard detection (mobile): native bridge gives `window.__OPENCHAMBER_HARDWARE_KEYBOARD__`
  + `oc:hardware-keyboard` events (iOS GCKeyboard); otherwise infer: `keyboardWillShow` height
  < 120 px = only the iOS shortcut strip → hardware keyboard present; focus with NO keyboard event
  within 600 ms → hardware present. Soft-keyboard quick keys and resting layouts switch accordingly.
- Mobile keyboard mode setting (`native` | `resize-content`): viewport meta behavior when the soft
  keyboard opens (web-runtime only setting). The terminal refits to whatever layout results.
- On mobile the "Hard restart" button appears in the fatal error banner (regular ambient restart
  affordance otherwise).

### 6.7 Terminal-related settings (all client-owned, server stores the values)

The settings registry (03/12 own the settings engine) exposes these terminal fields; the UI reads
them from the UI store at render time — a change affects **new sessions and explicit restarts only**,
never running PTYs.

| Setting | Scope | Type / values | Default | Effect |
|---|---|---|---|---|
| `terminalShell` | instance | `auto` or one shell id | `auto` | shell passed on create/restart; the selector lists `GET /api/terminal/shells` results (hidden in VS Code) |
| `terminalLoginShells` | instance | array of shell ids | `[]` | marks which shells launch with their login argument; `terminalLoginShell = terminalLoginShells.includes(terminalShell)` |
| `terminalFontSize` | profile (per surface) | number (renderer clamps 6–32) | 13 | font for the canvas metrics; changes re-measure and refit |
| `showTerminalQuickKeysOnDesktop` | instance | boolean | off | renders the quick-keys row on desktop |
| `mobileKeyboardMode` | instance (web runtime only) | `native` \| `resize-content` | `resize-content` | viewport behavior under the soft keyboard |
| theme tokens (foreground/background/cursor/16 ANSI/selection) | profile | via theme | — | mapped per §5.7; on change also pushed to running sessions via `/appearance` |

The shell selector option shape is `{ id, name, supportsLogin }`; if the persisted id is no longer
offered by the server, it is kept as a disabled-looking entry rather than silently switching to
`auto` (an explicit preference that became unavailable must fail loudly at create/restart, §4.4).
Selection applies per surface; a runtime switch re-queries shells (epoch listener).

### 6.8 Close semantics (tab close vs session close)

Two distinct exits (this is a common regression; keep them apart):

| Action | What happens |
|---|---|
| Close a TAB (`closeTab`) | UI-only removal of the tab row + its buffer. If the tab's session id resolves, it ALSO `DELETE /api/terminal/:id` (session closed, process killed, fatal `CLOSED` broadcast on all viewers). Closing the last tab seeds a fresh empty tab. |
| Panel closed / tab switched / project switched without closing | PTY keeps running server-side; attachment drops (socket-`detach` on unsubscribe for the removed active tab or on panel unmount); the app-level 10-min keepalive keeps the session off the idle reaper while any client still lists it in a tab, even when that project's panel is unmounted. |
| Force-kill (session or whole-directory) | server-side immediate; all clients get fatal `KILLED` and reset their tabs to exited. |
| Close terminal via runtime switch | not a close at all — transport disposed, store cleared, sessions orphaned until the (previous) server reaps or the same server is switched back to and re-adopted. |

## 7. F. Reattach, persistence, and cross-device behavior

What survives, and where:

| Artifact | Where | Survives |
|---|---|---|
| PTY processes, scrollback, appearance | server memory | reload/tab close/device swap (30 min idle + unattached otherwise) |
| Tab strip (ids, labels, icons, purposes w/o executionId) | browser `sessionStorage` | reload of the SAME tab; NOT new tabs/devices |
| Scrollback shown after reload | server snapshot replay | everything within 512 KiB |
| Client projection cache | memory | subscriber churn (tab switches) only |
| Running-action identity | server (purpose on session) | reload, other devices |

**Flow 2 — Reattach from another device (or after reload)** (normative):

1. Client opens terminal panel; store hydrates from sessionStorage (tab strip possibly empty on the
   new device).
2. `observeTerminalSessions` (§F.2) fetched `GET /api/terminal/sessions?cwd=<dir>` (5 s cadence).
3. `reconcileServerSessions` adopts each listed session into the store: existing tab (same session
   id or same purpose.actionId for actions) is updated; unknown sessions become new tabs; sessions
   listed for another directory are ignored here (grouped by resolved cwd server response is
   grouped client-side by normalized cwd).
4. The active tab's `terminalSessionId` triggers the standard attach flow (§Flow 1 steps 5–10); the
   authoritative snapshot replays 512 KiB of history at the recorded PTY size, then events
   `q > snapshot.q` follow. Nothing is lost between devices: outputs missing from the projection
   still exist server-side.
5. Fresh-from-sessionStorage placeholders that show an action tab with `executionId=null` are
   reconciled to the server purpose (a running run gives the adopted executionId; exited ones stay
   exited).
6. If the same tab is attached from two devices, both are attachments on their own sockets; both
   receive every event; `write` from either reaches the PTY (shared shell ⇒ mirrored cursor state —
   this is by design).
7. Tabs the user closes on device A do not close the PTY for device B unless the close button uses
   the tab-level close which DELETES the session (§6.8); the server cannot tell devices apart. For a
   "hold my place on the desk, keep running on the server" flow: switch tab rather than close it.

**Flow 1 — Open terminal (first attach)** (normative):

1. Panel becomes visible (tab whose panel holds terminal view becomes active).
2. Store hydrates; directory resolved (explicit target or context directory; `normalizeTerminalDirectory`
   = trim, backslashes→slashes, strip trailing slash, keep "/").
3. Directory exists in store? else `ensureDirectory` creates one tab (`Terminal`).
4. The viewport mounts; the ghostty WASM + fonts load lazily; while loading, the viewport reports a
   **provisional size** from container+font metrics (fallback 80×24) so shell spawn can proceed even
   if the renderer is not ready.
5. The spawn gate waits for the **fitted grid** when visible (a shell spawned wider than the final
   grid prints a prompt for the wrong width; a later resize only repaints the prompt row in zsh and
   leaves the `%` mark above it): tab without session id + visible + fitted? → `createSession`
   (HTTP) with `sessionId = tabId`, cols/rows = fitted or provisional or 80×24, shell/loginShell from
   settings, appearance from theme. Creates are single-flight per (directory, tab). Hidden tabs spawn
   at provisional size and resize once shown.
6. Response session id stored on tab (→ lifecycle `running`); `connectTerminalStream` subscribes.
7. Socket: ensure URL token; open; send `hello`; attach all subscriber sessions. Server: auth/origin
   gates → connection accepted → `hello`; attach barrier/snapshot (§3.5).
8. Client: on `snapshot` → clear connecting; **replaceBuffer** with replay text (`size` on the
   snapshot chunk); the viewport replays at the recorded size (resize core → detach writer → write →
   re-attach writer → resize back to fitted grid), which reflows where the shell wrapped.
9. Live events append (`data` events with `replayData` written into the buffer when present).
   PTY resize to the fitted grid via HTTP once the surface settles (§5.3); focus if window focused
   and not touch-input.
10. Exit later ⇒ append localized exit text, lifecycle `exited`, stream detached (session remains
    attachable for replay until close/idle/action replacement).

**Flow 6 — Session shutdown and cleanup (numbered)**:

1. **Explicit close (user closes tab)**: client `DELETE /api/terminal/:id` → registry removes the
   session → every attached socket receives fatal `error CLOSED` → SIGTERM, 1 s, SIGKILL (process
   group on POSIX) → client forgets projection + buffer.
2. **Force-kill**: `POST /api/terminal/force-kill` → immediate SIGKILL (no grace) → fatal `KILLED`
   to attached sockets; by sessionId or, when only `cwd` passed, every session in that directory.
3. **Idle reaping**: 5-min sweep deletes unattached sessions idle > 30 min (fatal `IDLE_TIMEOUT`);
   background clients keep explicit keepalive touches at 10-min cadence (failures are swallowed —
   the server decides freshness, the client only helps).
4. **Server process shutdown** (graceful, §4.8): stop upgrades, stop the sweep, wait pending
   restarts, force-kill all PTYs, await in-flight terminations, close the WS server with a 1 s race.
   Because children are killed as process groups on POSIX, shell-spawned grandchildren (dev servers,
   watches) go with the session; on Windows ConPTY's close is the anchor.
5. **Runtime switch (same-device second server)**: client-side only —
   `disposeTerminalInputTransport()` (socket torn down; in-flight abandoned) + `clearAll()` on the
   terminal store (tabs AND buffers AND mutation revisions). No server calls; orphaned sessions are
   left to the previous server's own idle reaper. (src: apps/runtimeEndpointReset.ts:39–51)
6. **Client unmount** (panel hidden, tab closed, app backgrounded): stream unsubscribe → surface
   teardown: blur the focused textarea FIRST (removing a focused editable mid-IME wedges Android
   WebView), explicitly hide the Android soft keyboard, dispose handles, flush pending resize
   debounces. The server-side session stays alive for the next attach.
7. **VS Code**: no terminal at all — stub API; nothing to clean.

### 7.3 Session observer (mechanics) — the loop that makes reattach possible

`observeTerminalSessions(terminalAPI, directory, captureRevisions, listener)` (src:
terminalSessionObserver.ts):

1. One loop PER adapter (WeakMap) for the whole app, shared by every mounted consumer; scoping is a
   Map of `normalizedDirectory → {listeners, revisionCapture}` per loop. A directory of `""`
   observes ALL sessions (the sidebar and the actions header use an all-directories scope).
2. Cadence: `GET /api/terminal/sessions?cwd=…` every **5 s** while the page is visible and online;
   a single consumer-mount starts the loop; every new scope triggers an immediate refresh.
3. Coalescing: an in-flight request sets `refreshAgain`; new mounts within the same tick are queued
   behind one microtask (mounting many consumers starts one request, not many).
4. Wake/pause: immediate refresh on window `focus`, `visibilitychange`, `online`; timer cleared on
   `offline`; the loop does not run while hidden or offline (no wasted polls — the invariant is
   "authoritative refresh on recovery, never a background storm").
5. Runtime guard: the request captures `getRuntimeKey()` and the started mutation-revision snapshot;
   results are dropped when the runtime changed or a generation counter moved (stale data could
   resurrect tabs from the previous instance).
6. Authority result: `{sessions, startedActionMutationRevisions}`; the caller (TerminalView,
   ProjectActionsButton, SidebarTerminalActivity) feeds `reconcileServerSessions` (§6.2) — one
   server listing decides the tab truth; nothing else writes adopted sessions.
7. Demand profile: TerminalView polls only while its panel is visible; the sidebar polls only while
   SOME action is known running (plus one listing pass on mount, to notice runs other devices
   started); the actions header keeps its own loop while open. Loops close when their last
   listener unsubscribes.

### 7.4 Flow 5 — Terminal selection → composer context ("attach selection" / inline comment draft)

Terminal-driven "file open" in this app is NOT a file: a terminal selection becomes a composer-
attached context item the agent can read in the next user message.

1. User selects text in the terminal (mouse drag / double/triple click; touch long-press). The
   surface maintains the selection in the emulator (spanning wrapped rows).
2. User presses the **Attach selection** toolbar button (or the host equivalent shortcut).
3. The viewport's imperative `getSelection()` returns `{ text, startLine: startY+1, endLine:
   endY+1 }` (1-based, screen rows); empty/whitespace-only selections are ignored.
4. Store mutation: `useInlineCommentDraftStore.addDraft({directory, sessionKey}, { source: 'terminal',
   fileLabel: <active tab label>, startLine, endLine, code: selection text, language: '',
   terminalId: <sessionId or tab id>, text: '' })`. The draft store is the same one a code-comment
   draft uses; `source` and `terminalId` distinguish the terminal variant (the chat renders it as
   "terminal tab label, lines X–Y").
5. Focus returns to the chat composer (`queueMicrotask(focusChatInput)`).
6. The draft is inserted into the NEXT message payload (see 04/05 for transport); it exists only in
   the message body — the agent processes it as text, and the terminal remains untouched.
7. Line numbers refer to the visible screen rows at selection time; they are presentation labels,
   not file offsets (the terminal is not a file view).

## 8. G. Project actions executed in terminals ("ActionTerminal")

Definition/storage (12 owns editor UI; the shape must match):
- Actions live in project setup: a **personal** block (user-global, per-project: settings-stored,
  served by the host) and optionally a **team-shared** file checked into the repo at
  `<repo>/.openchamber/project.json`. Merged view (shared first, personal overrides by id duplicate
  suppression) with a `source: 'shared'|'personal'` marker on the merged entries. Fields:
  `{ id, name, command, icon?, runIn?: 'parent', platforms?: ['macos','linux','windows'],
  autoOpenUrl?, openUrl?, desktopOpenSshForward? }`. (src: ui/src/lib/openchamberConfig.ts:34–68)
- Shared commands are untrusted third-party shell strings: the first time one WOULD run, the UI
  shows the exact commands and waits for explicit trust; refusal runs nothing. Trust is keyed to a
  hash of the shared setup (id/name/icon changes keep trust; command or order changes reset it).
- Optional variable substitution before running: `$ROOT_PROJECT_PATH` / `$ROOT_WORKTREE_PATH`
  (legacy alias) and `${...}` forms → the project root path.

**Flow G — Run an action in a terminal** (client orchestration, exact):

1. Guard: not VS Code; not mobile (unless `allowMobile`); a directory is active. Single-flight per
   `(directory, actionId)` (a starting key blocks re-entry; a `running` run is a no-op).
2. Auto-discovery action (synthetic id `auto-discover`): fetch actions state + `package.json`
   scripts, `detectDevServerCommand` picks the dev command (13 owns detection); no dev server →
   error toast.
3. `getOrCreateActionTab`: find the existing tab for the action in the EXECUTION directory (per
   action `runIn: 'parent'` semantics → the parent checkout dir when running in a worktree) or
   create one; label = action name, icon = action icon; purpose set (`executionId: null` until
   allocated); tab activated.
4. If the tab previously had a live run and the current executionId is null → run
   `reconcileTerminalSessionAuthority` (single-flight listSessions per terminal+directory) first so
   an adopted session from another client is not duplicated.
5. If a running action session exists locally (tab lifecycle running + session id) → ADOPT it
   (`activeSessionId`, `executionId` from the tab purpose) — no new PTY.
6. Otherwise: `allocateActionExecution(directory, tabId, actionId)` → new `executionId`
   (`exec-<uuid>`); store revision snapshot (`actionMutationRevisions++`); buffer for the tab DROPPED
   (fresh run, fresh buffer); `createProjectActionTerminalSession` creates
   `POST /api/terminal/create` with `mode:'command'`, `command: normalizeProjectActionCommand(cmd)`
   (trims, CRLF→LF, strips control chars), `sessionId = executionId`
   (so server dedupe keys on it), `purpose {type:'project-action', actionId, executionId}`, cwd,
   shell, login, appearance.
7. Post-create verification (each failure closes the created session only if it used OUR id — never
   an adopted peer session): mode must be `command` (else `COMMAND_MODE_UNSUPPORTED`), purpose must
   carry a matching actionId+non-empty executionId (else `PROJECT_ACTION_PURPOSE_UNSUPPORTED`), and
   the run must still be expected (else `PROJECT_ACTION_RUN_CANCELLED` — silent).
8. Server-side dedupe may return ANOTHER client's run for the same resolved (cwd, actionId) — its
   purpose (and thus executionId) names the actual execution; the client adopts that executionId.
9. Store: `purpose {actionId, executionId: adopted}`, `terminalSessionId = sessionId` (AKA
   executionId), lifecycle `running` via connect-time snapshot; `stopping` on stop attempts.
10. Subscribe to the session (guarded by `matchesActionExecution(directory, tabId, executionId)`);
    snapshot → `replaceBuffer`; data → `appendToBuffer`; exit → lifecycle `exited`, purpose
    `executionId: null`, cleanup of per-run UI state.

**Output capture + exit codes:**

- Output exits the PTY only: there is no separate action-log channel; the terminal buffer IS the log
  (512 KiB tail). Exit code/signal arrive on the `exit` event and are stored in the projection; tabs
  do not display an exit badge (13's preview + 12's inventory consume state transitions only; the
  localized "process exited (code N)" text is appended to the buffer for plain-reading contexts in
  the non-action flow, action tabs surface state via lifecycle).
- Stop flow (exact steps): mark `stopping`; subscribe-and-wait for exit (up to **1 s**);
  send **`Ctrl+C` (`0x03`) via WS write**; if no exit observed → `forceKill({sessionId})`
  (immediate SIGKILL; command-mode PTY dies with the shell) or `close(sessionId)` on runtimes
  without forceKill; if termination fails → restore `running` (a stopped-dead action whose PTY won't
  die reports as running rather than lying); otherwise lifecycle `exited`.

**URL opening (dev-server actions):** output chunks are scanned for announced loopback URLs;
`autoOpenUrl` actions open the best URL in the preview pane (manual `openUrl` locked when
configured; desktop SSH-forward selection opens the local forwarded URL instead and locks the tab
preview; auto-discovery collects announced URLs, waits **3 000 ms** (`AUTO_DISCOVER_SETTLE_MS`) for
late servers after the first announcement, opens when exactly one, offers a list when several, and
reveals the terminal tab when none arrives within **15 000 ms**
(`AUTO_DISCOVER_PREVIEW_WAIT_TIMEOUT_MS`)). (src: ProjectActionsButton.tsx:76–83, 474–636, 839–944)

URL extraction rules (client scan, from `terminalPreview.ts`; the preview pane is 13's but the
patterns are protocol-relevant):

1. Strip VT escape sequences (`CSI … final-byte`) from the chunk text, normalize CR/CRLF to LF.
2. Python-style announces win first: `Serving HTTP on … port N` → `http://127.0.0.1:N/`.
3. Otherwise per line: the line must look like a server announcement (ETX-mark arrows `Local:`/
   `Network:` or the words `local|network|loopback|serving|listening|available|ready|started|running|server|vite|webpack|next.js|astro|sveltekit|nuxt`,
   case-insensitive) — then every `http(s)://` URL on that line is extracted (`localhost|127.0.0.1|
   0.0.0.0|::1|[::]` hosts, optional port 2–5 digits, path part).
4. Normalize: 0.0.0.0/[::1]/[::] → 127.0.0.1; trim trailing punctuation and unbalanced closers
   (brackets/parens/braces/angle).
5. For actions: `extractProjectActionUrl(text, {requireAnnounced})` prefers step 2–3 answers; with
   `requireAnnounced` (auto-discovery) it NEVER guesses from loose URLs (non-announced links are
   scored only when the command was user-configured: loopback bonus +50, query/hash −10, first-won).
6. Detection is gated: a candidate URL is opened only after a server-side probe
   `POST /api/system/probe-url {url}` (1.5 s budget) answers `{ok: true}` — dead ports never open a
   tab. The scan keeps a 1 024-char tail across chunk boundaries so a URL split across reads is
   still found, and per-generation state is reset on tab switches/restarts.

**Flow H — Shared-action trust (numbered)** (before Flow G step 6 when `action.source === 'shared'`):

1. Load (or reuse the cached) project setup; note `trust: { hash, trusted }` of the merged view.
2. If not trusted: render the exact commands from the shared file's `projectActions` (and worktree
   setup, when that flow runs) — a confirm-only tripwire; canceling runs nothing at all.
3. On confirm, persist a personal trust record for that hash; run the action; subsequent runs skip
   the prompt until the shared content changes. The hash covers the COMMANDS only (action commands,
   their order, and `runIn`); renaming an action, changing its icon, or adding unrelated shared
   fields keeps existing trust valid; any command or ordering change re-arms the prompt.

**Flow A — "Agent targeting a terminal" (explicit non-flow, because the question is common):**

The agent harness does NOT address terminals, and terminals are not a projection target of agent
actions. Concretely:

1. There is no wire message, tool call, or route by which an agent (harness) writes to a terminal
   session, opens one, or reads its output. Not in this design, not as a fallback.
2. When an agent needs to run a command, it uses the harness's own execution channel; its output
   never lands in a terminal buffer and terminal buffers are never scanned for agent state
   (see §1 items 2–3; the enforcement is architectural, not a filter).
3. The coupling that DOES exist runs the opposite way, and is user-initiated only:
   the "attach selection" toolbar button (§Flow 5) and project actions (§G). Both emit *user
   message context*; neither mutates agent state, session status, or transcript labels by itself.
4. The "is a project action running" indicator derives exclusively from `GET /api/terminal/sessions`
   polling (live server channel), never from persisted terminal history and never from agent events;
   when the listing fails, the indicator keeps its previous value rather than decoding a success
   (a failed read must not erase the last authoritative truth).
5. If a replacement harness WANTS its agents to interact with terminals, add an explicit,
   separately-authenticated OpenChamber route for it — do not reuse this subsystem's client transport,
   whose authority model assumes a human at the keyboard (shared cursors, broadcast selection).

## 9. H. Security

- **Who may spawn shells**: any client that passes the server's UI authentication (cookie/bearer per
  03) AND — for the WS — the URL-scoped token or trusted origin. Concretely at upgrade:
  `ensureSessionToken` (401 when UI auth is enabled and the token fails) then
  `isRequestOriginAllowed` (403). Known-origin loopback requests (the desktop app and the relay
  dispatcher dialing loopback) are trusted; the private-relay tunnel carries E2EE frames end-to-end
  so the relay host never sees terminal content. Terminal capability is NOT gated per project — the
  server has one trust level for the machine it runs on: an authenticated user gets shells in any
  existing directory (scoping beyond that is an implementer decision, but the reference design
  intentionally treats UI auth as the machine boundary).
- **cwd validation**: `fs.stat` + `isDirectory()`; missing → recoverable code; no parent
  substitution; no symlink→different-tree checks (a symlink to a directory is accepted).
- **Command injection surface**: create/restart take a shell command string executed by the user's
  shell (command mode). This is by design (it's a terminal). The protections are:
  `normalizeProjectActionCommand` strips control characters (prevents unprintable hijacks like CR
  injection of extra lines), 64 KiB caps, purpose-id/id length caps, and the **shared-action trust
  prompt** before running repo-carried commands. No additional escaping is performed and no
  allowlist of commands exists.
- **Env hygiene**: host-private variables never leak into shells (§4.3), covering the
  daemon-IPC descriptor (privilege boundary to the host), AppImage `ARGV0` (argv[0] corruption
  vector), Electron runtime flags, and shell trace/env files.
- **Relayers/tunnels**: the WS path must be in BOTH allowlists (URL-token gate + tunnel dispatcher);
  the client must use the platform helper that mints `oc_url_token` — a direct socket breaks the
  relay in exactly the documented way (fails with a custom-scheme URL or 401 after stale token).
- **No secrets** in session listings (command text is never returned), never logged.

## 10. I. Edge cases & invariants (normative I-list)

| # | Invariant | Mechanism |
|---|---|---|
| 1 | **No zombie PTYs** | SIGTERM→1 s→SIGKILL (process group on POSIX); force-kill/idle/shutdown kill immediately; delete-while-creating tombstone kills late PTYs; process removal broadcasts fatal closes **even when the backend never fires onExit** |
| 2 | **Exit is never lost** | data/exit listeners wired in the same turn as spawn; events enter one FIFO queue per session before processing |
| 3 | **Cache/replay correctness** | replay = server history + per-event `r` text; query exchanges stripped; incomplete sequences carried across chunks; client chunks replay with recorded PTY size then reflow |
| 4 | **Reattach idempotency** | single-flight creates; dedupe by (cwd,actionId) adopting existing runs; sequence-deduped delivery; per-socket attach idempotent |
| 5 | **One failed entity doesn't erase the rest** | create failure keeps the prior exited action record and its output; per-session errors don't touch other sessions |
| 6 | **Output overflow is lossy-tail, agent-scope loss** | 512 KiB server history cap, projections trim from the HEAD (oldest dropped), latest state always wins |
| 7 | **Hidden clients don't burn the session** | attached ⇒ never idle; background tabs keep themselves alive via 10-min touch; WS backoff 60 s hidden/offline with instant wake |
| 8 | **Font never sizes the grid wrong** | measure only after the faces loaded; re-measure on `loadingdone`; monospace probe; canvas-safe font shorthand |
| 9 | **Cursor is always visible when it should be** | blink restarts on every write; hidden/blink-off/unfocused steady states |
| 10 | **IME never double-sends** | 229/Process/composing keydowns ignored; composition end emits once and suppresses the follow-up input; textarea cleared per input |
| 11 | **Focus never steals on touch** | touch-input surfaces skip programmatic focus; soft keyboard via explicit plugin show |
| 12 | **Runtime switch is total** | transport disposed + terminal store cleared; server sessions continue server-side (server was not restarted), tabs are re-adopted by the observer |
| 13 | **PTY children can't inherit host plumbing** | env deletions + POSIX `env -u` wrapper + ConPTY flag on Windows |
| 14 | **Fish (and friends) never hang on startup queries** | server-side DA1/DSR/OSC answers via stored appearance even before any attachment |
| 15 | **Windows process cleanup works without signals killing groups** | `useConpty: true`; force kill via backend `kill` |
| 16 | **Client ejects dead sockets fast** | pre-open close/error invalidates URL token (fallback retry path); healthy sockets reused ≤ 15 s |
| 17 | **Deduped creates share identity safely** | cancellation cleanup closes only the session id requested for the cancelled run; adopted peers survive |

## 11. J. Build checklist

Implement in this order; each step has a measurable exit.

1. **Server skeleton**: WS path constant + frame codec (`0x01`+JSON, 64 KiB cap), hello/attach/snapshot
   loop; in-memory registry with 20-cap, id validation. Test: two sockets attach the same session,
   see an identical snapshot then identical event stream.
2. **PTY backend**: provider chain (bun-pty when running under Bun, node-pty otherwise;
   `useConpty: true` on Windows), spawn options exactly as §4.3; FIFO wiring. Verify on Windows that
   ConPTY output includes the expected resize redraw and that process trees die on SIGKILL (process
   groups on POSIX).
3. **History + sanitizer** + trim; replay field `r`; test with a script that emits the exact query
   sequences (OSC 10/11, DSR, DA1, 2031) and verify history lacks them while live bytes keep them.
4. **Theme-response answering** incl. DA1-before-attach; test the Fish-like startup probe scenario
   (send `CSI c` pre-attach; must see `CSI ? 1;2 c` on the PTY within 1 s).
5. **Command plane HTTP routes** per §3.7; both origin/token gates; `TERMINAL_CWD_MISSING`.
6. **Restart/close/force-kill/idle** timings exactly (1 s grace, 5 min sweep, 30 min idle, attached
   excluded, touch).
7. **Client transport** (TerminalTransport): reconnect matrix from §3.6; token invalidation; toggle:
   kill the server mid-stream → UI shows non-fatal reconnecting, then settles after restart with one
   snapshot and no duplicated events (q-dedupe proves it).
8. **Ghostty adapter**: vendored wasm + trampoline; struct layout loader; core tests run the REAL
   wasm under the test runner: reflow (resize after wrap), palette bytes, replay isolation (writer
   detached), recycled-row cleanliness (row cache resets when cols change).
9. **Canvas renderer + surface**: dirty-row correctness (pixel-read tests paint primitives on a
   software canvas), box-drawing seams at 1.35 em, cursor styles, blink gating, scrollbar geometry.
10. **Input matrix**: keydown/up encode (legacy + Kitty flag toggling via test terminal programs),
    macOS Option chords, IME composition on WebKit (`keyCode 229`), paste bracketing on/off,
    mouse-reporting modes, wheel-to-arrow in alternate screen, copy/paste token races.
11. **Store + TerminalView**: tab strip, per-directory independence, persisted tabs, execution
    guards; snapshot/append/replay wiring incl. `size` honored; hidden-tab size behavior.
12. **Cross-device**: two clients (browser + phone) attach the same session; both mirror output and
    can write; one closes the other keeps working; reload replays identically (5 s observer).
13. **Project actions** (client orchestration + server purpose support): run/adopt/stop/force-kill;
    server dedupe for concurrent runs of the same action; trust prompt only for shared source;
    exit-code capture on the `exit` event; URL auto-open paths.
14. **Ports/platform tests to replicate**: Windows 10/11 (ConPTY, PowerShell/cmd via ComSpec chain),
    macOS (zsh default, Option chords, CoreText rendering), Linux/Alpine (limited /bin/sh fallback;
    `env -u` wrapper), Bun vs Node server runtimes (`bun-pty` vs `node-pty` parity: same snapshot
    bytes for the same script), Electron in-process (same suite over loopback), VS Code (stub
    unsupported), plus the web-mobile gesture suite.

14a. **Behavior test map** (functional equivalents of the name-referenced suites; replicate their
     coverage, not their file names):

| Behavior | What a test must assert |
|---|---|
| Create dedupe | two `create` calls, same id + same attrs, different attrs (cwd/command/purpose), session cap, id reuse rejection |
| Attach barrier | events emitted during `attach` appear exactly once, either in snapshot or post (q > snapshot.q) |
| Replay sanitization | OSC 10/11, DA1, DSR, 2031 sequences absent from `history`/`r`; present in `d`; split mid-sequence across chunks is still stripped everywhere |
| Theme answers pre-attach | Fish DA1 answered server-side; 2031 notify reaches a subscribed TUI on appearance change |
| Restart ordering | old process alive until replacement wired; `restarted` with empty history; command-mode rejected |
| Close/kill taxonomy | cancellation tombstone; DELETE wins over still-pending create; force-kill by cwd; fatal codes reach attached sockets |
| Idle reaper | unattached + idle reaped; attached never reaped; touch prevents reaping; exited sessions attachable |
| Bun/node PTY parity | same script produces identical replay text under both backends |
| Frame codec | tag byte roundtrip; text frames and wrong-version frames rejected as `BAD_FRAME`, non-fatal |
| Client transport | token invalidation pre-open; backoff caps; hidden/offline 60 s; wake on visible/online; q-dedup; projection trimming to 512 KiB mid-character |
| Store reconcile | placeholder replaced; action dedupe picks running/newest; stale listings (older started revisions) discarded; execution guards honored |
| Ghostty core (real wasm) | reflow after resize; palette layout; replay writer isolation; row-cache reset when cols shrink |
| Renderer pixels | software-canvas reads: background runs, selection overlay, box-drawing coverage to cell edges, cursor styles incl. unfocused hollow |
| Input | legacy vs Kitty encoding switches, release suppression, IME 229/composition paths, bracketed paste toggling, mouse-report modes, wheel→arrows in alternate screen |
| Clipboard races | native event claims token; async fallback ignored when superseded; primed textarea copy; primed copy cleared only when unchanged |
| Chunk replay | incremental append, mid-trim replay of snapshot+live, session swap rebuild via replay (viewport key unchanged) |
| Observer | one request per tick across many consumers; hidden/offline pause; stale runtime/generation dropped; sidebar demand profile |

## 12. Appendix: constants quick-reference

| Constant | Value | Source of truth |
|---|---|---|
| WS path | `/api/terminal/ws` | terminal-ws-protocol.js |
| Frame tag | `0x01` + UTF-8 JSON | same |
| Protocol version | `v: 3` | all frames |
| WS max payload | 65 536 bytes | TERMINAL_WS_MAX_PAYLOAD_BYTES |
| Input/command cap | 65 536 chars | MAX_INPUT_CHARS |
| Session id / purpose-id cap | 128 chars | runtime.js |
| Dims | cols 1–1000, rows 1–500 | validateSize |
| Sessions | max 20 live | MAX_SESSIONS |
| History caps | 512 KiB (server), 512 KiB (client projection), 512 KiB (client buffer) | runtime.js / terminalApi.ts / useTerminalStore.ts |
| Server WS ping | 15 s | index.js |
| Client app ping | 45 s | terminalApi.ts |
| Connect timeout | 10 s | same |
| Backoff | 500·2^(n−1) cap 8 s; 60 s hidden/offline | same |
| Idle socket hold | 15 s | IDLE_SOCKET_GRACE_MS |
| Idle sweep / idle age | 5 min loop / 30 min | runtime.js |
| Client keepalive touch | 10 min | useTerminalSessionKeepalive.ts |
| Kill grace | 1 s | TERMINATION_GRACE_MS |
| Resize debounce | 150 ms | surface.ts |
| Ghostty scrollback | 10 000 rows | MAX_SCROLLBACK_ROWS |
| Cell height | max(1.35 em, glyph box) | renderer.ts |
| Canvas padding | 4 px | CONTENT_PADDING |
| Cursor blink half-cycle | 500 ms | CURSOR_BLINK_INTERVAL_MS |
| Long-press select | 350 ms | TerminalViewport.tsx |
| Multi-click interval | 500 ms / 4 px | surface.ts |
| Font wait | 2 000 ms | TerminalViewport.tsx |
| Selection autoscroll tick | 80 ms | surface.ts |
| Session observer poll | 5 s | terminalSessionObserver.ts |
| Stop-action exit wait | 1 000 ms | projectActionTerminal.ts |
| Preview probe timeout | 1 500 ms | terminalPreview.ts |
| Environment vars stripped | ARGV0, NODE_CHANNEL_FD, ELECTRON_RUN_AS_NODE, BASH_ENV, ENV, BASH_XTRACEFD | runtime.js + inherited-env.js |
| PTY env set | TERM=xterm-256color, COLORTERM=truecolor, COLORFGBG 15;0 / 0;15, PATH=augmented | runtime.js |
| Wrapping launch (POSIX) | `env -u ARGV0 -u NODE_CHANNEL_FD` | resolvePosixPtyLaunch |
| Shell ids | auto bash zsh sh fish pwsh powershell cmd dash ksh nu | shells.js |
| Shell override env | `OPENCHAMBER_TERMINAL_SHELL` | shells.js |

END — 07-terminal.md
