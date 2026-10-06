# C — Complete native configuration coverage

Working evidence: [settings-coverage.json](settings-coverage.json) is the partial C1
source census. All rows remain open; it does not establish GUI or installed coverage.

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
reviewer/vision scalar routes also have focused controls. Typed controls for
`memory.timeout_ms`, `memory.max_items`, and `memory.max_bytes` use the same
native user-manifest preview and save path. The provider scheduling limits
`provider_concurrency` and `provider_queue_limit` also have bounded controls
when NNA advertises them. Dream maintenance enablement, idle/stage delays,
and retention also have typed controls gated by the native catalog. NNA can
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
and recovery wall-clock limit remain generic JSON controls. Approval wait,
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
execution authority. Older NNA releases can evict unfinished reviews when the
limit is exceeded. Repaired NNA releases preserve unresolved reviews through
compaction, including those with an uncertain external effect. The NND
configuration view does not expose a trustworthy NNA product version, so this
control carries a compatibility warning instead of claiming that every
connected NNA preserves them. Telemetry stays in the generic
editor because NNA does not yet ship a telemetry exporter. Other execution
and context scalars remain generic JSON controls without complete
family-specific UX or installed application evidence. Provider identities,
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
census against the paired NNA catalog. The gateway rows' application class
stays unverified until an installed journey exercises the change; the
remaining C6 external-store families (web search, browser, compatibility
service, environment, hooks, native updates, optional integrations) and the
distinct TUI preferences page remain open.

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
this consumer landed. The trust rows' application class stays unverified
until an installed journey exercises a real grant; the remaining C6
external-store families stay open.

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
real search; the remaining C6 external-store families stay open.

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
The web-search family's four compatibility-alias rows reconcile to the
family's existing native chain: NNA accepts legacy version-1 document keys
on load and normalizes them into the served version-2 shape, so the aliases
point at the native surface with a note that the modern shape only is
served. The rows' application class stays unverified until an installed
service is observed recording a real check; the remaining C6 external-store
families stay open.

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
stay open.

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
lifecycle actions (six operator_action rows) stay for their own slice.

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
hooks, update actions) stay open.

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
mutations, compatibility lifecycle actions, and hooks stay open.

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
columns (gateway/web_fetch/web_search/browser) stay open.

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
`nnd_package_action`, and served-family action columns stay open.

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
`secret` sensitivity, verified GUI paths, and per-row evidence. The
`update_action` (2 install-action rows) and `nnd_package_action` (3) families
remain open.

Progress: at NNA `20261006-3` the environment rows became a read-only native
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
a refresh; the census environment rows carry the native read endpoints, the
paired read permission, and the section component path. The rows'
application class stays unverified until an installed service is observed
through its restart; the remaining C6 external-store families stay open.

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
