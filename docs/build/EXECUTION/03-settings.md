# C — Complete native configuration coverage

Working evidence: [settings-coverage.json](settings-coverage.json) is the C1
source census. Its rows carry live disposition state; it does not establish GUI
or installed coverage except where the install column says otherwise.

Incremental implementation: the providers page now consumes native
`GET /v1/nnd/setup/status` and explicit `POST /v1/nnd/setup/activate` through
the authenticated NND proxy. Native execution readiness leaves provider connectivity
unchecked. Missing or invalid manifests require independent NNA setup; generic GUI
repair, revision-checked save and complete setting coverage remain required work.
See the execution ledger for audit and verification status.

Status: planned migration, audited against NND `20261001-41` and NNA
`20261001-6` on 2026-10-01. This guide specifies work; it does not certify
that the APIs, controls, or installation acceptance below already exist.
Paths beginning `src/` in the NNA column belong to `NotNativeAgent`;
`packages/` paths belong to `NotNativeDesktop`.

## Outcome and ownership

Every supported operator-configurable NNA setting must be discoverable and
configurable from the NND GUI, with its actual scope, effective value,
authority, and activation behavior. This includes NNA TUI preferences in a
separate NNA TUI settings page; it does not merge TUI tabs or sessions into
NND. Browser and desktop use the same authenticated NND service contract.
NND appearance/device preferences remain NND-owned. NNA remains the sole
owner of NNA validation, configuration persistence, secrets, and runtime
application. NND must never write NNA files directly to fill an API gap.

“All settings” includes stores outside `manifest.json`, environment and
launch overrides, and optional installed integrations. Internal runtime
state, generated version markers, security invariants, and host-granted
authority are inventoried but are not made arbitrary editable settings.
A read-only explanation is appropriate for an invariant or externally
managed source; an editable native feature without a GUI mutation contract
is an open MVP gap, not a completed read-only feature.

## Confirmed existing gaps and consequences

| Finding | Concrete consequence | Required repair |
| --- | --- | --- |
| `packages/web/src/server/lib/mcp/mcp-config.ts` writes `OPENCODE_CONFIG_DIR` or `.opencode/opencode.json`; `routes/mcp-config.ts` returns “Restart OpenCode to apply.” | An NNA operator saves MCP settings successfully but NNA never consumes them. | Replace the NNA path with native NNA storage/activation contracts and reconcile existing drafts explicitly. |
| `packages/ui/src/components/settings/pages/mcp.tsx` combines that editor with a separate read-only `mcp-inventory.tsx`. | Configuration and runtime rows can describe different servers under one settings page. | Render native persisted configuration and runtime observations with stable shared identities and revisions. |
| `src/integration-cli.js` calls `resolveManifest` on the user manifest, while `src/startup-configuration.js` resolves trusted project and explicit sources. | The GUI can report a user setting as effective even when an equivalent TUI context resolves another value; project settings may never reach NND engines. | Unify the NNA resolver for equivalent workspace contexts while preserving authenticated surface-specific constraints. |
| Existing provider UI exposes basic profiles and primary/subagent selection; `src/configuration-shape.js` defines four roles and many additional fields. | Reviewer/vision configuration and route limits remain inaccessible despite a seemingly complete provider page. | Add complete native route/profile controls, including inheritance and unset semantics. |
| `src/integration-server.js` provider writes do not accept an expected revision. | Two browser windows can overwrite each other's changes without a conflict signal. | Add durable revision compare-and-swap to the native mutation contract and all competing writers. |
| TUI configuration publication persists a manifest transformed from resolved workspace configuration into its user/explicit source path. | A route edit can persist trusted project settings or temporary launch overrides in the user manifest. | Carry raw selected-source bytes/revision and typed mutation intents; resolve overlays separately from persistence. |
| Onboarding parses before migration/quarantine, and provider bootstrap compensates for any persistence failure by deleting the created secret. | A competing replacement can be quarantined; a save failure after rename can leave a committed provider reference to a deleted secret. | Hold one native transaction across reread/validation/publication and distinguish unpublished failure from saved-but-not-applied outcomes. |
| `runtime-config.js` supports immediate/pending engine updates, while provider activation in `integration-cli.js` changes defaults for newly created engines and leaves existing sessions unchanged. | “Saved” or “Applied” alone conceals which work actually uses the setting. | Distinguish persisted, service-default, pending, and session-effective revisions. |
| NND `lib/settings/registry.ts` governs NND preferences, not the NNA configuration surface. | Adding native fields there creates another persistence authority without configuring NNA. | Keep a separate native schema/client and use the NND registry only for presentation preferences. |

## Mandatory census before claiming completeness

The following is a verified family-level starting census, not a completed
key-level inventory. C1 must expand every family into concrete keys/actions,
including dynamically keyed records, credential variants, and current CLI
options. Compare source, operator documentation, CLI/TUI commands, persisted
stores, and integration permissions; no single manifest represents all of NNA.

| Family | NNA source of truth to inspect | Required GUI treatment |
| --- | --- | --- |
| Manifest format and migrations | `src/config.js`, `src/configuration-shape.js`, `src/persistence/manifest-migration.js` | Show schema compatibility; migrate through NNA; do not offer format/version counters as free numeric inputs. |
| Provider profiles | `src/provider/profile-store.js`, `src/config.js`, `src/credential-bindings.js` | Identity/name, endpoint, model, trust zone, credentials, context/output limits, tool-call mode, all capabilities; deletion and references. |
| Role routing | `src/provider/route-configuration.js`, `src/config.js`, `src/provider/reasoning.js` | Primary, reviewer, subagent, vision; assignment/inheritance, provider/model, capability requirements, fallbacks, timeout, temperature, output, budget, reasoning effort/thinking. |
| Execution defaults | `src/config.js`, `src/config-bounds.js` | Provider/connect/first-token/idle/reviewer/approval timeouts, provider/tool concurrency, queue limits, persistence flush/shutdown bounds. |
| Context and recovery | `src/config-context.js`, `src/config-bounds.js`, `src/config.js` | Context limit, compression levels/compaction threshold; step bound, retry limit/ladder, wall-clock limit. Preserve null/zero/unset meaning per native validator. |
| Workspace, persistence, application policy | `src/config.js`, `src/startup-configuration.js`, `src/configuration-sources.js` | Scope selector, persisted/effective provenance, trusted project overlay, application system prompt; workspace/persistence changes create new contexts. |
| Attachments and memory | `src/config.js` | Attachment enablement/size/retention; memory enablement/required/timeout/item/byte bounds and capability-derived effective disablement. |
| Dream maintenance | `src/dream-config.js`, `src/dream-coordinator.js`, `src/dream-store.js` | Enablement and supported idle/stage/inference/hygiene/retention controls; show state separately from settings. |
| MCP | `src/config.js`, `src/configuration-shape.js`, `src/mcp-credentials.js` | Both transports, enablement, commands/arguments/cwd or endpoint, individual deadlines, effects, trust/protocol and credential/header bindings. |
| Skills and hooks | `src/skill-registry.js`, `src/skills-cli.js`, `src/hook-manifest.js`, `src/hook-runtime.js`, `src/startup-configuration.js` | Bundled/user/trusted-project inventory; supported install/remove/edit/enable actions, validation and discovery diagnostics; hosted inline skills remain host-authorized. |
| TUI preferences | `src/config.js` (`validateTui`), `src/experience/key-bindings.js`, `src/environment-settings.js` | Reduced motion, color, validated key bindings; separately label TUI-only effects and environment precedence. |
| Telemetry and retention | `src/config.js`, `src/config-bounds.js`, `src/persistence/retention.js` | Telemetry enablement/destination/retention, reviewer-ledger retention; distinguish exposed controls from fixed internal limits. |
| Session permission posture | `src/nnd-review-mode.js`, `src/nnd-operator-routes.js` | Existing session-scoped Default/Auto-review/Unattended selector and CAS; mandatory review stays active; no fabricated Full control mode. |
| Mission and host authority | `src/config.js`, `src/execution-policy.js` | Mission bounds/expiry/termination and authenticated-host capability/tool/disconnect grants are typed authority operations or read-only inherited state, never a generic editable policy blob. |
| Secrets and credential bindings | `src/secret-broker-server.js`, `src/secret-broker.js`, `src/secret-management.js`, `src/credential-bindings.js` | Scoped metadata, create/rotate/delete and binding operations through NNA; reference checks and redacted status; never expose vault/master-key files. |
| Workspace trust | `src/experience/trust.js`, `src/tui/trust-command.js` | Canonical workspace trust/revoke, consequences for project configuration/skills/hooks; never infer trust from merely opening a folder. |
| Web search | `src/web-search-config.js`, `src/web-search-cli.js` | Enablement, bounded SearXNG profile list, identity/name/endpoint, primary order, managed installation status/actions. |
| Web fetch | `src/web-fetch-config.js`, `src/web-fetch-cli.js` | Exact trusted origins, add/remove/reset; origin scope and native validation. |
| Browser capability setup | `src/web-browse-cli.js`, `src/web-browse-tool.js`, `src/product.js` | Supported managed Playwright setup/status/actions; runtime browser state is not a freely editable setting. |
| Gateway | `src/gateway/config.js`, `src/gateway-cli.js` | Enablement, credential source, authorized user IDs, workspace, polling timeout, lifecycle; never return the stored bot token in a normal read. |
| Existing OpenCode compatibility service | `src/opencode/config.js`, `src/product.js` | Clearly identified optional NNA compatibility service: enablement/bind/port/credential settings; it is not the NND execution backend. |
| Product/service/integration installation | `src/product.js`, `src/nnd-package.js`, `src/integration-cli.js`, `src/nno-integration-activation.js` | NNA home/instance, package registration, service account/start behavior, optional NNO activation; privileged lifecycle changes use L-series contracts. |
| Updates and provider dialects | `src/update-cli.js`, `src/update-service.js`, `src/reliability/model-dialects.js` | Inventory actual operator controls and actions, update status/channel if supported, dialect management if supported; generated discoveries/state are not automatically writable. |
| Environment and invocation overrides | `src/cli-options.js`, `src/onboarding.js`, `src/environment-settings.js`, `src/product.js`; repository-wide environment reads | Include NNA_HOME, onboarding provider/model inputs, terminal environment and credential references; show source and service-effective presence without revealing values of secrets. |

C1 must also inspect NNA `src/product.js` path inventory for stores missed
above (including legacy provider/MCP credentials), plus all `src/cli.js`
dispatches and TUI commands. Mark each discovered item as operator setting,
operator action, generated state, authority grant, compatibility alias, or
internal invariant. Record a reason for every noneditable item. An optional
dependency's absence changes availability, not the coverage obligation.

## Native contract requirements

