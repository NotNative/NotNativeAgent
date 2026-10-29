# NNA desktop settings integration plan

Status: active delivery plan, reconciled for version `20261017-2`. The mapping below describes
the target experience; it must not be read as a list of shipped controls.

Implementation progress: the first native settings foundation is documented in
[Desktop and web settings](DESKTOP_SETTINGS.md). It provides supported preference pages, shared
revision-checked persistence, working consumers, keyboard editing and successful-turn feedback.
The remaining options in the mapping below are the roadmap, not claims of shipped controls.

## Delivery status

| Area | Status | Remaining scope |
| --- | --- | --- |
| Tray and launch | Delivered with General launch/login preferences and installed restart/reconnect | Explicit installed-browser selection remains deferred; system default is supported |
| Settings foundation | Delivered for supported preferences | OS/browser notifications, sound and additional host adapters |
| Providers and models | Delivered for the native adapter | Additional adapters and capability-backed presets as supported |
| Agent policy and context | Delivered for native defaults and session review | Workspace instruction editing, saved-memory CRUD and editable delegation limits need native owners |
| Operational capabilities and data | Delivered supported management/observations | Full support bundles, import, attachment inventory/cleanup and retention need native contracts |
| Settings cohesion | Delivered; General/lifecycle now has native host ownership | Complete field-level search; candidate update lifecycle verified, direct GitHub candidate installation awaits publication |
| Trust and secrets | Delivered native scope-aware management and diagnostics | Legacy unscoped records require their native owner; client revocation/remote identity require dedicated native contracts |
| Optional media and knowledge | Deferred | STT/TTS, images, indexing/retrieval and sandboxed artifacts require separate adapters |

Next sequence: complete field-level search and publish/verify the candidate through GitHub after authorization. Add optional media/knowledge
after these existing flows are coherent. Every new control must have a native owner and behavior test.

General/lifecycle delivery uses the selected local desktop's native host adapter. The shortcut can
open Desktop or the system default browser. Explicit tray destinations remain explicit. Windows
sign-in uses the NNA service's existing startup wiring rather than Electron's shell-login registry.
Restart requires confirmation, replaces the verified controller generation and reconnects the desktop.
Browser General exposes connection/version observations and host recovery guidance; it cannot acquire
local process authority. Closing a desktop window continues to leave the background service running.
No new close-to-tray switch or arbitrary browser executable field is exposed.

## Purpose and decisions

Give NNA one understandable settings interface shared by desktop and web. Use OpenWebUI's
organization, consistent fields, search, and progressive disclosure as references. Implement the
behavior against NNA's own runtime and configuration contracts. Do not copy its implementation.

The first priority is finding and changing real NNA settings without understanding the current
configuration inventory. Keep the existing inventory available under Advanced for diagnosis.

Decisions carried forward:

- The default workspace is the permanent catch-all. New conversation reuses the unfinished draft.
- Provider configuration belongs in Settings. The composer selects a configured model and review policy.
- Mandatory reviewer governance remains in effect for every execution posture.
- Native admission owns executable workspace identity. Folder labels and UI preferences grant no access.
- Optional capabilities remain optional. NNA must work without NotNativeMemory, remote services,
  a document index, voice services, or an image-generation server.
- Settings affect the scope they name. Changing a default must not silently change an existing session's route.

## Evidence and present NNA state

Reference: the authenticated OpenWebUI instance at `http://jill:3000`, reporting v0.12.2, and
`D:/ProjectRepo/External/open-webui` at commit `6a18585ff`. This is the local reference version,
not a claim about every upstream version. All 27 visible settings tabs were visited. Source review
covered 100 settings and dependent components, including forms hidden by feature flags, roles,
provider choices, or disabled services. Conditional source review did not enable those services.
The adjacent [source inventory](DESKTOP_SETTINGS_REFERENCE_INDEX.json) identifies the reviewed files
and their setting labels. It contains no configured values, credentials, or implementation code.

Historical NNA state at the initial reference review (superseded by the delivery status above):

1. Native settings currently expose only Providers, Native Configuration, and Installed Skills.
   `desktop/packages/ui/src/components/settings/window.tsx` restricts the native page registry to
   those three pages. Other settings components existing on disk are not proof of native availability.
2. Native Configuration already composes many real controls: configuration previews and publication,
   provider routes, workspace trust, secrets, MCP credentials, web search/fetch, provider and browser
   observations, gateway controls, services, package actions, updates, and installation observations.
   The problem includes organization and presentation; much of this backend should be reused.
