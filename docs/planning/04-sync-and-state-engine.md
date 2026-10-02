# 04 — Client Sync & State Engine (packages/ui/src/sync + stores)

> **Reference status — 2026-10-01:** This document records OpenChamber behavior.
> Execute [the NND build guide](../build/PLAN.md) and its native-contract amendments.
> Reference auto-accept, managed-harness, TUI, and process-ownership details do not
> override NNA governance or the independent NNA/NND product boundary.
> Use the [document disposition audit](../build/EXECUTION/01-architecture-audit.md)
> and feature coverage guide before treating a reference requirement as executable work.


Cleanroom reference for the OpenChamber client-side sync and state engine. Source of truth here is
OpenChamber's own maintained documentation (`packages/ui/src/sync/DOCUMENTATION.md`,
`packages/ui/src/stores/DOCUMENTATION.md`) verified line-by-line against the implementation. You do
not need access to that repository to implement this document: every contract, constant, timing, and
sequence needed to reproduce the mechanism is inline. ` (src: ...)` citations point back at the peer
repository for traceability only.

## 0. Scope and cross-references

| Document | Owns |
|---|---|
| 02 — Harness event/payload definitions | Authority for OpenCode event type names, `Event` envelope shape (`{ type, id?, properties }`), `Session`/`Message`/`Part`/`SessionStatus`/`PermissionRequest`/`QuestionRequest`/`Todo` payload shapes. This doc *references* those type names and defines what the client does with them. |
| 03 — Server-side routes/queues | Authority for OpenChamber server routes: control SSE `/api/openchamber/events`, message queue REST (`/api/message-queue*`), permission policy, chat directories. This doc consumes them. |
| 05 — Chat UI | Consumes the stores, hooks, and materialized records this engine publishes. |
| 12 — Feature: Multi-Run orchestration | `useMultiRunStore` semantics cross-referenced but not duplicated here. |

All timings, sizes, and key names below are exact, extracted from source. When a value is hardcoded,
it is given as `literal (src: file:line)`.

---

## A. Architecture

### A.1 Layer diagram

```
        harness (OpenCode-compatible) + OpenChamber server
                             |  SSE (LongEventSource) or WS (global/event/ws)   see 03/02
                             v
  +------------ Event pipeline (createEventPipeline) -------------+
  |  transport selection, heartbeat, backoff, Last-Event-ID cursor|
  |  per-directory event queues, coalescing, 33ms flush frames    |
  +---------------------------------------------------------------+
                             |  one ordered flush per directory (readonly Event[])
                             v
  +--- Event handler (handleEvent) + reducer (applyDirectoryEvent) ---+
  |  directory routing (routing index), event ordering fixes,         |
  |  in-place draft mutation on batch-cloned slices, one store        |
  |  publication per touched directory per flush                      |
  +-------------------------------------------------------------------+
        |                                |
        v                                v
  Directory child stores            Global sidecar stores
  (ChildStoreManager, 1/directory)   (live status index, ordering ranks,
  State = sessions/messages/parts/   turn timing, global sessions cache,
  status/permissions/questions/...   streaming store, notification store)
        |                                |
        v                                v
  Sessions message loader (authoritative HTTP transcript fetches)
        |
        v
  Hook layer: useSyncExternalStore leaf selectors + sidecar subscriptions
        |
        v
  UI surfaces (05)
```

### A.2 The two data scopes (do not merge them)

There are exactly two live data scopes, intentionally different (src: sync/DOCUMENTATION.md §"two
distinct session data scopes"):

1. **Directory-scoped sync stores** — one Zustand `StoreApi<DirectoryStore>` per normalized
   directory path, created lazily by `ChildStoreManager`, primed by SSE + directory bootstrap.
   Live source for sessions/messages/parts/permissions/questions/status of *initialized*
   directories only.
2. **Global sessions cache** (`useGlobalSessionsStore`) — shared active+archived coverage for the
   sidebar and retention, fed by one inclusive HTTP poll + event deltas + direct mutations. It is
   **not** the source of live busy/retry status (that is the global live status index) and not the
   source of messages.

Rules derived from the split:

- Live activity/status indicators must read the event/snapshot-reconciled live index
  (`useGlobalSessionStatusStore`), never the global sessions cache (src: sync/DOCUMENTATION.md
  "Mutation responsibility" bullet list).
- Aggregate "live sessions across initialized directories" reads child stores (hooks
  `useAllLiveSessions`, `useAllSessionStatuses`), while cold/global coverage (archived pages,
  never-opened directories) reads the global store.
- `SessionLiveActivity` in `session-actions.ts` has a third answer: `"active" | "idle" | "unknown"`.
  `idle` requires positive coverage of the session's directory by an initialized child store;
  `unknown` must never be treated as idle. Callers gating destructive actions (worktree moves) must
  refuse on `unknown` (src: session-actions.ts:446-477).

### A.3 React binding style

- The engine is plain closures + Zustand, no classes (except `ChildStoreManager`, `SessionMessageLoader`).
- `SyncProvider` publishes **two** React contexts:
  - `SyncRuntimeContext` (`useSyncRuntime()`): `{ childStores, messageLoader, runtimeKey, sdk, currentDirectory }`
    where `currentDirectory` is a **subscribable source object** `{ get(), subscribe() }`, not a value.
    Reading it through `useSyncExternalStore` yields a constant snapshot for a hook handed an explicit
    directory, so cross-project switches do not re-render directory-addressed rows
    (src: sync-context.tsx:103-138, 2851-2874).
  - `SyncContext` (`useSyncSystem()`/`useSync()`): adds `directory: string`; consumers re-render on
    each directory switch. Only chat-frame-level consumers use this.
  - Context objects are stored on `globalThis` under `__openchamber_sync_context__` /
    `__openchamber_sync_runtime_context__` so duplicated module instances share one context (src:
    sync-context.tsx:127-138).
- Leaf selectors everywhere. `useDirectorySync((s) => s.permission[sessionID] ?? EMPTY)` rather than
  subscribing to containers. A selector returning an identical reference skips the subscriber's
  re-render (`Object.is`). Broad container subscriptions are the primary anti-pattern the entire
  store-split design exists to avoid (src: stores/DOCUMENTATION.md "Selector Rules").
- Hot cross-directory aggregates (`useAllSessionStatuses`, `useAllLiveSessions`) use a cached
  external-store selector (`useLiveSyncSelector`) that subscribes to **only** the slice it aggregates
  (`childStores.subscribeAllSelected((state) => state.session_status, notify)`) and minimizes with a
  domain equality function (`areStatusMapsEquivalent`, `areSessionListsEquivalent`), so unrelated
  part deltas do not recompute the aggregate (src: sync-context.tsx:184-308).
- Per-session sidecar subscriptions: `subscribeDirectorySessionMessages(store, sessionID, listener)`,
  `subscribeDirectoryPermission`, `subscribeDirectoryQuestion(s)` attach WeakMap-keyed listener sets
  to the *session*, and the store subscription notifies only listeners whose session bucket reference
  changed (src: child-store.ts:23-198). Messages also get a *purpose diff*: part-only changes carry
  the changed `messageIDs` so callers can filter (`user-message-history.ts` skips assistant-only
  changes; `useSessionRenderable` skips notifications that leave the session renderable).
- An unannotated bulk `part` replacement (part record changed, no targeted marks) conservatively
  resets all subscribed sessions for that store so bootstrap/rollback/legacy writers cannot leave
  stale projections (src: child-store.ts:149-198).

### A.4 Child-store pattern

One `ChildStoreManager` owns:

- `children: Map<string /* normalized directory */, StoreApi<DirectoryStore>>` where
  `DirectoryStore = State & { patch(partial), replace(next) }`.
- Lifecycle map `lifecycle: Map<string, { lastAccessAt: number }>`, pins `Map<string, number>`.
- The bootstrap scheduler (see §C), eviction (see §F.5), and sidecar message notification routing.

Store creation (`createDirectoryStore`): seeds from the persisted per-directory cache (stale-while-
revalidate: sessions paint instantly from `localStorage`; only an authoritative fetch replaces that
list), subscribes to persist `vcs`/`projectMeta`/`icon`/`sessions` back, and routes permission /
question / message sidecar notifications (src: child-store.ts:252-286).

Initialization (all fields; src: types.ts:115-158):

```
MAX_DIR_STORES     = 30        // soft target, overflow tolerated for graceMs
EVICTION_GRACE_MS  = 30_000    // recently-touched dirs are never overflow-evicted
DIR_IDLE_TTL_MS    = 20*60_000 // idle-time eviction bound
SESSION_CACHE_LIMIT= 40        // per directory message-map LRU (desktop); 4 on VS Code/mobile
```

`State` (per directory):

| Field | Type / shape | Notes |
|---|---|---|
| `status` | `"loading" \| "partial" \| "complete"` | store readiness |
| `agent, command` | lists | bootstrap phase 2 |
| `project` | string (id) | seeded from global projects then phase 1 |
| `projectMeta, icon` | metadata | persisted |
| `provider, config, path` | SDK payloads | bootstrap phase 1 |
| `session` | `Session[]` sorted by ID (binary-search index) | authoritative list |
| `sessionTotal` | number | count of root (no `parentID`) sessions |
| `sessionListSource` | `"empty" \| "persisted" \| "live" \| "authoritative"` | provenance of current snapshot |
| `sessionRevision` | number | bumped on every session-list mutation (events or actions) |
| `sessionEventRevision` | `Record<sessionID, revision>` | per-session last event/action application |
| `sessionDeletedRevision` | `Record<sessionID, revision>` | deletion tombstones; beats overlay merges |
| `session_status` | `Record<sessionID, SessionStatus>` | `idle \| busy \| retry{attempt,message,next}` |
| `sessionStatusReady` | boolean | true only after a *successful* status snapshot; never persisted |
| `session_diff, todo, permission, question` | `Record<sessionID, ...>` | per-session buckets |
| `mcp, lsp, vcs` | enrichment | bootstrap phase 2 |
| `limit` | number | session list spray limit (`= 5` initial; raised to >= 50 after authoritative load) |
| `message, part` | `Record<sessionID, Message[]>` / `Record<messageID, Part[]>` | live transcript |

`sessionStatusReady` is deliberate: before it (or an explicit status record) arrives, an omitted
status is "unknown", never proof of idle; a failed status fetch must not grant idle authority
(src: sync/DOCUMENTATION.md rule 6; bootstrap.ts:175).

### A.5 Sanitization boundary

Oversized blob fields are stripped at three ingestion points, before anything enters a store
(src: sanitize.ts):

- `stripSessionDiffSnapshots(session)`: removes `revert.snapshot`, `revert.diff` (strings) and for
  each `summary.diffs[]` entry removes string `before`/`after`/`from`/`to` and `patch`.
  Applied in the event reducer (`session.created`/`session.updated`) and on session responses.
- `stripMessageDiffSnapshots(message)`: same for `summary.diffs[]` but keeps `patch` (message
  objects may carry a small patch; full-content fields still stripped).
- `stripSessionListDetails(session)`: for list responses, additionally deletes `permission`, deletes
  whole `summary.diffs`, and reduces `revert` to its `{messageID, partID}` marker (revert is
  otherwise never deleted entirely — a non-object `revert` triggers the strip).

Reverted-UI behavior derives from the lightweight `session.revert.messageID` marker only; stores must
never hold file snapshot blobs. All loader/list ingestion paths apply the strip (src: session-message-
loader.ts:628, globalSessions.ts:162, sync-context.tsx:1562).

### A.6 Identity and keying model

- A directory key is `normalizePath(path)`: backslashes → slashes, Windows drive letter upper-cased
  (`c:` → `C:`), trailing slashes stripped (for length > 1) (src: useDirectoryStore.ts:46-58,
  sync-context.tsx:891-898).
- A **session identity is the tuple** `(runtimeKey, normalized directory, sessionID)`. Session IDs
  alone are NOT globally unique across runtimes/directories (src: sync/DOCUMENTATION.md rule 1).
  This tri-part key appears in: message loader entry keys (`runtimeKey\ndirectory\nsessionID`),
  prefetch cache, message-queue keys, input history buckets, todos, drafts, pins, viewport memory
  (`viewportSessionKey`), view counters.
- A `runtimeKey` identifies the connected harness instance (web/desktop/VS Code/mobile surfaces can
  switch runtimes without reload). EVERY async completion must be generation/token-guarded against
  runtime switches, sdk swaps, directory store identity, and loader generation.
- Message IDs `msg_<6-byte-rolling-hex><base62>` are **identity, not chronology**: the fixed-width
  sortable timestamp prefix rolls over, so a newer `msg_000..` can follow an older `msg_fff..`.
  Part IDs have the same property. Everything (fetch, pagination, materialization, optimistic
  insertion, events, render, revert/undo/redo) orders by `message.time.created` (number, tie-break
  ID string compare) — never by ID lexically (src: message-ordering.ts).

---

## B. Complete event catalog

### B.1 Transport envelope and normalization

An event arrives as `{ id?, type, properties }` (02 owns shapes). The pipeline normalizes:

- Extension-suffixed types (`foo.1`) are folded to their base type by regex `^(.*)\.(\d+)$`
  (src: event-pipeline.ts:138-158).
- The OpenChamber server's own `openchamber:session-status` frames are converted into a standard
  `session.status` event: `properties.sessionID|sessionId`, `properties.status` ∈ `idle|busy`;
  `retry` requires numeric `metadata.attempt`, string `metadata.message`, numeric `metadata.next`
  else the frame is dropped (src: event-pipeline.ts:80-136).
- Directory resolution order (src: event-pipeline.ts:160-190): (1) envelope `directory` field;
  (2) `properties.directory`; (3) `properties.info.directory` (session payloads); else `"global"`.
  Then the consumer's `routeDirectory(directory, payload)` hook (the directory routing index in
  §D.3) may override.

### B.2 Catalog

`applyDirectoryEvent` is the reducer; `handleEvent` (sync-context.tsx) routes + side-effects. Sources:
harness SSE/WS via the OpenCode-compatible global event stream (02), and the OpenChamber control
SSE (03) for `openchamber:*` types. "Changed" = reducer returned true / batch published.

