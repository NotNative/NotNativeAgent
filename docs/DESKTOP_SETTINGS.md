# Desktop and web settings

The native settings foundation ships in version `20261015-11`. Desktop and web use the same
settings pages and the selected installation's background service.

## Available preferences

| Page | Supported behavior |
| --- | --- |
| General | Desktop/browser lifecycle guidance, installed desktop/web version, verified NNA installation details |
| Appearance | System/light/dark mode, separate built-in light/dark themes, interface scale |
| Conversations | Enter or Ctrl/Cmd+Enter to send, spellcheck, conversation width, Markdown/plain user messages |
| Notifications | Off/static/animated successful-turn indicator; reduced motion suppresses animation |
| Keyboard | Record, validate, replace conflicting bindings, reset one command or all displayed commands |

Keyboard currently exposes focus input, new conversation, toggle sidebar, open settings and cycle
theme. It does not offer bindings for unsupported terminal, worktree or model-switch commands.
Provider/model management, installed skills and the existing native configuration controls remain
available under Agent, Capabilities and Advanced. The composer still selects configured models;
these preferences cannot change provider routes, review policy or workspace admission.

OS notifications, sounds, font downloads, persistent browser selection and unsupported editor
preferences are not exposed by this foundation. They need their own complete adapter and acceptance
slice. The broader [settings plan](DESKTOP_SETTINGS_PLAN.md) remains the roadmap.

## Providers and models

These controls ship in version `20261015-13`.

Provider management has Connections, Models and Routing views. Connections use the native
OpenAI-compatible provider adapter. Add and Edit open a focused dialog; credentials are environment
references or existing Secret Broker bindings. The broker's public labels and field names identify
the selection. Secret values are never fetched or displayed. A save must confirm the requested
fields and binding. Existing profiles carry a revision; an outdated editor receives a conflict
and retains its input. Close the editor and refresh to load the newer profile.

The `active` profile flag identifies the saved primary provider; other profiles remain available.
Discovery and connection tests run on explicit clicks in Settings. A successful catalog test confirms
model presence, not inference. Discovered catalogs are shared with the composer and scoped to the
current service connection. Failed discovery retains profile defaults and remembered favorites.

Models supports search, favorites and picker visibility. Preferences use provider/model pairs, so
identically named models on separate providers remain distinct. Favorites sort first within each
provider. Hidden models remain available to existing conversations, and the current selected model
stays visible. Favorites and hidden choices persist in the installation's interface preferences;
they do not enable providers or redirect execution. The complete settings document stays below
32 KiB; an oversized update is rejected before replacement.

Choosing a model in Models only prefills the primary-route form. Save primary route publishes the
selection, and Apply saved provider routing explicitly makes it available to new sessions. Existing
sessions keep their route. Routing exposes the native role bindings and supported tuning controls
with preview, revision checks and publication receipts. Unsupported adapter options are not exposed.

## Agent policy, memory and context

Version `20261015-14` adds Agent policy and Memory and context to native Settings.
Agent policy contains application instructions, conversation persistence, recovery steps/retries,
ordered recovery actions, turn time, approval wait, and tool concurrency. Review policy is scoped
to a selected existing idle conversation, with the same native revision checks as the conversation
panel. New conversations choose review policy in the composer. Review is mandatory in every mode;
Unattended denies unresolved escalations. Child sessions inherit their runtime constraints.

Memory and context contains the root context byte ceiling, four ordered compression/compaction
thresholds, optional memory enablement/requirement, and retrieval time/item/byte limits. Provider
and route ceilings still constrain context. Enabling Require memory also enables retrieval;
disabling retrieval also clears Require memory. Native preview shows the resolved pair and all
thresholds before publication. These controls configure an optional adapter; they do not install
one, delete saved memory, or edit local project files. AGENTS.md directory instructions and NNA.md
project memory are explained separately. Retrieved content cannot grant execution authority.

Each editor opens directly below its setting. Source details show the resolved value's provenance
and the user override. Unsupported or unreadable values cannot be edited as invented empty values.
Reset removes only the named user override and requires preview. Save sends the exact previewed
request with native source and resolution revisions, then shows the publication receipt. A native
revision or source-ownership refusal preserves the draft and releases the rejected pending handle.
An unknown transport outcome keeps its handle for Check save outcome. Reload values explicitly
discards the editor. Search waits for asynchronous native fields before scrolling/highlighting.

