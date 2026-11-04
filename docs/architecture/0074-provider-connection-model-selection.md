# Architecture decision 0074: provider connections and model selections

Status: accepted for slice 0 (decision record). Slices 1-5 implement it.

This decision replaces the stored *provider profile* record with two records:
a **provider connection** and a **model selection**. It also removes the
role-to-role fallback mechanism. The goal is a routing surface that is boring
and reliable: one obvious path from a request to a model, no hidden second
path, and an operator can read the whole routing state from one screen.

## Problem

The stored provider profile binds four unrelated ideas in one record:

| Idea | Field in the provider profile |
| --- | --- |
| Where inference runs | `endpoint`, `trust_zone` |
| How to authenticate there | `credential`, `credential_env` |
| Which model to use | `model` |
| That model's limits and capabilities | `context_limit_bytes`, `output_limit_tokens`, `tool_call_mode`, `capabilities` |

`withUpdatedProvider` (`src/provider/route-configuration.js:154`) carries every
route whose model equals the profile model to the new model, and drops the
route context limit when the model changes (`:184-186`). Two models on one
endpoint therefore need two provider profiles that share an endpoint, a
credential, and a trust zone. The desktop and terminal surfaces also write
routing through five different contracts, each with its own confirmation and
apply rules.

The role-to-role `fallbacks` list adds a second, configurable path that a
reviewer or sub-agent request can take. It needs cycle validation
(`validateRouteGraph`, `src/config.js`), trust-zone containment
(`src/provider/router.js:6-7`), and a depth-first search
(`orderedRoles`, `:78-93`). Operators rarely configure it and cannot predict
its result.

## Decision

### Two records

A **provider connection** stores where inference runs and how to authenticate:

<pre>
connection: id, display_name, endpoint, trust_zone, credential, credential_env
</pre>

A **model selection** names one model on one connection:

<pre>
selection: connection_id, model
</pre>

A route stores a **model selection**, not a provider profile. The stored route
record keeps its tuning fields: `context_limit_bytes`, `required_capabilities`,
`temperature`, `max_output_tokens`, `deadline_ms`,
`reasoning_effort`, `enable_thinking`.

A stored `budget` field is retained for compatibility and is not enforced: a
role has one selection, so the number of attempts is no longer a routing
choice. It never appears as a control on a surface.

### Limits and capabilities leave the stored record

`context_limit_bytes`, `output_limit_tokens`, `tool_calls`, and capability flags
describe *one model on one connection*, not a connection. They become
**observations**, not assertions:

1. **Observed** when a discovery or qualification probe proves the value.
   `OpenAICompatibleProvider.capabilities` already reads context and output
   limits from the `/models` model card
   (`src/provider/model-metadata.js:4`) and reports `unknown` when the card has
   no limit field.
2. **Configured** when the route sets an explicit `context_limit_bytes`
   override. Route tuning wins for that route.
3. **Unknown** when no probe proved a value and no route sets one. An unknown
   limit is a display state. It never becomes zero and never becomes a guessed
   default.

The migration keeps a connection-level **default selection limits** record only
to preserve behaviour: an operator who configured limits on a provider profile
gets the same limits on that profile's model selection. The record is labelled
as configured, not observed.

### Route resolution

Every route resolves by inheritance from the primary route:

<pre>
routes[role] = assigned ? routes[role] : routes.primary
</pre>

This applies to `reviewer`, `subagent`, and `vision`. The primary route is
always assigned.

A role with its own assignment is authoritative for that role. NNA does not
compare its trust zone with the primary zone. The operator selected that
selection explicitly, and the selection's own zone is what the request uses.
This replaces the earlier plan to refuse a role whose zone is broader than the
primary zone: the containment rule existed only to stop a *fallback* from
widening egress, and no fallback exists now.

The reviewer is a separate inference call with its own resolution. It is not a
step in the agent's route chain. `RoutedSemanticReviewer.review`
(`src/provider/model-reviewer.js:32`) already requests `router.candidates
('reviewer')` independently.

