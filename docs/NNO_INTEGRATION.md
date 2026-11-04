# NNO integration service

NNO owns the lifecycle of one long-lived, local NNA integration child. It starts:

```text
nna integration serve
```

The service is dormant unless `NNA_NNO_INSTALL_ROOT` names an installed NNO root
containing `nna-integration/nno-hosted/integration.json` with this shape:

```json
{
  "id": "nno-hosted",
  "ownership": "nno",
  "scope": "nno-child-only",
  "nna_integration_protocol": "1.0",
  "deployment_id": "deployment-identifier"
}
```

## Startup and lifecycle

Standard output is protocol-only UTF-8 NDJSON. Diagnostics use standard error. After
binding an operating-system-assigned loopback port, NNA emits exactly one atomic frame:

```json
{"type":"ready","protocol":"1.0","endpoint":"http://127.0.0.1:49152","instance_id":"nna_...","token":"..."}
```

The port in this example is illustrative. It is never fixed or configured. NNO retains
the endpoint and token in memory only, closes the child during platform shutdown, and
invalidates both values whenever the child exits. A bounded restart policy may launch a
new child; the new instance has a new endpoint and token.

NNO must bound startup time and readiness-frame bytes, require the exact protocol
version, and accept only an `http` URL whose hostname is exactly `127.0.0.1`, whose port
is nonzero, and which has no credentials, query, or fragment. It must terminate the child
when any check fails. Requests use redirect mode `error`; redirects are never followed.

## Authentication and principal

Every request supplies:

```text
Authorization: Bearer <ready-frame-token>
X-NNA-Principal: <base64url(JSON)>
Content-Type: application/json
```

The bearer authenticates the current NNO child instance. It is minted by NNA at process
start, never stored, cannot be refreshed, and is revoked by stopping that process.
`X-NNA-Principal` is an exact, bounded envelope:

```json
{
  "subject_id": "u_...",
  "platform_role": "root",
  "permissions": ["provider.read"],
  "workspace_ids": ["w_..."],
  "group_ids": ["g_..."],
  "trace_id": "trace_...",
  "issued_at": "2026-08-11T12:00:00.000Z",
  "request_id": "req_..."
}
```

All eight fields are required; unknown fields, invalid values, and envelopes more than
five minutes from NNA's clock are rejected. `platform_role` is attribution only. It does
not grant authority. NNA checks the explicit permission and applicable ownership scope
for every operation.

Permissions are `integration.health`, `provider.read`, `provider.manage`,
`provider.discover`, `provider.test`, `secret.read`, `secret.manage`, `secret.use`, and
`secret.audit`. A domain wildcard such as `provider.*` is accepted. Secret visibility is
further limited to matching user, workspace, or group IDs. Role and deployment scopes
require `secret.scope.role:<id>` and `secret.scope.deployment`; cross-scope access requires
`secret.scope.all`.

Bearer tokens, principal envelopes, secret fields, and authorization headers must be
redacted from NNO and NNA telemetry.

## Provider connections and model selections

A **connection** stores where inference runs: endpoint, trust zone, and the credential
reference. A **model selection** names one model on one connection. One connection can
carry several selections, so two models on one endpoint no longer need two records.

```text
GET    /v1/connections
GET    /v1/connections/{connection_id}
POST   /v1/connections/{connection_id}/discover
GET    /v1/models
GET    /v1/routes
```

The connection contract is read-only in this release. `connection_id` is the stable
foreign key; `display_name` is presentation text. A response wraps a secret-free
`connection` object:

```json
{
  "connections": [{ "connection_id": "lan", "display_name": "LAN box",
    "endpoint": "http://model-host.example:1234/v1", "trust_zone": "private_network",
    "credential": null, "credential_env": null, "connection_revision": "..." }],
  "selections": [{ "selection_id": "big", "connection_id": "lan", "model": "glm",
    "context_limit_bytes": null, "output_limit_tokens": null, "tool_call_mode": "single",
    "active": true, "selection_revision": "..." }],
  "configured_primary_route": { "connection_id": "big", "model": "glm" }
}
```

`/v1/models` lists every configured selection with the connection that serves it, so a
catalog row always names a usable **connection and model pair**:

```json
{ "models": [{ "connection_id": "lan", "connection_name": "LAN box",
  "endpoint": "http://model-host.example:1234/v1", "model": "glm", "selected": true }],
  "configured_primary_route": { "connection_id": "big", "model": "glm" } }
```

