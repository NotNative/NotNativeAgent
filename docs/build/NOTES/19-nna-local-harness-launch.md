# NNA local harness launch boundary

> **Historical implementation note — 2026-10-01:** Retained for contracts and dated evidence.
> Current scope, ownership, remaining work, and acceptance are defined by
> [PLAN](../PLAN.md) and the [execution audit](../EXECUTION/01-architecture-audit.md).
> Old mock-only, auto-accept, lifecycle, and deferral instructions are superseded.
> A recorded test pass is limited to its stated version and surface.


## Current interoperable path

NND's server-only `nna` harness adapter forwards its `/api/*` requests to an
NNA integration service.  NNA now owns the live session engine, canonical
ingress, governance, durable transcript projection, and authenticated SSE
stream.  NND remains a presentation and local-operator client.

The NNA child is started with `nna nnd serve`. Its single stdout
readiness line is JSON with `type: "ready"`, `protocol`, `endpoint`,
`instance_id`, and a short-lived integration `token`.  Diagnostics belong on
stderr; stdout must remain protocol-only.

## Launch ownership contract

NND's managed local launcher now:

1. Spawn the configured NNA executable with `nnd serve`, with stdout
   and stderr kept separate.
2. Accept exactly one bounded readiness line before a startup deadline, reject
   malformed data, non-loopback endpoints, and a protocol mismatch.
3. Keep the endpoint and token only in the NND server process.  They must not
   enter browser JavaScript, URL query parameters, persisted settings, or
   logs.
4. Supply the authenticated NNA principal from the NND server's local session
   authority; a browser directory header never selects an NNA workspace.
5. Terminate the child on NND shutdown and treat an unexpected exit as a
   harness-down transition, never as an empty session list.

## Attach-mode configuration

`NOTNATIVE_NNA_MODE=attach` lets NND attach to an NNA child managed by its
parent or operator through server-only `NNA_HARNESS_URL`,
`NNA_INTEGRATION_TOKEN`, and `NNA_PRINCIPAL` configuration. This remains
useful for development and externally owned NNA processes.

NND product boot defaults to the managed NNA child. On Windows it first reads
the local NNA installation descriptor and invokes its recorded Node runtime
and immutable installed CLI directly, avoiding an assumption that `nna.cmd` is
on PATH. That direct launch passes the descriptor's `data_root` as `NNA_HOME`,
matching the installed launcher so NNA uses the operator's configured state.
`NNA_COMMAND` overrides that discovery; portable/non-Windows installs
fall back to `nna` on PATH. `NNA_WORKSPACE_ID` supplies the explicit local workspace authority (default
`local`). NND mints a fresh, bounded principal envelope per forwarded request;
the readiness credential itself never reaches the browser or logs.
The local operator envelope grants session create, submit, title update,
abort, and catalog removal separately. NNA checks each grant at its own
route and retains session journals after catalog removal for recoverable
inspection; the GUI delete action is not a secure erase.

The authenticated `/api/config` projection reports NNA's configured primary
provider and model identifiers without its endpoint or credentials. The NND
composer labels that primary route and disables model and agent selection for
NNA-backed sessions; it hides the mock-only auto-accept toggle. Prompt requests
carry the configured primary model and NNA agent marker. NNA rejects different
model or agent selections instead of silently running another route. Per-turn
selection remains a future NNA-owned engine contract, and an actual turn may
still use a manifest-configured fallback. The composer also blocks sends while
the bootstrap config is pending or unavailable, including when path/status
bootstrap succeeds independently; it never assumes a missing config means mock.

The source development launcher explicitly selects `NOTNATIVE_HARNESS=mock`
unless the developer provides another value. That keeps a first-run source
checkout usable without weakening the packaged product's NNA-first contract.
