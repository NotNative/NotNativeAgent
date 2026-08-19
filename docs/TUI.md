# NNA Console operator guide

`/model qualify` runs bounded text and native-tool compatibility probes for the active
provider/model and opens a temporary result view. It executes no synthetic tool and does
not change provider routing.

Start the installed interactive surface with `nna`. It resolves the saved user manifest
or performs first-run provider setup. `nna tui --config manifest.json` remains the
explicit configuration form. The interface requires a TTY;
redirected workflows should use `host` or prompt mode. The interface uses a
single-column, state-first Console layout. Essential meaning never depends
on color.

With color enabled, the Console uses a restrained NNA palette: the startup wordmark
descends diagonally through a cyan, lavender, pink, magenta, and purple synthwave gradient; the active tab
and agent marker carry the purple accent, operator prompts occupy a subtle full-width band,
successful tool work uses green, and secondary controls remain dim. Plain mode retains
`›`, `●`, `✦`, and explicit text so no state depends on color. Completed turns have
breathing room and a human duration label; engine-only transitions stay out of the
transcript.

The persistent header shows the canonical NNA version and attached conversations. The
bottom status line shows the review posture, semantic state, provider/model route, latest
token usage, and transcript follow state. The transcript distinguishes operator text,
model text, tools, review, dependencies, errors, and terminal outcomes with text and
symbols. Expanded tool activity includes the declared effect and scope, bounded redacted
arguments, reviewer result, terminal status, duration, and effect certainty; mutation
content is represented by byte count and digest rather than displayed. Typing `/` exposes matching commands; `/help` opens the registry-backed command
catalog without changing conversation state. Every command row identifies its required
capability, effective direct binding when one exists, and an actionable reason when the
command is unavailable in the active conversation.
Terminal receipts distinguish completed, needs-input, cancelled, failed, and limit outcomes.
Completed and needs-input outcomes share the same quiet receipt shape instead of repeating
state labels already visible in the footer. Failures show their stable code plus either an
explicit history-resubmit action or `/health` inspection guidance.

Assistant Markdown is rendered into terminal-safe structure: paragraphs and blank lines
remain distinct, headings and emphasis become plain styled text, lists retain bullets,
links expose their destination, and fenced code remains a separate indented block. Width
calculation accounts for combining marks and wide Unicode characters instead of slicing
UTF-16 code units. Control sequences are still neutralized before formatting.

Key actions:

- `Enter`: submit the editor. `Ctrl+S` remains a compatibility shortcut.
- `Ctrl+J`: insert a newline. Pasted newlines never submit.
- `Shift+Enter` or `Alt+Enter`: insert a newline when the terminal emits a distinct
  modified-Enter sequence. NNA negotiates enhanced keyboard reporting with modern Windows
  Terminal sessions. Legacy Windows Console Host collapses the chord to ordinary Enter
  before NNA can inspect it; `Ctrl+J` remains reliable there. Backslash immediately followed
  by Enter is retained as a compatibility fallback.
- `Ctrl+C`: press twice within one second to cancel a pending permission or active turn;
  when idle, press twice within one second to exit NNA and restore the terminal. The latch
  resets after the confirmed action, so exiting after a cancellation requires a new pair.
- `Esc`: in the ordinary editor, press twice within one second to clear a non-empty draft.
  With an empty editor during active work, press twice within one second to cancel the turn.
  This makes four deliberate presses clear a draft and then cancel its active turn. A single
  `Esc` still navigates back from a menu or help view, and empty idle input remains unchanged.
- `Ctrl+Y`: allow the currently displayed immutable request once.
- `Ctrl+N`: deny the currently displayed request.
- While an approval is displayed, `2` preauthorizes the same tool and redacted target for
  this conversation; `3` preauthorizes that tool for targets within this conversation's
  workspace; `4` denies. Mandatory review still evaluates every matching request, and
  authority, policy, tool-definition, effect, workspace, or expiry drift invalidates a match.
  Operation-scoped grants bind every canonical source and destination; process grants also
  bind the executable and complete argv, so a different command cannot reuse an earlier grant.
  Keyboard and mouse tab/new-session actions remain inert until the permission is resolved;
  F12 remains available as the fixed emergency binding reset.
