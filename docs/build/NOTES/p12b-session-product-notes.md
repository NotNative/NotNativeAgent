# P12B — SLICE-C session-product working notes

Working notes for SLICE-C (`session-product`). Contract sources: SECTION-4-slice-plan.md
(SLICE-C, ~line 116), SECTION-3-reference-map.md §3.2, planning/03 §5.22/§6.7,
planning/05 §A.7/§A.8/§F, planning/12 §D. OC reference read-only (cleanroom).

## Slots (one heading per area — filled as work lands)

### T1 — transcript tool cards + mock harness `tool` trigger (doc 05 §C/§F.1)

- `packages/ui/src/chat/tool-cards.tsx` — `ToolCard({part})` (tool-cards.tsx:36):
  header = `toolPhrase` + `StateBadge` (running/done/error pill, :90) +
  `Duration`; failed → `ErrorLine`; live `state.output` streaming block for the
  newest running part (`chat-tool-live-output`, :112 via `LiveOutput`); expand
  toggle → `ToolDetail` (:123) in summary/formatted/raw modes driven by the
  registry key `toolJsonViewMode` (summary default, :30–33 + per-card override
  buttons); `ToolSummary` (:156) = scalar input rows (path/command/pattern/
  query/url/description priority), `SettledOutput` rendered through
  `markdown-lite` blocks, `MetadataSummary` chips. `jsonViewModeFromSettings()`
  (:202) + `ToolPartLite` exported for tests. Zero HTML injection (no
  dangerouslySetInnerHTML — the renderer is element-tree based).
