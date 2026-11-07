# OpenCode protocol compatibility

NNA's `nna opencode` service targets the OpenCode **2.2.5** client contract used
by OpenChamber. NNA implements an independent compatibility surface over its own
session engine. The reported version identifies that protocol target, not an
installed OpenCode runtime. NNA's product version remains separate.

## Why this target

The installed OpenChamber desktop build gates the surface on one rule: the
reported version must be a `2.x` release at or above its
`MINIMUM_OPENCODE_VERSION` of `2.2.4`. A future major is refused outright, so
`3.x` is not an option, and a lower version makes the whole surface unreachable.
The desktop build pins `@opencode/client` and `@opencode/schema` at `2.2.5`, so
that is the version NNA reports; `2.2.4` is the floor it must never report
below. `src/opencode/version.js` holds both numbers and
`test/opencode-v2.test.js` asserts the rule rather than a literal, so a future
bump cannot silently make the surface unreachable.

Reporting the target is not a claim that every 2.2.5 operation is implemented.
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
- The installed OpenChamber desktop build (2.6.1), whose bundled
  `compatibility.js` defines the accepted version range read above.

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

Each settled turn is closed by an `idle` record (`Session.Message.Idle`) in
session history. A client walks history newest-first and stops at that marker to
find where the running turn began, so the marker is what makes turn duration and
post-restart adoption correct. A prompt drained by an operator stop also carries
its marker: it settled without running, but it still bounds a turn.
| Events | `{payload}` and `sync` mirrors | `/api/event`, native `type`, `data`, location and sequence metadata |
| Stop | `/session/:id/abort` | `/api/session/:id/interrupt` with `{interrupted}` |
| Questions | Question tokens and answer matrices | Session-owned forms with typed fields and answer objects |
| Errors | Bare statuses or `UnknownError` | Tagged JSON errors for supported v2 operations |

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
- Empty catalogs for OpenCode-specific plugins, skills, commands,
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

Implemented at the 2.2.5 target: discovery, location, projects, configuration,
the model/provider/integration catalogs, session create/list/get/patch/delete
including archive and restore, text prompts with client IDs and queued
admission, synthetic continuation prompts, inbox reads, wait, interrupt, viewed
state, paginated message reads, native session/inbox/step/text/usage/form
events, `idle` turn markers in history, tool parts with name and lifecycle state,
form settlement, and the isolated provider and credential routes.

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
execution, filesystem and VCS APIs, session move, manual compaction, command and
generated-text routes, tool-call lifecycle events, `session.diff` (NNA keeps no
file snapshots, so it cannot answer truthfully), OAuth and command-based
provider connection, and plugin management. Reviewer escalation remains
fail-closed.

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
session and its directory are identified on every event.

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
surface also emits are informational; dropping them would not stop the GUI
rendering a turn.

**A settled turn needs an `idle` record in history.** `turn-start.js` walks
`GET /api/session/:id/message` newest-first and stops at an `idle` record to find
where the running turn began. Without one, every turn reads as a single unbroken
turn and turn duration is wrong. This applies to the v2 message list, not only to
the v1 ledger.

**A finished compaction is announced by `session.compaction.ended`.** The client
has no case for NNA's richer `nna.context.compaction` extension, so a compaction
that only emitted the extension never reached the transcript.

**A recovering provider is a retry status.** While NNA waits out an outage it is
still busy, and the client shows a bare busy status. `session.retry.scheduled`
is what turns that into an explained wait.

**Basic auth username is fixed.** The client builds `opencode:<password>` and
ignores `OPENCODE_SERVER_USERNAME`; see the authentication note above for where
that is enforced.

## Known gap: revert is blocked on an identifier mismatch

Revert is the largest remaining gap by use: the client calls
`session.revert.*` fifteen times, more than any other unimplemented method.
NNA already has journal-backed revert in `src/desktop-session-revert.js`, but it
cannot be wired to this surface as written.

