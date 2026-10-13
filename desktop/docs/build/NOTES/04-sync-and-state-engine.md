# NOTES 04 — Client sync & state engine (from docs/planning/04)

> **Historical implementation note — 2026-10-01:** Retained for contracts and dated evidence.
> Current scope, ownership, remaining work, and acceptance are defined by
> [PLAN](../PLAN.md) and the [execution audit](../EXECUTION/01-architecture-audit.md).
> Old mock-only, auto-accept, lifecycle, and deferral instructions are superseded.
> A recorded test pass is limited to its stated version and surface.


## A. Architecture spine (build in P2)
Layers: harness+server → event pipeline → handleEvent+applyDirectoryEvent reducer →
per-directory child stores + global sidecar stores → SessionMessageLoader (HTTP transcript
authority) → useSyncExternalStore leaf selectors → UI (doc 05).
- Two scopes NEVER merge: (1) child stores `StoreApi<DirectoryStore>` per normalized directory
  (live sessions/messages/parts/status/permissions/questions of INITIALIZED dirs only);
  (2) global sidecars (live status index, ordering ranks, turn timing, global sessions cache,
  streaming store). Live busy indicators read the status index, never the sessions cache.
- `SessionLiveActivity = active|idle|unknown`; `idle` requires child-store coverage of the dir;
  `unknown` never treated as idle; destructive actions refuse on unknown.
- React binding: plain closures + zustand vanilla stores; provider contexts (runtime context with
  subscribable currentDirectory source; sync context adds directory value); leaf selectors only
  (`Object.is` ref-equal skips re-render); hot aggregates subscribe only to their slice
  (session_status / session) + domain-equality minimizer.
- Child-store pattern: ChildStoreManager owns children Map (normalized dir → StoreApi),
  lifecycle lastAccessAt, pins, bootstrap scheduler, eviction, sidecar message notification.
- State fields per directory: status loading|partial|complete; agent,command,project,projectMeta,
  icon,provider,config,path; session Session[] sorted-by-ID binary index; sessionTotal (roots);
  sessionListSource empty|persisted|live|authoritative; sessionRevision; sessionEventRevision;
  sessionDeletedRevision (tombstones beat overlays); session_status; sessionStatusReady (true ONLY
  after successful snapshot; omitted status ≠ idle before it); session_diff/todo/permission/
  question; mcp/lsp/vcs; limit (5 initial → ≥50 after authoritative load); message
  Record<sessionID,Message[]>; part Record<messageID,Part[]>.
- Identity: dir key normalizePath (slashes, upper drive, strip trailing); session identity =
  (runtimeKey, dir, sessionID); EVERY async completion generation-guarded vs runtime/sdk/store-
  identity/loader-generation. msg_/prt_ ids = identity NOT chronology (6-byte rolling prefix);
  ALWAYS order by (time.created, id) — never lexical ID sort.
- Sanitization at ingestion: stripSessionDiffSnapshots (revert.snapshot/diff, summary.diffs
  before/after/from/to/patch), stripMessageDiffSnapshots (keeps patch), stripSessionListDetails
  (list: delete permission, whole summary.diffs, reduce revert → {messageID,partID?}).