3. Several general pages still name OpenCode settings or use the older desktop settings store.
   Exposing every existing page would introduce controls that do not govern NNA. Each binding needs audit.
4. The Windows tray previously had desktop labels, a generic state-ring icon, and Open/Quit only.
   There was no tray browser action or persistent UI-browser chooser.
5. Windows default-browser selection is sufficient for the first browser action. A dedicated browser
   choice is a separate preference, not a dependency for opening the web UI.

Primary NNA implementation references:

- `desktop/packages/ui/src/components/settings/window.tsx`, `search.ts`, and `primitives.tsx`.
- `desktop/packages/ui/src/components/settings/pages/native-configuration.tsx` and its typed controls.
- `src/configuration-catalog.js`, `configuration-keys.js`, `desktop-configuration-service.js`,
  `desktop-configuration-intents.js`, and `desktop-configuration-routes.js`.
- `src/provider/profile-store.js`, `src/provider/route-configuration.js`, and the provider settings pages.
- Native MCP, workspace, secret, web-search, web-fetch, notification, and lifecycle route families in `src/`.
- `desktop/packages/ui/src/chat/sidebar-service-preferences.ts` and conversation draft persistence.

## Settings navigation

Use a searchable settings window with grouped navigation and section links. The desktop and web
show the same supported NNA settings. Host-specific controls identify the selected host and appear
only where supported. Keep technical configuration paths in expandable details.

| Group | Page | Sections |
| --- | --- | --- |
| Preferences | General | Startup destination, desktop/browser behavior, start at login, close-to-tray behavior, versions |
| Preferences | Appearance | System/light/dark theme, contrast, text scale, fonts, content width, motion, code/transcript display |
| Preferences | Conversations | Send-key behavior, queue behavior, scrolling, titles, suggestions, attachment defaults |
| Preferences | Notifications | Completion/error/question/subagent events, foreground/background delivery, sound, supported targets |
| Preferences | Keyboard | Searchable commands, editable bindings, conflicts, reset by command or section |
| Agent | Providers and Models | Profiles, credentials, discovery, health tests, model selection, capabilities, approved parameter presets |
| Agent | Routes and Review | Primary/reviewer/subagent routes, supported generation settings, review posture, context and recovery budgets |
| Agent | Memory and Context | Local/project memory, optional external memory, instructions, retention, context use and compaction |
| Workspace | Workspaces and Conversations | Permanent default, admitted folders, labels/order, drafts, archives, export and import |
| Workspace | Files and Knowledge | Upload rules and limits; managed attachment storage; optional extraction/index/retrieval controls |
| Capabilities | Tools and Integrations | MCP, native tools, terminal/browser capabilities, credential binding, connection tests |
| Capabilities | Skills and Hooks | Installed skills, supported catalogs, bundle provenance, enablement, hook review and rollback |
| Capabilities | Search and Browsing | SearXNG and other supported search adapters, fetch trust, managed browser status and installation |
| Capabilities | Voice and Media | Supported STT/TTS first; optional image generation/editing only after backend support exists |
| System | Services and Updates | Desktop/background runtime, gateway, OpenCode compatibility service, login wiring, update stages |
| System | Trust and Secrets | Workspace grants, operator/client credentials, secret metadata and rotation, supported remote access |
| System | Data and Diagnostics | Storage locations, support export, logs, measured usage, retention and bounded cleanup |
| System | Advanced | Effective configuration, source/override details, operation receipts, compatibility and unsupported capabilities |

These are navigation destinations, not a requirement to expose 18 pages at once. Begin with the
implemented groups and add pages as their complete flows pass acceptance. Child sections can
share a page until their size warrants a separate destination. Search must find section and field
names, aliases such as "API key" and "tray", and relevant outcomes such as "restart required".

## Ownership and save contract

| Scope | Examples | Owner and persistence |
| --- | --- | --- |
| Device/host | OS browser choice, window placement, host startup wiring, microphone choice | Host adapter or host preference service; identify which machine changes |
| Data root/operator | Theme defaults, notification choices, providers, route defaults, retention | NNA service-backed settings or existing native configuration owner, according to field |
| Workspace | Admitted root, display label/order, workspace instructions, project defaults | Native admission for execution identity; presentation service for labels/order; project configuration for instructions |
| New conversation | Initial workspace, selected model, review posture, prompt/attachments | Durable conversation draft, captured before creation |
| Existing session | Pinned route, reviewed workspace changes, execution policy and context | Session engine and its durable records; never a global UI settings write |

