# NND GUI north-star scan

Date: 2026-09-24
Scope: targeted visual-product audit of the read-only OpenChamber checkout and
comparison with the NND GUI plan. This is an independently expressed product map.
It does not authorize copying upstream code, assets, dependencies, styling, or text.

## Outcome

NND should feel like one coherent operator workspace for NNA, not a collection of
agent chat, file, and settings pages. The desired experience is a live session in the
center, durable navigation and project awareness on the left, NNA context and
governance evidence on the right, and workspace tools available without leaving the
session.

NNA remains authoritative. NND presents engine projections and sends authenticated
requests; it never decides a turn state, permission outcome, lifecycle action, or
network-exposure policy from the GUI.

## Live OpenChamber comparison (2026-09-27)

The running upstream UI confirmed the intended visual hierarchy beyond the source
audit: a slim left project/session navigator, a restrained central transcript and
bottom composer, and a persistent icon dock on the far right. Selecting Context,
Git, Files, or Project knowledge opens a titled secondary workspace beside chat;
the panel can occupy a substantial portion of a wide display, and close/expand
controls do not eject the active conversation. Project knowledge groups Notes,
Todo, and Plans within that workspace, with search and section counts. Tool calls
read as compact timeline rows rather than full-sized message cards.

A follow-up live comparison of a new workspace showed a distinct first-use state:
the workspace name and prompt composer form one centered starting point, and
suggested prompts sit below the composer. NND should use that composition only
while no session is selected. Once a session opens, the transcript regains the
canvas and the composer returns to its stable bottom position, preserving the
same editor and unsent draft through the transition.

The upstream header also keeps the active workspace and Git branch visible while
switching between a conversation and supporting panes. NND should show the
selected NNA directory identity and only a branch actually projected for that
directory, not a branch inferred from the UI process's own repository.

NND should borrow these spatial and interaction principles, not upstream code,
assets, text, or styling. At a normal desktop window width the icon dock must remain
discoverable even when the panel is closed. The composer and transcript should share
a readable maximum width and muted, warm hierarchy. A failed or unfocused desktop
renderer must never leave a visible but inert window; reopening it must recover the
page and return keyboard focus to the embedded UI.

## The seven visible surfaces

| Surface | What the operator should experience | NNA authority needed | NND status / next emphasis |
|---|---|---|---|
| 1. Workspace shell | One stable window: project/session navigation, active session, context rail, and workspace tools. The web app and Electron shell show the same product. | Activated NND web-service, selected engine context, shell lifecycle state. | Shell, tabs, and tool views exist. Make the information architecture intentional before adding more controls. |
| 2. Session navigator | Fast project/worktree/chat navigation; hierarchy, folders, pin/archive/restore, search, timeline, activity, blocker, unread signals, and delegated child sessions. A user can understand where work is happening at a glance. | Cross-context session index, replayable projection status, blocker summaries, worktree metadata, session ownership, and parent/child delegation links. | Sidebar/session fundamentals exist. Prioritize reliable activity precedence, folders/pins, timeline, project/worktree identity, and child-session visibility. |
| 3. Conversation surface | A capable coding conversation: streamed response, tool evidence, readable diffs, blockers and forms, queue/steer, fork/revert, attachments/mentions, command and skill discovery, and clear recovery. | Prompt/steer/cancel/fork/revert, message parts, permission/question receipts, capability catalog, and projection replay. | Core chat, cards, blockers, queue, prompt rail, and timeline are present. Improve depth and evidence rather than adding a second state model. |
| 4. NNA context rail | A compact, always-relevant explanation of the active session: current projection state, governance mode, pending approvals/questions, active model/agent/tools, context use, goal, subagents, tasks, and accounting. | Authored projection frames, governance mode and constraints, resolved parameters, tool/subagent/task summaries, context and usage accounting. | Work-status panel exists but is partial. This is the highest-value native NNA differentiator. |
| 5. Workspace review band | Files, diff, Git, plan, comments, worktrees, terminal, and preview are available as deliberate work modes. Agent changes refresh these surfaces without manual guessing. | Workspace grant and file/Git read models; governed mutations; terminal lifecycle; worktree ownership; agent change notices. | The basic views exist. Add file preview/upload, diff navigation/tree mode, comment lifecycle, and reliable invalidation after agent work. |
| 6. Configuration and capability center | Settings make NNA understandable and configurable: providers/models, agents, tools, MCP, skills, plugins, projects, behavior/governance limits, notifications, network exposure, and diagnostics. Status explains what is loaded, allowed, unavailable, or needs restart. | Versioned config schemas, capability/status projections, plugin and MCP attestation, secret-safe mutation APIs, exposure policy and lifecycle responses. | Theme/settings foundation exists; P10 and PA must supply the NNA-owned truth before broad configuration UI lands. |
| 7. Desktop and remote doors | Desktop feels native—tray, notifications, reconnect/recovery, deep links, and local-first startup—while the browser remains first-class. LAN/remote access is visibly deliberate and authenticated. | NNA service state, activated surface endpoint, auth/pairing, explicit exposure state, connection identity. | Packaging/tray foundations exist. Keep Electron a thin renderer and make listener exposure an NNA-controlled consent flow. |