The vision role adds one capability filter. A vision selection must be
vision-capable. If no vision-capable model exists anywhere in the configured
inventory, NNA cannot review an image or video attachment. It tells the
operator that no vision-capable model is configured and names the attachment.
It does not fall back to a text-only model and does not retry.

### Remove `fallbacks`

The `routes[role].fallbacks` list is removed from the manifest, the resolver,
the catalog, and every surface. `orderedRoles` becomes the single inheritance
lookup above. The following code leaves the runtime:

- `validateFallbacks` and the `fallbacks` field in `buildRoutes`
  (`src/config.js`);
- `validateRouteGraph`, its cycle rule, and the `route_cycle` and
  `invalid_route_fallback` error codes;
- `orderedRoles` (`src/provider/router.js:78-93`);
- the fallback array editor in the desktop routing page, the read-only
  fallback rows in `/provider settings`, and the `fallbacks` catalog row.

A reader migration removes `fallbacks` from a stored route and records the
removal in the migration receipt. Until that migration runs, the reader ignores
a stored list without failing, so an older manifest still loads.

### Trust zones

A provider connection keeps its trust zone. The zone describes the network
path the credential and the request payload travel on. It is derived from the
endpoint and is not configurable.

`trustCompatible` (`src/provider/router.js:6-7,103-105`) and its zone-rank
table are removed with the fallback mechanism. A route that inherits from the
primary always uses the primary's zone, so an inherited route cannot widen
egress by construction. A role with its own assignment uses the zone of the
connection the operator selected.

### Main selection unavailable

NNA does not switch to another connection or another model when the primary
selection fails. The failure is the same as a network failure for any remote
service:

- the provider call fails with a provider error that names the connection and
  the model;
- dependent roles inherit the same failure, so one operator message describes
  one cause, not four;
- NNA does not poll connection health in the background and does not switch on
  a health verdict;
- the operator selects another model or connection, or restores the failed
  one.

`Why:` automatic switching hides which model answered a request, and that fact
is part of every token receipt and review decision.

### Reviewer self-review

When the reviewer route inherits the primary route, the reviewer and the agent
can be the same model. The reviewer receives a fresh call over
harness-verified evidence: the sealed request, the deterministic classification,
the authenticated intent, the ledger summary, and the tool definition
(`src/reviewer.js:100-109`). It does not receive the agent's private reasoning
or its accumulated session state.

NNA accepts this configuration and records the self-review condition in the
review decision evidence. It does not add a policy gate that requires a
different reviewer route.

The residual risk is shared-distribution blindness: a reviewer that shares the
agent's training can accept a justification that it would also have produced.
The deterministic evidence remains an independent signal. This decision records
the limitation on purpose, so a later change can raise a gate without
re-litigating the reason.

The reviewer stays **fail-closed**. When the reviewer cannot produce a valid
decision, NNA denies the tool request (`src/reviewer.js:322-329`) and tells the
agent to continue a safer way. Fail-open applies to **structured output
format**, not to review outcomes. `RoutedSemanticReviewer` already repairs
malformed output with a prose JSON-text request before it gives up
(`src/provider/model-reviewer.js:31`). This decision records that behaviour for
every structured consumer:
`Invariant:` a server-side structured-output grammar is an optimization. Local
validation is the requirement.

## Migration

**Slice order note.** The first implementation slices keep the stored
connection-level `context_limit_bytes`, `output_limit_tokens`, `tool_call_mode`,
and `capabilities` where they are. That keeps every existing behaviour and every
stored manifest valid while the connection and selection records are separated.
The per-selection observation record below is a later slice; until then a
selection reads the connection default when its model equals the connection's
default model, which is the rule `buildRoutes` already applies.

The manifest gains `format_version: 2`. `assertManifestVersion`
(`src/config.js:162`) refuses a future version with `manifest_version_future`.
A release binary that predates this change refuses a version-2 document and
asks the operator to upgrade. A rollback needs the operator to restore the
`.bak` file that the transaction published.