Build a field registry that joins the settings presentation to an existing typed native capability.
Each field declares its page/section, label/help, type/bounds, current value, default, source,
override scope, secret status, allowed mutation, and when the change applies. It must distinguish
read-only observation from writable configuration. Unsupported provider parameters must not
become arbitrary JSON writes to the runtime.

For each write:

1. Load the selected installation/data identity, source revision, and effective state.
2. Edit a local form draft. Display validation before Save; do not silently clamp values.
3. Use the existing preview/publication or compare-and-swap protocol where available.
4. On success, re-read effective state. Show Saved, Next conversation, or Restart required accurately.
5. On conflict, preserve the form draft and offer Reload/Compare. Do not overwrite another window.
6. On authentication/authority/runtime changes, cancel or invalidate the operation and its preview.

Use section-level saves for related settings and explicit action buttons for service operations.
Reset means reset this section or override; it must not reset unrelated credentials, routes, or sessions.
Secrets are write-only inputs backed by native credential handles. Never export them with ordinary
preferences. No controller credential belongs in a browser setting.

## OpenWebUI personal settings mapping

| Reference page and options | NNA decision and destination | Delivery |
| --- | --- | --- |
| General: theme and language | Adopt theme organization in Appearance; expose only shipped, verified translations | Slice 1 |
| General: system prompt | Adapt as user/workspace instructions with source and scope. Keep reviewer/system authority separate | Slice 3 |
| General: Advanced Parameters and Custom Parameters | Model-capability-aware presets under Providers/Routes; detailed parameter rules below | Slice 2–3 |
| Interface: UI scale, font family, contrast/accessibility, tab title, username display, wide/bubble layout | Adopt useful presentation choices. Tab title can protect privacy by hiding conversation names | Slice 1 |
| Interface: location and Android haptics | Location only for a specific capability with permission and declared purpose; defer platform haptics | Optional |
| Interface: rich/plain input, formatting toolbar, prompt insertion, large paste as file, Enter behavior | Adopt send-key and paste controls first; rich input must preserve plain-text command/attachment semantics | Slice 1, then 4 |
| Interface: message queue, auto-scroll, branch-change scrolling, markdown rendering, code/details expansion, hover previews | Adapt to NNA's actual queue/fork/transcript APIs. Do not render active previews for hidden sessions | Slice 1/4 |
| Interface: automatic title, tags, follow-ups, prompt autocomplete and insert-versus-send options | Keep titles useful; make extra generation opt-in with visible model/cost scope. Suggestions insert text by default | Slice 2/4 |
| Interface: clipboard auto-copy and formatted copy | Offer explicit copy format; leave auto-copy off to avoid replacing unrelated clipboard data | Slice 1 |
| Interface: background image, quick-action customization and styled PDF export | Defer decoration; adopt a small configurable action set and export after lifecycle/data work | Slice 4/optional |
| Interface: temporary chat default | Do not imply execution is unrecorded. Consider a clearly named no-history presentation mode only after defining retained audit evidence | Separate decision |
| Interface: multi-model response tabs | Defer to a genuine comparison workflow; do not reintroduce redundant conversation tabs | Optional |
| Interface: terminal file placement, show files on selection, same-origin previews | Gate on native file/terminal support. Preview isolation is policy, not a casual user toggle | Slice 4/optional |
| Interface: web search default, full-document/focused retrieval, image compression and dimensions | Respect per-conversation capabilities and supported adapters. Show attachment processing and effective size limits | Slice 4/5 |
| Interface: artifact detection, scripts, same-origin, forms and downloads | Defer until a sandboxed artifact viewer exists. No general same-origin/script bypass switch | Separate capability |
| Interface: voice interruption and emoji in calls | Voice interruption only after cancellation is reliable; defer call decoration | Slice 5 |
| Notifications: browser permission, sound, targets and target-specific options | Adapt with event types and hidden-only delivery. Local completion badges and OS notifications are separate preferences | Slice 1/4 |
| Keyboard: enablement, per-command rebind, recorder, conflicts, reset, chat/global/input/message/voice groups | Adopt structure; expose only commands backed by NNA. Keep browser/OS reserved-key conflicts visible | Slice 1 |
| Personalization: memory enablement, saved-memory search/add/edit/delete/clear | Adapt to NNA's actual local/project/optional external memory owners. Retrieval content never becomes authority | Slice 3/4 |
| Audio: STT engine/language, instant send; TTS engine/voice/speed/auto-play, local versus non-local voices, Kokoro dtype | Capability-gated STT/TTS, manual send by default, disclose remote audio processing and local downloads | Slice 5 |
| Data Controls: import/export conversations, shared-chat manager, archive/delete all, uploaded file manager | Export and archive first. Import validates schema and cannot replay tool authority. Sharing and destructive bulk actions require separate contracts | Slice 4 |
| Usage: Overview, activity/time ranges, model and tool use, synchronization detail | Show measured versus estimated tokens, calls, duration and supported cost data; no invented exact billing | Slice 4 |
| Archived Chats: search, restore, export, delete, restore all | Reuse NNA archive lifecycle, preserve workspace ownership, use explicit destructive confirmation | Slice 4 |
| Account: name/avatar/bio, gender/birth date, prompt variables, password, MFA/recovery codes, API keys/JWT | Optional display name/avatar only. Omit demographic account fields. Move real credentials/trust controls to Trust and Secrets; no JWT-copy page | Slice 1/4 or omit |
| About: installed/latest versions, release notes, update check, Ollama version, community/license | Adopt NNA/core/desktop/protocol versions and update status; show external engine versions only when configured | Slice 0/1 |
| Conditional personal Connections: direct connections and configuration modal | Use service-owned provider profiles. Browser-session-dependent direct inference is not the default architecture | Slice 2 |
| Conditional personal Integrations: tool connections and terminal servers | Fold into Tools and Integrations; avoid a second independent connection inventory in the user settings | Slice 4 |