- `packages/ui/src/chat/markdown-lite.tsx` — dependency-free hardened renderer:
  `markdownBlocks(source)` fences/headings/lists/quotes/hr/paragraph grouping,
  `renderMarkdown(source)` → ReactNode[], `MarkdownBlockView`, `safeHref`
  (http/https only; anything else renders inert text/span). **bold**, `code`,
  *em*, [label](https://…) handled; `<script>`, `javascript:`, event handlers
  are inert by construction (no HTML parsing anywhere).
- `packages/ui/src/chat/transcript.tsx` — PartView text case renders
  `renderMarkdown` (transcript.tsx:132), tool case renders `ToolCard` (:136);
  `StreamingTailRow` (:172) renders ALL visible part kinds (SKIP_KIND set) with
  a `StreamPlaceholder` tail; `BlockingCardsColumn` mounts between the rail and
  the composer (:49).
- Mock harness trigger: `packages/web/src/server/harness/mock/sim.ts` —
  `ToolDemoVariant` ('read'|'bash'|'fail'), `toolDemoVariantOf` (user text
  containing "tool" (+ "bash"/"command" → bash; "fail"/"error" → fail)),
  `specFor(variant)` (read = turns.ts path w/ metadata{lines,source}; bash =
  live `message.part.delta` field:'output' per line (TOOL_STEP_MS 90), input
  command `pnpm --filter @notnative/ui test -- --maxWorkers=2`, metadata
  {exitCode:0, outputLines, workingDirectory}; fail = grep tool error state),
  `runToolDemo`/`emitToolPartStates` emit the doc-02 §6.x lifecycle:
  `session.next.tool.input.started/.delta/.ended` → pending part
  (`message.part.updated`) → `session.next.tool.called` → running part →
  (bash: per-line output deltas) → terminal state → `session.next.tool.success/
  failed` → final durable `message.part.updated`. Aborts mid-tool map to the
  error state 'Interrupted'. `runTurn` emits the assistant `message.updated`
  anchor BEFORE tool deltas so part buckets exist in the reducer.
- Seed copy: `packages/web/src/server/harness/mock/index.ts` welcome hints the
  trigger words ("tool", "bash", "fail", "permission", "question", "todo").
- Tests: `packages/ui/src/chat/__tests__/tool-cards.test.tsx` (9) — running/
  completed/error card attributes + text, registry-driven detail modes,
  settled output markdown, hardening (script inert, javascript: inert, https
  anchors carry rel noreferrer, fences/lists, garbage no-throw).
  `packages/web/src/server/__tests__/p12b-mock-tool-trigger.test.ts` (4) — SSE
  frames for read lifecycle + REST completed part; ≥3 bash output deltas +
  session.idle last; fail variant error state; no trigger → no tool frames.

### T2 — session product sidebar (doc 03 §5.22 folders + §5.19 archive)

- `packages/ui/src/lib/session-folders.ts` — client contract for doc 03 §5.22:
  `SessionFolder` / `SessionFoldersSnapshot` / `FolderWrite`
  (session-folders.ts:10/18); `loadSessionFolders()` (:34) GET `/api/
  session-folders` (exists:false → empty envelope; malformed → error string),
  `saveSessionFolders(snapshot)` (:62) POST full-snapshot w/ version:1 +
  exists:true, `{ignored:true}` mapping to `writeIgnored` (LWW loss), never
  throws (transport → error result). All through `runtimeFetch` (app origin,
  NOT the harness proxy).
- `packages/ui/src/stores/useSessionFoldersStore.ts` — per-directory folders +
  `collapsedFolderIds` + `updatedAt`; optimistic apply → POST full snapshot →
  `ignored:true` ⇒ LWW refetch (server wins); single-membership
  `assignSession` (remove from every folder first); `toggleCollapsed` rides its
  own snapshot write; `unsortedSessionIds` (:132) for sidebar rows. State shape
  `foldersByDirectory` keyed by normalized directory.
- `packages/ui/src/chat/session-sidebar.tsx` — `showArchived` toggle +
  Archive section (archivedInDirectory split per §5.19, restore action through
  engine.actions.restore), tree of `Zone` blocks: folder headers collapsible
  (`folder-${id}` header + FolderActions rename/delete), folder membership via
  the store, unsorted sessions via `unsortedSessionIds`; sidebar rows file-into
  a folder (prompt → assignSession) and unfile (⤫). `bindBlockedProbe` export
  for tests.
- `packages/ui/src/components/MainLayout.tsx` — rename is REAL now:
  `engine.actions.rename(sessionID, trimmed)` with success/failure toasts
  (MainLayout.tsx); the stale `'land with P4'` toast path is deleted; actions
  gained `restore`.
- Tests: `packages/ui/src/stores/__tests__/useSessionFoldersStore.test.ts` (6)
  — empty shape, createFolder POST body assertions, single-membership assign,
  LWW ignored:true refetch, write failure keeps the optimistic local view and
  surfaces lastError, toggleCollapsed + deleteFolder.
  `packages/ui/src/sync/__tests__/session-rename-archive.test.ts` (3) —
  rename PATCH body {title}, archive → time.archived > 0, restore →
  {time:{archived:0}}, failure rejects with 'failed'.

### T3 — blocking cards (doc 05 §F.2/§F.3/§F.4)

- `packages/ui/src/chat/blocking-cards.tsx` (311 lines) — `BlockingCardsColumn`
  (newest-only keyboard stack on the column wrapper: Alt+Enter = once,
  Alt+Shift+Enter = always, Alt+Backspace = reject newest; testid
  `blocking-cards`) + `PermissionCardView` (testid `permission-card`,
  :55; per-tool bodies for bash — `<pre>` highlighted command +
  cwd/timeoutMs/description —, edit — path + DiffPreviewBlock + replaceAll
  note —, write — path + content, webfetch — method chip + URL, generic —
  description + metadata JSON; PatternsLine chips; buttons
  `permission-allow-once/-allow-always/-deny` all route through
  `engine.actions.replyPermission` (:64–66)). `QuestionCardView` (testid
  `question-card`, :189) — multi-question `Tabs` strip Q1..Qn + Summary
  (:234), `SummaryTab` (:251) lists per-question answers with the requested
  shape previewing `[[label]]`/`[[custom]]` reply payloads, custom textarea per
  question (`question-custom-${header}`, "Other…" label) that satisfies the
  answer rule, nextUnanswered jump (`question-next`), submit disabled until
  every question carries an answer, `question-submit` (:213) →
  `replyQuestion(sessionID, request, answers, reject)` with single-element
  answer arrays (:170), `Dismiss` → reject route (:215), stale 404 → toast
  "This question is no longer waiting for a response.", transport → retry
  toast; md/json copy via navigator.clipboard.
- Composer rule preserved: planSend marks sends blocked by
  permission/question; on submit the planner DENIES all open permission
  requests / rejects questions from the same store buckets before the send
  proceeds (composer.tsx:250–259), i.e. deny-then-send per §F.4.
- Tests: `packages/ui/src/chat/__tests__/blocking-cards.test.tsx` (7) — bash
  body highlight + working directory/timeout row, Alt-key stack (once/always/
  reject), edit diff preview + button route, radio submit single-element
  payload, custom "Other…" text as the answer, multi-question tabs + Summary +
  Next jump to first unanswered, Dismiss reject route.
- PARTIAL — auto-accept shield persistence (doc 03 §6.7): that section is a
  full server runtime (settings file five-activation-rule, event-connection
  wrapping, notification acks). The client half IS here (composer shield draft
  persistence + per-request allow-always rendering). Server runtime = deferred;
  exact next steps: implement §6.7 processor in packages/web/src/server (the
  existing settings-store five-activation-rule seed + event filter from
  baseline analysis), then surface active reason in the composer shield tooltip.

### T4 — server-owned message queue UI (doc 12 §D.6/§D.7)

- `packages/ui/src/stores/useMessageQueueStore.ts` — projection over
  `/api/message-queue` (doc 03 §5.18): keyed
  `${runtimeKey}␊${directory}␊${sessionId}` (`queueKey`); full-snapshot
  application owns every session it omits (applySnapshot; malformed items drop
  per-item, sendingId maps to `sendingIds`); revision gate drops older
  snapshots and older `notnative:message-queue.updated {revision}` broadcasts
  (doc 02 §5.4 renamed family; literal in app-engine.ts:14 — the server side is
  out of scope for the ui package by import direction). Mutations are
  server-mirror-first: `addToQueue` (optimistic + POST envelope
  `{directory, item:{content, attachments:[], context:[], sendConfig}}`,
  failure removes the optimistic entry and reports the server error; the
  COMPOSER restores the input text (nothing is lost on a failed enqueue),
  `removeFromQueue` (DELETE `-items/-itemId`; 409 in-flight surfaced),
  `takeForInput` (POST `-items/:id/take`, payload back to composer),
  `reorderQueue` (FULL permutation PUT -order, on failure restores the
  pre-mutation projection + refetches), `clearQueue` (DELETE session),
  `applyRevisionNotification` → coalesced GET; `hydrate()` on session open +
  `resync()` after every mutation. D1 limit guard (20 items/session) client-side.
- `packages/ui/src/chat/app-engine.ts` — the control-stream subscription now
  also routes `notnative:message-queue.updated` into
  `applyRevisionNotification` (app-engine.ts:64) with the existing
  `handleHarnessEventDirect` call unchanged.
- `packages/ui/src/chat/composer.tsx` — busy/blocked sends route to the SERVER
  queue for open sessions (composer.tsx:272 `handleQueuedTarget`) and to the
  client-held draft queue for draft columns (doc 12 §D.9: the server has no
  target for drafts). Input history records ONLY on server acceptance. The
  mode switch reads the `followUpBehavior` setting ('steer' | 'queue', default
  queue, composer.tsx:229) and feeds planSend.memorySettings — the plan route
  table is unchanged.
- `packages/ui/src/chat/composer-queue.ts` — `handleQueuedTarget` (59 lines)
  keeps the serverside add + restore-on-failure + toasts in one shape.
- `packages/ui/src/chat/composer-bits.tsx` — `QueueChipsRow` (:99) server
  projection chips: count + follow-up toggle (`queue-followup-toggle` writes
  the `followUpBehavior` settings field, :123), `queue-clear` (DELETE),
  per-item `queue-chip` rows (marker dot = amber idle / sky sending via
  `sendingIds`), preview button pops the FULL payload into the composer via
  `takeForInput`, ▲▼ reorder (`queue-up/down-${id}`, full-permutation via
  `reorder` :176), `×` remove; re-renders reactively via
  useSyncExternalStore over the store subscribe with stable snapshot
  selectors. Draft columns keep the legacy count chip row.
- Tests: `packages/ui/src/stores/__tests__/useMessageQueueStore.test.ts` (10)
  — snapshot application + keying + sending map + omission ownership, same-
  revision application clears omitted keys, malformed item drop, revision gate,
  POST envelope shape + refetch on acceptance, optimistic entry removal on
  failure, full-permutation PUT shape + snapshot restore on 409, DELETE clear,
  409 in-flight remove, take payload text + refetch, revision notification
  hydrate/drop-older. Server behaviors ride the existing p9-1 web tests
  (5 files, unchanged).

### T5 — timeline dialog + prompt rail (doc 05 §A.7/§A.8)

- `packages/ui/src/chat/timeline-dialog.tsx` — rows newest-first; "Revert"
  fills the composer with the reverted prompt via the §B.9/§C.10
  `nnd:composer-fill` channel after `engine.actions.revert` succeeds (the
  prompt is never auto-sent); "Fork from here" opens an inline panel
  (`timeline-fork-dialog`, instructions textarea `timeline-fork-instructions`,
  `timeline-fork-confirm`) → `engine.actions.fork` → follow the child through
  `persistLastActiveSession` + session-view store (routingDirectoryOf)
  → optional composer fill with the instruction text → toast 'Forked into a
  new session'; ESC closes the fork panel first, then the dialog; busy state
  on the confirm button.
- `packages/ui/src/chat/prompt-rail.tsx` (§A.8 v2) — reactive subscription
  (useSyncExternalStore over store.subscribe with empty-bucket constants; a
  getState()-once read never re-rendered), newest-first ordering by
  `time.created`, ≥2-prompt gate, hover preview card
  (`prompt-rail-preview`: "Prompt N of M" + 240-char text) with the newest
  dot flagged "Current prompt" (`prompt-rail-current-label`), teleport click
  target unchanged (anchor hash + scrollIntoView).
- Tests: `packages/ui/src/chat/__tests__/prompt-rail.test.tsx` (2) — hide
  until ≥2 prompts, reactive re-render, newest-first order + Current label +
  hover preview text, teleport hash rewrite.

## Acceptance matrix (slice-plan SLICE-C rows → where it lives)

| Slice-plan criterion | Landed at | Test |
| --- | --- | --- |
| Tool cards carry running/settled/error states + expandable JSON summary (§F.1) | tool-cards.tsx:36/58/90/123/156 | tool-cards.test.tsx (9) |
| bash live output streaming (§F.1) | tool-cards.tsx:112 + sim.ts runToolDemo output deltas | tool-cards + p12b-mock-tool-trigger (4) |
| markdown hardening | markdown-lite.tsx renderMarkdown/safeHref | tool-cards.test.tsx hardening block |
| Mock harness "tool" trigger inside doc-02 shapes | sim.ts `toolDemoVariantOf`/`runToolDemo` | p12b-mock-tool-trigger.test.ts (4) |
| Sidebar folders wired to existing routes (§5.22) | lib/session-folders.ts:34/62 + stores/useSessionFoldersStore.ts:65 | useSessionFoldersStore.test.ts (6) |
| Archive view from archived split + real restore | session-sidebar.tsx archive zone + MainLayout.actions.restore | session-rename-archive.test.ts (3) |
| REAL rename (delete stale 'land with P4' toast) | MainLayout.tsx rename → engine.actions.rename | session-rename-archive.test.ts |
| Permission/question card UI §F.2/§F.3 | blocking-cards.tsx:55/:189 | blocking-cards.test.tsx (7) |
| Keyboard stack newest-only (Alt+Enter / Shift / Backspace) | blocking-cards.tsx BlockingCardsColumn | blocking-cards.test.tsx Alt-stack |
| Server-queue store §D.6 (keys, revision gates, optimistic + authoritative) | stores/useMessageQueueStore.ts | useMessageQueueStore.test.ts (10) |
| Composer queue/steer chips + reorder/clear §D.7 | composer.tsx:272/437 + composer-bits.tsx:99–176 | useMessageQueueStore + composer suites |
| Timeline fork from any turn (§A.7) + revert-to-composer-fill | timeline-dialog.tsx fork panel + `nnd:composer-fill` | no dedicated test in-slice — engine flows keep existing sync-suite coverage; see deferred #6 |
| Prompt rail §A.8 hover preview + current label + reactive | prompt-rail.tsx | prompt-rail.test.tsx (2) |

Note: the composer rule tests (planner deny-then-send) live in
composer-policy.test.tsx (12, unchanged and green). The timeline-dialog
rewrite has no dedicated test file yet (deferred #6); its §A.7 behaviors are
typechecked and ride existing sync/engine coverage.

## Tallies (truth runs after final state — final full run 15:20)

- ui vitest: **79 files / 683 tests passed** = recorded baseline 73/646 +
  **37 new tests across 6 new files** (exactly reconciles): tool-cards 9 ·
  useSessionFoldersStore 6 · session-rename-archive 3 · blocking-cards 7 ·
  useMessageQueueStore 10 · prompt-rail 2. No pre-existing test file was
  modified in this slice (git status).  Final run exit 0 (no known
  0-failed-artifact either way).
- web vitest: **44 files / 648 tests passed** = baseline 43/644 + 4
  (p12b-mock-tool-trigger; no existing web test file modified — server-side
  queue lives in p9-1).
- typecheck: ui tsconfig 0 · web tsconfig.ui.json 0 · tsconfig.cross.json 0 ·
  tsconfig.server.json 0.
- `node scripts/repository-graph.js --check` current (357 modules) after one
  rebuild; `node scripts/quality-gates.js` passed (0 violations).

## PARTIAL / deferred (with exact next steps)

1. **Auto-accept shield full persistence** (doc 03 §6.7 server runtime) —
   PARTIAL: client surface complete (draft-shield persistence +
   per-request always-allow). Next: implement the §6.7 processor in
   packages/web/src/server (settings five-activation-rule + event filter);
   surface the active reason in the composer shield tooltip; add web tests
   beside p9-1.
2. **Queued attachments** (doc 12 §D.1 item.attachments must parse fully) —
   PARTIAL: the composer enqueues TEXT + sendConfig only
   (`attachments: []` in the POST envelope); attachments stay composer-local
   for queued turns. Next: when queueing, upload/serialize DraftAttachments
   into the item payload and map them back through takeForInput.
3. **Queue hold + take-all UI** — server routes exist (`hold`, take-all) but
   the UI exposes reorder/remove/clear/pop only (per §D.6 v1 surface). Next:
   add a "hold" chip in QueueChipsRow wired to `/hold` + a take-all button if a
   use shows up in the autonomy flows.
4. **Prompt rail windowing/"Load more"** (§A.8 virtualization slice) — dot
   list unvirtualized while >60 prompts; next: reuse the transcript
   virtualization slice hooks when that lands.
5. **Mock harness permission/question lives inside sim** were verified
   read-only (routes + v2 surfaces exist); no behavioral changes were needed
   beyond the tool demo.
6. **timeline-dialog tests** — add `chat/__tests__/timeline-dialog.test.tsx`
   covering: revert button fills the composer via a spied `nnd:composer-fill`
   listener after `engine.actions.revert` resolves; fork panel
   open → `timeline-fork-confirm` →child switch assertions
   (persistLastActiveSession + session-view store) with the instruction text
   routed to the composer fill (never auto-sent); ESC closes the fork panel
   before the dialog.