Application timing is explicit: saving these user defaults does not update running engines. The
desktop service captures non-provider configuration when its host starts. Restart NNA to load saved
defaults when engines are constructed, including reopened conversations. This differs from the
explicit provider-route activation flow and from interface preferences that apply immediately.
The configuration view resolves user defaults with the service workspace sources; it is not a
per-workspace instruction editor. Project overrides retain precedence and can refuse a user write.

Delegation rules are shown as runtime information, with no ineffective sliders: foreground child
work, no nested subagents, mandatory review, inherited scope, durable lineage, parent cancellation,
and the native agent_run timeout/output bounds. The subagent model remains under Providers and
models / Routing. Editable delegation limits and saved-memory CRUD require their own native owners.

Installed acceptance commands use the actual registered service and selected Electron payload:

```powershell
node desktop/scripts/electron-installed-agent-settings-smoke.mjs ABSOLUTE_REGISTERED_DESKTOP_ROOT ABSOLUTE_EVIDENCE_DIRECTORY
node desktop/scripts/electron-installed-review-policy-smoke.mjs ABSOLUTE_REGISTERED_DESKTOP_ROOT ABSOLUTE_EVIDENCE_DIRECTORY
```

The first previews all 18 native settings, checks invalid bounds and source details, and publishes
and restores policy, context and memory limits. The second changes a conversation's review policy,
checks the native revision, restores the original mode, and verifies Refresh. Both capture installed
Electron evidence and confirm that closing the test shell leaves its service generation running.

Version `20261015-14` passed the full core suite (2,513 passed, 8 skipped), UI suite (2,216 passed),
and web suite (1,557 passed), plus both repository quality gates. Browser checks exercised all
18 editors, real publication/restoration, reset previews, a revision conflict, conversation review
save/restoration, and asynchronous search. Installed Electron repeated the native editor and review
checks after the main installer upgraded the registered application. Test values were restored;
Gateway remained stopped and disabled. Tests now verify usable preview outcomes as well as request
payloads, covering the reset-validation defect that a request-only assertion missed.

## Operational capabilities and data

Version `20261016-1` adds five native destinations with 17 sections:

| Destination | Sections |
| --- | --- |
| Tools and integrations | MCP servers, Runtime inventory, References |
| Skills and hooks | Skills, Hooks |
| Search and browsing | Web search, Web fetch, Managed browser, SearXNG deployment |
| Services and updates | NNA desktop, Telegram gateway, OpenCode service, Updates |
| Data and diagnostics | Diagnostic summary, Conversations, Files, Environment |

These compose existing native owners. Only the selected section mounts. Authentication or authority
loss removes its controls; connection identity includes both key and origin. Pending reads cancel
and late results are discarded when ownership changes. Optional service absence remains a setup
state. Opening Updates makes no release-source request: Check now does. Installation uses `nna update`;
the unsupported install action is removed.

Diagnostic JSON downloads contain an explicit metadata allowlist and environment names/presence,
with no environment values, prompts, credentials, configuration or evidence. Local storage paths
require opt-in. This is not a backup or full support bundle. Conversation data supports title/workspace
search, archive filtering, archive/restore and Markdown text export. The list is bounded to 1,000
parent conversations. Export requires an idle conversation with unchanged metadata and retrieves
at most 50 pages / 5,000 messages / 8 MiB. Failed, duplicate, foreign, partial or changed reads refuse
download. Tool payloads and synthetic/ignored text are excluded. Exports cannot restore execution
authority. Usage remains in each conversation's existing context panel.

Files exposes native attachment enabled, retained-copy and byte-ceiling defaults through existing
preview, revision comparison, reset and publication receipts. Retention concerns managed copies,
not source files or evidence deletion. Saved engine defaults require restart. MCP definitions also
require restart before newly constructed desktop engines consume them; existing sessions retain
initialized tools. The Console's between-turn reload behavior does not apply to the desktop engine.

Confirmed defects corrected here include absent optional credentials rejecting environment reads,
empty hook directories reported as failed discovery, successful restore reported as failed when the
native reply omitted the cleared archive timestamp, and missing reload after authentication recovery.
Tests that encoded incorrect credential/recovery behavior were corrected in place.