These contracts are **proposed**, except the existing provider, inventory,
and review-mode endpoints described above. Agree exact names/versioning in
L1 before implementing; do not call these routes and assume they exist.

Suggested native boundary: schema/catalog read, scoped configuration read,
validate/preview, revision-checked mutation, application-status read, and
configuration-changed events. Dedicated secret, trust, package, and service
operations retain narrower contracts; do not tunnel arbitrary file edits
through a general settings route. NND's authenticated server translates
browser intent to the installed NNA principal; browser-supplied permissions
or filesystem paths cannot manufacture authority.

Each catalog entry must define stable ID, family, type/bounds/enumeration,
default/unset semantics, sensitivity, legal scopes, required permission,
editable status/reason, validation dependencies, activation class, and
compatibility version. The form must preserve explicit false, zero, empty,
null, and absent when the native contract distinguishes them. Arrays need
stable native identities/order semantics; indexes alone are not durable IDs.

A scoped read must identify NNA instance, workspace where applicable,
source revision, persisted explicit value, effective value and source,
overridden sources, and session-effective/pending revision when requested.
Source names must come from the native resolver. A service environment is
not assumed to match the interactive operator's environment. Inherited
values have a reset-to-inherit action; resetting must not serialize today's
default as a permanent override.

Mutation requests bind exact instance, scope, expected revision and unique
operation ID. NNA authenticates authorization and canonical workspace,
checks conflicts, validates the resulting configuration, and atomically
persists it before publishing success. The expected revision includes
external/TUI writers; an in-memory counter in one HTTP process is insufficient.
Duplicate operation IDs return their original outcome; a changed payload
under the same ID is rejected. Bound retained receipts and document expiry.

Return separate persisted revision, application outcome, effective revision,
affected scopes/sessions, warnings, and any required next action. A failure
after durable save must report saved-but-not-applied, with recoverable native
status; never hide it behind a generic failure that encourages blind retry.
Multi-store operations must either have a native transaction/recovery design
or be explicit independent operations with per-operation receipts.

Activation classes are derived per field from the native implementation:
immediate; next model step; new session; service restart; new TUI invocation;
or external-source change. `src/runtime-config.js` currently rejects runtime
changes to workspace/persistence, MCP, execution manifests, and mission.
Its accepted pending update is not proof that every manifest field has a
live applier. Trace every field to its consumer before advertising hot apply.
Do not silently restart a service or migrate running contexts after Save.

Secrets have set/replace/clear operations and redacted configured/source
status. Never round-trip masked placeholders as secrets. Keep secret input
out of localStorage, ordinary settings stores, event payloads, diagnostic
bundles, analytics, and error echoes. Native secret references remain scoped;
readable metadata does not grant secret use. Raw endpoint/header/command
data is disclosed only to authorized configuration views, not work projections.

## Executable work packages

### C1 — Key-level census and contract ledger

Dependency: L1 architecture/contract decisions. Read every authority above
before coding. Create a machine-readable native coverage ledger and reviewed
rendered report with one row per setting/action: source path and validator,
persistence owner/path class, precedence, legal scope, permission, secret
classification, apply class, native endpoint, NND control, tests, status.
Compare accepted keys/CLI options to the ledger in CI; a new native key must
fail coverage until classified. Preserve aliases/migration keys explicitly.
Exit: no unclassified current setting; all omitted controls are open work or
justified noneditable invariants. Family counts alone cannot close C1.

Progress: the census lives in this directory, and the C1 gate
(`scripts/settings-coverage-gate.mjs`) now enforces the manifest census rows
against the NNA classified configuration catalog and the two option modules'
dashed CLI option literals in both directions. Release gates run it when
`NNA_SOURCE_ROOT` names the paired NNA checkout; without it the seal reports
the coverage check as skipped, which is an unverified gate. Census
classifications were regenerated at NNA `20261005-13`; hermetic failure-path
tests live in `scripts/settings-coverage-gate.test.mjs`. Enforcement scope is
still narrower than the exit: positional subcommands, environment reads, and
non-manifest stores stay in the census's remaining list until the gate
reaches them.

### C2 — Native resolution and concurrency foundation

Dependency: C1 and L2 persistent runtime baseline. In NNA, reconcile
`integration-cli.js`, `startup-configuration.js`, `configuration-sources.js`,
`runtime-config.js`, and `provider/profile-store.js` around native scoped
reads/validation/CAS/application receipts. Preserve trusted-project admission
and distinct TUI/NND session ownership. Implement the approved schema and
revision contracts with the same validators used by existing native writers.
The authenticated configuration control plane must run in L2's setup/repair state
without a valid manifest, configured provider, or live session engine. Restrict
operations there to native setup/repair authority; no execution fallback. Preserve
invalid originals and require explicit repair rather than overwriting on read.
Exit: two writers conflict correctly; service restart retains saved revision;
equal workspace/sources resolve equally across TUI and NND; scope exceptions
are explicit and tested rather than duplicated accidental resolver behavior.

### C3 — NND settings transport and presentation foundation

Dependency: C2. Extend `packages/web/src/server/harness/nna.ts` and authenticated
route wiring; add a typed native-settings client beside
`packages/ui/src/lib/nnd/client.ts`. Extend settings `window.tsx`, `search.ts`,
and native page components without adding NNA keys to NND preference storage.
Display source/scope, explicit versus effective value, save/apply status,
conflicts, validation errors, unsupported version, and unavailable service.
Guard late results by instance/workspace/request generation; preserve drafts
on conflicts but require refresh/reconciliation before resubmission.
Exit: browser and Electron controls exercise real native contracts; no
optimistic “Applied” before native confirmation; keyboard/search accessible.

### C4 — Providers, credentials, routes, and engine controls

Dependency: C3. Expand `pages/providers.tsx`, `provider-profile-editor.tsx`,
`provider-route-action.tsx`, `provider-route-activation.tsx`, and
`subagent-route-editor.tsx`; add reviewer/vision and advanced native fields.
Complete execution/context/recovery/attachments/memory/dream/telemetry and
retention families. Use native defaults and per-field application classes.
Integrate secret operations and references rather than environment-name-only
inputs. Retain `chat/review-mode-control.tsx` as a distinct session operation.
Exit: every C1 entry in these families has successful, rejected, reset,
conflict, persistence, and application evidence where applicable; changing
reviewer settings still exercises the mandatory reviewer on real work.

Current NND GUI coverage is narrower than this exit gate. The native
configuration page can read the catalog and edit NNA-authorized generic scalar
fields through preview, revision-checked save, and operation receipt lookup.
It now offers direct typed controls for `attachments.enabled`,
`attachments.max_bytes`, and `attachments.retain`; native TUI preferences and
reviewer/vision scalar routes also have focused controls: the routes page
offers seven typed scalars for each of those two roles, plus one paired
provider-and-model binding per role that previews both values before a
`bind_route` save. The route scalars NNA advertises but that page does not
tune — the primary and subagent limits, and the reviewer and vision
capability and fallback lists — ride the catalog-gated chooser on the native
configuration page. NNA leaves the primary and subagent provider/model pair
uneditable and treats no route object as a value, so those eight census rows
stayed open at that date rather than by omission (`20261007-60` later closed the
four route-role containers through their self-complete member card; the
today-open set is `manifest:mission` only, disowned with `owed: false` on the
one-legal-value rule). Route rows show an inherited
value with an `Unavailable` origin instead of a guessed layer, and a saved
zero keeps its explicit `0` while the effective deadline resolves to `null`,
because zero means no deadline rather than a length of zero. The three
attachment rows carry NNA's semantics verbatim: enablement is opt-out (only
an exact `false` disables), retention is opt-in (only an exact `true`
retains, otherwise the store deletes files after the turn), and the byte
ceiling defaults to 10 485 760 within 1 024–104 857 600. All three are
`engine_boundary`: a compatible command republishes the engine
configuration, so the next admission and the next cleanup see the new
values without restarting the session. Typed controls for
`memory.timeout_ms`, `memory.max_items`, and `memory.max_bytes` use the same
native user-manifest preview and save path, alongside `memory.enabled` and
`memory.required`, which NNA saves as a coupled pair (disabling memory also
clears required; requiring memory also enables it) and the editor says so
before the preview. The five rows carry NNA's bounds verbatim
(`timeout_ms` 50–30 000 default 750, `max_items` 1–64 default 8,
`max_bytes` 1 024–262 144 default 16 384) and are `engine_boundary`
settings: an accepted compatible configuration command applies immediately
while the engine is idle and otherwise at the next model step. The provider scheduling limits
`provider_concurrency` and `provider_queue_limit` also have bounded controls
when NNA advertises them. Dream maintenance enablement, idle/stage delays,
and retention also have typed controls gated by the native catalog, bounded
exactly as the engine bounds them (`idle_ms` 5 000–3 600 000 default
45 000, `inter_stage_ms` 1 000–300 000 default 5 000, `inference_idle_ms`
10 000–3 600 000 default 120 000, `hygiene_idle_ms` 30 000–7 200 000
default 300 000, `retention_days` 1–365 default 30; out-of-range values
refuse the whole resolve with `invalid_limit`). NNA can
still disable dream maintenance through host authority; a saved user-manifest
value is not applied to an existing constructed context. These controls do not
assert that running sessions adopt saved values. Provider connection and
semantic-review timeouts also have bounded native controls. Global provider
timeout and primary route deadline controls preserve NNA's zero-disables and
primary-route override semantics; preview shows both effective values before
the same revision-checked save. First-token and idle timeout controls offer
zero (disabled), reset (inherit), and unambiguous fixed values. They decline
the exact legacy sentinels (30s/45s) and the 600s/300s default pair values
because NNA can reinterpret them as inherited; preview shows both effective
stream timeouts before the same revision-checked save. Recovery model-step and
local-retry budgets have bounded controls when NNA advertises
`recovery.max_model_steps` and `recovery.local_retry_limit`. NNA preview validates
the retry limit against its configured recovery ladder before save. The ladder
and recovery wall-clock limit remain generic JSON controls. The ladder takes
only `nudge` and `compact`, at most four entries, and NNA stores just the
first `local_retry_limit − 1` steps, so the effective ladder can be shorter
than the declared one; the wall clock is unset by default, where `null` and
`0` both mean unset. All four recovery rows keep an `unverified` application
class, matching NNA's own catalog metadata: the step loop reads the budget
and wall clock from live engine limits at each entry, while the recovery
supervisor fixes its limit and ladder at construction. The three telemetry
rows are opt-in (`enabled` only on an exact `true`), refuse to enable
without a string destination (`telemetry_destination_required`), and resolve
destination and retention to `null` while telemetry is off even when the
source declares values. The native projector serves the destination string
in the clear, so the row keeps its private sensitivity label; the settings
inventory renders all three, and none claims an application moment because
no NNA runtime path consumes the block. Approval wait,
persistence flush, and shutdown timeouts have bounded controls gated by the
native catalog. Their save receipt does not claim application to running
work or to the running service, nor does approval wait change permission
scope. The root context byte ceiling and four compression/compaction thresholds
have catalog-gated typed controls; preview displays the complete ordered
threshold set and NNA rejects an invalid ordering. Provider and route limits
can further constrain the actual context window, and Save does not apply these
values to running work. Reviewer-ledger retention has a bounded catalog-gated
control for
`reviewer_ledger.retention_entries` (1–100,000). Its preview and save use the
native revision-checked path; a saved receipt does not change running work or
execution authority. The default is 10 000 entries; the engine reads the
budget once when it builds its reviewer ledger and compacts settled reviews
beyond it at the next write, and any other key inside the block is refused
with `reviewer_ledger_config_invalid`. Older NNA releases can evict unfinished reviews when the
limit is exceeded. Repaired NNA releases preserve unresolved reviews through
compaction, including those with an uncertain external effect. The NND
configuration view does not expose a trustworthy NNA product version, so this
control carries a compatibility warning instead of claiming that every
connected NNA preserves them. Telemetry stays in the generic
editor because NNA does not yet ship a telemetry exporter. Other execution
and context scalars remain generic JSON controls without complete
family-specific UX or installed application evidence. `tool_concurrency` joined
the provider scheduling block as a focused control at `20261010-1` (bounded 1–16
mirroring `configuration-rules.js`); the full UI suite ran green in-session at
`20261010-2` and covers it.
Where NNA derives a value rather than reading it from the manifest, the view
shows the value with an `Unavailable` origin instead of guessing a layer —
the global provider timeout follows the primary route deadline, the idle
stream timeout stays derived even when the first-token half is set by hand,
and the second and third compression thresholds follow compression plus
three and six sevenths of the span to the compaction threshold. Half of
these scalar rows carry an `engine_boundary` application class in NNA's
catalog metadata (a republished configuration reaches the limits the engine
reads for its next turn or request, and the reviewer timeout, permission
timeout, and scheduler capacity are pushed directly); the tool-concurrency,
flush, shutdown, and five context rows stay `unverified` because NNA
declares no class for them. Provider profile rows are served by the same
view: the desktop displays the resolved identity, trust zone, limits, and
capability probes (unknown until NNA observes them), and the configuration
contract itself offers no provider writes. A credential reference in any shape
arrives `redacted` and is never carried as text, and the inventory labels it
`Redacted` rather than leaving a blank cell that reads like a missing secret.
Provider profiles are nonetheless writable natively, just not here:
`POST /v1/provider-profiles` and `PATCH /v1/provider-profiles/:id` rewrite the
same manifest through the same locked transforms, gated on
`provider.profile.write` or `provider.manage`, and they accept `display_name`,
`endpoint`, `model`, `context_limit_bytes`, `output_limit_tokens`,
`tool_call_mode`, a credential binding, and `profile_id` on create. No native
write accepts `trust_zone`, and capability rows are derived state that nothing
writes. Either way a saved profile applies because a published configuration
rebuilds the model router, so the next request uses it.