`/v1/routes` reports the resolved role map. A role that inherits the primary selection
reports `assigned: false` and the primary's connection:

```json
{ "roles": { "primary": { "connection_id": "big", "model": "glm", "assigned": true },
  "reviewer": { "connection_id": "big", "model": "glm", "assigned": false } },
  "configured_primary_route": { "connection_id": "big", "model": "glm" } }
```

Discovery returns `{ "connection_id", "models": [...] }`. Every endpoint above requires
permission `provider.read`, except discovery, which requires `provider.discover`. A write
method returns `405`; this release defines no connection mutation over HTTP.
Neither contract accepts or returns a literal credential value.

### Provider profile compatibility projection

The profile contract below still serves one flat row per model selection. It is a
derived projection of the records above, and it accepts the same writes it always did.

## Provider profiles

The stable profile ID is the foreign key. `display_name` is presentation text and may be
renamed without changing route assignments.

```text
GET    /v1/provider-profiles
POST   /v1/provider-profiles
GET    /v1/provider-profiles/{profile_id}
PATCH  /v1/provider-profiles/{profile_id}
DELETE /v1/provider-profiles/{profile_id}
POST   /v1/provider-profiles/{profile_id}/discover
POST   /v1/provider-profiles/{profile_id}/test
```

Create body:

```json
{
  "profile_id": "lab-qwen35b",
  "display_name": "Lab Qwen 35B",
  "endpoint": "http://model-host.example:1234/v1",
  "model": "qwen3.6-35b-a3b",
  "credential": { "source": "secret", "secret_id": "sec_...", "field": "api_key" },
  "context_limit_bytes": null,
  "output_limit_tokens": null
}
```

`profile_id`, `endpoint`, and `model` are required on create. PATCH accepts the other
fields but never changes `profile_id`. Responses wrap a secret-free `profile` object; list
uses `{ "profiles": [...] }`. Discovery returns `{ "profile_id", "models": [...] }`.
Test returns `{ "profile_id", "status", "selected_model", "discovered_models" }`.
Provider authentication accepts a Secret Broker record/field binding. The compatibility
field `credential_env` may instead name an environment variable available to the NNA process.
Literal provider credentials are neither accepted nor returned by this API.

### Provider response schemas

Successful responses are newline-terminated JSON with `Content-Type: application/json`
and `Cache-Control: no-store`:

| Operation | Status | Body |
| --- | ---: | --- |
| List | 200 | `{ "profiles": [<profile>...] }` |
| Get | 200 | `{ "profile": <profile> }` |
| Create | 201 | `{ "profile": <profile> }` |
| Update | 200 | `{ "profile": <profile> }` |
| Delete | 200 | `{ "removed": "<profile_id>" }` |
| Discover | 200 | `{ "profile_id": "...", "models": ["..."] }` |
| Test | 200 | `{ "profile_id": "...", "status": "ready|model_unavailable", "selected_model": "...", "discovered_models": 3 }` |

## Secret management

```text
GET    /v1/secrets
POST   /v1/secrets
GET    /v1/secrets/{id}
PATCH  /v1/secrets/{id}
DELETE /v1/secrets/{id}
PUT    /v1/secrets/{id}/values
PATCH  /v1/secrets/{id}/status
POST   /v1/secrets/{id}/use
GET    /v1/secrets/audit?limit=500
```

Create accepts `{ "label", "kind", "scope", "metadata", "fields" }`. Supported kinds
are `api_key`, `token`, `username_password`, and `text`; scope is `{ "kind", "id" }`.
Metadata responses contain only field names and lifecycle information. Value rotation is
`{ "fields": { ... } }`; status is `{ "enabled": true }`. Use requires
`consumer`, `destination`, `purpose`, and `reviewerDecisionId` (with optional `sessionId`).
The `/use` result is for NNO's trusted backend only and must never be forwarded to a
browser, model context, or log.

## HTTP failure contract

Every integration HTTP failure is a newline-terminated JSON object:

```json
{"error":{"code":"provider_missing","message":"provider profile not found"}}
```

NNO branches on `error.code`, never on message text. The NNO-relevant stable codes are:

| HTTP | Codes |
| ---: | --- |
| 400 | `request_invalid`, `request_too_large`, `provider_request_invalid`, `provider_id_invalid`, `provider_duplicate`, `provider_last_profile`, `provider_in_use`, `provider_configuration_invalid`, `provider_configuration_too_large`, `invalid_endpoint`, `invalid_model`, `missing_credential`, `provider_discovery_unreachable`, `provider_discovery_failed`, `provider_discovery_too_large`, `provider_models_empty`, `secret_label_invalid`, `secret_kind_invalid`, `secret_fields_invalid`, `secret_field_name_invalid`, `secret_field_value_invalid`, `secret_scope_invalid`, `secret_metadata_invalid`, `secret_label_duplicate`, `secret_status_invalid`, `secret_use_request_invalid`, `secret_revoked`, `secret_audit_unavailable`, `secret_key_invalid`, `secret_vault_integrity_failed`, `secret_vault_corrupt` |
| 401 | `unauthenticated`, `principal_required`, `principal_invalid`, `principal_stale` |
| 403 | `integration_permission_denied`, `secret_scope_forbidden` |
| 404 | `not_found`, `provider_missing`, `secret_not_found` |
| 405 | `method_not_allowed` |
| 500 | `internal_failure` |

The request-body limit is 96 KiB. A 500 response always uses the generic message
`integration request failed`; internal exception text is not exposed.

## Hosted agent selection

NNO launches `nna host -provider <profile_id>` (the `--provider` and
`--provider-profile` aliases remain accepted) and initializes with the canonical field:

```json
{
  "type": "initialize",
  "version": "1.0",
  "request_id": "req_...",
  "manifest": {
    "provider_profile_id": "lab-qwen35b"
  }
}
```

The `initialized` frame acknowledges the resolved route at one canonical location:

```json
{
  "version": "1.0",
  "type": "initialized",
  "request_id": "req_...",
  "status": "ready",
  "provider": {
    "profile_id": "lab-qwen35b",
    "display_name": "Lab Qwen 35B",
    "endpoint": "http://model-host.example:1234/v1",
    "model": "qwen3.6-35b-a3b"
  }
}
```

NNO validates `version`, `type`, `request_id`, `status`, and the complete `provider`
object. Other bounded fields in the frame are additive runtime metadata. The acknowledged
`provider.profile_id` must exactly equal the requested stable ID before NNO submits work.

If initialization fails after a command was parsed, NNA emits one protocol error frame
before exiting nonzero:

```json
{
  "version": "1.0",
  "type": "error",
  "request_id": "req_...",
  "code": "provider_missing",
  "category": "provider",
  "message": "provider profile not found",
  "retryable": false,
  "operation": "headless_protocol",
  "next_action": "Inspect local health and diagnostics using the stable error code."
}
```

Initialization codes NNO must handle are `provider_missing`,
`provider_profile_conflict`, `provider_profile_invalid`,
`provider_configuration_unavailable`, `initialization_required`,
`initialization_manifest_invalid`, `incompatible_version`, `session_missing`,
`malformed_json`, `line_too_large`, `structure_too_large`, `unknown_control`, and
`internal_failure`. An unparseable command cannot supply a trustworthy `request_id`.

Before the integration service emits `ready`, fatal CLI activation errors are written to
stderr as `nna: <code>` and the process exits nonzero without a ready frame. Codes are
`integration_command_invalid`, `integration_bind_invalid`, `integration_token_invalid`,
`nno_install_required`, `nno_install_invalid`, `nno_integration_activation_missing`,
`nno_integration_activation_invalid`, `nno_integration_activation_incompatible`, and
`nno_integration_activation_required`. NNO treats stderr as diagnostics, not as protocol.

NNO business routes, blind-test primaries, and candidates store profile IDs, never model
names or display names. NNA resolves its internal reviewer, vision, and subagent routes.
Legacy flat initialized fields may be read during migration, but new integrations write
and validate only the canonical fields above.

## Failure behavior and retirement

An unexpected integration-child exit makes the provider and secret settings surfaces
unavailable. NNO records correlated telemetry/review evidence and may restart with bounded
backoff. It must not silently use stale authority or fall back to direct file mutation.

The historical fixed port `7321`, `NNA_SECRET_BROKER_TOKEN`, and `nna secrets serve`
authority path are retired. There is one integration child, one ephemeral bearer, and one
authorization path.