### Advanced generation parameters

| Reference controls | NNA treatment |
| --- | --- |
| Streaming and delta chunk size | Streaming is a transport/display choice. Do not imply a provider supports a streaming mode it does not expose |
| Temperature, top-p, top-k, min-p, seed, stop sequences, frequency/presence/repeat penalties, logit bias | Offer supported fields with bounds, defaults, and reset. Bind to a profile/preset, never silently to all providers |
| Reasoning effort and think | Display only advertised/supported options. Keep primary, reviewer and subagent budgets distinct |
| max_tokens | Show the effective provider output ceiling and NNA's bounded allowance; distinguish input context from output capacity |
| Context compaction threshold, num_ctx and num_keep | Use NNA context budgets and compaction contracts. A UI number cannot enlarge the real model context window |
| Native/legacy function calling and reasoning tags | Keep native tool contracts. Reasoning-tag rendering must not infer success, authority or completion from model text |
| JSON/structured response format | Add only with adapter support and validated schema; do not disrupt native tool continuation contracts |
| Mirostat/eta/tau, tfs_z, mmap, mlock, batch, threads, GPU layers, keep-alive | These are engine-specific. Defer local model-server management; do not pretend NNA owns a remote server's memory/GPU settings |
| Arbitrary custom parameter name/value | Replace unrestricted passthrough with a validated extension allowlist. Credentials, endpoint, tools and reviewer policy cannot be overridden here |

## OpenWebUI administration mapping