Reading a binding was a different gap, and a total one: the thirteen provider rows
describing `credential.source`, `credential.name`, `credential.secret_id`,
`credential.field`, the credential and capability containers and the
`credential_env` alias had `native_endpoint: null`, so no surface could answer
"which credential is this provider bound to" without opening `manifest.json`. NNA
`a026763e` (`20261007-1`) opens
`GET /v1/nnd/configuration/provider-observations` for exactly that. It resolves the
manifest through the same `readManifestSnapshot` plus `resolveManifest` path the CLI
uses and projects each binding with `credentialManifest`, so the response carries
`source` with an environment name, or `source` with a secret id and field — the
place, never the value — and the projector refuses a key it does not whitelist,
including inside the capability flags. Trust zones are `config.js`'s own three
words, and the catalog's classification, intent and sensitivity are transcribed
from `configuration-catalog-metadata.js` rather than invented: credential and
capability paths are `container`, `credential_env` is the `compatibility_alias` it
has always been, and the binding leaves carry `credential_reference`. Writes are
not this route's to own, so all thirteen fields report
`editability: unavailable, reason: manifest_transaction_owns_writes`.

The desktop renders nothing from it yet. The rows therefore gained an endpoint, a
permission and a walked proof, and kept `current_gui.path: null` — the count of
rows without a surface stays 37 because nothing was rendered to earn a change.
Their application class moved from `unverified` to `engine_boundary` on NNA's
declaration (`family(..., live, ...)` for the provider family), which is a
transcription of what NNA already says, not a capability this slice built.

That paragraph's first sentence is superseded the next slice, and stays quoted here
rather than quietly rewritten: "The desktop renders nothing from it yet." As of
`20261007-32` the desktop renders it, in
`packages/ui/src/components/settings/pages/provider-observation.tsx`, with
`packages/ui/src/lib/nnd/provider-observation.ts` mirroring the projector, so the
thirteen rows gained a GUI path and their status became verified. The claim was true
when written and is false now; sealed prose is corrected by the entry that follows it,
not by editing the entry.

What the panel shows per provider is exactly the thirteen fields: the model, the
endpoint, the trust zone, the binding as a reference (`secret <id> field <field>` or
`environment variable <NAME>`), the `credential_env` alias or `unset`, and the six
capability flags spelled out as yes or no. It never shows a value, and a test plants
`value: 'sk-secret'` in a response to prove the client refuses such a body rather than
rendering it. Two refusals here are stricter than NNA's own router, stated at the call
site so the desktop is never mistaken for NNA's contract: a present manifest listing no
providers, and any binding key beyond the reference grammar.

The provider-profile editor beside it writes the same family through
`POST /v1/provider-profiles` and `PATCH /v1/provider-profiles/:id`, and five of its rows
had been carried as "GUI exists" without anyone checking. Checking produced two rules
worth keeping.

A field that opens blank on edit is not necessarily missing. The endpoint and credential
fields start empty when editing an existing profile, which reads as a lost read-back and
is a redaction: the window test asserts the page never prints the stored secret's name.
The fix would have been to pre-fill it, and that would have been a regression.

And a claim needs the assertion on the path that makes it. The create flow typed a display
name; only the edit flow asserted the name reached the request. That gap is closed — the
create request is now asserted to carry the typed name — and it passed, which means the
field always travelled and was never verified, the cheapest kind of hole there is.

The same redaction discipline extends the editor at `20261010-2` rather than
superseding it. The editor now writes the whole binding family — an environment
reference, a Secret Broker reference chosen from the roster, and an explicit
clear — plus the bounded context and output limits and the tool call mode. What it
shows of any binding is its kind: never a name, secret id, or broker label, and
the roster itself renders anonymous numbered options, because a label is
operator-chosen text the page must not echo. A blank limit box keeps the stored
limit only while the model stays the same, and the editor says so on the form,
because NNA drops the limit for a model change that does not resend it.

The routes page tunes its seven reviewer and vision scalars through typed
controls from `20261010-3`, not a raw JSON textarea: a number input gated by a
client mirror of `configuration-rules.js` bounds, a checkbox for thinking mode,
and an effort select fed by the served catalog's own enum list. An
out-of-range or non-enum draft is refused before the preview wire, and a zero
deadline still means disabled, exactly as the engine reads it. The mirror is
declared a convenience, not authority: the engine revalidates on save, and the
catalog, not the form, decides what is offered.

### A family page is not a surface for every field in the family

`20261007-34` took eight rows apart and the headline went up by eight, because the rows
were not missing a surface: they never had one. Each named a real settings page for its
family, and none of those pages mentioned the field the row claimed. Six pages, grepped for
`.version`, `.provider`, `.managed`, `.format`: no occurrences.

The rule this leaves behind, stated for whoever writes the next row: **name the page only if
the field is on the screen, and cite the test that reads it off the screen.** A page that
forwards a field, validates a field, or refuses a frame over a field is enforcement, which
belongs in the evidence and not in `current_gui.path`. The census shows the correct shape
three times over — the hook list prints `v` and the bundle version, the skills list prints
the entry version, the installation panel prints the descriptor version with a test that
asserts it — so "we render it" is always checkable against a sibling, and a `status` left
`unverified` for many rounds is a signal that nobody ever looked.

The distinction earns its keep because these values are CAS guards: `version` exists so a
concurrent write fails loudly. Rendering it would satisfy a counter, not an operator, and
"close the row" is not a reason to build a panel.

The companion rule, settled by `20261007-35`: **a container is on screen only when everything
it holds is rendered in that unit.** The provider credential container closed because its
line carries the whole thing — source, secret id and field, or the variable name. A route
card that prints provider and model does not put `routes.primary` on screen: the route holds
thirteen members and the other eleven live in the editor below, so the four route container
rows stayed open at that date while their leaf fields closed (`20261007-60`
later closed them through the self-complete member card).

The other thing that slice corrected was a type that masqueraded as a domain fact.
`RoleBinding` accepted `'reviewer' | 'vision'`, inherited from NNA's
`NND_ROUTE_BINDING_ROLES` — a list of the roles the desktop may *rebind* through
`bind_route`, not a list of the roles that exist. `contracts.js` `ROLES` names four, and
`effectiveManifest` resolves and projects each one on every read, so an operator reading
route bindings is entitled to see Primary and Subagent too. Visibility and mutability are
different questions, and a page that confuses them hides half the system's configuration
behind a permission it was never gated by.

That also fixes the copy: a card must name the authority that can change what it shows.
Reviewer and vision point at the paired binding offered below; Primary and Subagent point
at the provider route authority (`PATCH /v1/provider-route`, `/v1/provider-route/subagent`).
Telling the operator that the editor below changes Primary would be false in a place where
false is expensive.

`20261007-36` settled the rest of that rule, and settled it from NNA's side rather than ours.
`MANIFEST_SHAPE_DESCRIPTORS` in `src/configuration-keys.js` already classifies every manifest
path: `kind: 'collection'` with an `identity` for `providers[*]` and `mcp_servers[*]`,
`kind: 'object'` for `attachments`, `memory`, `dream`, `tui`, `telemetry`, `reviewer_ledger`,
`recovery` and `mission`, and `finite-map` over `ROLES` for `routes.{role}`. The distinction
that matters for a surface follows from the kind, not from a preference:

- **a collection is on screen when the surface shows which entries it holds.** Membership is
  information no member field carries — an operator can see every field of the servers that
  exist and still not know that a fourth server was never written down. The provider list,
  the four role cards, and the native MCP server list all answer that question, so those
  three containers close.
