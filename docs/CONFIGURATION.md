# Configuration and manifest reference

## Adaptive model dialects, project guidance, and optional LSP

NNA maintains a bounded local dialect profile for each provider/model pair in
`~/.nna/model-dialects.json`. It records compatibility outcomes, never credentials, and
tightens schema/termination guidance after repeated observed failures. `/model qualify`
runs two bounded inference probes (exact text and one synthetic native tool call); the
synthetic tool is never executed. This is local qualification, not a benchmark.

Optional language-server diagnostics use `~/.nna/config/lsp.json`:

```json
{
  "servers": [{
    "id": "typescript", "command": "typescript-language-server", "args": ["--stdio"],
    "extensions": [".js", ".jsx", ".ts", ".tsx"], "language_id": "typescript"
  }]
}
```

Commands are spawned directly with an argv array and no shell. A missing or unmatched
configuration returns `lsp_not_configured` without changing the workspace.

Repository guidance is independent of external memory. A root `NNA.md` applies to the
workspace; additional `NNA.md` files apply beneath their directory. NNA discovers them
from actual tool targets, loads them root-to-leaf with strict bounds, rejects symlinks,
and attributes them as workspace guidance that cannot grant tool authority.

The CLI accepts a UTF-8 JSON manifest with `--manifest PATH`; headless mode supplies the
same object in its `initialize` command. Secrets are references such as `credential_env`,
never command-line values. Unknown security-like keys fail. This validation applies at
the full nested path across provider, route, attachment, memory, MCP, Console, telemetry,
reviewer-ledger, and mission objects. Other unknown keys are reported in the effective
configuration warnings and ignored for forward compatibility.

Review-floor keys cannot be weakened by any configuration source. A rejected known or
unknown security-relevant key reports the winning source and writes a redacted
`configuration_security_rejected` record to the local structured log; its configured
value is never copied into the diagnostic or audit record. Stricter bounded reviewer
settings remain valid.

Recognized top-level fields are `format_version`, `persistence`, `provider` or `providers`, `routes`,
`workspace_root`, `application_system_prompt`, `mission`, provider/context deadlines,
`context_limit_bytes`, `context_compaction_threshold`,
`provider_connect_timeout_ms`, `semantic_review_timeout_ms`, `approval_timeout_ms`,
`provider_concurrency`, `provider_queue_limit`, `tool_concurrency`,
`persistence_flush_timeout_ms`, `shutdown_timeout_ms`,
`attachments`, `memory`, `mcp_servers`, `recovery`, `tui`, and `telemetry`. Configurable
external telemetry is disabled by default and requires an explicit destination; this is
separate from NNA's default local-only forensic database. This candidate ships no
telemetry exporter.

`recovery.max_model_steps` defaults to 1,024 and is bounded from 16 through 100,000,
allowing long-horizon work without disabling cancellation or no-progress supervision.
`recovery.local_retry_limit` defaults to 3 and is bounded from 2 through 5. The
`recovery.ladder` array supplies at least one action for every retry before exhaustion and
may contain only the supported bounded `nudge` and `compact` actions; its default is
`["nudge", "compact"]`. The effective ladder is retained by every configuration round trip
and is captured when a turn starts, so a mid-turn configuration update cannot reset its
consumed recovery budget.

Provider connection, semantic-review, and interactive-approval deadlines default to 10,
15, and 120 seconds respectively. Provider first-token, inter-token idle, and overall
deadlines default to 10, 5, and 30 minutes. These deliberately generous bounds accommodate
large prompts on local models and consumer hardware while preserving cancellation and a
finite failure path. Manifests carrying the exact historical 30-second/45-second/120-second
default tuple are migrated to these safer defaults; genuinely customized values remain
authoritative. `provider_concurrency` and `tool_concurrency` default
to one for constrained local systems and accept one through sixteen. Tool concurrency
applies only to consecutive independently reviewed read-only operations; mutations remain
ordered barriers. `provider_queue_limit` defaults to 256 and accepts one through 4,096.
Health reports these effective operational values. They are engine policy rather than
ordinary Console preferences and are not editable through `/config`.

