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