- **a record is on screen only when its members render together.** A record has no membership;
  its fields are all there is, and scattering them across a settings page does not assemble them.

Two refusals belong to the same rule and are recorded because they were tempting.
`manifest.provider` is an alias whose effect *is* on screen — `resolveManifest` folds the
singular spelling into the same provider list the panel prints — but nothing says which
spelling the file used, and the row exists to track the alias, so it stays open. And
`providers` and `routes` keep `apply.class: unverified` even though their members have
declared classes, because `container()` supplies no application and neither declaration names
one: the container has no declared moment of effect, and a census that fills such gaps with
inherited vocabulary stops being evidence. Manifest container
rows (`providers`, `routes`, `attachments`, `memory`, `dream`, `mcp_servers`,
`tui`, `telemetry`, `reviewer_ledger`, `recovery`) and the `provider` and
`mission` roots stay open by rule rather than by case: NNA serves a container
with no printable value and declares no application class for it, so the
members carry the settings and each of those carries its own evidence. Of the
remaining manifest roots only `persistence` and the application system prompt
are offered for editing; `workspace_root` is displayed verbatim so the
operator knows which installation is shown, while a saved persistence or
workspace change names a new session instead of claiming a live one. The three
version stamps are displayed as the contract version in force and are
labelled unverified by NNA itself, because they record a contract rather than
an applied value. Provider identities,
credentials, authority grants, and external-store settings require separate
native contracts and acceptance evidence. The gateway external store now has
a dedicated polling-timeout control when NNA advertises its separate native
`/v1/nnd/configuration/gateway` contract. It reads only the timeout and selected
identity, requires a native preview and revision-checked save, and recovers
uncertain saves by operation lookup. A saved timeout needs a gateway restart.
Gateway tokens, authorized users, enablement, and other external stores remain
outside this control; installed browser and desktop acceptance is still due.

### C5 — MCP, skills, hooks, trust, and project configuration

Dependency: C3 plus C2 scope support. Replace NNA usage of
`routes/mcp-config.ts`, `lib/mcp/mcp-config.ts`, `lib/mcp-config-api.ts`,
`stores/useMcpConfigStore.ts`, and `pages/mcp.tsx` with native contracts.
Extend `pages/skills.tsx` and `skills-catalog.tsx` only through native skill
management; inventory existing NND companion skills separately where needed.
As of the NNA v12 contract, `/v1/nnd/mcp` is read-only inventory and the
configuration catalog does not offer mutation for `mcp_servers[*]`. NND must
hide its OpenCode MCP writer on an NNA runtime. C5 requires a scoped native
MCP preview/save/receipt API before the GUI can claim that a save changes NNA.
Add hooks/trust/project-source controls and supported native lifecycle actions.
Do not silently import OpenCode configuration: provide a preview, mapped and
unmapped fields, target scope, and an explicit operator import action.
Exit: an MCP save affects a newly created NNA session using the intended
server; project revocation removes subsequent project admission; no NNA
configuration write lands in `.opencode`; existing TUI sessions remain owned
by the TUI. Unsupported OAuth remains a recorded native capability gap.

### C6 — Non-manifest settings and independent TUI preferences

Dependency: C3 and lifecycle contracts where required. Complete web search,
web fetch, browser setup, gateway, compatibility service, native updates,
installation/environment settings, and supported optional integration setup.
Add a distinct NNA TUI preferences page; changing a TUI key binding must not
change NND shortcuts or open/close a TUI tab. Route privileged service changes
through approved native lifecycle operations with retained failure evidence.
Exit: every C1 external-store row has a working GUI operation or justified
noneditable classification; optional missing installations offer native setup
guidance/actions, not a misleading empty “configured” page.

Progress: at NNA `20261005-14` the gateway settings file left the CLI-only
world: the whole classified gateway settings family (enabled flag, Telegram
token with replace/clear-only changes, token environment name, workspace
root, polling bounds, authorized user allowlist) is native-first under one
CAS transaction at `/v1/nnd/configuration/gateway` with preview, save
receipts, bounded operation replay, and token-presence-only reads. NND ships
the typed client and a settings page covering the family's bounded
operations, and the census gateway rows now carry the native endpoints, the
paired permissions, and the settings-page path; the C1 gate re-verified the
census against the paired NNA catalog. Those rows are now closed: the six
operator fields are shown and edited on that page (the state line, the
checkbox, the prefilled token-environment name, the workspace root, the
bounded polling input, and the grant list with its own revoke control), the
token is present-only end to end — the projector refuses to emit the field,
the client refuses to model it, the replace control is a password input that
starts empty, and the suite asserts the secret never appears in the page text —
and the class records what the native catalog declares, `restart_gateway`, with
the read view answering `not_applied` and a saved receipt pointing at
`restart_gateway`. A declared point is not an observed one: an installed
journey that restarts the gateway is still owed to C7 and the L gates. The
update stamp is displayed rather than dropped, and an absent stamp says so;
the store's internal version counter is not shown at all, so that row keeps an
unverified surface instead of inheriting a claim no test supported. Web search,
environment and native update state were closed in later slices — as were hooks,
compatibility service, secrets, the optional integrations, and the distinct TUI
preferences page, each with its own dated slice — so the families this paragraph
once called remaining stayed open only at that date.

Progress: at NNA `20261005-15` the WebFetch trust family followed the gateway
template. The authority-grant list of exact credential-free HTTP(S) origins
(`config/web-fetch.json`, at most 64 entries, each at most 300 characters) is
native-first under one CAS transaction at `/v1/nnd/configuration/web-fetch`
with the 20261005-14 bounded-replay mechanics and an honest `next_fetch`
application class: the destination policy reloads the store on every
classification, so a saved grant is honored by the next web fetch without a
restart. Origins canonicalize exactly as the store normalizes them; an absent
store reads and previews as sticky defaults, the first trust save creates it
exactly like the `webfetch trust` CLI, and a corrupt store fails closed. NND
ships the typed client and a trust page (add/revoke drafts previewed as the
sorted candidate list before one revision-checked save), and the census
web-fetch rows carry the native endpoints, the paired permissions, and the
settings-page path; an independent audit passed with no defects and its two
risks — an unbounded origin length versus the family response bound, and a
catalog editability asymmetry with the gateway mirror — were fixed before
this consumer landed. The grant row is closed: `trusted_origins` is shown as the
saved list and the editable draft, each grant with its own revoke control, the
add field refuses anything but an exact credential-free origin before a request
is composed, and the class is the honest `next_fetch` the native surface already
stamps on every receipt. The page now also shows when trust last changed, and an
absent store says `not recorded` rather than leaving the operator to infer it.
The store's version counter is deliberately not displayed, so that row carries an
unverified surface instead of a claim no test supported. Whether an installed
journey exercises a real grant is still owed to C7 and the L gates; the remaining
C6 external-store families stayed open at that date, and each has since closed
with its own slice.

Progress: at NNA `20261005-16` the WebSearch settings family followed both
templates. The enabled flag plus at most eight canonical SearXNG profiles
(`config/web-search.json`) is native-first under one CAS transaction at
`/v1/nnd/configuration/web-search` with the family-line receipt mechanics.
Each operation maps to one domain helper: an enable without a profile keeps
the domain's endpoint-required refusal, an add derives its slug id and
enables by domain parity, promote fronts the target, and removing the last
profile honestly disables. Domain refusals keep their governed codes at the
native boundary, and both transport bounds double to 131,072 bytes so any
legal state round-trips. The honest application class is `next_search`: the
web search tool reloads the file on every search invocation, so a saved
change is honored by the next web search without a restart. An absent file
reads and previews as sticky defaults and the composition bootstraps it
like the CLI. NND ships the typed client and a settings page (staged profile
drafts previewed as the exact list NNA will save before one revision-checked
save), and the census web-search settings rows carry the native endpoints,
the paired permissions, and the settings-page path; two independent
non-author audits returned PASS with no defects. The family rows'
application class stays unverified until an installed journey exercises a
real search; the remaining C6 external-store families stayed open at that date,
and each has since closed with its own slice.

Progress: at NNA `20261006-4` the update_state entries became a read-only
native surface at `/v1/nnd/configuration/update-state` (read plus catalog,
read permission only). The surface loads through the store's own validator,
so any content it refuses — an absent, corrupt, or foreign-shaped file —
reads as the sticky state `absent`, honestly meaning "no recorded check is
known to be valid"; a validator-accepted record projects as stored with
store-grammar parity (v-prefixed or long-sequence versions, offset
timestamps, length-bounded brief strings), the eight census fields only
(the unclassified `installed_at` store field stays unprojected until the
census classifies it), unknown fields dropped and any further drift failing
closed; the catalog marks every field read-only with
`reason: generated_state` because only the update worker and its install
path write the store. NND ships a typed client and a read-only updates
section (status, checked-at, latest version and digest, last error, or the
honest no-record-yet default), mirrors the native store grammar exactly,
and the census update_state rows carry the
native read endpoints, the paired read permission, and the section path.
The web-search family's five shown rows (`enabled`, the `profiles` array, and
each profile's identifier, display name and endpoint) are verified against the
page that renders and edits them, with the class NNA itself declares,
`next_search`: the search tool reloads the file on every invocation, so a saved
change is honored by the next search, and a save goes through preview plus a
native revision check. The family's four compatibility-alias rows are open and
have no desktop surface at all: `src/nnd-web-search-routes.js` states the
version-1 keys normalize into the version-2 profiles on load and are not
projected, so there is nothing to render, and an earlier pin that named the
web-search page for them named a component that cannot show those keys.
`profiles[*].provider` is likewise open by choice: it has exactly one legal
value, which NNA enforces and the typed client refuses to parse otherwise, so
it is enforced rather than printed on every row. For update state, the class now
records what the native catalog declares (`next_update_check`) rather than a
placeholder; whether an installed service really records a check is still
unobserved, which C7 and the L gates own. The remaining C6 external-store
families stayed open at that date, and each has since closed with its own slice.

Progress: at NNA `20261006-5` the three trust rows became the settings family's
first authority-grant surface at `/v1/nnd/configuration/trust`: the granted
workspace roots listed exactly as stored with their trust times, a catalog
carrying the census authority-grant statement, and grant/revoke operations that
run through the native trust functions so canonicalization via realpath, admission
semantics, path locking, and atomic writes stay native. A grant requires an
existing root (a missing target is refused with `workspace_trust_target_missing`);
revoking a removed root is an honest no-op receipt; receipts record the CANONICAL
root the grant recorded; lock contention maps to `workspace_trust_busy` (409); an
unreadable store maps to `workspace_trust_invalid` (503), and the list never
degrades to an empty list because "nothing trusted" would admit unsafe flows.
Mutations need the workspace authority right; reads need the settings read
right. NND
`20261006-5` consumes it with a typed client (exactly the three census paths in
the served order, receipts pinned to the requested operation, the catalog's
authority statement) and a trusted-workspaces section on the native configuration
page: listed roots with trust times, a staged grant with the canonical-root
receipt shown, per-row revoke, and honest refusals in sentences; the section's
installed journey stays unverified until an installed NNA process is observed
admitting a real granted workspace; the remaining C6 external-store families
stayed open at that date, and each has since closed with its own slice.

