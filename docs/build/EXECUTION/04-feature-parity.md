# Feature completion against native NNA

Status: executable build guide; work packages below are open until their native and installed acceptance evidence is recorded. This guide changes the build direction, not production code. Historical P0–P13 completion, a rendered control, a mock test, and a safe “unavailable” response are not proof of native feature completion.

## Authority and completion boundary

NND is an optional, separately installed Windows product on the same computer as NNA. Its browser and desktop application reach the same persistent NND service and NND-owned session collection. NNA remains independent; its TUI retains its tab model and sessions. NND must not automate the TUI, discover its tabs as desktop sessions, or parse terminal display as engine state.

The OpenChamber v1.23.0 documents in `docs/planning/04`–`07` and `12`–`15` define reference feature breadth and interactions. They do not authorize OpenCode-specific storage, provider calls, auto-accept, implicit grants, or a second governance engine. Retain their chat and visibility capabilities by supplying NNA-native contracts. Where the reference and this guide differ, this guide defines the intended product; record the precise adaptation alongside acceptance evidence.

The MVP includes the full local chat, workspace, review, terminal, autonomy, knowledge, and visibility experience mapped below. Remote hosting, SSH/relay/tunnel transport, non-Windows packaging, VS Code, and native mobile shells are outside this same-computer MVP. Deferring those transports must not defer browser access on the same Windows computer. Ordinary browser limitations require a supported equivalent or an explicit desktop-only native action; they do not justify removing shared chat/visibility features.

Settings ownership and complete NNA configuration coverage are specified by [03-settings.md](03-settings.md) (C packages); installed lifecycle is specified by [02-installation-lifecycle.md](02-installation-lifecycle.md) (L packages). This guide owns F1–F10. V means the installed acceptance/verification work owned by the execution plan. “Depends on C/L” means the relevant contract must be available before declaring the F package complete, not that an agent may silently skip it.

## Confirmed gaps and consequences

These findings were inspected in the current source on 2026-10-01. Recheck named targets before modifying them; other agents can change the repository.

| Finding | Concrete failure and downstream consequence | Required package |
|---|---|---|
| ~~NNA `src/nnd-harness-routes.js:textContent` filters parts to text; NND `sync/session-actions.ts` sends optimistic file parts.~~ Rechecked 2026-10-11 against NNA `20261011-5`: stale. `promptParts` fails closed (`nnd_prompt_part_unsupported`) for unknown part shapes, and uploaded file parts resolve through the authenticated attachment-admission route into engine-bound `attachments`; the integration suite proves upload admission, permission refusal, single-use expiry, retry-after-persisted-acknowledgement, and that a mixed text + uploaded-file prompt delivers both content and attachment to the engine. | Closed by the current source; the remaining acceptance is the installed image/file journey (04:86), not a route gap. | F3 (closed at route level) |
| ~~NNA session creation selects `nndWorkspaceRoot`; the engine host uses configured `workspaceRoot`; browser directory headers are deliberately not execution authority.~~ Rechecked 2026-10-11 against NNA `20261011-6`: stale in its concrete claim. Session creation resolves a per-session binding from the admitted workspace (`resolveContextBinding` → `options.workspace_id`), the engine is constructed with that binding, and `assertBoundEngineWorkspace` fails closed when the engine root is not exactly the binding's `configured_root` — including after durable journal replay during `initialize()`. Dedicated coverage: `nnd-workspace-binding` (revocation guard, replaced-workspace refusal, replay-to-another-directory refusal, restored-child identity) plus integration admission tests. The retained half is deliberate design: browser directory headers are not execution authority. | Closed by the workspace-admission binding; residual is the installed two-project/worktree journey. | F1 (closed at host level) |
| NND client exposes `/session/:id/fork`, `/revert`, `/unrevert`; the native harness route catalog lacks those operations. Rechecked 2026-10-11 against NNA `20261011-8`: the fork half is landed — `POST /session/:id/fork` with `{messageID}` (positional `session:message:index` or submitted user request id) creates a child `ses_*` session whose durable journal is seeded with the parent prefix up to the boundary turn's `turn_outcome` through the child's own hash-chained append path (no cross-session reads at restore; a `forked_from` provenance record carries `source_session_id`/`boundary_message_id`/`record_count`). Boundary rules: the turn must be completed (`nnd_fork_boundary_unsettled` 409 otherwise), the boundary message must exist (`nnd_fork_boundary_unknown` 404), the session must be idle and durable (`nnd_fork_busy` 409 / `nnd_fork_unavailable` 503); the fork reuses the parent's workspace binding and review mode and requires the `nnd.session.create` grant. Real-engine coverage proves the child replays the inherited transcript, continues submitting turns, and restarts from its own journal without the parent; host/integration coverage pins the route, permissions, and error statuses. Implemented-unverified (installed observation owed). | Fork is native; timeline fork still needs its NND-side adapter call, and `/revert`/`/unrevert` remain unimplemented natively. BTW linkage still blocked by the metadata contract (next row). | F4 (fork landed natively; revert/unrevert open) |
| `chat/btw-actions.ts` writes generic metadata; native session PATCH accepts only title or archived time. | Even after a fork implementation, BTW linkage fails unless its persistence contract is replaced. Pins and other metadata-dependent features need individual contract tracing. | F4, F8 |
| `lib/small-model/provider-ports.ts` reads `/config/providers` and defaults to OpenCode `auth.json`; `routes/small-model.ts` calls provider wires directly. Rechecked 2026-10-11: still current (module now at `packages/web/src/server/lib/small-model/provider-ports.ts`; consumed by `routes/small-model.ts` and `routes/git-walkthrough-generate.ts`). Step 1 landed 2026-10-11: NNA `20261011-7` ships the bounded native assist seam (`POST /v1/nnd/sessions/:id/assist`, `nnd.session.assist` grant, engine-owned router/scheduler, tools disabled, bounded prompt and output) — implemented-unverified. Step 2 landed 2026-10-11: the desktop inventory resolves NNA's public provider-profile roster (no `/config/providers` probe) and credential presence comes from the profile manifest or environment reference; the OpenCode `auth.json` default read is deleted, and secret-backed profiles resolve to no raw key (fail closed). Step 3 landed 2026-10-11: real `ses_*` session generation tries the native assist seam first (`source: 'nna-assist'`), with synthetic ids, oversized inputs, and harness refusals falling through to the legacy env-key wire. | Named NNA deliverable remaining: the installed assist journey observation, then deletion of the remaining legacy direct-wire parts once the seam is proven installed. | F5 (steps 1-3 done, installed run owed) |
| NNA rejects per-prompt model/agent overrides; NND multi-run accepts multiple models and separate worktrees. | Multi-run creates partial groups or cannot dispatch the promised comparison; fusion inherits unsupported routing assumptions. | F1, F5, F9 |
| ~~NOTE 18 explicitly records bounded in-memory SSE replay with snapshot recovery, without durable history or explicit gap signaling.~~ Rechecked 2026-10-11 against NNA `20261011-7`: stale on its headline objection. `replayAdmission` returns an explicit `fresh`/`complete`/`gap` status on the `server.connected` opener, rejects out-of-scope cursors and cross-process cursors as gaps, the retention ring stays a contiguous suffix (an oversized frame clears it rather than bridging), and dedicated tests pin every case. Durable backstops exist alongside the ring: durable session events mirror with the same id, a `.1` suffix, and a per-session monotonic seq; `activity-history` and `activity-tombstones` provide the authoritative paged history and deletion/revocation records. NND deliberately never trusts replay for correctness (authoritative reconnect reconciliation in the event pipeline), and the Activity rail already renders the incomplete-evidence state visibly (`activity-history-gap` status row: "An event stream gap occurred. Transient activity during that gap may be missing, even after recovery."), driven by `markActivityGap` on the explicit gap in the authority-recovery path. | Residual: the installed disconnect/restart/correction journey (04:70 acceptance) is the V-gate observation. | F2 (closed at transport and surface level) |
| Historical knowledge/skills notes retain OpenCode configuration roots and restart semantics. | Saving a skill/MCP configuration can appear successful while NNA never loads it. Read-only native inventories are useful, but do not satisfy management parity. | F8, C |
| `chat/work-status.ts:usageRows` returns only “No rate limits reported”; dictation has a shortcut/auth allowlist but no dedicated audio implementation was found in the source inventory. | Quota and voice affordances must not be counted complete from labels or an allowed WebSocket path. Required provider observations and voice journeys need implementation and end-to-end evidence. | F3, F5, F10 |