- `Ctrl+G`: toggle help.
- `Esc`: return from the current menu, selector, help page, or temporary view.
- `Ctrl+T`: create and select a standard conversation.
- Left-click a tab to select it, or click `[+]` to create a conversation. Hold Shift
  when dragging if the terminal requires it for native text selection while mouse reporting is active.
- Right-click a tab to open its conversation menu. Rename is available for every tab; Close
  is available for standard conversations because Main remains attached until NNA exits.
  Menu rows can be clicked directly or selected with Up/Down and Enter.
- `Ctrl+W`: close the selected standard conversation. The primary remains attached until exit.
- `Alt+1` through `Alt+8`: select an attached conversation directly.
- `Ctrl+PageUp` / `Ctrl+PageDown`: select the previous or next conversation. Common
  `Ctrl+Shift+Tab` / `Ctrl+Tab` terminal encodings are also recognized.
- `PageUp` / `PageDown`: detach and navigate the transcript; reaching the top pages older
  durable journal records into a bounded 4,096-event Console window without moving the
  visible reading position. `End` returns to sticky follow.
- The mouse wheel navigates the same transcript viewport. NNA stays in the terminal's normal
  screen buffer by default, so it does not replace the host's configured scrollback with a
  viewport-sized alternate buffer.
- `Ctrl+O`: show or collapse the full detail for the latest completed activity group.
- Left-click a completed turn receipt to toggle its compact activity summary. Full detail
  remains a keyboard-controlled view so click-drag selection can copy arguments and results
  without collapsing the activity.
- `Shift+Tab`: cycle Prompt, Auto-review, and Unattended review postures when the
  terminal reports the chord distinctly. Review, hard policy, and the ledger remain mandatory.
- Typing `/` opens the complete command catalog. Additional text filters the list; Up/Down
  selects a match and Tab completes its literal command prefix.
- Arrow keys move the cursor or navigate history when command completion is not active.
- Up/Down inside multiline input move between lines. Shift+Left/Right select text where
  the terminal emits standard sequences; Shift+Up/Down extends multiline selection.
  Ctrl+Left/Right moves by word and Ctrl+Shift+Left/Right extends selection by word.
  Home, End, Delete, and bounded `Ctrl+Z` undo are supported.
- High-level Console actions are configured by action name in `tui.key_bindings`; unsupported
  actions and conflicting physical keys fail manifest validation. F12 always restores the
  documented defaults, persists the reset, and remains effective inside overlays and
  permission views without requiring a configuration-file edit.

Commands include `/new NAME`, `/switch ID-OR-NAME`, `/sessions`, `/resume [SESSION_ID]`, `/rename NAME`, `/close`,
`/confirm close`, `/health`, `/hooks`, `/extensions`, `/stats` (or `/status`), `/files`, `/project`, `/audit`, `/permissions`, `/copy [N]`, `/provider [ID]`, `/model [NAME]`, `/mcp`, `/memory`, `/dream`, `/config`, `/websearch`, `/workspace PATH`, `/context`, `/support`,
`/plan`, `/tasks`, `/goal`, `/task`, `/support preview`, `/steer MESSAGE`, and `/quit`. `/support` creates a local redacted ZIP that can be sent
to maintainers for troubleshooting; it never uploads the archive and refuses to overwrite an existing path. Its manifest lists the included attached conversations, and each conversation has an isolated `sessions/<session-id>/` folder containing its redacted diagnostics, repair statistics, and forensic trace. Closing active work requires the explicit confirmation
command. Conversation editors and transcript projections remain isolated when switching.
The archive includes a content-free idle-maintenance summary (scheduler state, stage,
bounded result codes, and run counts) so cancelled or failing dream cycles can be diagnosed
without including prompts, memory content, or candidate text.
If the saved tab pool or an individual conversation cannot be validated, unlocked, or
recovered, the Console still opens a fresh Main conversation and reports each named
failure as a recovery notice. NNA leaves the saved pool and session journals untouched
and pauses tab-pool persistence for that run so troubleshooting evidence cannot be
silently replaced; resolve the reported condition and restart NNA to retry recovery.
`/resume` opens a picker for unattached standalone durable conversations, or accepts a session
ID directly. It restores the saved transcript in a new tab using the current Console provider
and workspace configuration. Authenticated hosted and mission sessions are intentionally excluded;
their originating host must resume them with the original execution authority.