Provider capability discovery used by `/model`, `/provider test`, and `/health` has a hard
owner-side deadline in addition to its abort signal. A cooperative adapter is cancelled;
an adapter that ignores cancellation is detached and reported as
`provider_capabilities_timeout` without freezing the Console or diagnostics.
The built-in adapter reads model/error metadata as bounded UTF-8 before JSON parsing, and
the shared adapter boundary projects only known scalar capability fields plus at most
4,096 bounded model identifiers. Custom providers therefore cannot inject an unbounded
object graph into health or model-selection views.

Global Console changes use a prepareâ€“persistâ€“publish transaction. Every attached
conversation validates its prospective frozen configuration before the user manifest is
written; a validation or manifest-write failure publishes nothing. After the atomic
manifest write succeeds, every prepared conversation version is published at its idle or
next-model-step boundary, preventing a session-by-session partial update. The workspace
default advances its own monotonic runtime version and seeds newly created conversations
with that version; it does not reset to the manifest format version after each edit.

`persistence_flush_timeout_ms` defaults to 10 seconds and independently bounds each
journal write/fsync boundary. A timeout returns `persistence_flush_timeout`, latches that
journal unavailable, and prevents later records from being accepted under false durability.
`shutdown_timeout_ms` defaults to 15 seconds and bounds the whole-runtime shutdown. Its
expiry aborts active provider work, closes hook admission, returns `shutdown_timeout`, and
suppresses a false `shutdown_complete`; component-specific shutdown deadlines remain
narrower where configured.

The canonical persisted manifest uses `format_version: 1`. A legacy manifest without
that field is validated, backed up to `manifest.json.bak`, and atomically upgraded once.
An unknown future format is rejected before configuration can affect the runtime.

The installed CLI loads the user manifest, binds the active workspace to the resolved
launch directory, then merges a trusted `.nna/settings.json` project file and an explicit
`--manifest` file in that order. Project configuration is ignored until the operator runs
`/trust workspace`; `/untrust workspace` revokes that trust. Both commands take effect on
restart so project configuration, guidance, hooks, tool roots, and MCP eligibility are
recomputed together at a safe boundary. `/config` displays the effective winning sources.

Hook discovery always includes the per-user `~/.nna/hooks` root. After the exact resolved
workspace is trusted and NNA is restarted, it also includes `<workspace>/.nna/hooks` as
the project scope. The combined catalog is bounded to 32 bundles. User scope wins a
duplicate bundle identity; the project duplicate is skipped with
`hook_identity_conflict` in health rather than ambiguously registering both. Project hook
output remains attributed, untrusted enrichment and never replaces mandatory review.
Supported hook edges are exactly `session.start:post`, `session.end:pre`, `turn:pre`,
`turn:post`, `tool.call:pre`, `tool.call:post`, `compaction:pre`, and
`compaction:post`. A bundle using an unimplemented event/phase pair is rejected with a
health diagnostic instead of being reported loaded while silently skipping work.

Mission authority is accepted only in a headless initialization or configuration update
from the authenticated stdio host. A mission requires safe `id` and `revocation_id`
identities, an outcome, an ordered ISO `not_before`/`expires_at` schedule, explicit
`resources`, `targets`, `side_effects`, and environment-name-only `credential_refs`, bounded
`max_turns`, `max_tool_calls`, and `max_duration_ms`, plus `termination.suspend_on` and
`termination.terminate_on` conditions. Termination must include expiration, budget
exhaustion, and disconnect. Target entries may be an exact canonical target, a directory
prefix ending in `/**`, `tool:TOOL_NAME`, `scope:SCOPE`, or the deliberately broad `*`.
Every tool—including deterministic read-only tools—is checked against this envelope before
approval. Provider and MCP credential references must also be declared in the envelope;
secret values remain adapter-private. Declared review denial, tool failure, unknown-effect,
cancellation, or provider-failure conditions stop the current run with a typed suspended or
terminated mission outcome for the authenticated host. User, project, explicit CLI, prompt, model, hook, and
MCP content cannot create or expand mission authority; schedule or budget violations fail
closed. The effective non-secret mission is returned in headless initialization and stored
with the durable session header. It must match on resume and cannot be changed by an in-place
configuration update; changing authority requires a newly authenticated session.

Mission turn, tool-call, and duration budgets are cumulative across the complete mission,
including resumed processes and cleared conversation context. Tool-call batches are reserved
and durably journaled before validation, review, or execution, so denial, invalid requests, or
process restart cannot replenish the budget. Duration begins with the first durably authorized
mission turn rather than with each individual model turn. The earlier of mission expiration
or duration exhaustion arms an active cancellation boundary for provider, memory, hook, and
tool work; the terminal failure retains the mission identity, declared condition, and cause.
If cumulative duration expires while idle, the next authenticated submission is rejected
under the declared budget-exhaustion condition before another turn ordinal is consumed.

