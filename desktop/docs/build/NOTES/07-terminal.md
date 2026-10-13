# NOTES 07 — Terminal

> **Historical implementation note — 2026-10-01:** Retained for contracts and dated evidence.
> Current scope, ownership, remaining work, and acceptance are defined by
> [PLAN](../PLAN.md) and the [execution audit](../EXECUTION/01-architecture-audit.md).
> Old mock-only, auto-accept, lifecycle, and deferral instructions are superseded.
> A recorded test pass is limited to its stated version and surface.


Doc read in full (1,316 lines). P7 sliced per the doc's build checklist (section 11).
Nothing relaxes the contracts; this file records the adaptation deltas and registered
approximations for the multi-session build.

## A. Slice map vs build checklist (section 11)

- **P7-1 (server core)** — checklist steps 1-6: `terminal/` server family: WS protocol
  codec (0x01+JSON tag frame, v3, 64 KiB cap, BAD_FRAME/SESSION_NOT_FOUND/BAD_INPUT/
  NOT_RUNNING/WRITE_FAILED/CLOSED/KILLED/IDLE_TIMEOUT/SUPERSEDED taxonomy), session
  registry (20-cap, id<=128, existing-running dedupe by id/cwd/purpose, action
  adoption, pending single-flight, delete-while-pending tombstone, dims 1..1000x1..500,
  TERMINAL_CWD_MISSING), history sanitizer (OSC 10/11/12 + DSR/DA/CPR + 2031 query/
  report/set strips with cross-chunk carry, `r` replay variant), theme-response
  answering server-side before any attachment (Fish DA1 + 2031 + 996/997), PTY
  backend node-pty with useConpty on Windows (doc section 4.3) + shells discovery
  (allowlist ids, OPENCHAMBER_TERMINAL_SHELL override, auto chains, login args,
  command argv tables) + env hygiene (deletions; POSIX env -u wrapper), WS endpoint
  `/api/terminal/ws` with attach barrier/snapshot and 15 s protocol ping, HTTP
  command plane (shells/sessions/create/resize/appearance/restart/DELETE/force-kill/
  touch), idle sweep 5 min / 30 min unattached, kill grace 1 s, restart serialization,
  server shutdown (section 4.8). All timings exact per section 3.6/12.
- **P7-2 (client)** — checklist steps 7+11-12: TerminalTransport (one socket,
  projections 512 KiB, q-dedupe, reconnect matrix 500ms*2^(n-1) cap 8 s, 60 s
  hidden/offline slow path, wake on visible/online, 45 s app ping, 10 s
  connect timeout, 15 s idle socket hold, pre-open close invalidates the URL
  token), useTerminalStore (per-directory tabs, sessionStorage persistence of
  tab metadata, buffers map outside persistence, 512 KiB oldest-chunk trim,
  execution guards, actionMutationRevisions, reconcileServerSessions as sole
  adopting writer), session observer (5 s cadence, coalesced, hidden/offline
  pause, per-adapter WeakMap, runtime+revision guards), TerminalView (tab
  strip + close + restart, quick-keys row semantics per section 6.4, create-at-fitted-or-provisional,
  snapshot replay with recorded size, exit text, fatal banner states), MainLayout
  toggle; Flow 5 (attach selection -> inline comment draft store source 'terminal'
  + composer focus via the P6-3b channel).
  - **P7-2 delivery (this slice)**: wire.ts/transport.ts/transport-singleton.ts
    mod-splits; store.ts; observer.ts; terminal/TerminalView.tsx (hook-split
    for the 60-line span cap); server-api terminal command-plane family;
    i18n terminal.* keys; tests: 12 transport + 11 store + 5 observer + 2
    view = 30 for the slice. Adversarial review registered E-07-14..23
    below; web package untouched. Flow-5 v1 shape: startLine/endLine stay
    1/1 (E-07-1), the selection rides the draft `text` field (the P6
    composer consumer fills from `text`; doc 7.4's `code` trio is
    registered with the renderer), and the draft carries `terminalId`
    (sessionId fallback tab id). A refused/failed RESTART keeps the tab
    live (toast only, no demotion/buffer drop): the session still exists
    server-side.
- Registered beyond P7: renderer is NOT libghostty-vt (see delta), input/mouse
  encoding matrix, IME lifecycle, ghostty tests, project actions orchestration
  (doc 12 phase), URL extraction (doc 13 phase), cross-device-with-two-clients
  soak tests (covered by protocol-level tests instead), VS Code stub (P12 shell).

## B. Adaptation deltas (registered)

- **E-07-1 (renderer swap, E19-style)**: the ghostty-vt WASM adapter, Canvas 2D
  atomic cell renderer, box-drawing procedural glyphs, and the IME/selection/link
  surface (doc 5.1-5.6) are replaced in v1 by a first-party line-buffer terminal:
  snapshot history rendered as a scrollable monospace pane with VT query exchanges
  removed (server `r`/history are already clean), CSI/OSC filtered for display,
  \r-overwrite v1 approximated by normalizing to LF, and input through a terminal
  input line + quick-keys row (full keystroke encoding per section 5.2 columns is
  registered to the adapter swap). The WASM artifact (vendored binary), the 121-byte
  trampoline, struct-layout loader and its test-suite gates (checklist step 8-10)
  land with the adapter swap.