`/plan` opens the optional durable work hub for the active conversation; `/tasks` is an
alias for the same view. One goal may own up to 64 ordered tasks, with at most one task
in progress. Use `/goal TEXT`, `/goal complete EVIDENCE`, or `/goal reopen`, and use
`/task add TEXT`, `/task start ID`, `/task pending ID`, `/task complete ID EVIDENCE`, or
`/task block ID REASON`. The menu provides the same operations without requiring command
memorization. Completion requires evidence and blocking requires a reason. Work state is
stored in the conversation journal, restored by `/resume`, preserved independently of
context compaction, and summarized as `plan completed/total` in the footer. No planning
state is created for an ordinary conversation unless the operator or agent chooses to do so.

`/dream` shows local idle-maintenance state and its bounded recent stage receipts.
`/dream pause` and `/dream resume` control scheduling for the current process; `/dream run`
requests the next eligible deterministic stage immediately. Any keyboard or mouse input
cancels an active stage and restarts the idle clock. Implemented stages harvest classified
telemetry, diagnose failures, create project-memory proposals, reconcile NNM receipts,
and request read-only NNM hygiene. Explicit skill requests may appear as proposal-only
opportunities. None of these stages builds or activates a skill, broadens authority, or
silently applies a project-memory change.
`/project` shows deterministic, read-only intake for the active workspace: repository
kind, recognized manifests and guidance, source/test directories, likely entry points,
and bounded package metadata. The same intake is added to model context only when the
operator explicitly refers to the project, repository, codebase, or workspace. It does
not read source contents or imply an assignment merely because a workspace exists.
On every cold launch the fresh Main conversation receives focus. A meaningful prior Main
is restored as `Previous Main` only until it has a usable topic, and other eligible tabs
retain their presentation state,
but restored tabs do not take startup focus away from Main.
The Experience Engine derives a terse 1–3 word local topic after the first informative turn
using at most the first two user messages. This does not make another provider request.
Generated names persist with the tab pool. A user rename—or an explicit name supplied to
`/new`—sets a durable lock, so later turns and restores cannot replace that name.
Multiple Console processes may run concurrently. The first owns the workspace authority
lease and displays its replaceable tab name as `[* Main *]`; later Consoles receive an
independent, non-authoritative Main. Sessions already open elsewhere are skipped without a
recovery alarm. Its `/provider` view retains conversation-local profile selection but shows
an amber authority notice instead of silently omitting global profile-management actions.
Each Console merges its meaningful Main and tabs into the shared pool on
exit, so they become separately restorable after their writer locks are released.
If a tab-pool write fails after a successful restore, the Console reports a persistence
notice without changing the agent turn state. The write queue remains usable and retries
the current presentation snapshot on the next tab mutation or shutdown. Exit still closes
every engine and restores the terminal even when the final presentation save fails.
This applies equally to completed tab, route, provider, configuration, and MCP menu actions:
the successful live action remains successful while the notice truthfully identifies only
the unsaved presentation snapshot.

Completed and needs-input receipts show elapsed time and that turn's token accounting, plus
compact tool/review counts and a `Ctrl+O` details hint when activity exists. Every dispatched
provider attempt receives a durable content-free receipt, so failed retries and route
fallbacks remain part of the accounting. The footer rolls authoritative provider usage into
a conversation total. Providers that support OpenAI-compatible streaming usage are asked to
include it. Usage omitted by a provider is shown separately with `~`; a mixed total such as
`1200+~340 tokens` means 1,200 provider-reported tokens plus approximately 340 unreported
tokens. `tokens --` means no provider attempt has supplied or incurred countable evidence.
The context footer uses
the loaded model's usable input window when available. A `~` marks the conservative prompt
token estimate; values below one percent display as `context ~<1%` instead of rounding to
zero. `/context` shows that estimate, output reservation, the configurable compression and
full-compaction boundaries, provider discovery source, loaded parallel capacity, and the
independent hard byte ceiling. The two boundaries can be edited from that menu or the Context
entry under `/config`.
Terminal restoration happens before shutdown work. If an engine close fails, NNA still
attempts every other engine close and flushes local diagnostics; the Console completion
latch is always released and a safe stable failure code is written to the fallback stream.
`/permissions` shows only bounded redacted metadata for the active conversation's
preauthorizations; `/permissions revoke ID` removes one immediately. Grants are in-memory,
tab-local, expire within four hours, and never survive closing NNA.
`/copy` explicitly copies the latest assistant response; `/copy N` selects the Nth-latest.
It never copies user, tool, or reviewer content and rejects payloads over 100,000 bytes.
Clipboard transfer uses an explicit OSC 52 terminal action, so unsupported terminals may
decline it without NNA invoking a platform clipboard executable.