## B. Event pipeline contracts (exact)
Envelope `{id?,type,properties}`; fold `^(.*)\.(\d+)$` → base type. Directory resolution:
envelope.directory → properties.directory → properties.info.directory → "global"; then routing
index may override. Server control frames `<brand>:session-status` normalize to session.status
(sessionID|sessionId; status idle|busy; retry needs numeric attempt+string message+numeric next
else DROP).
Per-directory queue {queue,buffer,coalesced,timer,last}; double-buffered swap flush;
FLUSH_FRAME_MS=33 (publish ≈30Hz), BACKPRESSURE_MODE_MS=10_000 widens to
BACKPRESSURE_FLUSH_FRAME_MS=200; STREAM_YIELD_MS=8 event-loop yield; heartbeat timeout
DEFAULT_HEARTBEAT_TIMEOUT_MS=30_000 resets on ANY frame → abort `${transport}_heartbeat_timeout`.
Coalescing (ONLY 4 keys): `session.status:<id>` replace-in-slot; `session.updated:<id>` replace;
`lsp.updated` single; `message.part.delta:<msg>:<part>:<field>` CONCATENATE. Barriers: full
message.part.updated for a part deletes its pending delta keys; session.idle/error/created/deleted
delete `session.status:<id>`; created/deleted also delete `session.updated:<id>`.
Backoff: base 250ms; computeRetryDelay = min(cap, 250·2^(failures−1)); cap 5_000 visible+online,
60_000 hidden|offline; exponent clamp 8; permanent 4xx (400.. except 408,429) → long cap
immediately. waitForRetry resolves early on online / visibility→visible / abort; onOffline/
onOnline/pageshow/system-resume abort current attempt (system-resume → retryDelayMs 0).
notifyDisconnected once per cycle; markConnected → resync flows (see reconnect).
Transport auto|ws|sse: no WebSocket fn → sse; ws unless wsFallbackUntil>now; WS upgrade cannot
carry auth header → mint url token BEFORE connect (`nn_url_token=` query); WS failure in auto →
wsFallbackUntil = now+60_000, code WS_FALLBACK → transport switch (NOT disconnect), retryDelay 0;
ready timeout 2_000; close before ready → clear cached token; close <2s after ready → prefer SSE.
WS frames: `ready{replayReset?}` (replayReset ⇒ clear cursor, full authoritative repair even early
boot), `event{payload,eventId?,directory?}`, `error`, `backpressure{bufferedBytes,maxBytes}`.
SSE: Last-Event-ID header when cursor known; `id:` updates cursor. Reconnect recovery (§D.5):
markConnected → queueStore.resync (independent of boot debounce) → stop if (!replayReset &&
(firstConnect && !disconnectedBeforeFirstConnect)) → stop if (!replayReset && isRecentBoot) →
resyncAfterStreamGap("stream-reconnect") for EVERY child dir; transport switch → same with
"transport-switch".

## B2. Reducer catalog (applyDirectoryEvent) + clone map
session.created/updated: binary upsert by id; freshness guard shouldSkipStaleSessionEvent
(incoming time.updated|created < current ⇒ skip); archive truthy ⇒ REMOVE + cleanupSessionCaches
(message/part/todo/diff/status/permission/question) + sessionTotal−1 (root) + tombstone revision;
sessionListSource="live"; revision marks. session.deleted: `{sessionID}|{info}` remove + cleanup +
tombstone + persisted-state cleanup + loader invalidate + toast dismissal.
session.diff → session_diff[sessionID]. session.status: set if changed (type; retry also
attempt/message/next). session.idle/error: write idle/error if changed + clear coalesced key +
interrupted-turn reconcile same batch + settled-running-tool enqueue + child-session-idle enqueue +
timing settle; error adds recordSessionError (20 max). todo.updated: set unless JSON-equal (+persist).
message.updated: skip if areMessageUpdateFieldsEqual (role, finish, time.completed, summary|error|
cost|tokens|structured|model|tools|format|variant|agent|system); replace-in-place or remove+
reinsert chronologically; absent bucket ⇒ [info]; assistant inserted with NO part bucket ⇒
materialize empty-assistant-message; time.completed while still busy ⇒ 750ms deferred status poll.
message.removed: delete message + part bucket. message.part.updated: skip types patch|step-start|
step-finish; need messageID; upsert by part.id; shouldPreserveExistingPart (existing tool in
completed|error|aborted|failed|timeout|cancelled or with time.end never overwritten by
non-terminal/end-less); snapshot-after-delta dedupe: __dedupeNextDeltaFields ["text"|"output"] +
appendNonOverlappingDelta (longest suffix-overlap scan), flag clears after first apply; NEW-id
text|file part REPLACES optimistic (sessionID-less) same-type part in place, else push; owner
message absent ⇒ materialize missing-owning-message. message.part.removed: delete part, drop empty
bucket. message.part.delta: append to part[field] (overlap-dedupe when flagged); coalesced in
pipeline. vcs.branch.updated → draft.vcs. permission.asked/replied + question.asked/replied/
rejected: binary upsert/remove in permission[sessionID]/question[sessionID]; toast unless viewed
(keys `${sessionID}:${requestID}`, ids `permission-`/`question-` prefix). lsp.updated → deferred
refetch. server.connected/global.disposed → refresh (suppressed within BOOT_DEBOUNCE_MS=1500 of
boot; else global reload=pending + forced bootstrap every non-loading child). project.updated →
global projects binary upsert. heartbeat/ping → activity stamps only.
Clone map (clone ONLY written slices; one setState per touched store per flush; DirectoryEventBatch
tracks Map<store,draft>+Map<store,Set<clonedField>>): session events → session,permission,todo,
part,revision maps (+question when deleted/archived); session.status/idle/error → session_status;
session.diff → session_diff; todo → todo; message.updated → message; message.removed →
message,part; part.* → part; permission.* → permission; question.* → question; lsp → lsp;
vcs.branch → none.
Routing index precedence: (1) explicit dir if its store holds the session; (2) indexed dir (store
exists); (3) scan all stores (self-heals); (4) active-dir fallback ONLY if event session == active
session AND active store exists; (5) message-addressed: dir holds parts → indexed session-of-message
→ part-bucket scan → orphan-part active-dir fallback (triggers materialization, not death);
(6) single-store fallback; (7) normalized dir ("global").

