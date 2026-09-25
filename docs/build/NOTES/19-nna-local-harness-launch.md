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

The forthcoming NND local launcher must:

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

## Deliberate interim configuration

Until that launcher lands, NND can attach to an NNA child managed by its parent
or operator through server-only `NNA_HARNESS_URL`, `NNA_INTEGRATION_TOKEN`,
and `NNA_PRINCIPAL` configuration.  This is an attach mode, not the intended
desktop default.  It keeps the existing adapter testable while preserving the
same authentication boundary the launcher will use.
