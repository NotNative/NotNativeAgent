# OpenCode protocol compatibility

NNA's `nna opencode` service targets the OpenCode **2.x** client contract used
by OpenChamber. NNA implements an independent compatibility surface over its own
session engine. The reported version identifies that protocol target, not an
installed OpenCode runtime. NNA's product version remains separate.

## Why this target

The installed OpenChamber desktop build gates the surface on one rule: the
reported version must be a `2.x` release at or above its
`MINIMUM_OPENCODE_VERSION` of `2.2.4`. A future major is refused outright, so
`3.x` is not an option, and a lower version makes the whole surface unreachable.

The reported version is resolved per serve boot from npm's `@opencode/cli`
`latest` dist-tag and falls back to `2.2.7` when the registry cannot answer;
`src/opencode/version.js` holds the rule and
`test/opencode-v2.test.js` asserts it rather than a literal, so a future bump cannot silently make the surface unreachable.

Reporting the target is not a claim that every 2.x operation is implemented.
Unsupported operations fail explicitly with a tagged error, as recorded under
Boundaries below.

## Reference contracts

Research and contract capture date: 2026-10-02.

- [Official migration guide](https://opencode.ai/v2/docs/migrate-v1)
- [Official API reference](https://opencode.ai/v2/docs/api)
- [Published OpenAPI schema](https://opencode.ai/v2/openapi.json)
- [Official JavaScript client](https://opencode.ai/v2/docs/planning/client), tested with
  the published `@opencode/client@2.2.5` package.
- [OpenChamber v2 announcement](https://openchamber.dev/blog/opencode-v2/).
- The installed OpenChamber desktop build (2.7.0 as of 2026-11-12), whose bundled
  `compatibility.js` defines the accepted version range read above and whose
  `packages/web/server/lib/opencode/` defines the spawn contract below.

The `agustif/opencode-v2` repository is an older third-party fork, not the
reference for this migration. No external agent implementation code was copied.
The JSON fixture under `test/fixtures/opencode/` contains selected public schemas
and their referenced definitions. The upstream documentation can advance beyond
the pinned client; changes require conformance checks before changing the target.

## Changes from the v1 surface

| Contract | v1 | v2 |
| --- | --- | --- |
| Discovery | `/global/health` | `/api/info` with version, PID, URLs and temporary path |
| Session | Flat directory, slug and version | `location`, configured agent/model, usage and outcome |
| Prompt | Text parts; synchronous message or `prompt_async` | `/api/session/:id/prompt`, text and client ID; immediate inbox receipt |
| History | `{info, parts}` records | Typed user and assistant messages; paginated `{data, cursor}` |
| Events | `{payload}` and `sync` mirrors | `/api/event`, native `type`, `data`, location and sequence metadata |
| Stop | `/session/:id/abort` | `/api/session/:id/interrupt` with `{interrupted}` |
| Questions | Question tokens and answer matrices | Session-owned forms with typed fields and answer objects |
| Errors | Bare statuses or `UnknownError` | Tagged JSON errors for supported v2 operations |

Each settled turn is closed by an `idle` record (`Session.Message.Idle`) in
session history. A client walks history newest-first and stops at that marker to
find where the running turn began, so the marker is what makes turn duration and
post-restart adoption correct. A prompt drained by an operator stop also carries
its marker: it settled without running, but it still bounds a turn.

Legacy routes remain available. The separate desktop native integration is not
relabelled as OpenCode v2.

## Supported operations

- Discovery, location, projects, public configuration, and the OpenCode model,
  provider, credential integration and build-agent catalogs.
- Create, list, fetch, rename and delete sessions. Session creation validates the
  requested directory and initializes the engine in that directory. An authenticated
  execution manifest cannot have its workspace scope changed by this API.
- Text prompts, client-supplied session/message IDs, metadata, queued admission,
  pending inbox reads, active-session reads, wait, interrupt and viewed state.
- Paginated session and message reads; individual message reads.
- Native session, inbox, assistant-step, text, completion and form events.
- Pending form recovery, form details, answer and cancel. Forms are bound to their
  owning sessions and settle through the existing authenticated question ingress.
- The command catalog: NNA's commands are exactly its user-invocable skills.
- Empty catalogs for OpenCode-specific plugins, skill listings,
  MCP servers, references, background shells and permission requests. These do not
  expose or configure NNA's own extension catalogs.

Directory-scoped reads accept `location[directory]` or the URI-encoded
`x-opencode-directory` header used by OpenChamber. All routes, including discovery
and streaming, retain the existing configured Basic authentication gate.

The Basic auth username is fixed to `opencode`. OpenChamber builds its upstream
credential as `opencode:<password>` in `auth-state-runtime.js` and explicitly
ignores `OPENCODE_SERVER_USERNAME`, so any other username is an authentication
the client can never satisfy. Only the password is a choice.
The refusal lives at the point a value is chosen (`saveOpenCodeConfig`), not at
load. A document written by an earlier build may already hold a custom username;
refusing it while loading made `status`, `start`, `stop` and the settings page all
fail on a configuration the operator could no longer repair. Such a document
still loads, and saving it again with username `opencode` repairs it. Choosing any
other username fails with `opencode_username_unsupported`.

A session update refuses `permissions` by name. The client sends that field only
when a caller sets it, so a rename or archive still works; accepting a ruleset
would let a caller widen what this surface may do, and permission rules belong to
NNA's reviewer governance. `archived` is a top-level field on the update the
client sends, not a `time.archived` patch — the patch shape is what a stored
record carries, not what a caller writes.

## Boundaries

This is the NNA text-chat compatibility surface, not the entire OpenCode server.
A caller that needs an operation outside this list receives a tagged
`InvalidRequestError`, never a silent success or an empty result that reads as
"nothing happened".

Implemented at the 2.x target: discovery, location, projects, configuration,
the model/provider/integration catalogs, session create/list/get/patch/delete
including archive and restore, text prompts with client IDs and queued
admission, synthetic continuation prompts, inbox reads, wait, interrupt, viewed
state, paginated message reads, native session/inbox/step/text/usage/form
events, `idle` turn markers in history, tool parts with name and lifecycle state,
form settlement, one-shot text generation, and the isolated provider and
credential routes.

Tool parts carry the tool's name and its state, never its arguments or raw
result: a tool's input can contain a secret and its output can contain retrieved
content that must not gain authority. NNA's own protocol tools (such as the
turn-outcome declaration) are not rendered, because OpenCode has no call to show
for them.

A tool part lives on the assistant message beside the text, and a text part
replaces only prior text. The first implementation assigned the whole content
array when the answer arrived, which erased every tool call the moment a turn
finished: a live turn that read a file reported the correct contents and showed
no tool row at all. Only an end-to-end run against a real provider exposed it,
because the engine emitted the correct `tool_status` records and the parts were
published with the correct message id — the loss was one assignment later.

Not implemented, and refused explicitly: attachments, deferred execution,
active-turn steering, agents beyond build, permission mutations, shell
execution, filesystem and VCS APIs, session move,
generated-image and generated-decision routes, tool-call lifecycle events,
`session.diff` (NNA keeps no file snapshots, so it cannot answer truthfully),
OAuth and command-based provider connection, and plugin management. Reviewer
escalation remains fail-closed.

## An unserved route is a bare 404, and the route resolves before the record

A path this surface does not serve — and an operation it does not serve under a
path it does — answers `404` with a **zero-byte body**. A route that exists but
names a record that does not (an unknown session, message or form) answers a
*tagged* 404. Both facts were measured against the reference server.

The distinction is not cosmetic. A client tells "this server has no such route"
from "that record is gone" by the body, and the two lead to different behaviour:
OpenChamber probes `GET /api/experimental/job`, a route added in OpenCode 2.2.6,
and reads `404` without a `_tag` as "unsupported, keep the older reads" while a
tagged `404` reads as a failure. Its goal runtime answers a failed probe by
re-arming its timer and returning, so a tagged refusal left a goal waiting on an
audit that never ran.

The route shape is therefore resolved *before* the session is loaded, which is
what the reference does:

| Request | Answer |
| --- | --- |
| an unserved operation on a session that does not exist | bare `404` |
| an unserved operation on a session that does exist | bare `404` |
| `inbox`/`form`/`permission` on a session that does not exist | tagged `SessionNotFoundError` |
| a message id that session never held | tagged `MessageNotFoundError` |

A tagged 404 is what a client renders as a message, so it stays where a record is
genuinely missing. Answering `404` for an unserved path is also what a missing-route
probe expects; answering it with a typed refusal makes an unsupported optional
feature look like a broken one.

## One-shot text generation, for a client's titles and recaps

`POST /api/experimental/generate/text` takes `{ prompt, model? }` and answers
`{ data: { text } }`. It exists because OpenChamber runs its session titles and
its per-turn recap through it (`server/lib/small-model/index.js`, which calls the
published client's `experimental.generate.text`). Refusing it was not silent:
the host logged `[session-assist] generation failed …` after every turn, so a
conversation never got a name and the "what happened" line above it never
appeared.

This is a nested inference call, not an operator turn: it carries no tools, no
conversation history and no retrieved content, and its output is a string
returned to the caller. It enters no transcript and grants no authority. The key
is read through the surface's own endpoint-bound credential store, so a
GUI-connected key works and a Console key is still never touched; the broker's
audit records the read as `opencode.generate.text` rather than borrowing a turn's
identity.

The request is the smallest thing an OpenAI-compatible endpoint accepts, with
`stream: false` stated explicitly — a host that defaults an omitted `stream` to
true would otherwise answer with a stream this route cannot read. A provider
failure answers a fixed `GenerateUnavailableError` rather than the upstream body,
because a provider's error text can quote the prompt.

`model` is optional because the host's own fallback chain calls this route
without one. A caller that names a model gets exactly that model or a refusal,
never a silent switch: it picked that model for a reason.

## A session's model is durable

A session created through this surface records the model it runs at, including a
chosen thinking level, in the durable index beside its wire identity. A restore
replays it, and a model switch re-writes it.

Why: a real OpenCode keeps `model` on a session across a restart, and a client
renders it beside the title. Without the field, every restored conversation
reopened on whatever route the surface happened to be configured with at that
boot — a model the conversation never ran on, and one the operator never chose
for it. The failure only appears on the *second* boot, and only when the
configuration changed between them, which is why it survived a suite where both
boots shared one config.

A session created without naming a model still persists the effective route,
because that is the model its transcript was produced by. An index entry written
before the field existed still restores, on the configured route — refusing it
would strand every conversation an operator already had.

## Session move: refused, and why the refusal is structural

`POST /api/session/:id/move` answers a tagged `InvalidRequestError` rather than
moving anything. This is the one refusal here that is architectural rather than a
missing wire mapping, and it was checked rather than assumed.

The engine's `changeEngineWorkspace` is complete — it validates the target,
persists a `workspace_changed` record and notifies. But its guard
`assertWorkspaceTransition` refuses three cases: an unavailable tool root, an
authenticated execution manifest or desktop-bound surface, and, decisively, **no
active turn**: "working directory transition requires an active reviewed tool
call". Workspace movement belongs to the `workspace_change` tool, which a reviewed
turn invokes and the reviewer can refuse. It is not an operator API.

OpenChamber calls `session.move` when relocating a session into a new git
worktree — a request that arrives while the session is idle. Satisfying the guard
would mean fabricating an active turn, which would defeat exactly the review the
guard exists to require. So the route refuses, and an operator who needs a session
in another directory creates it there.

Verified live: the route answers a tagged 404 and the engine answers
`workspace_change_unavailable` for the same attempt, so the surface is not hiding
a capability it could have offered.

## Fork

`POST /api/session/:id/fork` creates a child session from a validated parent
prefix and answers the new session record. `before` is the boundary message id
the client admitted; omitting it carries the whole settled timeline over. The
engine resolves a boundary by its own request id, so the same join revert uses
applies here.

Two things a fork needs beyond the engine call. The child is created through the
ordinary session path with `forkIngest` and a `parentID`, so it has the same
engine, registry and wire voice as any session and the client can nest it in the
tree. And because the ingest replays the parent prefix into the engine
*silently* — no events describe those turns — the child's wire history is seeded
from the transcript it inherited. Without that seeding a fork looked like a blank
session whose engine nonetheless held the transcript. The timeline context a fork
is handed also has to carry `title` and `directory`: an absent title produced a
child named `undefined-fork`, and the parent's location was lost.

## Client contracts this surface is written against

These were read from the installed OpenChamber desktop build rather than from the
upstream documentation, because the client's own translation layer — not the raw
OpenCode wire — decides what an operator actually sees. They are recorded here so
a future change does not silently break the GUI.

**The event envelope is flat.** The client's `translateWireEvent(payload)` reads
`payload.type`, `payload.created` and `payload.data`; it does not read a nested
`properties` object. `data.sessionID` and `data.location.directory` are how a
session and its directory are identified on every event. The reader also requires
`payload.id`: an event missing `id` or `type` is **dropped silently**, so a frame
that renders in a test can still vanish in the client. The full translator maps
129 upstream type strings and ends with `default: return []`.

**A short history page silently truncates a transcript.** The client stops
paginating when a page carries fewer records than the `limit` it asked for,
regardless of `cursor.next`; and it **throws**
`Session history pagination made no progress` on an empty page with
`complete: false` or an echoed cursor. A page that returns exactly `limit`
records must therefore supply a distinct `next`, and a final page must not claim
there is more. History reads on the open path send `limit` only — `order` travels
only when there is no cursor.

**`GET /api/session/active` must be an object map.** The client parses
`{"<sessionID>": {"type": "running"}}`; the value's `type` must literally be
`"running"`, and any parse failure makes the call answer `null` and abort the
bootstrap step. It then discards entries whose id is not already in the loaded
session list. NNA's own answer already matches this shape.

**`time.busy` is not part of this contract.** Across all 1,347 client assets the
string does not appear once. A session's busy state comes from the active map
and from `session.execution.started`, and clears only on a terminal event
(`session.idle`, `session.error`, `session.execution.succeeded|failed|
interrupted`). `session.execution.interrupted` with `reason: "shutdown"` emits
**nothing at all**, so it neither starts nor ends a spinner. There is no client
timeout, which is why a started turn with no terminal event is a permanent one.

**A message `type` outside the declared set breaks the whole page.** The reader
switches on ten values (`user`, `assistant`, `synthetic`, `system`, `skill`,
`shell`, `compaction`, `agent-switched`, `model-switched`, `location-switched`,
`idle`) and destructures the result, so an unlisted type throws rather than
rendering an unknown row. An assistant record must carry `model.providerID` and
`model.id`, and its `content[]` may hold only `text`, `reasoning` and `tool`.

**A prose block's identity on the wire is its ordinal, not its part id.** For
text the client builds its own part identity as `` `${assistantMessageID}:text:${ordinal}` ``
and ignores whatever id the surface stored. Two prose blocks emitted with the
same ordinal therefore render as one, and the second overwrites the first: a turn
that writes prose between tool calls collapsed into a single block above every
tool row, which is the pile-up an operator reads as "the transcript order is
broken". The ordinal must be the segment's index within the assistant message,
and `session.text.delta` must name the segment it continues — appending a delta
to the message's first text part puts a later step's streaming prose in the block
the turn opened with. `reasoning` follows the same rule with its own prefix, and
`session.tool.*` shares the tool part id directly.

**The translator is not the only consumer.** It maps 29 event types and ends with
`default: return []`, but two further paths read events the switch ignores: a
delta hub for `session.text.delta` / `session.reasoning.delta` /
`session.tool.input.delta`, and a runtime handler for `session.inbox.delivered`
and `session.patched`. An event missing from the switch is therefore not
necessarily invisible, and an event audit must search the whole bundle for the
type string rather than assuming the switch is the contract.

**Transcripts are rebuilt from step events, not message frames.** The GUI renders
an assistant turn from `session.step.started` / `session.step.ended` plus
`session.text.delta`. The `message.updated` / `message.part.updated` frames this
surface also emits are informational *for text*: dropping them would not stop the
GUI rendering a turn. They are not informational for tools — see below.

**A live tool row comes only from `session.tool.*`.** The client declares
`message.part.updated` in its schema but dispatches no reducer case for it, so a
tool published as a part appears after a reload and never while the turn runs.
The reducer renders tools solely from `session.tool.input.started`,
`session.tool.called`, `session.tool.progress`, `session.tool.success` and
`session.tool.failed`, each joined to its row by `id` plus `assistantMessageID`.
Two reducer rules decide what a server must send: `success` is dropped unless the
row is already `running`, and `failed` is dropped unless it is `streaming` or
`running`. A tool reported only by its terminal status therefore needs the
opening pair first, or it never appears. NNA publishes `input.started`, `called`
and the closing event from each `tool_status` record, carrying a fixed empty input
and an empty success cell: arguments and results stay in the engine, where the
reviewer governs them. The terminal pair is stamped durable `version: 2`, matching
the client's declaration for those two types; everything else rides `version: 1`.

**A settled turn needs an `idle` record in history.** `turn-start.js` walks
`GET /api/session/:id/message` newest-first and stops at an `idle` record to find
where the running turn began. Without one, every turn reads as a single unbroken
turn and turn duration is wrong. This applies to the v2 message list, not only to
the v1 ledger.

**A finished compaction is announced by `session.compaction.ended`.** The client
has no case for NNA's richer `nna.context.compaction` extension, so a compaction
that only emitted the extension never reached the transcript. It is also the only
signal a *manual* compaction has: see the compaction section below.

**A recovering provider is a retry status.** While NNA waits out an outage it is
still busy, and the client shows a bare busy status. `session.retry.scheduled`
is what turns that into an explained wait.

**Basic auth username is fixed.** The client builds `opencode:<password>` and
ignores `OPENCODE_SERVER_USERNAME`; see the authentication note above for where
that is enforced.

## `session.diff` is refused, not approximated

NNA keeps no file snapshots, so a diff panel would report a file state that was
never captured. The refusal is by name rather than an empty answer, and it costs
nothing: the client has no call site for it. Revert's `files` option is refused
for the same reason, while `files: false` is accepted because it asks for
nothing. See the revert section for how revert itself is wired.

## Thinking levels, traced end to end

A model's `variants` are its thinking levels. They cross six layers, and three
defects were found by following them one layer at a time — each visible only
after the previous was fixed, which is why the whole chain is recorded here
together.

1. **Catalog.** `/api/model` reports a model's declared variants as `{ id }`. It
   used to report `[]` for every model regardless of the document, so a level
   never appeared.
2. **Selection.** `session.switchModel` and the `model` on `POST /api/session`
   accept `variant`. Before that, choosing an advertised level answered 400
   `Unsupported field: variant` — the picker existed and every choice failed.
3. **Mapping.** A level's own `settings.reasoningEffort` becomes the manifest's
   `reasoning_effort`. NNA accepts a fixed set of efforts, so a level spelled
   differently — vLLM's `max`, for instance — is refused by name rather than
   failing inside routing as an opaque 500.
4. **Session record.** The level travels on the reference the selection returns,
   so both create and switch keep it. A create that named a level used to drop
   it, leaving the UI showing a level the next prompt did not use.
5. **Route.** The engine's resolved route carries `reasoningEffort`, which is
   where the request builder reads it.
6. **Request.** `providerReasoningControls` emits `reasoning_effort` for a model
   that understands the scale. A Qwen-named model is deliberately left at its
   native default: those hosts expose binary thinking, and promoting an
   unsupported value can turn reasoning fully on.

Verified against a live service, across three consecutive turns:

```
create high  : route=high wire={"reasoning_effort":"high"}
turn 1       : prompt=200 wait=204 | route=high
switch low   : 204 | model={...,"variant":"low"} | route=low
turn 2       : prompt=200 wait=204 | route=low
clear level  : 204 | model={id,providerID} | route=null wire={}
turn 3       : prompt=200 wait=204 | route=null
```

So `spark` and `AGDuo/spark` honour a level; `Qwen/Qwen3.8-Flash-Next` and
`qwen-vllm/Qwen/Qwen3.8-Flash-Next` will not, by design.

## Reviewer forms, and the posture that keeps them quiet

The form surface is complete: `GET` lists a session's pending forms, a form can be
read by id, settled with a decision, or dismissed. Settling publishes
`form.settled`, which is what a client uses to clear its prompt.

**Under this adapter's posture, however, no form is raised.** Sessions are created
with `reviewPosture: 'auto-review'`, so every tool call is approved without
asking. Measured: a turn that read a file went from prompt to `succeeded` with no
`session.form.*` event and no pending form at any poll, and its assistant message
carried a completed tool row.

That is a deliberate choice rather than an oversight, and its consequence should
be stated plainly: **NNA's reviewer governance does not engage for a session
driven from OpenChamber.** The engine still holds the posture and the desktop
surface still reviews, but a GUI session runs tools unattended. An operator who
wants approval prompts should drive the same work from NNA's desktop surface,
where the mode is selectable (`default`, `auto-review`, `unattended`).

The routes stay implemented rather than removed: the posture is a session
property, so a future mode selector has somewhere to land, and the tests exercise
settling directly. A client that never sees a form behaves correctly, because an
empty list is a valid answer.

## Client methods this surface refuses, and why that is safe

The published client exposes more methods than OpenChamber calls. Measuring the
installed bundle's own call sites separates the two:

| Method | Calls in OpenChamber | Refusal is safe because |
| --- | --- | --- |
| `session.context` | 1 | its only caller is the session-title plugin, which wraps the read in `.then(..., () => "")` and titles from the message alone when it fails |
| `session.diff` | 0 | never called |
| `session.environment`, `session.stats`, `session.shell`, `session.generate`, `session.background` | 0 | never called |

`synthetic`, `inbox.list`, `message.get`, `form.*`, `view`, `active` and
`command` are implemented and were re-checked through the published client: the
inbox answer is a plain array, a form list unwraps to the array itself rather
than a `{ data }` wrapper, and the command call answers 204 with an empty body,
which is the success the SDK declares.

## Failure and busy-state behaviour

The error surface was probed deliberately, because a client renders these as
user-facing states rather than logs. Nineteen failure paths answer a tagged JSON
error with a sensible status: unknown session, message and form; no auth and bad
auth; malformed JSON; wrong method; a create naming an unknown model, a
non-build agent, a non-string title or malformed metadata; a bad cursor, limit or
order; and an unknown route. None crashes, and none answers an empty 200.

**Prompts that arrive together take turns.** Every prompt re-binds the provider
selection first, which briefly marks the session as selecting. Two clients firing
in the same tick — two tabs, or the desktop and a phone — used to make the loser
answer `409` "Wait for the session to become idle before changing its model", a
selection it never asked for, contradicting the rule that prompts queue rather
than reject. Concurrent admissions are now serialized. Verified live: three
simultaneous prompts all admit, each gets its own answer, and none is lost.

**Deleting a session races admitted work safely, in either order.** Verified
across three repeats of each ordering:

| Ordering | Result |
| --- | --- |
| delete and prompt in the same tick | delete wins deterministically: the prompt answers `404 SessionNotFoundError`, the session leaves the list |
| prompt admitted, then deleted mid-turn | `200` then `204`; the session is gone and no turn is left dangling |

After three mid-turn deletes in a row the surface still answers `/api/info` and a
fresh session still runs a turn. `shutting_down` is the engine's terminal state,
not a stalled shutdown.

**A refused timeline mutation is a conflict, not a failure.** The engine's guards
raise plain contract codes with no HTTP status, so these once arrived as an opaque
`500 UnknownError`:

| Situation | Answer |
| --- | --- |
| fork or revert while a turn runs | `409` "Wait for the session to become idle…" |
| compact while a turn runs | `409` "Wait for the session to become idle before compacting it" |
| fork a session with no settled turn | `409` "Fork requires a session that has completed at least one turn" |
| fork at a message the session never admitted | `404` `MessageNotFoundError` |
| clear a revert that was never staged | `409` "This session has no revert point to clear" |

Forking a **brand-new** session was the worst case: a fresh session is a
legitimate idle state, and the answer used to be a 500.

**Deleting a session mid-turn is safe, though it looks alarming.** The delete
answers `204`, the registry and v2 state both release the session, and the engine
enters `shutting_down` — which is its *terminal* state, not a stalled shutdown
(`test/opencode-surface.test.js` asserts the same after a surface stop). An
admitted prompt that was already in flight still answers `200` with its user
receipt: admission succeeded before the delete, and the answer describes the
message admission, not a turn that ran against a removed session.

## Revert, and the identifier join it needed

Revert is wired to the engine's journal-backed timeline
(`src/session-revert.js`): `POST /api/session/:id/revert/stage` hides the
turns at or after a boundary message, and `DELETE /api/session/:id/revert` clears
the marker and brings them back. The turns are hidden, never destroyed.

It required one translation. The engine resolves a revert boundary by its own
`request_id` (`oc_prompt_*`), while the client names the message it supplied
(`msg_*`). The wire session now records that join when a prompt is admitted, and
drops it when the same history entry is evicted, so the map cannot outgrow the
ledger. A message id this session never admitted answers
`MessageNotFoundError`, and the response names the id the client sent rather than
the engine's internal one.

Two limits are deliberate:

- Revert requires a durable journal. On an ephemeral session the engine refuses,
  and the surface answers an error rather than claiming to have hidden a turn.
- `files` is refused. NNA keeps no file snapshots, so it cannot revert file
  contents, and a success there would report a file state that was never
  captured. Passing `files: false` is accepted because it asks for nothing.

Staging, clearing and committing each announce on the v2 event stream
(`session.revert.staged` with `{ sessionID, revert: { messageID } }`,
`session.revert.cleared`, and `session.revert.committed` with `{ sessionID, to }`).
The events alone were not enough, and the live run against the installed client
showed why: its sync path reads `revert.messageID` from the **session record**
(`GET /api/session/:id`), looks the boundary message up, and cuts every history
read past that timestamp on each load — so the record must carry the boundary or
a reload un-hid the taken-back turns. The record now serves
`revert: { messageID }` while a boundary exists: a stage sets it, a clear ends
it, and a commit keeps it, because the commit's own event promises the tail
stays hidden. A session that was never reverted carries no field, which is the
same shape an absent boundary had.

Why the events matter more than they look: **there are two event streams.** The
v1 wire bus carries turn cadence to `/global/event`; the client renders from the
v2 stream at `/api/event`, built by `createV2Events`. A timeline mutation raised
only on the v1 bus is invisible to OpenChamber. Anything that happens outside a
turn has to publish on the v2 stream.

## Manual compaction, and the id that joins its three halves

`POST /api/session/:id/compact` compacts on request. The body carries `{ id,
delivery }` and the answer is a full `SessionInbox.Compaction` record, because
the client admits that record into its own transcript and joins it to the
lifecycle events by its id.

Three halves have to agree:

1. `session.compaction.started` with `{ sessionID, reason: "manual", inputID }`
   moves the client's locally admitted bubble into `status: running`.
2. `session.compaction.ended` with the same `inputID` and the summary as `text`
   completes it; `session.compaction.failed` with a `{ type, message }` error
   fails it instead. Only fixed guidance crosses the wire — the exception text
   stays on the server, where it can name a file or a provider.
3. The response record `{ id, sessionID, time.created, type: "compaction",
   payload: {}, delivery }` is what the client admits and then removes from its
   outbox when the call answers.

An omitted `id` is minted, never returned as `undefined`: the client reads the
record's id before any event can join to it. A finished compaction is also kept
in `GET /api/session/:id/message` as a `compaction` record with
`status: completed` — the same standard a model switch meets — so a client that
reloads still sees why the transcript shrank instead of an unexplained gap.

Two things made this worth writing down. The engine's operator compaction is
silent: it appends its snapshot, records telemetry, and publishes nothing on
either stream, so the first version of this route compacted correctly and left
the GUI's bubble spinning at `running` forever. And the answer used to be
`{ data: { id } }`, which is not a `SessionInbox.Compaction` at all. Both were
invisible to a route test that only checked the status code.

## Slash commands are the operator's installed skills

`GET /api/command` is the palette the client renders as its slash-command list, and
the surface it resolves scheduled commands through. `Command.Info` declares exactly
two fields, `name` and an optional `description`, so that is all the listing
carries. NNA's commands are its user-invocable skills, one per skill, listed by id:
no built-in commands are invented for operations this surface does not implement.

Discovery is done once by the surface over the same roots a session engine reads,
with the engine's own registry options, which is what makes a listed command a
runnable one — a hosted run answers from host skills and a local run from the roots,
so palette and engine cannot disagree. Listing from live session engines was the
obvious design and is wrong: the client's scheduled-command resolver calls
`command.list` with a location and no live session at all, which is precisely the
moment a session-derived palette is empty.

`POST /api/session/:id/command` takes `{ name, ...prompt fields }` and answers 204,
the success gold declares. It queues the skill and admits the command's text as the
turn's operator prompt — the same lane the TUI's `/skill` takes — so the workflow
binds to the turn its own text opens. A command with no argument text runs the
workflow against the conversation. `POST /api/experimental/session/:id/skill` takes
`{ id, resume? }`, also 204, and stages without starting a turn; `resume: true`
there would start one, so it is refused and left to the command route. No GUI calls
that route — the SDK declares it.

Three behaviours are load-bearing:

- **Busy refuses.** Skills promote only at turn start, so a command queued while a
  turn runs would bind its workflow to a turn the caller never opened, and a
  `steer` delivery would split its text from its workflow. Both routes answer 409.
- **A refused admission retracts its queueing.** Admission can refuse after the
  skill was queued — a model switch in flight is the reachable case, since
  anything that fills the prompt queue also makes the session busy. A skill left
  pending is promoted by whatever turn runs next, hijacking unrelated work.
- **No body crosses the wire.** A listing exposes name and description only, so it
  cannot disclose workflow text or a source path. A body reaches a model solely
  through the engine's `configured_skill` journaling, as a system message stating
  it grants no tools, secrets, permissions, or scope. Command text is operator
  speech only because the operator typed the command carrying it.

`command.updated` is never emitted: NNA has no runtime skill install or unload —
`nna skills` lists — so the palette cannot go stale, and a client is entitled to
cache it. An engine's registry is immutable after initialization for the same
reason, so a skill added to disk joins sessions opened after that point.

## Verified against a live service

The surface was run as the operator runs it (`nna opencode start`, port 4095,
`~/.nna/config/opencode.json`) and queried with the real credential. That found a
defect no test had: every catalog route answered **400** because the operator's
OpenCode document declares a model `variants` field — a model's thinking levels —
which `normalizeProvider` refused as an unknown key. `/api/model`, `/api/agent`,
`/api/config` and `/api/provider` all failed, so the composer would have had no
models, agents or provider at all, while the whole suite was green.

Verified live after the fix: `/api/info` 200 with the resolved protocol version, and
`/api/model`, `/api/agent`, `/api/config`, `/api/provider`, `/api/project` all 200.
Session creation returns 200 with a `ses_` id.

A prompt then answered 400 with
`Connect an API key for this OpenCode provider in OpenChamber settings before
sending a prompt`. That is the endpoint binding working as designed: the stored
credential was connected at `192.168.20.25:8000` while the provider now points at
`:8015`, so the key is deliberately not sent to a different endpoint. The
operator must reconnect the key. The response carries that guidance in a JSON
envelope — an empty body read earlier was a PowerShell client artifact, not a
missing message.

Two lessons worth keeping: a document written by another tool is the real input,
and only running the service exercises it; and a refused credential must be read
from the response body, because the status alone cannot distinguish "no key" from
"key bound to another endpoint".

A sweep of every read route against the live service then found a second
config-driven defect that status codes hid. Every route answered 200, but the
catalog reported `variants: []` for **every** model — the field was hardcoded —
so a model whose document declares thinking levels showed none and the client's
level picker stayed empty. The catalog now projects a model's declared variants
into the `{ id }` shape its schema uses. The fixed-provider catalog, which has no
provider document behind it, still reports `[]` honestly.

The live v2 event stream was also verified end to end: a create, rename, archive,
restore and delete produced `session.created`, `session.renamed`,
`session.patched` (once per mutation), `session.unarchived` and `session.deleted`.
Every frame carried the flat `{ type, created, data }` envelope with no v1
`payload` or `properties` field, and `session.created` carried exactly
`agent, location, model, projectID, sessionID, slug, title, version`.

Method note: checking status codes alone proved insufficient twice in one round.
Reading the response bodies against the operator's real configuration is what
finds these, and it is faster than reasoning about what the GUI might want.

## Isolated provider configuration

The managed service has its own provider configuration. It does not load or write
NNA's Console manifest, provider profiles, model defaults or secret vault. NNO's
platform routing remains separate. A programmatic caller that supplies a config
or manifest explicitly retains the fixed-provider surface unless it also supplies
an isolated provider settings store.

OpenChamber's custom-provider form writes the OpenCode user configuration locally;
this write is an OpenChamber backend operation, not an upstream OpenCode API.
The adapter reads `opencode.json` then `opencode.jsonc` from
`OPENCODE_CONFIG_DIR`, or `$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode`.
An explicit `OPENCODE_CONFIG` document is loaded last. Configuration files are
bounded to 1 MiB. Changes announce native catalog events within a polling interval
of 500 ms. All requests also read current configuration.

Create a custom provider in OpenChamber with the **OpenAI-compatible** chat
protocol, its base URL, and model IDs. Supported packages are
`aisdk:@ai-sdk/openai-compatible`, `@ai-sdk/openai-compatible`,
`@opencode/ai/providers/openai-compatible` and `@opencode/ai/providers/openai/chat`.
These identifiers select NNA's Chat Completions transport; no SDK package is loaded.
OpenChamber's current [custom-provider contract](https://github.com/openchamber/openchamber/blob/main/packages/web/server/lib/opencode/DOCUMENTATION.md)
uses the `aisdk:` spelling. Select **OpenAI Chat Completions** for an endpoint
that serves `/chat/completions`. **OpenAI Responses** (`aisdk:@ai-sdk/openai`)
uses a different wire protocol and remains unsupported. A rejected profile can be
replaced with a supported chat profile without deleting credentials or changing
the NNA Console configuration.
The existing v1 `provider`/`npm`/`options` spelling is not imported. Recreate those
entries with OpenChamber's v2 form. Other wire protocols, OAuth, command-based
login, model variants, custom headers/body overlays, arbitrary provider packages
and project-scoped provider configuration remain unsupported. Project files never
grant provider routing or secret disclosure authority.

API keys use `/api/integration/:id/connect/key`. Credential rename, activation
and deletion use the v2 credential routes. Keys are stored in a separate encrypted
vault under the NNA data root's `runtime/opencode/secrets`, in the `opencode.local`
realm, with a separate master key and audit ledger. Catalogs return metadata only.
Existing NNA Console keys are not copied or exposed; connect a key in OpenChamber.
Explicit provider environment references use the service process's environment.

`GET /api/credential` provides credential IDs, labels, integration IDs and active
status for OpenChamber's backend source/authentication lookup. The upstream route
exports secret values; NNA deliberately returns an empty `value.key` with
`value.metadata.nna_redacted: true`. Active status requires the saved endpoint
binding to match current provider configuration. OpenChamber's presence check
can complete, but its features that require reading an actual key (such as quota
lookups) cannot use this projection. Integration connection metadata and trusted
NNA model transport continue to use the real credential.

`POST /api/credential` — creating a credential directly, outside an integration
connect — is not routed. Checked rather than assumed: OpenChamber instantiates one
OpenCode credential source at startup
(`configureOpenCodeCredentials(openCodeCredentialSource(...))`), and its own
comment scopes that source to "quota lookups, voice keys and routing", all reads.
The source object does expose a `create` method, but the only `source.create(`
call in the bundle belongs to an unrelated SSH-passphrase store, so the OpenCode
one has no caller. Keys are created where OpenChamber actually creates them,
through `/api/integration/:id/connect/key`, which this surface serves.

Credentials are bound to the endpoint where they were connected. Changing an
endpoint requires connecting a credential for that endpoint. The service rejects
a new prompt with setup guidance when its configured credential is unavailable,
and the guidance names the endpoint that holds a stale key when one exists: a key
connected at another endpoint is otherwise indistinguishable from never
connecting one, and only the operator knows the endpoint moved. Known credential
failures during a turn also receive fixed, safe guidance; raw provider exception
text never becomes a public error message.

Session creation accepts a model from this catalog. `/api/session/:id/model`
switches the model through canonical configuration ingress and emits
`session.model.selected`. Model changes require an idle session. Other sessions
and NNA's persisted routing remain unchanged. The next idle prompt refreshes its
provider and credential binding, including keys connected after session creation.
Provider/model defaults come from this OpenCode document, not NNA's defaults.

The isolated catalog permits 16 providers, 128 models per provider, 128 credential
accounts, and 32 pending settings mutations. The adapter also implements these
OpenChamber settings endpoints; they are not upstream OpenCode endpoints:

- `GET /api/provider/:id/source` returns public form configuration and file-source
  metadata used to show Edit. It reports only loaded user/custom files and no
  project authority. Keys are never included.
- `PUT /api/provider` edits the winning provider file in the named `user` or
  `custom` scope. Custom scope requires an explicitly configured `OPENCODE_CONFIG`
  file. Other settings and credential records are preserved.
- `DELETE /api/provider/:id/auth?scope=user|custom|all` removes profile configuration
  from the named loaded scopes, including shadowed entries and matching defaults.
  It preserves credentials; use credential deletion routes to remove keys.
  `all` includes only the adapter's loaded user/custom files, never project files.
  Repeating a removal is safe. Each file write is atomic; a failure during a
  multi-file removal can leave earlier files changed. Retry the removal to finish.

Unsupported provider protocols remain disabled catalog entries for correction;
session selection and credential connection still reject them. Structurally unsafe
settings are rejected. OpenChamber controls which edit/reset buttons it renders.
Its current Disconnect action removes credentials and retains profile
configuration; implementing a removal route does not add a new UI control.

The wire-session lifetime is durable. Engine journals persist under the
surface's dedicated session store, and a boot-time restore re-opens every
journaled conversation: the session list, its titles, its archive decisions, and
its seeded transcripts survive a restart. Deleting a session in OpenChamber
removes it permanently, including its journal; a deleted session's journal is
tombstoned so session discovery never re-adopts it. The v2 event stream itself
is live-only. Reconnects must fetch session, message, active-session and
pending-form snapshots; an earlier design that listed zero sessions after a
restart was replaced by the durable index, and the historical measurement below
describes that superseded behaviour.

Verified against a live service with a real provider:

- **Concurrent sessions.** Three sessions prompted in parallel each produced
  their own `user, assistant, idle` history with the expected answer, their own
  `session.text.delta` frames, no event naming another session, and an active
  snapshot that drained to `{}` when all turns settled.
- **Reconnect mid-turn.** Dropping the event subscriber while a turn ran did not
  disturb it: the prompt still answered 200, `wait` returned 204, and the
  transcript settled with its idle record. A subscriber attaching mid-turn
  received the remaining frames from the point it connected, and no earlier ones.
  That matches the live-only contract rather than contradicting it — the client
  is expected to fetch the message snapshot, which it can.

V2 admits at most 128 live sessions and 64 event subscribers. Message pagination
accepts 1–500 records. Legacy wire sessions queue at most 64 unfinished prompts
and retain the latest 64 prompts in process-local message history; a settled
prompt does not consume a queue slot. The legacy message endpoint exposes only
that recent in-process history.
Slow event consumers are disconnected rather than accumulating an unbounded queue.

## Spawn contract: OpenChamber runs NNA as its OpenCode

Beyond the detached service, OpenChamber can spawn NNA directly, the way it
spawns its own `opencode.exe`. The contract NNA satisfies:

1. **Version preflight.** `nna --version` answers the resolved protocol version
   (a `2.x` semver at or above `2.2.4`), not the product version, whenever the
   binary is addressed as a spawn target.
2. **Spawn argv.** OpenChamber runs `nna.cmd serve --stdio --hostname H --port P`
   on Windows. Bare `serve` is the foreground runtime; `--stdio` holds stdin as
   a stop lease.
3. **Stdout handshake.** One line `opencode server listening on <url>`.
4. **Stdin lease.** Closing stdin stops the child cleanly, including removing
   its runtime PID record.
5. **Host credential.** A spawned child serves with the password OpenChamber
   generated (`OPENCODE_PASSWORD` or `OPENCODE_SERVER_PASSWORD`), never the
   stored config password, or the host would answer every request with 401.

The switch is `nna opencode enable`: it records the NNA launcher in the host's
spawn environment (`OPENCODE_BINARY`) and clears the attach-mode variables
(`OPENCODE_SKIP_START`, `OPENCODE_HOST`, `OPENCODE_SERVER_PASSWORD`,
`OPENCODE_SERVER_USERNAME`) so the host spawns rather than attaches.
`nna opencode disable` removes the switch. `start`/`stop` continue to exist for
the detached service mode; a spawned child writes no PID record because its
lifetime belongs to the host.

## Verification and activation

Run `node --test test/opencode-v2.test.js` for local schema, lifecycle, invalid-input,
authentication, pagination, question and cancellation checks. The existing v1
OpenCode tests continue to cover legacy behavior and reviewer governance.
`test/opencode-provider-settings.test.js` covers isolated settings, encrypted
credentials, endpoint binding, mutation authentication, session selection and
configuration/admission races. It also exercises setup and switching through
the published client when the client-module environment variable is set.

To additionally test the published client, obtain `@opencode/client@2.2.5` in an
ignored research directory. Set `NNA_OPENCODE_CLIENT_MODULE` to the absolute path
of its `dist/promise/index.js`, then run the same test command. This enables the
official-client discovery, directory-header, event, prompt, history and deletion
test without adding a production dependency or downloading code during tests.

After installing the updated NNA build, restart the surface: in spawn mode,
close and relaunch OpenChamber (it spawns the new binary itself); in detached
mode, run `nna opencode stop` followed by `nna opencode start`, then reconnect
OpenChamber.
Repository tests do not establish that an already-running installed service was
updated, or that every OpenChamber UI feature is supported.