## C. Bootstrap
Global (per mount/runtime switch): generation++, bootingRoot; allSettled(path.get, config.get,
project.list[filter worktree, sort id]); unwrap error ⇒ throw w/ status; missing data w/o error ⇒
synth 503 (retry: 3 attempts, 500ms×2, 10s cap); ALL failed ⇒ /health probe (4s) w/ lastError;
partial fail = diagnostics only; ready:true regardless; bootedAt then BOOT_DEBOUNCE_MS=1500.
Directory scheduler: priorities selected(0)<active-project(1)<expanded(2)<visible(3)<background(4);
concurrency 2; visible/background only while ZERO low-priority(≥visible) in flight; demand dedup by
dir, promote on higher priority, force ORs; states queued→running→complete|failed; generation/
token/runSequence isCurrent() gates EVERY publication incl. setTimeout(0) deferred phases.
bootstrapDirectory: seed project+config from global (status partial); PHASE 1 allSettled
(project.current, config.get, path.get, session.status→sessionStatusReady=true on success ONLY);
abort only if ALL failed OR (path.get failed AND no project); status:"complete" → paintable;
PHASE 2 (after phase-3 request starts, setTimeout(0)): command.list, mcp.status, lsp.status,
vcs.get, question.list/permission.list(directory) grouped by session sorted by id, SIGNATURE-
GUARDED merge (id-set signature unchanged pre-read/post-write ⇒ response-omitted entries deleted
only, live SSE arrivals preserved); PHASE 3 (holds slot): paged session list (pageSize 500,
archived:false roots:true; best-effort roots:false second pass) → mergeBootstrapSessions closed
hierarchy (retain parents from broader/cached set, tombstoned-ancestor children excluded,
post-baseline events overlaid back) → setState(session, sessionTotal, source:"authoritative",
limit:max(len,50)) → routing re-ingest. Empty result AUTHORITATIVE on web/desktop (no retry loop).
Cold continuity: persisted dir cache (sessions ≤50) paints instantly → replaced by phase 3;
runtime live-status seed for current busy session (TTL 15_000, expiry→idle); last-session pointer
(confirm before opening). System-resume: resync blocking requests for ACTIVE dir only, deduped.

