# Architecture decision 0004: bounded context and extension adapters

Status: accepted for milestone 4.

Attachments use an append-only fact lifecycle. The runtime copies an operator-selected
image into a managed location, verifies size, declared MIME type, and magic bytes, and
assigns a stable identity before model input. The primary route is attempted first unless
its keyed capability record is conclusively incompatible. Only an explicit image
incompatibility permits vision fallback. Vision receives no tools or authority; its
bounded, attributed observation returns to the primary context as untrusted data.
Capability keys include profile identity, endpoint, effective model, operation, and
configuration version; changing any of them returns capability to unknown/probeable.
Rejected managed copies are removed without touching the source. Temporary failures
remain `pending_failed` until an explicit retry or removal command.
Standalone `web.browse screenshot` reuses the same primary-first observation router for
managed browser captures. The screenshot remains a successful browser artifact if image
observation is unavailable; the tool result records that state explicitly rather than
encouraging an ungoverned browser or image-library detour.
Attachment stream consumption is independently cancellation-aware even when an adapter
ignores its signal. Cancellation detaches the pending read without waiting for a hostile
iterator, records a visible retryable state, and prevents late observations from becoming
admitted context.

Memory is an optional replaceable adapter. Queries are redacted, project-scoped,
deadline-bound, and smaller than the transcript. Results require stable attribution,
retain stale/conflict labels, are deterministically ordered by pinning, project-before-user
scope, relevance, recency, and identity, and enter context as untrusted memory.
Optional failures produce visible degradation and do not stop the turn. Explicit saves
carry idempotency fields; updates to an existing identity require an optimistic version
and adapter conflicts surface without last-writer-wins loss. Automatic saves are only candidates,
and secret-like content is rejected before reaching the adapter.
Every adapter operation carries a distinct correlation identity and owned cancellation
signal. Recall distinguishes deadline expiry from parent-turn cancellation, and an adapter
result arriving after cancellation cannot advance the provider boundary or enter context.

MCP servers must be explicitly configured and enabled. The runtime supports contained
local stdio and Streamable HTTP transports. It targets MCP `2026-07-28` stateless request
metadata and routing headers, with explicit negotiated compatibility for earlier
configured protocol revisions. Discovered tools are collision-safe, schema checked,
attributed, locally effect-classified, and installed into the ordinary immutable tool
snapshot. Consequently every MCP call crosses the same mandatory reviewer, execution
revalidation, private ledger, cancellation, and result normalization boundary as a
native tool. Server failures and reconnects revoke that server's next-step capabilities;
an unknown-effect call is never replayed. A `tools/list_changed` notification refreshes
the registry under a bounded call: an already-built model-step snapshot remains immutable,
while the next step sees a new generation and prior approved definitions remain versioned.
The root Console exposes `nna.mcp_status` for inspecting the global MCP registry and
`nna.mcp_test` for negotiating one configured server and listing the tool names it
discovers. These controls replace filesystem searches for private NNA configuration.
An MCP server saved after a conversation began is usable from a newly created conversation;
restarting NNA is unnecessary. A connection test reports discovered tools but does not add
them to the immutable tool snapshot of an older conversation or invoke any remote tool.
Stdio framing enforces its byte limit on each complete line before JSON parsing as well as
on an unterminated buffer. Overflow or malformed framing makes that transport terminal,
settles owned requests, and closes the subprocess. Remote-controlled error messages never
cross the adapter boundary; callers receive the stable `mcp_remote_error` text only.

Non-MCP extensions have a small manifest-gated registry. Origin, version, license,
host-contract version, configuration schema, permissions, capabilities, lifecycle deadlines,
and explicit enable confirmation are mandatory and inspectable before activation. The
registry neither downloads code nor exposes engine internals. It supplies only a frozen,
versioned host facade and an owned cancellation signal; disable/unload aborts owned work,
closes the adapter within its deadline, and revokes future capability snapshots. Crashes and
incompatible host contracts remain isolated in failed/incompatible states with diagnostics.
