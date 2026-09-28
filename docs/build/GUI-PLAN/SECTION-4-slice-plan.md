# GUI-PLAN — Section 4: Slice plan (ordered)

Every slice states: the **user guarantee** (the acceptance test a human can
perform), file targets in this workspace, which harness seams are real vs
still mock, what it must precede, and the W-ids from Section 1 it advances.
Each slice ends in a working build of the installed app (packaging pipeline
re-runs: `pnpm --filter @notnative/electron package`, watch the three
boot-killers seen in main.log — bundle location, esbuild CJS `require`,
settings-registry.json adjacency).

---

## SLICE-A · `chat-alive` — the app looks ALIVE (SMALLEST FIRST)

> **Status (2026-09-22, ACCEPTANCE CLOSED — P12b-5):** task 1 landed earlier
> behind seal; P12b-5 fixed the two defects that kept the decision inert and
> closed the acceptance on observation (fresh headless profile, prod server,
> CDP drive): (a) the sidebar lifecycle ordering stripped session records to
> `{id,parentID,time}` ("Untitled Session" in every row, row-open lost its
> directory) — `orderSessionsByLifecycle` is now generic
> identity-preserving (sync/session-ordering.ts + the wrapper in
> chat/session-sidebar.tsx); (b) boot-open raced: `resyncDirectory('initial')`
> short-circuits on a fresh boot (zero reconnect candidates), so the open
> decision ran against an EMPTY list — `sync/boot-open-readiness.ts`
> `awaitAuthoritativeList()` now gates the decision on
> `sessionListSource === 'authoritative'` (bootstrap sets status 'complete'
> BEFORE the phase-3 list merge), failure, or the 6 s cap. Verified live on
> the mock harness: boot auto-opens the seeded welcome session; unthrottled
> window streams the typed turn with the busy chip and settles <1 s; the
> mid-flight `stop` button settles with the doc-05 aborted face; reload
> restores the same session with history (persisted pointer). Tasks 2–4 are
> verified rather than re-wired (streaming sidecar + settle timing + stop
> chips behave per spec in the unthrottled drive); task 3 (copy) already
> honest; task 6 tests landed (readiness ×5 + ordering identity ×1). User's
> installed copy additionally ran a stale 09:54 web-dist (installer skip)
> — refresh the installed artifacts after any bundle change.

**Guarantee (hand-acceptable):** "I open the installed app, log in if asked,
and within seconds I am INSIDE a session. I type a message, press enter, and
watch the reply render live — text appears in chunks, a busy chip shows while
it works, then settles to idle. I press stop mid-stream and the turn ends
with an aborted error face. I close the app and re-open it: I land back in
the same session with the same history."
No server restart must be involved in that loop; a server restart legitimately
resets the mock's in-memory history (documented in-app).

**Why it is first:** every ingredient already exists (SECTION-2 §2.1); this
slice is pure wiring + polish on top of the verified mock loop
(`sim.ts:115–143` streams 16-char deltas every 60 ms; the engine consumes
them; `terminal-text` pipeline renders). The installed app looks empty only
because boot lands on an unopened draft and mock state is invisible.

Tasks:
1. **Boot-open**: adopt `readLastActiveSession()` in `engine-instance.ts`
   `partsStart` (sync/engine-instance.ts:151–160) — after the directory
   bootstrap resolves the session list, set
   `useSessionViewStore.currentSessionId` to the persisted session if it
   still exists, else the single seeded welcome session, else stay null.
   Call `persistLastActiveSession` (persist-cache.ts:154) from
   `onSelectSession` + `setCurrentSession` call sites (engine-instance.ts:321–324;
   session actions) so the restore pair is wired both ways.
2. **Live-tail UX**: verify the streaming sidecar + transcript live row
   (sync/activity-streaming.ts, chat/transcript.tsx) render chunk deltas with
   the busy chip (chat/work-status panel already reads `session_status`); fix
   any settle timing (D.7) so the chip flips to idle exactly when the mock
   settles.