## D. Recovery / watchdog / materialization
Reconnect candidates: status≠idle ∪ trailing-assistant-without-time.completed ∪ non-renderable
(missing part bucket) ∪ all parentIDs in list ∪ viewed session (if in active dir & known);
zero ⇒ stop. Authoritative status resync: snapshot replaces candidates; absence⇒explicit idle
(authoritative mode sets sessionStatusReady); feeds global index (knownSessionIds=candidates);
then interrupted-turn reconcile per candidate. null fetch = preserve state, NEVER empty success.
Then per candidate session.get + refreshTail(30); then resyncBlockingRequests (signature guard,
toast only not-viewed unseen ids); re-ingest routing index.
Watchdog per initialized dir @5000ms: candidates; status poll ≤5000ms MONOTONIC (confirm/raise
only, never lowers); idle-snapshot-vs-busy-store ⇒ escalate authoritative resync (cooldown 15_000);
stale-stream: shouldTrigger(staleAfter=20_000, resyncCooldown=15_000) on lastStreamActivityAt
(counts heartbeats; 0=disabled) ⇒ pipeline.reconnect("active_stream_stale") + triggerDirectoryResync.
MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS=750 deferred single poll per dir\0session.
Interrupted-turn: finalize ONLY on explicit authoritative settle (idle/error event or snapshot
record), never absent status, never while busy; guard no pending question/permission; trailing
assistant w/o time.completed ⇒ complete locally error MessageAbortedError("aborted") + finalize
active tools (status error/"Interrupted"/end) same batch; later terminal supersedes; stale refresh
never regresses finalized (materialization keeps terminal parts). Tool cleanup on materialize:
pending/running tool under completed message → error/"Interrupted".
Materialization scheduler: reasons missing-owning-message|orphan-delta|missing-delta-part|
empty-assistant-message|child-session-idle|child-session-discovered|ensure-session-messages|
stream-reconnect|transport-switch|stale-status-resync|settled-running-tool. Key
[runtime,dir,session]; cooldown SESSION_MATERIALIZATION_COOLDOWN_MS=5_000 incl. fast success
(settled-running-tool may supersede a different pending reason); runs after current batch;
pre-flight still-needed re-check (explicit [] bucket counts as fetched-empty authoritative);
refreshTail(SESSION_MATERIALIZATION_MESSAGE_LIMIT=30); pre-refresh non-idle ⇒ authoritative status
resync for session; then recoverInterruptedTurnAfterMessageLoad; stale guards store/pending/
runtime/sdk; marker cannot be cleared by older completion.

## E. Message loader (single transcript HTTP authority)
Key runtime\ndir\nsession. State {status idle|loading|ready|error, loadingKind initial|older|
refresh|prefetch|null, error, resolved, limit, cursor (header x-next-cursor; complete=!cursor),
complete, generation, updatedAt}. Pages: initial 50, older 100. ensure (renderable⇒ready w/o HTTP;
attach in-flight; foreground upgrades prefetch kind), prefetch, loadOlder (merge prepend, buckets
not overwritten), loadComplete (visited-cursor guard), refreshTail(limit) (window cursor must NOT
clobber coverage cursor; queued behind in-flight older loads, max-limit), optimisticAdd/Remove/
Confirm (per-entry Map<messageID,item>; page merges optimisticIn; drop confirmed when server parts
cover), invalidateSession/Directory/dispose (generation/sdkEpoch), initializeCreatedSession
(claim EMPTY transcript [sessionID]=[], supersede unresolved load, preserve arrivals, mark ready).
Initial underfill expansion: first page !complete && no user message ⇒ fetch [100,150] before
commit (constrained [50,80,120]). Failure ⇒ status error + keep records, NEVER empty success.
Records chronologically sorted + diff-sanitized + parts filtered to identified.

