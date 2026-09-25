# NNA local harness launch boundary

## Current interoperable path

NND's server-only `nna` harness adapter forwards its `/api/*` requests to an
NNA integration service.  NNA now owns the live session engine, canonical
ingress, governance, durable transcript projection, and authenticated SSE
stream.  NND remains a presentation and local-operator client.

The NNA child is started with `nna integration serve`.  Its single stdout
readiness line is JSON with `type: "ready"`, `protocol`, `endpoint`,
`instance_id`, and a short-lived integration `token`.  Diagnostics belong on
stderr; stdout must remain protocol-only.

## Launch ownership contract

NND's managed local launcher now:

1. Spawn the configured NNA executable with `integration serve`, with stdout
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

When `NOTNATIVE_HARNESS=nna` and the mode is not `attach`, NND runs managed
mode by default. `NNA_COMMAND` selects the executable (default `nna`) and
`NNA_WORKSPACE_ID` supplies the explicit local workspace authority (default
`local`). NND mints a fresh, bounded principal envelope per forwarded request;
the readiness credential itself never reaches the browser or logs.
