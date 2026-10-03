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
native user-manifest preview and save path. These controls do not assert that
running sessions adopt saved values. Other execution, context, recovery, dream,
telemetry, and retention scalars remain generic JSON controls without complete
family-specific UX or installed application evidence. Provider identities,
credentials, authority grants, and external-store settings require separate
native contracts and acceptance evidence; none are counted complete here.

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