Existing native review-mode, question, projection, goal-audit, walkthrough, notification, and delegated-transcript work must be preserved and extended. Do not replace working native paths with generic compatibility endpoints merely to reduce code differences.

## Execution protocol for every F package

1. Read the named reference sections, current source, applicable ADRs, and repository instructions; trace one complete browser → NND → NNA → state/event → browser journey before editing.
2. List the native contracts used, owner of each persisted field, required permissions, request/revision identity, error semantics, and interruption behavior. If a native contract is missing, implement and test the NNA prerequisite before enabling its production UI.
3. Add an acceptance case that reproduces the identified failure against real NNA. Mock cases remain useful for deterministic edge cases but cannot close native parity.
4. Preserve existing data using versioned, bounded migration with rollback/read compatibility. A safe unavailable state is required during rollout and remains an open feature obligation.
5. Implement the smallest complete journey, including loading, denied, stale, cancelled, empty, partial, restart, and retry outcomes. Every side effect needs a defined duplicate/retry policy; do not blanket-retry unknown outcomes.
6. Run focused tests, required repository checks, native integration, and the relevant installed browser/desktop scenario. Request the user-required adversarial subagent review; apply confirmed repairs and repeat affected checks.
7. Record the scenario, exact versions, evidence artifact, remaining subcases, and any approved scope change. Then follow the execution plan's version, graph, immutable-release, and commit procedure. Never mark a W row complete from the existence of a component alone.

## F1 — Authorized projects, execution roots, and session identity

Depends on: L service identity/activation, C configuration scopes. Unlocks F3, F4, F6, F8, F9.

Targets: NND `packages/web/src/server/routes/projects.ts`, `routes/git-worktrees.ts`, `harness/nna-local.ts`, `packages/ui/src/sync/session-lifecycle.ts`, `lib/nnd/client.ts`, `components/worktrees/WorktreesView.tsx`; NNA `src/nnd-harness-routes.js`, `nnd-engine-host.js`, `nnd-session-description.js`, and authenticated integration-principal/session-catalog code.

1. Add a native project/workspace admission contract: NNA resolves and authorizes canonical Windows roots, returns opaque workspace identity plus safe display path, and persists the grant under the authenticated principal. A user-selected path is a request for admission, never a grant.
2. Bind session creation to that admitted workspace identity and immutable initial execution root. Return the authoritative directory before inserting a session into a directory store. Reject missing/expired scope with an actionable response; never substitute the host's default project silently.
3. Register created worktrees as distinct authorized roots before running setup commands or dispatching an agent. Define rebind/move semantics explicitly, with idle checks and revision guards; do not mutate a busy session's root.
4. Replace the single synthetic project view with an authorized native project inventory sufficient for multiple local projects. Keep NND folder/tab organization separate from NNA TUI tabs.
5. Bind file/git/terminal/preview/context actions to the same authorized workspace and principal. Persist the mapping across NND/NNA restarts and reconcile removals without orphaning recoverable work.