## Right-side workspace rail

The right side is not a collection of mutually exclusive full-screen pages. It is a
dockable workspace that lets the operator watch the session while opening supporting
evidence beside it. A narrow vertical rail selects a surface; the selected surface
opens as a resizable panel with a title, tabs where a surface has more than one open
item, expand, and close controls. The active chat remains visible until the operator
deliberately expands a panel.

Surface order and visibility are device-local preferences. Width is restored per NNA
engine-context identity and surface (never merely by a directory path). File editor, diff, browser, terminal, and activity panes
retain their scroll, tabs, and selection while hidden, but pause avoidable polling or
rendering work. Singleton panes (Context and Notes) restore from NNA snapshots when
reopened. A rail icon never promises an unavailable capability: unavailable features
are hidden or explain their prerequisite.

The side-by-side promise applies only when the viewport can preserve a usable chat and
panel. Below that threshold, NND enters an explicit compact mode: the operator chooses
which surface is foregrounded and gets a persistent return-to-chat affordance. It must
not silently collapse the chat, submit focus to a hidden composer, or treat a compact
viewport as an operator request to expand a panel.

| Rail surface | Operator experience | Authority and safety boundary |
|---|---|---|
| Context | A calm summary of the active session: authored turn state, governance mode, selected model/agent/tools, context use, task/goal/subagent state, and audited cost/usage. | NNA supplies projections and accounting. NND does not derive state or manufacture a zero/complete value when data is unavailable. |
| Activity | A chronological session log that unfolds live. Compact rows show timestamp, category, state, and short description; expansion reveals the associated receipt, tool input/output summary, changed paths, error, or link to the relevant chat/diff/terminal item. Filters include engine state, tool work, governance/blockers, subagents, workspace changes, and diagnostics. | The feed is replayable NNA event/evidence data keyed by session and correlation id. NND appends new frames but also applies NNA-authored redaction, revocation, and correction/tombstone frames to already rendered evidence. NNA decides what reasoning, diagnostic, secret, and tool content is safe to project. Private chain-of-thought, credentials, and raw sensitive provider payloads are never a default GUI log. |
| Changes | A session-aware change explorer: last-turn changes, current working-tree changes, staged changes, and per-file diff navigation. It can open a file or review hunk without losing the chat. | NNA/workspace grants and evidence identify changed paths. All write actions remain governed NNA requests with receipts. |
| Notes | Project-owned General Notes, Todos, and Plans in one surface. Notes are editable durable operator context; Todos are ordered work items that can be sent to a selected/new session; Plans open in place. Agent memory is visually separate from user-authored notes and carries its source/scope. | User notes/plans/todos are surface/project data. NNA owns agent memory, its delivery to a session, and any memory tool. NND must never imply that editing a note changes an already-running turn unless NNA confirms it. |
| Browser | A bounded preview/inspection browser: address and tab controls, agent-created pages, capture/annotation into the conversation, and an explicit user take-over/return control where NNA supports it. | Browser pages are untrusted guests. Capture, navigation, and inspection require NNA-approved scope and never receive shell, filesystem, secret, or privileged IPC authority. |
| Terminal | A persistent terminal tab scoped to the selected engine context/workspace, with reconnectable output, visible command lifecycle, selection-to-chat, and clear ownership when an agent or user is active. | NNA owns terminal creation, scope, process lifecycle, and cancellation. NND renders the transport and never treats terminal text as permission to perform an action. |

