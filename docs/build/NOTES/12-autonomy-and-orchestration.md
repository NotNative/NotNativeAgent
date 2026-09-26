# NOTES 12 - Autonomy & orchestration

## NNA-native goal seam (2026-09-25)

The original P9-2a pure goal core is now aligned to `metadata.nnd.goal`.
NNA owns bounded persistence in its session catalog and exposes a dedicated
goal route instead of accepting generic metadata replacement. Writes are
owner-scoped and require the goal-manage permission plus expected goal identity
and server-owned revision atomically; NND's web-service loop will use the NNA route.
The revision prevents a stale autonomous settle from overwriting a user's Pause
on the same goal id. The generation-bound objective-file store and root-session
goal management strip are delivered as pre-loop slices. Event-driven ticks,
independent audits, send arming, and scheduled-task integration remain P9 work.
This section supersedes upstream `openchamber`
namespace and `PATCH /session/{id}` references elsewhere in the audit notes.

Doc read in full (1651 lines). P9 opens with P9-1 — the server message-queue
runtime (build checklist step 7: sections D.1–D.5 + the G.3 recovery matrix +
the I.4/I.6/I.9/I.10 invariants). The goal runtime (B.4–B.5), scheduled tasks
(C.1–C.10), the orchestration service (F.1), multi-run (E) and every shared-UI
face (steps 10–13) stay unstarted slices; the queue UI store (step 11) also
waits — the server row ships first so a closed tab can never strand a queue.

## A. Slice map (against the doc checklist)

