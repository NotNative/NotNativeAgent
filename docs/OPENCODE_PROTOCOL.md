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

Not implemented, and refused explicitly: attachments, deferred execution,
active-turn steering, agents beyond build, permission mutations, shell
execution, filesystem and VCS APIs, session transfer and fork, session move,
manual compaction, command and generated-text routes, tool-call lifecycle
events, `session.diff` (NNA keeps no file snapshots, so it cannot answer with a
truthful diff), OAuth and command-based provider connection, and plugin
management. Reviewer escalation remains fail-closed.

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
a new prompt with setup guidance when its configured credential is unavailable.
Known credential failures during a turn also receive fixed, safe guidance; raw
provider exception text never becomes a public error message.

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