Verification used the main source installer in the normal registered application and desktop locations.
Browser checks exercised real downloads, search publication/restoration, three file previews and an
explicit update check. Installed Electron traversed all 17 sections, performed a disabled temporary
MCP create/timeout-edit/remove cycle, and exercised diagnostics, archive/restore, filtering and
transcript downloads. Test conversations remain archived; operator settings were restored and
Gateway stayed stopped and disabled. Credentials, trust grants and optional service startup settings
were preserved. This does not certify the acquisition/execution path of `nna update` itself.

Installed acceptance commands use the same absolute arguments as the settings smoke command below:

```powershell
node desktop/scripts/electron-installed-operations-smoke.mjs ABSOLUTE_REGISTERED_DESKTOP_ROOT ABSOLUTE_EVIDENCE_DIRECTORY
node desktop/scripts/electron-installed-mcp-settings-smoke.mjs ABSOLUTE_REGISTERED_DESKTOP_ROOT ABSOLUTE_EVIDENCE_DIRECTORY
node desktop/scripts/electron-installed-data-smoke.mjs ABSOLUTE_REGISTERED_DESKTOP_ROOT ABSOLUTE_EVIDENCE_DIRECTORY
```

Full suites passed: core 2,513 passed / 8 skipped, UI 2,241 passed, web 1,557 passed. Added behavior
tests cover ownership changes, authentication recovery, late reads, failed acknowledgements, archive
restoration, bounded multipage export, cancellation, diagnostic redaction and download MIME.

## Settings cohesion

Version `20261016-2` adds a shared edit boundary to the settings shell. Form owners report only their
label and dirty/operation state. The boundary never reads field values or stores credentials. Page,
tab, search and close transitions offer Keep editing or Discard changes for unsaved forms. Refresh
actions that replace the search/fetch, gateway, compatibility, MCP or agent/file draft use the same
decision. In-flight or unconfirmed publications require returning to the editor to check the outcome.
Known unpublished receipts do not permanently trap the operator. Runtime/authentication changes
cancel queued navigation; browser unload receives a native unsaved-change warning. All native page
forms remount on a connection key/origin change, preventing drafts from carrying into another host.

The owner registrations cover configuration/repair and agent/file editors, provider connections,
primary/subagent/role routing, MCP definitions, WebSearch/WebFetch, gateway/compatibility configuration,
secret drafts and managed MCP credential drafts. Explicit Cancel edit closes an agent/file editor
without publication. Reloading MCP definitions now clears a discarded draft. No settings write or
service operation is triggered by navigation. Native preview, revision checks, durable operation
recovery and application timing remain with their existing owners.

Provider and operational tabs share roving keyboard focus: Left/Right wrap and Home/End select the
first/last section. Dirty-state protection also applies to keyboard selection. Controls share native
settings sizing, borders, disabled states and visible focus styles, with a narrow-window layout.
Interface-preference save status appears on preference pages and the Models preference section;
configuration editors retain their own publication receipts. General now directs operators to
Services and updates rather than the previous Advanced destination.

The installed acceptance command exercises real tab/page/close/search/refresh decisions, retained
and discarded drafts, keyboard focus, native file preview/cancellation, and unchanged search revision:

```powershell
node desktop/scripts/electron-installed-settings-cohesion-smoke.mjs ABSOLUTE_REGISTERED_DESKTOP_ROOT ABSOLUTE_EVIDENCE_DIRECTORY
```

Dedicated Trust and secrets navigation, full field-level search, additional host preferences and
restart/reconnection controls remain separate follow-up slices. This pass preserves existing native
save protocols rather than replacing them with a second writer.

Acceptance passed in the browser and the registered installed Electron payload after the main
installer rebuilt version `20261016-2`. The 17-section operational check also passed. Agent acceptance
repeated all 18 previews and three real publications/restorations. Operator settings were restored;
Gateway stayed stopped and disabled. Full suites: core 2,513 passed / 8 skipped, UI 2,251 passed,
web 1,557 passed. Both quality gates passed. New tests cover actual WebSearch draft retention and
discard, pending publication, a publication starting during a discard decision, focus restoration,
keyboard tabs, page-scroll reset, status placement and same-key origin changes. The installed agent
harness now checks inherited fieldset disablement with `:disabled`, rather than a button-only flag.

## Trust and secrets

