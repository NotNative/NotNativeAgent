# OpenCode protocol compatibility

NNA's `nna opencode` service targets the OpenCode **2.0.21** client contract used
by OpenChamber. NNA implements an independent compatibility surface over its own
session engine. The reported version identifies that protocol target, not an
installed OpenCode runtime. NNA's product version remains separate.

## Reference contracts

Research and contract capture date: 2026-10-02.

- [Official migration guide](https://opencode.ai/v2/docs/migrate-v1)
- [Official API reference](https://opencode.ai/v2/docs/api)
- [Published OpenAPI schema](https://opencode.ai/v2/openapi.json)
- [Official JavaScript client](https://opencode.ai/v2/docs/build/client), tested with
  the published `@opencode/client@2.0.21` package.
- [OpenChamber v2 announcement](https://openchamber.dev/blog/opencode-v2/), which
  specifies OpenCode 2.0.15 or newer.

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

Legacy routes remain available. The separate NND native integration is not
relabelled as OpenCode v2.

## Supported operations

- Discovery, location, projects, public configuration, and the configured model,
  provider and build agent.
- Create, list, fetch, rename and delete sessions. Session creation validates the
  requested directory and initializes the engine in that directory. An authenticated
  execution manifest cannot have its workspace scope changed by this API.
- Text prompts, client-supplied session/message IDs, metadata, queued admission,
  pending inbox reads, active-session reads, wait, interrupt and viewed state.
- Paginated session and message reads; individual message reads.
- Native session, inbox, assistant-step, text, completion and form events.
- Pending form recovery, form details, answer and cancel. Forms are bound to their
  owning sessions and settle through the existing authenticated question ingress.
- Empty catalogs for OpenCode-specific plugins, integrations, skills, commands,
  MCP servers, references, background shells and permission requests. These do not
  expose or configure NNA's own extension catalogs.

Directory-scoped reads accept `location[directory]` or the URI-encoded
`x-opencode-directory` header used by OpenChamber. All routes, including discovery
and streaming, retain the existing configured Basic authentication gate.

## Boundaries

This is the NNA text-chat compatibility surface, not the entire OpenCode server.
Attachments, deferred execution, active-turn steering, model/agent changes beyond
the configured selection, permission mutations, shell execution, filesystem APIs,
session transfer, compaction and plugin management are not implemented here.
Unsupported actions fail explicitly. Matching configured model/agent selections
are accepted without changing NNA routing. Reviewer escalation remains fail-closed.

The existing wire-session lifetime is retained: projections and queued inputs are
process-local. Engine journals follow NNA's persistence configuration, but this
adapter does not reopen its session catalog or replay queued prompts after service
restart. Event sequence metadata follows the v2 wire shape; it does not add a
crash-replay guarantee. The v2 event stream is live-only. Reconnects must fetch
session, message, active-session and pending-form snapshots.

V2 admits at most 128 live sessions and 64 event subscribers. Message pagination
accepts 1–500 records. Existing wire sessions retain their 64-prompt lifetime bound.
Slow event consumers are disconnected rather than accumulating an unbounded queue.

## Verification and activation

Run `node --test test/opencode-v2.test.js` for local schema, lifecycle, invalid-input,
authentication, pagination, question and cancellation checks. The existing v1
OpenCode tests continue to cover legacy behavior and reviewer governance.

To additionally test the published client, obtain `@opencode/client@2.0.21` in an
ignored research directory. Set `NNA_OPENCODE_CLIENT_MODULE` to the absolute path
of its `dist/promise/index.js`, then run the same test command. This enables the
official-client discovery, directory-header, event, prompt, history and deletion
test without adding a production dependency or downloading code during tests.

After installing the updated NNA build, restart the compatibility service with
`nna opencode stop` followed by `nna opencode start`, then reconnect OpenChamber.
Repository tests do not establish that an already-running installed service was
updated, or that every OpenChamber UI feature is supported.