The three trust rows are now settled. The grant row closes on `root`: each
trusted root is a row asserted by its own text, carrying the stamp that grant
wrote and a revoke control, with a path field that grants through the native
surface and a receipt repeating the canonical root rather than what was typed.
The class is NNA's own `project_configuration`, read from the route rather than
from the page fixture — the effect of trust is the project configuration that
becomes admissible, and no desktop code decides it. The trust stamp is closed as
`not_applied`, because NNA writes it and an operator never sets a timestamp; the
native catalog groups that field under the same family declaration, and this row
does not borrow the louder claim. The store counter stays deliberately open: the
page lists roots, not the counter, and printing a value that is always 1 would
make decoration look like coverage.

Progress: at NNA `20261006-6` the seven compatibility_service rows gained a
native settings surface at `/v1/nnd/configuration/compatibility-service` over
`config/opencode.json` — the OpenCode wiring identity (login auto-start plus the
fixed hostname, port, and Basic auth username) — using the same one-CAS
read/preview/save/operations shape the gateway, WebFetch, and WebSearch families
established. A candidate is a full document view (enabled, hostname, port,
username) merged server-side over the stored secret through keep/replace/clear,
and every merged document is validated by the same `normalizeOpenCodeConfig` the
CLI and the wiring service use, so an exposed bind without credentials refuses
with `opencode_bind_exposed_requires_password` and the host, port, username, and
password grammar surface the domain's own codes. Secret values never project: a
read shows a credential presence source only (the stored secret or the
`OPENCODE_SERVER_PASSWORD` environment override), a replace value is validated
without echoing, and receipts class application as `next_service_start` because
the wiring service reads the configuration at its next start. NND `20261006-6`
consumes it with a typed client (the seven census catalog paths, receipts pinned
to the requested operation, replace values bound locally with the domain codes)
and a compatibility section staging the full document view with a one-of-three
password choice; both the preview and the receipt state the change applies at the
next service start, and honest refusals surface as sentences. Corrupt or
foreign-version stores fail closed (`nnd_compatibility_source_invalid` on reads;
saves refuse to normalize a broken store), and the compatibility_service
lifecycle actions (six operator_action rows) stayed reserved at the time of
that slice — they were closed with their native authority on 20261007-25 and
their gui citations were rewritten with their own test on 20261007-50.

The seven configuration rows are now closed, and the sweep suspicion about
`updated_at` was correct in the way it usually is not: the row carried a verified
surface since before C1 while citing no test at all, and the page never rendered
the stamp. Rather than record a claim nobody had checked, the status line now shows
`last saved` with the real value and `not recorded` for an absent store, so the
field is covered because it is displayed. The store counter went the other way —
from an unexamined verified pin to an explicit unverified surface — because the
page shows the wire identity a reader acts on, and a counter that is always one is
not information. The five editable fields take NNA's `next_service_start`, declared
on this document and repeated on the save receipt with no restart verb; the two
generated rows keep `not_applied` rather than borrowing that start claim.

Progress: at NNA `20261006-7` the compatibility family absorbed its independent
review findings — preview checks the revision before building the merged
candidate (corrupt or foreign-version stores report
`nnd_compatibility_source_invalid` on every spoke, and a stale revision wins over
candidate grammar), candidates must be full document views with no value slot on
keep/clear, projection drift gets its own server-side code
`nnd_compatibility_projection_invalid` (500) so version, `updated_at`, and
receipt `replayed` flags fail closed, and the credential source strings come from
the domain's `OPENCODE_PASSWORD_SOURCES` constant. New route tests pin the
refusals over HTTP. The same version gave the census row
`managed_mcp_credentials:credentials.{NNA_MCP_MANAGED_reference}` its native
surface at `/v1/nnd/configuration/mcp-credentials` over the engine host's stored
credential map — list plus catalog (read) and save plus delete (manage), with no
operations ledger because both builds are implicitly idempotent: save derives the
reference from the server id and upserts it (256-reference and 1 MiB caps,
16,384-character tokens), delete is an honest no-op receipt reporting `absent`
when nothing was stored, and the list carries references and an `applied`
presence flag only — token values never project, and the store applies at the
next MCP server spawn. Corrupt stores fail closed (`mcp_credentials_invalid`,
503); session lock and capacity surface as honest conflicts. NND `20261006-7`
consumes both: the projection code joins the compatibility page's sentences, and
a typed managed-MCP-credentials client plus settings section renders the
reference roster and stages idempotent save/delete actions whose receipts claim
nothing about replay. The remaining C6 families (compatibility lifecycle actions,
hooks, update actions) stayed open at that date; the lifecycle rows were later
closed with their native authority on 20261007-25 and the update_actions panel
claimed its own slice after it.

That single credential row is now closed, and it was the last row in the census
claiming a verified desktop surface while citing no test — the hand-flagged case, and
a false positive about the surface: the reference roster really is rendered and really
is asserted, token value never appearing in the document at any step. What had never
been checked was the class, left `unverified` because nobody had matched the receipt's
wording to the route. `next_server_spawn` is NNA's, declared on the catalog field
itself and enforced against any receipt that carries something else, and the sentence
carrying it — the engine host applies saved references at the next server spawn — is
now asserted rather than assumed. Sensitivity stays `secret` as the catalog sets it.

With that row closed, the diagnostic that found it returns empty: no row in the file
claims a verified surface with no test behind it. The neighbouring measurement is not
empty: eight verified rows still cite a suite description without ever naming a test
file (`web_fetch_action` ×3, `trust_action` ×2, `session_review` ×2,
`manifest:tool_concurrency`) — all of them recorded as pins of surfaces verified
elsewhere rather than by work in their own slice. A citation that cannot be walked up
to is closer to a claim than to a proof, so those rows are the next thing on this list.

*Follow-up, same document, next slice:* those eight rows are the subject of
`20261007-28`. Seven gained citations naming the file that proves the claim, and the
`session_review` pair lost a class word that turns out to exist nowhere in NNA — see
that family's passage. The measurement is now 0 of 321 on both counts: no verified row
cites no test, and no verified row cites a suite description in place of a file.

Progress: at NNA `20261006-8` the six `secrets` rows became the settings
family's first pure read surface at `/v1/nnd/configuration/secrets` (list plus
catalog, `nnd.configuration.read` only; no operations, query strings refused).
The list projects the runtime secret broker's redaction-safe `publicSecret`
envelope exactly — label/kind/scope, public metadata, FIELD NAMES (never
values), enabled, timestamps/use-count — so secret values and encrypted material
never leave the encrypted-at-rest vault `secrets/vault.json`. An absent vault
reads honestly as `source_state: "absent"` with `count: 0`; vault corruption or
master-key damage fails closed with the vault's own codes
(`secret_vault_corrupt` / `secret_key_invalid`, 503) and never degrades to an
empty roster; projection drift on either side refuses with
`nnd_secrets_projection_invalid` (500, registered client-side), inside the same
client-checked 2 MiB + 64 KiB response ceiling. `application` is
`next_secret_use`: values reach a consumer only at the next broker consumption
point, so the settings read applies nothing. All writes (create/rotate/rename/
enable/delete/audit) stay on the runtime broker surface and its `secret_action`
source rows; this family never becomes a vault or master-key file editor. NND
`20261006-8` consumes a typed read-only client (exact envelope, count parity,
absent-as-absent) with honest sentences — vault damage says the vault needs
native repair — and a "NNA secrets metadata" settings section rendering the
redaction-safe roster with the statement that values never render there and
writes remain broker actions. Census rows updated in place; the `secret_action`
mutations stayed open at that date (they closed through the broker-action rows
with their slice), the compatibility lifecycle rows resurfaced on 20261007-25
and closed there, and hooks stayed open for its slice.

The six metadata rows are now closed, and the slice caught a defect the census
could not have: the page said it shows field names and public metadata, but the
line it rendered printed a field **count** and no metadata at all. Two census rows
were therefore claimed against a surface that did not display them — and the pins
had cited no test, so nothing noticed. The row now carries the field names and the
metadata **names** in full, with values asserted absent, because a metadata key is
safe to list while its contents are not this surface's business; a record with no
scope says `unscoped` rather than going quiet. All six take NNA's own
`next_secret_use`, with the refusal to edit recorded as the broker's, and the
sensitivity NNA set stays `secret`.

Progress: at NNA `20261006-9` the six `compatibility_service_action` rows became
the product's first operator-action surface at
`/v1/nnd/configuration/compatibility-service/actions`, reusing
`src/opencode/service.js` verbatim — the opencode-start session lock, the
detached managed runtime spawn into `nna opencode run`, verified pid records,
the Startup-folder `.vbs`, and the OpenChamber user-environment wiring stay
exactly as the CLI shipped them. `status` (GET, `nnd.configuration.read`)
projects the redacted wire identity (credential presence and source only —
never a value), the runtime variant grammar exactly as ProcessIdentity produces
it, login wiring, the presence-only environment observation, and
`stale_binding`. start/stop/enable/disable (POST, the NEW terminal right
`nnd.service.manage`, kept separate from the settings write right because they
reach outside the configuration file) reuse the domain verbatim: start reads
the persisted wiring NOW into a fresh detached runtime (`start_service`); stop
refuses an unverified runtime (`opencode_identity_unverifiable`, 503) so a
wrong-process kill can never ride identity drift and is an honest no-op when
nothing runs (`stop_service`); enable/disable install or remove the Startup
script with the same rollback and flip the persisted flag (`next_service_start`
— the wiring surface applies at the next service start; the immediate script
install is reported in the receipt). `run` is refused honestly
(`nnd_service_run_unsupported`): the foreground managed runtime is driven by the
detached start and the login script, and an HTTP handler cannot host a surface
that never returns. Input-less verbs accept only empty or empty-object bodies;
projection drift fails closed (`nnd_service_projection_invalid`, registered
client-side); operational failures are honest 503s. NND `20261006-9` consumes a
typed inputless client (all seven runtime variants, per-verb receipts with
operation ids and application classes) and an "NNA compatibility service
actions" settings section rendering the redacted wire panel, honest runtime/
login/environment sentences, per-verb receipts, run-less wording, and native
code sentences. Census rows updated in place; the `secret_action` mutations,
`update_action`, `nnd_package_action`, hooks, and the served-family action
columns (gateway/web_fetch/web_search/browser) stayed open at that date and
closed in their own slices.