`resolveForkBoundary` finds the revert boundary by matching
`item.requestId === messageId` against the engine transcript — the engine's
`request_id`, which this surface generates as `oc_prompt_*`. The client stages a
revert with the session message id (`msg_*`), which is stored here as
`entry.userMessageId`. Nothing joins the two, so the engine revert never finds its
boundary.

Two ways forward, both needing review of their own:

1. Pass a client-supplied message id through as the engine `request_id`, so the
   identifiers coincide. Simplest, but it changes how requests are identified in
   the durable journal.
2. Keep a bounded `msg_*` → `oc_prompt_*` map per wire session and translate at
   the revert boundary. Leaves the journal untouched; the map lives only as long
   as the process, which matches the documented process-local lifetime of the
   wire projections.

For the same reason, `session.diff` is refused rather than approximated: NNA
keeps no file snapshots, so it cannot answer truthfully, and the client never
calls it anyway.

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
| `session.command` | 2 | it needs a command catalog this surface does not have; it is a capability gap, not a contract gap |
| `session.diff` | 0 | never called |
| `session.environment`, `session.stats`, `session.shell`, `session.generate`, `session.background` | 0 | never called |

`synthetic`, `inbox.list`, `message.get`, `form.*`, `view` and `active` are
implemented and were re-checked through the published client: the inbox answer is
a plain array, and a form list unwraps to the array itself rather than a `{ data }`
wrapper.

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
(`src/desktop-session-revert.js`): `POST /api/session/:id/revert/stage` hides the
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
The client sets its session's `revert` field from `staged` and clears it on the
other two, so without these events a revert completed on the server and the GUI
showed nothing.

Why the events matter more than they look: **there are two event streams.** The
v1 wire bus carries turn cadence to `/global/event`; the client renders from the
v2 stream at `/api/event`, built by `createV2Events`. A timeline mutation raised
only on the v1 bus is invisible to OpenChamber. Anything that happens outside a
turn has to publish on the v2 stream.

## Verified against a live service

The surface was run as the operator runs it (`nna opencode start`, port 4095,
`~/.nna/config/opencode.json`) and queried with the real credential. That found a
defect no test had: every catalog route answered **400** because the operator's
OpenCode document declares a model `variants` field — a model's thinking levels —
which `normalizeProvider` refused as an unknown key. `/api/model`, `/api/agent`,
`/api/config` and `/api/provider` all failed, so the composer would have had no
models, agents or provider at all, while the whole suite was green.

Verified live after the fix: `/api/info` 200 with `version: 2.2.5`, and
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

The existing wire-session lifetime is retained: projections and queued inputs are
process-local. Engine journals follow NNA's persistence configuration, but this
adapter does not reopen its session catalog or replay queued prompts after service
restart. Event sequence metadata follows the v2 wire shape; it does not add a
crash-replay guarantee. The v2 event stream is live-only. Reconnects must fetch
session, message, active-session and pending-form snapshots.

Measured across an actual restart on the same data roots: a session that had
`user, assistant, idle` before the stop listed zero sessions afterwards, and its
id answered `404 SessionNotFoundError`. A new session on the same roots then
prompted normally, so the store is healthy and only the catalog is not reopened.

This is a deliberate boundary, not a hidden absence: NNA itself can rehydrate a
transcript (`restoreSessionRecords` feeds the engine's own restore path), and
`SessionDataManager` lists stored sessions for the console. Reopening them here
would be a feature with its own questions — which sessions a GUI should adopt,
and what an adopted session's wire history contains — so it is left out rather
than half-built. An operator who needs earlier work creates a session and reuses
the transcripts NNA already keeps.

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

After installing the updated NNA build, restart the compatibility service with
`nna opencode stop` followed by `nna opencode start`, then reconnect OpenChamber.
Repository tests do not establish that an already-running installed service was
updated, or that every OpenChamber UI feature is supported.