### Delegated-session transcripts

Subagents are first-class child sessions, not a count in the parent work-status card.
The session navigator renders their relationship beneath the initiating session (and
in a filtered cross-project timeline when appropriate), with the same live precedence
used by root sessions: pending authority request, pending question, active work,
failure, unread result, then idle. A child row shows its NNA-projected title, agent,
short current activity, and parent relationship; NND never invents a title or marks a
child complete from an absent event.

Selecting a child opens its transcript in a read-only child-session view by default,
either in the main chat column or a docked chat tab. The parent remains identifiable
and a one-action return to it is always available. The child transcript receives the
same replayable activity feed, message/tool cards, blockers, and evidence links as a
root transcript, so an operator can watch delegated work unfold in real time. Whether
a principal may prompt, steer, cancel, or answer a child blocker is a distinct NNA
authorization decision. The UI begins read-only. A compact **Steer subagent** toggle
in the transcript header is hidden until NNA projects steering capability; activating
it deliberately reveals the steering composer and a clear target/authority notice.
Turning it off returns the transcript to observation mode without discarding an
unsent draft. NNA receives the same authenticated, correlated steering request as any
other session command and returns the authoritative receipt; the toggle never grants
authority or implies that a parent can control its child.

NNA must expose child identity, parent session identity, delegated agent identity,
ownership/entitlement, projection status, and transcript cursor as structured fields.
Transcript discovery is demand-driven: sidebar summaries and live status are enough to
render a row; message and tool history loads only when the child is selected or
explicitly opened. Entitlement changes, redaction, deletion, or unavailable replay are
shown honestly and never replaced by the parent's text.

If a child remains discoverable while its parent is unavailable (for example after
retention, deletion, or an entitlement change), NND lists it in an explicit
"parent unavailable" group with a non-navigable parent reference. It must not hide the
child, attach it to a different session, or render a return action that can open an
unrelated transcript.

### Activity log rules

- The default view follows the live tail until the user scrolls away; a clear new-events
  affordance returns to live without moving a reader unexpectedly.
- Every row links back to its evidence: chat part, approval/question, changed-file diff,
  subagent, browser capture, or terminal instance. Logs are navigation, not duplicate
  transcripts.
- A compact row is readable in a fast stream; large output is deferred behind expansion
  and bounded previews. Export/copy is redaction-aware.
- Reconnect uses the NNA frame cursor and can state that a range is unavailable or
  compacted. It applies a later NNA redaction/revocation/correction to any cached
  evidence and never fills a gap with guessed history.
- The visual hierarchy is explicit: attention-required and failed events are prominent;
  normal progress is quiet; diagnostic verbosity is opt-in and capability-gated.

### Notes, plans, and todos rules

- General Notes, Todos, and Plans are separate user-authored record types under the
  active project owner. Search spans all three and shows result counts by section.
- A plan opens in the rail rather than ejecting the operator into a disconnected page.
  Its owner is explicit, so worktree and general-chat paths cannot silently address the
  wrong project.
- Pinning a note or plan to a session is an explicit NNA-facing context action with a
  receipt. It is not an automatic project-wide prompt injection.
- Agent memory remains a separate, source-labelled section with project/global scope.
  The operator can inspect and correct it only through NNA-authorized APIs.

## What makes the target feel complete

The target is not visual mimicry. It is the following operator loop:

1. Open NND and immediately land in the last meaningful session, with the active
   project and worktree visible.