Acceptance: use two repositories with distinct sentinel files and one worktree; create a session in each, execute a governed read/write, and prove only the selected root changed. Test Windows case aliases, junction escapes, removed roots, permission loss, stale worktree IDs, and conflicting same-name projects. Restart both services, then repeat. Existing TUI sessions and tab order must remain unchanged.

## F2 — Authoritative state, durable observations, and complete recovery

Depends on: L identity and durable data paths. Can begin before F1; multi-project acceptance follows F1.

Targets: NND `sync/nna-projection.ts`, `sync/projection-reducer.ts`, `sync/event-equality.ts`, `sync/engine-recovery.ts`, `sync/session-actions.ts`, `sync/activity-log.ts`, `sync/activity-snapshot.ts`, `chat/operator-activity-surface.tsx`; NNA `src/nnd-projection.js`, `nnd-activity-snapshot.js`, `nnd-child-snapshot.js`, `nnd-session-registry.js`, and the native event-bus persistence/transport implementation located by tracing `subscribe`.

1. Define versioned cursor semantics: retained lower bound, current upper bound, instance/epoch identity, authorized history scope, and an explicit gap/reset response. Persist the required observation history or provide an authoritative paged history source; bounded memory replay alone cannot meet durable activity acceptance.
2. Keep projection epochs/revisions separate from transport cursors and wall-clock timestamps. Preserve the existing restart-epoch defenses. Pair snapshots with a cursor boundary so concurrent publication cannot leave an unseen interval.
3. Specify deletion, redaction, revocation, correction, and retention tombstones. Apply them to already cached timeline/activity rows, search results, child caches, and exports. Do not recreate purged content from an older snapshot or browser cache.
4. Implement gap recovery as visible resynchronization with snapshot/history replacement and capability refresh. An unexplained gap must not leave destructive controls enabled using old capability evidence.
5. Preserve bounded stores, visible-demand history loading, cancellation/generation guards, and optimistic echo reconciliation. Persist drafts/queue intent independently from authoritative execution state.
6. Render all NNA-authored phases, active-tool/context observations, usage measurement provenance, governance, blocker state, and safe error evidence. Do not invent private reasoning or assume missing metrics are zero.

Acceptance: disconnect during stream, exceed replay retention, restart NNA, reconnect with an old cursor, and prove no duplicated messages and an explicit gap/recovery outcome. Deliver a stale snapshot after a newer event; issue a correction/redaction while offline; revoke a child while its transcript is open; replay under a different workspace principal. Test deletion during bootstrap, archived history paging, malformed frames, large transcripts, and clock rollback. The Activity rail must state when retained evidence is incomplete.

## F3 — Complete composer and governed submission

Depends on: F1/F2 and C review/provider capability contracts.

Targets: NND `chat/` composer and attachment modules, `sync/session-actions.ts` and `chat/composer-attachments.ts` for send/attachment failure handling, `lib/nnd/client.ts`, `chat/review-mode-control.tsx`, server upload/file-grant and question routes; NNA `src/nnd-harness-routes.js`, question broker/routes, native ingress, and provider input conversion.

1. Specify a bounded native submission envelope for text, attachment references, selected context, command/skill invocation, and idempotency identity. Distinguish trusted product metadata from untrusted document/prompt content.
2. Implement secure attachment ingestion/reference authorization and supported file/image conversion. Preserve MIME, name, byte bounds, ownership, lifetime, and transcript identity. Reject unsupported parts before acknowledging submission; never silently discard them.
3. Wire drag/drop, paste, file picker, preview annotation, terminal selection, inline comments, snippets, draft starters, history, and autocomplete into the same native submission path. Show the exact context that will be sent.
4. Map queued send, active-turn steering, and abort to distinct NNA operations. NNA validates busy state and current authorization; NND preserves the draft on denial or unknown delivery. A cancelled request must not turn into a new turn after restart.
5. Keep permission choice server-authored: Default, Auto-review, and Unattended as currently advertised; mandatory reviewer and hard policy remain active. No NND auto-accept, “always approve” policy store, or invented Full control. If a user-decision mode is added, first provide an authenticated NNA decision contract with exact pending-request scope.
6. Preserve native question forms, multiple answers, validation, indefinite waiting, explicit response/decline/abort settlement, and cold-start recovery. Questions do not inherit permission-approval timeouts. Service interruption must report the native interrupted disposition rather than inventing a surviving broker promise. Separate questions from permission escalation; never answer either through a synthetic prompt that bypasses the broker.
7. Implement dictation/STT, transcript editing, and TTS/read-aloud where specified by the reference chat/settings inventory. Resolve audio providers and secrets through the C/F5 authority design; obtain browser/desktop microphone consent, bound streams, and release devices on stop. Speech transcription enters the editable composer and cannot silently submit or approve tools. Define whether the speech integration is NNA-owned or an explicitly registered NND companion capability before adding routes.

Acceptance: attach an image containing a unique marker plus a text file, then prove the native provider receives authorized content and the transcript survives restart. Test file-only input, unsupported MIME, deleted upload, over-limit bytes, cross-session attachment reuse, expired grants, mixed text/file failure, and annotation upload failure. Verify queue/steer/abort while blocked and duplicate submission after a lost acknowledgement. Reviewer denial must remain denied in browser and desktop. Test dictation/read-aloud success, microphone denial, disconnect mid-recording, cancellation, stale audio after a session switch, and no submit until the operator requests it.