| Reference page and submenus | NNA decision and destination | Delivery |
| --- | --- | --- |
| General: versions/help/license, sharing, rating, folders/counts, memories/system context, notes, channels, response modes, apps, calendar, automations, webhooks, user status, watermarks, canonical URL | Adopt service/version diagnostics and feature availability. Preserve folder/memory concepts. Defer hosted community features. Native automation needs its own authorized scheduler before a toggle appears | Slice 1/4; optional modules later |
| General: default interface settings, translations and banners | Adopt shared presentation defaults with clear overrides. Ship translations as reviewed assets; defer runtime translation editor/banners unless needed | Slice 1 |
| Authentication: signup/login, default roles/groups, endpoint-restricted API keys, JWT lifetime, pending-user overlays, LDAP/TLS/groups, OAuth/OIDC claims/domains/roles, MFA | NNA's local operator/client trust model is the immediate target. Display session expiry, revocation and client scope. Defer signup, LDAP, SSO and organization RBAC to an explicit multi-user product | Slice 4; hosted identity deferred |
| Interface: task/local/external models and task parameters | Adapt into named NNA routes for title generation, primary/reviewer/subagents and other supported tasks; keep one provider inventory | Slice 2 |
| Interface: tool permission menu | Expose supported NNA review postures with accurate descriptions; no Full Access switch that bypasses mandatory reviewer governance | Slice 3 |
| Interface: compaction model, threshold/cap, retained messages and prompt | Present effective context budgets, source and application timing; retain reviewed native compaction invariants | Slice 3 |
| Interface: deferred tool search, threshold and always-loaded tools | Evaluate against NNA's tool catalog and bounded discovery. Do not advertise it until the runtime supports the contract | Optional |
| Interface: title/voice/follow-up/tag/query/autocomplete/image/function-call generation prompts | Task-specific optional templates with scoped defaults and model route. Avoid a page of unrestricted engine prompt replacements | Slice 2/3/5 |
| Connections: OpenAI-compatible and Ollama groups, add/edit/verify, enablement, direct connections, model cache refresh | Adapt cards, explicit tests and stale/last-success state to NNA profiles. Group by configured provider, not a hard-coded OpenAI/Ollama split | Slice 2 |
| Models: search/filter/view, drag order, selected/pinned/visible/enabled, import/export/clone, defaults, model manager and row menu | Adopt discovery, favorites, visibility and per-model overrides. Keep enabled, reachable and selected distinct; imported model records do not import credentials | Slice 2 |
| Models: editor/history, compare revision, production version, descriptions/images/tags, system prompt, parameter controls, prompt suggestions, tools/skills/knowledge/actions/filters, voice/avatar and terminal defaults | Adopt named agent/model presets with a reviewed diff and revisioned publication. Existing sessions keep their captured route. Defer production-version promotion and voice avatars until real version/media contracts exist | Slice 2/3; optional additions |
| Sub-agents: enablement, concurrent/background limits, iterations, output ceiling, system prompt | Map to supported NNA delegation routes and limits, inherited authority, cancellation, durable child lineage and evidence | Slice 3 |
| Integrations: external tools/OpenAPI/MCP, terminal and knowledge servers, direct integrations | Service-owned MCP first. OpenAPI tools require an adapter through NNA governance. Terminal servers and external knowledge need separate capability contracts | Slice 4 |
| Documents: extraction engines and OCR/format/cache options; splitter/tokenizer/chunk/overlap; embeddings/batch/concurrency; hybrid/BM25/rerank/top-k/relevance; RAG template; upload limits/extensions/compression; Drive/OneDrive; reset/reindex actions | Begin with existing attachment limits/storage. Add extraction/index/retrieval only as optional supported adapters. Never expose reset/reindex buttons before their storage and recovery semantics exist | Slice 4 then optional knowledge module |
| Audio: call mode, STT/TTS engines/endpoints/credentials/models/voices/MIME types, Azure settings, API format, extra parameters, response splitting | Split personal playback/input preferences from service/provider setup. Install/download and remote transmission need explicit user-facing actions | Slice 5 |
| Images: create/edit providers, API credentials/version/extra params, model/size/steps, prompt rewriting, ComfyUI workflow/nodes and provider-specific methods | Optional provider adapters after runtime support. Validate workflow files as data; do not execute arbitrary imported code | Slice 5 or separate capability |
| Web Search: provider selection, credentials, language/region/depth, result/content/token/concurrency limits, domain filters, confirmation, loader/retrieval bypass, proxy trust, TLS, Playwright and external loaders, YouTube language/proxy | Expose NNA's actual SearXNG/search/fetch/browser capabilities first. Register other adapters incrementally. Keep TLS verification on; distinguish domain filters from native network authority | Slice 4 |
| Code Execution: enablement, Pyodide/Jupyter engine and URL/auth/timeout; interpreter enablement/engine/prompt | NNA already governs native process/tool execution. Do not create an independent chat-side executor. Notebook/sandbox adapters require explicit workspace/authority/timeout/cancellation integration | Slice 3/4; notebooks optional |
| Pipelines: source URL, Python upload, GitHub installation, selected pipeline, delete, typed valves | Do not adopt arbitrary Python upload/run. Adapt the configuration UX to reviewed skills/hooks/MCP bundles with provenance and supported rollback | Slice 4 |
| Analytics: dates/ranges, model/user/token/message counts, drill-down, ratings and tags | Local operator usage and diagnostics first. Telemetry export remains opt-in and content-free by default. No multi-user leaderboard in the local product | Slice 4 |
| Evaluations: arena models, add/edit routing and comparison configuration | Defer arena UI. Preserve a place for NNA verification/evaluation results that distinguishes generated answers from executed checks and receipts | Optional |
| Database: configuration import/export, database download, all-chat JSON, users CSV | Provide redacted configuration and support exports plus explicit session export. Never offer a live SQLite-file download as a consistent backup without a snapshot protocol | Slice 4 |
| Conditional Apps: app identity, channels, credentials and allowed scopes | Defer the hosted apps model. Any NNA connector must declare scopes and preserve native execution governance | Optional |