## E2. Optimistic send (exact sequence)
runtimeKey guard → waitForConnectionOrThrow (CONNECTION_GRACE_MS=2000, 500ms probe timeout,
100ms loop) → resolve dir (session's OWN confirmed directory) + store → revert-branch commit
(remove tail+marker, restore exactly on failure) → ascendingId msg/prt → optimistic message
(user, time.created=now, completed=0)+text/file parts → optimisticAdd → set status busy →
send(messageID) (SERVER GETS SAME ID) → success = nothing (echo reconciles) → failure:
isAmbiguousSendFailure: transport-tagged OR status∈{503,504,408} OR TypeError OR DOMException
AbortError|TimeoutError OR message ~ timeout|timed out|failed to fetch|networkerror|network
error|gateway timeout|econnreset|socket hang up. Ambiguous ⇒ confirmation refetch limit 30,
reconnect-bound wait 3000ms@100ms, ≤3 attempts @ 250·2^(n−1); found ⇒ materialize server records +
confirm + RESOLVE QUIETLY (never roll back — queue could double-send). Definite/absent ⇒
recordSendFailure (buffer 20, reason≤200) + optimisticRemove + revert restore + status idle +
rethrow.
Blocking replies: route by session record's directory (ownership NOT containment): search all
stores' buckets for request → resolve dir = record.directory ?? project.worktree ?? store key.
Reply success removes deterministically; QuestionNotFound/PermissionNotFound (404/message match) ⇒
remove locally + enqueue settled-running-tool materialization. Send-path supersede: dismiss
permissions+questions across session SUBTREE (childrenByParent BFS, ids≤root) optimistically,
reject in parallel, swallow failures.

## F. Lifecycle actions (P2 subset)
createSession: capture runtime → create → stale check → sessionDirectory = response.directory ??
requested (SERVER AUTHORITATIVE) → routing pre-register → child insert if empty → loader
initializeCreatedSession → select + global upsert. setCurrentSession: publish draft-transition
identity BEFORE closing draft; fetch STARTS BEFORE store publication (400ms keep-old-timeline in
05); set {currentSessionId,currentSessionDirectory} together; guessed dir never persisted;
archive = updateSession({time:{archived:Date.now}}) → remove+invalidate+global archived bucket;
restore writes sentinel archived:0 (readers classify by truthiness; lists must fetch inclusive);
delete: 404 on child = cascade ⇒ commit; runtime-guard before EVERY reconciliation; move: invalidate
BOTH dirs. Eviction: soft cap MAX_DIR_STORES=30, sort lastAccessAt asc, evict over-cap or idle
≥DIR_IDLE_TTL_MS=20min, NEVER within EVICTION_GRACE_MS=30s, NEVER with pending blocking requests;
canDispose recheck (booting/loading/blocking). Message-map LRU SESSION_CACHE_LIMIT=40 protected:
non-idle, pending request bucket, unfinished trailing assistant.
Ordering (F.10): ranks monotonic max(lastRank+1,Date.now()); promote EXACTLY on settled(busy|retry
↔ idle|error) crossings; first snapshot = baseline w/o promotions (ties share ONE rank); baseline
frozen at first participation (created if pinned else updated); comparator: pinned bucket, rank
WITHIN scope (roots vs roots, children vs same-parent siblings), baseline desc, created desc, id
asc; raise baselines only on authoritative snapshots; NEVER sort lists by time.updated.
Timing (F.10): startedAt (persisted single key, NOT runtime-scoped) + settledMs (cap 200); busy
NEVER starts clock (means "still running"); only live idle/error or COVERED-snapshot silence
settles; liveness stamp ≤15s + precise on pagehide/hidden/freeze; restore eligibility
pageLoadAt−seen ≤ MAX_AWAY_MS=30_000 vs performance.timeOrigin; adoption window 90_000 else
discard; MAX_TURN_AGE_MS=24h; malformed rejected.

## H. Streaming store
streamingMessageIds Map<session, messageID|null> + messageStreamStates Map<msgID,{phase
streaming|cooldown|completed, startedAt,lastUpdateAt,completedAt?}>; MESSAGE lifecycle not turn;
completed-stamp trailing never streaming even while session busy; only busy sessions stream;
part-only events touch heartbeat only (no busy rescan); heartbeat throttle 1000ms.

## Persistence subset built in P2 (rest deferred)
G.1 principles all apply: stale cache never authority; failure≠empty; runtime scoping; debounced
writes flush on pagehide/beforeunload/hidden/freeze; pending writes for old runtime rejected;
tombstones for explicit-empty. Built: dir sessions cache (`nnd.dir.v2.*`, ≤50, debounce 50ms,
fallback ladder [50,25,10,5,1], v2 tombstone), last-session pointer (≤8 runtimes), session-activity
single key, runtime live-status seed. DEFER: worktree map, drafts, input history, pins/folders/
tabs/todos/display stores, message-queue store+sync, permission auto-accept, notification store,
chatDraft, safe-storage adapter nuances (keep simple try/catch JSON).

## Deferred beyond P2 (owner → later doc/phase)
- Retention/auto-cleanup (§F.7) → doc 08 (P8); folders/pins/tabs/worktree bindings (§F.8) → 06/07;
  multi-run (§F.9) → 12; message queue server+sync (§G.3) → 03/06 (P4+); permission auto-accept
  incl. VS Code runtime (§E.5) → 06 (P4); toasts for blocking requests minimal here (dedupe keys +
  viewed gate), full copy/lifecycle → 05 (P3); question-recovery (§E.7 delays [0,500,1500]) → P3
  with chat mount; bulk archive echoes + archive batch (§F.4 batch) → P4; VS Code-only empty-list
  retry loop N/A (P2 skipped); prefetch pagination metadata cache (200-entry LRU) → P3;
  diagnostics counters (§I.12) → post-P2; safe-storage adapter → P3.
- P1 interim superseded: useSessionsStore ad-hoc status map + App refetch-on-event + fixed mock
  model constant (model picker still P3); ChatView keeps visual shape.

## Test hinge points (doc §J.2 subset for P2, built in P2)
pipeline: coalesced delta concat; part.updated clears delta keys; idle clears status key; per-dir
flush frame (one publish); backoff caps incl. 4xx-long-cap; heartbeat abort; replayReset→cursor
clear; yield cadence (skip). reducer: freshness guard; chronology insert out-of-order; terminal
tool preservation; delta overlap dedupe; no-op equality (status/todo/message/session); archive
branch removal+tombstone; optimistic part replace-in-place. routing: directory-less event rules.
bootstrap: de-blocking rules; signature-guarded merge. child-store: priorities/dedupe/promote/
force/stale-generation guard; eviction: grace beats burst, TTL bounds, blocking-request protect.
loader: inflight share; prefetch→initial promote; underfill expansion; refreshTail doesn't clobber
cursor; queued refresh; generation rejection; initializeCreatedSession empty+supersede.
reconnect: candidate enumeration; monotonic vs authoritative; sessionStatusReady only-on-success;
interrupted-turn guards + later-terminal-supersede + stale no-regress; 750ms poll no-request-when-
idle. ordering: promotion-only-on-crossing, baseline freeze, scope-local rank. timing: busy never
starts; adoption bounds. optimistic: ambiguous confirm-in-place; definite rollback+status idle+
failure log. blocking: ownership routing; NotFound⇒remove+materialize.

## Review register (adversarial sub-agent pass, 2026-09-16)

Fixed in P2:
1. P0-1 runtime reset bricked the scheduler — ChildStoreManager.reset() (re-arms
   configure/generation; partsResetAll uses reset not dispose).
2. P1-1 primitive field publication — recordRevision/ensure('sessionTotal')/
   deletedRevision ensured, batching publishes counters + tombstones.
3. P1-2 mergeBootstrapLists closed hierarchy — tombstoned-ancestor exclusion now
   actually fires; cached parents retained ONLY as parents; live overlays re-added.
4. P1-3 runGlobalBootstrap runs in partsStart; bootedAt measures from COMPLETION.
5. P1-4 eviction sweep — 30s coalesced interval in partsStart, stopped on dispose.
6. P1-5 signature guard reads the POST-FETCH map: stable-pinned deletes stick; mid-flight
   arrivals preserved from CURRENT state (no pre-read resurrection, no arrival loss).
7. P1-6 archive echo — reducer outputs {sessionID, record}; side effects upsert to the
   global archived bucket and retire the live status index entry on archive AND delete.
8. P2-1 pipeline classification — supervisor interrupts (online/offline/pageshow/
   system-resume) no longer count as failures or fake heartbeat reasons; reconnect()
   consumes its own flag; disconnect reason flows into useConfigStore (no 'init_error'
   hardcode).

Registered for later phases (P2 residuals):
- P2-2 control-frame normalization seam (<brand>:session-status + retry-shape DROP).
- P2-3 routing: info.directory source; store-scan precedence (3) instead of index replay;
  'global' junk-store creation guard.
- P2-4 streaming reconcile hooks (busy transitions, message slices); map bounds.
- P2-5 watchdog per-directory cooldowns; discovery inserts+registers; 750ms
  contradiction escalation.
- P2-6 recovery runtime guards before global index feeds; session.get retry; revision-
  guarded fetched-session upsert.
- P2-7 lifecycle actions: runtime guards, delete/archive local reconciliation, move.
- P2-8 optimistic send: revert-branch commit/restore; ownership dirs for supersede;
  restore-to-idle; 200-as-success contract check.
- P2-9 loader: complete-flag short circuit; server-side deletions on refreshTail merge;
  6-status terminal set in mergeParts; isCurrent entry-creating side effect.
- P2-10 bootstrap: paginated session list; path-without-project abort rule; phase-2
  schedule timing.
- P2-11 covered-snapshot settle call sites; ordering tie-break (baseline desc only);
  baseline raise on authoritative snapshots.
- P2-12 minor: churn-free no-op paths for session echoes; part/message map prunes after
  idle; lastRunAt prune; NaN comparators guard; sanitize input clone.