Headless initialization freezes an authenticated execution snapshot identified by
`execution_manifest_id` and safe `host_origin`. `allowed_capabilities` can ceiling tools,
steering, attachments, memory, and MCP; omitted values retain all five. The only supported
`disconnect_policy` is `cancel`. The initialized response and durable session record expose
the non-secret snapshot, including the primary route, credential reference, workspace,
application-policy fingerprint, and persistence. Resume requires the same host identity,
scope, policy, and capabilities. If the original host policy is unavailable, opening the
durable session fails with `execution_manifest_required` and waits for a compatible host
initialization; it never substitutes current saved defaults.

Each MCP server may set independent `connect_timeout_ms`, `list_timeout_ms`,
`call_timeout_ms`, and `shutdown_timeout_ms` bounds. `credential_env` supplies a bearer
token reference; `header_env` maps non-reserved HTTP header names to environment-variable
references. Literal credentials and endpoint user-info are rejected. `/mcp` and health
views expose transport, trust, credential/header references, state, negotiated revision,
and redacted failure code without resolving or displaying secret values.
Initialization negotiation, the `notifications/initialized` acknowledgement, discovery,
calls, and shutdown are all independently bounded. Failed initialization closes the
partially opened transport. A failed `tools/list_changed` refresh serializes behind any
prior refresh, revokes the now-stale generated tools, and degrades only that server until
an explicit bounded reconnect succeeds. Shutdown and reconnect close capability admission
before transport cleanup; a late refresh result is discarded and cannot reinstall tools.
The stdio transport rejects already-cancelled work before writing protocol output, settles
all owned requests when its process fails or the transport closes, and removes their abort
listeners at every terminal edge. Once terminal, it rejects new calls instead of writing to
a dead child process.
For negotiated stateful Streamable HTTP revisions, shutdown sends a bounded authenticated
`DELETE` carrying the session identity. The identity is then discarded locally; a failed or
timed-out close remains visible as the closed connection's redacted `lastError`.
An in-flight transport failure or timeout revokes that server's generated capabilities and
moves it to `degraded` or `failed`; a valid remote tool error does not falsely poison the
connection. Explicit reconnect uses bounded cancellation-aware backoff and never replays the
failed call, including calls whose external effect is unknown.

`reviewer_ledger.retention_entries` bounds retained private review operations from 1 to
100,000 and defaults to 10,000. Once a completed operation crosses the limit, the reviewer
atomically rebuilds its hash-chained journal from the newest retained proposals,
decisions, execution starts, and terminal outcomes. Expired entries are physically
removed rather than hidden only from the audit view.

Each provider profile may declare known `context_limit_bytes` and `output_limit_tokens`.
The latter caps every route request using that profile. Each role route accepts
`provider_id`, `model`, an optional model-specific `context_limit_bytes`, `required_capabilities`, `temperature`,
`max_output_tokens`, `deadline_ms`, `budget`, and an ordered `fallbacks` list of role
names. Fallback graphs are bounded and cycle-checked. A candidate conclusively lacking
a required capability is rejected before inference, and fallback cannot silently cross
from loopback or private-network context to a less trusted destination.
Omitting `provider_id` and `model` from a non-primary role means no dedicated profile is
assigned. The resolved role follows Primary without serializing a false assignment. The Console
expresses the same operation as “No dedicated profile” or `/provider ROLE clear`. Attachment
admission remains Primary-first and uses an assigned Vision profile only when Primary cannot
process the image.

The global `context_limit_bytes` remains an independent safety ceiling. Before provider
work, NNA queries a short-lived provider-neutral runtime snapshot. LM Studio endpoints use
`/api/v1/models`, then `/api/v0/models`, then generic `/v1/models`; the loaded
`context_length` is treated as a per-request window and is never divided by `parallel`.
The reported parallel value only caps scheduling beneath NNA's configured concurrency.
NNA reserves the route's bounded output allowance and triggers at the earlier of
`context_compaction_threshold` (default `0.85`) or the fixed 13,000-token safety boundary.
When token metadata is unavailable, the validated byte ceilings remain the conservative
fallback. Estimates and authoritative provider usage are never presented as equivalent.
A temporary `/model` override clears a stale profile-derived limit unless the selected
model is the provider profile's declared model.