`/compact` explicitly applies the same bounded, auditable context compaction used by
automatic provider preflight. Compaction retains the full local transcript for display and
audit, appends a source-fingerprinted continuation artifact, and starts subsequent model
context from that artifact plus the newest causal tail. A bounded semantic pass enriches
the artifact when the configured provider supports it; strict schema validation and a
deterministic artifact remain the failure-safe path. Recent-turn protection relaxes only when
it would otherwise make an explicit or required compaction a no-op; complete source records
remain in the durable session ledger. `/clear conversation` never acts immediately: it requires
the exact `/confirm clear conversation` follow-up, records the durable clear boundary,
and resets authenticated conversational authority, durable goal/task state, and visible context.

`/handoff` is intentionally more aggressive. It creates an extremely terse self-handoff
containing only the active objective, binding decisions, completed work, verified state,
blockers, and immediate next actions. No prior transcript records remain in active model
context, although the complete conversation remains visible and durably journaled.

The primary conversation is marked with `*`. Inactive conversations use `+` for unseen
output; `~`, `?`, and `!` indicate active work, attention required, and failure.

Queue images for the next message with `/attach PATH`; `/attachments` inspects the
tab-local queue and `/detach INDEX|all` removes entries before submission. PNG, JPEG,
GIF, and WebP are admitted with bounded size and content-signature checks. A temporary
vision failure displays its managed attachment ID; use `/attachment retry ID MESSAGE`
or `/attachment remove ID` to resolve it explicitly.

Ctrl+V and right-click paste accept either clipboard text or a clipboard image. Clipboard
images are encoded as PNG beneath the active session's managed `attachments` directory
and queued for the next message. Dragging or pasting one or more PNG, JPEG, GIF, or WebP
file paths into the conversation queues those files instead of inserting their paths as
prompt text. Configuration forms continue to treat pasted paths as ordinary single-field
text.
The transcript reports each persisted `staged`, `admitted`, `pending_failed`, `rejected`,
and `removed` transition. When no image-capable route exists, it explicitly says the
managed image was removed and not analyzed, preserves the text draft, and directs the
operator to configure a capable primary or vision route before reattaching the image.
If filesystem cleanup cannot be verified, NNA records and displays `cleanup_failed`
instead of falsely claiming rejection/removal; the managed identity remains available
for an explicit removal retry after the filesystem condition is resolved.

`/provider` opens the configured-provider menu and `/model` queries the selected provider's
model catalog before opening its model menu. Use Up/Down to choose and Enter to apply.
`/provider ID` and `/model NAME` are direct equivalents. Manage profiles from Main with
`/provider add`, `/provider edit`, `/provider test`, and `/provider delete`; run `/help` for
their exact forms. Those operations are also selectable inside `/provider`; Enter closes
the menu and places the corresponding command form in the editor for completion.
Credential arguments name environment variables and never contain the credential itself.
Deletion is refused while any conversation Primary route or global specialist role still uses the
profile, and every persisted manifest replacement retains a last-known-good `.bak` file. Left/Right
selects a pronounced Primary, Sub-agents, Permission reviewer, or Vision role tab. Only Main's
Primary tab exposes profile-management actions. Primary is conversation-specific: Main supplies
the one-time default copied by new tabs, while existing tabs retain their own routes. Reviewer,
Sub-agents, and Vision are global workspace roles and can be assigned or cleared only from Main;
changes propagate to every open and saved tab. A cleared specialist falls back to the requesting
tab's Primary route. Vision is attempted only after that Primary cannot process the image. The
direct clear form is `/provider ROLE clear`. “Copy Main” copies only Main's Primary route once.
`/model` changes only the active conversation's temporary
primary-model override and does not rewrite the provider profile. Configuration changes are
immediate while idle and take effect at the next model boundary while a turn is running.
`/config` is the keyboard-driven hub for focused configuration surfaces. It opens the
Provider, Model, MCP, WebSearch, and Workspace Trust managers without duplicating their
logic. Esc returns to the hub when a manager was opened from it. The hub does not expose
memory service policy, attachment admission, context ceilings, recovery behavior,
deadlines, concurrency, or key maps as ordinary toggles.