| Event type | Payload (`properties`) reference | Reducer behavior | Side effects | Affected stores/slices | Clone on receipt |
|---|---|---|---|---|---|
| `session.created` | `{ info: Session }` | binary-search upsert (sorted by `session.id`); skip if `shouldSkipStaleSessionEvent` (incoming `time.updated/created < current`); trim; `sessionTotal += 1` if root; `sessionListSource = "live"`, revision marks | routing index session→directory; global session router upserts (immediate if structural, deferred if recency-only); alive-code path pre-registers ID→directory before arrival when possible | child `.session/.sessionTotal/.session*Revision`; global sessions store | `session`, `permission`, `todo`, `part`, revision maps |
| `session.updated` | `{ info: Session }` | same as created; **if `info.time.archived` truthy**: REMOVE session (splice), `cleanupSessionCaches` (drops message/part/todo/diff/status/permission/question for that ID via `dropSessionCaches`), `sessionTotal -= 1` if root, tombstone revision | routing index; loader generation bump (invalidate); global router applies archive (remove from active / upsert to archived). Stale SSE archive echoes of a batch archive are consumed by the bulk-archive echo table (§F.4) instead of reducer (freshness check runs BEFORE the archive branch) | child `.session/...`; global store | `session`, `permission`, `question`(if archived/deleted), `todo`, `part`, revision maps |
| `session.deleted` | `{ sessionID }` or `{ info: Session }` | remove session; cleanup caches; `sessionTotal -= 1` if root; tombstone revision | `cleanupPersistedSessionState` (drafts, queue projection, todos, folders, pins, input history — §F.6); loader invalidate (delete + archived); router remove; pending UI toasts for that session id | child + global + queue + persisted stores | same as created |
| `session.diff` | `{ sessionID, diff: FileDiff[] }` | `session_diff[sessionID] = diff` | — | child `.session_diff` | `session_diff` |
| `session.status` | `{ sessionID, status }` | set if changed (`areSessionStatusesEqual`: type equal; `retry` also compares `attempt`, `message`, `next`) | drop the queued/coalesced `session.status:<id>` key | child `.session_status`; global live status index; ordering ranks (`observe` active); timing (`observe` active) | `session_status` |
| `session.idle` | `{ sessionID }` | write `{ type: "idle" }` if changed; drop coalesced status key for that session → clears pending `session.status` coalescing, ordering transition | notification append (if top-level & not viewed); trailing `settled-running-tool` materialization enqueue; parent `child-session-idle` materialization enqueue; interrupted-turn reconciliation in the same batch; enqueue-side coalescing deletion; module timing `observe settled` (retires persisted start) | child; global index; ordering; timing; notifications | `session_status`, then possibly `message`/`part` (interrupted finalize) |
| `session.error` | `{ sessionID, error? }` | identical to idle for status/reducer; additionally `recordSessionError` (memory log, 20 max) and type `"error"` notification with `{name, message}` summary | same as idle | same as idle + session error log | `session_status` (+message/part finalize) |
| `todo.updated` | `{ sessionID, todos }` | set unless JSON-equal; also writes to `useTodosPersistStore` (persisted todos, runtime+directory+session key) | — | child `.todo`; todos persist store | `todo` |
| `message.updated` | `{ info: Message }` | find by ID in `message[info.sessionID]`; skip if `areMessageUpdateFieldsEqual` (preserves reference — no re-render); if same chronology position replace; else remove + chronological reinsert (insert by `time.created`); if bucket absent create `[info]` | full-part MISSING? if assistant message inserted with no part bucket → `empty-assistant-message` materialization enqueue; if `info.time.completed` present and session still busy → `maybePollStatusAfterMessageCompletion` (750ms deferred); routing index message→session | child `.message` | `message` |
| `message.removed` | `{ sessionID, messageID }` | remove message; also `delete part[messageID]` | routing index removal | child `.message`, `.part` | `message`, `part` |
| `message.part.updated` | `{ part }` (+ optional `sessionID`) | skip `part.type ∈ {patch, step-start, step-finish}`; ignore without `messageID`; upsert by `part.id` into `part[messageID]`; **preserve existing terminal tool part** if incoming non-terminal or loses end time (`shouldPreserveExistingPart`); set `__dedupeNextDeltaFields` on part when next snapshot's text/output relates to previous (snapshot-after-delta dedupe, §D.4); **insert order**: if new part id and `text|file` type and some existing part of same type has NO `sessionID` (optimistic part), replace THAT in place (keeps ordering + avoids remount) else push; produce `materialization: missing-owning-message` result if owning message absent | part-change mark (`markDirectorySessionPartChanged`) for sidecar notify; pipeline clears that part's pending delta coalescing keys (snapshot barrier); `sessionEvents.requestGitRefreshForToolTransition` on tool status change; heartbeat `touchStreamingSession` if streaming directory | child `.part`; git hint bus | `part` |
| `message.part.removed` | `{ messageID, partID }` | remove part; delete empty `part[messageID]` bucket | sidecar mark | child `.part` | `part` |
| `message.part.delta` | `{ sessionID?, messageID, partID, field, delta }` | append `delta` to `part[messageID][field]` string; if part has `__dedupeNextDeltaFields` including `field` use overlap-deduped append (`appendNonOverlappingDelta`: suffix-overlap scan) and clear that field from dedupe set; new part object + new array | sidecar mark; streaming heartbeat; coalesced in pipeline (deltas merged into one queued event per `(messageID, partID, field)` key) | child `.part` | `part` |
| `vcs.branch.updated` | `{ branch }` | `draft.vcs = { branch }` unless equal | git stores consume via hint bus | child `.vcs` | (none — mutates `draft.vcs` directly) |
| `permission.asked` | `{ PermissionRequest }` | binary-search upsert `permission[permission.sessionID]` sorted by `permission.id` | toast unless viewed/pending (toast id `permission-<sessionID>:<requestID>`, dedupe set `sessionID:requestID`); VS Code: async auto-accept path (`processVSCodePermissionAutoAccept`) replaces the sync path; server-mode: `usePermissionStore.isSessionAutoAccepting(sessionID)` → silently skip (no store write!). On auto-accept decline → event re-handled with store write | child `.permission`; permission store (policy) | `permission` |
| `permission.replied` | `{ sessionID, requestID }` | binary-search remove from `permission[sessionID]` | toast dismiss + pending-toast key delete; pending VS Code deferred-ask token invalidated (a later `permission.replied` must not let an async policy check resurrect a resolved request) | child `.permission` | `permission` |
| `question.asked` | `{ QuestionRequest }` | upsert `question[sessionID]` | toast unless viewed/pending (id `question-<key>`; title = first question `header` fallback `"Input needed"`, description `question` fallback `"Agent is waiting for your response"`) | child `.question` | `question` |
| `question.replied` | `{ sessionID, requestID }` | remove | toast dismiss | child `.question` | `question` |
| `question.rejected` | `{ sessionID, requestID }` | remove | toast dismiss | child `.question` | `question` |
| `lsp.updated` | — | no reducer change; deferred HTTP load | `onLoadLsp` callback → refetch `lsp` | child `.lsp` | `lsp` |
| `server.instance.disposed` | — | reducer: `onRefresh("")` | global refresh pipeline | global sync store | — |
| `server.connected` / `global.disposed` | — | `reduceGlobalEvent` → `{type:"refresh"}`; during/within `BOOT_DEBOUNCE_MS` of boot the refresh is suppressed; otherwise `useGlobalSyncStore.reload = "pending"` and every directory child store with `status !== "loading"` gets a **forced** bootstrap request (`reason: "server-connected"`) | — | global sync store; child bootstrap queue | — |
| `project.updated` | project payload | `applyGlobalProject`: binary-search upsert into global `projects` | — | global sync store `.projects` | — |
| `installation.update-available` | `{ version }` | — | window CustomEvent `openchamber:opencode-update-available` | updater UI | — |
| `openchamber:session-status` (03 control/main stream) | see §B.1 | normalized to `session.status` | — | as `session.status` | — |
| `openchamber:message-queue.updated` | `{ revision, session }` (zod-validated incl. `serverSessionSchema`) | — | `applyMessageQueueUpdatedEvent` → projection replace (§G.3). Applied from BOTH the control SSE subscription and the main event dispatch (`handleEvent` first line) | message queue store | — |
| `openchamber:permission-auto-accept.updated` | `{ sessions: Record<id,bool>, revision }` | — | `usePermissionStore.applySnapshot(snapshot, runtimeKey)` with monotonic revision guard | permission store | — |
| `openchamber:notification` | `{ title, body, tag, kind, sessionId, directory, requireHidden, desktopNotificationDelivered, desktopStdoutActive }` | — | runtime-API notification dispatch (skipped on the `"local"` runtime when the server already delivered a desktop notification or stdout is active); `kind: "opencode-restart-interrupted"` → sticky toast with "Open session" action | OS/notification hosts | — |
| heartbeat / `ping` | — | resets stream activity/heartbeat timestamps only | — | — | — |

Global stream directory-omission rule (src: sync/DOCUMENTATION.md "Directory-less session events"):
when the stream omits the directory for a session-addressed event, resolve it through the routing
index; if the index is briefly stale, route the event **only when** the event session matches the
active session AND that directory store exists; otherwise leave it un-routed — never update another
directory on a guess.

### B.3 Clone-on-receipt map (authoritative; keep code and table in sync)

`handleEvent` clones ONLY the field set the reducer writes (the "golden rule"), so untouched slices
keep referential identity and their subscribers skip. During streaming `message.part.delta` fires
~60/s; eager all-field cloning was measured at ~1972 `MessageList` renders per session, targeted
cloning reduced it to ~296 (src: sync/DOCUMENTATION.md "Why this matters").

| Event | Fields to clone | | Event | Fields |
|---|---|---|---|---|
| `session.created/updated/deleted` | `session`, `permission`, `todo`, `part`, `sessionEventRevision`, `sessionDeletedRevision` (+`question` when deleted or newly archived) | | `message.updated` | `message` |
| `session.diff` | `session_diff` | | `message.removed` | `message`, `part` |
| `session.status` / `session.idle` / `session.error` | `session_status` | | `message.part.updated/removed/delta` | `part` |
| `todo.updated` | `todo` | | `permission.asked/replied` | `permission` |
| `vcs.branch.updated` | (none) | | `question.asked/replied/rejected` | `question` |
| `lsp.updated` | `lsp` | | — | — |

Per-flush batching still clones each touched slice **at most once** per flush: `DirectoryEventBatch`
tracks `Map<store, State>` for cumulative drafts + `Map<store, Set<field>>` of already-cloned fields;
the store receives exactly one `setState` per flush (src: sync-context.tsx:237-269, 1858-1955).

---

## C. Bootstrap sequence

### C.0 Definitions

- *Runtime* = one connected harness instance (`runtimeKey`), `sdk` = its OpenCode-compatible client.
- *Global state* = the `useGlobalSyncStore` snapshot `{ ready, error?, path, projects, providers,
  providerAuth, config, reload, sessionTodo }` (src: global-sync-store.ts, types.ts:74-84).
- The chats root warm-up (`warmChatsRootDirectory()` / `ensureChatsRootDirectory()` 03) classifies
  managed-chat sessions; it runs *alongside* bootstrap calls, not ahead (src: bootstrap.ts:72-75).

### C.1 Global bootstrap (per SyncProvider mount / runtime switch)

1. Increment `globalBootstrapGeneration`; set `bootingRoot = true` (suppresses event-triggered
   global refreshes until `bootedAt` is set; relaxed `BOOT_DEBOUNCE_MS = 1500ms` after
   `bootedAt`).
2. `Promise.allSettled` of: `warmChatsRootDirectory()`;
   `retry(sdk.path.get)` → `set({path})`; `retry(sdk.global.config.get)` → `set({config})`;
   `retry(sdk.project.list)` → filter `p.worktree` present and path not containing
   `"opencode-test"`, sort by id, `set({projects})` (src: bootstrap.ts:72-88).
3. `unwrap()` semantics — CRITICAL: the SDK returns `{data,error,response}` without throwing on
   non-2xx. `unwrap` converts `error` to a thrown `Error` (stamping `.status`), and a missing
   `data` with no error is treated as **transient (status 503)** so `retry()` fires. Never let a
   5xx silently become empty state (src: bootstrap.ts:15-38).
4. If ALL requests failed, fetch OpenChamber `/health` (4s timeout) outside the readiness gate to
   surface `lastOpenCodeError` / "OpenCode process is not running"; `set({ ready: true, error })`.
   Partial failure => diagnostics only; `set({ ready: true, error: undefined })` (src:
   bootstrap.ts:96-117).
5. On completion set `bootedAt = Date.now()`; finally `bootingRoot = false`.

### C.2 Directory bootstrap (scheduler-owned; never row-mount effects)

`ChildStoreManager` is the single owner. Consumers publish demand:

- `requestBootstrap(demand)` (manual, one-off) and `setBootstrapDemand(owner, demands[])` /
  `clearBootstrapDemand(owner)` (declarative from the layout-level list driver). Aggregate demand is
  the highest-priority demand per directory across owners.
- `DirectoryBootstrapPriority`: `"selected"(0) < "active-project"(1) < "expanded"(2) < "visible"(3) <
  "background"(4)` (src: child-store.ts:200-233).
- `DirectoryBootstrapReason`: `current-directory | selected-session | known-project | known-worktree |
  project-expanded | worktree-expanded | server-connected | action-demand`.

Scheduler behavior (src: child-store.ts:479-667):

- `bootstrapConcurrency = 2` — at most **two** directory bootstraps run concurrently. `nextBootstrap`
  additionally only admits `"visible"`/`"background"` entries while ZERO low-priority (≥ `visible`)
  runs are in flight, so `selected`/`active-project`/`expanded` always outrank background.
- Demand is deduplicated by normalized directory; a later higher-priority demand promotes the
  queued entry; `force` ORs.
- States per directory: `queued → running → complete | failed`; `failed` reasons
  `os-permission | generic`. A completed/failed bootstrap is only redone on forced demand.
- Each run captures `generation` (manager configure generation), a token, the manual-demand
  revision, and a per-directory `runSequence`. The `isCurrent()` closure = not disposed AND
  generation unchanged AND this is still the newest run for that directory AND the child-store
  identity did not change. Stale completions are recorded `"stale"` and publish nothing. Deferred
  phase work (scheduled via `setTimeout(0)`) remains gated on `isCurrent()` — this is why the
  deferred pull cannot be killed by the run token but still cannot publish into a newer generation.
- On settle: `"complete"` cleaned; `"failed"` recorded with `os-permission` only when the owning
  runtime filesystem API (`getRegisteredRuntimeAPIs().files.listDirectory(directory)`) independently
  confirms `EPERM`/`EACCES` for that exact directory. OpenCode/proxy error text is never permission
  evidence (src: child-store.ts:635-641, sync-context.tsx:2445-2458).
- A pinned directory (mounted consumer) is disposed only when unpinned: "a mounted directory-store
  consumer pins that store for its lifetime" (src: child-store.ts:375-399, useDirectoryStore pin
  effect sync-context.tsx:2868-2871).

### C.3 `bootstrapDirectory` sequence (src: bootstrap.ts:124-308)

Numbered:

1. Capture `state` and `loading = state.status !== "complete"`. `commit()` = guarded by `isStale`.
2. **Seed from global state**: `project` = first global project whose `worktree` or `sandboxes`
   contains the directory; seed `config` if store config empty and global config non-empty
   (emitting `emitSyncConfigChanged`); set `status: "partial"` while loading; stale → return.
3. **Phase 1 (critical path, blocks first paint with chat data) — `Promise.allSettled`:**
   a. `project.current` (skipped when seeded),
   b. `sdk.config.get` (emit config change),
   c. `sdk.path.get` (`path` + project resolution),
   d. `sdk.session.status()` → `session_status`, sets `sessionStatusReady: true` on success.
4. De-blocking rule (do not strand the directory in loading): abort (return `"failed"`) ONLY when all
   phase-1 requests failed, or when `path.get` failed AND no project resolved. A failed
   `session.status` snapshot is harmless — SSE replaces it (src: bootstrap.ts:184-198).
5. `status: "complete"` after phase 1 lands → UI can paint.
6. **Phase 2 (deferrable enrichment; scheduled AFTER phase 3 request starts, via `setTimeout(0)`,
   never extends slot ownership)**: `command.list`, `mcp.status`, `lsp.status`, `vcs.get`,
   `question.list(directory)` (grouped by session, sorted by id, **signature-guarded**: requests
   whose id-set signature is unchanged between pre-read and post-write may be DELETED when the
   response omits them — i.e. an empty response clears only conversations nobody touched, so the
   merge cannot erase live SSE updates that arrived mid-flight), and the same for
   `permission.list(directory)` (src: bootstrap.ts:208-290, requestSignature = sorted ids joined by
   `"|"`).