Provider-specific limits remain part of the validated provider profile. Changing a
provider's model clears stale declared limits, preventing assumptions from one model from
being applied to another. The Console does not expose a separate global context-budget
control; the global value is an internal safety ceiling for unknown model metadata.

## WebSearch

WebSearch is global rather than tab-local. Its configuration lives at
`$NNA_HOME/config/web-search.json`, so Main, other conversations, subagents, and
non-TUI workflows use the same endpoint.

Use `/websearch` for the keyboard-driven manager. `/websearch URL` validates and
saves an existing SearXNG endpoint; `/websearch test`, `/websearch disable`, and
`/websearch deploy` are direct forms. The quiet aliases `/search-config` and
`/search_config` remain available.

NNA does not install Docker. Local deployment first verifies the Docker client,
daemon, Compose support, Linux-container mode, and port 8888. It then starts the
pinned SearXNG image on `127.0.0.1:8888` and saves configuration only after a JSON
search succeeds. Disabling or uninstalling NNA does not implicitly delete the
managed container data.

## WebFetch destinations

`web.fetch` permits bounded public HTTP(S) text by default. Loopback, private-network,
link-local, and reserved destinations are blocked to prevent model-controlled server-side
request forgery. An operator can deliberately trust an exact origin such as
`http://service.example:8080` with `/webfetch trust http://service.example:8080`; use `/webfetch revoke ORIGIN`
to remove it. `/webfetch` and the WebFetch entry in `/config` show the current allowlist.
Trust is exact by scheme, host, and port, is stored in `$NNA_HOME/config/web-fetch.json`,
and is not a subnet wildcard. DNS answers and every redirect target remain revalidated.

## Telegram gateway

`/gateway` opens the Telegram manager and is also listed by `/config`. Bot configuration,
authorized numeric user IDs, workspace, enablement, and polling bounds are global rather
than tab-local. Specialist roles with no assigned provider profile inherit Primary for
gateway turns. Full setup and lifecycle behavior are documented in
[TELEGRAM_GATEWAY.md](TELEGRAM_GATEWAY.md).

When multiple sources are assembled programmatically, lowest-to-highest precedence uses
recursive object merge and array/scalar replacement. The winning source is recorded per
canonical effective leaf. Values supplied by the user manifest, trusted project,
explicit manifest, environment, or CLI retain that source label; values introduced only
by resolution are labeled `compiled_default`. Provenance records paths and source names,
never configuration values or resolved secrets. Runtime `configuration_update` uses a complete manifest and publishes an immutable
version at idle or the next model-step boundary. Workspace, persistence, and MCP changes
require a new session.

In the Console, `/workspace PATH` applies this rule by opening a new conversation rooted
at the canonical directory. NNA recomputes exact-workspace trust, project settings,
project guidance and hooks, tool roots, and project MCP eligibility before starting the
new engine. The existing conversation is not mutated and remains independently usable.

Default key bindings are documented in [TUI.md](TUI.md). Conflicting bindings fail
validation; unknown action names fail validation; cancel, help, and reset actions must
remain reachable. Configurable action names are `submit`, `newline`, `cancel`, `help`,
`allow_once`, `deny`, `reset_keys`, `undo`, `toggle_activity`, `new_tab`, `close_tab`,
`previous_tab`, `next_tab`, `cycle_review`, `scroll_page_up`, `scroll_page_down`, and
`scroll_bottom`. Help shows every effective binding, and F12 remains a fixed emergency
reset path even when `reset_keys` is customized. The emergency path remains active in
menus and permission views and atomically persists an empty override map, so defaults stay
restored after restart. Custom bindings remain a validated manifest concern; the Console
does not expose them as ordinary runtime settings.

## Runtime environment

Runtime environment values are a small, typed interface rather than an unstructured
configuration source:

- `NNA_HOME` selects the application-data root and must be an absolute path. It is
  resolved before the default manifest path.
- `NNA_PROVIDER_ENDPOINT` and `NNA_MODEL` form a first-run onboarding pair. Both must be
  present together. They do not replace an existing manifest.
- `NNA_REDUCED_MOTION` accepts only `0` or `1`; `1` disables nonessential Console
  animation. Any other non-empty value fails startup instead of being coerced.