Provider-specific search credential fields in the reference include SearXNG, Brave, Google PSE,
Tavily, Kagi, Bing, Exa, Jina, Firecrawl, Perplexity and additional regional/external adapters.
They are a pattern for conditional connection forms, not an instruction to implement every provider.
Unsupported provider choices must be absent, rather than selectable placeholders.

## Submenu behavior to retain or change

### Provider connection dialog

Retain name, provider type, endpoint, enabled state, masked credential binding, discovered/manual
model IDs, capability information, tags, Test connection, and last result. Make advanced headers,
API version and Responses versus Chat Completions visible only for adapters that implement them.
NNA secrets stay in the native secret broker. Do not adopt forwarding browser cookies, user session
tokens or arbitrary OAuth credentials to a model endpoint. OAuth/Entra integration needs its own
native credential contract. Prefix IDs and model aliases must not change the canonical provider/model identity.

### Model defaults and presets

Use one source of available models for Settings and the composer. A preset can choose a configured
model, supported sampling/reasoning parameters and optional instructions. Capabilities are observed
or explicitly operator-declared with provenance; a checkbox cannot manufacture vision/tool support.
Keep favorites/visibility separate from execution enablement. Do not let a rename or reorder alter routes.
Import/export is versioned, validated, redacted and previewed before applying. Deleting a profile
used by an existing session must not silently redirect that session.

### MCP and external tool dialog

Retain stable ID, display name, transport, endpoint or executable/args, enablement, credential
binding, allowed environment metadata, connection test, tool inventory and operation receipts.
Show static versus dynamic OAuth registration only when the native adapter supports it. A tool-name
filter controls exposure, not reviewer authority. OpenAPI specs are untrusted data; imported schemas
cannot grant filesystem access, replace policy or enable arbitrary code execution.

### Terminal and execution configuration

The reference includes terminal endpoints, auth, chat versus shared contexts, uploads, filesystem,
orchestrator policy, image/CPU/memory/storage, persistence/idle timeout, environment and lifecycle JSON.
For NNA, first show the real local CWD, native permissions and process cancellation/timeout policy.
Only add remote terminal provisioning after a supported lifecycle adapter exists. Container resource
limits and working-directory context must be actual enforced settings, not prompt text.

### Files, memory and retrieval managers

Distinguish attached files, managed copies, indexed sources, saved memory and execution evidence.
Every manager needs source/workspace ownership, status, size/limits and a clear remove action.
Changing an embedding model requires explicit reindex planning; do not silently mix incompatible vectors.
Reset Uploads, Clear Memory and Reset Knowledge are different destructive operations. An upload
is not a trusted instruction source. Never enable public sharing as a side effect of export.

### Notifications and completion

Expose separate preferences for in-app status, OS/browser notifications, sound and configured remote
targets. Default ordinary completion delivery to background/hidden windows; avoid duplicate tray,
desktop and browser notifications. A successful response can say Turn completed. Error, cancellation,
waiting for input and session archive/closure require distinct structured states. Busy-to-idle alone
is insufficient evidence of success. Existing completion celebration behavior should be repaired
in the notification slice, not merely relabeled.

### Desktop and browser launch

Open in browser uses the Windows default browser now. A browser without an admitted cookie gets
a prefilled one-use code and an Unlock action. The launch code is removed from the fragment before
the app initializes and is redeemed only in a POST body against the matching local origin.
Controller tokens and long-lived cookies are never put in the launch URL or exported to another browser.

General now offers a default launch destination Desktop / Browser, using the system default
browser. Selecting another installed browser remains deferred. Reopening resolves current service
discovery; it does not save an ephemeral port. External links retain their normal behavior.

Restart NNA in the tray means the selected desktop/background NNA runtime. It must wait for the old
controller to disappear, start through the selected installation, verify a different ready generation,
and retain one service-owned tray. It must not enable or restart Telegram/OpenCode services implicitly.
The General/Services page explains interruption behavior and shows restart progress. Existing
TUI sessions and other installed services are separate owners.