## F4 — Session product, timeline, forks, and side conversations

Depends on: F1–F3; model-assisted affordances also depend on F5.

Targets: NND `lib/nnd/client.ts`, `sync/session-actions.ts`, `chat/btw-actions.ts`, `chat/btw-context.ts`, `chat/btw-panel.tsx`, session sidebar/header/timeline components located under `chat/`, transcript loader/reducers, and export/retention stores; NNA session host, catalog, transcript persistence, and new native lifecycle operations.

1. Inventory every visible session action and its current endpoint: create, rename, AI rename, archive/restore/delete, search, folders, pins, multi-select, tabs, export, fork, revert/unrevert, compaction, and deep links. Record behavior under native NNA, not just route presence.
2. Add native fork at a stable transcript boundary, preserving approved context and provenance while assigning a new NND session identity. The fork must not gain parent-only authority, copy pending approvals, or commandeer a TUI session.
3. Define revert semantics separately for conversation history and working-tree changes. Never claim a transcript rewind undoes external side effects. Implement safe native checkpoint/restore or explicit affected-file preview with conflict handling before enabling “revert work.” Preserve original history for recovery.
4. Replace generic `metadata.openchamber` writes with bounded NND-owned organization records or specific NNA-native mutations according to field ownership. Migrate pins, links, BTW correlations, and selection state without allowing metadata to grant engine authority.
5. Implement BTW as a native authorized side conversation/fork with explicit parent and boundary; select its route through NNA. Recover partial creation without deleting a child whose dispatch outcome is unknown. Keep parent execution isolated.
6. Verify rendering of every supported part, rich tool evidence, diffs, timestamps, paging, anchor links, pinned content, selection menus, usage/quota, recap/follow-up, errors, and empty states in both doors. Unsupported native evidence requires a contract addition, not a fabricated tool card.

Acceptance: fork an older turn after paging; compare context with the parent; reload both doors; rename and archive concurrently; restore from archive; export the full authorized transcript. Exercise revert with dirty user edits and irreversible prior tool effects, and prove the UI describes actual effects. Test BTW failure before/after submission, missing parent, removed capability, and duplicate clicks. Browser/desktop navigation must not alter TUI tabs.

## F5 — NNA-owned model helpers, route selection, and accounting

Depends on: C provider/settings contracts and F1/F2. Native helper endpoints already implemented are the starting point.

Targets: NND `server/lib/small-model/provider-ports.ts`, `provider-call.ts`, `routes/small-model.ts`, `routes/git-walkthrough-generate.ts`, `lib/walkthrough/model-readiness.ts`, `session-assist/nna-session-assist.ts`, `goals/nna-goal-auditor.ts`, AI naming/magic-prompt/notification callers; NNA `src/nnd-walkthrough.js`, `nnd-notification.js`, `nnd-goal-audit.js`, provider route/configuration and scheduler modules.

1. Enumerate all helper calls and required output: AI rename, assist recap/follow-up, goal audit/distillation, walkthrough, notification text, and any prompt improvement/summarization. Record which already use native endpoints and which still read legacy provider catalogs/auth stores.
2. Provide native model-only operations with purpose, allowed input, output schema, token/time limits, cancellation, audit/accounting, ownership, and route resolution. A model-only operation must reject tool calls; it cannot implicitly dispatch agent work.
3. Expose readiness from NNA without returning secrets: resolved profile/model, supported modalities/schema, limits, usable credential status, and actionable unavailable reason. Preserve provider-profile identity rather than assuming the profile ID is an OpenAI/Anthropic/Google wire name.
4. Replace production direct-provider credential reads/calls with native contracts. Keep any compatibility/mock path explicitly test-only. Use existing native walkthrough/notification/audit behavior; reconcile readiness with the route actually used for generation.
5. Add authorized per-session/per-run model and agent selection where parity requires it. NNA validates an advertised selection and records the effective route; no browser-provided endpoint, raw key, or arbitrary agent manifest.
6. Record helper usage alongside turn usage with truthful unavailable/estimated/provider measurement. Prevent automatic assist loops and retry storms when credentials expire or budgets exhaust.
7. Add native provider quota/rate-limit observations with provider/profile identity, units, reset time, and freshness; distinguish provider-reported limits from configured budgets and estimated usage. Verify the quota UI against multiple profiles without borrowing values from another session or converting unknown values to zero.

Acceptance: install NNA with a nonstandard provider profile ID and no OpenCode files; run each helper and verify the selected native route, bounds, and secret-free output. Test configured-route change during a call, credential expiry, invalid JSON, tool-call output, cancelled generation, provider timeout, stale diff input, output exhaustion, and no usable model. A safe failure is required but does not satisfy the success case.

## F6 — Files, review, plans, Git, and connected work visibility

Depends on: F1/F2/F3; walkthrough depends on F5; service file identity depends on L.

Targets: NND `components/files/FilesView.tsx`, `components/diff/DiffView.tsx`, `DiffViewer.tsx`, `components/git/GitView.tsx`, `components/plan/PlanView.tsx`, `components/worktrees/WorktreesView.tsx`, corresponding `lib/files`, `lib/git`, `lib/plan` and inline-comment stores, server `routes/git*`, filesystem routes, GitHub/Linear routes. Locate exact helper filenames rather than inventing replacements.