- **E-07-2 (server PTY dims)**: node-pty resize works; the v1 renderer computes its
  own grid, so a resize notification records the accepted size on the session and
  forwards pty.resize exactly (no client-side reflow engine to reflow).
- **E-07-3 (auth/relay)**: the URL-scoped `oc_url_token` gate + relay tunnel
  allowlisting belong to docs 03/08 (P12/P8 phases); the v1 WS endpoint rides the
  local-server trust boundary (loopback origin check) — the gate slot is marked.
- **E-07-4 (bun-pty patch)**: not applicable (Node runtime only); the same-turn
  listener rule is preserved. Run parity test on Windows only.
- **E-07-5 (theme)**: appearance scalars (themeMode/terminalBackground/
  terminalForeground) ride create + /appearance exactly; the client token mapping
  table (section 5.7) lands with the renderer swap.
- Env var name: doc says `OPENCHAMBER_TERMINAL_SHELL` — NND reads
  `NOTNATIVE_TERMINAL_SHELL` (documented rename per NOTES/03 brand seam).

## B2. P7-1 adversarial-review deltas (registered this pass)

- **E-07-6 (bounded sequence carry)**: the doc keeps silent on UNTERMINATED
  sequences with unbounded bodies. The history and theme scanners cap the
  cross-chunk carry at 8192 bytes; a body beyond the bound is abandoned
  together with the rest of its chunk (bounded loss; the carried partial can
  never grow without limit and scanning resumes fresh on the next chunk).
- **E-07-7 (create over an exited id)**: section C.2 #2 defines same-id
  dedupe for RUNNING sessions only. v1: an EXITED record holding the id
  (either purpose) with matching identity (cwd/purpose; mode+command for
  plain) is REPLACED by the new create (fresh PTY, old record's history
  dropped); its attached viewers receive the documented fatal `SUPERSEDED`
  and re-attach by id. Identity mismatch stays a 400 (section 4.1).
  Exited ACTION runs otherwise follow C.2 #6 exactly (retire only after the
  new PTY starts; the retirement now also broadcasts `SUPERSEDED`).