`migrateManifestDocument` (`src/config.js:157`, `src/persistence/
manifest-migration.js`) gains a `manifest_connection_version` marker that runs
once:

1. **Group providers by connection identity.** Two providers join one
   connection only when `endpoint`, `trust_zone`, `credential`, and
   `credential_env` are all equal. The connection takes the first provider's
   `id` and `display_name`. Two providers that share an endpoint but use
   different credentials stay separate connections; collapsing them would
   drop one credential binding.
2. **Write one selection per provider.** The selection is
   `(connection_id, model)`. The provider's `context_limit_bytes`,
   `output_limit_tokens`, `tool_call_mode`, and `capabilities` become configured
   limits and declared capabilities on that selection.
3. **Rewrite routes.** `routes[role].provider_id` and `model` become
   `routes[role].connection_id` and `model`. A route that references a collapsed
   connection keeps its model unchanged.
4. **Drop `fallbacks`.** Record each removal.
5. **Keep unknown keys.** Existing private source keys stay in place.

The migration is a pure read transformation. It writes nothing until the next
transaction. An operator sees the migrated document on the first
configuration save.

**Credential rule.** A migration never merges two credential bindings. If the
only difference between two providers is the credential, the migration keeps
both connections.

## Surface split

The three operator surfaces follow from the two records:

| Surface | Owns | Writes |
| --- | --- | --- |
| Connections | connection records | connection create, update, credential binding, test, discovery |
| Models | discovered models per connection, the current selection, favourite and hidden flags | primary selection; favourites, hidden |
| Routing | role assignments other than the primary assignment | `routes[role]` assignment and tuning |

The `/model` list sweeps every connection with the existing `/models` probe:
bounded at 4,096 entries per connection and 3 seconds per probe. The surface
fills rows as connections answer, can be cancelled, and marks each row
`observed`, `configured`, or `unavailable`. A model row shows the connection
display name, the model name, and the context window from
`providerModelLimits`, or `unknown`.

A model pick is conversation-scoped: it overrides the primary selection for the
current conversation and is stored in the conversation snapshot. A pick made in
the main console persists the primary selection as the workspace default.

## Consequences

- One stored route record, one resolution rule, and one apply rule replace
  five write contracts and one configurable fallback graph.
- The desktop and terminal surfaces share the same two records.
- `provider profile` leaves the terminology contract. `provider connection` and
  `model selection` replace it. Historical evidence keeps the words it was
  written with.
- `NNO_INTEGRATION.md` describes `/v1/connections`, `/v1/models`, and
  `/v1/routes` as a new contract with no compatibility projection.
- Scheduler capacity keys, token receipt correlation, and durable evidence
  rename `profile_id` to `connection_id` and add `model`. Scheduler capacity
  becomes keyed by `(connection_id, model)` because two models on one
  connection have different capacity.

## Slice record

| Slice | State |
| --- | --- |
| 0 — this decision record | Done |
| 1 — route resolution inheritance, fallback removal, vision refusal wording | Done |
| 2 — connection/selection manifest records, `format_version: 2`, migration | Done |
| 3 — per-selection limit observation, primary pick persistence, `/model` sweep | Pending |
| 4 — `/v1/connections`, `/v1/models`, `/v1/routes`, evidence key rename | Pending |
| 5 — Connections, Models, Routing surfaces | Pending |

Slice 2 stores `connections[]` and `model_selections[]` and resolves them into the
flat provider map every existing consumer reads. A route names the **model
selection** that serves it (`routes[role].selection_id`), and the selection names
its connection, so two models on one endpoint no longer need two stored records.

The resolved manifest still carries a derived, unpersisted `providers` array so a
read surface that has always shown provider rows keeps its shape. `manifestFromConfig`
emits it, `assignProviders` and the intent layer remove it before a write, and it is
never read back from a document.

Slice 1 keeps the internal name `providerProfiles` for the resolved connection
map, and slice 2 keeps it: it names the resolved flat records, which are still one
per model. A later slice can rename it with the `/v1/connections` contract.