Version `20261016-3` provides Workspace trust, Secrets, MCP credentials and Credential diagnostics.
These native controls are removed from native Advanced; compatibility navigation retains its legacy
anchors. The shared tab, authentication, authority, connection ownership and unsaved-edit protections
apply. Each tab mounts only its own owners.

Workspace trust supports refresh, root filtering, reviewed grants and reviewed revocation. Adding
a sidebar folder does not trust its project configuration or skills. Only existing roots can be
granted; the native receipt names the canonical root. Filtering accepts either Windows slash form.
A failed trust read does not become an empty successful list, and changes are unavailable until a
valid observation is restored. Revocation does not undo completed work or terminate initialized engines.

Secrets supports search/pagination, creation, label/scope/metadata edits, rotation, enable/disable,
confirmed permanent deletion and recent redacted audit events. Username/password creation supplies
both required fields. Rename writes only changed fields; it cannot silently clear scope or metadata.
Metadata is public record information, not a place for credential values. Editing metadata explicitly
replaces it; leaving that option off preserves it. Values stay in write-only inputs and clear when
the editor closes or a mutation is acknowledged. No value-read/use endpoint is called.

`GET /v1/secrets/scopes` requires secret.read and reports a bounded, deduplicated list of existing
user/workspace/group/role/deployment scope access plus management availability. The native principal
owns this response. The UI never derives workspace IDs or invents global-scope access. The endpoint
does not modify permissions or add secret.use. Read-only principals receive disabled management
controls and an explanation; missing audit permission does not block an otherwise authorized roster.
Legacy unscoped records remain diagnostic-only for the desktop principal and require their native
owner for management. The scope-filtered empty state does not claim that the entire vault is empty.
Client admission, client revocation and remote identity administration
remain outside this page until dedicated native contracts exist.

Secret mutations use the existing broker's immediate action protocol. They do not claim manifest
CAS or live engine reconfiguration. A matching redacted acknowledgement confirms the mutation;
refresh failure is shown separately. A transport failure requires checking the roster/audit before
retrying. The UI ignores late results after connection, authentication or authority changes.
Native deletion still refuses records referenced by providers or MCP configuration.

Managed MCP credentials retain their native staged save/delete and unknown-outcome recovery. They
apply at the next server spawn. Discard stage clears the local credential draft without publication.
Credential diagnostics observes vault metadata and legacy startup alias status, without reading
stored values or master keys. An absent legacy alias is no longer described as active.

Installed acceptance uses disposable, unbound records and an empty test directory. It restores the
original grant set, secret ID set and managed-reference set. Redacted native audit events remain as
durable evidence; tests do not erase that ledger. Run without concurrent operator edits:

```powershell
node desktop/scripts/electron-installed-trust-smoke.mjs ABSOLUTE_REGISTERED_DESKTOP_ROOT ABSOLUTE_EVIDENCE_DIRECTORY
node desktop/scripts/electron-installed-secrets-smoke.mjs ABSOLUTE_REGISTERED_DESKTOP_ROOT ABSOLUTE_EVIDENCE_DIRECTORY
node desktop/scripts/electron-installed-trust-credentials-smoke.mjs ABSOLUTE_REGISTERED_DESKTOP_ROOT ABSOLUTE_EVIDENCE_DIRECTORY
```

Tests replace the former request-only secret lifecycle case with stateful roster, acknowledgement,
scope preservation, username/password autofill, cancellation, bound-secret refusal, failed refresh,
read-only permission and late-result checks. Audit parsing now accepts the broker's actual
secret.revoked event. Installed acceptance saves a failure screenshot when a check fails.

Version `20261016-3` verification passed: core 2,514 tests (8 skipped), UI 2,263 tests and web
1,557 tests. Type checking, controlled-language and quality gates passed; root and desktop graphs
were regenerated and checked. The main installer rebuilt the normal registered installation.
All three installed acceptance commands passed, preserving existing grants, records and references.
Browser checks covered grant/revoke, Windows path filtering, native ownership choices, editor discard,
MCP draft discard, diagnostics and settings search. Gateway remained stopped and disabled.
The diagnostics parser now accepts the native projector's required schema version; a test consumes
the actual projector output instead of a fixture that omitted that field.

## Conversation layout containment