1. Verify existing local implementations against the installed service account and F1 workspace grants. Keep GUI file/git actions explicitly user initiated; tool-originated changes remain governed by NNA.
2. Complete file tree operations, search, editor positions, autosave/dirty guards, external edit conflicts, large/binary files, and image/PDF/HTML/Draw.io/Markdown/JSON/code previews. Outside-workspace access needs an explicit bounded grant.
3. Complete staged/working/branch/commit diffs, stacked/unified/side-by-side views, hunk actions/navigation, binary/image diffs, history/graph/stashes, commits, branches, conflict workflows, and worktree lifecycle. Protect uncommitted operator changes and serialize conflicting mutations.
4. Connect inline selection/comments, review handoff, plan improve/implement, and changes walkthrough to F3/F5 native contracts. Do not equate an AI “review complete” message with NNA permission approval.
5. Preserve PR/GitHub/Linear visibility and linked-session context. Local MVP excludes remote NNA hosts, not these user-facing integrations. Test via credential-free fixtures; record an optional account credential as an environment requirement, not an omitted implementation.
6. Invalidate visible and retained views after operations; preserve drafts when data refresh fails. Export/preview must apply redaction and grant expiry.

Acceptance: run the full edit → external-conflict → diff → stage → commit → history → worktree → review-comment → agent response journey in browser and desktop. Test locked Windows files, rename-case changes, symlinks/junctions, binary diffs, stale hunk offsets, concurrent Git operations, revoked grants, offline integration APIs, and a changed diff during walkthrough generation.

## F7 — Terminal, project actions, preview, and browser inspection

Depends on: F1/F3, L persistent service/Windows identity; F2 for observations; F5 for walkthrough.

Targets: NND `server/terminal/`, `server/preview/`, `components/terminal/TerminalView.tsx`, `TerminalKeepaliveOwner.tsx`, `lib/terminal/`, `lib/browser/`, desktop browser/IPC modules; NNA `src/nnd-browser-tool.js` and scoped operator/browser integration contracts.

1. Move PTY/session ownership to the persistent service lifecycle defined by L. Verify ConPTY and shell discovery under that Windows identity. Closing a tab detaches unless the user explicitly closes the terminal; closing Electron must not terminate work.
2. Preserve v3 attach/replay/sequence semantics, heartbeat/backpressure, resize, IME/paste/keyboard handling, bounded history, selection-to-context, and terminal theme behavior. Do not embed the NNA TUI as a replacement for engine integration.
3. Bind project actions to authorized roots with deliberate run/adopt/stop/force-kill behavior and exit evidence. Handle shell descendants on service shutdown without killing unrelated operator processes.
4. Complete local dev-server discovery and startup readiness, preview tabs/navigation/reload, and desktop native embedding. Use a browser-compatible local transport for shared preview content. Deliver required browser inspection/capture/annotation through an explicitly scoped service capability or another supported browser-only path; requiring Electron to be open does not close browser acceptance. Desktop-only window/guest utilities may remain explicit native affordances.
5. Finish native authorized browser projection/actions: scoped page identity, navigation/capture/annotation grants, operation receipts, expiry/revocation, and ownership. Brokered model tools and explicit user preview actions must have distinct authority paths.
6. Treat embedded pages as untrusted: no privileged IPC, secrets, arbitrary host-file access, or unrestricted callback authority. Route annotations/screenshots into the working F3 attachment path. Preserve console-problem and walkthrough visibility.

Acceptance: start a long terminal task, close Electron, attach from a browser, reopen Electron, and prove the same task continues with bounded replay. Test service restart behavior, ConPTY unavailable, full output buffers, dead shell, duplicate attach, stale resize, IME, and path spaces. Exercise preview against a hostile fixture, expired capture grant, detached page, screenshot failure, two competing clients, and denied navigation. Browser limitations cannot produce a false successful capture.
Run the required preview/inspection/capture/annotation journey with Electron never
launched and deliver the resulting attachment to native execution. Keep this gate
open until the browser-only implementation passes; a desktop handoff is not parity.

## F8 — Knowledge, memory, skills, MCP, and dependable context

Depends on: F1–F3 and C native settings/entity management. Shared settings details belong to C; context use belongs here.

Targets: NND `server/session-knowledge/`, `server/project-context/`, `server/agent-tool/`, `server/context/nna-context-obligatory-ports.ts`, skill/MCP routes and libraries, `chat/context-memory.tsx`, `chat/session-knowledge-summary.ts`, settings skills/MCP pages; NNA native skills/MCP inventories, memory tool, engine context/compaction, and forthcoming management APIs.

1. Produce a field ownership map for session knowledge, pinned transcript/context, user-authored project notes/plans/todos, engine memory, skills, and MCP configuration. Keep explicit notes distinct from agent memory; list scope and provenance in the GUI.
2. Retain NND-owned presentation/organization data, but use NNA-native operations for engine-affecting memory, skills, MCP, and context delivery. Do not write OpenCode directories and label the result applied to NNA.
3. Complete skills discovery, installed/catalog views, install/update/remove, supporting-file editing, project/user scope, visibility flags, and composer invocation. NNA reports effective loaded revision and any reload/restart requirement.
4. Complete MCP inventory/config/import/OAuth/connect/disconnect/status using native lifecycle contracts. OAuth credentials stay with the owning backend; a configured server and a connected usable tool are different states.
5. Implement bounded context assembly and restoration across compaction with stable content identities. Show which pinned notes/files were included, skipped, or truncated; validate grants again when resolving context. Do not duplicate reminders on every reconnect.
6. Preserve snippets/starters/magic prompts/todo links and project-context migration. Test migration atomically; retain original data on failed validation. Treat retrieved text as untrusted context, never a permission grant.