## Delivery slices and acceptance

| Slice | Work | Acceptance and dependencies |
| --- | --- | --- |
| 0 Tray and launch | NNA icon/labels; Open Desktop, Open in browser, Restart NNA, Quit NNA; generation-aware tray handoff | Install into the registered location; real service stop/start; new ready generation and one tray; browser launch code scrubbed and matching-origin redemption; unknown ownership refuses restart |
| 1 Settings foundation | Native capability registry, grouped pages/search, appearance, conversation basics, notifications/keyboard, General/About | Each visible field changes its named behavior and persists across browser reload, port change and desktop reopen; no OpenCode-only controls in native mode; no fake Save |
| 2 Provider and model experience | Connection cards/dialogs, secret bindings, discovery/status, favorites, defaults, supported presets, named route editors | Two providers with identical model names remain distinct; unreachable provider retains saved choices; credential redaction; active sessions keep their routes; failed test is visible |
| 3 Agent policy and context | Review posture, prompt sources, context/recovery/delegation limits, memory controls and application timing | Preview/CAS conflicts preserve edits; mandatory governance remains; workspace/session scope is correct; cancellation and child limits enforced by runtime |
| 4 Operational capabilities and data | MCP/skills/hooks, search/fetch/browser, workspaces, archives, safe export/import, files, usage, services/update diagnostics | Only real adapters exposed; default workspace protected; negative outcomes and missing dependencies are actionable; exports redact secrets and import cannot restore execution authority |
| 5 Optional media and knowledge | STT/TTS, image adapters, document extraction/index/retrieval, sandboxed artifacts as separate supported capabilities | Explicit dependency setup and privacy scope; bounded uploads/models/jobs; safe cancellation; graceful absence; no requirement for core chat/agent work |

Implement each row as several small end-to-end slices when needed. Each verified product slice
gets its own tests, canonical version bump, graph/language regeneration and commit. Do not begin
by replacing the settings window wholesale or exposing all dormant pages.

### Required failure scenarios

| Plausible failure | Required outcome |
| --- | --- |
| A form was loaded on host A, then the operator switches to host B | A's pending result cannot write B's settings or claim they were saved |
| Two windows change the same section | Revision conflict; preserve local edits and offer comparison/reload |
| Provider discovery fails while saved models exist | Keep saved models selectable, label discovery failure, allow retry |
| A provider/profile is renamed, disabled or removed while a session uses it | Preserve pinned identity; show an explicit unavailable/refused route, never silently fall back |
| Settings storage is full, corrupt or read-only | Preserve input; no Saved banner; useful path/operation error and bounded recovery |
| Restart occurs with a running turn or pending first send | Explain/confirm the interruption where needed, preserve durable recovery evidence and refuse unverified ownership |
| Service restarts on a new port with an old browser window open | Rediscover/reconnect through the host path or show reconnect guidance; preserve draft/settings state |
| A new tray starts before the old tray releases its lock | Bounded generation handoff; exactly one tray survives |
| Installer finds a disabled gateway with a stale PID record | Do not infer a running gateway from uncertainty or enable it; verify identity before stop and respect disabled state before restart |
| An optional extraction, search, audio or indexing service is absent | Core NNA remains usable; unavailable capability has specific setup guidance |
| A user imports a config/model/tool file containing credentials or policy overrides | Reject unsupported fields and authority changes; show a redacted preview before applying allowed data |
| An interrupted or failed turn changes status back to idle | No successful-completion celebration or misleading session-ended message |

### Verification procedure

1. Unit tests target owning state transitions, invalid input, conflicts, cancellation and late results.
2. Route tests cover authenticated reads and narrow mutations, including unsupported/denied cases.
3. Browser tests exercise real configured providers and the installed service, including reload and port change.
4. Desktop-specific acceptance covers the native chooser, tray, OS browser launch, login wiring and window lifecycle.
5. Install/update acceptance includes an idle running service, a stopped service, disabled gateway,
   fresh optional-desktop installation, installed desktop upgrade, restart failure and recovery.
6. For each change, verify source tests and the built installed artifact. A source-only success is not installed acceptance.

The source main installer completed a full upgrade acceptance run for `20261015-11`, including the
registered desktop upgrade, while Gateway remained stopped and disabled. The later updater acceptance
is recorded below. A desktop-only installer or source main-installer success must
not be reported as proof of the updater command's acquisition and execution path.

## Original foundation scope (delivered)

