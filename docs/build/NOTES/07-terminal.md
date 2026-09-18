# NOTES 07 — Terminal

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
  hidden/offline slow path, wake on visible/online, 45 s app ping, 10 s connect
  timeout, 15 s idle socket hold, pre-open close invalidates the URL token),
  useTerminalStore (per-directory tabs, sessionStorage persistence of tab metadata,
  buffers map outside persistence, 512 KiB oldest-chunk trim, execution guards,
  actionMutationRevisions, reconcileServerSessions as sole adopting writer),
  session observer (5 s cadence, coalesced, hidden/offline pause, per-adapter
  WeakMap, runtime+revision guards), TerminalView (tab strip + close + restart,
  quick-keys row semantics per section 6.4, create-at-fitted-or-provisional,
  snapshot replay with recorded size, exit text, fatal banner states), MainLayout
  toggle; Flow 5 (attach selection -> inline comment draft store source 'terminal'
  + composer focus via the P6-3b channel).
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

## C. Constants pinned this slice

All from section 12 (exact): WS path /api/terminal/ws; frame tag 0x01; protocol v3;
payload cap 64 KiB; input cap 64 KiB chars; session/purpose id cap 128; dims
1-1000 x 1-500; MAX_SESSIONS 20; history/projection/buffer caps 512 KiB; server WS
ping 15 s; client app ping 45 s; connect timeout 10 s; backoff 500*2^(n-1) cap 8 s /
60 s hidden-offline; idle socket hold 15 s; idle sweep 5 min / idle age 30 min;
keepalive touch 10 min; kill grace 1 s; resize settle 150 ms; session observer 5 s.