Acceptance: create a note/plan, pin a file, install a skill, configure an MCP server, and show actual native use in a session. Compact and restart; prove required context is restored once. Edit/forget memory and verify the next turn uses the new revision. Test duplicate names, removed files, broken symlinks, poisoned context text, scope mismatch, stale OAuth completion, conflicting saves, corrupt data, and a skill saved successfully but not yet loaded.

## F9 — Goals, schedules, queue, multi-run, and fusion

Depends on: F1–F5, F8, L persistent scheduler ownership, and C route/review settings.

Targets: NND `server/goals/`, `server/scheduled/`, `server/queue/`, `server/session-orchestration/`, `chat/session-goal-controls.tsx`, `chat/composer-queue.ts`, `chat/multirun-launcher.tsx`, `chat/multirun-fusion-dialog.tsx`, `lib/multirun/create.ts`, `fusion.ts`, `ui-services.ts`; NNA goal/review/ingress/provider contracts.

1. Preserve NNA-governed goals and progress-audit evidence. NND may persist user scheduling/queue intent and coordinate authorized native operations; it must not implement a competing permission engine or infer completion from text alone.
2. Make schedule occurrence claims, pending sends, and multi-run creation durable under the installed service. Define crash boundaries before/after native acceptance; reconcile by operation ID instead of resubmitting blindly.
3. Implement user stop as a durable guard against automatic continuation. Account for busy parents/children, blockers, audit failure, token/time limits, and context changes; native denial must propagate to the originating control.
4. Complete queue editing/reordering/hold/clear and steering distinctions. Capture attachments/context by safe reference with lifetime rules; stale intent must remain reviewable when a grant or project disappears.
5. Replace multi-run title-only identity with durable NND group/run records linked to native sessions/workspaces/routes. Complete up-to-five-model comparisons, partial failure recovery, per-run worktrees, adoption, and fusion through F1/F5.
6. Make fusion provenance explicit: selected authorized source revisions, omitted/failed runs, chosen target root/model, and resulting session. Renaming a session must not corrupt grouping. Do not automatically delete recoverable worktrees on an unknown outcome.

Acceptance: close both clients while a scheduled occurrence runs; restart the service around acceptance and prove at-most-one native submission for that occurrence. Test DST fold/gap, clock change, user stop racing a continuation, denial, partial group creation, one provider failure, deleted source run, group rename, stale fusion source, and recovery with uncommitted worktrees. Auto-review remains active throughout.

## F10 — Shared workspace presentation, attention, and surface parity

Depends on: F2–F9, C appearance/settings, L shared browser/desktop service.

Targets: NND app layout/router, `chat/operator-activity-surface.tsx`, `chat/child-session-controls.tsx`, context rail registry and panes, notification/attention UI, `server/notifications/` if present (locate actual module), web-push/native notification delivery, themes/i18n/shortcut registries, Mini Chat/embedded session surfaces.

1. Complete the Context/Activity/Changes/Notes/Browser/Terminal rail and keep-alive visibility rules; retain per-device layout separately from authoritative session state. Ensure every panel has accessible loading/empty/error/recovery states and return-to-chat navigation.
2. Preserve delegated-session nesting, demand-loaded transcripts, parent navigation, child tools/blockers/unread precedence, and read-only default. NNA alone authorizes steer/cancel/blocker actions with current child/parent correlation.
3. Reconcile capabilities on reconnect/revocation and make stale drafts non-sendable. A capability unavailable in the installed native version is an open parity dependency, not completion of steering.
4. Complete attention chips, notifications, click/deep-link routing, usage/quota, recap, and freshness indicators across browser, desktop, and Mini Chat. Keep deduplication and read state coherent without leaking private content into OS notifications.
5. Finish themes, shortcuts, language coverage, formatting, and accessibility from the settings guide. Browser and desktop must retain the same chat/visibility semantics even when native-only utilities differ.

Acceptance: open a session in browser plus desktop/Mini Chat, trigger a native question, tool denial, delegated task, completion, and notification. Prove identical authoritative state, correct action scope, bounded duplication, and safe focus/deep-link navigation. Revoke a child grant while its composer is open; remove its parent; update redacted evidence while a panel is hidden; reconnect after sleep. Test keyboard-only navigation, high DPI, reduced motion, and a narrow browser window.

## Complete W inventory disposition

This table maps every W-01–W-115 baseline item plus the native additions W-116/W-117. “MVP” means required implementation and acceptance, including every subfeature of that item unless this table explicitly narrows a platform/transport. C/L/V references delegate ownership, not completion. Historical auto-accept language is superseded wherever it occurs.