7. **Phase 3 (authoritative session list — this is what the scheduler slot is held for):**
   `loadSessions(directory)`:
   a. Capture `baselineRevision = store.sessionRevision ?? 0` AFTER the store is created.
   b. `listGlobalSessionPages(sdk, { directory, archived: false, roots: true, pageSize: 500 })`
     — inclusive-of-nothing server filter (active only), paged with a `500` page size, on success
     filter IDs and sort by session id.
   c. Best-effort second pass: `roots: false` (children/sub-agents) — on failure fall back to
     roots-only (`allSessions = null`).
   d. `mergeBootstrapSessions(rootSessions, allSessions, existing, {
     baselineRevision, eventRevision, deletedRevision })` — snapshots MUST publish a **closed
     hierarchy**: sessions with a `parentID` retain their referenced parent, which is recovered from
     the broader response or the pre-existing cached list; children whose ancestors were
     deletion-tombstoned after the baseline are excluded, and events newer than the baseline are
     overlaid back (their id sets survive, deletions stay deleted) (src: reconnect-recovery.ts:49-99).
   e. `store.setState({ session, sessionTotal: rootCount, sessionListSource: "authoritative",
     limit: max(sessions.length, 50) })` then re-ingest the routing index.
8. `sessionListSource` provenance is load-bearing: banned "cache as a race fallback" — bootstrap
   completion replaces persisted data **including with a successful empty response**; only session
   events and direct move/archive/delete mutations newer than the captured baseline revision
   survive overlay (src: sync/DOCUMENTATION.md "Directory bootstrap scheduling").
9. VS Code-only retry: if the bridge answered an empty 200 during warmup and `attempt < 5`, wait
   `2000ms`, set status back to `"loading"`, retry (attempts 0..4). On web/desktop an empty result
   is AUTHORITATIVE — no retry loop (src: sync-context.tsx:2419-2440).
10. On `"complete"`, `useSessionUIStore.adoptAuthoritativeSessionDirectory()` promotes a guessed
    selection directory to the authoritative one (§F.2).