`/websearch` opens the global SearXNG manager. It can test, disable, or forget an existing
endpoint, deploy/start/stop NNA's optional local container, and preserves managed data
when stopped. `/websearch URL` validates a remote, private-network, or local endpoint
before saving it. The setting is global across conversations and agent roles.

`/mcp` opens the MCP server manager. Main can add Streamable HTTP or shell-free stdio
servers, test connection and discovery, enable or disable entries, and safely remove them.
Selecting a configured server opens a focused action menu. Add and edit use bounded,
single-line, keyboard-navigable forms with same-level Esc/back behavior; deletion requires
an explicit confirmation. The menu never requires users to complete raw slash-command syntax.
Authentication may be omitted, entered directly as a masked token, or supplied through an
existing environment variable. Directly entered tokens are saved in NNA's restricted local
MCP credential file; only a generated reference is written to the MCP configuration. Because an MCP topology changes
the callable tool catalog, saved changes apply to new conversations and after restart;
the manager reports this explicitly instead of pretending to hot-load the active engine.
The agent can call `nna.mcp_status` to inspect this global registry and `nna.mcp_test` to
validate a server and list discovered tool names. It must not search the active workspace
for NNA's private configuration. Opening a new conversation is sufficient to make newly
discovered tools invocable; the application does not need to be restarted.
Connected servers expose bounded, attributed untrusted content through `/mcp resources ID`,
`/mcp read ID URI`, `/mcp prompts ID`, and `/mcp prompt ID NAME [JSON]`. These views do
not add resource or prompt content to authority or silently submit it to the conversation.

`/memory` reports adapter health and inspects project-scoped memories. `/memory save TEXT`
is the explicit, secret-screened write path; `/memory delete ID [EXPECTED_VERSION]` removes
an item with an optional optimistic-concurrency guard. Enabling memory does not install an
adapter or configure an MCP server, and the view reports an absent adapter as unavailable.
This boundary refers to an external structured memory service such as NNM; it is unrelated
to repository guidance files such as `NNA.md`.

Permission prompts show the exact tool, scope, effect, reversibility evidence, blast
radius, reviewer reason, redacted arguments, expiry, and distinct allow/deny/cancel
actions. A tool definition's general `reversible` effect label is not itself recovery
evidence: the prompt reports `not_verified` unless the sealed request carries an
engine-verified recoverable checkpoint. Up/Down navigates permission details when the terminal is narrow. While a
permission is pending, ordinary editor input is retained but cannot replace the focused
decision surface. A stale prompt cannot be approved. Terminal output from models and tools is
escaped; the interface never opens links, copies text, or executes displayed paths.

Diagnostics and configuration inspection open bounded temporary views instead of writing
serialized objects into the conversation. Up/Down scrolls these views; Esc, Ctrl+G, or Ctrl+C
closes them and restores the prior transcript position. Invalid Console commands remain
editor-local notices and never change the engine state to failed.

Submitting ordinary text while a turn is active records it as authenticated steering for
the next safe checkpoint. The editor is cleared only after that steering is accepted.

Terminal cleanup is idempotent across ordinary exit, cancellation, renderer failure,
termination, and suspend/resume. Cleanup independently attempts to disable bracketed
paste and mouse reporting, show the cursor, leave the alternate screen, restore cooked
input, and pause input even if one terminal write fails. A fatal renderer error is then
reported as one sanitized plain diagnostic without model/tool content.
Exit restores those terminal modes immediately after input/rendering is stopped, before
waiting for bounded engine shutdown or log flushing, so a slow cleanup cannot strand the
operator in raw mode or an alternate screen.
# Skill workflows

`/skills` opens the bounded skill catalog. Choosing an entry prepares `/skill ID` in the
editor so the operator may add a request before submitting it. `/skill ID [REQUEST]`
invokes a user-accessible skill for the next turn; it does not persist new authority or
change the conversation's tool grant.