| ID | Work package | Required disposition |
|---|---|---|
| W-01 | L, F10 | MVP browser/PWA and Windows desktop shared UI; CLI service tooling L; VS Code/native mobile excluded. |
| W-02 | L, F10 | MVP cold boot, bounded retry, manual recovery, theme prepaint. |
| W-03 | L, F2, F10 | MVP PWA/update and disconnected recovery; offline UI never implies offline execution. |
| W-04 | L, F10 | MVP authenticated browser/desktop/Mini Chat access and expired-session recovery. |
| W-05 | F10, C | MVP complete shell, settings window, command palette, workspace regions. |
| W-06 | F10 | MVP rail registry, widths, ordering, visibility and keep-alive. |
| W-07 | F4, F10 | MVP session/surface/settings deep links and URL restoration. |
| W-08 | F2, L | MVP instance-generation reset/reconnect; remote host switching excluded. |
| W-09 | F1, F2, F8, C | MVP explicit authoritative/service/device state ownership. |
| W-10 | L, F10 | MVP Windows controls, splash, crash recovery and read coalescing. |
| W-11 | F4, F10, L | MVP desktop Mini Chat and embedded session chat; shared session authority. |
| W-12 | F2, F3, F4 | MVP native transcript/message/part schema and identity. |
| W-13 | F4, F10 | MVP complete chat composition, status column and session header. |
| W-14 | L, C | MVP local detection/setup/recovery wizard; remote setup excluded. |
| W-15 | F3, F8 | MVP full composer/editor/autocomplete/attachments/context/drafts/commands. |
| W-16 | F3, F9 | MVP native queue, steer and abort with distinct semantics. |
| W-17 | F2, F4, F6 | MVP complete authorized part/evidence rendering and history. |
| W-18 | F1, F4, F10 | MVP sidebar/projects/worktrees/folders/search/tabs and actions. |
| W-19 | F2, F5, F10 | MVP NNA-authored activity/status, recap, follow-up and errors. |
| W-20 | F3, C | MVP native questions/review modes; auto-accept/automatic approvals prohibited. |
| W-21 | F2, F5, C | MVP usage/quota/limits with native source and truthful missing-data state. |
| W-22 | F3, F8, F10 | MVP palette/history/snippets/prompts/starters. |
| W-23 | F4 | MVP timeline search/fork/revert and prompt navigation with native checkpoints. |
| W-24 | F4, F5, F10 | MVP AI rename, pins, notifications, bulk actions, archive and export. |
| W-25 | F4, F5 | MVP native BTW and recap/follow-up assistance. |
| W-26 | F3–F10 | MVP full surface-state catalog; author NNA-accurate copy. |
| W-27 | F2, F4 | MVP virtualization, history paging and stable message deep links. |
| W-28 | F2 | MVP global/directory state separation and bindings. |
| W-29 | F2 | MVP native event catalog, envelope validation and immutable receipt. |
| W-30 | F1, F2 | MVP bootstrap, enrichment, continuity and resume recovery. |
| W-31 | F2 | MVP live transport, ordering, watchdog and explicit gap recovery. |
| W-32 | F2, F3 | MVP optimistic echo/failure/question recovery; no auto-accept policy. |
| W-33 | F1, F4 | MVP full session lifecycle, retention and sidecars. |
| W-34 | F2, F4, F9 | MVP scoped drafts/history/folders/queue/worktree persistence. |
| W-35 | F2, F4 | MVP stream and native revert representation. |
| W-36 | F2, F10 | MVP bounded stores/tails and visible-demand fetching. |
| W-37 | F2, V | MVP mechanically enforced sync invariants. |
| W-38 | L | MVP persistent service boot/middleware/auth/static/API-only contract. |
| W-39 | F1–F10, C, L | MVP local feature route inventory; auto-accept removed, remote-only routes excluded. |
| W-40 | F1–F5, L | MVP native seam and lifecycle; legacy event names are compatibility only. |
| W-41 | F1–F9, C, V | MVP P-01–P-24 port audit translated to native contracts. |
| W-42 | L, F9 | MVP install/service/update/diagnostic and schedule tooling; tunnel commands excluded. |
| W-43 | L, C, F8, F9 | MVP data ownership, migrations and strict readers. |
| W-44 | L, C | MVP typed supported environment/configuration inventory. |
| W-45 | L, F1–F10 | MVP attached independent NNA has complete local features; legacy degraded external mode superseded. |
| W-46 | F6 | MVP full file tree/actions/tabs/grants. |
| W-47 | F6 | MVP editor/autosave/position/external-conflict/large-file behavior. |
| W-48 | F6 | MVP all listed preview types and persisted view modes. |
| W-49 | F6 | MVP complete diff modes/scopes/hunks/binary-image support. |
| W-50 | F6 | MVP Git operations/history/graph/stashes/PR visibility. |
| W-51 | F1, F6 | MVP authorized worktrees and branch-scoped review. |
| W-52 | F6, F8 | MVP plans/save queue/improve/implement/walkthrough navigation. |
| W-53 | F6 | MVP PR/GitHub/Linear surfaces; account setup may be optional, feature implementation is required. |
| W-54 | F3, F6 | MVP inline comments/context/review workflow; review never grants tool permission. |
| W-55 | F6, F10 | MVP cache invalidation and retained-pane visibility gating. |
| W-56 | F7 | MVP local terminal v3 protocol and command plane. |
| W-57 | F7, L | MVP Windows ConPTY lifecycle; POSIX platform branches excluded. |
| W-58 | F7, C | MVP equivalent terminal renderer/input/fonts/theme. |
| W-59 | F7 | MVP terminal transport/store/panel/detach versus close. |
| W-60 | F7 | MVP browser/desktop mirroring and reattach; remote-device access excluded. |
| W-61 | F7 | MVP project actions/trust/exit evidence/local preview opening. |
| W-62 | F7, V | MVP bounded terminal input/output and access isolation. |
| W-63 | F3, F7 | MVP terminal selection to context/comments. |
| W-64 | L, C | MVP local browser/session/device auth and passkeys where supported; public/tunnel access excluded. |
| W-65 | L | Remote private relay excluded from MVP; preserve existing code without counting it as local acceptance. |
| W-66 | L | Remote tunnel providers excluded from MVP. |
| W-67 | L | Remote pairing/QR excluded; local desktop-to-service authenticated setup remains required. |
| W-68 | L | SSH remote-machine access excluded from MVP. |
| W-69 | F7 | Local preview required; remote preview tunnel excluded. |
| W-70 | L | Public reverse-proxy deployment excluded; safe loopback origin/cookie rules required. |
| W-71 | L, F1–F10, V | MVP secret handling, revocation and failure isolation remain mandatory. |
| W-72 | L, F10 | MVP local installation/service/auth status; remote host fleet UX excluded. |
| W-73 | L | Replace Electron-owned in-process backend with persistent installed service attachment. |
| W-74 | L, F7, F10 | MVP bounded sender-gated IPC and least-privilege preload. |
| W-75 | L, F10 | MVP window geometry/tray/Mini Chat/navigation guards. |
| W-76 | L, F4 | MVP local session deep links; remote host/pairing links excluded. |
| W-77 | L | MVP packaged assets/protocol/SPA/runtime config. |
| W-78 | F7 | MVP isolated embedded browser/capture/storage controls. |
| W-79 | L | SSH manager excluded from MVP. |
| W-80 | L | MVP Windows NND updater and NNA compatibility checks; other platforms excluded. |
| W-81 | L, F10 | MVP Windows tray/menu/notifications/login/resume/native utilities; macOS dock excluded. |
| W-82 | F7, L, V | MVP adversarial IPC/guest/navigation/secret boundary tests. |
| W-83 | L, V | MVP supported Windows installer architecture matrix; other OS packages excluded. |
| W-84 | F6, L | MVP guarded native file utilities and Windows atomic replacement. |
| W-85 | F9 | MVP native goals, audit, limits and management UI. |
| W-86 | F9, C | MVP persistent schedules/timezones/run-as-goal; auto-accept toggle prohibited. |
| W-87 | F3, F9 | MVP queue intent/delivery/holds/edit/reorder/clear/context; VS Code auto-send excluded. |
| W-88 | F1, F5, F9 | MVP full multi-run, worktree isolation, comparison/adoption/fusion. |
| W-89 | F4, F9 | MVP managed-session orchestration through native operations. |
| W-90 | F9, V | MVP stop/recovery/isolation/idempotency invariants. |
| W-91 | F7 | MVP Windows local dev-server discovery/probe; POSIX scanners excluded. |
| W-92 | F7 | MVP local browser/desktop preview/tabs/readiness/reconnect; tunnel mapping excluded. |
| W-93 | F3, F7 | MVP governed inspection/capture/annotation/console callbacks. |
| W-94 | F5, F6, F7 | MVP native walkthrough generation, readiness, cache and complete UI. |
| W-95 | L, F7 | Remote dev tunnels excluded; local preview delivery still required. |
| W-96 | F10, C | MVP celebration affordance honoring reduced motion/settings. |
| W-97 | F7, V | MVP preview/capture scope and untrusted-page isolation. |
| W-98 | C, F10 | MVP tokens/fonts/type/motion and coherent workspace presentation. |
| W-99 | C, F10 | MVP complete accessible primitive inventory. |
| W-100 | C, F10 | MVP app/file icon system. |
| W-101 | C, F10 | MVP built-ins/custom themes and browser/desktop/embedded propagation. |
| W-102 | C | MVP NND registry plus all configurable NNA settings; historical ~160-key count is not the completeness test. |
| W-103 | C, F10 | MVP twelve-locale key coverage/fallback and language selection; record authored translation verification. |
| W-104 | C, F10 | MVP shortcut inventory/conflicts/recorder/context ownership. |
| W-105 | C, F10 | MVP consistent time/money/measurement formatting. |
| W-106 | F3, F8 | MVP knowledge assembly/delivery/reading surfaces. |
| W-107 | F8 | MVP native-integrated agent memory, scope, edit/forget and provenance. |
| W-108 | F8 | MVP project context/notes/plans/todos and migrations. |
| W-109 | F8, C | MVP native skills discovery/CRUD/catalog/install/update/invocation. |
| W-110 | F8, C | MVP native MCP management/runtime/OAuth/import/status. |
| W-111 | F3, F8 | MVP pinned/obligatory context/compaction/grants with native authority. |
| W-112 | F3, F8 | MVP snippets/starters/prompts/todos/linked issues and review context. |
| W-113 | F3, F8, V | MVP explicit verified native model-input delivery matrix. |
| W-114 | F1–F10, L, V | MVP local module invariants/notifications/TTS-STT/small-model features; no auto-accept persistence; APNs excluded. |
| W-115 | F10, L | MVP attention/status/native and browser notification delivery; mobile push excluded. |
| W-116 | F2, F6–F8, F10 | MVP full NNA observability rail, durable evidence, corrections/redaction and sourced notes. |
| W-117 | F2, F3, F10 | MVP delegated transcripts and currently authorized actions; native steering dependencies remain required. |

## Evidence handoff

Create one machine-checkable acceptance record per W item, with subcases for every explicitly listed capability: scope, native endpoint/owner, success test, failure/recovery test, Windows installed scenario, source revision, and evidence path. A range-level test may support several records, but each record must identify its exercised assertions. Carry unsupported native operations as blocked F tasks with named NNA deliverables; never convert them into completed “capability gating.”

The release gate must reject missing IDs, missing required subcases, mock-only evidence, stale evidence after a changed contract, and any unapproved MVP exclusion. Aggregate suite counts are useful regression evidence, but cannot replace installed end-to-end proof. Remote/platform exclusions above must remain labeled exclusions rather than passed features. F1–F10 complete only when their native dependencies and all required local W subcases pass V.