Version `20261016-4` bounds the workspace shell to the dynamic viewport height. Intermediate flex
containers allow the transcript to shrink into its available space. Transcript scrolling preserves
the workspace sidebar, application header, operator panel and composer positions. Workspace lists
and operator content use independent overflow scrolling; short content does not reserve scroll space.
Overscroll stays within each region.

The installed geometry regression check uses an existing accessible conversation and transient DOM
fixtures for long transcript, workspace-list and operator content. It asserts independent scroll
positions, stable controls and a viewport-sized document, then removes the fixtures. It never adds
workspaces, sends prompts or modifies conversation records:

```powershell
node desktop/scripts/electron-installed-scroll-smoke.mjs ABSOLUTE_REGISTERED_DESKTOP_ROOT ABSOLUTE_EVIDENCE_DIRECTORY
```

Browser acceptance used the existing long counting transcript, real wheel scrolling, a short workspace
list and prompt jumps. The main installer rebuilt the normal registered installation. UI tests
(2,263), core tests (2,514 passed, 8 skipped) and type checking passed. Installed geometry acceptance
passed for all three regions. Both repository graphs were regenerated and quality gates passed.

## Interface preference persistence

`GET/PUT /api/ui-preferences` uses the application's authenticated API boundary. The server accepts
only the shared presentation preference registry. It stores `ui-preferences.json` under the native
desktop data root supplied to the supervised service. Credentials and execution configuration do
not enter this document. Updates use a bounded body, a revision comparison, the configuration lock,
and atomic file replacement. Invalid updates fail as a whole. Corrupt storage is retained for repair.

Preferences apply immediately. The status remains Saving until the server confirms the new revision
and applied values. Network failures preserve the local edit and offer Retry. Another window's write
produces a conflict; local edits remain visible until the operator explicitly reloads saved settings.
Connection changes invalidate pending results and writes. Reads and saves have a 15-second deadline.
Reloading the browser, reopening the desktop and service port changes restore preferences from the
service, without depending on a previous browser origin's local storage.

The status explicitly names interface preferences. Provider and Advanced forms retain their own
save/publication actions; a saved appearance preference must not imply that an edited engine profile
has been published.

Native turn completion uses the service-authored `turnOutcome` on turn Activity records. This
optional field survives parent/child history persistence. It distinguishes completed, cancelled,
needs_input, failed and unknown outcomes without reinterpreting the legacy display status or its
summary. Compatibility messages use their explicit successful finish field. Idle alone, cancellation,
error, token limits and historical transcript loading do not prove success. The indicator is off by
default and clears after four seconds when enabled.

## Verification

Run the UI and web test suites from their package directories. The foundation tests cover actual
controls, their consumers, disk persistence, concurrent revision conflicts, rejected input, corrupt
storage, failed saves, response validation, late results, keyboard input and completion evidence.

The explicit installed Electron acceptance command is:

```powershell
node desktop/scripts/electron-installed-settings-smoke.mjs ABSOLUTE_REGISTERED_DESKTOP_ROOT ABSOLUTE_EVIDENCE_DIRECTORY
```

This uses the selected installed Electron payload and live registered service, with isolated shell
window state. It changes interface scale through the real control, verifies the server revision and
document effect, restores the original scale, reloads the renderer, checks restoration, captures a
screenshot and confirms that closing the shell leaves the same service generation running. Run it
while other windows are not editing preferences; a concurrent revision refuses restoration instead
of overwriting another window's changes. Its evidence directory is a local test artifact.

Provider acceptance against the same registered installation uses:

```powershell
node desktop/scripts/electron-installed-providers-smoke.mjs ABSOLUTE_REGISTERED_DESKTOP_ROOT ABSOLUTE_EVIDENCE_DIRECTORY
```

This checks the real installed editor, temporarily saves and restores a provider display name,
performs diagnostics, saves and restores a favorite, filters models, and opens native routing.
It verifies server acknowledgements, records an Electron screenshot, and checks that closing the
shell leaves the same background service running. Run it without concurrent provider/preference edits.

The version `20261015-13` acceptance also used the main installer in the registered application and
desktop locations. Browser checks covered creation, correction of invalid limits, an actual stale
editor conflict, failed discovery with a saved model, persisted picker preferences, primary-route
save/activation/restoration, and native tuning publication/restoration. Temporary providers were
removed. Gateway stayed stopped and disabled. The full core, UI and web suites passed.