Those six action rows are now closed, and they are the slice where closing meant
nothing to the headline counts: the class words were already NNA's, read from the
receipt the route writes, and no row changed state. What was missing was anything a
reader could check. The evidence on all six said a receipt application "mirrors the
native surface", a sentence true of every row in the file and therefore
distinguishing none of them, and the citation list was empty — a verified surface
that had never been looked at. Two gaps were genuine once the page was read against
the tests: `disable` had never been clicked, and the refusal of `run` was evidenced
only by a request that did not happen rather than by the sentence explaining why no
button exists. Both are asserted now, with no `Run` control in the document.

Worth stating plainly: this slice moved no census axis at all. It is recorded because
removing an unfalsifiable claim is the work, not because a number moved.

Progress: at NNA `20261006-10` the nine `hooks` rows (name, version, and the
seven `subscriptions[*]` fields) became the product's second multi-instance
read roster at `/v1/nnd/configuration/hooks`, reusing `src/hook-manifest.js`
`discoverHookBundles` verbatim — the sorted non-dot readdir, the 32-bundle cap
with the honest omitted diagnostic, per-bundle realpath containment, bounded
manifests, and the `validateBundle`/`validateSubscription` manifest and
subscription authority. The projection carries only what the census carries
(name, version, directory name, subscriptions with event/phase/command/
blocking/priority/timeout_ms/max_concurrent — the camel domain pair renamed to
the census snake pair; version keeps the domain tolerance, empty strings
project bounded by the domain 64-slice) and the absolute directory stays out.
Discovery's honesty channel survives the trip: a malformed bundle is its own
skipped diagnostic (never an empty or partial list), the limit diagnostic
reports the omitted count, and an absent hooks directory reads as an honest
`absent` source state with count 0. The surface applies or activates nothing
(application `next_hook_use`): runtime EXECUTION stays with hook-runner,
authoring a manifest belongs to the hook-store mutation story, and every
catalog field refuses editability (`hook_store_mutation_separate`). Projection
drift fails closed (`nnd_hooks_projection_invalid`, registered client-side).
NND `20261006-10` consumes a typed read client (envelope pin, seven-variant
runtime grammar excluded — this family has none, every live bundle field, and
the diagnostics shapes) and an "NNA hook bundles" settings section rendering
the honest absence sentence, per-diagnostic lines, and per-bundle subscription
rows. Census rows updated in place; the `secret_action`, `update_action`,
`nnd_package_action`, and served-family action columns stayed open at that
date and closed in their own slices.

The nine roster rows are now closed on evidence, which also documents what the
earlier pin was worth: it named this page as a verified surface and cited no test
at all, and two of the nine fields (priority and concurrency) had their values
rendered but never asserted. Both gaps are now covered, every subscription field
carries a value assertion, and the class records NNA's own `next_hook_use`
alongside the reason no row is editable here — the store is changed elsewhere,
the page offers a refresh and no save, and execution belongs to the hook runtime.

Progress: the seven `secret_action` rows closed with an NND-only consumption
slice (NNA runtime unchanged at `20261006-10`): the runtime SecretBroker over
the integration server (`dispatchSecretBrokerRequest`) already served
`GET`/`POST /v1/secrets`, `PATCH`/`PUT /v1/secrets/:id[/values|/status]`,
`DELETE /v1/secrets/:id`, and `GET /v1/secrets/audit`, and the NND operator
principal already carried `secret.read`/`secret.manage`/`secret.audit` while
deliberately never carrying `secret.use` — consumption stays with trusted
local callers, so the console has no value-read client at all (the lib export
surface pins that absence). The "NNA secret actions" settings section performs
the seven actions with the broker's redacted receipts: the roster renders only
labels, kinds, scopes, field names, enablement, and use counts; create and
rotate send typed field values once (password inputs, cleared after send);
update renames or re-scopes without values; enable/disable and delete are
per-row; the audit ledger views the newest events with no values, ever. The
parser refuses drifted grammars (sorted-unique field names, scope kinds,
stamps, and audit events' fixed 14 keys). Census rows updated in place with
`secret` sensitivity and verified GUI paths; the "per-row evidence" this passage
claimed at the time was in fact one bulk suite count shared by all seven rows and
no application evidence at all.

Those seven rows are now closed on evidence. The five mutating verbs take NNA's
own `next_secret_use`: the broker writes an encrypted vault whose values are handed
to a trusted consumer at use time with exact-value redaction active, and the
console never calls the use endpoint, so it cannot manufacture the very event that
marks the effect. `list` and `audit` are reads and say `not_applied` rather than
borrowing an effect claim they cannot support. The audit read is now asserted as
content — time, event, outcome — instead of by the heading of the panel that hosts
it. One suspicious pin from the earlier sweep turned out to be sound: the
enable/disable toggle really is clicked and its status request asserted, which is
worth recording because the sweep is a pointer, not a verdict.

The sweep now covers every row it started with: pre-C1 "verified" pins never
re-examined stand at **0**, from 62. Two rules came out of finishing it, and both exist
because a measurement of my own work was doing its job badly rather than well.

First, the exit of a row from that bucket is a label, and a label is not an
examination. Eight rows left on a "citation repair" label — the row's proof was walked
through the test that renders it, nobody re-read the panel — and
`probe-label-honesty.mjs` now prints them each round so the count cannot quietly absorb
them again.

Second, per-row citation checks are the wrong unit. "No verified row cites a suite in
place of a file" was true while 176 of 559 individual citations named no file, because
one precise citation on a row could carry a vague one beside it. The unit is the
citation.

Third, no counts in citations. `test/nnd-skills-routes.test.js` was cited as 3/3 while
holding five tests, and the browser pair as "lib parser + page drills 2/2" where the two
files hold one and two. A count is the part of a citation nobody maintains, and merged
phrases across suites are true in total and unverifiable in every part. Citations here
name the file, quote the tests, and assert nothing about how many there are.

The
`update_action` (2 install-action rows) and `nnd_package_action` (3) families
closed in the next slice together with the runtime wiring repair they
surfaced: `/v1/nnd/configuration/update/actions` runs the CLI's forced
`checkForUpdate` probe and refuses the installer honestly
(`nnd_update_install_unsupported` — the CLI keeps its authority), the package
surface reuses `runNndPackageCommand` verbatim (status read with
`nnd.configuration.read`; activate/deactivate under `nnd.package.manage` with
wrong-root deactivation refused at 400), both receipts pin the CLI's variant
grammars and fail closed on projection drift, and the desktop console serves
them as "NNA update actions" and "NND package actions". The same slice found
and fixed a real native wiring defect: the listener context had dropped the
compatibility lifecycle, MCP-credential, secrets, and hooks services since
`-9` (production-only; the route tests had injected services directly), so
the option set now spreads the whole classified service list and the
factory's exported key set is locked by test. Those five action rows are now closed
on evidence a reader can follow, and the work was almost entirely evidentiary: the
class words were already NNA's (`update_check_recorded` stamped on the check receipt,
`registered_root` and `unregistered_root` on the registry receipts, `not_applied` for
the observation and the refused installer), the routes had been verified at ship time,
and the page tests already drove every verb. What the rows carried was the same
generic evidence line as the lifecycle family and no citation at all. One real gap
surfaced in the fixtures: a branch built for the unregistered reading had never been
exercised, so the honest absence — the registry holding nothing — was now finally
asserted rather than assumed. Remaining families belong to C4
(provider advanced fields), C5 (MCP mutation), C7 (installed gates), and the
F/L lanes. The `trust_action` and `web_fetch_action` pairs then closed as
census pins of already-verified surfaces (the `-5` grant/revoke surface and
the `-1` WebFetch settings transaction carry both action families, with their
desktop consoles and drills verified at ship time), leaving
`web_search_action`, `gateway_action`, `browser_action`, the `invocation`
flags, the three served-family read columns (`web_search`, `web_fetch`,
`gateway`), `skills_action`, `legacy_provider_credentials`, `session_review`,
and the wide `manifest_*` projection families open. The four generated-state
meta rows of the served families (web_search/web_fetch/gateway `version`,
web_fetch `updated_at`) then pinned as census-only rows riding their family
pages' read views (no operator control, read right only), and the
`session_review` pair pinned the same way, consumed by the chat panel's
`ReviewModeControl`. **This passage was wrong and is corrected rather than
rewritten.** It described that commit as "idle-session policing" and cited "lib and
page drills". No word `idle_session` exists anywhere in NNA: `src/nnd-review-mode.js`
declares no application class at all — the commit is a compare-and-set on
`expected_revision` that writes `reviewMode`, bumps `reviewRevision`, and sets
`engine.reviewPosture` in the live context (L25-35), with no receipt and no application
word. The class those two rows carried was invented when the census was written, and it
now returns to `unverified`. NNA's own test shows the posture takes effect immediately
(it blocks ingress and restores on restart), so the effect is real; what is missing is a
word from NNA to describe it, and this project does not observe the installed effect.
The citation named a suite where a file belongs; the file is
`packages/ui/src/chat/__tests__/review-mode-control.test.tsx`, where the commit is
asserted as `setSessionReviewMode(session, mode, revision)` with the revision passed
exactly, recovery is exercised for denied, throwing, invalid and same-revision
outcomes, a stale read is ignored across session switches, and a fresh revision is
required after a replay gap. The installation family then closed with a real surface:
`GET /v1/nnd/configuration/installation` re-verifies the descriptor through
the admission authority on every read and fails closed on disk drift (the
authority's `nnd_install_*` verdicts surfaced verbatim at 503), and the
desktop `NNA installation` panel renders the descriptor; the configuration
router now surfaces registered failure codes verbatim — closing a `-12`
registry gap where the package root codes were silently rebranded — and the
two remaining served-family field rows pinned as census-only projected
state. Those six installation rows are now closed on evidence read from the route
itself: `not_applied` is written on the response (`nnd-installation-route.js:38`), the
snapshot module names all six fields `generated_state` in `OBSERVED_DESCRIPTOR`, and the
projector is where the honesty lives — product must equal the `PRODUCT` constant, version
and both roots must match their grammars (L74-76), the node path must match it too (L77),
and `node_major` must sit between 24 and 100 (L78), so drift is a projection refusal
rather than a plausible-looking panel. Reading the panel against its tests found that
`install_root` and `data_root` had never been asserted, though the page renders both on
adjacent lines: the product and version say what is installed, but the roots are what an
operator goes and fixes. Both are asserted now, and the citation names the file instead
of a suite. These remain installer-owned facts — the desktop reads them and changes none.

The `browser_action` family then closed the same way: the native
surface reuses the webbrowse CLI authority verbatim — the read reports the
managed Playwright Chromium exactly as `playwrightStatus` reads it, and the
verify action runs that authority with the launch probe (headless Chromium,
a validation page, a clean close; nothing on disk changes) — and the desktop
`Managed browser` panel renders the one fail-closed receipt grammar with
honest refusal sentences. The `skills_action` family then closed the same
way: the native surface initializes the same workspace SkillRegistry the
skills CLI authority builds — project skills included only on the trust
verdict — and serves the catalog with body digests only plus registry
diagnostics and honest failure codes; the desktop `Native skills catalog`
panel renders it (distinct from the opencode skill-source browser). The
seven `manifest_skills` rows read through that same receipt: each entry
serves `id`, `version`, `description`, `invocation`, `source`, and
`requires_tools` verbatim and the body **only** as `body_sha256`, while
inline manifest skills stay host-only (`hosted_skills_forbidden`, checked
before the descriptor is ever validated), so the catalog the desktop sees
is discovered roots only. The
legacy provider credential alias then closed the same way: the served
process runs the startup alias loader against a spare environment and
projects only the load verdict (loaded, count, honest refusal reason) — the
key value is never served — and the desktop `Legacy provider credential
alias` panel renders that verdict. The gateway/web-search operator verbs
then closed via a per-verb triage over the two CLI authorities: the
config-mutation verbs were already native through the two save transactions
and are pinned to those surfaces; the gateway status/test reads and the
managed SearXNG observation reuse the CLI authorities verbatim (public
config + identity-verified pid runtime, a read-only Telegram getMe probe,
the HTTP probe + docker ps identity); and the eight runtime/docker verbs
(gateway run/start/stop; SearXNG deploy/install-local/remove/
remove-deployment) are refused natively with honest `nnd_action_cli_only`
200 verdicts pointing at the terminal — the native service never detaches,
kills, or drives docker compose. The desktop panels `Gateway runtime` and
`Managed SearXNG deployment` render those views and state the CLI-only
stance honestly. The invocation flag rows then closed with a vocabulary
read over the CLI's own flag grammar: one entry per census row (flag,
aliases, argument grammar, allowed modes, the host/headless manifest
refusal, the parsed option key, the operator effect), proven against
`parseCli` by a mechanical consistency test and served fail-closed behind
the read permission; the desktop `Invocation vocabulary` panel renders the
grammar and states that the flags stay terminal commands.
The MCP manifest rows then closed with an advanced-fields projection: the
nine fields the redacted editor route already serves stay pinned there, and
the twenty-one sensitive/structural fields ride `GET /v1/nnd/configuration/
mcp/advanced` in two fail-closed grammars — presence under the read right
(booleans and null-safe counts per server, never a value) and inner behind
`nnd.configuration.manage` (the manifest's own credential references as
environment names or `secret:<id>#<field>` pointers, header maps, tool
effects, protocol version, transport surface; the secret VALUE never
crosses). The desktop `MCP server details` panel on the MCP page renders
the presence rows and, behind an explicit `Load references` action, the
inner references, stating that values stay native.
The tui block rides the same configuration view with no new surface: the
catalog already serves every `tui` path (the container, `reduced_motion`,
`color`, and the seventeen `key_bindings` actions), and the view test proves
the 20 census rows carry explicit values, the merged validated map, and
provenance. The defaults always apply before the manifest loads —
`reduced_motion` starts false, `color` starts on (a tty must allow it and
`NO_COLOR` still clears it), and every default binding is present before
validation — the map is re-validated (`experience/key-bindings.js`) and
applied at TUI start (`src/tui.js:runTui` → `decoder.setBindings`) before
the first frame; `reduced_motion` skips animation frames and `color` gates
ANSI rendering. The container projects presence only. The desktop inventory
page renders the rows read-only; NNA owns the block.
Mission authority is host-only and rides the same view with no new
surface: `validateMission` checks the principal first, so the
`authenticated-nnd-operator` read is refused with
`mission_authority_forbidden` before the schedule order (`not_before` <
`expires_at`), the bounded lists (resources ≤ 32, targets ≤ 128, the
four `side_effects` choices, credential references ≤ 64), the three
resource bounds (`max_turns`, `max_tool_calls`, `max_duration_ms`), and
the termination checks (which always require `budget_exhaustion`,
`expiration`, and `disconnect`) are ever reached. The view test proves the
16 paths serve as honest absence and the refusal echoes nothing of the
outcome, references, or schedule. The inventory page renders the rows as
`Not set`; NNA owns mission authority, the desktop never sets or observes
a mission block, and NND renders the honest absence read-only.
surface at `/v1/nnd/configuration/environment` (read plus catalog, read
permission only). The seven census-named entries are projected exactly as
the served process resolves them: public entries carry their value
(including legal empty values; oversize values are refused, never
truncated), credential entries project presence without a value, and the
observation digest covers public values plus credential presence only, so
the surface never becomes an offline guess-verification oracle for
credentials. The catalog reports every field read-only with the census
verdict's reason `process_environment`; a live determination can only be
changed in the Windows shell and reaches the service at its restart. Unknown
service fields are dropped, and a drifted projection fails closed. NND
consumes the surface with a typed client and a read-only default settings
section that renders the observation, the shell-and-restart explanation, and
a refresh; every one of the seven rows is asserted at row level, including
the two credential rows, and the typed client refuses a credential entry that
arrives carrying a value, so withholding is enforced rather than merely
labelled. The census environment rows carry the native read endpoints, the
paired read permission, and the section component path, and their desktop
surface is verified. Their application class now records what the native
catalog declares (`restart_service`) instead of a placeholder; that is a
declared point, and the restart effect on an installed service is still
unobserved, which C7 and the L gates own. The remaining C6 external-store
families stayed open at that date; the C6 census finished on 20261007-61 with
every row dispositioned (verified on a surface, verified in place, or a
gate-checked owed:false basis).