- **P9-1 (delivered this slice)** — checklist step 7: the whole server-side
  message queue, 9 modules under `packages/web/src/server/queue/`
  (1,640 lines): `queue-item.ts` (246) §D.1 server-canonical item schema —
  `\n`-edge-trimmed content ≤ 200 000 chars, `text` defaulting to content
  with the LEADING `@name` mention stripped into `agentMention` (delivered
  later as the trailing `{type:'agent',name}` part), full-or-reject
  attachment parsing (filename/mimeType/dataUrl required; unknown source
  coerces `local`; id synthesized when absent), the 3-limb `ContextPart` union
  (a `context` entry REQUIRES its `metadata` object envelope — the server is
  a courier, the metadata is the UI's payload), need-one-of
  (text/attachments/context), mandatory `sendConfig` with providerID+modelID
  (agent/variant optional), `contextPreview` slice ≤ 103 and the ≤ 100-char
  first-line `...` snapshot preview derivation with legacy fallbacks
  (attached-comment metadata text → first non-instruction context text →
  delivered text), and the public projection that drops `dataUrl`/`context`
  and carries only serverPath+ids. `queue-store.ts` (278) §D.2 persistence —
  `<data-dir>/message-queue.json` `{version:1, revision, sessions:{[sessionId]:
  {directory, items}}}`, atomic pid-suffixed tmp+rename through a serialized
  write chain (`queueTempPath` pinned), missing file boots empty, a MALFORMED
  file is a failure not empty data (renamed aside to
  `message-queue.json.corrupt-<ts>` BEFORE the empty boot so the next write
  cannot clobber user data), a hard read failure DISABLES writes (in-memory
  queue stays owner; `recoverWrites` re-probes a later load and never reverts
  the in-memory queue), the write chain is serialized + awaited by
  `flushWrites`, EMPTY sessions deliberately stay out of the doc (memory-only
  directory memory), and the enqueue limits (20 items/session newest-kept with
  the in-flight head PINNED, 50 sessions oldest-first by first-item createdAt,
  never evicting an in-flight session) plus the monotone global revision
  bumped on every mutation. `queue-runtime.ts` (491) the §D.3 delivery loop —
  feed intake: `session.deleted` drops the queue, commits + broadcasts +
  forgets the directory memory (mid-flight sends resolve against nothing,
  tolerated by `onDelivered`), `session.status` idle arms the 500 ms quiet
  timer (turn-boundary burst coalescing) and busy/retry clears it,
  `message.updated` records a `MessageAbortedError` abort timestamp but a
  COMPLETED assistant reply also arms when unarmed (a missed idle cannot
  strand the queue); the tick gate ladder in order (stopped/empty/in-flight/
  hold-TTL self-expiry/abort hold → re-arm at expiry/backoff record: item
  match + `nextAttemptAt` re-arm else drop for a different head); live
  idleness verification with BOTH signals authoritative (the `GET
  /session/status` map must NOT list the session AND the 2-message tail must
  not be an unfinished assistant reply — `time.completed` absent — either
  failed fetch is UNKNOWN, never idle, and re-arms at the 2 s verify backoff);
  the post-await head re-read (§D.3.5) refusing a stale head; dispatch marks
  the head in-flight and broadcasts FIRST, then the extracted
  `queue-dispatch.ts` (168) seam (`deliverHead`) resolves a slash command
  against the harness catalog (`GET /command`): skill → the prompt route
  keeping the raw `/name args` text + the explicit synthetic skill
  instruction, command WITHOUT context → `POST /session/:id/command` with
  `{command, arguments, model:'provider/model', agent?, variant?, parts?}
  file parts ONLY, command WITH context → the prompt route with the template
  EXPANDED into the delivered text (`$ARGUMENTS` whole-string, `$1..$N`
  quoted-or-bare words with the LAST placeholder absorbing the remainder,
  append-if-none — the composer's §B.8 rules mirrored in `queue-expansion.ts`
  (67) without importing the Vite-flavored UI graph); the prompt route posts
  `{model, agent?, variant?, parts}` with the EXACT §D.3.6 part order — user
  text, file parts, context parts (each entry as a synthetic text carrying
  its metadata VERBATIM, `instructions` as their OWN synthetic part
  immediately before the entry), skill instruction, pending project knowledge
  (synthetic), agent mention LAST; knowledge resolves through the
  `ProjectKnowledgeProvider` seam and `recordDelivered` runs ONLY after an
  accepted prompt, a lookup failure sends without it; delivery success
  removes + commits + broadcasts + fires the `onPromptSent` hook (§D.3.7
  notification-trigger seam); failure keeps the item and re-arms on the
  backoff formula `min(2000 * 2^(failures-1), 60000)` — `failureDelayMs`
  exported as the single authority shared by tests — after broadcasting the
  failure pitch, and the NEXT item always waits for a fresh busy→idle cycle;
  `reconcileAll` re-arms every armed-less session with items on hub
  (re)connect, and startup = load file then reconcile. Holds (§D.4) live
  in the runtime: `held:true` holds until `now + min(ttlMs || 5 min, 10 min)`
  at check time clearing the armed timer, `held:false` releases + arms; a
  held-true arm is refused at `armQuiet` so nothing races the TTL.
  `queue-adapter-calls.ts` (40) is the HP-1 seam wrapper (nothing bypasses
  the adapter; a loopback-only synthetic origin carries `/api`-prefixed paths
  and the directory header; adapter throws map to a shared 502 so every
  failure path is identical). `queue-feed.ts` (160) carries the event source:
  the production `AdapterQueueFeed` pumps the harness event stream
  (`GET /api/global/event`) through the adapter seam with its own reconnect
  + connected fan-in (§D.3 wiring: no hub module yet — E-09-8), and
  `ManualQueueFeed` stays the deterministic test seam. `queue-hooks.ts` (40)
  holds the §D.3.7 `onPromptSent` registry (unsubscribe-clean) and the
  `ProjectKnowledgeProvider` seam + `NULL_KNOWLEDGE_PROVIDER` (E-09-2).
  `queue-routes.ts` (150) the §D.5 family at `/api/message-queue` — snapshot
  GET (`{revision, sessions:[{sessionId, directory, items(public),
  sendingId}]}`), enqueue (arms dispatch; session may already be idle),
  take/takeAll returning FULL items with payloads reattached (404 unknown,
  409 in-flight), complete-permutation reorder (400 otherwise; 404 unknown;
  no-op on empty), single delete (409 in-flight) and session DELETE that
  keeps the in-flight item so its send can still resolve, hold PUT with TTL
  clamps, the 50 MiB bounded JSON body budget through the shared
  `readJsonBodyBounded` reader, and every mutation answering + broadcasting
  `{revision, session}` with `session` ALWAYS the directory name —
  including the broadcast that removes the last item. Wiring: app.ts
  `registerApiSurfaces` mounts the family BEHIND the global /api gate and
  BEFORE the generic harness proxy catch-all (+2 lines), and
  `lib/harnessNaming.ts` gains `CONTROL_EVENTS.messageQueueUpdated` (+2).
   Tests 74 (+ the shared `__tests__/helpers/queue-fakes.ts` (211): the fake
  harness adapter seam with canned outcomes/gates, a manual feed, a
  control-bus spy, the SHORT_TIMING override, and the compact factory):
  `p9-1-message-queue.test.ts` (22: parse matrix, preview derivation, store
  postures, limits), `p9-1-message-queue-runtime.test.ts` (19: feed intake,
  tick gates, live idleness verification incl. unknown re-arm, head
  stability, holds: current-hold airtightness + the expiry auto-release
  wakes + stop-stamp consumption), `p9-1-message-queue-runtime-2.test.ts`
  (15: the backoff formula, slash routing + expansion, the EXACT part
  order, knowledge + hooks, failure pitch + next-item idle gate, feed
  reconnect + the hard-failure recovery probe, startup load-then-reconcile),
  `p9-1-message-queue-routes.test.ts` (17: snapshot publicity,
  enqueue/arm/validation, take/takeAll/reorder/delete/409s incl. the
  directory-named last-item reply and the mute emptied take, hold TTL
  clamps, the broadcast contract, the registration-order pin lives in
  `p9-1-message-queue-app.test.ts` (1) which also pins the data-dir file
  through the real app gate).
  Completion review fixes (this session): three SPEC-BLIND fixture bugs
  were corrected without touching runtime semantics — the part-order
  test's item lacked the leading agent mention the order pin requires
  (§D.1 strips `@scout` out of `content`), the startup test never
  registered its fake on the adapter seam (both parks silently dispatched
  through the previous test's fake) and asked for an unreachable third
  revision bump (E-09-5/E-09-6), the failure-pitch test demanded the
  emptied entry be `null` (§D.2 keeps it as directory memory; now pins
  item removal + file exclusion + RAM retention), and the head-stability
  test only ADDED items so the §D.3.5 head-ID re-read correctly passed —
  the edit now DELETES the recorded head mid-park. The completion pass
  also SPLIT the previous build's 589-line `queue-runtime.ts` past the
  500-file gate: the head dispatch (slash routing, expansion, the §D.3.6
  part-order assembly, route posting, knowledge attach) moved VERBATIM to
  `queue-dispatch.ts` — the 74 P9-1 tests run against the split
  untouched.
  Adversarial review fixes (this session, E-09-9 proven): (1) §D.4's
  "the hold EXPIRES ON ITS OWN" was a latent STRAND — an expired hold
  self-deleted only at check time and no later busy→idle signal was
  guaranteed for an idle session, so a dead asserting UI could park a
  queue forever; expiry now schedules its own wake (E-09-9) and the ttl
  test that encoded the stranding posture was rewritten. (2) §D.2's "a
  later load success re-enables" was DEAD CODE — `recoverWrites` had no
  production caller; the reconcile beat now probes. (3) the LAST-item
  DELETE reply answered `session: ''` (snapshot-derived) while §D.5
  demands the directory ALWAYS named in payloads; the runtime now returns
  the directory, and the emptied-queue reorder NO-OP reply shared the same
  snapshot-derived blind spot (its helper now reads `directoryOf`).
  (4) a take over an emptied queue bumped the revision, persisted, and
  broadcast a no-op (deleteSessionQueue already skipped); takeAllItems
  mirrors it now. (5) consumed stop-stamps self-delete at check time,
  mirroring holds (a test/diagnostic `abortAtOf` read rides the runtime).
  NOT in: the queue UI (store/composer/steer-vs-queue = checklist 11),
  goals runtime, scheduled tasks, orchestration service, multi-run; the
  knowledge module itself (E-09-2) and agent-registry mention validation
  (E-09-7) stay future seams.

- **P9-2c (goal evaluator exchange, delivered this slice)** — checklist
  B.5.5/B.6: the tick's `ready` candidates are consumed by an independent
  auditor exchange; modules 3 (`nna-goal-auditor.ts` 245, the
  `runAudit` production adapter inside `nna-goal-safety-ports.ts` 64,
  runtime +12): pure apply functions (verdict streaks, T5 failure streaks,
  note/attribution bookkeeping, whole-payload equality + loop-field drift +
  revision readers), the wire interpreter (code-keyed race vs unavailable
  classification — NNA answers 4xx-contract errors non-status-keyed), the
  CAS exchange (fresh re-reads, a pre-audit loop-field coherence guard vs
  the tick candidate, revision-equality across the audit window, single
  combined verdict write, streak-only failure writes, skip-audit candidates
  persisted without an audit call and never re-audited), and the awaited
  consumer hook (index.ts passes the audited ports + exchange; the runtime
  parks later arms behind it). `turnsUsed` stays untouched while dispatch
  stays off (E-09-18c). Tests: `p9-2c-goal-auditor.test.ts` (409, 26: apply
  matrix, interpreter matrix, helper matrix, 13 exchange orchestration
  cases incl. the adversarial pre-audit edit-drop, the production-port
  wire shape, and the runtime-inline-consumer serialization) + the live
  `probeGoalAudit` seam in the cross-repo source smoke (`smoke-goal.mjs`
  116): an armed goal under one REAL provider turn, the attributed receipt
  (primary/test), NNA's raw audit answer (same provider profile + model),
  and the stale-revision `nnd_goal_audit_conflict` refusal. NOT in: send
  arming, continuation dispatch, scheduled tasks, the audit-note auth
  against the live small model (already covered parse-side), multi-run.
- **P9-2d (continuation dispatch, delivered this slice)** — completes B.6:
  the exchange's last action is the send (`nna-goal-dispatch.ts` 122, the
  `sendPrompt` production adapter in `nna-goal-safety-ports.ts` 79, exchange
  integration +11). Both candidate paths ride it — an audit `continue`
  verdict and the skip-audit kicks (aborted-turn re-kick, Resume) — and
  dispatch is the same guarded ladder every time: fresh session re-read,
  active/id/loop-field coherence vs the persisted candidate
  (`accountingDrift`), the 20-cap check (beyond it: settle `blocked` /
  continuation limit, no send), a conversation-tail re-verification against
  `ready.tailId` (any newer message — user text or an assistant reply still
  open — refuses the dispatch), ONE slot-consumption CAS
  (`turnsUsed + 1`, `statusReason` cleared so a later cancel pauses a
  resumed goal per the resume one-shot), then the single
  `POST /session/:id/prompt_async` with the verbatim B.6.2 continuation text
  (XML-escaped objective, budget block or the no-budget line, live
  `turnsUsed` count). The consumed state builds the prompt, so the sent
  count includes the continuation being sent; 409 `session_busy` is a drop
  (`session busy at dispatch`, slot burned — NNA's seat was taken, a queued
  re-send is exactly the unbounded send the loop forbids), any other
  refusal/transport fault is a quiet dropped dispatch with NO streak write
  (send failures are not audit failures; the next exchange re-decides from
  evidence). No model/agent/variant rides the body (E-09-19); NNA's ingress
  fence covers the CAS-to-send window. UI: the session goal strip's
  auto-continuation line now states the live contract (count in the editor,
  arm-what-you-mean phrasing in the no-goal branch). Tests:
  `p9-2d-goal-dispatch.test.ts` (306, 17: builder matrix, prompt-body shape,
  9 dispatch-ladder cases, 5 exchange flow cases, the production-port wire
  for parts-only submit) + the widened p9-2c exchange fixtures. NOT in:
  scheduled tasks, a live full-loop smoke probe (route-level probes stay
  the smoke's scope), queue UI batch, multi-run.
- **P9-3a (scheduled-task storage core, delivered this slice)** — first
  slice of C: the task schema, next-run math, and the locked per-project
  store (`scheduled/scheduled-constants.ts` 38, `next-run.ts` 141,
  `task-schema.ts` 205, `config-lock.ts` 118, `task-config.ts` 197): the
  C.1 task document (schedule kinds daily/weekly/once/cron, execution with
  goal settings, runtime state) normalized on every deliberate write with
  unknown fields preserved verbatim at all four levels (task, schedule,
  execution, state), the C.2/C.3 next-occurrence computation (Intl zone
  validation fixed on true Epoch; spring-forward gaps skipped; fall-back
  repeats resolved to the FIRST instant; cron via the registered
  cron-parser dependency with `{tz}`), and the C.9 multi-writer store:
  whole-document atomic rewrite under BOTH an in-process promise chain and
  a cross-process `{pid, at}` wx-file lock (60 s stale steal, 5 s
  unreadable-mid-write grace, release verifies own pid), state patches
  swapping ONLY the state object onto the RAW stored record (an older
  build cannot strip fields a newer one normalized in), `undefined` patch
  values clearing keys (the claim clears a past once slot), malformed
  configs quarantined to `.corrupt-<ts>` on first write, and the
  read-normalize view reporting damaged entries without deleting them.
  Tests: `p9-3a-scheduled-storage.test.ts` (351, 26: next-run matrix incl.
  the America/New_York gap and fold, schema reject matrix, unknown-field
  preservation, legacy single daily `time`, id immutability, goal-setting
  coupling, state-patch swap/clear, malformed quarantine readback, lock
  steal/mid-hold-foreign/chain serialization, the lock fd leak regression,
  and the updatedAt explicit-undefined regression). NOT in: timers, run
  pipeline, claiming, loop files, routes/SSE (P9-3b..d), UI.
- **P9-3b (scheduled-task runtime, claiming, completion — delivered this
  slice)** — the C.4/C.5/C.7 execution machine over the P9-3a store:
  `scheduled-runtime.ts` 65 composing `scheduled-ports.ts` 53 (port
  contracts; the harness pipeline injected behind `runPipeline` — the
  runtime never imports the harness), `scheduled-state.ts` 147 (memory
  task maps, due timers carrying the slot they arm FOR, FIFO queue, global
  4 / per-project 2 slot counters, overflow timers re-arming recursively at
  the setTimeout cap `MAX_TIMEOUT_MS`), `scheduled-run.ts` 305 as
  module-level functions over an explicit run context (claim protocol,
  watchdog, completion), `scheduled-claims.ts` 76 (pure claim-patch
  helpers), `scheduled-util.ts` 11. Behaviors: `start()` syncs every
  listed project (listProjects failure aborts; one unreadable project logs
  and skips; a vanished project sheds timers and tasks); sync persists each
  computed `nextRunAt` and arms enabled future slots — past slots are
  never re-armed (a missed run is skipped, not caught up); a due timer
  enqueues the exact `(task, scheduledFor)` and the queue pump starts runs
  while the global/per-project slots allow, head-of-line held otherwise;
  claim = `patchIf` on the RAW record with the 5 s slack predicate
  (`|lastScheduledFor - scheduledFor| <= 5000` refuses), claim patch
  writes lastScheduledFor/lastRunAt/running-status/clears lastError and
  the NEXT slot (`nextRunAt` computed from `max(now, scheduledFor+1)`), so
  the slot is consumed exactly once and never stays stale; a losing
  process adopts the returned task into memory and re-arms from the
  winner's persisted slot without dispatching; a claim WRITE failure
  records lastStatus/lastError/updatedAt only (a separate re-arm is
  computed and armed) and reports `claim-failed`; the watchdog races the
  pipeline at `maxRunDurationMs` — a timeout records the error WITHOUT
  aborting the session it may have created, a pipeline REJECTION is a
  run error never a silent success, and the pipeline invocation itself is
  async-defused (a synchronous pipeline throw is a run error, never a
  claim failure); completion: one-time tasks consume
  the enabled slot before completion persistence (`enabled: false`, run
  runs once exactly), then read-latest-or-memory fallback, a single
  completion patch (status, `lastError` on error else `lastSessionId`,
  lastDurationMs, the recomputed `nextRunAt` — undefined clears it when the
  task is disabled or its once slot is consumed, and updatedAt), exactly ONE retry on persist failure, then in-memory terminal
  state (never advertise a stuck running) + re-arm from the in-memory
  task; completion emits the C.7 event (warn-only emission; a refused
  event never fails the run) `{projectId, taskId, ranAt,
  status, sessionID?}`; `runNow` manual runs refuse `task-busy` (queued
  or running) and `capacity-exhausted` (full slots), never claim an
  occurrence, run paused tasks, best-effort persist the manual start, and
  never re-arm or consume an occurrence; `stop()` clears timers and
  queued work and latches the runtime inert until the next `start()` (a
  settling run completes but arms nothing). Tests:
  `p9-3b-scheduled-runtime.test.ts` (433, 23: due
  cron fire end-to-end incl. re-arm to the next slot, disabled/consumed
  arming skip, the setTimeout-cap recursion, no re-enqueue while
  running, hold at both caps then drain on settle, sibling-claim
  adoption + winner-slot re-arm, claim store failure record + re-arm,
  no finite scheduledFor skip, watchdog timeout without abort, completion
  persist retry then terminal + re-arm with disk left at the claim state,
  one-time consumption, manual success on a paused task without claim or
  re-arm, manual busy/capacity refusals, start sync + vanished-project
  shed, stop clears, listProjects abort; the review regressions: a sync
  pipeline throw lands as an error run on the scheduled AND manual paths
  (slots freed, slot re-armed, no claim-failed misclassification), a
  throwing event emitter is warn-only with the run intact, a post-stop
  settling run persists but arms nothing, and a refused claim adopts the
  winner's task into memory). NOT in: the harness pipeline
  adapter (P9-3c), loop files, routes/SSE, UI, and the per-project
  settings-route `scheduledTasks` clobber fix (P9-3d).
- **P9-3c (scheduled run pipeline on NNA — delivered this slice)** — the
  C.6/C.10 harness side, injected behind the runtime's `runPipeline` port
  (the runtime still never imports the harness): `scheduled-pipeline.ts`
  255 (the adapter: session create, running event, goal planting, dispatch
  routes), `nna-scheduled-ports.ts` 95 (production ports over the internal
  adapter seam `harnessRequest` + the ready poll), `scheduled-service.ts`
  130 (lazy singleton wiring the P9-3a store ports, project enumeration,
  the C.10 fanout, boot/stop), `harnessNaming` gains
  `notnative:scheduled-task-ran`, boot joined `bootAutomation`, dispose
  sheds timers. Behaviors: the title is `${name clipped at 120} ${yyyy-LL-dd
  HH:mm}` in the SCHEDULE zone's wall clock; the ready poll (250 ms / 10 s
  against `GET /command`) failing only warns and proceeds (the create
  attempt adjudicates a cold harness); a missing worktree
  (`GET /project` id/worktree match), a blank session id (`sessionID ?? id`
  on the created record), or a rejected dispatch is a run error the
  RUNTIME records; the `running` event emits at session create (warn-only);
  auto-accept is unwired in NND (A-6.7), so `permissionAutoAccept` warns
  and the session prompts normally; slash prompts resolve
  `commandNameOf`/`commandArgsOf` against the command catalog — a matched
  non-skill command dispatches `POST /session/:id/command`
  `{command, arguments, model: 'provider/model', agent?, variant?}` with
  the goal objective = EXPANDED TEMPLATE (B.8; template-less commands keep
  the raw invocation), no synthetic parts; a catalog miss, a skill-named
  entry, or a catalog read failure degrades to the plain prompt path;
  plain prompts dispatch `prompt_async`
  `{model: {providerID, modelID}, agent?, variant?, parts}` with parts in
  the C.6 order knowledge (synthetic; lookup failure sends without) ->
  prompt -> goal intro (B.6.1 verbatim + the budget sentence before the
  closing tag), `recordDelivered` only after acceptance; goal planting
  rides `buildGoalPayload` (objective file first beyond the 5000-char
  clamp, key from the NND objective store, inline fallback on write
  failure), fresh sessions read revision 0 when metadata has no
  `nnd.goalRevision` and no current goal, existing goals guard
  `expected_id`/`expected_revision` from the record, evaluation
  provider/model come from the task execution, and a REFUSED goal write
  dispatches WITHOUT the intro (goal mode must not be claimed falsely;
  the command route never carries the intro); the run outcome carries
  `{sessionID, durationMs, reason, startedAt, finishedAt}`. C.10 events
  fan out on the control bus with the payload
  `{projectId, taskId, ranAt, status, sessionId?}` (wire name `sessionId`,
  the internal field stays `sessionID`). Tests:
  p9-3c-scheduled-pipeline.test.ts` (412, 18: title stamp + clip, plain
  dispatch body/event, knowledge order + delivery record, revision
  guards, tolerated goal-write refusal, objective file ride + inline
  fallback, command route + B.8 expansion, plain-path degradation trio,
  knowledge failure + blank-knowledge tolerance, ready-poll/emitter/
  auto-accept warnings, the four run-error axes, intro wording incl. the
  budget-range gate, C.10 payload shape, project stem listing, and a
  real-store integration (sync persists the next slot; once
  consumption); the review regressions: blank knowledge delivers and
  records NOTHING, the objective-file degradation always warns with the
  session id, and the intro's budget sentence agrees with the payload's
  budget range). NOT in: server routes for tasks/manual runNow,
  loop files, UI listeners, snippet expansion, the B.6.3 distill call
  (P9-3d and later).
- **P9-3d (loop files + the scheduled-task route surface — delivered this
  slice)** — C.8 loop files and the doc 03 §5.16 route family:
  `scheduled/loops.ts` 240 (frontmatter parse with cron-only schedules,
  `enabled` defaulting FALSE, the model split on the FIRST slash,
  discovery with user/project scope shadowing and nearest-ancestor
  preference, the PATCH-enabled frontmatter rewrite),
  `task-config.ts` 285 (gains the locked `reconcileLoopTasks` with the
  full C.8 table — revive/adopt/rename/keep/prune — plus a store-exists
  helper), `scheduled-tasks.ts` 210 (the seven routes: list, upsert,
  delete, loop-file PATCH/DELETE, run-now, scheduler status), the
  service grows to 212 lines (optional C.8 `loopsFor`/`reconcileLoops`
  runtime ports over the harness tree, the 400/409 run-now mapping, the
  status snapshot), `scheduled-state.ts` 157 (reconcile rides
  syncProject before the store read; the memory task mirrors the armed
  slot), and `routes/projects.ts` 244 (the per-project config PUT no
  longer clobbers the managed `scheduledTasks` key). Behaviors: loop
  files live in `~/.agents/loops/*.md` and `.agents/loops/*.md` under
  every ancestor up to the worktree root (a `.git` entry ends the walk;
  gitless paths reach the fs root); project scope shadows the user
  scope and the NEAREST ancestor wins; parse failures degrade
  (name-bearing files hold their task's last good definition, nameless
  files warn and vanish; invalid zone -> server zone; a long optional
  agent is omitted); adoption keeps the colliding plain task's id plus
  unknown fields, UI-only execution extras, and state; a renamed file
  re-keys its task to the fresh `loop:<scope>:<name>` id; orphaned
  pointers are pruned and JSON tasks never are; the general task routes
  refuse loop-owned identities while the file is present; the
  loop-file routes mutate the FILE and let the sync's reconcile apply
  it; run-now answers `{ok, status, sessionID?, task, persistError?}`
  with the service mapping unknown -> 400 and busy/capacity -> 409; the
  status route reports `{running: {global, byProject}, queued, tasks}`
  sorted soonest-first. Tests: `p9-3d-scheduled-loops.test.ts` (296,
  18: the C.8 format table, deterministic ids and file-task input
  carry, the enabled-fence rewrite, root walk + scope precedence, and
  the reconciliation table add/rename/adopt/prune/keep-last-good/
  duplicate/no-op-write) and `p9-3d-scheduled-routes.test.ts` (285,
  11: the §5.16 family over a real store + runtime, loop gates, the
  loop-file E2E through the reconcile, run-now 200/400/409 incl. the
  capacity and pipeline-failure axes, the status snapshot, and the
  config-PUT non-clobber both directions). NOT in: UI listeners, the
  API client, the scheduled dialogs, snippet macro resolution, the
  B.6.3 distill call (P9-4 and later).
- **P9-4a (the scheduled-task UI data plane — delivered this slice)** —
  `packages/ui/src/lib/scheduled-tasks-api.ts` 190: the typed §5.16
  client (list/upsert/delete, loop-file PATCH/DELETE, manual run,
  scheduler status) with the §C.1 wire types mirrored locally, failures
  folded into `{ok:false,status,error}` with the server's message
  preserved verbatim, plus the C.10 `parseTaskRunEvent` over the control
  stream's flat `{type, properties}` frame (`SCHEDULED_TASK_RAN` is the
  build's event name). Tests: `lib/__tests__/scheduled-tasks-api.test.ts`
  (15: every route's URL/method/body bytes incl. `%3A`/`%2F` encodings,
  the error-message folding at 400/404/409/500 incl. JSON-on-500, the
  bare-task PUT fold, `{task}` PATCH fold, run-now strict-equality with
  the body-owned `ok:false` of an errored-but-completed 200 run, the
  status snapshot recovery, and the parser's accept/reject table) and
  `scheduled-tasks-api.transport.test.ts` (5: the same folds through the
  REAL runtimeFetch pipeline with only the native fetch stubbed — the
  server strings survive end-to-end). NOT in: the dialogs, the entry
  point, the live-refresh wiring, the editor's autocompletes
  (P9-4b/4c).
- **P9-4b (the scheduled-tasks dialog — delivered this slice)** —
  `components/scheduled/scheduled-tasks-dialog.tsx` 301: the §H dialog
  (project selector defaulting to the active directory's project, task
  rows with schedule summaries `daily/weekly/once/cron (+ tz)`, next/last
  run stamps in the viewer's zone via `lib/format/time`, lastStatus
  badges, the enable toggle split by ownership, run-now, delete split by
  ownership, and the loop-file editor handoff) + `scheduled-task-list.ts`
  119 (the `useScheduledTaskList` + `useTaskRanFanout` hooks: list load
  with the no-store 404 folded to empty, the C.10 live refresh, the
  view-ownership guard against stale loads/frames, busy state with
  single-toast folding) + `scheduled-shell-wiring.tsx` 32
  (`nnd:scheduled-tasks-open` + `nnd:files-open` window events) +
  MainLayout wiring (a `◷ tasks` header button, the dialog mount, and
  `openEditorFile` opening the FilesView pane with the tab selected).
  Tests: `scheduled-tasks-dialog.test.tsx` 20/20 (default selection,
  404-empty, toggle split, run-now toasts by outcome incl. the 200
  `ok:false` body, plain-delete immediacy, loop-delete confirm, the
  inside-worktree editor handoff with Windows separators, C.10 refresh,
  Escape + project switch). NOT in: the task editor dialog itself (the
  Edit button arrives with P9-4c), the editor's autocompletes,
  session-switcher placement polish (P9-4c).
- **P9-4c-i (the schedule preview machinery — delivered this slice)** —
  the editor's time inputs need to show what they produce before a task
  exists, so the slice ships the server primitive as a route:
  `POST /api/openchamber/scheduled-tasks/preview` takes a DRAFT schedule
  (+ optional `count` 1..4, `from` epoch) and answers `{slots}` by
  iterating `computeNextRunAt` — the exact function the armer uses — so
  previewed = armed (E-09-26). Wire: invalid drafts answer 200 with the
  collected (possibly empty) prefix — "preview unavailable", never an
  error panel; only shape 400s. Client: `previewNextRuns` in
  `scheduled-tasks-api.ts` with the wire pins (bare `{schedule}` body
  when options are omitted, 200-empty-prefix stays ok, 400 fold). Tests:
  `p9-4c-cron-preview.test.ts` 10/10 (true epoch bytes, DST-family
  spacing, weekly filter, consumed once, hostile shapes, epoch window,
  count clamp, shape 400s) + 4 client pins. NOT in: the editor dialog
  itself, kinds/time literals/weekday selectors (P9-4d), the debounced
  preview wiring in a React surface.

## B. Adaptation deltas (registered)

- **E-09-1 (NND branding of doc 12's openchamber wire names)**: the
  §D.5 broadcast rides `notnative:message-queue.updated` (doc:
  `openchamber:message-queue.updated`, name kept ASCII-stable with the
  dotted suffix) fanning on the `/api/notnative/events` control stream
  (doc's `/api/openchamber/events`); payload shape unchanged
  `{revision, session}` and the harness calls keep `x-nnd-directory`.
  The name row is a single constant (`CONTROL_EVENTS.messageQueueUpdated`)
  consumed by the routes family, the runtime, and the control-bus spy.
- **E-09-2 (knowledge seam, provider-only)**: §D.3.6 step 5's project
  knowledge ships as the `ProjectKnowledgeProvider` seam
  (`resolve(sessionId, directory)` + `recordDelivered`) with
  `NULL_KNOWLEDGE_PROVIDER` wired today and `recordDelivered` running ONLY
  after an accepted prompt (a rejected dispatch carries the knowledge
  again). The project-knowledge module that would implement it is NOT built
  (goal/knowledge slices own it); the contract incl. its failure posture
  (lookup failure → send without it, never block delivery) is pinned by
  tests so the later provider plugs in without runtime changes.
- **E-09-3 (expanded commands REPLACE the user text; skill instructions ride
  slot 4)**: the doc lists "command template expansion or skill instruction
  (when applicable)" as prompt part slot 4, but a non-skill command's
  expanded template REPLACES the delivered text at position 1 and slot 4
  stays open — the expansion IS the user's message (composer parity with
  §B.8; a second synthetic copy would deliver the command twice) — while a
  skill KEEPS its raw `/name args` invocation as position 1 and the
  instruction rides its OWN slot 4 synthetic exactly as written. The
  doc-literal prompt-order contract (1 text, 2 files, 3 context with
  instructions-first, 4 skill instruction, 5 knowledge, 6 agent mention)
  is otherwise byte-pinned by the part-order test.
- **E-09-4 (template-less catalog command keeps the raw invocation)**: a
  non-skill command WITH context whose catalog entry carries no usable
  template delivers its original `/name args` text instead of an expansion
  (nothing to expand; an empty delivered text would drop the payload), with
  its context parts attached verbatim. Registered in `queue-dispatch.ts`.
- **E-09-5 (announce ≠ mutate; sendingId never bumps)**: §D.5's "every
  mutation bumps the revision" covers queue-doc mutations (enqueue, take,
  reorder, delete, drop, delivery commit) — the in-flight mark broadcasts
  WITH-FIRST (§D.3.6) but at the CURRENT revision, because `sendingId` is
  §D.2 deliberately in-memory and unpersisted (a persisted "sending" flag
  would strand a message across a restart); the failure pitch and hold
  announcements behave the same. Clients stay current: same-revision
  broadcasts are not "older than applied", so §D.6's revision gate admits
  them. The startup test pins the +2 arithmetic (enqueue commit + removal
  commit) and the broadcast contract instead of a fake third bump.
- **E-09-6 (emptied queues keep the entry; only `session.deleted` forgets)**:
  after the last item delivers the session entry persists as in-RAM
  directory memory with `items: []` (§D.2's deliberate list), excluded from
  the file and from snapshots; `DELETE /api/message-queue/sessions/:id`
  also keeps it (its in-flight send must find its entry, §D.5); only
  `session.deleted` drops it (`forgetDirectoryMemory` exists for the same
  posture). The engine never auto-GCs it after a drain.
- **E-09-7 (agent mention is not registry-verified at parse time)**: §D.1
  strips a leading `@name` and the dispatcher emits the `{type:'agent'}`
  part, but the harness agent/registry list is not consulted at enqueue
  today; an unknown agent surfaces as a harness rejection at dispatch (backoff
  + failure pitch), not a 400 at enqueue. The registry
  verification hook (`sendConfig.agent` path) joins when the harness
  agent-writing seam lands (goal/orchestration slices reuse it).
- **E-09-8 (no hub module: the queue owns its feed pump)**: doc 12 wires
  the runtime to an internal event hub; NND has no hub yet, so
  `AdapterQueueFeed` taps `GET /api/global/event` through the HP-1 adapter
  seam with its own SSE frame parser, 2 s reconnect loop and connected
  fan-in that triggers `reconcileAll`. The runtime accepts any `QueueFeed`
  (constructor seam), so a later hub module replaces the pump without
  touching delivery semantics.
- **E-09-9 (hold auto-release is scheduled, not latent)**: §D.4 says a
  hold "EXPIRES ON ITS OWN (auto-release) at the TTL", but self-deletion
  had only a check-time reader — for an already-idle session nothing
  guaranteed a later signal, so a dead asserting UI could strand a queue
  long past expiry. `setHold(held:true)` now schedules its own wake at
  `expiresAt + 1 ms` in a separate timer map: burst `busy`/`retry`
  `clearArm`s cannot kill it, every re-assertion replaces it,
  `held:false`/dispose/`session.deleted` clear it. The wake only DRIVES a
  tick — the §D.3 gate ladder (live idleness, hold self-delete, abort
  window, backoff) still owns every dispatch: an auto-review run that
  still holds the session busy is refused by the §D.3.4 live check, and
  only a genuinely idle expiry boundary resumes delivery. Registered in
  `queue-runtime.ts`.
- **E-09-10 (arming + bookkeeping postures)**: (a) quiet coalescing keeps
  the EARLIEST pending arm — a later idle does not extend the 500 ms
  burst window; correctness rests on the §D.3.4 live re-verification,
  which owns late burst members. (b) `arm()` deliberately has no
  `stopped` guard: a post-dispose arm is inert (the tick bails on
  `stopped` first) and the stray timer is bounded by the current backoff
  ceiling — a dispose flush inside `arm` was rejected as ceremony.
  (c) consumption bookkeeping self-vacuums at check time (holds and
  consumed abort stamps — §D.3.1 posture); a stamp emitted for a
  session that NEVER ticks persists until `session.deleted` — a bounded
  per-session timestamp, not a growth path; sendingId/backoff/holds are
  §D.2-in-memory and cleared on the drop path.
- **E-09-11 (slash-catalog load failure degrades to prose)**: the
  §D.3.6 catalog `GET /command` has three outcomes: a genuine miss
  (`source` absent) delivers plain prose through the prompt route;
  a fetch/transport/parse failure ALSO delivers plain prose rather than
  blocking or re-arming — mirrors §B.8's "if command details cannot be
  loaded, the raw invocation remains … dispatch itself is never
  blocked" composer posture. Distinct from the §D.3.4 idleness rule,
  where a failed fetch is UNKNOWN and re-arms: unknown-transport never
  silently rewrites delivery INTENT, only the command ROUTING choice.
- **E-09-12 (feed pump cleanup is shutdown-grade)**: `AdapterQueueFeed.stop`
  halts the reconnect loop and drops listeners but does not cancel a
  stream read already parked in `pump` — an open SSE body keeps the
  read loop alive until the harness closes it (breaker: the process
  shutdown path). `parseFeedFrame` deliberately tolerates heartbeat
  comment frames and multi-line `data:` joins; `response.ok` failures
  count as connect failures and ride the same 2 s retry. A `dispose`
  cancellation handshake would need a cancel handle threaded through
  `QueueFeed`; the interface seam stays lean until a hub module
  (E-09-8) pays for it.
- **E-09-13 (parse trusts the caller's id/createdAt)**: §D.1 casts
  `queued-<ms>-<rand7>` as enqueue-generated, but `parseQueuedItemInput`
  accepts a caller-supplied `id` and `createdAt` — the UI side keeps its
  own legacy ids (§D.6 migrates pre-server items as-is) and the
  20/50/200 000 gated surface makes a spoofed id or future-stamped
  `createdAt` self-owned harm (eviction of one's own session only).
  Server-generated ids stay the default; this is registered, not gated.
- **E-09-14 (lazy route registration, process-land pump)**: createApp
  hands the family a lazy runtime provider (`createMessageQueueRoutes`
  accepts a runtime instance OR a provider), so an app router built in
  a smoke/test process never starts the §D.3 SSE pump (it would pin
  the event loop and the smoke could never exit). index.ts boots the
  singleton eagerly like the terminal sweep/relay service (boot
  failure degrades to a warning plus an empty-queue answer) and
  dispose joins shutdown. Routes pin: the provider resolves only on
  the first request.

- **E-09-15 (objective generations, orphan posture)**: adversarial review of
  the P9 objective-file API confirmed that a session-keyed mutable file would
  let a stale editor overwrite a winning goal after NNA rejects its metadata
  CAS, and a stale clear could delete a replacement containing identical text.
  Each PUT therefore creates a random immutable generation, and NNA goal
  metadata carries only the successful generation key; keyed reads/deletes
  cannot affect a different generation. Legacy unkeyed files remain supported.
  Authenticated clients can still stage bounded (5 KiB) orphan files at
  arbitrary syntactically valid session IDs. Before broad remote goal arming,
  add session-aware quota/garbage collection that preserves the currently
  referenced key; do not delete by session prefix during an active goal.
- **E-09-16 (goal control result authority)**: browser goal controls use the
  NNA mutation response as the authoritative success result; a subsequent GET
  failure cannot recast a committed CAS as a failed edit. The strip tracks
  `metadata.nnd.goalRevision` from the directory and global session caches,
  while an editor generation guard prevents a late objective-file read from
  replacing typed text. Pause/Complete/Clear report explicit partial success
  if NNA committed the goal change but aborting the live turn failed.
- **E-09-17 (NNA turn evidence and arming boundary)**: the NNA default cannot
  apply OpenCode's cumulative message-token math to its projected transcript.
  Its owner-scoped goal-evidence route projects bounded, ordered turn receipts
  with request ID, outcome, accounted tokens or null, and measurement class;
  bodies and failure details stay private. An adversarial review fixed valid
  dotted/colon IDs being omitted, invisible live/journal/compaction window
  truncation, and zero/unavailable accounting masking legacy provider usage.
  NNA rejects fresh goal arming during a pre-goal turn and fences prompt ingress
  while the durable goal CAS is pending. NND seeds the goal cursor from the
  latest receipt and rejects truncated evidence with no usable cursor. The
  future tick must fail closed on lost cursors and unknown usage, not guess a
  budget from the visible window.

- **E-09-18 (the evaluator exchange keeps the dispatch out; ordering is
  audit-first for the sends-off phase)**: the tick's `ready` candidate is now
  consumed by an independent auditor exchange (`nna-goal-auditor.ts`, 245)
  through NNA's authenticated `POST /v1/nnd/sessions/:id/goal-audit` — a
  model-only route NNA binds to the audited turn's FINAL provider route
  (receipt affinity: profile id + model travel the request, and NNA refuses
  conflicting id/revision/objective/request-id/turn-window requests with
  typed contract errors). NNA answers raw text `{text, providerID, modelID}`;
  parsing, note safeguards and goal mutation stay on the NND side. The
  exchange deliberately sends NO prompts — verdicts ride the CAS-only path
  and the loop waits for future turns (or the later dispatch slice), so the
  UI's auto-continuation-disabled label stays accurate. Doc-order deltas for
  the sends-off phase: (a) the upstream persist-accounting-then-send order
  collapses into ONE CAS write AFTER the audit call — the audit is pure on
  NNA and the send race the upstream ordering guards against does not exist
  yet; (b) an UNAVAILABLE/unparsable audit persists ONLY the failure streak
  from the durable goal (tokens and cursor stay unadvanced), so the same
  turn is re-presented next tick and the second consecutive failure settles
  `blocked` ('progress audit unavailable') exactly per T5 — persisting the
  cursor first would strand a counted streak on evidence no tick would ever
  revisit; (c) `continue` verdicts persist note/accounting/eval-route
  attribution WITHOUT bumping `turnsUsed` — the 20-continuation cap counts
  sent continuations, so its slot must be consumed by the dispatch slice at
  send time (queued as its own P9 work); (d) route races are not audit
  failures: `nnd_goal_audit_conflict` (goal changed / stale objective /
  trimmed evidence window) and `nnd_goal_audit_busy` drop the tick with no
  streak write, while transport faults, unknown codes and unparseable text
  ride the T5 streak; (e) every write re-reads the session and refuses on
  revision drift or a loop-field change — against the TICK candidate at the
  exchange's first read (a user Pause/reactivate/budget edit between the
  tick and the audit can only refuse the tick, never be overwritten, even
  when NNA's own trim-match CAS would accept the stale vote) and across the
  audit window itself (revision equality on the second re-read); the
  route's own 25 s deadline rides NNA, NND waits beyond
  the 30 s listener cap (`AUDIT_CALL_TIMEOUT_MS`). Runtime: the ready
  consumer is awaited inline (the exchange inherits the tick's per-session
  in-flight serialization and pending-arm parking) and owns its failures
  (a rejected consumer cannot strand or crash the loop). Not in: send
  arming, schedules, the audit-note language guard tests for live routes,
  and the broad remote orphan-file quota (E-09-15).
- **E-09-19 (the continuation send rides NNA's session route; the loop
  invents no route or retry policy)**: doc 12 B.6.2 copies
  provider/model/agent/variant from the newest non-summary assistant reply
  into the prompt body. NNA does not accept that: its prompt ingress
  requires an EXPLICIT `model` to equal the session's configured route
  (`nnd_model_override_unsupported`) and any `agent` other than `nna`
  (`nnd_agent_override_unsupported`) — a stale route copy would turn every
  post-change continuation into a guaranteed 4xx and strand the goal on its
  own history. The dispatch therefore sends a parts-only body
  (`{parts:[{type:'text',text}]}`, no messageID — NNA synthesizes the
  request id, so no dedupe collision can block a send) and NNA's
  session-configured route governs, which makes a mid-goal route change the
  user's authoritative act rather than a loop hazard. Consequent deltas:
  (a) the send is the exchange's LAST action after the slot-consumption CAS
  (NNA fences prompt ingress while a durable goal CAS is pending, so the
  race the upstream persist-then-send order guarded against is structurally
  absent — E-09-18a's collapse is superseded, not contradicted); (b) a
  refused or failed send writes NOTHING (no streak, no retry timer): the
  turn slot may burn (409 busy seat, transport faults after the CAS), the
  loop stays quiet, and the next exchange re-decides from evidence — a
  bounded single-loss instead of an unbounded send loop; the skip-audit
  resume kick simply waits for the next Resume because the send CAS also
  cleared its label; (c) the turn-slot consumption (`turnsUsed + 1` +
  `statusReason` cleared) is its OWN CAS between verdict persistence and
  the send, restoring the upstream "count consumed at send time" contract
  (E-09-18c); (d) the cap re-check at dispatch time settles
  `blocked`/`continuation limit` so a cap reached inside the exchange
  window (user resave reverted the count) can neither send nor overshoot.
- **E-09-20 (scheduled-task storage rides Intl, not luxon, and the
  multi-writer rule is enforced on RAW records)**: doc 12 C.2 formats
  dates with luxon (`DateTime.fromMillis`, `yyyy-LL-dd HH:mm`) and zone
  checks with `IANAZone.isValidZone`. Luxon is outside the NND dependency
  tree; Node's ICU answers the same questions. Deltas: (a) zone validation
  is a real `Intl.DateTimeFormat` construction (throws for invalid zones
  — the same fail-closed `null`), and `computeNextRunAt` builds daily/
  weekly/once candidates in the schedule's wall clock: a nonexistent
  spring-forward slot is skipped, and a fall-back repeat resolves to its
  FIRST instant (deterministic; per-kind internal consistency — cron
  iterations ride cron-parser's own tz machinery, which is fine because a
  task's kind never mixes paths). (b) Cron is the doc-directed dependency
  (registered `cron-parser`, MIT, v5 `CronExpressionParser` with the
  `{tz}` option), used by BOTH the server and the future UI preview so a
  preview cannot disagree with the dispatch. Storage-level `next()`
  validation means a never-firing expression (e.g. Feb 31) is rejected at
  write, not scheduled into permanent silence. (c) C.9's version-skew rule
  is enforced structurally: a STATE patch swaps only the state object onto
  the RAW stored record after a `findIndex` (no re-normalization), so an
  older build writing state after a newer one cannot strip fields it does
  not know; the SCHEDULING view (read path) IS normalized and reports
  damaged entries instead of deleting them — an unknown schedule kind
  still schedules nothing, but its task stays on disk untouched. (d) A
  patch value of `undefined` is a key CLEAR, not a skip (JSON has no
  undefined; the claim clears a past once slot by clearing `nextRunAt`).
  (e) The config lock is `{pid, at}` wx-exclusive-create with a 60 s stale
  steal and a 5 s unreadable-mid-write grace (a fresh lock caught between
  create and write is not stolen); release verifies it still names this
  pid, so a stolen lock is never unlinked by its loser. (f) NND-side
  storage-safety bounds not in the doc: task id 128, route ids 256,
  loopFile path 1024, cron 200 — caps beyond which a task is rejected at
  normalization, never clamped. Audit-registered behaviors: (g) the ONLY
  modern sub-hour fold (Lord Howe, 30 min) resolves daily/weekly slots to
  the SECOND occurrence, deterministically per process (the 60 s claim
  window is unaffected; the island's first-vs-second choice is invisible
  to the contract); (h) a hard READ error is treated as malformed by the
  writer, so an unreadable-but-valid config is quarantined like a corrupt
  one (bytes land in the `.corrupt-<ts>` aside); (i) hand-edited duplicate
  task ids are loaded as-is (first match wins patches, removal clears all
  matches) because C.1 implies but does not mandate read-time uniqueness;
  (j) the projectId regex carries no length bound here — C.1's bounded
  stem mapping belongs to the project layer, and over-long ids surface as
  plain fs failures the runtime already logs per project.
- **E-09-21 (the scheduled runtime is ports-injected and claims by exact
  armed slot)**: doc 12 §C.4-C.7 sketch the runtime as one harness-side
  module (`runtime.js:248-1132`); NND splits it into six small modules
  (`scheduled-ports/types`, `scheduled-state` memory+timers+queue,
  `scheduled-run` claim/watchdog/completion as standalone functions over an
  explicit run context, `scheduled-claims` pure patch builders,
  `scheduled-util` tiny numeric/message helpers, `scheduled-runtime`
  58-line composition) and the harness-facing pipeline rides the injected
  `ports.runPipeline` — the runtime never imports the harness, so P9-3c
  wires NNA behind that seam without touching the runtime. Deltas:
  (a) deadlines ride the doc's numbers verbatim: global 4 / per-project 2
  slots, 30 min watchdog default, jitter `random(0..2000)` supplied by the
  port (production adapter wires `Math.floor(Math.random()*2000)` in
  P9-3c), and the claim slack predicate is exactly
  `state.lastScheduledFor` finite with `|diff| <= 5000`
  (`TASK_DUE_SLACK_MS`) — nothing else consulted, so the on-disk
  `nextRunAt` being routinely overwritten by sibling syncs never suppresses
  later occurrences. (b) A due timer arms FOR the exact slot it computed
  (`scheduledFor` carried by the timer and request), so the claim tests
  that candidate against the armed occurrence, not against
  `Date.now()` — under multi-process jitter the two processes race for the
  same 5 s window rather than whichever woke first. (c) `nextRunAt` is
  advanced at CLAIM time from `max(now, scheduledFor+1)` (doc step 3), so a
  mid-run crash cannot double-fire the consumed slot after restart; the
  refuser of a claim adopts the winner's task into memory and re-arms from
  the WINNER's persisted `nextRunAt` (only if still future) without
  dispatching (doc step 5). (d) A claim WRITE failure records
  `lastStatus:'error', lastError:'Scheduled claim failed: ...',
  updatedAt` conditionally under the same not-already-claimed predicate
  (a winner's claim is never clobbered) — NEXT-slot bookkeeping is a
  separate best-effort patch + arm, not part of the failure record, and
  the run resolves `{ ok:false, skipped:true, reason:'claim-failed' }`.
  (e) The watchdog is a `Promise.race`: the timeout rejects a guard
  promise, the run records `'scheduled task run timed out'` and the
  session KEEPS RUNNING (doc's explicit note); the discarded background
  result is intentionally not awaited twice. A pipeline REJECTION (not a
  timeout) is a run error with the thrown message — the doc leaves the
  dispatch-crash path implicit; registered: a failed dispatch is an error
  run, never silence. (f) The `running`-status task-run event (C.6 step 5)
  is emitted by the PIPELINE side, not the runtime: this slice's runtime
  emits only the C.7 completion event; P9-3c's adapter emits
  `status:'running'` at dispatch once a sessionID exists. (g) Completion
  order follows the doc exactly: consume `once` (whole-task
  `enabled:false` upsert, warn-only failure) BEFORE the completion patch;
  then latest-or-memory read, the single patch, exactly ONE retry, and on
  double failure the in-memory task goes terminal (success keeps its
  `lastSessionId`, error keeps `lastError`) with the re-arm from the
  in-memory task — a successfully dispatched run stays `ok` with
  `persistError` surfaced (the UI toast is P9-3d). (h) Manual `runNow`
  writes `{lastRunAt, lastStatus:'running', updatedAt}` without claim
  fields, refuses busy/queued with `task-busy` and
  `capacity-exhausted` (the doc's 400/409 service-layer mapping is
  P9-3d), and its completion never re-arms a paused task (an enabled
  task's completion DOES arm — C.7 says arm if enabled). (i) syncProject
  in this slice does NOT discover `.agents/loops` or reconcile loop tasks
  (the doc's `reconcileLoopTasks` step) — loop files are P9-3d; the
  memory-map replace + per-task patch/arm shape is otherwise doc-faithful.
  (j) Known environment flake to watch (not this slice's code): the
  pre-existing `p8-5a` relay client e2e occasionally fails at SUITE level
  in full parallel runs on Windows (child console attach,
  `AttachConsole failed`) while all six tests pass; solo runs and most
  full runs are green. Audit addendum (review round 1, five defects
  reproduced empirically then fixed): (k) a SYNCHRONOUS `runPipeline`
  throw escaped the async shell and misclassified an already-CLAIMED run
  as `claim-failed` — a spurious error patch, a stale-snapshot re-arm
  clobbering the advanced slot, and no completion/event ever (the manual
  path even surfaced the raw rejection) — the pipeline invocation is now
  async-defused with a single failure-mapping catch, so `background`
  never rejects and the race's catch can only mean the watchdog fired;
  (l) a throwing event emitter could poison a fully persisted run
  (emission is now warn-only, per the doc's own "event emission never
  fails the run"); (m) `stop()` could resurrect timers — a run settling
  after stop re-armed a future slot — the runtime now latches inert in
  `stop()` (arming and enqueueing refuse) and clears the latch on
  `start()`; (n) a refused claim re-armed from the winner's slot but did
  not ADOPT the winner's record into memory, leaving `onDue`/claim on a
  stale snapshot until the next sync — now remembered; (o) adoption
  normalization is fail-closed (a hostile `toString` on a raw record
  adopts nothing instead of throwing a refused claim into the
  claim-failure path).
- **E-09-22 (the scheduled pipeline is seam-first and aux-failure tolerant,
  with NND-specific degradations)**: doc 12 §C.6 sequences the run as
  ready-wait, create, event, auto-accept, slash resolution, goal planting,
  dispatch; NND keeps every step but registers these deltas: (a) the
  ready poll targets `GET /command` (a cheap real route on both mock and
  NNA) at 250 ms up to 10 s, and a FAILED poll only warns — the doc's
  non-prompt-goal clause ("goalEnabled without waitForOpenCodeReady
  success still proceeds") is generalized to all runs: the create attempt
  itself adjudicates a cold harness, and its failure is the run's error.
  (b) The `prompt_async` body carries
  `{model: {providerID, modelID}, agent?, variant?, parts}` per §C.6
  step 9 (the same shape the message-queue dispatch already sends);
  E-09-19's parts-only rule stays specific to goal continuations whose
  sessions bind the route at ingress, while a scheduled session is fresh
  and the first dispatch also performs the initial binding. (c) A slash
  prompt whose catalog entry is missing, is a skill (`source ===
  'skill'`), or whose catalog READ fails degrades to the plain prompt
  path — §C.6 has no skill clause and the queue's skill-instruction part
  is NOT injected here; the raw `/name args` text dispatches as prose.
  (d) Auxiliary failures degrade warn-only, never fail the run: emission,
  knowledge lookup, knowledge delivery record, AND a refused goal write
  (the prompt route drops the intro when planting failed — a falsely
  claimed goal mode would be worse than a plain run; the command route
  never carries an intro). (e) Fresh-session goal planting reads revision
  0 when `metadata.nnd.goalRevision` is absent and there is no current
  goal (NNA seeds `?? 0`); an EXISTING goal with a missing revision is
  fail-closed (throws, degrades per (d)). (f) `expandSnippets` is a seam:
  P9-3c ships the identity expansion — prompts dispatch verbatim; the
  `{file}`-style macro resolver and the B.6.3 distill call are future
  ports, and the objective uses `buildGoalPayload`'s 5000-char inline
  clamp with the NND objective store carrying longer texts file-first.
  (g) §C.10's wire payload spells `sessionId` (the doc's camelCase) while
  the internal event field remains `sessionID` — mapped once in the
  service emit adapter. (h) `listProjects` enumerates
  `<data-dir>/projects/*.json` stems (comma-free id pattern); a missing
  or unreadable directory returns an EMPTY list rather than aborting the
  sync (nothing can be scheduled from a directory that does not exist).
  (i) The store-port `consumeOnce` is the whole-document upsert
  `{...task, enabled: false}` (normalize + replace under the same lock,
  §C.7.1's upsert intent). Audit addendum (review round 1, four defects
  reproduced then fixed): (j) a blank/whitespace knowledge resolution was
  dropped from the parts but still recorded DELIVERED (nothing sent, yet
  consumed from later dispatches) — `resolveKnowledge` now normalizes
  blank text to null like the queue's own resolver, and the parts gate
  is a plain `!== null`; (k) an `ObjectiveInputError` from the objective
  store was swallowed silently (the inline 5000-char fallback is a real
  degradation the logs must show) — the warn is now unconditional and
  attributed to the session; (l) the B.6.1 budget sentence could claim
  `A token budget of 0 tokens` for a task whose schema accepts
  `goalTokenBudget >= 0` while the payload's own range nulls sub-1
  budgets — `goalIntro` now applies the payload's budget range, so the
  intro and the goal payload can no longer disagree; (m) the
  delivery-record-failure test asserted nothing interesting (dead
  second-deps construction) — it now pins the warn.

- **E-09-23 (loop files + the scheduled route family, interpreted for
  NND)**: doc 12 §C.8 describes loop discovery/reconciliation but leaves
  several mappings to the build; registered here: (a) §5.16's "404
  invalid project; 400 missing projectId" becomes — a `projectId`
  failing the store id pattern is 400 (a Hono path param can never be
  absent) and a project with no store file on disk is the "invalid
  project" 404. (b) The deterministic `loop:<scope>:<name>` id must obey
  task id law, so loop names are restricted to `[A-Za-z0-9._-]`
  (colon excluded for id sanity): a space-bearing name is a parse
  failure ("not a legal task id segment"), never slugified. (c)
  Leniencies the doc does NOT count as failures: an unknown or invalid
  `timezone` falls back to the server zone (cron validity is still
  checked by the real cron engine), an over/under-long optional `agent`
  is simply omitted, and any `enabled` value other than `true` parses as
  false — discovery must never auto-execute repository content. (d) A
  file without a usable NAME warns and vanishes from discovery (it
  cannot claim a shadowing key); a file WITH a usable name stays even
  when other fields fail — it reports `definition: null` and
  reconciliation keeps its task's last good definition. (e) Discovery
  ranks user first, then project ancestors from the FARTHEST to the
  nearest, and a later file SHADOWS the earlier one for its name (the
  nearest ancestor and the project scope win — the walk ends at the
  FIRST ancestor holding a `.git` entry, inclusive of itself);
  duplicate-name files inside ONE directory are first-sorted-wins with a
  drift warning. (f) Adoption vs rename: a loop adopting a name-
  colliding plain task keeps the stored id verbatim (doc: "id + runtime
  state preserved") along with unknown fields and UI-only execution
  extras; a task whose identity is the FILE (loop-marked entries) is
  re-keyed to the fresh `loop:<scope>:<name>` id whenever its name field
  changes — which also means an adopted task (say id `hand-made`) re-keys
  to the deterministic id on its first post-adoption rename; identity is
  the file path throughout. (g) "Unscheduled (marker persisted)" is
  implemented as REMOVAL of the loop-marked task when its file is gone
  (the loopFile field is the marker across restarts); plain JSON tasks
  are never removed by reconcile, duplicate pointers to one file are
  first-wins, and a reconcile with nothing to do does not rewrite the
  document at all (no per-sync churn). (h) Gate mapping while a loop
  file is present: the general task routes refuse (400) an upsert whose
  id/name/file hits a file-owned task, or whose name any discovered loop
  claims — a mid-edit (parse-failed) file is equally authoritative — and
  DELETE refuses with the doc's guidance text; PATCH
  `.../loop-file` `{enabled}` rewrites the frontmatter flag (appending
  inside the fence when absent), DELETE unlinks the file (ENOENT is
  tolerated — the next sync's orphan prune finishes the job), both then
  ride runtime.syncProject where the C.8 reconcile applies the file, and
  both answer 404 for an unknown task and 400 for a task that is not
  loop-sourced. (i) runNow (C.6 line 892) maps the refusals to HTTP:
  `task-unknown` -> 400, `task-busy` and `capacity-exhausted` -> 409; a
  COMPLETED run always answers 200 with the C.7 result
  `{ok, status, sessionID?, task, persistError?}` — persistence failures
  are body facts, not status codes. (j) The list route answers
  `{tasks}` exactly (unreadable store entries are logged, not leaked);
  the status route's concrete shape is
  `{running: {global, byProject}, queued, tasks[]}` soonest-first
  (doc: "{ ...running state, next runs }"), and syncProject splices the
  computed nextRunAt into the memory task so the snapshot reads memory
  without a store round-trip. (k) The scheduled-task store's own
  `scheduledTasks` config key now has a second writer to defend against:
  the settings-family PUT /api/projects/:id/config drops any incoming
  copy of the key and rides the stored value through verbatim while
  replacing every other key (the C.9 writer discipline widened to the
  settings family). Deltas in code shape: the C.8 runtime ports are
  OPTIONAL (`loopsFor`/`reconcileLoops`) — an unknown project path
  (the harness cannot resolve a worktree) yields NO reconcile and a
  plain JSON sync (the doc's "when the path is known"); reconcile
  failures propagate, skipping the project sync per C.4's broken-project
  rule, while discovery failures degrade to null (plain sync).

  Audit addendum (round 1; five defects reproduced on red, fixed, then
  pinned in p9-3d-audit-repro.test.ts): (l) an adopted task whose id was
  NOT loop-derived was re-keyed to the deterministic id on EVERY later
  reconcile (id churn on each sync plus a doc rewrite E-09-23(g) called a
  no-op) — the re-key now fires only when the file owns the entry AND its
  name field actually changed (or an already-derived id is stale), and a
  no-op reconcile rewrites nothing (byte-pinned). (m) the upsert gate
  checked the STORE's loop-owned entries but not DISCOVERY: a PUT whose
  `loop:scope:name`-shaped id (or whose `loopFile` field) pointed at an
  existing file under a foreign name passed, and the next sync's
  reconcile silently re-owned the just-upserted task — the gate now also
  asks discovery by id and by file path while the file exists. (n) the
  settings-family config PUT performed an unlocked read-modify-write and
  could revert a concurrent store append/patch (the classic lost update)
  — it runs under the per-project write lock now (builder
  `replaceProjectConfig`), the P4-2 todos PUT got the same lock in this
  slice, and a locked reader defers instead of writing around the lock
  (both pinned). (o) `writeLoopEnabled` rewrote the whole frontmatter as
  LF, churning CRLF files (and, on the append path, would have grafted an
  LF line into a CRLF fence) — the rewrite now preserves the file's
  dominant line ending. Also hardened: the existing adoption test's
  rewrite assertion was vacuous (a byte-identical doc comparison replaced
  an assertion that a doc rewrite would have satisfied too); run-now
  while the singleton runtime was never started answers ERROR 500 with
  an empty status shape instead of crashing the handler.

- **E-09-24 (the scheduled-task client seam, interpreted for NND)**: the
  §5.16 surface now has a typed UI client; registered so the dialogs do
  not re-litigate: (a) the envelope rule — the client stamps `ok:true`
  onto a 200 body ONLY when the body carries no boolean `ok` of its own;
  the run route's C.7 result OWNS its `ok` (`finishRun`: ok =
  status === 'success'), so an errored-but-completed manual run answers
  200 with `ok:false` and must NOT read as success (an earlier draft
  stamped every 200 `ok:true` — caught by audit, pinned strict-equal);
  all other endpoints' bodies have no top-level `ok`. (b) Envelope
  asymmetry is the server's contract and stays: PUT returns the stored
  task BARE, PATCH loop-file wraps `{task}` — the client normalizes both
  into `{ok:true, task}` for callers. (c) The PUT input type is
  `ScheduledTaskInput = Omit<ScheduledTaskView,'state'> & {state?}` —
  `normalizeTaskForStorage` seeds a missing state (`createdAt/updatedAt:
  now, lastStatus: 'idle'`) and rejects everything else required; the
  client loosens ONLY state. (d) Id encoding stays `encodeURIComponent`
  (taskId `loop:project:daily` makes `%3A`): verified against the REAL
  Hono router by a temporary probe — decoded params reach the handlers
  (`l%6Fop` resolved and answered the registered 404, which the raw
  string would not); `%2F` stays inside one path segment and lands the
  registered 400; literal colons also match. (e) The runtime transport
  does NOT pre-consume error bodies (status-only observation at the auth
  layer, the coalescer clones + is route-allowlisted, the relay lane
  rebuilds a Response from decrypted chunks), so the server's error
  strings fold verbatim — pinned by a suite that drives the real
  `runtimeFetch` over a stubbed native fetch. (f) `parseTaskRunEvent`
  consumes the control stream's wire frame `{type, properties}` (the
  server fans C.10 payloads out as `properties`), requires a complete
  payload, and accepts only `running|success|error` — `idle` is not an
  emission value (emitRunning/finishRun only). (g) An unknown field
  literally named `ok` on a task is dropped by the upsert view
  reconstruction (the envelope strip) — accepted non-fix: no schema
  defines one and the strip is what removes the stamp. (h) Test
  environment rule: `vi.mock` specifiers must JOIN to the real file from
  the test's directory (`'../runtime-fetch.ts'` from
  `lib/__tests__/`); a non-joining `'../..'`-form silently registers a
  key nothing imports and the mock never binds — hit this round's probe
  and registered here as the UI-suite mock rule.

- **E-09-25 (the scheduled surface's UI posture, interpreted for NND)**:
  registered so P9-4c and future audits do not re-litigate: (a) the
  view-ownership boundary in `useScheduledTaskList` — a load answers only
  the CURRENT view (a `viewIdRef` armed by the list effect arms nothing
  else), so a slow load of a previous project or a C.10 frame through a
  subscription that is cancelled-but-not-yet-closed paints nothing into
  the switched view; a fanout resolving after teardown only closes. (b)
  The loop-file editor handoff targets the ACTIVE directory (FilesView's
  root and the tabs-store `byRoot` key), never the selected project's
  worktree — they differ when the session sits in a subfolder or the file
  belongs to another project; the guard for an unbootstrapped empty
  active directory; outside-the-active-root loop files keep the button
  disabled with the path as its title (a user-scope `~/.agents/loops` file
  cannot ride the workspace-scoped editor by design; the toggle + the
  enabled-fence PATCH manage it instead). (c) Default project selection:
  exact worktree match against the active directory (case-insensitive),
  else the first roster entry. (d) A list 404 renders as "No scheduled
  tasks for this project yet" — the store is born on the first create
  (E-09-23 a carried into the UI), never as an error panel. (e) The
  enable toggle split: loop tasks go through the loop-file PATCH (the
  file is authoritative; a gone-file 404 toasts verbatim and the refetch
  repaints the file-owned state), plain tasks through the PUT with the
  full-task spread (server normalize preserves unknown fields and
  `state`, verified against task-schema). (f) The delete split: plain
  delete is immediate, the loop delete confirms in-row ("delete file?")
  because it removes the FILE and the reconcile prunes the task on the
  refetch. (g) Weekday summary labels index 0=Sunday, matching the
  server's `getUTCDay()` filter in `next-run.ts`. (h) Escape-close rides
  the same no-autofocus overlay convention as TimelineDialog; the shell
  wiring removes its window listeners on teardown. (i) The function-cap
  gate measures RAW block length (no nesting collapse) — the dialog is
  split into hook/fanout/panel/header/rows/name-block/actions so every
  span stays ≤ 60; expect that shape to be kept, not re-merged.

- **E-09-26 (the schedule preview route, NND interpretation of §C.2/§C.3
  "next-4-runs preview")**: the §H editor shows the next runs BEFORE a
  task exists; there is no openchamber route for that, so NND ships the
  arming primitive as `POST /api/openchamber/scheduled-tasks/preview`
  (registered here and in the §A P9-4c-i row): (a) wire — draft schedule
  + optional `count` (integer 1..4, else default 4; 0/out-of-range → 4)
  + optional `from` (epoch ms); the bounded reader folds malformed/
  oversize/non-object bodies into the one 400 `preview body must be an
  object`, and a missing/non-object/array `schedule` into `schedule
  object is required`. (b) leadership — the loop iterates
  `computeNextRunAt(draft, true, cursor)` with `cursor = last + 1`, the
  same claim-cursor shape the runtime uses (`Math.max(now, scheduledFor
  + 1)`), the same 5 s due-slack, so previewed = armed; the only
  divergence is the runtime's overdue policy inside a long running task
  (§C.2 previews the schedule, not the runtime's timing). (c) invalid-
  draft posture — an invalid draft answers 200 with the collected
  (possibly empty) prefix; the UI renders "unavailable", it is never an
  error panel; `from` is honored only inside `[0, 253402300799999]`
  (year-9999Z edge; beyond it Intl candidates throw RangeError) and
  folds to `Date.now()` like a non-number. (d) hostile shapes — the
  daily/weekly branches of `computeNextRunAt` now guard non-array
  `times`/`weekdays` to empty (audit-reproduced TypeErrors escaped the
  handler): compute stays the validator, the route never wraps the loop
  in try/catch. (e) the client `previewNextRuns` passes `count`/`from`
  through UNCLAMPED (JSON.stringify renders NaN/±Infinity as null, the
  router folds null to now) — one validation authority, the server, so
  a client clamp cannot grow a second drifting count window. (f) cost
  note — scans are bounded (15 candidate days, cron max, fold walk);
  worst case ≈ 1 s CPU at a 64 KiB all-valid-times body, localhost
  behind the gates, acceptable for a debounced editor call; the same
  cost class exists for the pre-existing armer with 256 KiB stored
  bodies — carried here as a flagged follow-up, not fixed in-slice.