11. Trigger UI demand after: `useSessionListSync` (layout-level) publishes the complete known
    project/worktree set as demands (`current-session` and active project outrank; collapsed and
    off-screen directories remain background demand so they refresh eventually), coalescing
    OpenChamber control events for `500ms` (src: sync/DOCUMENTATION.md "Layout-mounted session-list
    lifecycle"). Sidebar must NOT start bootstrap from row-mount effects.

### C.4 Cold-start continuity layers (what loads before anything else)

In order of arrival safety:

1. **Persisted directory metadata** (`readDirCache`): `vcs`, `projectMeta`, `icon`, bounded session
   snapshot (≤50) — instant sidebar paint, replaced by step 3 of §C.3.
2. **Persisted managed-chats startup snapshot** (`oc.dir.v2.readManagedChatSessions`, scope key
   `openchamber:managed-chats`): the global sessions store seeds its full state from this snapshot
   before leaving `idle`; every global session surface sees the stale snapshot while the real list
   is unresolved/failed; the first authoritative load replaces it. Persistence is produced by a
   store subscription and only after the chats root authority is warm (src:
   useGlobalSessionsStore.ts:873-888, persist-cache.ts:247-260).
3. **Runtime live-status seed** (`runtime-live-memory.ts`): at runtime switch, if the *current*
   session was busy/retry, seed the new directory store's `session_status` for that one session on
   first `ensure`; TTL `LIVE_STATUS_TTL_MS = 15_000`; a seed expiry timer resets it to idle if no
   authoritative event contradicted. Entries keyed `runtimeKey\ndirectory`, evicted lazily on read
   and eagerly on write (src: runtime-live-memory.ts, sync-context.tsx:2738-2772).
4. **Last-session pointer** (`oc.lastSession.v1`, per runtime, ≤8 runtimes): startup-only context;
   callers must confirm the session still exists against an authoritative snapshot before opening
   it (src: last-session-cache.ts:1-12).
5. **Worktree topology cache** (`oc.worktreeMap.v2`): `Map<projectRoot, WorktreeMetadata[]>`
   seeded synchronously into `sessionUIStore.availableWorktreesByProject`, refreshed by discovery
   in the background via a serialized-comparison write-through guard (no redundant localStorage
   write when content unchanged) (src: session-ui-store.ts:968-984, 2268-2283; caching module
   §G.4).

### C.5 System-resume (foreground) handler

A `openchamber:system-resume` window event (Electron power monitor / Capacitor foreground) triggers
`resyncBlockingRequestsForActiveDirectory(currentDirectory)` ONLY for the active, materialized
directory; deduplicated while in flight (`blockingRequestResyncingDirectoriesRef`); preserves
existing state on fetch failure; unopened directories untouched; the normal reconnect recovery
remains the broader catch-up path (src: sync-context.tsx:2318-2334; sync/DOCUMENTATION.md).
The event pipeline separately aborts the current attempt on the same event
(`onSystemResume`) so reconnect runs immediately with `retryDelayMs = 0`
(src: event-pipeline.ts:903-909).

---

## D. Live channel lifecycle

### D.1 Transport (event-pipeline.ts)

One pipeline per provider mount, plain closure API with `{ cleanup, reconnect }`:

- Ordered queue model: events enqueue into **per-directory** `DirectoryQueue { queue, buffer,
  coalesced, timer, last }`; flush swaps `queue`/`buffer` (double-buffer, zero allocation per
  flush) and delivers `onEvents(directory, readonly Event[])` in order. Each flush frame is
  scheduled `FLUSH_FRAME_MS = 33ms` after `d.last`, so a directory's changes publish at ~30Hz even
  under 60Hz input.
- Backpressure: a WS `backpressure` frame opens `BACKPRESSURE_MODE_MS = 10_000ms` during which
  flush frames widen to `BACKPRESSURE_FLUSH_FRAME_MS = 200ms` (src: event-pipeline.ts:24-27,
  732-735).
- Yield: between SSE frames, when `Date.now() - yielded >= STREAM_YIELD_MS = 8ms`, `await wait(0)`
  — keeps the event loop responsive on dense replay (src: event-pipeline.ts:581-595).
- Heartbeat: any SSE event/WS frame resets a timer; on expiry the attempt aborts with reason
  `${transport}_heartbeat_timeout`; `DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000` (29:41).
- Transport selection: `transport: "auto" | "ws" | "sse"` from the settings store
  (`settingsMessageStreamTransport`; on mobile it is the same `auto`). `resolveTransport()`:
  no `WebSocket` function → `sse`; forced choice honored; otherwise `ws` unless
  `wsFallbackUntil > now` (src: event-pipeline.ts:790-801).
- WS specifics: the upgrade cannot carry an Authorization header, so the query-param token
  (`oc_url_token`) must be minted **before** connecting (`refreshRuntimeUrlAuthToken`); on failure
  in `auto` mode, set `wsFallbackUntil = now + WS_FALLBACK_WINDOW_MS = 60_000` and rethrow with
  `code = "WS_FALLBACK"`; the loop treats that as a transport switch, not a disconnection
  (`onTransportSwitch`), with `retryDelayMs = 0`. Ready timeout `DEFAULT_WS_READY_TIMEOUT_MS =
  2_000`. If the socket closes before `ready`, clear the cached token (it is being replayed
  against a server that will not accept it, else reconnect storms loop). If it closes quickly
  after ready (< 2s lived) prefer SSE for the fallback window (src: event-pipeline.ts:598-801,
  27-31).
- WS frame types: `ready` (with optional `replayReset: true` — the server's bounded replay suffix no
  longer covers the client's `lastEventId` cursor, so clear the cursor and let reconnect recovery do
  full authoritative repair, even during early boot), `event` (`{ eventId?, directory?, payload }`),
  `error`, `backpressure` (src: event-pipeline.ts:70-78, 704-755).
- SSE specifics: the retryable stream sets `Last-Event-ID` header when a cursor exists; SSE `id`
  field updates the cursor (src: event-pipeline.ts:558-574).
- Reconnect loop: after a failure, `notifyDisconnected(reason)` fires once per cycle; retry delay:
  - base `DEFAULT_RECONNECT_DELAY_MS = 250` on success-less first attempt;
  - `computeRetryDelay(failures)` = `min(cap, 250ms * 2^(failures-1))`, `cap = 5_000ms` when visible
    and online, `60_000ms` when hidden or offline (`RETRY_BACKOFF_MAX_EXPONENT = 8`);
  - permanent 4xx (`400..` except `408`, `429`) use the long cap immediately (stuck-path/bad-auth
    does not benefit from hammering at 5s);
  - `waitForRetry(ms)` resolves early on window `online`, on `visibilitychange` → visible, or abort.
  Interrupt listeners: `onOffline`/`onOnline` abort the current attempt (guarded by `disconnected`),
  `pageshow` (bfcache restore), and `openchamber:system-resume` (src: event-pipeline.ts:36-44,
  388-437, 891-932).

Constant table (src: event-pipeline.ts:24-44, 49-63):

| Constant | Value | Meaning |
|---|---|---|
| `FLUSH_FRAME_MS` | 33 | per-directory flush frame |
| `BACKPRESSURE_FLUSH_FRAME_MS` | 200 | flush frame during backpressure |
| `BACKPRESSURE_MODE_MS` | 10_000 | backpressure window after a backpressure frame |
| `STREAM_YIELD_MS` | 8 | event-loop yield cadence under burst |
| `DEFAULT_RECONNECT_DELAY_MS` | 250 | first retry delay |
| `DEFAULT_HEARTBEAT_TIMEOUT_MS` | 30_000 | dead-stream detection |
| `WS_FALLBACK_WINDOW_MS` | 60_000 | prefer-SSE window after WS trouble |
| `DEFAULT_WS_READY_TIMEOUT_MS` | 2_000 | WS ready-frame timeout |
| `RETRY_BACKOFF_BASE_MS` | 250 | backoff base |
| `RETRY_BACKOFF_CAP_VISIBLE_MS` | 5_000 | backoff cap (visible tab, online) |
| `RETRY_BACKOFF_CAP_HIDDEN_OR_OFFLINE_MS` | 60_000 | backoff cap (hidden/offline) |
| `RETRY_BACKOFF_MAX_EXPONENT` | 8 | backoff exponent clamp |

### D.2 Coalescing rules (pipeline-level, order-safe)

Only four coalescing keys exist (src: event-pipeline.ts:285-302):

| Key | Merge behavior |
|---|---|
| `session.status:<sessionID>` | later replaces earlier in-queue (same array slot) |
| `session.updated:<sessionID>` | later replaces earlier |
| `lsp.updated` | single key |
| `message.part.delta:<messageID>:<partID>:<field>` | **deltas concatenate** (`prev.delta + inc.delta`) preserving order |

Barriers and invalidations (order-critical):

1. A full `message.part.updated` snapshot for a part **deletes that part's pending delta coalescing
   keys** so the delta arriving after the snapshot queues fresh (a snapshot would otherwise
   overwrite its queued predecessor AND a later delta merged into it) (src: event-pipeline.ts:467-490).
2. `session.idle` / `session.error` / `session.created` / `session.deleted` delete the
   `session.status:<id>` key (a terminal/structural event must not be swallowed by a queued status).
   `session.created/deleted` additionally delete `session.updated:<id>` (src: 492-513).

### D.3 Directory routing index (which store receives an event)

Maintained per provider (`EventRoutingIndex`: `sessionDirectoryById`, `messageSessionById`,
`sessionMessageIdsById`), ingested on bootstrap and after actionable events; updated by events
(`updateRoutingIndexFromEvent`) (src: sync-context.tsx:870-1356).

`resolveDirectoryFromRoutingIndex(rawDirectory, payload)` precedence:

1. Normalized explicit directory — if a child store there ALREADY holds the session (state or
   message or status bucket), index + use it.
2. Indexed directory for the session — if that store still exists, use it.
3. Scan all child stores for the session (also self-heals the index). Covers unindexed sessions and
   wrong-directory events.
4. Active-directory fallback — only when the event's session equals the active session AND the
   active directory store exists (the "route only what is being viewed" rule for stale indexes).
5. For message-addressed payloads: normalized directory if it holds the message's parts;
   indexed session for the message ID; store scan by part bucket; active-directory fallback for
   orphaned part events (a missing `message.updated` during reconnect gaps) so they can trigger
   materialization instead of dying as global events.
6. Single-store fallback: no directory + only one child store exists → that store.
7. Else: normalized directory (usually `"global"`).

### D.4 Ordering fixes enforced by the reducer

- **Chronology**: never ID-sorted; `insertMessageChronologically` is a binary insert by
  `(time.created, id)`. `message.updated` for an existing message whose incoming message changes its
  chronology position removes it and inserts at the right slot (src: event-reducer.ts:354-384,
  message-ordering.ts).
- **Terminal tool preservation** (`shouldPreserveExistingPart`): an existing tool part in a final
  status (`completed|error|aborted|failed|timeout|cancelled`) or carrying a time `end` is never
  overwritten by an incoming non-terminal or end-less part (stale refresh shielding) (src:
  event-reducer.ts:79-97).
- **Snapshot-after-delta dedupe** (`getUpdatedDeltaFields`): if the incoming full part's
  `text`/`output` is a prefix/relation of the live one, next clones carry
  `__dedupeNextDeltaFields = ["text"|"output"]`, and each delta for a deduped field is appended via
  `appendNonOverlappingDelta` (longest suffix-overlap scan) rather than blind concatenation, and the
  flag clears after the first application (src: event-reducer.ts:24-58, 480-517).
- **Optimistic part replacement in place**: when a server part with a NEW id arrives and the bucket
  contains an optimistic (`sessionID`-less) part of the same type (`text`/`file`), the server part
  REPLACES it at its index (not push-to-end) — otherwise text and file echoes of a just-sent message
  would reorder and remount the subtree. The scan runs only on new-id arrivals (src:
  event-reducer.ts:434-451).
- **No-op suppression**: equal `session_status` (incl. retry fields), JSON-equal `todo`, unchanged
  `session` (freshness guard `shouldSkipStaleSessionEvent`: incoming recency < current recency),
  `areMessageUpdateFieldsEqual` (role, `finish`, `time.completed`, and the field list
  `summary|error|cost|tokens|structured|model|tools|format|variant|agent|system`) all return
  `changed = false` so references survive (src: event-reducer.ts:99-147).
- **Session list trim**: over `limit`, drop oldest-by-ID from the front but never a session holding
  pending permissions (src: event-reducer.ts:597-611).

### D.5 Reconnect & recovery sequence

```
disconnect → notifyDisconnected(reason) [once per cycle]
          → useConfigStore: isConnected=false, connectionPhase = hasEverConnected ? "reconnecting" : "connecting"
reconnect (markConnected) → isConnected=true, hasEverConnected=true, phase="connected"
          → messageQueueStore.resync() (queue recovery is INDEPENDENT of boot debounce)
          → if (!replayReset && firstConnect && !disconnectedBeforeFirstConnect) stop
          → if (!replayReset && isRecentBoot()) stop
          → resyncAfterStreamGap("stream-reconnect") for EVERY child directory
transport switch (WS→SSE) → same as reconnect without replayReset nuances:
          resyncAfterStreamGap("transport-switch")
```
(src: sync-context.tsx:2511-2597)

`triggerDirectoryResync(directory, reason)` — deduped per directory (`resyncingDirectoriesRef`),
records `lastFullResyncAt`, stale-guards `runtimeKey | sdk identity | child-store identity`
(src: sync-context.tsx:2297-2316):

`resyncDirectoryAfterReconnect(directory, …)` numbered:

1. Candidates = `getReconnectCandidateIds(state, viewedSession)`:
   - any session whose stored status is not `"idle"`;
   - any session whose message bucket ends with an assistant message lacking `time.completed`;
   - any session not renderable (missing part buckets);
   - plus every `parentID` referenced in the session list;
   - plus the viewed session IF it is in directory = active directory and known to the store.
   Zero candidates → nothing.
2. Authoritative status resync: `resyncDirectorySessionStatuses(directory, candidates,
   "authoritative")` — `/session/status?directory=` snapshot replaces entries for these candidates;
   absence/idle lowers the entry AND sets the explicit idle marker (`sessionStatusReady = true`
   gate is NOT needed here — authoritative mode sets it), feeds the global index
   (`applyGlobalSessionStatusSnapshot` with `knownSessionIds = candidateSessionIds`), then runs
   `applyInterruptedTurnReconciliation` per candidate (interrupted-turn finalize, §D.7).
   `null` (fetch failed) preserves state — a failed snapshot is never empty success (src:
   sync-context.tsx:689-775).
3. Per candidate, `Promise.all`: scoped `session.get` (with `retry`) + imperative loader
   `refreshTail({directory}, RECONNECT_MESSAGE_LIMIT = 30)`; stale-guarded commit of the session
   record (upsert w/ `sessionTotal` adjustments) and routing-index re-ingest;
   `recoverInterruptedTurnAfterMessageLoad` after each.
4. `resyncBlockingRequestsForDirectory(directory, candidates)` — re-fetches pending questions and
   permissions (`listPendingQuestions`/`listPendingPermissions` cu directory filter), merges by
   session with the signature guard, shows toasts only for not-viewed sessions and unseen ids (VS
   Code: auto-accept reconciling flatten, §E.5).
5. Re-ingest directory state into the routing index.

Reconnect-cache invalidations: loader tail refreshes replace the transcript TAIL (30 records) via
loader `refreshTail` (queued behind in-flight loads, §E.1); nothing else is wholesale-dropped at
reconnect — the directories themselves only invalidate on archive/delete/move/runtime switch
(§F.6).

### D.6 Watchdog, delayed poll, and stale-stream resync

Watchdog (`setInterval(ACTIVE_SESSION_WATCHDOG_INTERVAL_MS = 5_000)`, src: sync-context.tsx
2600-2735), per initialized directory:

1. Candidates as in §D.5(1). Zero → clear per-directory poll timestamps, skip.
2. Status poll at most every `ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS = 5_000ms`, via the shared
   one-in-flight-per-directory guard `statusPollingDirectories` and the background-network gate:
   **monotonic** snapshot (confirm/raise only; NEVER lowers status) — a blind 5s poll must not
   clobber live state. Escalation: if any candidate's snapshot is idle/absent while the store still
   believes it active (`needsSnapshotAfterStatusPoll`) → `triggerDirectoryResync(dir,
   "stale-status-resync")` (authoritative resync is the recovery path).
3. Stale-stream detection: `shouldTriggerStaleResync(lastStreamActivityAt, lastFullResyncAt, now,
   20_000, 15_000)` — `lastStreamActivityAt` counts EVERY delivery incl. heartbeats (a quiet-but-
   connected session is not stale); 0 (no traffic yet) disables the check. A stale signal fires
   `pipeline.reconnect("active_stream_stale")` AND `triggerDirectoryResync` (cooldown
   `ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS = 15_000`).
4. Child-session discovery at most every `CHILD_SESSION_DISCOVERY_INTERVAL_MS = 15_000`: paged
   `roots: false` list (`pageSize: 200` — a single 200-record page once truncated the list), append
   unknown children whose `parentID` ∈ candidates, then parent materialization for each discovered
   subtree (`child-session-discovered`).
5. All network calls under the shared background-network gate so the browser's per-origin pool keeps
   sockets for interactive traffic.

`maybePollStatusAfterMessageCompletion(directory, store, sessionID)`: on `message.updated` for an
assistant message carrying `time.completed` while store still busy, schedule ONE deferred check per
`directory\u0000session`, `MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS = 750ms`; at fire time, if still
busy and no poll in flight, run the monotonic poll; if `needsSnapshotAfterStatusPoll` → escalate to
authoritative resync. A normal turn whose `session.idle` lands inside the 750ms window issues no
request. Narrows the stuck-spinner window to one round-trip; the 5s watchdog is the backstop
(src: sync-context.tsx:777-847; tests `message-completion-status-poll.test.ts`).

### D.7 Interrupted-turn reconciliation (missed finalization while gone)

Managed-harness processes can die mid-turn leaving a persisted unfinished turn (trailing assistant
message without `time.completed`, tools `pending`/`running` forever). Rules (src:
sync-context.tsx:2060-2223):

- Interrupted finalize fires ONLY on an **explicit authoritative settle** — `session.idle`/`
  session.error` event, or an authoritative snapshot record — never from absent status ("unknown"
  is never judged), never while busy (question/permission waits keep busy).
- Guard `interruptedTurnToolParts(state, sessionID)`: no pending question or permission for the
  session; trailing assistant message exists and has NO `time.completed`; then complete it locally
  with `error: { name: "MessageAbortedError", message: "aborted" }` and
  `time.completed = now`, and finalize active tool parts
  (`state.status = "error", error = "Interrupted", time.end = now`) in the same batch.
- A later terminal event supersedes the mark; a stale refresh cannot regress a locally finalized
  message or part (materialization merge preserves terminal parts; `materializeSessionSnapshots`
  also reconciles a locally-finalized aborted assistant message with an incoming completed one).
- `recoverInterruptedTurnAfterMessageLoad` (router: 09/destination covered) re-checks after a
  hydration: if trailing turn unfinished and no question/permission, and no stored status, fetch an
  authoritative snapshot (fills unknown status only — never overwrites a live event that arrived
  mid-flight), then reconcile. A failed status fetch leaves unknown.
- Completed-message tool cleanup on data arrival: during materialization, a `pending/running` tool
  under a message with `time.completed` finalizes to `error`/"Interrupted" with end time (stale
  persisted tool state during reload) (src: materialization.ts:101-124).

### D.8 Materialization scheduler (incomplete-snapshot recovery)

Reasons (sealed union, src: event-reducer.ts:160-182): `missing-owning-message`, `orphan-delta`,
`missing-delta-part`, `empty-assistant-message`, `child-session-idle`, `child-session-discovered`,
`ensure-session-messages`, `stream-reconnect`, `transport-switch`, `stale-status-resync`,
`settled-running-tool`.

`enqueueSessionMaterialization(directory, sessionID, request)` (src: sync-context.tsx:354-492):

- Key = `JSON:stringify([runtimeKey, directory, sessionID])`; cooldown
  `SESSION_MATERIALIZATION_COOLDOWN_MS = 5_000` per key INCLUDING after fast success/failure.
  Exception: a `settled-running-tool` request may supersede a different pending reason in that
  window (so an earlier pre-settlement refresh cannot consume the only terminal recovery signal).
- Runs after the current ordered batch (`Promise.resolve().then(run)`); pre-flight
  `isSessionMaterializationStillNeeded(state, sessionID, request)` re-checks local state — patch:
  `empty-assistant-message` → skipped when part bucket for the message now EXISTS (an explicit []
  counts — fetched-empty is authoritative); `missing-owning-message` → skipped when the message is
  present; `orphan-delta`/`missing-delta-part` → skipped when the part exists;
  `settled-running-tool` → skipped when the message is no longer the stale-running-tool one.
- HTTP is `loader.refreshTail(directory, SESSION_MATERIALIZATION_MESSAGE_LIMIT = 30)`; if the
  tail is error → rethrow (no publish). If the session's status was, pre-refresh, non-idle →
  authoritative status resync for the session. Then `recoverInterruptedTurnAfterMessageLoad`.
- Stale guards: `childStores.children.get(directory) !== store || pending.get(k) !== pending ||
  getRuntimeKey() !== runtimeKey || opencodeClient.getSdkClient() !== sdk` — recovery responses
  after a runtime/SDK switch, request invalidation, or directory disposal publish nothing.
- Cooldown marker retained until expiry; an older completion cannot clear a newer request marker.

Trigger points:
- reducer results typed as `materialization` (missing owning message / orphan delta / missing delta
  part) (src: event-reducer.ts:400-517 → sync-context.tsx:1998-2014);
- `message.updated` for an assistant message with no part bucket (`empty-assistant-message`);
- `session.idle`/`session.error` when the trailing running-tool message id matches
  (`settled-running-tool` via `getStaleRunningToolMessageID`);
- child went idle and the parent task tool reflects it (`child-session-idle`);
- discovery found new children (`child-session-discovered`); navigation (`ensure-session-messages`);
  and `session-actions` blocking-request not-found recovery (§E.4).

## E. Optimistic model

### E.1 SessionMessageLoader (single authority for transcript HTTP)

`SessionMessageLoader` (one per runtime/provider; ref-stable; deactivated only via deferred
`setTimeout(0)` disposal so React Strict Mode's setup→cleanup→setup keeps a usable loader) is the
shared authority. Every caller (navigation, reactive chat loading, sidebar prefetch, pagination,
reconnect/recovery, optimistic reconciliation) delegates — no parallel initial requests
(src: sync/DOCUMENTATION.md "Session message loading"; session-message-loader.ts).

Entry key: `` `${runtimeKey}\n${directory}\n${sessionID}` ``. Load state:

```
SessionMessageLoadState = {
  status: "idle" | "loading" | "ready" | "error"
  loadingKind: "initial" | "older" | "refresh" | "prefetch" | null
  error: Error | null
  resolved: boolean
  limit: number
  cursor: string | undefined      // from HTTP header x-next-cursor; complete = !cursor
  complete: boolean
  generation: number              // bumped by every invalidation
  updatedAt: number | undefined
}
```

Page sizes (src: session-message-loader.ts:20-25): initial `50` (desktop) / `30` (VS Code/mobile);
older-page `100`; initial expansion limits `[100, 150]` desktop / `[50, 80, 120]` constrained.

API surface:

- `ensure(target, {force?, reason?})` — if materialization says the transcript is renderable,
  publish ready without HTTP; if a request is in flight attach to it (a foreground demand upgrades a
  `prefetch` load kind to `initial` without restarting); `force` bumps generation then loads.
  One in-flight request shared by ALL callers (rule 2).
- `prefetch(target)` → `ensure(..., reason: "prefetch")`; resolves only the first renderable page.
- `loadOlder(target)` — cursor-based older page (`before`), merge mode `"prepend"` (existing part
  buckets are not overwritten; optimistic records merged in; reference-preserving for unchanged
  records).
- `loadComplete(target)` — loops `loadOlder` until `complete`, with a visited-cursor guard against
  non-progressing pagination (throws "no progress").
- `refreshTail(target, limit)` — small-window tail refresh; its cursor describes only that window so
  it must NOT replace the established coverage cursor/complete. While an older load is in flight,
  the refresh is QUEUED and runs after it (queuedRefresh + `queuedRefreshLimit` max), so newer
  authority demand is never lost.
- `optimisticAdd(input)` / `optimisticRemove(input)` / `optimisticConfirm(input)` — insert the
  optimistic (non-authoritative) message+parts into store AND a per-entry `optimistic`
  `Map<messageID, OptimisticItem>`; a page fetch merges them
  (`mergeOptimisticPage`) and drops confirmed IDs when the server's parts already cover them.
- `invalidateSession(target)` — bump generation, clear optimistic, reset state, clear prefetch cache
  entries. Called for archive/delete/move/eviction.
- `invalidateDirectory(directory)` — same for the whole directory (on directory disposal) plus
  prefetch-cache clearing.
- `dispose()` — bump sdkEpoch, clear all entries + runtime prefetch.
- `initializeCreatedSession(target)` — post-create: if no transcript arrived yet, claim an EMPTY
  transcript optimistically (`message[sessionID] = []`, `complete`), supersede an earlier unresolved
  history load, preserve anything that did arrive, and mark ready — opening the session then needs
  no history read (src: session-message-loader.ts:179-201).
- `configure({sdk, runtimeKey})` on runtime (re)configuration: sdkEpoch bump, all inflight generation
  killed, entries cleared entirely when the runtime key changed (with runtime-scoped prefetch
  cleanup).

`isCurrent()` = `!disposed && sdkEpoch unchanged && entry.generation unchanged && same child-store
instance`. Commit authority = runtime + directory + sessionID + SDK epoch + loader generation
(src: sync/DOCUMENTATION.md rule 4).

HTTP page shape: `sdk.session.messages({ sessionID, directory, limit, before }) → { info: Message,
parts: Part[] }[]` (02); cursor from response header `x-next-cursor`; `complete = !cursor`. Records
are chronologically sorted (`sortMessagesChronologically`), sanitized (`stripMessageDiffSnapshots`),
parts filtered to identified parts.

Initial-load underfill expansion (src: session-message-loader.ts:543-589): the first page is
*committed deferrally* when `!complete && no user message in page` — expansion pages [100,150] (or
constrained [50,80,120]) are fetched until a user message appears / complete / last limit, and only
the last accepted page is committed. This avoids painting a headless assistant fragment.

Fetch failure must preserve prior materialized records and expose retry — status `"error"`, never
authoritative empty success (rule 3). Message/part materialization preserves references for
unchanged records and keeps a direct message→parts lookup (rule 6).

Prefetch pagination metadata cache (`session-prefetch-cache.ts`): plain `Map<runtime\ndir\nsession,
{limit, cursor, complete, at}>`, `MAX_PREFETCH_ENTRIES = 200` LRU (recency via delete+set), runtime-
scoped clearing on loader runtime reconfiguration/disposal/directory eviction/session eviction. The
underside: `prefetch` metadata seeds a NEW loader entry immediately (ready without fetch).

### E.2 Optimistic send (`optimisticSend`, src: session-actions.ts:1702-1952)

Numbered sequence:

1. Guard: attached `runtimeKey` still active else throw ("Message was not sent because the runtime
   changed.").
2. `waitForConnectionOrThrow()`: while disconnected, wait up to `CONNECTION_GRACE_MS = 2_000ms`,
   probing connection health (500ms timeouts, 100ms loop); throw "Connection lost…" afterwards
   (transient reconnects must not produce hard failures) (src: session-actions.ts:414-433).
3. `beforeOptisticInsert?.()` (composer context lifecycle hooks), re-assert runtime,
   `appendSubmissions?.()` (input history).
4. Resolve target directory (the resolved session directory — §F.2) and the directory store.
5. **Revert-branch commit**: if `session.revert.messageID` exists, FIRST remove the reverted tail
   and marker optimistically: sessions array gets `revert: undefined`; messages truncated to
   `messagesBefore(messages, revertMessageID)`; reverted parts deleted; each removed reverted
   message confirmed in the loader shadow too (so the next tail refresh cannot merge deleted
   messages back). Both are restored exactly on failure (src: sync/DOCUMENTATION.md rule 4).
6. Generate the optimistic IDs: `ascendingId("msg"|"prt")` — `BigInt(now) * 0x1000 + per-ms
   counter`, serialized to 6 big-endian hex bytes plus 14 random base62 chars. Identity only; the
   6-byte prefix rolls over (§A.6).
7. Build `optimisticMessage` (role user, `time.created = now, completed = 0`, model/agent fields)
   and `optimisticParts` (text part + one file part per attachment, ids `prt_...`).
8. `optimisticAdd(...)` into store + loader shadow; hook `onOptimisticInsert`.
9. Set `session_status[sessionID] = { type: "busy" }` in the store (UI shows working instantly).
10. `await input.send(messageID)` — the server is given the SAME message id.
11. On success: nothing more — the server echo + events reconcile; loader `optimisticConfirm`
    will be part of page merges.
12. On failure:
    a. `getErrorStatus` / `isAmbiguousSendFailure(error)` (§E.3).
    b. Ambiguous → confirmation refetch (§E.4): recent `session.messages` (`limit = 30`,
       `SEND_CONFIRMATION_REFETCH_LIMIT`) with bounded reconnect wait
       (`SEND_CONFIRMATION_RECONNECT_TIMEOUT_MS = 3000`, poll `100ms`) and up to
       `SEND_CONFIRMATION_REFETCH_ATTEMPTS = 3` attempts at `250ms * 2^(n-1)`. If the message id
       appears → `materializeConfirmedSendRecords` (replace the optimistic record with the server
       records through `materializeSessionSnapshots`), `optimisticConfirm`, and RESOLVE quietly —
       the send stays. Rolling it back would let the queue re-send a prompt the engine is already
       running, producing two independent AI responses (src: sync/DOCUMENTATION.md rule 8).
    c. Not found or not ambiguous → `recordSendFailure` (diagnostics buffer) + `optimisticRemove`
       + restore the pre-send revert branch if there was one + reset `session_status` to idle +
       rethrow.

### E.3 Send-failure taxonomy (src: send-failure-classification.ts; relay tagging in 03)

`isAmbiguousSendFailure(error)` is authoritative-first: if the transport that lost the request
explicitly tagged it (`markAmbiguousTransportFailure` — the relay tunnel tags every stream that dies
with a request in flight), it is ambiguous. Fallbacks otherwise:

- `status ∈ {503, 504, 408}`; `TypeError` (fetch network failure);
- `DOMException` named `AbortError` or `TimeoutError`;
- message contains: `timeout`, `timed out`, `failed to fetch`, `networkerror`, `network error`,
  `gateway timeout`, `econnreset`, `socket hang up`.

Non-ambiguous definite rejections (4xx with response) roll back. Relay-tunnel wording that matches
none of the patterns ("stream aborted by host", "relay keepalive timeout") must be tagged by the
transport, not string-matched here.

Diagnostics buffer (`send-failure-log.ts`): in-memory, `MAX_RECORDED_SEND_FAILURES = 20`, reason
truncated to 200 chars, fields `{at, sessionId, messageId, directory, status, ambiguous,
confirmationChecked, reason}`; surfaced by the status report (Ctrl/Cmd+Shift+L) — never persisted.

### E.4 Blocking-request replies (permissions & questions)

Reply routing MUST use the **session record's own server-confirmed directory** (ownership), never
the containing store key (containment): `resolveDirectoryForBlockingRequest(type, sessionId,
requestId)` searches every child store's request buckets for the request, then resolves ownership
from the session record (`directory` then `project.worktree`), falling back to store key only when
the record carries no directory; nested fallbacks via `getDirectoryForSession` then store scan
(src: session-actions.ts:681-738; sync/DOCUMENTATION.md §"Blocking-request reply routing" — a reply
addressed to the parent instance answers `QuestionNotFoundError` and the question stays pending in
the worktree instance forever).

Question reply/reject success removes the request deterministically (authoritative; the later SSE
event is a no-op because the reducer removes only when present). `QuestionNotFoundError` /
`PermissionNotFoundError` (404 or message match) → remove locally AND enqueue the
`settled-running-tool` tail materialization so the trailing tool part converges instead of leaving
the UI on "asking" forever (src: session-actions.ts:2095-2163, `recoverStaleBlockingRequest`).

Send-path supersede: `dismissOpenPermissionsForSession` / `dismissOpenQuestionsForSession` walk the
session's SUBTREE (see `computeSubtreeIds` — one `childrenByParent` map, BFS from root; ids ≤ root)
across all stores, remove every open request optimistically (prompt disappears pre-round-trip), then
reject each in parallel through the canonical reply path; failures swallowed (an open permission
must never block the send). Note: reject unblocks but does not settle the turn — callers that
dispatch a new send immediately must abort/queue so the runner reaches idle before the runner's
`ensureRunning` window (src: session-actions.ts:2048-2333).

Permission reply (`respondToPermission`) additionally honors a captured `directoryOverride` and the
connection-grace wait. `respondToQuestion` normalizes answers to
`string[][]` (empty → `[]`).

### E.5 Permission auto-accept policy

- Policy authority is the server (web/desktop/mobile) or the VS Code extension host; the UI store
  (`permissionStore`) keeps an authoritative snapshot with a **monotonic revision**
  (`applySnapshot` rejects lower revisions and completions captured before a runtime reset;
  persisted UI policy is NOT live authority; v2 store retains an old unscoped map only as a
  migration candidate, then removes it after successful migration) (src:
  stores/DOCUMENTATION.md; permissionStore.ts).
- Server event path: `openchamber:permission-auto-accept.updated { sessions, revision }` →
  `applySnapshot`.
- `hydrate()` reads `/api/permission-auto-accept`, migrates legacy per-session entries (PUT each)
  when the snapshot is empty, then applies if the session's lineage resolution
  (`isSessionAutoAccepting`: walk `autoAccept` membership over `getAllSyncSessionMap` parent chain)
  says this session accepts.
- New-session draft auto-accept: `sessionUIStore` draft flag applies `setSessionAutoAccept(id,
  true)` right after creation (src: session-ui-store.ts:947-953, 2144-2148).
- **VS Code-specific runtime** (`vscode-permission-auto-accept.ts`): the extension host broadcasts
  policy; the foreground UI resolves unknown lineage through the OpenCode API before deciding to
  suppress-and-answer a live `permission.asked`. Behavior:
  - live `permission.asked` → `processVSCodePermissionAutoAccept(permission, directory)` with
    `verifyPending: false` (do not block on a permission-state preflight);
  - walk the policy up the parent chain (policy hit → `true`; fetched session failure → closed);
  - reply via `respondToPermission(id, req, "once", directory)` with retry delays
    `[0, 250, 1000]ms`; recentOutcomes cache `5s` prevents echo-processing storms; per-request
    in-flight dedupe (`inFlight`) and reconcile dedupe (`reconcileInFlight` keyed by directory);
  - enabling the policy reconciles pending requests: process visible cards first (no preflight),
    then `permission.list`-derived ones (also WITHOUT preflight — `permission.list` is served by
    the V1 pending map while the state preflight reads the separate V2 map, so a preflight
    "resolved" verdict cannot prove a listed request settled; #3259);
  - reconnect/bootstrap reconciles pending requests in the session directory the same way,
    including child-inherited requests (sync-context resync arms it);
  - unknown lineage and exhausted reply retries **fail closed** (leave manual); later
    `permission.replied` invalidates the deferred ask token so an async check cannot resurrect it;
  - with every webview closed/suspended no responder runs — intentional VS Code limitation.
  (src: vscode-permission-auto-accept.ts; sync/DOCUMENTATION.md §"Live cross-directory
  session/status view" paragraph.)

### E.6 Permission / question toast lifecycle

- Keys: `${sessionID}:${requestID}`; toast ids `permission-<key>` / `question-<key>`.
- Shown only when the session is NOT currently viewed (`isViewedInCurrentSession` requires the
  active directory+session match AND `document.hasFocus()`; externally-viewed sessions keep a
  `15_000ms` TTL map `EXTERNAL_VIEW_TTL_MS`) and not already pending
  (`pendingPermissionToastIds`/`pendingQuestionToastIds` dedupe sets) (src: permission-toast.ts,
  sync-context.tsx:494-640).
- `permission.replied` / reconciles: `toast.dismiss(id)` + pending-key delete. Same for questions.
- Message of record: permission toast description = `permission.permission` string else
  "Agent needs your approval"; action "Open session" → open the session (toast opener set by
  `session-ui-store`.

### E.7 Question recovery (cold-start race)

Signals: the mounted chat turn contains a `question` tool part with state `pending|running` while
the session's pending-question record is missing
(`hasActiveQuestionToolInCurrentTurn` — only inspects the CURRENT turn: walk backwards, stop at a
user message). Recovery: `resyncBlockingRequestsForDirectory([sessionID], {includePermissions:
false})` scoped to that session, retried **at most 3 times with delays `[0, 500, 1500]ms`**
(`RECOVERY_DELAYS_MS`), cancelled on chat unmount/session change, every attempt runtime-guarded.
No extra requests on ordinary session opens; no scanning of unrelated sessions/directories (src:
question-recovery.ts, sync/DOCUMENTATION.md).

---

## F. Session lifecycle state machine

### F.1 Creation

`createSession(title, directoryOverride, parentID, metadata)` (src: session-actions.ts:888-934):

1. Capture `runtimeKey`.
2. `effectiveDirectory = directoryOverride ?? activeDirectory`; call harness `createSession`
   (03 owns the server behavior; it may canonicalize worktree paths).
3. Stale-runtime check (`getRuntimeKey() !== runtimeKey` → `null`).
4. `sessionDirectory = response.directory ?? effectiveDirectory` — "the directory returned by the
   server is authoritative over the requested draft directory" (rule 6).
5. Pre-populate the routing index (`registerSessionDirectory`) so SSE events arriving before
   `session.created` route correctly; also insert the record into the owning child store if empty
   there (event may have published newer metadata — do not overwrite).
6. `initializeCreatedSession` (§E.1) — empty transcript authority + superseding pending load.
7. `setCurrentSession(id, sessionDirectory, "submitted-draft")` and
   `markSessionAsOpenChamberCreated`; global store `upsertSession`.

Draft lifecycle (src: session-ui-store.ts): `newSessionDraft` state machine with
`openNewSessionDraft` (target resolution: `"chat"` vs `"project"`; VS Code forces project, and
managed chats are excluded defensively), `prepareChatDraftDirectory()` (one deduplicated
directory preparation per `draftId` under the managed root `~/.config/openchamber/chats` as
`YYYY-MM-DD/session-<id>`; materialization consumes it before `createSession`; unclaimed dirs are
deleted on close/target change/runtime-change; create failure deletes the consumed directory),
`closeNewSessionDraft` (no-op guard for default-drafts), `setNewSessionDraftTarget` (persists
`oc.chatInput.lastDraftTarget` pseudo-record `{projectId, directory, target: "chat"|"project"|null}`).
Regular new-chat drafts that inherit a persisted current/last directory confirmed MISSING (deleted
worktree) fall back to the active project — the fallback is used for creation but never persisted
until creation succeeds; a concurrent draft rewrite to the same fallback must not abort creation
(§ resolveCreatableDraftDirectory, src: session-ui-store.ts:707-791; sync/DOCUMENTATION.md rule 7).

`materializeOpenDraftSession` installs selection state (model/agent/variant records), session
knowledge preparts, and the input-history append hook, then routes the message
(`routeMessage`: shell → `shellSession`; `/command` → `sendCommand` via `optimisticSend` when the
only additional part is session knowledge, else prompt route with synthetic parts incl. skill
invocation; else `sendMessage` via `optimisticSend`) (src: session-ui-store.ts:134-268, 858-961).

### F.2 Directory resolution precedence ("which directory does this session belong to")

`resolveSessionDirectoryFromSources(sources)` (src: session-directory-resolution.ts) — authority
ordered, not convenience:

| Rank | Source | Meaning |
|---|---|---|
| 1 | `authoritative` | the session record's own `directory` (then `project.worktree`), then a child store that holds it. Holding = containment, not ownership. |
| 2 | `selected` | server-confirmed directory captured at selection; a guessed one is NEVER passed (guessed selections are tracked via `guessedSelectionSessionId` and excluded) |
| 3 | `attachment` | worktree attachment recorded by this client — the *requested* path before canonicalization |
| 4 | `worktree-metadata` | worktree captured when the session was created in one — also the *requested* path |
| 5 | `remembered` | per-runtime directory persisted across restarts (last active session record) |

Rules: (1) "not indexed yet" ≠ "no directory" — `getSyncSessionDirectory()` is the
containment fallback only for a recordless session and may return the parent repo for a worktree
session; (2) attachment metadata is a hint, never a correction of a confirmed directory; (3)
never persist or rank a guessed directory (`selectSession` may fall back to the active directory
for routing but nothing is written to runtime memory / last-active snapshot / `selected`);
(4) components must use `getDirectoryForSession()` rather than reading
`currentSessionDirectory`; (5) disagreement logs once per session (bounded set of 200 conflict
keys) and `__opencodeDebug.diagnoseSessionDirectory()` reports all sources (src:
session-ui-store.ts:458-626, 2150-2168).

`adoptAuthoritativeSessionDirectory()` promotes a GUESS only (target session must equal
`guessedSelectionSessionId` AND be current), after a directory bootstrap completes (src:
session-ui-store.ts:2212-2230). Runtime memory (`runtimeSessionMemory`) per runtime key keeps
`sessionId, directory, draft, worktreeMetadata, availableWorktreesByProject`;
`prepareForRuntimeSwitch`/`restoreForRuntimeSwitch` swap them in place (src: session-ui-store.ts:
1121-1170).

### F.3 Selection (`setCurrentSession`, src: session-ui-store.ts:1005-1114)

Numbered:

1. Publish `materializedDraftSessionId` transition identity BEFORE closing the draft (two separate
   store updates — ChatContainer must never observe a closed draft with the previous identity).
2. Close the draft if opening a real session.
3. Update per-runtime active-session memory.
4. Resolve the session directory with sources (guessed vs known).
5. **Fetch start precedes the store publication** (`fetchMessagesForSession`) — the request is on
   the wire while React renders (source of the 400ms keep-old-timeline behavior in 05).
6. `set({currentSessionId, currentSessionDirectory})` together (send/SSE hooks must read the same
   child store that events will update during startup races).
7. Track `guessedSelectionSessionId` when nothing but the fallback was known.
8. Write runtime memory + `persistLastActiveSession` (keeps last NON-null session per runtime;
   draft open intentionally does not erase it — user-initiated draft open DOES clear it; automatic
   boot-fallback opens don't; src: session-ui-store.ts:1177-1186).
9. Activate dependent stores: directory store `setDirectory` (if different), project store
   active-id-only, display single-project id, harness client directory focus.
10. Previous session's viewport anchor saved in a `queueMicrotask` (bails if the user already
    switched again) to beat the restore effect.
11. `markSessionViewed(id)` + `setActiveSession(directory, id)`.

### F.4 Archive / restore / delete (runtime-guarded)

All three actions capture `expectedRuntimeKey` at start (or accept it from callers whose
confirmation may span a switch) and recheck before EVERY store reconciliation
(`isStaleRuntime`). Session IDs are not unique across runtimes (§A.6) — a stale deletion could
erase unrelated user state on the new runtime (src: sync/DOCUMENTATION.md §"Deletion runtime guard").

- **Archive** (`archiveSession`): cleanup review/btw partner metadata first (best-effort),
  `updateSession(id, { time: { archived: Date.now() } }, directory)`; on confirmed data: remove
  from live child stores (one `setState` per store with `sessionMutationPatch(deleted=true)`),
  invalidate loader for every touched directory, `useGlobalSessionsStore.upsertSession(archived)`
  (moves it to the archived bucket), clear current session if it was open.
- **Archive batch** (`archiveSessions`): plan per-directory server batches; sessions needing
  partner-link cleanup (review/btw) or unknown to this client go individually. Echoes are
  registered (`registerBulkArchiveEchoes`) so that stale `session.updated` archive echoes with the
  same `archivedAt` are CONSUMED rather than double-processed (TTL 30s, cleaned on runtime switch).
  Server batch unavailable → fallback to individual archives. Partial results preserved:
  `{archivedIds, failedIds}` (src: session-actions.ts:1390-1529; bulk-archive-echo.ts).
- **Restore** (`unarchiveSession`): OpenCode cannot clear `time.archived` to NULL over HTTP —
  restore writes the sentinel `UNARCHIVED_TIMESTAMP = 0`; ALL readers classify by truthiness so
  `0` reads active. Server `time_archived IS NULL` list filter still excludes such rows, so
  truthful lists must fetch inclusive (`archived: true`) and split client-side
  (`splitGlobalSessionsByArchived`). Server failure keeps the session archived locally; never moves
  the session (src: session-actions.ts:1546-1615; sync/DOCUMENTATION.md §"Restore (unarchive)
  contract").
- **Delete** (`deleteSession`): pre-clean partner metadata; server `deleteSession`; server
  cascade semantics mean 404 on a child means "already deleted by cascade" — commit. Commit path
  (`finalizeConfirmedSessionDeletion`): remove from live stores, invalidate loader, global store
  remove, clear current session, clear worktree metadata,
  `cleanupPersistedSessionState({runtimeKey: CAPTURED key, directory, sessionId})`. A 404 after a
  runtime change reports failure (the 404 describes the previous runtime) (src:
  session-actions.ts:1229-1326). Managed chat directory removal: deleted only if it is the root
  session's directory AND no other known session resolves to it AND the global list is loaded (a
  leaked scratch directory is recoverable, a stranded session is not) (§F.1 golden rule).
- **Move** (`moveSessionToDirectory`): runtime-guarded control-plane move; invalidate loader for
  BOTH source and destination; update the child store of each (or the owning one), global store
  upsert (directory index maintenance), routing index re-register, UI session directory set.
  Archive/restore/move never move sessions between directories on their own (missing worktree
  groups stay visible; manual movement explicit) (src: sync/DOCUMENTATION.md §"Missing worktree
  directories").

### F.5 Directory eviction

`ChildStoreManager.runEviction` (coalesced into ONE pass per tick via `queueMicrotask`; `unpin` runs
it synchronously as an explicit lifecycle edge) calls `pickDirectoriesToEvict` (src: eviction.ts):

1. Candidates = all store directories − pinned − directories with pending blocking requests
   (`hasPendingBlockingRequests`: any non-empty `question` or `permission` bucket — a directory
   holding an unanswered question/permission must NEVER be evicted, else the SSE-routed request
   data is lost).
2. Sort by `lastAccessAt` ascending.
3. Overflow = `max(0, stores.length − MAX_DIR_STORES=30)`. Evict while overflow remains OR the
   entry has been idle ≥ `DIR_IDLE_TTL_MS = 20min`.
4. **Grace**: a directory touched within `EVICTION_GRACE_MS = 30s` is never a victim — sidebar rows
   may `ensureChild` during render before their pin effect commits; evicting them recreates + re-
   bootstraps in an endless loop (#1472). The limit is a soft target: brief overflow beats thrash.
5. `canDisposeDirectory` re-check at dispose time: has store, not pinned, not booting (queued/
   running/isBooting), not loading sessions, no pending blocking requests. `disposeDirectory`
   deletes lifecycle, queue, demands, states, failures, bootstrap runs; calls
   `onDispose` → `messageLoader.invalidateDirectory(directory)`, clears per-directory poll
   timestamps.
6. Eviction-thrash test (eviction-thrash.test.ts) asserts: expanding a project with more worktrees
   than 30 never produces a recreate loop; grace holds during the burst; idle TTL eventually
   bounds the cache.

### F.6 Session-cache eviction (message maps; use-sync.ts "touch")

- A module-level LRU of *seen session sets* per directory: `MAX_SEEN_DIRS = 30` entries keyed
  `runtime\n directory`, each map a `Set<sessionID>`.
- Each `useSync.syncSession`/`loadMore`/`prefetch` calls `touch(sessionID, directory)`: promotes
  seen; `getProtectedSessionCacheIds` marks protected sessions (non-idle status, pending
  permission/question bucket, unfinished trailing assistant message) — those are never evicted; the
  rest are evicted LRU oldest-first down to the effective limit: `SESSION_CACHE_LIMIT = 40`
  desktop, `4` VS Code/mobile.
- Evict = `dropSessionCaches(draft)` (messages, parts-by-message + parts-by-session, todo, diff,
  status, permission, question for those ids), drop cached message-records snapshots, loader
  invalidate per session, clear prefetch cache.
- Constrained runtimes additionally evict prefetched (non-visible) sessions outright and any
  inactive session whose message cache exceeds the initial page size (heavy cache).
- Directory-wide eviction of message data is separate (`dropSessionCaches` handles it from
  `cleanupSessionCaches` after archive/delete) — one failed entity must never erase unrelated
  entities; eviction is per-session-id only.

### F.7 Retention / auto cleanup (src: session-retention.ts)

Settings (`useUIStore`): `autoDeleteEnabled` (default `false`), `autoDeleteAfterDays` (default
`30`), `sessionRetentionAction: "archive" | "delete"` (default `"archive"`),
`sessionRetentionOnlyArchived` (default false; forces Delete and measures from `time.archived`;
Archive disabled in Settings while on), `autoDeleteLastRunAt`. Cadence
`RETENTION_INTERVAL_MS = 24h` while the app is open; manual runs bypass the cooldown and the
enabled checkbox. Shared run lock (`useSessionRetentionRunStore.isRunning`, acquired before
loading).

Candidate selection (`buildSessionRetentionCandidates`):

1. Scope: sessions whose archive state matches (`time.archived` truthy == `onlyArchived`).
   Retention timestamp: `time.archived` (only-archived mode) else `time.updated || created`.
2. Protection set: the `RETENTION_KEEP_RECENT = 5` most recent in scope; the selected session;
   sessions with a share url; sessions with observed live activity
   (`useGlobalSessionStatusStore.activeSessionIds`); parents with an attached `/btw` fork; sessions
   older than cutoff; sessions outside the scope entirely.
3. Ancestors cascade: since OpenCode deletion cascade-deletes the subtree, every ancestor of a
   retained session is protected (delete; and only-archived-archive mode).
4. Ordering: children-first topological order by remaining-children count; cyclic/malformed
   hierarchies never become leaves and cannot be deleted.

Execution (`runSessionRetentionCleanup`): fresh complete global snapshot ref required
(`useGlobalSessionsStore.loadSessions()`), refuses `status !== "ready"` (error/fallback state never
drives cleanup); runtime switch stops the batch and prevents the cooldown write into the new
runtime; per candidate recheck (scope, share, btw, selected, active, age); before a delete, any
child still present (planned+archived snapshot children) skips the parent (a failed child blocks
its ancestors while unrelated sessions continue); cleanup uses the CANONICAL archive/delete actions
(incl. confirmed 404 delete and runtime guards); `failed` reasons surfaced separately
(`skippedReason: disabled|loading|cooldown|no-candidates|running|runtime-changed`).

### F.8 Folders, pins, tabs, todos, worktrees (binding sidecars)

- `useSessionFoldersStore`: folders per runtime-scoped v2 browser keys
  (`oc.sessions.folders` runtime-suffixed + STORAGE_INDEX_KEY index, legacy claimed once); syncs
  with a server file too, with revision rules (§G.5); `removeSessionEverywhere(runtime, sessionId)`
  on delete; create-time folder assignment via draft `targetFolderId`.
- Pins (`useSessionPinnedStore`): `nnd.sessions.pinned.v1`, keys
  `JSON:[runtimeKey, normalizedDir, sessionId]`, touchedAt map, NO silent age/count
  eviction, never pruned from the first startup list; clear on delete.
- Tabs (`useSessionTabsStore`): `session-tabs-store`, `tabIds` order-only, `MAX_SESSION_TABS = 10`
  soft cap (oldest leaves, never the session being opened); ids whose session is unknown are kept.
- Todos (`useTodosPersistStore`): `openchamber-session-todos` v2, key
  `JSON.stringify([runtimeKey, normalizePath(directory), sessionId])`, `MAX_SESSIONS = 50` LRU by
  touchedAt, ambiguous legacy entries discarded (migrate resets).
- Worktree binding (`session-worktree-store` + contract): `SessionWorktreeAttachment`
  `{worktreeRoot, cwd, branch, headState: branch|detached|unborn, worktreeStatus:
  pending|ready|missing|invalid|not-a-repo, worktreeSource, legacy, degraded, attentionReason}`.
  `resolveSessionWorktreeState` derives it from (sessionDirectory, metadata, cwdExists,
  runtimeResolution). UI copy paths (`formatSessionWorktreeBadge`) and mutation blockers are in
  05; the store and resolution contract belong here.

### F.9 Multi-Run (cross-ref 12)

`useMultiRunStore.createMultiRun` validates groups (name, ≥1 group, prompt per group, ≥1 model),
resolves the active project, creates one session per group×model (isolated worktrees when the
project is a git repo — branch/worktree naming `<groupSlug>/<modelSlug>[/<index>]`, per-run
`waitForWorktreeBootstrap` when configured), registers each session via
`registerCreatedSession` (routing index pre-registration + global upsert + child-store insert),
then fans out `routeMessage` per run in a detached async block. Failure semantics: warnings per
run; the dialog reports "failed to create any sessions" only when zero succeeded (src:
useMultiRunStore.ts:100-336). Orchestration semantics → document 12.

---

## G. Persistence design

### G.1 Principles

1. **Persistence is a stale cache, never authority.** Message/part data is ALWAYS loaded from the
   server (persist-cache.ts header); legacy persisted entries may seed startup continuity but are
   "not live truth".
2. **Failure is not empty.** Every reader treats malformed payload as a failed read (start fresh or
   preserve), never authoritative empty.
3. **Runtime scoping.** Shared caches either key by runtimeKey (`oc.dir.v2.<runtime/dir hash>`,
   envelopes with `runtimes: Record<runtimeKey, …>`) or are dropped on switch; `runtimeKey`
   defaults derived from injected globals are not stable early — timing records deliberately use
   ONE key.
4. **Bounded writes with lifecycle flush.** Debounces flush on `pagehide`, `beforeunload`,
   `visibilitychange → hidden`, and `freeze`; pending writes captured before a runtime switch that
   belong to the previous runtime are rejected, not written (src: persist-cache.ts:173-205).
5. **Tombstones.** What a successful authoritative empty state produces must persist as an explicit
   empty (v2 tombstone) so stale legacy data cannot resurrect.

### G.2 Key catalog

| Key (localStorage unless noted) | Owner | Format / version | Bounds | Notes |
|---|---|---|---|---|
| `oc.dir.v2.<head12>.<hash("runtime\0dir")>.{vcs\|projectMeta\|icon\|sessions}` | persist-cache | raw JSON per field (sessions = Session[]) | sessions ≤ `50` (fallbacks [50,25,10,5,1]), write debounce `50ms` | path-head hashing keeps keys short; legacy `oc.dir.<head>.<hash>.*` read-then-removed on write |
| `openchamber:managed-chats` (scope passed through the same v2 key derivation, files named `oc.dir.v2.<head>.<hash>.sessions` with directory `openchamber:managed-chats`) | persist-cache | Session[] | ≤50 | seeds `useGlobalSessionsStore`; VS Code never reads/writes it |
| `oc.lastSession.v1` | last-session-cache | envelope `{version:1, runtimes:{<k>:{sessionId,directory,updatedAt}}}` | 8 runtimes LRU by updatedAt (monotonic tie-break `max(now, maxExisting+1)`) | convenience only; confirm before opening |
| `oc.worktreeMap.v2` | worktree-topology-cache | envelope `{version:2, legacyClaimed, runtimes:{<k>:{updatedAt, entries:[[projectRoot, WorktreeMetadata[]]]}}}` | 8 runtimes | legacy `oc.worktreeMap` claimed once then removed |
| `oc.session-activity.v1` | session-activity-timing | `Record<sessionId, {start, seen}>` | live set only | liveness-stamped on pagehide/visibilitychange/freeze; single key (no runtime scope, see §D rationale) |
| `oc.chatInput.lastDraftTarget` | session-ui-store | `{projectId, directory, target:"chat"\|"project"\|null}` | 1 record | per install; `target` null = no side chosen |
| `openchamber.chatDrafts.v2` | chatDraftPersistence | envelope `{version:2, drafts:{key:{text, confirmedMentions[], touchedAt}}}` | 50 drafts (touchedAt LRU) | key = `JSON:[runtime, dir, sessionId]` |
| `openchamber-input-history.v1` | useInputHistoryStore | envelope `{version:1, entryLimit, scope, global:{}, session:{}}` | 8 global buckets, 50 session buckets, entry limit default 40 (configurable 1..100), quota retries [40,25,10,5,1] exact | keyed `JSON:[runtime]` / `JSON:[runtime, dir, session]` |
| `oc.sessions.pinned.v2` | useSessionPinnedStore | `{version:2, sessions: Record<key, touchedAt>}` | untouched by age/count | never pruned from first startup list |
| `oc.sessions.folders` + `<runtime>` variant + index | useSessionFoldersStore | v2 folders map per runtime; storage index `{version:2, legacyClaimed, runtimes[]}` | — | server-mirrored; revision semantics §G.5 |
| `openchamber-session-todos` v2 | useTodosPersistStore | `{sessions: Record<JSON-triple-key, {todos, touchedAt}>}` | 50 sessions | ambiguous legacy discarded via migrate |
| `session-tabs-store` v1 | useSessionTabsStore | `{tabIds}` | 10 | deferred safe storage |
| `session-display-mode` v5 | useSessionDisplayStore | display prefs | — | migrations v2 manual-order default; v3 recent→manual; v4 drop displayMode; v5 add all/single mode |
| `message-queue-store` v3 | messageQueueStore | `{queuedMessages, quarantinedLegacyMessages, followUpBehavior}` | 50 targets, 20 msgs/target | `partialize` SKIPS entries whose runtime is server-owned; `sendingIds` never persisted; migrate: v<2 legacy → quarantine; text defaulting |
| `permission-store` v2 | permissionStore | `{legacyCandidate, legacyRuntimeKey}` | — | live policy is server-owned; persisted only for migration |
| `lastDirectory`, `homeDirectory` | useDirectoryStore | string | — | last directory restored on boot; home resolution cascade = injected desktop home → stored → process env/cwd (§useDirectoryStore) |
| diagnostics flags `openchamber_session_load_perf`, `openchamber_sync_perf`, `openchamber_stream_perf` | diagnostics | `"1"` | — | opt-in only |

Zustand `persist` stores use a **deferred safe JSON storage adapter** (`createDeferredSafeJSONStorage`)
— per-key quota/access failures create ephemeral overrides/tombstones without disabling unrelated
keys; writes retry the durable backend; malformed Zustand JSON is removed and treated as missing
(src: stores/DOCUMENTATION.md "Shared safe storage"; utils/safeStorage).

### G.3 Message-queue persistence semantics

- Local (VS Code) mode: `queuedMessages` persisted keyed
  `runtime\ndirectory\nsessionID`; `text` defaulted from `content` on migrate (v<2 → quarantine).
- Server-owned mode: on the FIRST hydration of a runtime, leftover local messages of that runtime
  are uploaded once each (serialized, one in-flight at a time; concurrently kept out of
  re-uploads by `legacyMigrations[runtime] = {items, pending}`) then dropped from persistence
  (`partialize` skips server-owned runtime keys) — a stale local copy would resurrect messages
  the server already delivered.
- `sendingIds` never persisted (restart has no in-flight sends); server mode mirrors the server's
  `sendingId`.
- Revisions: `appliedRevisions` per queue key and `snapshotRevisions` per runtime — any snapshot
  older than the last applied revision is ignored; a full snapshot also OWNS sessions it omits
  (`clearSessionProjection` removes every projection of that session in the runtime when the
  session disappears, and broadcast revisions cover omitted sessions so a delayed mutation
  response cannot resurrect a cleared queue). Hydration/resync dedupe: `hydration` promise per
  runtime + `hydrationGeneration` (runtime switch rejects stale completions); snapshot read
  ``AbortSignal.timeout(15_000)`; a recovery edge during its snapshot read earns ONE trailing read
  (`resyncRequested` loop); failures re-read instead of guessing (`refreshSession`); offline keeps
  the optimistic projection (src: messageQueueStore.ts).

### G.4 Worktree topology cache semantics

Read: envelope-validate; unknown runtime → claim legacy file once (entries migrated into the new
runtime slot, legacy key removed). Write: prune to 8 newest-runtime topologies; discovery remains
authoritative in memory when persistence is unavailable. Sub-fast-path: the store-level write
guard serializes the Map and skips identical content (src: worktree-topology-cache.ts,
session-ui-store.ts:2268-2283).

### G.5 Folder store sync rules

Runtime-scoped v2 browser keys; never silently evict older runtime namespaces (runtime switch
flames the pending browser snapshot synchronously before namespace replacement). Server
files: missing/malformed ≠ authoritative empty; disk data replaces browser state only with a real
revision and after no newer local folder mutation; server writes serialized and reject
non-newer revisions (delayed/duplicate writes cannot overwrite current state). File-search cache
keys include runtime+directory and clear on endpoint reset (src: stores/DOCUMENTATION.md).

### G.6 Input history delta reconciliation

Every scope change, limit change, append, and session cleanup **rereads the latest durable
envelope** first (multi-tab correctness). A failed durable write retains bounded before/after
snapshots (`pendingWrite {base, value}`); the next mutation applies the local delta to the latest
durable data (per-bucket entry-set reconciliation by JSON identity + ordering by `submittedAt`),
preserving pending appends and deletions together with unrelated changes from other tabs; a
successful write clears the pending delta (src: useInputHistoryStore.ts:213-260).

### G.7 Chat draft persistence (lib/chatDraftPersistence.ts)

Envelope-cached parse (parse reuse until the storage value changes); composer draft edits use a
trailing durable-write debounce (composer side) with synchronous flush on hidden/freeze/pagehide/
identity switch/unmount; authoritative deletion clears the key and notifies mounted composers so
unmount autosave cannot resurrect deleted text (`subscribeChatDraftDeletion` +
`clearChatDraft(identity, notify=true)`); MAX_DRAFTS 50 by touchedAt.

---

## H. Streaming representation (what document 05 consumes)

### H.1 Streaming store shape

`useStreamingStore = { streamingMessageIds: Map<sessionID, messageID | null>,
messageStreamStates: Map<messageID, { phase: "streaming"|"cooldown"|"completed", startedAt,
lastUpdateAt, completedAt? }> }` (src: streaming.ts). This is a MESSAGE lifecycle, not a turn
lifecycle.

Derivation (`updateStreamingState` full reconciliation / `updateChangedStreamingSessions`
incremental):

1. A trailing assistant message stamped with `time.completed` is never streaming, even when the
   session stays busy for the next step of the turn — the typing indicator and part-update
   suspension must not linger on finished content.
2. Only busy sessions can stream; completion happens when the trailing message `time.completed`
   arrives, a NEWER trailing message appears, or the session leaves `busy`.
3. Incremental path triggers only on `session_status` or `message` slice changes; part-only events
   update the affected message's heartbeat directly (`touchStreamingSession`) and must NOT rescan
   busy sessions.
4. Heartbeat `lastUpdateAt` is throttled to `STREAMING_HEARTBEAT_MS = 1000ms` (1Hz) instead of 60Hz.

### H.2 Part-text pipeline (message parts as consumed by 05)

- The reducer owns the ACTUAL text state: deltas append (with overlap dedupe for
  snapshot-after-delta precedence, §D.4) into `part[messageID][field]` for fields `text`/`output`.
- The UI projects records via `buildSessionMessageRecordsSnapshot` (cached, per store, keyed
  `sessionID\u0000suspendFlag\u0000suspendMessageID`):
  - `visibleMessages = messagesBefore(sourceMessages, session.revert.messageID)` — revert-marker
    hiding is a projection, not deletion (records stay in the store so restore keeps the data);
  - `suspendPartUpdates` mode keeps the previous record's part arrays for the streaming tail so the
    markdown renderer is not re-parsed per delta; structural exemptions bypass suspension:
    single-`bash`-tool bridge messages parented to the synthetic shell marker text
    ("The following tool was executed by the user") and any change in a `task` tool part's session
    identity (so a parent links a newly created subagent immediately);
  - unchanged parts keep record references; only changed records rebuild.
- Assistant-only part changes never rebuild user input history (`buildUserMessageHistorySnapshot`
  skip); messages/removals/removal-of-final-part-bucket/conservative resets always notify.
- The markdown renderer reconciles changed blocks incrementally; text throttling happens ONCE
  upstream (streaming throttle) — no second character-pacing timers (src: sync/DOCUMENTATION.md
  "Loading diagnostics" end).
- A FAILED send rolls back the optimistic text part; a confirmed-but-lost-response send is
  materialized from refetched records (§E.2).

### H.3 Revert/undo/redo representation

- `session.revert = { messageID, partID? }` marker; visible timeline is a projection
  (`messagesBefore`); parts remain materialized (restore dock renders from real records).
- Revert commits the reverted branch's removal BEFORE the next send (optimistic granularity, §E.2
  step 5) and restores on rejection. Descendants cascade first (abort if busy → find first user
  message at-or-after the parent's target timestamp including EQUAL times → server revert), and the
  parent runs LAST so its shared-directory file snapshot stays authoritative; a descendant failure
  is logged and does not block siblings/parent. Redo clears markers on every descendant, including
  markers the user set on a subagent independently (src: session-actions.ts:529-575, 2239-2443;
  sync/DOCUMENTATION.md rules 9-10).
- Unrevert triggers bounded re-fetch: `UNREVERT_REFETCH_ATTEMPTS = 3`, `UNREVERT_REFETCH_RETRY_MS =
  150ms`, success when the message count exceeds the previous count.

---

## I. Performance contracts (stated invariants from the maintained docs + code)

1. **Event flush = one store transaction per touched directory.** Directory mutations accumulate in
   order and publish once per flush; each top-level slice is cloned lazily at most once per batch;
   no-op events change no references (src: sync/DOCUMENTATION.md "the event pipeline delivers …";
   implemented by `DirectoryEventBatch`).
2. **Targeted cloning only** (§B.3) — global re-renders during streaming were the motivating bug
   (1972 → 296 renders). adding an event type requires updating BOTH the reducer case and the clone
   map, and verifying with the stream perf counters if it fires > a few times/sec.
3. **Aggregates subscribe narrowly.** Session aggregation listens to `state.session`;
   busy/retry aggregation to `state.session_status`; `message.part.delta` must never trigger global
   session/status scans (src: sync/DOCUMENTATION.md "Live cross-directory session/status view";
   `subscribeAllSelected` selectors).
4. **Leaf selectors only** (§A.3). `useGitStore((s) => s.directories)`-style container
   subscriptions are banned in feature components.
5. **Store splitting by change frequency.** Streaming-frequency state (viewport memory
   `sessionMemoryState` updates ~60/sec during streaming) must not live with user-action state
   (selections, input). Rules: never grow `session-ui-store` beyond selection/draft/abort; group by
   subscriber set; prefer a new store; cross-store reads use `.getState()` (src:
   sync/DOCUMENTATION.md "Store splitting pattern").
6. **Terminal-tool / stale part rules** — a completed message's tools cannot regress to active
   (materialization + reducer guards, §D.4/D.7); idle-status writes cannot be claimed from absent
   data.
7. **Status snapshots edits are scoped**: monotonic polls never lower status; authoritative
   snapshots set explicit idle; the 750ms completion poll issues no request for a normal turn.
8. **Eviction-thrash guard** (§F.5): grace window + soft cap; one failed entity never erases others
   (per-id eviction everywhere; batch failures preserve partial results).
9. **Bounded persistence volume**: debounced writes (`50ms` sessions cache, `200ms` settings),
   payload caps (50 sessions/dir cache; 50 drafts; 500 notifications; 200 prefetch entries; 40
   message-map entries desktop / 4 constrained; 4 records snapshots × 30 messages constrained), and
   serialized-identity guards (worktree maps, list signature helpers like `sameSessionList`) so
   unchanged data does not rewrite.
10. **Background network gating**: the Active watchdog, git reads, global session pages, and
    command/skill discovery share the background-network gate so idle bursts cannot queue
    interactive traffic (browser ~6 sockets/origin) (src: sync/DOCUMENTATION.md). Global refresh: 45s
    cadence, bounded to 2 inflight directory loads, current directory prioritized
    (useGlobalSessionsStore `DIRECTORY_SESSION_REFRESH_CONCURRENCY = 2` + `PAGE_SIZE = 500`).
11. **Idle CPU quietness**: hidden surfaces do not poll (PR store, git store rules); retention
    polls ride the 45s global poller's lifecycle and not their own timers; the terminal observer
    shares ONE 5s loop per adapter consumers start/stop.
12. **Diagnostics are null-cost while disabled**: counters are fixed numeric slots behind a single
    flag check (`countSyncPerformance`), no IDs/payloads retained (src:
    performance-diagnostics.ts; sync/DOCUMENTATION.md "Loading diagnostics").

Measured-artifact numbers worth preserving as regression targets: MessageList renders during
streaming ~296 (was ~1972); store-split reduced per-update selector evaluations from 68+ to 2-3
subscribers for `useViewportStore`.

---

## J. Build checklist and test expectations

### J.1 Functional checklist (implementation acceptance)

1. Cold start paints the sidebar from persisted session snapshot within one render; no visible
   skeleton flicker for cached directories; stale-while-revalidate replacement without resurrecting
   removed sessions (v2 tombstone).
2. First prompt after cold reload: connect → optimistic message visible instantly with busy
   status; server echo replaces optimistic part in place (no order swap); failure without response
   rolls back with composer intact; failure after dispatch (ambiguous) confirms in place.
3. Stop button works for sessions in any directory (abort carries the SESSION directory), and
   sending while a permission/question is open dismisses subtree-wide requests optimistically.
4. Reload during a running turn resumes the running-time counter from the persisted start (bounded
   by liveness/away/adoption rules) and never resets to zero on a repeated busy event.
5. Session switch: skeleton only after 400ms; warm switches reveal in the same frame (05 owns
   presentation; the loader guarantees `status: ready` publication before paint).
6. Archive/delete of a busy session clears every store and persisted sidecar of the exact triple;
   runtime switch mid-delete does no cleanup.
7. Reconnect: heartbeats/resume produce at most one authoritative resync per directory; results
   are overlay-committed; nothing regresses finalized turns.
8. Overnight retention run deletes candidates oldest-first, children-first, preserving 5, sharing,
   live activity, selected, btw parents, and ancestors.

### J.2 Invariant tests worth replicating (from the repo's test suite; names indicative)

Event pipeline / reducer
- `event-pipeline.test.js` (+ `online`, `permanent-error`, `resume`): 4xx non-retryable uses long
  cap; offline/hidden caps; `online`/visibility interrupts waits; system-resume immediate
  reconnect; heartbeat timeout aborts; WS-capable→SSE fallback sticky; per-directory flush frame;
  coalesced delta concatenation; part.updated clears pending delta coalescing; idle clears
  status coalescing; batch publish once per directory; abort cleanup flushes.
- `event-reducer.test.*`: freshness guard (stale `session.updated` skipped); archive branch
  removal + tombstone revisions; message chronology insert on out-of-order `message.updated`;
  terminal tool part preservation; delta overlap dedupe; immutable part skip; no-op status/
  todo/message equality.
- `message-ordering.test.ts`, `issue-1637-2270`, `issue-2039`, `issue-2404`: ID rollover ordering;
  session directory assignment; queue-related regressions.

Bootstrap / stores
- `bootstrap.test.ts`: phase de-blocking (all-failed aborts; path-without-project aborts; failed
  status doesn't); os-permission classification only via filesystem probe; signature-guarded
  question/permission merge.
- `child-store.test.ts`: scheduler priorities; dedupe/promote; force rerun; stale generation
  publication guard; pinned directories protected; dispose checks (booting/loading/blocking).
- `eviction.test.ts` / `eviction-thrash.test.ts`: grace window beats burst; TTL bounds; pending
  blocking requests block eviction.
- `persist-cache.test.ts`: 50-cap snapshot; fallback ladder on quota; v2 tombstone on empty;
  runtime key mismatches rejected; lifecycle flush.
- `useGlobalSessionsStore*.test.ts`: inclusive `archived:true` fetch and client-side split;
  per-directory independence (failed directory preserves; success reconciles); mutation-revision
  overlay (older response cannot undo newer local authority); runtime switch generation; managed
  chats snapshot hydrate/persist rules; VS Code exclusion.
- `useGlobalSessionsStore-races.test.ts`: inflight coalescing; stale load rejection after runtime
  switch.

Loader / materialization / recovery
- `session-message-loader.test.ts`: inflight shared; prefetch→initial promotion; initial-page
  underfill expansion; cursor/complete maintenance; refreshTail does not clobber coverage cursor;
  queued refresh behind in-flight; generation rejection on configure/invalidate/dispose;
  initializeCreatedSession empty transcript + supersede.
- `materialization.test.ts`: explicit `[]` vs absent parts (fetched-empty is renderable);
  aborted message reconciliation with incoming completed; terminal tool finalization under
  `time.completed`; live part preservation in merge; prepend mode not overwriting existing buckets.
- `reconnect-recovery.test.ts`: candidate enumeration (statuses, unfinished trailing, non-
  renderable, parents, viewed); ancestor recovery merges closed hierarchies; tombstone exclusion.
- `session-status-snapshot.test.ts`, `session-activity-timing.test.ts`: monotonic vs authoritative
  apply; `sessionStatusReady` only on success; timing: persisted-start adoption bounds (90s window,
  15s liveness, 24h age cap, 30s away cap vs `performance.timeOrigin`), settle only via live
  start + covered snapshot or idle/error events; runtime reset clears.
- `interrupted-turn-tools.test.ts`: finalize only on explicit idle; busy/question/permission guards;
  later terminal supersedes; stale refresh cannot regress.
- `message-completion-status-poll.test.ts`: 750ms deferred poll; escalation to authoritative when
  snapshot disagrees with busy store; no request when idle lands in time.
- `session-switch-resync.test.ts`, `sync-context-child-discovery.test.tsx`,
  `sync-context-session-events.test.ts`, `issue-1637-2270`: routing index behavior incl.
  directory-less events; child discovery pagination; batched per-flush publication.
- `session-event-freshness.test.ts`, `live-aggregate.test`, `live-aggregate-performance.test.ts`:
  recency guard; aggregate equality bridges (no reference churn).
- `ordered` send pulse: `optimisticSend` — revert-branch commit/restore; ambiguous-path
  confirmation (reconnect-bound 3s); rollback path with failure log; `session_status` busy reset on
  rollback.
- Question/permission: `scoped-blocking-requests.test.ts` (subtree collectors), `permission-toast
  test.ts` (dedupe keys), `vscode-permission-auto-accept.test.ts` (fail-closed on unknown lineage,
  list-derived processing without preflight, invalidation of deferred ask), `question-recovery
  test.ts` (3 delays, cancellation).
- Retention: `session-retention.test.ts` (5-recent, scope filter, ancestors, children-first,
  failed-child blocks parent, runtime change, cooldown write policy, archived-scope measurement).

### J.3 Harness-port notes (anything OpenCode/SDK-derived)

Replace only these interaction points when re-binding to a different agent harness; everything else
above stays:

| Port | OpenCode contract (02) | Where consumed here |
|---|---|---|
| Global event stream | SDK v2 `client.global.event()` SSE; WS at `/api/global/event/ws` with `ready|event|error|backpressure` frames and optional `replayReset`; `Last-Event-ID` cursor | `event-pipeline.ts` transport layer |
| Event envelope | `{ id?, type, properties }`; types per catalog §B.2 | reducer + handler + index |
| Session status contract | `SessionStatus.set` publishes `session.status` with `busy` **repeated at every step of the agent loop** (a busy event means "still running"); `session.idle`/`session.error` fire once at end; snapshots list only non-idle | status index, timing, watchdog semantics |
| Message/part rows | `session.messages({sessionID, directory, limit, before})` → `{info, parts}[]`; pagination cursor in `x-next-cursor` header | loader |
| Session list | `experimental.session.list` with `archived` meaning "ALSO include archived"; `roots` filter; `time.archived IS NULL` filter exists server-side | global store + bootstrap |
| Archive semantics | `session.update { time: { archived: number } }`; restore requires `0` sentinel (HTTP cannot set NULL) | archive/restore + split helper |
| Deletion semantics | server cascade-deletes descendants → later child deletes answer 404 | delete actions |
| IDs | `msg_`/`prt_` + `<6-byte rolling prefix><base62>`; NOT chronology | ID generator + ordering |
| Turn finalization | no protocol marker for turn start; a managed-process death never finalizes the trailing message (`time.completed` missing) | interrupted-turn reconciliation |
| Blocking requests | `permission.asked/replied`, `question.asked/replied/rejected` + `permission.list {directory}` / `question.list {directory}` / scoped reply routes | child stores + reply routing |
| Directory-scoped status | `/session/status?directory=` snapshot semantics (only active entries; absent = idle for covered directory) | snapshot appliers |
| Filesystem availability | `project.current`, `path.get`, `config.get`, `command.list`, `mcp.status`, `lsp.status`, `vcs.get` | bootstrap phases |
| Runtime auth | WS upgrade needs query-param token (`oc_url_token`) minted BEFORE connect; SSE uses bearer header | pipeline WS attempt |

### J.4 Module map (layer map for lead implementers)

| Module | Owns | Key contract |
|---|---|---|
| `types.ts` | State shapes, constants, INITIAL_STATE | §A.4 |
| `child-store.ts` | store factory, sidecar subscriptions, scheduler, eviction | §A.4, §C.2, §F.5 |
| `bootstrap.ts` | global + directory bootstrap phases | §C |
| `event-pipeline.ts` | transport, cursor, coalescing, flush batching | §D.1-D.2 |
| `event-reducer.ts` | pure event→draft transform, materialization results | §B.2 |
| `sync-context.tsx` | provider, contexts, routing index, handleEvent + batching, reconnect recovery, watchdog, materialization scheduler, interrupted-turn, record snapshots, hooks | §A.3, §D, §E.7 |
| `session-message-loader.ts` | transcript HTTP authority, pagination, optimistic merge | §E.1 |
| `materialization.ts` | snapshot merge, renderability, stale tool detection | §D.8 |
| `optimistic.ts` | optimistic item type, page merge, message merge | §E.2 |
| `message-ordering.ts` | chronological insertion helpers | §A.6 |
| `session-actions.ts` | SDK mutations: create/delete/archive/restore/move/share/revert/fork/send/replies | §E, §F:
| `session-ui-store.ts` | selection, draft machine, worktree metadata (routes through worktree store), runtime memory, send entrypoint | §F.1-F.3 |
| `selection-store.ts` / `input-store.ts` / `viewport-store.ts` | per-session user picks, composer buffers, viewport anchors (streaming-frequency isolation) | §I.5 |
| `session-ordering.ts` / `session-activity-timing.ts` / `global-session-status.ts` | list ordering ranks, turn timers, live status index | §F.10 below |
| `streaming.ts` | streaming lifecycle derivation | §H.1 |
| `notification-store.ts` / `session-error-log.ts` / `send-failure-log.ts` | bounded diagnostics + unread tracking | §B.2, §E.3 |
| `persist-cache.ts` / `last-session-cache.ts` / `worktree-topology-cache.ts` / `runtime-live-memory.ts` | persisted continuity caches | §C.4, §G.2 |
| `session-retention.ts` | retention candidates + batch execution | §F.7 |
| `session-directory-resolution.ts` | directory precedence | §F.2 |
| `message-queue-sync.ts` + `stores/messageQueueStore.ts` | queue projection (03 owns server) | §G.3 |
| `vscode-permission-auto-accept.ts` / `permissionStore.ts` | auto-accept policy runtime | §E.5 |
| `question-recovery.ts` / `scoped-blocking-requests.ts` / `permission-toast.ts` | blocking request semantics | §E.4-E.7 |
| `sanitize.ts` | payload slimming | §A.5 |
| `retry.ts` | transient retry wrapper (3 attempts, 500ms ×2, 10s cap, 5xx/transient detect) | used everywhere |
| `bulk-archive-echo.ts` | archive echo suppression window | §F.4 |
| `send-failure-classification.ts` / `relay/transport-error` (02/03) | ambiguous tag + classification | §E.3 |
| `globalSessions.ts` / `globalSessionStructure.ts` | pagination + inclusive split + incremental structure indexes | §B.2, §F.4 |
| `useGlobalSessionsStore.ts` | global cache mutations/invariants | §B.2, §G |

### F.10 Session ordering & timing (list-visible sidecar module, exact contracts)

**Ordering** (src: session-ordering.ts; global cold array order is NEVER user-visible order):

- Lifecycle rank store: `useSessionOrderingStore = { rankById: Map<id, number> }` published
  separately from sessions; ranks allocated monotonic `nextRank() = max(lastRank+1, Date.now())`.
- A session is promoted EXACTLY when its authoritative phase crosses `settled` (`idle|error` ↔
  `active` (`busy|retry`)) in either direction. Repeated busy/retry or idle/error events are
  no-ops. The first authoritative status snapshot establishes the baseline WITHOUT promotions
  (unknown→phase is not a transition); later snapshots reconcile missed transitions (batch shares
  ONE rank, ties broken by timestamps).
- Removal on `session.deleted`/archive (removeFromIndex + rank cleanup); full reset on runtime
  switch (phases, baselines, lastRank, ranks).
- Baselines: fallback timestamp FROZEN at first participation from
  `time.updated` (`baselineRank`). `raiseSessionOrderingBaselines`
  runs only on AUTHORITATIVE snapshots (never demotes; wells stale live ranks up to fresh
  authoritative `updated` stamps for sessions re-activated on other devices while this client
  slept).
- Comparator (`compareSessionsByLifecycleOrder` / `orderSessionsByLifecycleScopes`): pins do not
  reorder (05 §D.12); lifecycle rank compared ONLY within scope (roots against roots, children only against
  siblings sharing `parentID`); then frozen baseline desc, creation desc, id asc. Hierarchies from
  the global structure indexes drive root/children grouping; remaining unindexed sessions are
  appended after by the same comparator; cycles guarded by visited set.
- Every user-visible list must consume this comparator — sorting by `time.updated` re-introduces
  streaming-frequency churn.
- Sidebar presentation includes pinned IDs beyond its recent-row cap, plus their
  known ancestors, while preserving the comparator's order.

**Timing** (src: session-activity-timing.ts):

- Two maps: `startedAt` (persisted `oc.session-activity.v1` records `{start, seen}`) and
  `settledMs` (memory, `SETTLED_LIMIT = 200`). A busy event NEVER starts a clock (it means "still
  running"); it prefers the persisted start. Only `session.idle`/`error` (live, one-shot) or a
  COVERED snapshot's silence (for sessions with a LIVE start in this page session) settles; the
  persisted record is retired only on live settle. Absent-status/snapshot-without-session is never
  evidence.
- Bounds replacing unobservable evidence: liveness stamp (`seen`) refreshed during active
  observation at most every `LIVENESS_PERSIST_INTERVAL_MS = 15_000ms`, stamped precisely on
  pagehide/visibilitychange/freeze (immediate write, not deferred); restore eligibility requires
  `pageLoadAt - seen ≤ MAX_AWAY_MS = 30_000` measured against this page's `performance.timeOrigin`;
  adoption gate `RESTORE_ADOPTION_WINDOW_MS = 90_000` after page load (records unclaimed past it
  are discarded; table cleared); `MAX_TURN_AGE_MS = 24h` sanity cap; malformed/negative/future
  entries rejected on read.
- These two write paths (event mutations, snapshot reconcile) are the ONLY writers; hooks
  `useSessionActivityStartedAt` / `useSessionSettledDurationMs` / `useHasSessionActivityDuration`
  (existence-only subscription variants) feed rows.
- One storage key, NOT runtime-scoped: records live seconds; runtimeKey is derived from injected
  globals and not stable across early startup; a read under a key the previous page never wrote
  to is indistinguishable from "no turn was running".

---

## Appendix 1 — Sync-state invariants: where each is enforced

| Invariant (root AGENTS.md) | Concrete enforcement sites |
|---|---|
| Authoritative state over heuristics | `sessionListSource` provenance + revision overlays (§C.3); snapshot modes `monotonic` vs `authoritative` (§D.6); directory resolution precedence server-confirmed-first (§F.2); global store inclusive fetch + client split (§F.4); ambiguous transport failures confirmed by refetch, not assumed (§E.2); `rewrite` classification is server-event-typed, not inferred from no-change results (sync-context "materialization driven by typed reducer outcomes") |
| Derive live activity from live channels, not persisted history | Live status index populated only by events + authoritative snapshots; "Live activity/status indicators must not depend on this cache" rule (useGlobalSessionsStore comments; §A.2); turn timers driven by the same two write paths (§F.10) |
| Scoped temporary fallbacks cleared when authoritative state arrives | status runtime-live seed TTL 15s + expiry reset (§C.4); `sessionListSource = "persisted"` until replace; loader optimistic items cleared on page confirm; `guessedSelectionSessionId` promotion then cleared (§F.2); routing-index fallback limited to the viewed session (§D.3); os-permission label reclassified on forced retry |
| Fetch failure must not masquerade as empty success | `unwrap` throws on error/no-data (transient 503) (§C.1); loader `error` status preserves records (§E.1); global store status `"error"` retains snapshot; queue `refreshSession` on failure keeps projection; median `sessionStatusReady` gate keeps omitted-status unknown (§A.4) |
| Partial results explicit, rollback explicit, cleanup explicit, stale-data behavior explicit | batch archive/delete/restore return `{archivedIds, failedIds}` etc. with runtime-change stop (§F.4); optimistic send rolls back the exact pre-send branch including revert markers (§E.2); retention rechecks per candidate; queued refresh merges after in-flight; materialization cooldown markers cannot be cleared by older completions (§D.8) |
| One failed entity must not erase unrelated entities | batch archive/delete/restore collect `failedIds` while committing confirmed ids (§F.4); per-directory global refresh isolation — a failed directory preserves its previous sessions while successful directories reconcile normally (§G.3 store contract); per-session-id eviction only (§F.6); question/permission signature guard deletes only buckets untouched since the pre-read (§C.3 step 6) |
| Directory-scoped caches | every cache keyed `runtime\ndirectory(ession)` (§A.6 table); directory eviction protects blocking requests (§F.5); VS Code/desktop/mobile scope differences intentional and visible (loader page sizes, cache limits) |

---

## Appendix 2 — Store catalog (shape / persistence / instance scope)

| Store | Singleton? | Shape highlights | Persisted? | Scope |
|---|---|---|---|---|
| Directory child store (`State`) | per (runtime, directory) | §A.4 | vcs/projectMeta/icon/sessions (≤50) | one per directory, lazily created, evicted |
| `useGlobalSyncStore` | yes | ready/error/path/projects/config/reload | no | runtime-wide |
| `useGlobalSessionsStore` | yes | active/archived/entityById/structure/sessionsByDirectory/reviewTransfer/revision maps/hasLoaded/managedChatsHydrated/status | managed-chats snapshot only | runtime-wide |
| `useGlobalSessionStatusStore` | yes | statusById Map + activeSessionIds Set | no | runtime-wide; only non-idle entries |
| `useSessionOrderingStore` | yes | rankById Map (+ module phase/baseline maps) | no | runtime-wide (module state reset on switch) |
| `useSessionActivityTimingStore` | yes | startedAt/settledMs Maps | `oc.session-activity.v1` | install-wide (single key by design) |
| `useStreamingStore` | yes | streamingMessageIds/messageStreamStates Maps | no | runtime-wide |
| `useSessionUIStore` | yes | selection/draft/abort/worktree maps/runtime memory | `oc.chatInput.lastDraftTarget` + worktree map via topology cache | app UI state with runtime memory map |
| `useInputStore`, `useSelectionStore`, `useViewportStore` (sync-side) | yes | composer buffers; per-session selections (`selection-store.ts`); viewport anchors keyed runtime\nsession | viewports: no; selections: internal | runtime-scoped where keyed |
| `useMessageQueueStore` | yes | queuedMessages/sendingIds/quarantined/followUpBehavior | yes v3 (partialize) | runtime+directory+session entries; sendingIds ephemeral |
| `usePermissionStore` | yes | autoAccept map + revision state | only migration state | runtime-scoped after v2 |
| `useInputHistoryStore` | yes | global/session buckets + limits + delta buffer | `openchamber-input-history.v1` | runtime+dir+session buckets |
| `useTodosPersistStore` | yes | sessions map | yes v2 (50 cap) | runtime+dir+session |
| `useSessionPinnedStore` | yes | ids set + touchedAt | `oc.sessions.pinned.v2` | runtime+dir+session |
| `useSessionFoldersStore` | yes | folders per runtime (v2 keys) + server file sync | yes | runtime-scoped |
| `useSessionTabsStore` | yes | tabIds (≤10) | yes | device-wide |
| `useSessionDisplayStore` | yes | display prefs v5 | yes | device-wide |
| `useSessionGoalArmStore` | yes | armed flag + objective override (consume-on-read) | no | one-shot, runtime-agnostic |
| `useMultiRunStore` | yes | isLoading/error + create flow | no | action-time state (12 owns semantics) |
| `useDirectoryStore` | yes | currentDirectory/history/home/persisted flags | `lastDirectory`/`homeDirectory` | device-wide; home re-resolved per runtime |
| `useNotificationStore` | yes | list + session/project unseen indexes | no (in-memory; 30d TTL, 500 cap) | runtime-wide |
| `contextStore.ts` (stores/) | yes | project notes/todos/plan links cache keyed by project id; optimistic writes serialized per project | via project routes only | per project |