Progress: at NND `20261007-57` the seven manifest record-containers that the
shape-table round (`20261007-36`) kept open closed on evidence the intervening
rounds had already built. `-36` deferred the `object`-kind records —
attachments, memory, dream, tui, telemetry, reviewer_ledger, recovery —
because their fields "render apart"; since then every one of them grew a unit
that renders all of its members together and a fixture asserting exactly that:
the memory, attachment and dream typed blocks
(`native-configuration-controls.test.tsx`: "renders all five memory census
rows in the memory block", "renders all three attachment census rows in the
attachment block", "renders all six dream census rows in the dream block") and
the recovery, telemetry, reviewer-ledger and tui composed inventory views
(`native-configuration.test.tsx`: "renders all four recovery census rows",
"renders the three telemetry census rows", "renders the reviewer-ledger
retention row", "renders the tui keyboard family with merged defaults,
provenance and honest container absence"). The founding rule ("a container is
on screen only when everything it holds is rendered in that unit",
`20261007-35`) therefore stops separating these records from the collections
that closed at `-36`: a fixture that names every member beside NNA's own view
test is the same composed evidence the first closures used, decided
member-set-by-member-set and never by family page. The four route role
containers do not meet the bar and stay open — the role card renders two of a
role's thirteen members and the rest ride the catalog-gated chooser across two
pages. The class axis follows NNA's own declarations, transcribed like
`20261007-35` and named in each row's apply evidence: memory and attachments
`engine_boundary`, dream `construction_only`, tui `surface_invocation` (with
its `no_generic_live_application_claim` guard kept), and mission
`new_session` with sensitivity `public` — while telemetry, reviewer_ledger and
recovery remain `unverified` because NNA's own metadata declares nothing for
those families. Mission stays owed: a desktop mission control has no authority
behind it for the desktop principal, so the row keeps no surface instead of
inheriting a claim no test supported. Unverified application class
**38 → 33** (the advance read at the end of this lane pulled it to 31).

The last one of the six buildable leaves closed the next round
(`20261007-58`): `web_search:profiles[*].managed`, the one owed
`generated_state` field whose 20261007-18 note had recorded "displaying it is
real follow-up work". The badge renders where the profile identity renders —
the profile row unit in the editable list, the `· managed` marker in the read
summary line, and the same marker in the NNA preview receipt — and says what
the value means: NNA stamps `managed` only on a profile its own deploy adopted
(`web-search-cli.js` deploy writes
`replacePrimaryWebSearch(current, deployed.endpoint, true)`, which derives the
"Local SearXNG" name), so the badge points at the sibling *Managed SearXNG
deployment* observation that renders on the same composed settings page. The
field stays operator-unsettable (`not_applied`, read right only), and the
census row verified with a test naming the summary marker, the row badge, and
the unmarked sibling.

The surviving alias row closed the round after
(`20261007-59`): `manifest:provider`, the legacy singular-provider block. NNA
had already proved the grammar NNA-side — `validateProviders` folds the
singular value into the profile map, the intent engine preserves the singular
raw form through edits
(`configuration-source-publication.test.js`: "provider field intent preserves
singular raw form and omits compiled defaults"), and the configuration view
binds the alias in place of `providers[0]`
(`nnd-configuration-view.test.js`: the block "is visible as an unprintable
structure and then disappears into providers[local]" and "mirrors the same
resolved profile", credentials redacted, no provider field editable). The
desktop needed no new control — the inventory page already renders
explicit-versus-effective for every row — but the composed member set had
never been asserted as a whole, so the round added the fixture
("renders the legacy singular-provider alias as the unprintable block beside
its resolved mirror"): the bare `provider` row reads *Value unavailable* over
*Not set*, the identity members render the resolved values beside their raw
declarations, the derived members state *Unavailable* provenance, the
credential references stay redacted on both sides, and a canonical-array
manifest renders the same rows with the alias side *Not set* while the
effective mirror still resolves — the operator sees both which spelling the
manifest used and what it became. No control is owed: the contract offers no
provider editing on this surface, and the row keeps `unverified` application
class because NNA's container declaration carries none. Surfaces owed are now
**6 → 5**.

The route-role containers closed the round after (`20261007-60`), on the same
composed-fixture rule. The route card had shown the binding pair only — two of
the eleven members each role container holds (`provider_id`, `model`,
`context_limit_bytes`, `required_capabilities`, `temperature`,
`max_output_tokens`, `budget`, `fallbacks`, `deadline_ms`,
`reasoning_effort`, `enable_thinking`), with the rest riding the editors: seven
scalars for reviewer/vision on the page's tuning chooser, and primary/subagent
spread across the inventory's scheduling, deadline and grouped controls. That
failed the record-container bar (a container is on screen when one unit
renders everything it holds). The fix is a card extension, not a new page:
each role card now lists all eleven members by name with the raw and resolved
value and the provenance NNA's own route-family test pins (canonical zeros,
the inherited/derived provenance the view refuses to attribute to a layer,
compound arrays). One fixture asserts all four cards render the full member
set ("renders every served member of each route role beside its binding
pair"), while the existing tests keep proving the pair editors and the scalar
chooser beside them; the binding authority text is unchanged (reviewer/vision
editable here, primary/subagent through the provider route authority). All
four census rows close verified on that unit; the containers keep the
`unverified` class because the roles-family declaration carries no
application. Surfaces owed are now **5 → 1**.

The last owed row resolved without a surface (`20261007-61`):
`manifest:mission`, the mission authority grant, went `owed: false` on the
guide's narrow rule — the only admissible shape. The claim rests on the field
having exactly one legal value for this client: NNA refuses a manifest
carrying any mission content before validation order
(`mission_authority_forbidden`, proven by
`nnd-configuration-view.test.js` to leak no mission text into the error), so
no mission value can ever vary on the wire to the desktop, and the runtime
refuses a mission change into a live session
(`configuration_mission_change`). Both sides of the boundary carry the proof
the refusal rule demands: the producing side serves the root row and all
sixteen census paths as honest absence for the desktop principal (NNA view
test), and the reading side renders that absence verbatim and invents nothing
(desktop test: every path present on the page, at least one *Not set* per
path, and neither the refusal code nor the mission outcome text anywhere in
the page). "No control exists today" was not the justification — that
describes work not done; the tested one-value contract is. The row keeps
`state: open` like the eleven precedent dispositions: an owed:false
disposition cancels the owed claim, not the row, and installed-evidence
questions (C7/V) remain askable. With it, the census's owed-surface list
empties: **surfaces owed 1 → 0**, every row either verified on a surface,
verified in place, or carrying a gate-checked `owed: false` with a basis.

At `20261007-63` the independent C6-exit audit returned **closed as standing**
(against the three exit criteria — every external-store row dispositioned with a
working GUI operation or a gate-checked noneditable classification; honest
missing-installation guidance; privileged changes routed through native service
lifecycle with retained failure evidence). The residue it reported was prose, not
rows: the ledger's C6 row still named five closed families as open, and aged
"stayed open" narrative tails (provider-store, trust, web-search, update-state,
installation, hooks/action columns, service lifecycle) still spoke in the present
tense about rows the census shows closed. This slice converted every such tail to
dated hindsight ("stayed open at that date; closed in its own later slice"),
refreshed the C1/C2/C3/C6 ledger rows (C6 now verified), fixed the census header
that still called the file a partial census with all rows open, and pinned the
store separation the audit wanted explicit: a full TUI save cycle leaves the NND
settings document — `shortcutOverrides` first among the profile keys — untouched
(`native-tui-preferences.test.tsx`, new negative test; the two pages share no
store, no client, and no write path). No census row changed; the round is
bookkeeping and one hardening test.

### What "verified" means in the census, and what it does not

`current_gui.status: verified` means one specific thing: a named test file reads the field off
the rendered surface, and a named source file shows NNA producing it. Every one of the 346
verified rows rests on that, and nothing more. The census's `evidence.installed_journey`
column, which is where an observation on an installed NNA/NND pair would be recorded, is empty
in all 371 rows, and 208 verified rows carry no `evidence.kind` at all.

Read together, those two facts say the coverage figure measures *read-and-unit-tested*
coverage. It does not measure installed acceptance, which is C7's to decide and cannot be
reached until C6 closes. Writing `source_inspection` onto 208 rows in one commit would make the
schema look complete without adding one observation, so it is recorded only on rows whose
evidence has been re-read by the person making the claim.

The rule for the citations this relies on has not changed: name the file, quote what the tests
refuse or assert, and assert nothing about how many there are. A citation that cannot be
opened is not evidence, however confident its prose.

Two kinds of citation fail that rule differently, and conflating them corrupts the count. A
citation naming **no file at all** is a claim nobody can check and is the thing being burned
down. A citation naming a **source file but no test** is sometimes the correct instrument: an
absence proof ("this page contains no reference to the store's version counter") has no test to
name because the fact is a grep. The census metric therefore reports both — citations naming no
test file, and of those, how many name no file at all — and only the second is treated as a
defect.

Because citations get rewritten in batches, a patcher is allowed to add citations and to replace
prose, but **not to drop a citation that names a file**. Filters that recognise only one kind of
evidence destroy the other kind: a rewrite that keyed on `includes('.test.')` deleted the absence
proof above, which was the evidence behind a refusal to credit a row. Every citation rewrite runs
against the patcher's own backup first, and anything that vanished is restored only after its
claim has been re-read.

A claimed path is itself a claim about the tree, and it rots the way code rots. Six rows long
claimed a verified surface at `pages/native-gateway-runtime.tsx` and
`pages/native-searxng-deployment.tsx`: components renamed away from the `native-` prefix, with
`status: verified` left in place. Nothing noticed, because no check had ever opened the path. The
coverage gate now rejects any row whose `current_gui.path` names a file that does not exist in the
owning product's tree, and the seal prints the count as `surface_files_missing`. The general rule:
**a census field that points outside itself is only as trustworthy as the check that follows the
pointer** — the same reason a citation must name a file a reader can open.

A citation that says *"not asserted by this suite"* is a to-do with a location. It is allowed because
naming a gap is cheaper than papering over it, but it is not a resting place: the next version that
touches that row should close it or say why it cannot. Three such gaps in the gateway family — the
enable flip, the token-variable set and reset, and a grant revocation — were named in one version and
turned into clicked assertions in the next, moving the UI suite from 1917 to 1918 and letting four
rows cite a saved request body instead of a source line.

Two traps produce the same false citation, and both were met while rewriting them. A **comment** in
a test file is not an assertion: the sentence has to come from an `expect`, not the prose above it. A
**fixture** is not an assertion either: a helper that can build a disable-shaped receipt proves only
that somebody wrote the helper, unless a test hands that receipt to the parser and asserts something
about the result. When a suite exercises one direction of a verb, the citation says so and points at
the other direction's real evidence, which is usually a different suite.

Two more species arrived with the secrets family. An **order refusal is not a name-set refusal**: the
fixture keeps the metadata names identical and reorders only the values, so the citation must say what
actually failed — claiming a foreign name is refused describes a refusal for a different input, and
the name-grammar refusal had to be written as its own line before it could be cited. And a **fork the
fixture never feeds** is a citation of the branch, not of the behaviour: the renderer's unscoped line
existed while every fixture carried a scope, so the honest citation is a new test that feeds the
scopeless record and asserts the word, not a pointer to the line that would print it. When a mirrored
bound (the client's copy of the native response ceiling) or a parameterised loop (catalog refusals
demonstrated one position at a time) is only partially exercised, the citation names the covered
input and stops there rather than claiming the whole rule.

The alias family taught the native half of the disposition rule. Four compatibility-alias rows said
the loader accepts the version-1 spellings and had been left open with their `tests_run` arrays
empty — the only family in the census that was quiet rather than padded with prose. The claim
needed both repositories and was satisfied in one order: the NNA test was written first, feeding
raw version-1 bytes to the loader and asserting the folded version-2 envelope, the derived display
name, the camelCase promotion and the precedence of the canonical key; then the rows were
dispositioned against that test's commit, with the desktop-side refusals already on file. A
disposition that says never projects the legacy spelling is only as strong as the version-2-only
read path behind it, so the cross-repo citation names a commit hash, not a workspace. Two
bookkeeping facts rode along. NNA's repository graph and controlled-language report measure test
files too, so a test-only edit staled the derived artifacts until they were regenerated, and the
refreshed copies ride the commit whenever the comments change the measurements. And one of NNA's
standing failures proved pre-existing the honest way: the edit was stashed, the clean tree re-run,
and the same failure reproduced, which is a claim about the tree before the round, not a hope.

### A row may state that no desktop surface is owed

If a surface is
still owed, the row simply has no path. If none is owed, the row states
`current_gui.owed: false` with a `basis` naming a source file and the symbol in it, and a
`justification` — and the coverage gate refuses the claim otherwise, including when the row
names a path and disowns it in the same breath. The seal prints how many rows opted out.

Admissible justification is narrow, on purpose: **the field has one legal value, the typed
client refuses every other, and a test at that boundary proves the refusal.** That is a claim
about the native contract, so it can be checked against it. "No control exists today", "an
operator would not care", and "the page would look odd" are not justifications — they describe
work not done. When a value could vary on the wire but NNA discards the fact (the web-search
document's legacy shape, for instance, is folded into version 2 at load), the row stays owed:
needing to build something is a reason to owe a surface, not to cancel one.

Where the justification is a **refusal**, the refusal belongs to both sides of the boundary and
has to be tested on both: the side that produces the value and the side that reads it. A basis
naming one guard and one test can pass the gate while describing half a contract. The
web-search profile provider row carried a note citing a native `throw` for a long time before
anybody noticed that neither repository had a test feeding it a provider that was not SearXNG;
the disposition went on only after NNA `7e108cf7` and the desktop test in `20261007-38` existed.

### C7 — Coverage and installed acceptance gate

Dependency: C4–C6. Run the key-to-control-to-native-effect coverage report
against the exact supported NNA build; retain tested product/protocol versions.
Use isolated Windows installed instances with browser and desktop clients.
Exercise same-setting concurrent edits, direct/TUI external edits, project
override and reset, service account environment differences, restart-required
changes with active work, shutdown during save, lost response/retry, disk
write failure, revoked authorization, secret rotation, and incompatible schema.
Verify persistence after reboot and removal of NND without changing NNA data.
Exit: no unresolved configurable setting absent from GUI; no placeholder or
read-only inventory counted as a working editor; all effective-value/apply
claims proven by native consumers. Attach failures and repairs to acceptance
evidence in the overarching execution plan.

## Verification and agent completion protocol

For each package, run focused native and NND contract/UI tests, then the
repository-required full checks for changed products. Use
`scripts/nna-source-smoke.mjs` and `scripts/smoke-http.mjs` as existing
source-integration entry points; add configuration probes without treating
source smoke as installed acceptance. Native test starting points include
configuration/provider/integration/review-mode tests; NND starting points are
`components/settings/__tests__`, `lib/settings/__tests__`, and
`packages/web/src/server/__tests__/p10-mcp-config-routes.test.ts`.

After each logical implementation slice obtain the requested adversarial
review: concrete scenario, downstream consequence, repair, regression evidence.
Update the coverage ledger, build status, product version, and repository
graph; run applicable release gates before the verified commit. Follow the
repository's immutable release sealing order. This planning document itself
does not authorize skipping native review, elevating authority, or declaring
settings complete from a form inventory alone.