Slice 1 established a native-only settings registry and General, Appearance, Conversations,
Notifications, Keyboard and About experience, while preserving the existing Provider, Skills and
Advanced configuration workflows. Provider/model management and native agent/operational settings
followed. Optional voice, image and retrieval infrastructure remains a later capability decision.

## Delivered updater lifecycle verification

Version `20261017-2` verifies both NNA and registered desktop versions and preserves the observed
running/stopped and sign-in states. The main installer drains desktop before replacing NNA files.
Partial failure retains repair source and prior payload evidence, without an unsafe NNA-only rollback.
Custom installations select their own descriptor. The installed two-case matrix and real GitHub
archive inspection passed; direct GitHub installation of this candidate awaits publication.
See [update lifecycle](UPDATE_LIFECYCLE.md) for the acceptance command and exact verification boundary.

## Delivered General and lifecycle

Version `20261017-1` delivers native host controls in General and Services: Desktop/browser shortcut
selection, Windows sign-in wiring, browser launch, verified restart/reconnect and live version
observations. Browser mode provides local-host guidance. The system default browser is supported;
specific browser selection and an editable close policy remain deferred.

The registered main installer and installed Electron acceptance verified every exposed host control,
restored preferences and sign-in state, and preserved the exact active conversation and unsent text
through a real restart. Cold conversation resolution and restart recovery now take precedence over
automatic draft and workspace fallback. UI tests cover those races and refused persistence. See
[desktop settings](DESKTOP_SETTINGS.md) for ownership, bounds and verification details.

## Delivered agent policy and context settings

Version `20261015-14` exposes the supported native policy, recovery, context and optional-memory
settings in dedicated Agent pages. Conversation review policy remains conversation-scoped and uses
the native revision contract. Editors show source details, native previews, explicit resets and
publication receipts. Revision refusals retain edits; unknown saves retain operation recovery.
Search waits for native fields to load. See [desktop settings](DESKTOP_SETTINGS.md) for exact controls,
application timing, test results and the installed acceptance commands.

Saving non-provider defaults requires an NNA restart before newly constructed engines consume them.
The UI explains this limitation. Fixed delegation rules are descriptive; editable child limits,
per-workspace instruction editing, and saved-memory content management need dedicated native owners
before they can be exposed. No unsupported control is presented as a working setting.

## Delivered operational capabilities and data

Version `20261016-1` provides dedicated native Tools and integrations, Skills and hooks, Search and
browsing, Services and updates, and Data and diagnostics pages. The 17 sections reuse native owners,
with one mounted section and connection/authentication guards. Diagnostic metadata export, bounded
conversation text export, archive/restore and attachment defaults are functional. Update checks are
explicit; installation remains the platform updater's responsibility. See [desktop settings](DESKTOP_SETTINGS.md)
for exact bounds, application timing, acceptance commands and results.

The main source installer upgraded the registered installation. Browser and installed Electron
acceptance exercised reads, previews, publication/restoration and local downloads. Temporary MCP
definitions were removed and verification conversations archived. Gateway remained stopped and
disabled. Full core, UI and web suites passed. Incorrect optional-credential and authentication-recovery
test assumptions were repaired, with additional failure-path coverage.

Full evidence/support bundles, authority-free import, bulk permanent deletion and additional remote
adapters remain deferred until dedicated native contracts exist. Transcript exports must never
become imported execution authority. Global costs are not inferred from estimated context; the
existing conversation context panel remains the usage surface. The later updater acceptance above
records the verified candidate path and the remaining GitHub publication boundary.

## Delivered Trust and secrets

Version `20261016-3` moves workspace grants, secret lifecycle actions, managed MCP credentials and
credential diagnostics into a dedicated page. Native Advanced retains effective configuration,
compatibility, packages and diagnostic inventories. Only the selected trust section mounts.

Secret creation and ownership selection use scopes reported by the authenticated native broker.
The read-only scope discovery endpoint reports existing access and management availability; it
does not grant permissions, reveal stored values or enable secret.use. Global scope is not offered
when the native principal cannot manage it. Workspace admission and trust remain distinct.

Grant/revoke, enable/disable and permanent secret deletion have explicit review steps. Native
acknowledgements and subsequent read outcomes remain distinct. Renaming sends only changed fields,
preserving unrelated scope and metadata. Username/password creation supports both required fields.
See [desktop settings](DESKTOP_SETTINGS.md) for contracts, verification commands and remaining limits.