- Presence of the conventional `NO_COLOR` variable disables Console color.

Explicit command-line choices take precedence over manifest presentation choices. The
two safety/accessibility environment controls can only reduce presentation: `NO_COLOR`
disables color and `NNA_REDUCED_MOTION=1` disables motion. Provider and MCP credential
fields contain environment-variable *names*. Secret values are resolved only at the
transport boundary by the adapter for that exact profile and are never merged into,
displayed with, or persisted in effective configuration, request bodies, events,
transcripts, or typed errors. A profile cannot receive another profile's credential.

`/health` and support bundles include a value-free `network_destinations` inventory. It
identifies every configured provider, enabled MCP transport, telemetry target, WebSearch
endpoint, governed dynamic network/process tool, loaded hook, and active extension with
its purpose, state, trust zone, and credential-reference name where applicable. Dynamic
tools show `per_request` or `process_arguments` instead of inventing a fixed destination.
Telemetry destinations must be bounded credential-free HTTP(S) URLs; this candidate still
ships no telemetry exporter. The inventory makes configuration inspectable but does not
replace exact-candidate packet capture for the default-egress release gate.

Installed application state defaults to `$HOME/.nna` on Linux and `%USERPROFILE%\.nna`
on Windows. `NNA_HOME` may select another absolute directory. This is an application-data
location and does not replace the manifest `workspace_root` tool boundary.

Bare `nna` and `nna tui` use `$NNA_HOME/config/manifest.json` when `--manifest` is absent.
On first use, `NNA_PROVIDER_ENDPOINT` and `NNA_MODEL` may provide the initial pair; both
must be set together. Otherwise NNA probes only fixed loopback OpenAI-compatible endpoints
on ports 11434, 1234, 8000, and 8080 before asking interactively. The validated generated
manifest is written with user-only permissions and is never silently overwritten.

## Interactive configuration

Use `/config` in the Console as the keyboard-driven configuration hub. Selecting an entry
opens its focused manager: provider profiles and role routing, conversation-local model
selection, MCP topology, SearXNG, or workspace trust. Esc returns from a manager to the
hub when it was opened there.
Memory service policy, attachment admission, recovery behavior, deadlines, concurrency,
and context safety ceilings are not presented as ordinary user toggles.

Use `/provider` to add, edit, test, and safely delete provider profiles from its Primary role tab,
and use the specialist tabs to assign an existing profile to reviewer, subagent, or vision.
Add and edit remain inside the provider manager: choose LM Studio, Ollama, or another
OpenAI-compatible endpoint; complete the guided fields; then choose from the endpoint's
discovered model catalog. If discovery is unavailable, the same form offers bounded manual
  model entry. Provider credentials are referenced by environment-variable name and are never
  entered as raw secret values in the profile form.

The native installers provide a first-profile bootstrap before WebSearch and gateway
setup. When no provider profile exists, they request the endpoint and an optional API
key, query the endpoint's OpenAI-compatible `/models` catalog, enumerate the returned
models, and accept either a list number or exact model identifier. The API key is read
without terminal echo and never enters process arguments or `manifest.json`. When one is
provided, it is kept in the permission-restricted
`$NNA_HOME/config/provider-credentials.json` store and injected only into the fixed
`NNA_PROVIDER_INITIAL_KEY` reference used by that initial profile. A blank key creates an
unauthenticated profile. Subsequent installer runs detect the existing profile and skip
the entire bootstrap without modifying it.
Clear a specialist assignment with “No dedicated profile” or `/provider ROLE clear`. Profile
mutations are available only from Main. Deletion is blocked while an explicitly assigned role in
any open conversation references the profile.
Canonical manifest writes are atomic and preserve the prior file as `settings.json.bak`.
Use `/model` for a conversation-local model override. Use `/mcp` to add, test, enable,
disable, and delete Streamable HTTP or stdio MCP server definitions. MCP topology changes
require a new conversation or restart because the callable tool set changes.

Enabling memory activates NNA's memory integration, but does not install or configure a
memory service. NotNativeMemory hooks and an MCP memory server are separate integrations;
the user must explicitly configure the relevant endpoint or adapter. In the Console,
`/memory` inspects project-scoped records and adapter health, `/memory save TEXT` performs
an explicit secret-screened save, and `/memory delete ID [EXPECTED_VERSION]` performs a
guarded deletion.