- **E-07-8 (cap accounting)**: MAX_SESSIONS=20 counts running records,
  pending flights, and exited PLAIN records (they remain attachable until
  close/idle); only exited action records for the same resolved cwd+action
  are exempt (C.2 #6 wording lists exactly that exception). The doc leaves
  plain-exited accounting open; counting bounds the registry.
- **E-07-10 (server shutdown granularity)**: section 4.8 orders "await
  pending restarts, await in-flight terminations". v1 `dispose()` is
  synchronous: it tombstones pending creates, broadcasts fatal closes,
  kills every PTY (SIGTERM groups on POSIX, ConPTY close on Windows), and
  the 1 s escalation timer is unref'd; pending restart chains are dropped.
  Awaiting in-flight terminations needs an async host step (slot marked).
- **E-07-11 (appearance scalars bounded)**: `themeMode` must be exactly
  `light`/`dark` on create and /appearance; color strings are capped at 128
  chars (they are echoed back into OSC query replies). Falling back: a
  MISSING foreground/background answers white/black respectively; a
  PRESENT-but-unparseable value answers white (doc 5.7 says "white/black"
  without a direction table).
- **E-07-12 (WS socket lifecycle extras)**: on client close/error the wire
  calls `detachSocket` so every session attachment of the dead socket is
  dropped (held attachments would block the idle reaper forever); frame
  intake is exception-safe (an unexpected throw answers BAD_FRAME instead
  of crashing the process); the intake grammar bounds client session ids to
  1..128 chars (empty/overlong = BAD_FRAME); the write cap stays 65 536
  CHARS per section 3.3 (the 65 536-byte cap is separately the WS
  maxPayload); re-attach re-sends the snapshot (idempotent per socket
  section 3.3; inert behind client q-dedupe); `dispose()` closes clients
  with the 1 s terminate race from section 4.8.
- Implementation notes from the review (bug class, not deltas): the
  pending single-flight matches on the NORMALIZED cwd (backslash/slash/
  trailing-slash respellings stay one flight, C.2 #4 "resolved cwd");
  restart serialization is keyed by session id and re-resolves the CURRENT
  record (a restart queued behind a completed one must not 404);
  force-kill requires sessionId or cwd (400 per the 3.7 envelope) and
  tombstones matching in-flight creates so no late PTY can outlive it;
  sessions listing filters use the same normalization on both sides.
  node-pty is required through `createRequire` (the package is ESM under
  Node strip-only execution; a bare `require`/parameter property crashes
  `node src/server/index.ts` boot).

## B3. P7-2 adversarial-review deltas (registered this pass)

- **E-07-13 (buffer-version tick, backfilled from the slice code)**: the
  doc keeps buffers OUTSIDE the persisted zustand state (section 6.2), but
  the v1 line-buffer viewport still re-renders on arrival, so every buffer
  write bumps a per `(directory, tabId)` counter in the store; the surface
  swap (E-07-1) removes this mechanism.
- **E-07-14 (create storm gate)**: section F1 step 5 re-arms create on every
  store patch while a tab lacks a session id, so a FAILED create (or a
  listing demotion, or a fatal error) retried POST /api/terminal/create in
  an unbounded pump. v1 spawns only the seeded idle placeholder; a failed/
  exited tab is retried by user action (the + tab button), never re-created
  automatically. Corollary: hydrated strips are lifecycle 'exited' and wait
  for the 5 s listing instead of racing a duplicate create before the
  snapshot (Flow 2 step 3 links by id since creates use sessionId = tabId);
  a directory whose listing stays empty keeps its dead exited tab (user
  adds a new one). v1 replaces the doc's "fatal banner retry" surface.
- **E-07-15 (observer wake gating)**: section 7.3 step 4's wake set fired a
  listing pass on HIDE too (a wasted request at the exact moment the page
  went dark). v1 gates focus/visibilitychange/online wakes on visible +
  online, matching the cadence-timer pause; the invariant "authoritative
  refresh on recovery, never a background storm" now covers events too.
- **E-07-16 (observer scope lifecycle)**: scopes stopped their timer when
  the last listener left but stayed in the map forever (dead directories
  accumulate). The last unsubscribe now DELETES the scope; the unused
  per-scope runtimeKey field is gone (runtime staleness is guarded inside
  the request by the captured key).
- **E-07-17 (reconcile authority)**: section 6.2's per-action dedupe was
  order-dependent (the LAST listing candidate silently won; a running
  session listed before a newer exited one produced TWO tabs for the same
  action), and plain sessions collided on a shared dedupe key (two plain
  exited sessions collapsed into one tab). v1 groups candidates per action,
  picks the authority in the documented order (running > newest createdAt >
  highest sessionId), drops the superseded local action records, keeps
  user-driven starting/stopping tabs out of listing demotions, seeds a
  fresh tab when an unknown directory meets an empty listing (previously a
  crash path), and fingerprints identical listings as a no-op (the 5 s
  cadence stopped rewriting state/re-rendering and resetting the 10-min
  keepalive interval every tick).
- **E-07-18 (client create single-flight)**: the single-flight ref held only
  the last value, so a fast tab switch during create could start a second
  concurrent create. v1 keeps a per-tab flight Set keyed by tab id
  ("single-flight per (directory, tab)").
- **E-07-19 (attach on a CONNECTING socket)**: subscribe sent attach when a
  socket object existed even if still connecting; a real browser WS throws
  InvalidStateError on send-before-open, which tore down a healthy dial and
  burned a reconnect attempt (invisible in the fake-socket tests). v1
  tracks socketReady; attaches defer to onopen (the open loop re-attaches
  every subscription id, covering late session joins mid-dial).
- **E-07-20 (kill button semantics)**: the quick-key Kill button issued
  DELETE /api/terminal/:id (documented CLOSE semantics, section 6.8) while
  labelling itself a kill. v1 rides POST /api/terminal/force-kill
  {sessionId} (immediate SIGKILL per section 3.7), so the label now names
  the behavior; the tab-level 'x' close remains the DELETE close, and the
  exit event demotes the tab.
- **E-07-21 (tab close failure)**: section 6.8 ties tab close to the
  session delete; a failed DELETE rejected before removal (tab + buffer
  preserved, the session still runs server-side) but callers voided the
  promise (unhandled rejection, silent no-op). v1 keeps the conservative
  semantics and surfaces a terminal.closeFailed toast at the view.
- **E-07-22 (bounded redraw ticks)**: the E-07-13 bufferVersions tick map
  grew unbounded across session churn. Entries are pruned on buffer drop
  (they mirror LIVE buffers only) and reset with the test reset. The
  buffer map itself retains exited-tab content on purpose: the exited
  session stays attachable and the tab displays its final output until
  close/restart (closeTab drops it), so growth is bounded by tabs the user
  can close, registered rather than auto-evicted.
- **E-07-23 (unsubscribe/handshake hygiene)**: the transport unsubscribe is
  idempotent (a double React cleanup must not re-send detach or reschedule
  the idle hold), a re-subscribe inside the hold window re-attaches and
  cancels the close, and the reconnect counter resets when a scheduled
  reconnect fires with zero subscribers (the next subscribe negotiates a
  fresh backoff instead of inheriting a stale attempt).

## C. Constants pinned this slice

All from section 12 (exact): WS path /api/terminal/ws; frame tag 0x01; protocol v3;
payload cap 64 KiB; input cap 64 KiB chars; session/purpose id cap 128; dims
1-1000 x 1-500; MAX_SESSIONS 20; history/projection/buffer caps 512 KiB; server WS
ping 15 s; client app ping 45 s; connect timeout 10 s; backoff 500*2^(n-1) cap 8 s /
60 s hidden-offline; idle socket hold 15 s; idle sweep 5 min / idle age 30 min;
keepalive touch 10 min; kill grace 1 s; resize settle 150 ms; session observer 5 s.