3. **First-run copy**: keep the mock seed text but make it honest product
   copy ("Mock harness mode — NNA arrives next; this session streams exactly
   like the real one"). Update mock `welcomeSeed` (harness/mock/index.ts:43–78).
4. **Abort/undo/redo visible**: MainLayout `undo` command already wires
   revert-to-last-user (MainLayout.tsx:77–105). Surface stop +
   composer-status-bar chips per doc 05 §E.6 (small).
5. **Gate copy**: I18n keys for the auth gate (currently English literals via
   `labels` injection, SessionAuthGate.tsx:24–26 n.); register them (W-64
   polish). With `desktopUiPassword` set on a machine, first paint is the
   gate — make sure its labels ship correct.
6. Tests: engine-side boot-open test with the mock harness
   (sync/__tests__/harness-client-mock.ts already provides the rig); a
   ChatView integration test streaming through `harness/mock` events
   (mountEngine path).

**Seams:** harness = mock (unchanged). NND server routes = real (events, auth,
settings, fs/git). **Precedes:** everything (B, C, D, F visuals).

W-coverage: W-12, W-27, W-31, W-32, W-19's chip, W-03's splash transitions.

---

## SLICE-B · `review-band` — the review surfaces turn real for real projects

**Guarantee:** "With my repo open as the workspace, the Files tab shows my
real tree; I can open/edit/save a file with autosave; the Diff tab shows my
uncommitted changes per-file with working/staged scope; the Git tab can stage,
discard and commit; the Worktrees dialog lists and creates a real worktree;
the Terminal tab opens a live PowerShell PTY I can type in."

Tasks:
1. Review surfaces already have real client+server (FILES: lib/files/api.ts +
   routes/fs*; GIT: lib/git + routes/git* + git-diff; WORKTREES:
   server-api.ts + routes/git-worktrees; TERMINAL: real PTY runtime +
   transports). Close the v1 gaps to the doc contract:
   - FilesView tree status dots + tabs store persistence (lib/files/tabs-store.ts exists),
     search overlay, dialogs polish (06 §2 acceptance rows 5–8) — compare against
     OC `views/files/directoryRequests.ts` semantics.
   - DiffView layout/large-diff gates + hunk actions endpoints apply (routes
     support `apply-hunk` — lib/git/api.ts:79) — port OC `diffPatchUtils.ts` +
     scroll anchoring pieces named in SECTION-3 §3.5.
   - GitView stage/unstage/commit wired to `/api/git/*` (already), plus
     reconcile cadence from doc 06 §6 + log/branch dialogs (06 §6.7–6.8).
   - TerminalView: replace the `createWebAPIs` terminal stub seam with the
     real terminal lib wiring (SECTION-2 §2.5), keep `RuntimeAPIs.terminal`
     real on desktop too (used by tests).
2. Directory/project identity: wire the doc-04 directory-resolution for
   review panes to the ACTIVE directory = the harness workspace
   (defaultHarnessDirectory → engine-support.ts:76–85) instead of falling
   back to `/`.
3. Invalidation triggers: port doc 06 §11 tables minimally for
   git-status/file content events (event-reducer already tags some) and the
   visibility gating (`visible` prop on FilesView/DiffView — present in
   MainLayout.tsx:240–255; implement the buffered-refresh replay per §13#1).

**Seams:** harness = mock; fs/git/terminal = REAL server routes (already).
**Precedes:** C (both chat+review share the store plumbing); needs A (boot
stability + directory bootstrap).

W-coverage: W-46–W-52 (majority), W-59–W-63 subset, W-55 partial.

---

## SLICE-C · `session-product-b` — the chat product catches up on the mock

**Guarantee:** "My session list behaves like the docs: I can create folders,
pin/archive/restore, rename live (PATCH), see busy/blocked badges; the
transcript renders a tool card live when the harness emits one (with the
expandable JSON/bash result), permission and question cards appear and reply
properly; queued messages show as chips while the session is busy and send
after idle; the timeline dialog can fork from any turn."

Tasks:
1. **Part catalog**: extend `chat/transcript.tsx`/`turns.ts` toward the OC
   `chat/message/parts/*` inventory (SECTION-3 §3.2): tool card states + JSON
   summary + bash live output; markdown hardening. Extend the MOCK to emit
   tool/step shapes (mock/sim.ts applyTriggers already demos
   permission/question/todo — add a `tool` trigger) so the renderer is
   testable pre-NNA.
2. **Sidebar product**: wire `lib/nnd` + session-folders routes
   (routes/session-folders.ts exists) to a folders store; archive view
   (current `time.archived` split already in globalSessions store);
   rename = real `updateSession` (mock PATCH works, main.tsx toast text is
   stale — MainLayout.tsx:136–139); pins/multi-select later.
3. **Permission/question flow completeness**: reply routes under /api +
   v2 surface exist in the mock; align card UI to doc 05 §F (incl.
   send-while-blocked rule) and server-side auto-accept policy persistence
   (doc 03 §6.7 reference when building it).
4. **Queue UI on the existing server**: build `messageQueueStore` (doc 12
   §D.6/§D.7) against `server/queue/queue-routes.ts` (already registered,
   app.ts:211 + p9-1 suites): composer queue/steer chips + reorder/clear.
   This is the bridge that later lets SLICE-D's runs behave.
5. **Timeline dialog + prompt rail rows**: fork-from-here etc. (mock fork
   exists) per doc 05 §A.7.

**Seams:** harness = mock (extended shapes; not the NNA contract surface —
all additions stay inside doc 02 shapes). **Precedes:** D (queue store + part
renderer are its dependencies). Depends on A; parallelizable with B after A.

W-coverage: W-17, W-18 (core), W-20, W-23, W-16, W-87's UI half.

---

## SLICE-C2 · `operator-rail` — observe work without leaving the session

**Guarantee:** "I can keep the active conversation on screen while opening a
right-side Context, Activity, Changes, Notes, Browser, or Terminal pane. The
Activity pane follows the live session as a readable event log; each entry opens its
real supporting evidence. Closing and reopening a supported pane preserves my useful
working state without background polling when it is hidden."

Tasks:

1. Replace the header-toggle replacement model in `MainLayout` with a dockable
   surface host and narrow rail. Persist local order, visibility, per-engine-context
   identity plus directory widths, panel open state, and selected tab; make the host a UI-state owner, not a
   second source of session state.
   **Order/visibility implemented (2026-09-25):** an in-rail customization
   control saves the pane order and visible set by runtime/directory, repairs
   malformed saved values, and prevents hiding the final pane.
   **Open-state continuity implemented (2026-09-27):** explicit dock open/close
   choices restore by runtime and workspace. An untouched responsive default
   is not persisted as an operator preference.
2. Promote the existing work-status content into the Context surface. Add the Activity
   surface over explicit normalized mock evidence events first; message parts and
   blocking records remain linked evidence, not synthetic log rows. Its event model
   must retain order, event identity, correlation, severity, evidence link,
   explicit unavailable/compacted gaps, and NNA-authored redaction/revocation/correction
   frames. The mock must emit explicit normalized evidence events; NND must not infer a
   purported engine log from message parts or blocking records. No private reasoning or
   secret-bearing raw payload can enter the surface by default.
3. Host the existing Diff/Files/Git material as Changes, and host Terminal as a
   keep-alive pane. Adopt visibility-gated refresh/reconnect behavior rather than
   replacing a hidden pane with a new instance.
4. Add the Notes surface as project-owned general notes, todos, and plans. Keep agent
   memory source-labelled and behind the later NNA knowledge contract. A plan opens in
   the panel with an explicit project owner.
   **Primary navigation implemented (2026-09-26):** resolved projects open
   project-owned General/Todos/Plans first; repo-local files remain available
   under Workspace files pending safe migration. A UI-local query now filters
   note bodies, todo text, and plan titles without changing stored lists;
   snapshot match counts now let operators jump to another section. The
   section lists still own their read state, so counts are refreshable rather
   than claimed as live authority. An explicit scan/preview/confirm flow can
   copy bounded legacy note/todo files into project context without deleting
   originals; longer notes and session plans still need a migration path.
5. A user-driven, sandboxed iframe preview may occupy Browser before the full
   preview/inspection contract. Keep it clearly labelled as a limited manual
   preview; agent navigation, capture, annotation, and take-over wait for
   NNA-scoped authority and the P11 guest-browser contract.
6. In SLICE-E, replace mock activity inputs with NNA projection/evidence replay and
   verify resume cursors, redaction, permission/question links, tool receipts, and
   state authority against the real harness.
7. Add delegated-session rows to the navigator and read-only child transcript tabs.
   Use child summaries for sidebar activity and demand-load each transcript only when
   opened. The real NNA adapter must supply parent/child correlation, replay cursors,
   redaction, and per-action authority. Add the child transcript's **Steer subagent**
   toggle only when NNA grants steering capability; it reveals a labelled steering
   composer and preserves an unsent draft when toggled off. NND must not let a parent
   session imply control over its child. Render a discoverable child whose parent is
   unavailable in a labelled orphan group; its parent reference and return action must
   be disabled rather than guessed.

8. Define compact-viewport behavior before mounting the rail: below the usable
   side-by-side threshold, foreground exactly one surface with an explicit return to
   chat. A resize must not silently hide the chat or move composer focus.
   **Implemented (2026-09-25):** the compact Surfaces door foregrounds the
   selected pane below `xl`; Return to chat restores focus to that door. The
   chat column remains visible at `xl` even if the compact door was open
   during a resize. Focus-mode suppression retains the rail's terminal
   keepalive without its active stream; a CSS-hidden compact rail also pauses
   terminal stream and observer work. Per-directory terminal keepalive across
   directory switches remains separate lifecycle work.

**Seams:** initial Context/Changes/Terminal use existing NND stores; initial Activity
uses the mock's explicit normalized evidence events. Agent-driven browser inspection
and NNA agent-memory data remain unavailable until their governing contracts land.
**Precedes:** richer autonomy and capability UI, which
should appear in the rail instead of creating disconnected status pages.

W-coverage: W-05, W-06, W-13, W-17, W-19, W-46–W-55, W-56–W-63, W-106–W-113,
W-116, W-117.

---

## SLICE-D · `autonomy` — goals, scheduled tasks, multi-run/fusion

**Guarantee (works fully once NNA real; testable on mock):** "I can arm a
goal on a session and watch the loop keep the turn chain alive; scheduled
tasks appear in my project with cron/tz preview and run on time; I can
launch a multi-run to N models in isolated worktrees, compare, and adopt or
fuse results into a new session; the agent manager shows the group's
worktrees."

Tasks:
1. Goal routes: port `OC server/lib/session-goal/{create.js,routes.js,runtime.js}`
   into `packages/web/src/server/goals/routes.ts` + runtime
   (goal-payload/state/metadata already exist + p9-2a tests) — add the small
   model exchange (02 §7.4; mock echo first, real later in E).
2. Scheduled tasks server: port `OC server/lib/scheduled-tasks/{runtime.js,service.js,loops.js,routes.js}` semantics (cron lib + IANA tz per 12
   §C.2; multi-writer lock) into `packages/web/src/server/scheduled-tasks/*`
   + per-project config persistence.
3. Multi-run: port `useMultiRunStore` + launcher/fusion dialogs + agent
   groups manager (SECTION-3 §3.9) with the `openchamber-sessions`
   equivalent service routes (12 §F.1) adapted to NNA naming.
4. Wire control events (`openchamber:scheduled-task-ran` equivalents) through
   `/api/notnative/events` (routes/notnative.ts:71–83) and the control
   subscribes already in app-engine.ts:51–54.
5. Goal UI: composer target button, goal strip, manage dialog, sidebar glyph
   (12 §H) driven by goal metadata (goal-metadata.ts).

**Seams:** turns/answers still = mock (flows validated); small-model =
mock echo; real autonomy requires SLICE-E. **Precedes:** F (notifications of
goal completion); needs A + C (queue + part rendering + fork flows).

W-coverage: W-85–W-90, W-87 completing (holds/VS Code auto-send deferred to
vscode later), W-112 partial (magic prompts as fusion templates — server
routes to build in C/D cut line).

---

## SLICE-E · `nna-real` — the NotNativeAgent goes real behind the seam

**Guarantee:** "Chat answers come from a REAL model through NNA: the streamed
deltas are the model's tokens; tool calls actually read/edit files in my
workspace; permissions asked by the real agent surface in my UI; the server
can restart/upgrade the harness process without breaking my session link;
docs promise can connect to an external instance (host attach)."

Tasks (doc 02 is the authority):
1. Implement `packages/web/src/server/harness/nna.ts` (HarnessAdapter) with
   port milestones P-01…P-24 (02 §9): first the §12.1 minimal checklist
   (health/session CRUD/message read/write/prompt_async/SSE with the exact
   event vocabulary per §5.2, directory headers §3.5a), then §12.2 full
   (v2 permissions, commands, fork/abort/revert/summarize, todos, quota,
   small-model reuse, injections: control tools + knowledge + goal intro;
   LF-1 restart/upgrade semantics + external attach LF-2).
2. Server-side wrappers for injected server-owned payload pieces (sanitized
   session list already at app.ts:32–67; enriched routes per 02 §4.1).
3. **Done (2026-09-25):** `NOTNATIVE_HARNESS` defaults to `nna`; product boot
   owns a managed loopback NNA child, while `mock` remains an explicit
   CI/development adapter. Keep the seed welcome out of the real adapter.
4. Real-tool-run plumb: tool parts in transcript (exists from C); fs/git
   routes are already server-owned and harness-independent.

**Seams:** ALL harness surfaces go real; NND-owned routes (fs/git/terminal/
auth/queue/goals...) stay server-real. **Precedes:** F's notifications with
real attention chips; G's preview/inspection capture by the real agent
(agent-tool). Depends: A–D (parts, flows); can be scheduled in parallel
tracks with B/C as a server-track slice on a feature flag.

W-coverage: W-38–W-45 (the seam half), W-40–W-45, unblocks W-85/86 real runs,
W-93/94 real captures.

---

## SLICE-F · `settings-shells` — settings parity + shell completion

**Guarantee:** "The Settings window covers parity pages (general, appearance,
chat, sessions, notifications, shortcuts, plus remote instances/tunnel/relay
subjects); my theme choice + persist across surfaces; the Electron app has a
tray with actions, native notifications (badge/click routing), deep links
(`notnative://connect?...`) that pair a phone/web device, geometry restore,
and an updater flow (check → download → restart install) with release notes."

Tasks:
1. Registry snapshot pipeline: generate + gate the settings-registry.json
   (server side, already strict) — port `OC lib/settings/registry-snapshot.ts`
   flow; fix the packaging adjacency invariant (main.log 04:32:03 ENOENT).
2. Pages: port OC section components (SECTION-3 §3.11) — remote instances,
   tunnel, relay, notifications chips text, voice/dictation skeleton.
3. Electron: port doc 09 §4–§5, §10 (window model + deep links + tray/
   notifications + updater) + §12 file utilities; wire into main.mjs IPC
   catalog (currently 2 commands, main.mjs:359–373).
4. Notifications server: attention chips + web-push routes (doc 03 §5.37/
   §6.3) behind the gate; client store + Electron notifier seam.
5. PWA: service worker + update prompt (SECTION-3 §3.1).

**Seams:** unchanged (harness from E); new server surfaces are NND-owned.
**Depends on:** A (gate), D (goal-completion notifications), E (real attention
states). 

W-coverage: W-64–W-72 UIhalf, W-73–W-84, W-98–W-105 completion, W-115.

---

## SLICE-G · `inspection-knowledge` — the intelligence surface (last)

**Guarantee:** "A walkthrough explains my diff stage by stage; the built-in
preview embeds my dev server and the agent can inspect/capture it; my
projects have notes/plans/memory; skills appear in the composer and MCP
servers can be added from settings."

Tasks: doc 13 stack (dev-servers, browser-control, openchamber-control
agent tool, walkthrough pipeline + UI, dev tunnels, fireworks) and doc 15
stack (session knowledge, agent memory tool + panel, project context,
skills + catalog, MCP config + OAuth, obligatory context, BTW/assist real).
Port sources enumerated in SECTION-3 §3.10/§3.12.

**Depends on:** A–F (mostly E for real agent actions + small-model).

W-coverage: W-91–W-97, W-106–W-114.

---

## Slice-order rationale (hardware for the parent agent)

- A must be first because it is the only slice whose achievement changes the
  perceived product (empty → alive) and it de-risks the streaming loop for
  every later surface.
- B can start right after A (real data already server-side; it makes the
  app AUTHENTIC for working developers even with the mock chat).
- C rides the same streaming base; part-catalog work is the biggest UI
  transplant (OC parts dir) — start it in parallel tracks with B if capacity
  allows (file disjointness: C touches chat/*, B touches views/*).
- D unlocks "agent finishes the work" product claims; it needs C's queue +
  parts and is much more real after E.
- E is the seam flip; it is server-track and can begin early behind the
  `nna` flag but its USER-visible acceptance lands after D exists to show
  real autonomy.
- F is breadth (settings/shell); G is depth (knowledge/inspection). Both
  inherit stability from A–D/E.

## Harness-seam ledger (cumulative state after each slice)

| After slice | mock surfaces | real surfaces |
|---|---|---|
| A | everything chat | fs/git/terminal/auth/settings/queue-substrate/order-substrate |
| B | chat | + review surfaces grounded (unchanged seams, wired UI) |
| C | chat (+ injected tool shapes for renderer tests) | + session sidecars (folders), queue UI |
| D | chat turns, small-model | + goal runtime, scheduled, multi-run flows (mock-driven) |
| E | nothing (mock stays as CI adapter) | \+ all chat/tool/goals/scheduled/multi-run real |
| F | — | + notifications with real states |
| G | — | + inspection/preview/knowledge/skills/MCP |

## Packaging regression gate (repeat after every slice)

The four observed kill-modes (main.log 04:25–04:39) define the installer
checks: (1) `resources/dist-server/server.mjs` + `settings-registry.json`
adjacency exist, (2) esbuild banner handles `ws`'s CJS requires, (3)
`web-dist` copy matches `pnpm --filter @notnative/web build` output,
(4) window navigates only after the health probe (packages/electron/main.mjs:398–428).