2. See what NNA is doing, why it is waiting, and what needs human authority without
   opening a debugger or terminal.
3. Give a prompt, steer, approve, reject, cancel, or fork with an accurate engine
   receipt; streamed work and tool evidence explain the result as it happens.
4. Move directly from the conversation to the changed file, diff, terminal, plan, or
   worktree and back without losing session context.
5. Configure NNA capabilities through a safe, explained GUI while NNA remains the
   validator and secret holder.
6. Close the window and return later without losing the session, state, or evidence.

## Inspiration findings to retain

The upstream scan highlights these interaction patterns as valuable inspiration for
NND's independently designed UI:

- A virtualized session sidebar that can switch between project hierarchy and a
  cross-project timeline, while showing a clear priority order for attention,
  questions, active work, and unread activity.
- A conversation column that treats tool activity, permissions, forms, quoted
  comments, queued work, and forks as first-class work artifacts rather than text
  decorations.
- A context rail that turns model, context, cost, subagents, goals, tasks, pinned
  knowledge, and extension-provided status into a quick operational explanation.
- A review band that pairs source browsing with diffs, Git operations, worktrees,
  plans, inline comments, terminal, previews, and generated-artifact inspection.
- A capability center that groups agents, providers, MCP, skills, plugins, projects,
  commands, snippets, usage, connectivity, and settings into discoverable management
  surfaces.
- Honest failure/recovery faces: a startup or connection failure must say what failed
  and offer the safe next action, rather than presenting an empty workspace.

## NNA-first decisions before UI expansion

Do not add a polished NND control until its engine source is clear. The next joint
contract slice should expose these NNA projections or commands:

1. A session-index and activity projection for the navigator, with hierarchy,
   ownership, worktree, archived/pinned state, and precedence-ranked blockers.
2. A session projection for the context rail: authored turn state, governance mode,
   resolved model/agent/tools, active subagents/tasks, context accounting, goal state,
   and durable usage/cost evidence.
3. Governed actions for prompt, steer, approval/question response, cancel, fork,
   revert, and session lifecycle, each returning a receipt that NND can reconcile.
4. A workspace projection for changed paths, file/Git refresh hints, worktrees,
   terminal ownership, and bounded preview/inspection grants.
5. A safe configuration/capability surface for plugins, skills, MCP, providers,
   agents, secrets references, reload requirements, and service/exposure state.
6. Delegated-session summaries and transcript capability: parent/child identity,
   agent identity, replay cursor, live state, evidence links, and per-action
   authorization so NND can show child transcripts without borrowing authority,
   including an explicit steer capability for the opt-in transcript control.

## Priority order

### Now: make the existing core feel deliberate

- Finish the session navigator and active-session context rail.
- Build the dockable right-side host and its Context, Activity, Changes, Notes,
  Browser, and Terminal surface registry before scattering more header toggles.
- Deepen chat evidence and blocker/queue/fork flows.
- Finish review-band continuity: agent change → file/diff/Git/terminal refresh.
- Replace the mock seam only after the NNA projection and governance contract is ready.

### Next: make NNA's advantages visible

- Governance explanation and authority-aware approval surfaces.
- Goals, scheduled work, subagents, and auditable accounting in the rail and sidebar.
- Capability/configuration management backed by NNA, especially skills, MCP, plugins,
  agents, and provider status.

### Later: high-value polish after the data contracts exist

- Usage history, richer file previews/uploads, diff file-tree navigation, persistent
  quoted-comment editing, and an explicit `/fork <prompt>` flow.
- Browser-provider take-over, walkthroughs, Mini Chat, and the remaining desktop
  conveniences.

## Source boundaries

This scan reviewed the local OpenChamber GUI directory layout and its maintained
component documentation, plus the 2.0.0/2.0.1 product changelog. It used the source
layout only to identify visible product areas. NND implementation must remain
dependency-minimal and independently authored. Existing detailed acceptance IDs remain
in `docs/build/GUI-PLAN/SECTION-1-feature-inventory.md`; this note sets product shape,
not a second implementation checklist.
