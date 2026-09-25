# NotNativeDesktop Cleanroom Reference — 05: Chat & Session UI

Re-implementation specification for OpenChamber's chat surface, composer, message
timeline, session sidebar, work-status readouts, and the question/permission
interaction layer. Written for a team rebuilding the same UI/UX on their own
agent harness (an OpenCode replacement). This document is self-contained; source
citations like `(src: ...)` exist only for traceability.

Scope owner of: chat composition, composer and its prompt language, message part
renderers, turn grouping/live activity, work-status panel, session sidebar and
its actions, project-context panel usage surface from the chat side,
question/permission cards, input history, snippets, magic prompts, draft
starters, usage/quota readouts shown in chat, onboarding entry, dictation entry.

Out of scope (owned elsewhere; this doc only lists entry points):
- 02: harness payload shapes (sessions, messages, parts, providers, models,
  agents, permissions, questions, quota), auth/trust model.
- 04: sync/state machinery beneath everything here (persistent session cache,
  live status channels, message records store, optimistic state).
- 06: file/diff/git/PR surfaces opened from chat.
- 08: trust dialogs, pairing, security (chat only lists entry points).
- 11: mobile-specific session UX (bottom sheets, keyboard choreography, mobile
  sessions sheet, Capacitor deltas).
- 12: multi-run launcher, session goals depth, scheduled tasks depth.
- 14: theme tokens, icon set, settings pages, global shortcuts/i18n infra.
- 15: MCP management UI (chat shows MCP status row only).

Conventions used below:
- "Runtime" means: desktop (Electron), web, VS Code webview, hosted mobile
  (phone shell), Capacitor mobile. Where behavior differs, it is called out.
- Label strings are quoted as shipped English (`en`); keys match the i18n
  catalog, so a port can localize them. `(src: packages/ui/src/lib/i18n/messages/en.ts)`
- A "turn" is one user message plus the assistant messages and tool activity
  until the next user message.
- Harness = the engine that produces sessions/messages/parts. Every task the
  OpenCode concepts did (models, agents, tools, parts) must be re-mapped by the
  porting team; those places are marked **HARNESS PORT**.

---

## 0. Data contracts the chat UI reads

The chat is a pure renderer over these records. 04 owns how they arrive; this
is the shape the UI assumes.

### 0.1 Session record

```
Session {
  id: string                    // "ses_..." opaque id
  title?: string                // human or AI-generated; optional
  parentID?: string | null      // set for child (subagent/task/btw) sessions
  directory: string             // project/worktree path the session runs in
  time: { created?: number; updated?: number }   // epoch-ms
  metadata?: {
    openchamber?: {
      btwSessionID?: string     // parent -> active btw fork id
      btwPromoted?: boolean     // fork was promoted out of btw mode
      goal?: { ... }            // session goal snapshot (owner: 12)
      assist?: { recap: string; suggestion: string; forMessageID: string;
                 generatedAt: number }
      linked_issues?: [{ kind: 'issue'|'pull'|'linear'; id; number?; identifier?;
                         title; url; author?; avatarUrl?; linkedAt }]
      // context pins ("obligatory messages") are entries
      // [{ id: messageId; createdAt: epoch-ms; role: 'user'|'assistant' }]
      // written by `setContextObligatoryMessage`
      [name: string]: unknown   // other namespaces ignored
    }
    [name: string]: unknown
  }
  share?: { url?: string; isPublic?: boolean } | null   // public share link
  archived?: boolean
  summary?: { additions; deletions; files }   // NOTE: always zeros; see 3.9
  revision?: number
}
```

`(src: packages/ui/src/components/chat/ChatContainer.tsx; packages/ui/src/lib/sessionBtwMetadata.ts;
packages/ui/src/lib/sessionAssistMetadata.ts; packages/ui/src/lib/linkedIssues.ts;
packages/ui/src/components/session/sidebar/sessions/SessionNodeItem.tsx)`

**HARNESS PORT**: `metadata.openchamber.*` is an OpenChamber-owned metadata
namespace written through a session-metadata PATCH channel. A re-implementation
must define its own metadata namespace with at least: btw link + boundary,
assist payload, linked threads snapshot, feature-kind marker, and per-message
context pins.

### 0.2 Message record

```
MessageRecord { info: Message; parts: Part[] }
Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  sessionID: string
  parentID?: string          // message-level: user message an assistant replies to
  time: { created: number; completed?: number }   // completed>0 → finished
  finish?: string            // assistant terminal reason: 'stop' | 'tool-calls' | 'error' | 'aborted' ...
  error?: { name?: string; message?: string; data?: { message?: string } }
  providerID?: string; modelID?: string; agent?: string; mode?: string
  variant?: string   // OpenCode ≥1.4 put effort under model.variant; legacy top-level fallback
  tokens?: { total?: number; input: number; output: number; reasoning: number;
             cache: { read: number; write: number } }
  cost?: number
  summary?: { diffs?: [{ file; additions; deletions; patch? }] }  // working-tree snapshot at turn end
  synthetic flags arrive inside parts, not here
}
```

`(src: packages/ui/src/components/chat/MessageList.tsx; packages/ui/src/lib/messageCompletion.ts;
packages/ui/src/components/chat/ChatMessage.tsx)`

### 0.3 Part union (renderable content of a message)

| `part.type` | Producer | Notes |
|---|---|---|
| `text` | any | `{ text; synthetic?: boolean; ignored?: boolean; time?: {start; end?} }`. `synthetic` parts carry harness/system instructions that are not user typing. |
| `reasoning` | assistant | `{ text; time?: {start; end?} }` thinking trace |
| `tool` | assistant | `{ tool; state: { status: 'pending'|'running'|'completed'|'error'; input?; output?; metadata?; error?; time? {start,end}; attachments? } }` |
| `step-start` | assistant | step boundary marker (rendered as nothing) |
| `subtask` | user | delegation to a child harness run: `{ description?, command?, agent?, prompt?, model? {providerID; modelID}, taskSessionID? }` |
| file / agent / `openchamberContext` chunks | user attachments & context | see 3.2 |

Unknown part types must not throw; they render nothing (the parts filter skips
non-matching types) and never break the message row. `(src:
packages/ui/src/components/chat/message/partUtils.ts)`

**HARNESS PORT**: the part taxonomy is OpenCode's. A port defines its own part
catalog (§C.3 catalog is presentation, not transport); what must be preserved
is the *rendering role*: user text/instructions, thinking, tool calls with
running/done states, subtask delegations, and lightweight step markers.

### 0.4 Runtime interaction contracts invoked from chat

- Send a message: `sendMessage(text, providerId, modelId, agentName,
  attachments, agentMention, additionalParts, variant, inputMode /* 'normal'
  | 'shell' */, options)` — options carry queue target/session/directory/draft
  snapshot/history submissions/`delivery: 'steer'`. On failure the composer
  restores everything (§B.9). `(src: packages/ui/src/components/chat/ChatInput.tsx)`
- Abort current operation: `abort(sessionId)` for busy; also clears a pending
  abort record via `acknowledgeSessionAbort` after side effects.
- Session lifecycle: create (from draft send), archive/restore, delete (hard)
  with descendants, rename, share/unshare (returns share URL), export Markdown,
  fork-from-message, revert-to-message, move-to-worktree, compact (harness-side
  summarization), summarize/title.
- Permission/question actions: `respondToPermission(sessionId, requestId,
  'once'|'always'|'reject')`, `respondToQuestion(sessionId, requestId,
  answers: string[][])`, `rejectQuestion(sessionId, requestId)`,
  auto-accept per session: `setSessionAutoAccept(sessionId, enabled)`.
- Message quotes/context: pins (context-obligatory messages) are stored in
  session metadata; pins survive compaction.
- Quota readout: per-provider usage windows (§G).
- Session-assist (recap + suggested follow-up): server-generated payload in
  metadata; read-only in UI.

---

## A. Chat surface IA

### A.1 Surfaces and modes

`ChatSurfaceMode` distinguishes three rendering behaviors of the SAME body
components `(src: packages/ui/src/components/chat/chatSurfaceContextValue.ts)`:

| Mode | Where used | Composer | Per-message controls | BTW/fork actions |
|---|---|---|---|---|
| `default` | main chat column (desktop/web/VS Code/mobile) | full | yes | yes |
| `mini-chat` | desktop "mini chat window" (separate small window) | compact (no fork/plan actions) | yes, minus fork | no |
| `peek` | the `/btw` panel's message list | n/a (composer of parent is reused) | none (no action row, no footer) | n/a |

The embedded session chat (subagent inspect panel) renders `ChatView` with
`readOnly` until the user opens prompting for subagents
(`allowPromptingSubagentSessions` setting synced through an iframe
`postMessage` handshake: `openchamber:chat-settings-request` →
`openchamber:chat-settings-sync`). Read-only state renders a banner text:
`Subagent sessions cannot be prompted.` (key `chat.container.readOnlySubagentPromptBanner`)
`(src: packages/ui/src/components/chat/ChatContainer.tsx:1021-1093)`

### A.2 Composition tree (desktop primary)

`ChatView` = error boundary + `ChatContainer`:
```
ChatContainer (flex row; rowRef measured for panel visibility)
├─ ChatColumn (flex-1 min-w-0, data-composer-bound)
│  ├─ "Return to parent" button (absolute top-left; only in child sessions)
│  ├─ Session surface (one of):
│  │   ├─ Draft welcome (centered heading + starter chips)   [when draft open]
│  │   ├─ Hydration skeleton (three fake turn rows)          [session loading, empty]
│  │   ├─ Session load error card (retry / log-in)           [failed history load]
│  │   ├─ Empty spacer                                       [session exists, 0 messages]
│  │   └─ ChatViewport
│  │       ├─ MessageList (virtualized; header = "Load older messages" button
│  │       │    on mobile; footer = QuestionCards + PermissionCards +
│  │       │    SessionErrorNotice + tail spacer)
│  │       ├─ ScrollToBottomButton (dock above composer, right side)
│  │       ├─ Floating status row anchor (glass chip above composer: working/
│  │       │    waiting/retrying; plus SessionRecapNote in the idle case)
│  │       └─ PromptNavigatorRail (right gutter; prompts only; ≥2 prompts)
│  ├─ Composer slot
│  │   ├─ floating (normal session): absolute over transcript tail; glass box
│  │   ├─ draft screen / expanded editor: in flow
│  │   └─ contains ChatInput (full composer) or ReadOnlyPromptBanner
│  ├─ WorkStatusPanel overlay (when the panel cannot fit beside the column)
│  └─ TimelineDialog (turn navigation / fork / revert dialog)
├─ WorkStatusPanel (inline, fixed-width sibling column; desktop, when it fits)
└─ (portal-layer dialogs: ToolOutputDialog, image preview overlay, pickers)
```

`(src: packages/ui/src/components/chat/ChatContainer.tsx:1625-1740)`

Key layout mechanics to copy:

- **Composer inset**: when floating, a ResizeObserver on the composer slot
  writes its height into CSS var `--chat-composer-inset` on the chat column;
  the timeline's tail spacer reads `var(--chat-composer-inset, 128px) + 80px`.
  Tail spacer height when not floating: `40px` mobile / `10vh` desktop.
  `(src: ChatContainer.tsx:30,397-409)`
- **Status row reserve**: the working chip floats over the transcript bottom;
  its measured height (+8px gap) extends the reserve (min reserve 40px) so a
  pinned viewport never sits under the chip. `(src: ChatContainer.tsx:22,1100-1131)`
- **Session switch choreography**: selection is published live but the chat
  swaps content on a deferred copy. A session not yet in memory keeps the
  previous timeline on screen for up to 400ms (`SESSION_SWITCH_HOLD_MS`) while
  it loads; if it loads, the new timeline reveals: held invisible until
  content height is stable for 2 frames (cap 300ms), then fades in as one
  picture if the user waited; instant if it was warm.
  `(src: ChatContainer.tsx:17-36,411-487)`.
- **Draft → session transition**: the first send from the new-session draft
  materializes a session; the composer stays mounted, draft-only UI fades for
  120ms, then the editor FLIP-animates (transform-only, 180ms,
  `cubic-bezier(0.22,1,0.36,1)`) to its session position. Reduced motion skips
  animation. Never remount the editor between draft and session.
  `(src: packages/ui/src/components/chat/composer/DOCUMENTATION.md` lines 10-19;
  `ChatContainer.tsx:1446-1482)`
- **Floating panels**: BTW panel, queued-message chips, and suggestion chip
  share one dock frame (`ComposerFloatingPanel`) inside the composer form,
  anchored `absolute bottom-full`, glass surface; their measured height writes
  `--chat-floating-panel-clearance` which lifts the floating status row and
  the scroll-to-bottom button without moving the transcript.
  Visibility priority: BTW > nonempty queue > suggestion. Composer content
  hides suggestion; new-session drafts hide queue+suggestion. Hiding the queue
  never pauses delivery. `(src: composer/DOCUMENTATION.md:21-46;
  ComposerFloatingPanel.tsx)`
- **`chatColumnSession`**: the composer and everything stacked with the
  timeline follow the *deferred* session shown in the column, not the live
  store selection, so the column swaps as one unit. `(src: chatColumnSession.ts)`

### A.3 Per-runtime deltas

| Runtime | Composer position | Work status | Prompt navigator | Load older | Notes |
|---|---|---|---|---|---|
| Desktop/web | floats over transcript; draft screen centers it | panel column right (or overlay) | right gutter rail | scroll-top trigger | full features |
| VS Code | in flow below transcript | hidden | hidden | scroll-top trigger | no fork/plan; pickers via extension host; worktrees excluded from sidebar; panel overlay only on desktop-width webviews |
| Phone/mobile | composer floats; collapsed pill by default; box grows with content, capped at 16 lines and at its screen container (`[data-composer-bound]`) minus a 4px gap; desktop box grows with content up to 8 lines (expanded mode unbounded) | hidden | hidden | explicit top button "Load older messages" | keyboard choreography; pill↔box swap; bottom sheets; typed send goes through form submit or tap |
| Mini chat window | default layout | hidden | hidden | scroll-top | window chrome incl. pinned state and Windows controls; no fork/plan/multirun actions |
| Embedded subagent chat (context panel iframe) | as main, optional read-only banner | hidden (VSCode/mobile rule) | hidden | as runtime | returns to parent button when drilled deeper |

`(src: ChatContainer.tsx:961-1000; ChatInput.tsx:189-204; MiniChatLayout.tsx)`

### A.4 Session detail header (above the chat, outside sidebar)

The header owns: session tab strip (`SessionTabsStrip` — one tab per opened
session, close X per tab; digits/keys cycle; active tab shows the session
title via `SessionsTabTitle`), context-usage readout, per-session menus
(AI rename via `SessionAiRenameMenuItem`), and the usage/quotas dropdown. The
header is a layout surface (see 02/14); this doc fixes only what chat shares:

- Header treatment: clicking the model/provider logo and usage readout opens
  dropdowns shared with the composer's model controls.
- The work-status visibility result `workStatusPanelVisible` is published in
  the UI store; the header drops readouts the panel already carries and the
  Git rail drops its readouts likewise. `(src: work-status/DOCUMENTATION.md:254-256)`

### A.5 Mini chat window

A separate desktop window (Electron) hosting `MiniChatLayout`:

- Header (drag region): session title — current session title, `New session`
  when a draft is open, `Session` otherwise (keys `miniChat.header.*`);
  directory label compacted to last 3 segments (`~/`-shortened); git branch
  label; pinned-window state via `desktop_get_window_pinned`; model display
  name; context-usage percentage bar with token counts.
- Body: `ChatContainer` in mode `mini-chat`.
- Buttons: session switcher dropdown, window controls (macOS traffic lights /
  Windows buttons), pin toggle.
- BTW is available in the mini chat window (`/btw` requires a
  parent session; the panel docks beneath the mini-chat composer); fork/save
  actions and multi-run footer actions remain hidden (mode `mini-chat`).

### A.6 Onboarding (first run)

`OnboardingScreen` routes between: `ChooserScreen` (two tabs: "Local install"
with copyable install + binary path setup + "Check now" watcher +
"Advanced: browse for binary"; and "Connect Remote" with `RemoteConnectionForm`
for a remote instance URL/credentials), `RecoveryScreen` /
`DesktopConnectionRecovery` (chat/instance unreachable), and LocalSetupScreen
variants for Windows (WSL steps) and unix. Entry point for chat: on
connection failure with no sessions.
`(src: packages/ui/src/components/onboarding/*.ts(x))`

---

## B. Composer specification

`ChatInput.tsx` is the orchestrator; layers: prompt language → CodeMirror
editor → composer-local state → submit assembly → attachments → UI.
`(src: packages/ui/src/components/chat/composer/DOCUMENTATION.md)`

### B.1 Visual structure

- Container: bordered rounded box (`--radius-xl` desktop, `1.5rem` mobile),
  `oc-glass-composer` when floating over the transcript, focus ring border
  color change; drop-ring highlight while dragging files.
- Rows inside, top to bottom (desktop):
  1. Context chips rows: attached files list, linked reference chips
     (issue/PR/Linear), VS Code file chips, active editor file suggestion;
     inline comment draft chips.
  2. Editor (CodeMirror) — grows with content, 8-line cap desktop /
     16-line cap tablet; mobile unbounded to screen bound minus 4px gap.
  3. Footer row (see below).
  4. Session goal strip (above the box, not inside; hidden in btw mode).
- Mobile collapsed pill: single-line; top row = suggestion chip; middle =
  attachment container; bottom row = model button + agent button. Expands on
  focus/typing or drag handle; the pill has explicit affordances: attach
  (opens bottom sheet), mic, send, queue, stop, plus/expand.
- Above-box stack (desktop): goal strip, status bars, draft-target selectors.

### B.2 Control inventory (desktop footer)

| Control | Icon/label | Behavior | Keys |
|---|---|---|---|
| Attach (+) | `add-circle`, title "Add attachment" | Dropdown: "Attach files", "Link GitHub Issue", "Link GitHub PR", "Link Linear Issue" (hidden when Linear unavailable) → dialog pickers | none |
| Model/agent settings | `ai-agent`, "Model and agent settings" | Opens settings dialog (models/agents page) | none |
| Focus mode | `fullscreen`, "Focus mode" (+shortcut by `expand_input`) | Toggles expanded editor mode (fullscreen surface; Escape exits; transcript hidden `aria-hidden`) | `expand_input` shortcut |
| Permission auto-accept | `shield-user` off / `shield-check` (info color) on; tooltips "Permission auto-accept: off/on"; aria "Enable/Disable permission auto-accept" | Toggles per-session auto-accept; on a draft toggles draft-level flag; disabled/op-30 when no session and not drafting | `toggle_permission_auto_accept` |
| Session goal button | `target` / `target-fill`, colored by goal state; aria "Arm goal mode"/"Disarm"/"Manage goal" | Arms next sent message as goal objective (drafts allowed); click with active goal opens manage dialog | — |
| Goal objective counter | text `n/2000` (aria "Goal objective character count") | Live composer text length while goal armed; server clamps 2000 | — |
| Model selector | provider logo + model name (marquee scroll when truncated, max 260px) | Dropdown panel (desktop): "Add new provider" row (opens Settings → providers with the add-provider pseudo id), search field, Favorites / Recent groups, per-provider collapsible groups; per-row: logo, name, provider, current marker, favorite star toggle, drag-reorder (favorites + provider order), thinking-effort hint (`Thinking: X | Default` navigable with ArrowLeft/Right when the row has variants). Readiness: before the harness instance is ready the trigger shows a spinner + localized "Loading"/"Unavailable" label and is closed/disabled. Mobile: compact button opens themed bottom sheet (search, favorites, recents, collapsible provider groups with "Current" tag); long-press opens the model metadata tooltip. Name-tooltip (600ms) on desktop shows the metadata card: name, provider, Capability icons ("Tool calling", "Reasoning"), input/output modality icon rows, cost per million (Input/Output/Cache read/Cache write), limits (Context/Output tokens, compact-formatted), Knowledge cutoff ("Mon YYYY"), Release date | `Ctrl+M` opens/owner is layout; inside picker: arrows navigate, Tab switches agent, Left/Right cycle effort, Enter applies |
| Agent (persona) selector | agent color dot + capitalized agent name | Dropdown: primary-mode agents sorted A→Z, fuzzy-ranked by name/description; selected shows check; per-agent description tooltip. Name-tooltip (600ms delay) shows: description; Mode ("Primary"/"Subagent"/"All"); Model (fixed `providerID / modelID`) + temperature/top_p when set; permissions summary rows for edit/bash/webfetch resolved from wildcard rules — values "Allow"/"Ask"/"Deny", or "Custom" when any non-wildcard rule exists; "Custom prompt" check row when the agent carries a prompt | Tab (in model picker footer hint); in the composer the `cycle_agent` combo cycles the agent forward (Shift+combo cycles backward; suppressed while a picker is open) |
| Effort/Thinking selector | `brain-ai-3` + effort label or "Default"; muted when default, status-info color when set | Dropdown: Default + variant list; compact mobile: bottom sheet panel "Thinking" with back button | Left/Right in model list |
| Dictation | `mic` "Start dictation" (desktop) | Starts browser voice transcription; overlay appears over composer with live transcript, waveform, and actions (cancel; insert; insert & send; retry; discard on error); placeholder states: "Listening...", "Transcribing...", "Downloading speech model... {percent}%" | configurable `voice` shortcut |
| Send button | `send-plane-2` "Send message"; `type=submit` on desktop form | Disabled (`opacity-30`) without content or session; primary action (see §B.9) | Enter / Ctrl+Enter per keyboard policy |
| Queue button | `send-plane-2` rotated -90°, "Queue message" | Floating above send while session is busy AND composer has content; adds composer content + context to the queue | — |
| Stop button | square `StopIcon`, "Stop generating", error-red | Shown while session busy (`canAbort`); aborts current turn. In btw mode stops the fork | — |

`(src: composer/ui/ComposerFooter.tsx; ComposerActionButtons.tsx;
ComposerAttachmentControls.tsx; PermissionAutoAcceptButton.tsx;
FocusModeButton.tsx; ModelControls.tsx; SessionGoalButton.tsx)`

Mobile footer (single row): attach opens bottom sheet first; shield; goal
button + counter; then right side: mic, then send/queue/stop. Model + agent
buttons live in the pill/upper rows instead of the footer.

### B.3 The prompt language (single source of truth)

The composer document is a plain string; `getValue()` is exactly what is sent.
`language/` owns syntax; adding a construct means adding it once
(`tokenize.ts`).

- `@mention` — file/agent references. Span `start..end` highlights the token
  itself. Plain editable text: deleting a character reopens the picker (not
  atomic). Membership = confirmed mentions set + known agent names; unknown
  tokens stay prose. `(src: composer/language/mentions.ts)`
- `/command`, `/skill`, `#snippet` — prefix tokens. Highlighting is generous
  when the letter follows `/` or `#`; **registry membership is authority**:
  an unknown `/token` is plain prose. `(src: composer/language/prefixTokens.ts)`
- `!` shell mode: first character `!` (caret at 0, either via keydown handler
  or, when keyboards skip keydown, by consuming a leading `!` in the change
  transaction) switches mode: element becomes mono; triggers `!` is
  auto-normalized away; screenshot state stays in `inputStore` as `inputMode`.
  Escape or Backspace-on-empty exits shell mode. In shell mode the text is a
  `bash` command executed by the harness, not model input.
- Autocomplete triggers, exactly ONE active, precedence
  `command > skill > snippet > mention`: caret immediately after `/`+letters →
  command/skill picker (filtered by registry distinction), after `#`+letters →
  snippet, after `@`+letters → mention (files + agents). Query = token text.
  `(src: composer/language/triggers.ts)`
- Highlights also confirm `@file` only when the path was resolved by the
  picker, and inline-cited attachment names (`[name]`) receive distinct
  highlight through `attachmentFilenames`.

### B.4 Editor behaviors (CodeMirror essentials to port)

- Full-document retokenization on every change (prompt-sized is fine).
- Line-ending normalization: never derive caret positions from inserted-text
  length; route caret-moving edits through a "measure the change" helper.
- Selection paint: painted selection via editor theme on desktop; on iOS the
  native selection is re-exposed for range selections (lag workaround); never
  disable drawn selection (iOS association bug). Out-of-scope chrome details
  live in 11, but the composer-specific rules are listed here because they are
  load-bearing: Desktop autocorrect off; mobile on; autocapitalize sentences
  mobile only; spellcheck = user setting (default off on desktop; on mobile).
  `(src: composer/DOCUMENTATION.md:115-193)`
- Markdown auto-pairing on typed bracket/quote characters (normal mode,
  no autocomplete open, no modifiers) via `getMarkdownAutoPairEdit`.
- Pasting a URL over a selection wraps it as a Markdown link
  `[selected](url)`.
- Ctrl/Cmd+N and P mapped to the open picker's next/previous (via generic
  dropdown navigation); Enter/Tab accepts, Escape closes; IME composition
  events bypass all handling (`isIMECompositionEvent`).

### B.5 Keyboard policy (submission)

`(src: composer/keyboardPolicy.ts — exact algorithm)`

```
shouldSubmitEnter:
  isCtrlEnter = ctrl || meta
  if isDesktopExpanded: return isCtrlEnter only   (Enter/Shift+Enter = newline always)
  if setting not configured: return !shift && (desktop-default Enter sends; mobile requires Ctrl/Cmd+Enter)
  otherwise: send = (enterToSend ? !shift : shift); return isCtrlEnter || send
```

- Chat setting: "Enter to send" (`enterToSend`, `enterToSendConfigured`).
  Once configured, the choice applies across all shared composers.
- CodeMirror defers mobile Enter keydowns losing modifier info: until
  configured, Shift is "restored"; once configured with mobile
  autocapitalization, deferred Shift+Enter cannot serve as send; Ctrl/Cmd+Enter
  is the supported modified send. `preserveDeferredEnterShift = !configured || !isMobile`.

### B.6 Autocomplete pickers (inventory & behaviors)

| Picker | Trigger | Items | Keyboard | Actions |
|---|---|---|---|---|
| Command | `/`+query; only registry members listed | OpenCode session commands (custom commands from harness config; plus built-ins: init, review, undo, redo, timeline, compact, btw, handoff-review (desktop only), summary, workspace-review, plan-feature, craft-goal, schedule-task, catch-up, debug, weigh, explore (magic prompts); plus `/skills` entries surfaced by skill picker) | Arrows/Enter/Tab/Escape; Ctrl+N/P | Selecting inserts `/name ` (with trailing space) except `/btw` on an existing session which immediately runs the btw transition |
| Skill | `/`+query filtered to skills | Directory-scoped skills list | same | inserts `/name ` |
| Snippet | `#`+query | Snippets (name + aliases) | same | inserts `#trigger ` |
| Mention | `@`+query | Project files (fuzzy search across the chat search directory) + agents | same | file: inserts `@relative/path `, adds to confirmed set; agent: inserts `@agent ` |
| VS Code extras | file tree drag → `@mention`; "add to input" chips from editor | directory-scope files | — | appends `@mention` line; toast "Added {count} file mention(s)" |

`(src: ChatInput.tsx:739-758 (knownSlashNames), 2646-2773 (handlers);
ComposerAutocompletePopups; FileMentionAutocomplete)`

Position: anchored above the composer (desktop); in expanded desktop mode the
picker re-anchors at the caret via measured coords; mobile clamps height to
available space above the pill (shared max-height hook).

### B.7 Attachments and context supplies

- Accept: images + documents (`attachment-files` contract: accept list; the
  single hidden `<input type=file multiple>` mounts once at composer level so
  a footer/pill swap cannot kill the file dialog).
- Uniqueness of names; images get generated names (image-1, image-2, …).
- Modality compatibility: when metadata says the model lacks image/pdf/audio/
  video input, a warning toast names the model, modalities, and files:
  "{model} does not support {modalities} input required by {files}. You can
  still send the message, but these attachments may be ignored."
  `(src: ChatInput.tsx:607-648)`
- Paste:
  - Files in clipboard → attach (`attachFilesWithCitation`), each cited in
    draft as `[name]`; for images, citation inserted before the attach
    resolves; other files cited only after successful attach; if the clipboard
    also carries the file's filename as text it is suppressed so only the
    citation lands.
  - Large plain-text paste (>~2000 chars or 25 lines): setting
    `largeTextPasteBehavior` = `ask` (default) / `attach` / `inline`.
    `ask`: synchronous preventDefault, then non-dismissible toast "Large text
    detected" with actions "Attach as file" / "Paste inline"; dismissal falls
    back to inline. `attach` creates in-memory `text/plain` file named
    `pasted-context-N.txt` with one citation; supersede/double-apply guarded
    by offer IDs. Ask-toast actions read live composer/attachment state.
  - Short text: inserts normally; if it contains `@`, mention autocomplete is
    pre-suppressed so pasted `@` doesn't open a picker.
  - URL over selection → markdown wrap (see B.4).
- Drag & drop:
  - External files → attach with citation. Overlay: icon + "Drop files here
    to attach" (or "Drop to insert as mention" for internal drags).
  - Internal drags (file tree ↔ composer) carry
    `application/x-openchamber-file-path` → inserts `@path` as mention with
    smart boundary spacing (disables drop-to-text).
  - VS Code also re-inserts the dropped path as text; a 700ms suppression
    window swallows the duplicate insertion when it matches the dropped path.
- Context supplies that render as chips and become synthetic parts at send:
  inline review comments (from text selection "Comment"), terminal selection
  (`{terminal}, lines {start}-{end}`), browser preview annotations, PR
  comments/checks, chat quotes, linked GitHub issue/PR and Linear issue
  pickers. Each chip has remove affordance; keyboard label keys:
  `chat.chatInput.reviewComments`, `chat.chatInput.terminalContext`,
  `chat.chatInput.prCheckContext`, etc.
- Linked references: chips show `#123`/`PR #456`/`AC-123`, title, optional
  author avatar/name ("by {author}"), branches for PRs (`head…base`), open in
  browser (aria "Open {issue|pull request} in browser") and remove (aria
  "Remove linked …"). Re-open picker via chip click.

### B.8 Draft persistence & targeting

`(src: composer/state/useComposerDraft.ts; useDraftTarget.ts; ChatInput.tsx:999-1030)`

- Draft identity = `(runtimeKey, directory, sessionKey)`. `sessionKey` may be
  a real session id, `draft` (new-session), or a btw pseudo id
  (`btw-pending:<sessionId>` / fork id). BTW drafts are independent of main
  drafts including when persistence is disabled.
- Debounced writes while typing; forced flush at every "page may die" edge
  (visibility, beforeunload, identity switch). Orderings: skip one debounced
  write during restore; record a deleted draft's empty signature before any
  queued write (no resurrection).
- New-session draft targeting: project picker (searchable popup desktop;
  selection commits only on activation, focus returns to composer even when
  unchanged), branch/worktree selector (Select on desktop; bottom sheets on
  mobile). Target may be a pending worktree directory that is not in the
  branch list yet — it must survive list refresh (no snap back to root) and
  owns the advisory "uncommitted changes" dirty state, cleared on change so a
  warning never names the previous branch.
- Fork replay: a fork can hand text+attachments back targeting the fork's
  identity (`pendingComposerRestore`), consumed after loading that identity's
  draft; restore focuses the editor when the draft was restored from a fork.
- Restored caret: to end (`atEnd`) or select-all modes; BTW transition moves
  caret to end.
- Draft permission auto-accept flag lives on the draft; transfers to the
  created session.
- Draft welcome: title "What are we working on?" or
  "What are we working on in {project}?" with project label emphasized;
  starter chips below; VS Code / mobile / mini chat variants suppress the
  centered presentation.

### B.9 Submit assembly (the invariant to port)

`(src: composer/submit/buildOutgoingMessage.ts; ChatInput.tsx:1371-1931)`

One send produces OpenCode's "one primary message plus parts" shape:

1. Plan local slash commands BEFORE consuming anything.
   - Action commands (`/undo /redo /timeline /handoff-review /compact`): take
     only command text; leave queue/context/attachments untouched; set editor
     to empty; run the UI action (undo/redo → session revert handling;
     timeline → dialog; handoff-review → review-flow dialog — desktop only;
     compact → harness summarize using current provider/model).
   - Prompt commands (magic prompts list in §H): render visible prompt + a
     synthetic instructions part; send them as one message with attached
     context. `/btw` is a composer transition handled before sending state.
2. Snapshot the draft + captured identities before any `await` (a sidebar
   click during a send must not reroute it).
3. Server-owned queue: if a session is busy and the user sends
   (Enter) with follow-up behavior `queue`, the send resolves agent/file
   mentions now (mentions resolved at queue time, never at delivery), records
   linked-references snapshots, converts `@`-named document files into
   attachments (documents are fetched up front — the delivering server cannot
   read them), captures context chips and skill-mention instructions onto the
   queued item, then clears the composer. A failed queue puts everything back
   (text appended to whatever the user has typed meanwhile).
   `followUpBehavior` `steer` sends with `delivery:'steer'` instead (steers the
   running turn); `queue` is default. The queue button/steer semantics apply
   only in `normal` input mode.
4. Questions/permissions pending on the session subtree: sending is
   authoritative — pending permissions are denied, open questions dismissed
   (optimistically), and the composed message is queued for auto-delivery once
   the turn ends (a direct send would be raced away — do not send while
   blocked).
5. Snapshot restored mentions; on any failure `restoreComposerText` returns
   text+mentions. A failed send MUST return the typed prompt regardless of
   why (auth/network/server): losing a long prompt to a toast is the failure
   mode that must never happen.
6. Prepare document mentions (`@notes.pdf` style) → error toast
   "Failed to attach {name}"; runtime switch mid-prepare aborts silently.
7. Take queued messages for send when queue has content and the send is not a
   command: oldest queued becomes primary; context parts per item follow in
   order; other queued items become synthetic text parts positioned before
   subsequent items. VS Code records full items taken for input history; the
   server-side queue projects display-only previews.
8. Consume inline-comment drafts + pending synthetic parts (restore on
   failure).
9. Build context parts: every attached context item (comment drafts,
   terminal selections, browser annotations, PR comments/checks, linked
   issues/PRs) becomes its own synthetic text part with structured metadata
   (the timeline reads metadata to render context blocks). PR instructions
   precede the PR diff. Skill-mention instruction derived from `/name` tokens
   present in text (registry-exact).
10. Response-style instruction: on a first message to a session (or a new
    draft), a settings-driven "response style" instruction is appended as a
    synthetic system-reminder-wrapped part (never for btw forks).
11. Snippet expansion over primary text and non-synthetic parts (failure
    keeps original text; warn only).
12. BTW pending flow: prepare pending send marker, create the fork session
    with question text + attachments + parts + auto-accept flag; migrate draft
    identity + inline drafts to the fork; failures restore text and set panel
    back to pending; runtime switch clears panel state.
13. Arm the timeline anchor BEFORE the optimistic user row commits
    (`scrollToBottom`), then `sendMessage`. On success: record linked
    references snapshots (post-send, swallow failures), clear linked chip
    state; on failure see §B.9 error mapping.
14. Draft identity: sessions created by the first send inherit the draft's
    context; persisted restore pointer is not cleared (programmatic fallback).

**Send error mapping** `(src: ChatInput.tsx:1874-1926)`
- payload too large / 413 → toast "Attachments are too large to send…",
  restore attachments.
- soft network errors (timeout/network/gateway/being processed) → restore,
  optional toast when attachments existed.
- "runtime changed" → toast "Message failed to send. Attachments restored."
- otherwise raw error text or "Message failed to send. Attachments restored."

### B.10 Queue (sender-side) semantics

`(src: stores/messageQueueStore.ts)`

- Queue key = runtime + directory + session. Server-owned everywhere except
  VS Code (extension keeps it locally; auto-send hook delivers on idle).
- Queued message fields: `content` (display/edit), `text` (mentions
  pre-resolved), `agentMention`, attachments, `context` (captured chips:
  context/instruction/synthetic kinds), `sendConfig` captured at queue time,
  `createdAt`.
- Editing a queued message pops it to the composer with its attachments and
  captured context (linked PR's captured diff is final: no branch re-fetch);
  "instruction" kind is re-derived on send, never restored.
- The queue panel (chips) semantics in §A.2/D. Embedded chat columns address
  their own session's queue target.

### B.11 Abort semantics

- Stop button aborts `abortCurrentOperation(sessionId)`; in btw mode targets
  the fork. After an abort the session shows the aborted-assistant error text
  once and re-arms the working chip only after the abort record is
  acknowledged (`acknowledgeSessionAbort`) — the old "Aborted" banner is gone.
- Sending while busy uses queue/steer per settings; queueing while an
  auto-review loop runs is automatic (see §F.4).

### B.12 Slash-command error toasts

Compact: "Failed to compact session"; magic prompt failures per command
("Failed to review changes", "Failed to start feature planning", "Failed to
catch up", "Failed to start debugging", "Failed to weigh options", "Failed to
start the tour", "Failed to start Goal crafting", "Failed to start scheduled
task setup", "Failed to generate summary").

---

## C. Message rendering specification

### C.1 Timeline model (turns)

`(src: chat/hooks/useChatTimelineController.ts; lib/turns/*; MessageList.tsx)`

- Messages project into **turns**: a user message heads a turn; assistant
  messages belong by `parentID` adjacency; tool parts become activity records;
  compaction summaries (`parentID` of a compact command → assistant client
  role) and bridge assistant rows (task-tool-only) are normalized.
- Two render modes from the Chat setting **Chat render mode**:
  - `sorted` (default): per turn, completed assistant messages only; an
    Activity group renders/tool rows inside `ProgressiveGroup` anchored to
    the first assistant message; the answer text renders after the group.
  - `live`: original streaming order (assistant messages with tools inline).
- Streaming tail: the in-flight assistant message renders via the same virtual
  list as a tail row keyed/subscribed separately (`streamingTailKey`), so
  streaming updates do not re-render static rows.
- Virtualization: single list for history + tail (estimated row 320px);
  end-pinning via `maintainScrollAtEnd` while pinned; prepends keep the read
  position via `maintainVisibleContentPosition`; explicit restores re-assert
  an anchor until stable for 30 frames (cap 180).
- History pagination: loads older in pages upward; triggered by scroll
  position on desktop; explicit button on mobile in the list header; a
  Timeline dialog also offers "Load earlier".
- Scroll state machine (`useChatTimelineScroll`): pinned-at-end by default;
  user scroll up releases pin and shows ScrollToBottomButton; sending re-arms
  the anchor; programmatic follow suspends scrollbar visibility.

### C.2 Row anatomy

`ChatMessage` wraps `MessageBody`:

- **User row**: right-aligned bubble, `--chat-user-message-bg`, radius
  `--radius-xl` with `--radius-sm` bottom-right corner; max width 85%.
  Content: agent-mention chip (first text part containing `@agent`),
  text parts, context blocks, subtask card, shell command block, attachments.
  Optional collapse control (setting "long prompts collapse"): collapsed
  shows ~3 lines, expand chevron, collapse button top-right.
  - Message actions row: on hover next to the bubble (desktop); touch: one
    "More actions" button opening a bottom sheet with the same actions plus
    the timestamp. Actions: Copy message, Revert from here (subagent-hidden
    rules), Fork from here, Pin/Unpin into context.
- **Assistant row**: optional header badge (agent name + model name +
  provider logo; sticky-off default shows header only per turn's first
  assistant). Parts render in order: text → tool/activity → reasoning (if
  enabled) → error notice → files → image gallery → footer.
  - Footer (one line, container-query responsive; facts drop in order:
    time → agent → effort → (model + duration never leave)):
    model logo + name · effort (lowercase, not for default/none) · agent ·
    duration ("4.2s" / "3m 12s") · timestamp.
    Right: action buttons (hover) or "More actions" sheet on touch: Copy
    answer, Review transfer actions (review-loop sessions), Save as image,
    Read aloud (TTS, if enabled), Save as plan, Pin/Unpin into context,
    Start new session from this answer (fork), Start new multi-run from this
    answer. Below the facts line: changed-files line ("Show changed files"
    setting) — TurnChangedFilesDropdown + file pills for the turn
    (interactive on the latest turn: click opens the turn diff for that file).
- Error notice: assistant `error` renders as an info-styled callout:
  - SessionRetry → "Opencode failed to send a message. Retry attempt info:
    {detail}"
  - provider auth failure → fixed auth message (08 owns auth copy)
  - "aborted" → "The running turn was stopped before OpenCode could send the
    next message."
  - otherwise → "Opencode failed to send message with error: {detail}"

### C.3 Part catalog (component ↔ visual contract ↔ interactions)

| Part | Component | Visual contract | Interactions | Fallback |
|---|---|---|---|---|
| user text | `UserTextPart` | plain markdown-ish text inside bubble; agent mention chip w/ color dot | selection menu (below) | — |
| user context block | `UserContextPart` | secondary surface chips: comments, terminal selection, browser annotations, PR contexts; label + body preview + edit/remove | edit opens comment dialog; remove deletes chip | legacy text-sniffing for pre-metadata messages |
| user subtask | `UserSubtaskPart` | "Delegated task" card: agent, model, description, command, collapsible prompt, "Open subtask session" | expand/collapse prompt; navigate to child session | missing model → hidden |
| shell action | `UserShellActionPart` | "Shell command" block: mono command, status, Show/Hide output toggle, copy output | copy button w/ check state | — |
| assistant text | `AssistantTextPart` | markdown body (§C.5) | code copy, links (app-link confirm), file mentions, images inline (tool/simple markdown only) | — |
| reasoning | `ReasoningPart` | `ReasoningTimelineBlock`: summary line, markdown content, optional duration; justification variant shares the block | click to expand/collapse (per-block); hidden entirely when `showReasoningTraces` off; duration hidden in sorted mode | — |
| tool (expandable) | `ToolPart` | see §C.4 | expand/collapse; open dialogs | unknown tool → generic expandable row w/ fallback title (description or glob pattern) |
| tool (static group) | `ProgressiveGroup.StaticToolRow` | one-line: icon + verb + short detail | click `read` opens file in editor; `skill` opens skill source | — |
| question (in-stream) | `QuestionCard` | blocking card appended at the transcript footer (not inline in a turn) | see §F | — |
| permission (in-stream) | `PermissionCard` | blocking card appended at the transcript footer | see §F | — |
| image files | `MessageFilesDisplay` | file chips/grid under text | click → image preview overlay (shared chrome) | — |
| image gallery | `MarkdownImageGallery` | 100px thumbnails row above changed files; filename caption w/ shared image icon | lazy load; click reuses preview overlay | ≤12 unique candidates per message; workspace-external needs server-verified path grant (08) |
| placeholder | `WorkingPlaceholder` (via status row) | glass chip above composer | — | — |
| busy dots | `BusyDots` | three pulsing dots suffixing status text | — | — |
| migration marker | `MigratingPart` | compact note when parts were migrated | — | — |

Unknown/unrepresentable parts: skipped by `filterVisibleParts`; the message
still renders the rest. A message whose visible parts are empty renders only
the footer (or nothing for hidden user continuations).

### C.4 Tool cards (expandable)

Header: icon (shared per-tool icon map; unknown tools fall back to a generic `tools` icon), title (per tool: file path, command,
URL, todo summary, task summary, skill name; plugin tools may surface a native
description from metadata), description (tool description fallback incl.
glob pattern), diff stats for edit/write tools (`+a −b` from patch), duration
(live 1Hz tick while running, freeze at end, `0.1s` minimum for completed;
`MinDurationShineText` ensures ≥ some minimal read time for finished rows),
expand chevron. Rows animate a reveal wipe on first mount in the streaming
tail.

Special titles: bash shows the command; question tool hides input and uses
its own card; task tool shows child-session summary entries (distilled from
the child session state — a running Task with no `sessionId` yet renders as
waiting; never match children by heuristic). `openchamber` plugin tool hides
its broad protocol input and renders the versioned result envelope through
the neutral JSON views.

Expanded body per tool:
- bash: while running, output from `state.metadata.output` fallback until
  canonical `state.output` arrives; viewport grows to content up to 46vh then
  scrolls and follows new output until the user scrolls up; live text rendered
  unhighlighted (throttled); finalized output normalizes ANSI with a bounded
  synthetic-cell budget and renders highlighted once.
- edit/write: lazy rich diff preview (`@pierre/diffs` + Shiki stack, chunk
  loaded); `PlainDiffFallback` while chunk loads or for oversized patches
  (>256 KiB or >2000 lines → bounded plain text); `DiffViewToggle` between
  diff/preview modes; for `apply_patch` tools, per-file buttons open files in
  the editor; write previews synthesize a unified diff of the new content for
  preview only.
- others: JSON output views — Summary / Tree / Raw; view mode persisted in
  settings (per model default Summary); `JsonSummaryView` renders_cards for
  arrays or scalar summaries; diagnostics lists capped at 5 per file with
  "+n more".
- large output: dialog ("Open full output" / `ToolOutputDialog`) — shared by
  tool cards and image preview requests; lazy chunk with recovery fallback.

Lazy-body rule: expanded content mounts deferred after a user toggle (rAF
batch) so chat startup doesn't pay for large payloads; expansions already
open at mount render synchronously so the virtualizer measures true height.

### C.5 Markdown pipeline

- Pipeline: markdown core (custom renderer) → Shiki highlight via a worker
  (`markdown-shiki.worker.ts`, sanitized grammars, hang-safe timeouts) →
  sanitizer (defense in depth; script/style elements forbidden; raw HTML
  renders as inert visible text) → app-link filtering (trusted custom links
  confirm before opening — 08 owns the flow).
- Virtualized code blocks: long code blocks render in a virtualized scroller
  with copy button (state: check icon 2s).
- Images: assistant body never inlines image syntax — renders a shared image
  icon + filename (policy `assistant image-label`); tool and simple markdown
  renderers keep normal inline images. HTTP image sources ship to the
  gallery, not the body.
- Mermaid: fenced mermaid renders via `mermaidViewer` (lazy viewer); click to
  open preview overlay.
- Detached DOM cache: rendered markdown DOM is cached per message/text for
  cheap re-mounts during virtualization (with cache size hygiene).

### C.6 Text selection menu

Selecting text inside message bodies opens a portal menu near the selection:
- "Comment" (opens inline mini-editor above composer context: optional
  comment text up to ~5 lines, Attach button) → stores an inline-comment
  draft as a composer context chip.
- "Add to current chat" (plus): appends the quoted markdown to the composer.
- "By the way…" (`chat-ai-3`): opens the BTW draft prefilled with the quoted
  selection (Quote-formatted) via `requestBtwComposer`.
- "Add to notes" (booklet): distills the selection via the small model to a
  project note (or raw text if summarization fails); toasts:
  "Added selected text to notes" / "Could not summarize selection, added
  selected text to notes" / failures.
- While the comment editor owns focus, the selection is repainted with
  overlay rectangles (text-node rects only), because focus clears native
  selection. Mobile: the comment bar docks to the composer pill.
`(src: message/TextSelectionMenu.tsx; lib/messages/contextParts.ts)`

### C.7 Live activity & turn disclosure

- Live streaming phase drives presentation: phases
  `streaming` → `cooldown` (tail kill) → `completed`. Reasoning streaming
  presentation derives from phase, never from missing persisted timing.
- Activity Default "Collapsed" (setting shared with sorted mode): in live
  mode, after the turn settles (final assistant message with `finish:
  'stop'`, or an interruption), a single "Activity" header button is added
  above the turn. Its collapse hides the intermediate live rows and all
  non-text parts of the final message (the final answer and its footer stay
  visible). It never adds tool subgroups, a side line, a height cap, or an
  inner scroller — collapsible history rows keep their original order and
  their individual controls. Unsettled (still streaming) turns render open;
  the header only appears once the turn settles; the collapse transition is
  a finite 180ms height animation (reduced-motion aware) that never calls
  scroll-to-bottom and delegates end pinning to the timeline.
- Header report (exact label keys): title `chat.liveActivity.title` =
  "Activity"; categories —
  `Changed {count} file/files` (from edit/write/patch results only, with
  `+{added}` green / `−{removed}` red counts when the diff set is complete),
  `Explored codebase` (flag, not a count), `Ran {count} command(s)` (command
  calls, not shell subcommands), `Researched the web` (flag),
  `Used {count} subagent(s)` (distinct child session ids). Unknown and
  administrative tools stay inside the collapsed region with no guessed
  category. Details render inside the button only at ≥560px column width.
- Manual expansion survives later metadata updates and timeline
  virtualization within the session; collapsed history does not mount the
  hidden message bodies; initial history loads never animate the collapse;
  layout-effect replay after a Suspense hide/reveal must settle the requested
  height and retained children; failed animations settle anyway and cancelled
  animation callbacks never settle a newer target.
- Subagent rollup + file statistics rules: file statistics come exclusively
  from successful edit/write/patch tool results (never from the user
  message's working-tree `summary.diffs` alone, which lists unrelated edits
  too); unique normalized paths determine file counts; per-file entries take
  precedence over whole-call patches and the two never add together; missing
  or truncated diffs suppress the line total; write input content is never
  evidence of added lines; repeated records of one call count once.
- Sorted-mode equivalents: `sorted` render keeps its own per-turn expansion
  state and its own Activity group path (`ProgressiveGroup`, §C.7).
- The active turn stays open; intermediate-text summaries and compaction
  summaries never count as final answers; an older turn without a final
  answer collapses once a later visible turn has an assistant response.
- Sorted mode's Activity group (`ProgressiveGroup`): header "Activity" with
  collapsed preview count; shows static rows one-line per navigation tool
  (read file, skill name, grep pattern glob pattern, fetched URL, todo
  summary), grouped by tool name; expandable tool rows for everything else;
  per-turn expansion state separate from live mode.

### C.8 Timestamps, freshness, pins

- Timestamps: `time.created` (user) formatted per preference (12/24h + date
  separators policy in `timeFormat.ts`); assistant footer shows completion
  time; touch surfaces show it in the actions sheet instead.
- Freshness: `MessageFreshnessDetector` (module singleton) animates a
  user message once when it arrives within 5s of a session send; fresh
  assistant rows animate entry (FadeInOnReveal) unless streaming or settled.
- Send animation: `userSendAnimation` module arms exactly-one animation per
  send (send-time mark, consumption on first mount of the new row) so
  optimistic-vs-echo id swaps don't replay.
- Pins: context-obligatory messages stored in session metadata
  (`setContextObligatoryMessage`); pin button state on user/assistant rows
  with clipboard-free single-write; failure toast "Could not update the
  context pin". Pins list/detach in the work-status panel; draft pins
  transfer to the created session.

### C.9 Changed files (turn footer)

- File identities exclusively from successful edit/write/patch tool results;
  per-file patches take precedence over whole-call patches (never summed);
  `summary.diffs` supplies line counts (and appends snapshot-only entries
  when the turn ran subagents); as projected once the last assistant message
  finished with `stop`; write input content is NOT evidence of added lines;
  truncated/missing diffs suppress line totals rather than showing partial.
- Pills: path relative to project root, icon per file type, `+a/−b` colored;
  dropdown lists "N changed files" with per-file rows when pills overflow
  (visible limit 4).

### C.10 History loading edge rules

- Failed fetch never renders as an authoritative empty list (04 owns; UI
  shows the load-error card).
- Compaction summaries: system messages following a compact command render
  with `clientRole: 'assistant'` and a special summary body ("Compacting
  previous conversation" style family — content owner 04).
- Reverted slices: `RevertedMessageDock` sings reverted messages back to the
  composer (state module `revertedMessageDockState`).
- Shell-bridge messages (`!/shell` command run by user) render as
  `UserShellActionPart` and show in the prompt rail as `$ {command}`.

---

## D. Session list / sidebar specification

`(src: packages/ui/src/components/session/sidebar/*; sidebar/DOCUMENTATION.md)`

### D.1 Structure

```
Sidebar (desktop left rail; mobile: sheet)
├─ SidebarNav: "New session" text row (opens new-session draft)
├─ SidebarHeader toolbar (projects view):
│   left: Add project, Scheduled tasks, New multi-run (disabled when none can
│          run), Archive
│   right: Search (expands inline field), Select-sessions toggle, Display-mode
│          dropdown (equalizer icon):
│          · Sort projects: Manual | A → Z | Z → A | Newest | Recent
│          · Show projects: All | One (when project display controls shown)
│          · Group sessions: By worktree | Flat list
│          · Show recent section toggle (when Recent available; not single-project)
│          · Sticky project headers toggle
│          · Collapse all / Expand all (not single-project)
│   search field: placeholder "Search sessions...", match count ("{count}
│          match(es)"), "Esc to clear" hint; Escape closes when empty
├─ Project collection (zones):
│   - Managed Chats root (its own zone; folders inside; no worktree actions)
│   - Recent activity section (optional; toggleable; flat session list of
|     last 48h + active roots)
│   - Project zones: root header + worktree groups + session trees + folders
│   - Archived view (ArchiveView full-page: buckets per project/worktree,
│     exact-ID search rule, Restore actions)
├─ Bulk action bar (multi-select)
└─ SidebarFooter: Settings, Keyboard shortcuts, About (+Update button when available)
```

VS Code: same shell minus worktrees and managed Chats; "Recent" remains
workspace-scoped; inline archived buckets; side panel variant
("Open in Side Panel" context entry with beta badge).

### D.2 Project/worktree zone

- Zone header: project icon + label; right actions: delete worktree (trash,
  aria "Delete worktree"/"Delete {label}"), delete archived sessions in group
  (archive buckets), new-draft-in-group (aria "New draft session in {label}") —
  the +-button opens a draft targeted to that project/directory without
  navigating.
- Worktree group header: branch icon + branch label; missing-directory
  worktrees show a warning icon (title "Worktree folder is missing") and stay
  for manual move/archive; sessions remain accessible.
- Project action indicator: static `pulse` icon in status-info color on
  headers/groups and session rows whose directory has an active process
  action (terminal/commands), separate from OpenCode session busyness.
- Sticky headers: optional sticky project/group headers while scrolling.
- Empty/failed group states: "No sessions in this workspace yet.", archive
  variant "No archived sessions yet.", loading "Loading sessions…", failures:
  "Could not refresh sessions." + Retry, permission failure:
  "Folder access is required." + Grant access (desktop: native picker for the
  exact directory).

### D.3 Session row

Row content: status dot (active/idle/read state), title (fallback label
`sessions.sidebar.session.untitled` = "Untitled Session"), date label
(relative; fades on hover when actions appear), and on the right an
actions cluster.

Badges/indicators:
- Active collaboration dot + `SessionActivityDuration` (elapsed 1Hz "mm:ss"/
  "h": tinted primary when running, info when finished; aria
  "Active for {duration}" / "Last turn duration {duration}").
- Wait-pill spinner while AI rename runs or worktree move runs (same spinner
  language).
- Pinned marker (pushpin icon; aria "Pinned").
- Decision points: permission-required badge (destructive tint) only when the
  session blocks on permissions; question-pending badge w/ count
  ("Q{n pending}"); conversation-unseen count (notification badge; subtasks
  only when "notify on subtasks" enabled).
- Expansion chevron for subsessions (aria "Expand/Collapse {title}"); state
  per user-only (parent never auto-expands).
- Subsession label: children render teal-indented under parents; PR-status
  summary on sessions backed by PR tracking ("Merged", "Ready to merge",
  "PR open", "Merge conflicts", "Merge blocked", "Draft PR", "Closed";
  mergeable/fail counts).

Indicators for directory actions (see D.2). Badges fade with the hover rule
on VS Code rows (where actions reveal over the right edge) but stay
permanently visible on always-actions rows of other runtimes.

### D.4 Ordering & structure

- Global sessions cache is the complete source; directory stores only fill
  gaps. Busy/retry state comes from the live global-session-status channel —
  never from cached history.
- Lifecycle recency: `settled ↔ active` transitions re-rank roots among
  roots and children among siblings; title/share/archive/directory/parent/slug
  changes rebuild rows; `time.updated` alone never does.
- Project sort: manual (persisted order), A→Z, Z→A, Newest (date added),
  Recent.
- Sessions per project: active root sessions + later-mentioned; children in
  trees; folders render their roots; assignment of both parent+descendants
  renders only highest assigned ancestors as folder roots.
- Recent section: 48h window + immediately includes active roots.
- Group session limit: "Show more sessions" / "Show {count} more session(s)"
  / "Show fewer sessions" pagination inside big zones.

### D.5 Search

- `ses_` prefix: exact session-ID match only, case-insensitive, whitespace
  trimmed; no title/path/folder fallback; no archived; matched node keeps its
  subtree; ancestors remain as context; match count reflects exact matches.
- Normal queries: fuzzy match over existing list contents, per project zone;
  search never fetches sessions or broadens membership. ArchiveView applies
  the exact-ID rule too.

### D.6 Row context menu (right-click & ⋯) — exact inventory

Open on root session row (VS Code has slightly reduced set; labels shipped):

1. Rename — inline edit (Enter submits via keydown form, Escape cancels; IME
   safe; see 1)
2. AI rename (via `SessionAiRenameMenuItem`; eligibility loaded while menu
   open; leading spinner while pending; pending survives menu close)
3. Copy session ID (toast success/error)
4. Pin session / Unpin session
5. Share submenu:
   - Share (create share; copy URL; toast "Share link copied" success family)
   - Copy link (when shared; copied → check icon for 2s)
   - Unshare
6. Export Markdown (subs task count dialog: "Include {n} subtask(s)" track)
7. Open in Side Panel (VS Code; beta badge)
8. Open in Mini Chat Window (desktop; beta-ish surface entry)
9. Move to worktree submenu (desktop): targets = primary + linked worktrees
   (current disabled), "New worktree...", refresh state inline
   ("Refreshing targets..." / "Load failed"); moving transfers full idle
   subtree; dirty source prompts: move session only / move changes too /
   cancel; rollback on later descendant failure; on uncertain outcome the
   created worktree is KEPT and both directories refreshed (never delete an
   existing destination).
10. Run fusion (multi-run launcher entry; 12 owns)
11. Move to folder submenu (folders: list folders, "New folder…", remove from
    folder)
12. Archive / Restore / Delete (destructive: confirm dialog with descendant
    counts; skip when configured to confirm; archived bucket delete is hard
    delete)
13. (mobile) Open in editor etc.

Session in archived buckets: Restore, Delete (hard).

### D.7 Folders

- `useSessionFoldersStore` owns folders (per runtime+chats-root or project).
- Folder DnD: sessions drag onto folders (desktop mouse; touch long-press);
  bulk move; folder item row has: rename (SharedSession rename flow), delete
  (confirm; sessions within are unassigned, not deleted), expand/collapse
  with persisted state.
- Bulk actions bar when selection mode active: count + "Archive", "Delete",
  "Move to folder"; per-session checkbox rows.

### D.8 Session switcher (keyboard)

`SessionSwitcherDropdown` (Ctrl/Cmd+K w/ 14's binding): fuzzy list of
sessions across runtime w/ previews; Enter selects; used by mini chat header
and keyboard switcher.

### D.9 Session header tabs (`SessionTabsStrip`)

- Open sessions surface as header tabs (persisted order): content = title +
  close X; activate neighbors on close (fall left, else right, else open
  draft); digit-shortcut activation through `activateSessionTabByIndex`
  (renderable-only rule); adjacent cycling support.
- AI rename / move spinner states shared via `SessionAiRenameMenuItem`.

---

## E. Status / live-activity specification

### E.1 The floating status chip ("working" row)

Rendered only while `isWorking`. Glass pill anchored above the composer;
height container query; content = `WorkingPlaceholder`:

- Text assembly: when a model is known → `"{model} is {status}"` (key
  `chat.statusRow.modelStatus`); status capitalizes first letter.
- Status derivation (live parts of the active assistant message,
  `useAssistantStatus`):
  - reasoning running → "thinking"
  - edit tools running/pending (`edit`, `write`, `multiedit`, `apply_patch`)
    → "editing file" (multiedit → "editing files")
  - tool running/pending → per-tool phrases:
    read→"reading file", write→"writing file", edit→"editing file",
    multiedit→"editing files", apply_patch→"applying patch",
    bash→"running command", grep→"searching content", glob→"finding files",
    list→"listing directory", task→"delegating task", webfetch→"fetching
    URL", websearch→"searching web", codesearch→"web code search",
    todowrite→"updating todos", todoread→"reading todos",
    skill→"learning skill", question→"asking question",
    plan_enter→"switching to planning", plan_exit→"switching to building";
    unknown tool → "using {tool}"
  - streaming text (no end time) → "composing"
  - nothing specific → stable pseudo-random phrase from
    WORKING_PHRASES list keyed by message id ("working", "processing",
    "preparing", "warming up", "gears turning", "computing", "calculating",
    "analyzing", "wheels spinning", "calibrating", "synthesizing",
    "connecting dots", "inspecting logic", "weighing options").
  - `isGenericStatus` phrasing churn ignored while the current status is
    shown for its minimum 1.2s; specific statuses replace generically only
    after their window.
- Provider logo (if available) precedes the label with a theme filter.
- Waiting for permission → fixed literal "waiting for permission" and
  `aria-live=assertive` + `data-waiting`.
- Retry state overrides: "Retrying in {countdown} (attempt {n})" with a live
  countdown (500ms tick; accepts epoch s/ms or relative seconds) and busy
  dots. `(src: message/parts/WorkingPlaceholder.tsx)`
- Abort in flight suppresses the placeholder (`abortActive`).
- The chip is hidden while the user owns scroll (fades with the anchor) — the
  scroll-to-bottom pill hands off to it in the same spot.

### E.2 Session-level states (sync layer, rendered by chat)

| State | Source | UI |
|---|---|---|
| `idle` | status channel Unavailable if busy | nothing |
| `busy` | status channel | working chip + abort button |
| `retry` | status w/ `message`, `confirmedAt` | retry chip; fallback timestamp when provider gave none |
| permission question pending | scoped blocking permissions/questions | cards under transcript (§F) + stop button enabled + SessionErrorNotice suppressed while blocked |
| streaming phase | streaming store | streaming visuals (§C.7) |
| aborted | abort record | refined error text on the assistant row once; acknowledged silently |

`sessionIsWorking` derivation (chat container): no blocking requests AND
(status ∈ {busy,retry} OR last message is an unfinished assistant).
`(src: ChatContainer.tsx:875-891)`

### E.3 SessionRecapNote (idle recap)

Server-generated recap of the last reply, valid only while its
`forMessageID` is still the last assistant message. Shown only after a
1-minute quiet window on an idle session, in the same band as the status row;
fades when the reader scrolls away; label "Recap:" italic prefix. Disappears
when stale. `(src: SessionRecapSpacer.tsx; lib/sessionAssistMetadata.ts)`

### E.4 Suggested follow-up chip

Same source (`assist.suggestion`), panel above composer (desktop) or top row
of mobile composer. Click = FILL composer (never auto-send); X = delete via
metadata patch (dismissed everywhere). Tooltip "Use suggested message";
dismiss aria "Dismiss suggestion".

### E.5 Auto-review banner

While an auto-review loop runs for the session: banner above the composer
with spinner, "Code review loop is running" + BusyDots, status label
"Waiting for reviewer" / "Waiting for implementer", buttons "Open" (opens
review-session chat panel read-only) and "Stop".

---

## F. Question & permission UX flows

### F.1 Placement

Both render in the transcript footer area (after the last message, before the
tail spacer), scoped to the current session and its descendant subagent
sessions (`useScopedBlockingPermissions`/`Questions`). When present, working
status shows `isWaitingForPermission`, the abort button is enabled, and the
composer may queue. Subagent-origin cards get a "From subagent" badge.

If a question tool ran in the current turn but no question request exists
(reconnect race), the chat automatically recovers pending questions with
retry (`recoverPendingQuestionWithRetry`).

### F.2 Permission card

`(src: PermissionCard.tsx)`

- Header: warning icon + "Permission Required" + tool icon + display tool
  name; "From subagent" when nested; one card owns keyboard (newest wins;
  global stack).
- Body per tool:
  - bash: working directory, timeout (ms), description; highlighted
    pre-wrap bash command.
  - edit: "⚠️ Replace All Occurrences" note when requested; diff preview
    (max 60vh overlay) of `changes`/`diff` metadata.
  - write: WritePreview of content (path label).
  - webfetch: method chip + URL; headers JSON; body JSON/text; timeout/format
    line.
  - other: description; "Action:" generic content; or full metadata JSON when
    nothing else; "Patterns:" chip line (`patterns` visible list).
- Actions: Allow once / Always allow / Deny (destructive), plus keyboard:
  Alt+Enter = once, Alt+Shift+Enter = always, Alt+Backspace = reject (newest
  card only; capture-phase listener).
- Response → `respondToPermission`; card disappears (also instantly when
  sends deny from composer submit per §B.9 step 4).
- Session auto-accept on = composer shield toggle; when on, the harness may
  skip requests; the card never renders then.

### F.3 Question card

`(src: QuestionCard.tsx)`

- Supports multiple questions in one request: tab strip "Q1..Qn" named by
  header text (fallback `Question {index}`), plus "Summary" tab when >1.
- Per question: header (bold), optional markdown body, options list
  (single-select radio; `multiple:true` → checkboxes), "recommended" marker
  option styling, "Other…" free-text choice: textarea (auto-height,
  2 rows min, becomes scrollable at max ~5 lines; min height constant).
- Validation: every question answered (or custom text non-empty). "Next"
  jumps to the next unanswered (wraps); Enter (no Shift, Ctrl+Enter on
  mobile) submits when complete, else jumps.
- Footer buttons: "Submit" (primary), "Dismiss" (secondary), overflow: "Copy
  as Markdown", "Copy as JSON" (serializers; toasts "Question copied as
  Markdown/JSON" or "Failed to copy question").
- Submit disabled until complete; submit → `respondToQuestion(sessionId,
  id, answers: string[][])` (custom answers as single-element arrays);
  stale-request error → toast "This question is no longer waiting for a
  response." and marks reacted; transmit errors → "Failed to send response"
  w/ "Please try again in a moment."
- Multiple concurrent questions for one session: cards stack; each card
  independent; each has its own sessionID (a subagent's question shows on the
  parent's chat with "From subagent").
- Dismiss = reject: unblocks the agent with no answer (tool result empty),
  does NOT end the turn.

### F.4 Send-while-blocked semantics (restated as a rule)

Sending (or queueing) with blocked requests is authoritative: deny
permissions, dismiss questions, queue the message for delivery after the
turn settles. Auto-review loops: while `autoReview` runs, submits are
routed to the queue explicitly.

---

## G. Usage / quota / limits UI

Two readout families share one grouping hook `useUsageProviderGroups`
(`components/usage/usageGroups.ts`):

- Providers listed: quota providers from the harness (`QUOTA_PROVIDERS`
  registry with id/name/limits) that are included in the dropdown selection
  AND configured; unclear-first-load failures stay with stale-data labels.
- Rows per provider: window rows ("5-hour window", "weekly window",
  "monthly window" — labels via `formatWindowLabel`) with `valueLabel`,
  `usedPercent`/`remainingPercent`, `resetAt`/`resetAfterFormatted`; then
  model-scoped rows (visible when the provider has none of the selected
  models filtered, first window each).
- Provider-level status text: refresh error (stale suffix) / error string /
  "No rate limits reported" (key `header.services.noRateLimitsReported`).
- Display mode: "used" vs "remaining" (setting, shared w/ settings page).

Surfaces:

1. **Work-status Usage section**: provider rows with logo; each window row
   `label – reset countdown  value`; tone thresholds on percent (≥80% error,
   ≥50% warning); refresh button (spinner while loading; aria
   "Refresh usage"); collapsed headline = shortest window of the provider
   the composer targets (alias table openai/chatgpt→codex, anthropic→claude,
   gemini→google; skip model rows while provider rows exist; window-less
   rows last resort; **no match → mode label, never another provider's
   number**). Data rules: first load gated by instance; `ensureLoadedForRuntime`
   owns read bookkeeping; shared fixed 3-minute refresh timer; explicit
   refresh; reset-in-flight wait; readiness before configured reporting.
2. **Work-status collapsed Usage headline** (see above) — key contract,
   tested by `usageHeadline.test.ts`.
3. **Mobile usage popover** (`UsageProviderCards`): compact cards — filled
   bars, provider name header, rows `subtitle · label` right value, monospace
   tabular numbers; same grouping.
4. **Settings → Usage page** (cross-ref 14): full quota management
   (credentials, provider selection, display mode, model filters); the chat's
   readouts link out to it from the header usage dropdown.
5. **Cost**: per-message token/cost display comes from message records
   (`tokens.total`, `cost`); the ModelControls tooltip shows model cost
   per million (input/output/cache read/write) and limits (context/output
   tokens), knowledge-cutoff and release date. There is no cost-only fallback
   row in the work-status Context row.

Context usage (session): context panel & header readouts compute from the
latest reporting assistant message tokens vs the model context limit
(unrounded percentage; store-default limit fallback when the model exposes
none) — mechanism in `work-status/contextUsage.ts` (cited; owner 04 for the
store getters' pitfalls).

---

## H. Command palette, input history, snippets, magic prompts

### H.1 Slash-command dictionary (session-local)

Planned before send (§B.9):
- Action: `/undo`, `/redo`, `/timeline`, `/handoff-review` (desktop only),
  `/compact`.
- Prompt (magic prompts): `/summary`, `/workspace-review`, `/plan-feature`,
  `/craft-goal`, `/schedule-task`, `/catch-up`, `/debug`, `/weigh`,
  `/explore`; `/btw` (composer transition).
- Registry-covered commands from the harness config; skills from
  directory-scoped skills.

### H.2 Magic prompts UI entries

`(src: lib/magicPrompts.ts; stores/useMagicPromptsStore.ts; settings section 14)`

- Stored prompts with `visiblePrompt` + `instructionsPrompt` (+ variables
  `{topic}`/`{idea}` built from the command argument).
- Entries in the composer command picker, draft starter chips (see below),
  and Settings → Magic Prompts page (14 owns editing UI).
- Rendering: templates render with argument substitution; the VISIBle text is
  sent as the message body; instructions go as an extra synthetic part.

### H.3 Snippets

- Plain text snippets with names + aliases; `#name` tokens insert an
  autocomplete selection into the composition (`#trigger `) which expands on
  send (`expandText` across primary + parts). Settings → Snippets (14).

### H.4 Input history

`(src: stores/useInputHistoryStore.ts; lib/inputHistoryScope.ts;
composer/inputHistory.ts; composer/state/useMessageHistory.ts)`

- Two buckets per runtime: global and `(runtime, directory, session)`;
  setting scope: 'session' (default) | 'global'; limit default 40
  (1–100). Entries store text + attachments + timestamp.
- Recall (ArrowUp from start-of-line/empty; ArrowDown from end) reads the
  session bucket (session scope also merges visible-transcript user prompts,
  oldest first; a prompt in both collapses to the persisted entry).
- Overlays: moving away from a recalled position stores live text+attachments
  as an overlay for that position; overlays never rewrite stored history;
  sending resets overlays.
- Caret placement: ArrowUp recall → caret to start; ArrowDown → to end;
  recalled attachments attach (non-btw).
- VS Code records the full items actually taken (server queues never do).

### H.5 Draft starters (welcome chips)

`(src: chat/useDraftStarters.ts; DraftPresetChips.tsx)`

- Two groups: global + project; each starter references a command, skill, or
  built-in; project starters can move to/from "repository config" (shared)
  via a hover badge (team icon); per-chip hover X to remove (mobile uses a
  trash drop-zone that swaps in for "+").
- Picker dialog: "+ Add a starter" with search over Built-in / Commands /
  Skills sections; empty state "Nothing to add".
- Click submits the starter: `text + (command ? ' ' : '\n') + existingDraft`
  — commands take inline args, skills take a multiline prompt form.
- DnD reorder within groups only; sensors: mouse 8px, touch 200ms long-press,
  6px tolerance.

### H.6 Command palette (global)

The global command palette (settings/shortcuts surface, 14 owns) also
exposes chat actions: new session, open session switcher, toggle focus mode,
open timeline, expand input, cycle agent, toggle work-status panel, open
multirun, scheduled tasks, archive, etc. Keyboard defaults and the palettes
live in 14; this doc lists the chat-invokable actions.

---

## I. Empty / loading / error states catalog

| Surface | State | Visual | Recovery action |
|---|---|---|---|
| ChatContainer (no session, draft closed) | none/neutral | blank background (one tick) before auto-draft opens | automatic |
| ChatContainer no session, no auto-draft | empty | `ChatEmptyState` ("OpenCode is not reachable" variant when init error; "Start a new chat") | New Session button |
| New-session draft | welcome | centered "What are we working on?" + starter chips; compact layouts show title above composer | — |
| Session loading (empty + not renderable) | hydration skeleton | 3 skeleton rows: tool lines + text lines; `data-chat-hydration-skeleton` | auto when load lands |
| Session load failure | error card | warning circle icon, "Session could not be loaded" + description ("…server may be offline…Nothing is lost; retry once it is back." / auth variant "Your session expired…") + button "Try again" (or "Log in" on auth expiry; auto-retries once after re-login) | Retry / markReauthenticating |
| Session exists, zero messages | empty spacer | (nothing; composer centered draft layout) | — |
| History load older failed | stays; retry via scroll again | — | — |
| Timeline empty | "No messages in this session yet"; search empty "No messages found"; no-text rows "[No text content]" | — | — |
| Prompt navigator | hidden until ≥2 prompts | dots rail w/ hover previews | "Load more prompts" |
| Composer without session | disabled input | placeholder "Select or create a session to start chatting" | open draft |
| BTW initializing | loading frame | spinner + "Starting btw session…" | Escape cancels |
| BTW pending | draft frame | "Ask your question" + Cancel (aria "Cancel this BTW question") | Escape/Cancel discard |
| BTW creation failed | toast "Failed to start the btw session" | — | retry submit |
| Queue panel | empty → hidden; collapsed chip shows count | "Queued messages {n}" expanded rows (drag/edit/send/remove, "(empty)" fallback, "+{count} file(s)") | — |
| Work-status per-section | each collapses when it has no rows (presence reporting) | all-hidden card keeps visible with empty state + section controls | — |
| Git status unavailable in panel | rows absent (worktree bootstrap pending suppresses fetch) | — | — |
| Session sidebar zone empty | project zone message | "No sessions in this workspace yet." | — |
| Session sidebar fetch failure | empty-with-retry | "Could not refresh sessions." + "Try again" button | retry |
| Permission-denied directory | empty+"Grant access" | "Folder access is required." | grant (desktop native picker) |
| Sidebar search no matches | zero rows, match count "0 matches" | — | Esc clears |
| Worktree missing | header warning icon | "Worktree folder is missing" | delete/move/archive still available |
| Image preview/attachment preview | lazy dialog | spinner then content; interrupted chunk auto-recover | — |
| Tool output dialog opened during load | Suspense fallback empty→ content lazy | — | — |
| Auth expired during send | toast "Your session expired…" variants (08 owns copy) | — | re-login |
| Dictation errors | overlay error text "Transcription failed" | retry / discard buttons | — |
| Mini chat with no session | draft title fallback ("New session" label) | — | — |
| Subagent read-only | banner "Subagent sessions cannot be prompted." | — | open prompting setting |

---

## J. Build checklist (component-by-component definition of done)

Order basis: contracts (0) → composer (B) → rendering (C) → sidebar (D) →
status (E) → prompts/questions (F) → usage (G) → extras (H) → states (I).

1. **Session/message/part contracts** — typed records; safe parsers for
   metadata (btw/assist/linked-issues/pins/goal); scaffold the "renderable"
   gate: a session cannot render until its message snapshot loads.
2. **ChatContainer frame** — flex row with chat column + work status column;
   composer slot with inset variable; draft/session transition; reveal gate
   (`pending→fading→none` data attributes, settle-stability loop).
3. **Virtualized timeline** — turn projection from raw records; sorted vs
   live modes; streaming tail row; end-pinning; maintain visible content
   position; history paging (scroll + button); `#message-<id>` hash
   navigation; turn anchor table.
4. **MessageBody user row** — bubble, actions (hover + sheet), collapse,
   subtask/shell/context blocks, mentions, attachments display.
5. **MessageBody assistant row** — header badges (stable sticky display
   values), part dispatch chain, footer facts row (CSS drop order), changed
   files pills/dropdown, error callouts, image gallery, tool dialog portal.
6. **Markdown pipeline** — worker-highlighted code, sanitized HTML policy,
   app-link rules, virtualized code blocks, assistant image-label policy.
7. **ToolPart** — header model (icon/title/desc/diff stats/duration), lazy
   rich diff + plain fallback, JSON summary/tree/raw views, bash live output
   semantics, question/task/todo/apply-patch specials, reveal wipe on mount.
8. **Activity grouping** — static rows, static group rows with one aggregated
   header, expandable tool rows, per-turn expansion state in both render
   modes, live activity header + categories.
9. **Composer editor** — CodeMirror integration with language tokenizer,
   trigger precedence, shell mode, auto-pairing, paste/drop/clipboard
   attachment pipeline (with citation, large-paste offer, VS Code duplicate
   suppression), selection painting rules, autocorrect flags.
10. **Composer controls** — footer inventory full (attach dropdown, focus,
    shield, goal, model/agent/effort pickers, dictation, send/queue/stop);
    mobile pill/bottom-sheet variants; narrow-width placeholder.
11. **Submit pipeline** — local command planning, queue/steer semantics,
    mention/document-mention preparation, context metadata encoding
    (comments, terminal, browser, PR, issues), response style, snippet
    expansion, btw pending fork, error restoration matrix.
12. **Queue store + panel** — keyed by runtime+directory+session;
    server/VS Code ownership; panel with DnD reorder, edit/send/remove,
    capture/restore of context, sticky collapse state per key.
13. **Draft persistence + targeting** — identity math, debounced+forced
    writes, restore modes, project/branch selectors with pending-worktree
    survival, dirty advisory.
14. **BTW** — panel state (pending/creating/active/collapsed), parent
    metadata link, boundary filtering, fork composer reuse (model adjustments
    copied once), promote/destroy flows, escape semantics.
15. **Floating panels + status row** — shared frame + clearance variable;
    working/waiting/retry chips; recap + suggestion; scroll-to-bottom pill.
16. **Work-status panel** — full contract in §E.9: sections w/ presence collapse, persistence of
    expanded/scroll/hidden sections, visibility measurements (chat-area
    width), data sourcing rules (git status not session, PR read-only, quota
    timer, turn stats computation and stop conditions), overlay mode.
17. **Session sidebar shell** — nav/header/footer controls exact;
    display-mode dropdown; search w/ exact-ID rule; bulk selection + bulk
    bar; visibility-driven suspension of background work.
18. **Project/worktree zones + session rows** — grouping modes, sorting,
    sticky headers, expansion rules, action indicators, PR status tags,
    badges, activity durations, context menus (exact inventory), AI rename
    spinner, worktree move flows incl. failure cleanup.
19. **Folders + archive** — folder CRUD/DnD/bulk move; archive buckets;
    restore; hard-delete dialogs with descendants; export Markdown dialog
    (include subtasks).
20. **Question + permission cards + flows** — scoped lists, keyboard
    ownership, subagent badges, multi-question tabs, serializers, blocked
    send semantics, auto-accept.
21. **Usage readouts** — grouping hook; work-status section + collapsed
    headline selection; mobile cards; header linkouts.
22. **Mini chat, embedded subagent chat, peek mode** — surface mode context,
    header (directory/branch/model/context), window pinning, read-only
    banner + settings sync.
23. **Input history, snippets, magic prompts, starters** — stores; recall
    UI; starter picker + DnD; `/`-command planning tests.
24. **State catalog** — implement every row of §I with exact strings.
25. **Onboarding** — chooser/local/remote/recovery screens, watcher, wizard
    copy.
26. **Dictation** — recording overlay over composer (pill↔box survival),
    placeholders, insert/insert-and-send/discard/retry actions; entry from
    footer mic and pill.

Validation gates for the port (mirroring repo rules): per-file tests for
language/submit/history/drop logic; pixie-level checks only where feasible;
hand-verified focus/IME/keyboard on real devices; never claim runtime
correctness from static checks.

---

## Annexes

### A.7 Timeline dialog (`TimelineDialog`)

`(src: packages/ui/src/components/chat/TimelineDialog.tsx; i18n keys `chat.timeline.*`)`

Opened from the composer status bar (VS Code/mobile) or command palette.
A modal listing the session's turns newest-first, one row per user prompt
with: relative time ("just now", "{count}m ago", "{count}h ago",
"{count}d ago"), the prompt text (preview from normalized display parts;
shell-marker prompts show `$ {command}` or `/shell`; synthetic non-context
prompts excluded).

- Search field ("Search messages...", placeholder) filters by full text.
- Row actions: click scrolls to the message and closes; per-row menu:
  "Revert from here" (loads reverted messages back into the composer — see
  RevertedMessageDock), "Fork from here" (creates a new session from that
  message with instructions dialog), "Previous turn" / "Latest" navigation
  arrows, "Load earlier" when history page can grow.
- Keyboard: rows focusable; Enter activates; Escape closes; sticky anchor
  keeps the highlighted row stable while the list re-measures.
- Empty states: "No messages in this session yet", "No messages found" for
  search; non-text prompts render "[No text content]".
- Help footer explains: click = scroll; undo = revert to point (message text
  will populate input); create session = fork from here.

### A.8 Prompt navigator rail

`(src: chat/components/PromptNavigatorRail.tsx; ChatContainer.tsx:539-549)`

- Right-edge vertical rail of dots for the session's user prompts.
  Shown only when ≥2 prompts, desktop, not VS Code, not expanded input,
  and the `promptNavigatorEnabled` setting is on.
- Windowing: renders a sliding window of dots anchored to the viewport's
  visible turn; "Load more prompts" entry extends the window upward when
  history pages remain; hover shows a prompt preview card (normalized user
  display parts; "Current prompt" label for the active one; no-text dots get
  "[No text content]").
- Inclusion rules: the rail lists every user turn that yields display parts —
  real typed prompts, shell markers (previewed as `$ {command}` or `/shell`),
  and context-only user turns (quotes, selections) — and excludes fully
  synthetic messages (loop continuations, plan-mode injections).
- Selecting a dot teleports (instant, never smooth) the viewport to the turn
  anchor.
  If the active turn is synthetic/filtered, the rail highlights the
  nearest preceding real prompt instead.
- Hidden while the timeline is hidden or during programmatic follow, to keep
  hover protection stable.

### B.15 Composer keyboard map (full)

`(src: ChatInput.tsx:2004-2163; keyboardPolicy.ts; hooks/useKeybind)` 

| Key | Context | Effect |
|---|---|---|
| Enter | expanded desktop mode | newline (always; send only via Ctrl/Cmd+Enter) |
| Enter | normal desktop, default unconfigured | send (Enter); Shift+Enter = newline; Ctrl/Cmd+Enter = send |
| Enter | mobile, default unconfigured | newline; Ctrl/Cmd+Enter = send (deferred-Enter modifier caveat: see §B.5) |
| Enter | after configuring "Enter to send" | send plain / newline with Shift; Ctrl/Cmd+Enter always sends |
| Ctrl/Cmd+Enter | any shared composer | send immediately (also cancels queue/steer semantics) |
| Enter/ArrowUp/ArrowDown/Tab/Esc | a picker open | picker nav (prevent/stop), Ctrl+N / Ctrl+P mapped to next/prev via dropdown-navigation |
| Escape | btw active, no dropdown open | exit btw (unsent discard / collapse fork) |
| Escape | desktop expanded editor | collapse expanded input |
| Escape | shell mode | exit shell mode |
| Backspace | shell mode, empty | exit shell mode |
| `!` | caret at 0 in normal mode | enter shell mode (consumed; also catches paste/leading-`!` via change transaction) |
| ArrowUp / ArrowDown | cursor at start (up) / end (down), no picker | message history recall (+ restored attachments, except btw) |
| ArrowUp/ArrowDown (no modifiers, no overlay/focus interference) | transcript focused (composer not) | previous / next turn scroll (`resumePastEnd = false`) |
| Ctrl/Cmd+M | global (owner 14) | open model picker |
| `cycle_agent` (Ctrl+Tab default family) | composer, no picker open | cycle agent persona forward; Shift+combo cycles backward (only when the base combo has no Shift) |
| `toggle_permission_auto_accept` | composer interactive | toggle shield |
| `expand_input` | composer | toggle focus/expanded mode |
| `voice` | global | toggle dictation (event `openchamber:dictation-toggle`) |
| Enter on goal-armed composer | goal idle (no active goal) | arms next-send objective rather than navigating (target button consumes; counter tracks length) |
| Alt+Enter / Alt+Shift+Enter / Alt+Backspace | permission card focused stack | once / always / reject (§F.2) |
| IME events | composition | bypass every interception (229 fallback for WebKit) |

Guard notes that must be ported:

- Blocking overlays suppress chat-turn keyboard handling: about dialog,
  command palette, help, image preview, multi-run launcher, session
  switcher, settings dialog.
- Text with focus in buttons/inputs/links/contenteditable/dialog roles
  never triggers transcript arrow-key navigation; port the shipped target
  selector list (`CHAT_NAVIGATION_IGNORED_TARGET_SELECTOR`: links, buttons,
  inputs, textareas, contenteditable, combobox/dialog/listbox/menu/menuitem/
  option/textbox roles, Radix popper content).
- The composer's padding-click focuses the editor BEFORE setting the
  selection (CodeMirror only reveals its drawn caret during an update).
- Attachment citation insertions wrap in inline boundaries (no gluing to
  adjacent words).

### C.11 Additional renderer contracts

**(a) `MessageFilesDisplay`** — user-attached files below exact text:
chips with file-type icon, name; image chips open the shared image preview
overlay (`ToolPopupContent.image`), non-images show an attachment preview
dialog via lazy `ToolOutputDialog`. Compact variant for user rows.

**(b) `UserSubtaskPart`** — "Delegated task" (key
`chat.messageBody.subtask.title`): card header with agent chip + model label;
description line; command line; "Show prompt"/"Hide prompt" disclosure of the
raw prompt; "Open subtask session" navigates to the child session (same
"embedded panel/mobile/VS Code navigates instead of nesting" rule as the
work-status subagent rows). Whole message hides if delegation metadata is
absent.

**(c) `QuestionMarkdown`** — question tool bodies render a markdown variant
with the SAME hardening rules as chat (inert HTML, safe links), used inside
permission/question contexts and tool expanded bodies for question tools.

**(d) Markdown image gallery** (recap of hard contracts):
- Collected only per completed assistant message; candidates from finalized
  text parts; ≤12 unique candidates; filenames captioned with the shared
  image-file icon; HTTP(S) kept as browser URL; embedded/workspace-local
  limited to 10 MiB and validated PNG/JPEG/GIF/WebP; thumbnails (100px) load
  near-viewport; server runtimes hydrate in one message-level request and
  then reuse the authenticated raw-asset route; VS Code reads through its
  workspace bridge only (temporary-directory images unsupported); gallery
  clicks reuse the existing preview overlay; workspace-external images pass
  only a server-verified path-bound grant (owner 08). Never alter chat-body
  rendering; presence of a gallery never switches state.

**(e) Diff preview** — edit/write tools: rich diff with Shiki/wasm stack in a
separate lazy chunk; `PlainDiffFallback` while loading and on parse errors;
oversized patches (>256 KiB or >2000 lines) render bounded plain text;
`DiffViewToggle` switches diff/preview rendering modes; navigation keeps the
original patch text; known hazard: a pathological template-literal grammar
can hang the diff worker pool (upstream limitation — document, don't copy).

**(f) `RevertedMessageDock`** — after a revert, the removed conversation
messages dock above the composer as a collapsed strip with restore actions
(`chat.revertIndicator.redoAria` = "Redo — restore reverted messages");
state module keyed per session.

**(g) Sticky user header** — Chat setting `stickyUserHeader` (default on):
the user message heading the active turn pins to the top of the viewport
while its assistant messages stream; the external-actions row reserves its
gap; when off, user actions render inline under the bubble.

**(h) Busy dots & shine** — `BusyDots` appends three animated dots to any
working text; `MinDurationShineText` guarantees finished tool titles render
at least a minimum read duration with a shine sweep (prevents "flash" rows).

**(i) `ToolRevealOnMount`** — streaming-tail tool rows animate a wipe reveal
on first mount; when the animation condition flips (message completion), the
wrapper element type must NOT change (unconditional wrapper rule) or the
subtree remounts and replays the wipe.

### D.10 Session switcher & header tabs

- `SessionSwitcherDropdown`: triggered from mini-chat header and the global
  Switch session shortcut (owner 14). Fuzzy-ranked list of across-runtime
  sessions with previews; Enter selection publishes `setCurrentSession`;
  closes; focus returns.
- `SessionTabsStrip` (header, 02/14 owns chrome): one tab per opened session;
  content = title (truncate) + close X; close activates a renderable
  neighbor (right neighbor preferred, else left) else opens a draft if it was
  the last tab; number-key activation through `activateSessionTabByIndex`
  counts only renderable tabs — the digit must match what the user sees.

### D.11 AI rename (`SessionAiRenameMenuItem` + `useSessionAiRenameAction`)

- Menu item label "Rename with AI" (`sessions.aiRename.action`); available in
  the row context menu, header-tab context menu, and the single-session
  header menu.
- While running: leading spinner in the row and menu column (same spinner
  shape as a worktree move); title = "Generating session title..." — the
  pending operation survives closing the menu or selecting another session.
- Eligibility: loads only while a menu is open; states: "Checking completed
  turns...", "Available after the first completed reply." ( disabled),
  "AI renaming is not available in VS Code." (VS Code hidden).
- Failure toast: "Could not rename the session. Check your Small Model
  settings and try again."
- Generation: server job posts up to the 3 most recent completed turns
  (oldest first; per-parent final answers only; skips error/summary turns;
  requires user content) to a small model with a strict title prompt
  ("Output ONLY a thread title…", ≤50 chars, echo the user's language, no
  word salad, treat conversation as source material). Output validation keeps
  a single non-empty line (think-block stripped), trims to 100 chars with
  "…" ellipsis. `(src: packages/ui/src/lib/sessionTitle.ts)`

### D.12 Pins, notifications, multi-select

- Pins: per (runtime, directory, session) pinned ids in a persisted store;
  pinned row shows a pushpin marker; unpin in context menu; pin/unpin does
  not reorder the list (pins float only in the data, ordering stays
  lifecycle-based).
- Unseen/conversation count: per session from the notification store;
  rendered as a count badge; a subagent's badge renders only when the
  "notify on subtasks" setting is enabled; reading the session clears it.
- Multi-select: header toggle or context menu ("Select sessions"); checkbox
  per row and folder; repeated clicks add; bulk bar shows "{count} selected"
  + Archive / Delete / Move to folder; exiting selection clears and closes
  the bar.
- Permission-required row state: individual rows show the destructive
  permission badge and keep session permission/question state subscriptions
  session-scoped (structural list updates must NOT resubscribe every row).

### D.13 Archive view (`ArchiveView`)

Full-page surface (sidebar Archive button, key `sessions.sidebar.nav.archive`
= "Archive"):

- Buckets per project and per archived folder; each header offers "Delete
  archived sessions" (destructive confirm) exactly for that bucket.
- Search accepts the exact-ID rule (`ses_...`), body = archived list only.
- Row actions: Restore ("Restore", toast "Restored N session(s)"), Delete
  (hard delete; confirm if deletions confirm setting asks).
- Empty state: "No archived sessions yet." per bucket.
- Non-Git note: archived sessions keep their directory binding; restoring
  re-roots under the current project list.

### E.6 Composer status bar (todos & abort chip)

`(src: packages/ui/src/components/chat/ComposerStatusBar.tsx)`

A small bar above the composer stack, promoted on VS Code and mobile
(`composerStatusExtrasEnabled = isVSCode || isMobile` — desktop carries these
readouts in the work-status panel instead):

- Todos dropdown: current harness todos (live channel, persisted fallback):
  trigger = list icon + "{done}/{total}" progress; panel rows: status
  ("In progress", "Pending", "Completed", "Cancelled"), priority icon and
  label ("High/Medium/Low priority"), text with line-through for completed;
  row colors: foreground vs muted.
- Idle aborted state: a one-click "Stop generating" ghost when an abort is
  pending acknowledgment.
- Container is a size-query context ("composer-status-bar") — restyles don't
  leak into the floating chip they used to share markup with; keep them
  separate.

### E.7 Session error notice

`(src: chat/SessionErrorNotice.tsx; en keys `chat.errorNotice.*`)`

Rendered under the last message (before tail spacer) when the session's
latest activity is an unanswered user prompt (idle >5s) or the last assistant
message failed without an inline error. It never duplicates an error already
rendered inline on the assistant row. Labels: heading "Unable to respond"
family (keys `chat.errorNotice.title/description`), link-styled "Retry"
action re-sends or nudges the harness idempotently (harness port: define
what a "nudge" means — at minimum, presenting the queued retry action).

### E.8 Mini chat status line

`(src: mini-chat/MiniChatLayout.tsx; `miniChat.*` keys)`

Below the header: session status ("Running", "Retrying", "Idle"), model name
("No model" fallback), agent name ("Default agent" fallback), directory
label (compactPath with `~/` collapse), branch label (raw, "HEAD" hidden),
pin action ("Pin above other windows" / "Unpin window"), context usage
percentage + token counts from the latest assistant message's `tokens`
(unit conversion shared with the header readout). "Open in main window"
action navigates the main app to the session; unavailable state: "Session
unavailable" / "This session could not be loaded. It may have been deleted,
archived, or opened from a different project context."

### E.9 Work-status panel (complete section contract)

`(src: work-status/DOCUMENTATION.md; WorkStatusPanel.tsx + sections.ts; work-status label keys)`

**Not a context-panel surface**: no rail icon, no tab, no persisted width, no
resizer. A floating-styled card ("glass" only when it overlays the
transcript; otherwise a lighter inline fill) inside the chat column area.
Desktop only (hidden on mobile, VS Code, mini chat). The card reads every
block from already-warm caches; it adds no aggregated endpoint.

**Visibility** (`useWorkStatusVisibility`): hidden when user-switched off,
mobile, VS Code, context panel open for the effective directory
(`useEffectiveDirectory` + normalized key — NOT the panel-reported
directory), or the row cannot fit `560px` chat + `300px` panel + `24px`
gutter (widths in code: `WORK_STATUS_MIN_CHAT_WIDTH=560`,
`WORK_STATUS_PANEL_WIDTH=300`, gutter `8+16`). The width test measures the
**chat area** (`data-chat-area`, chat + context panel container), never the
chat column — the column's width is an output of the decision and would
oscillate. `rowRef` must be a callback ref (late-attaching rows). Additional
suppression: mini-chat and desktop expanded-input mode. It stays available
over a new-session draft: draft-project/pending-worktree directories feed
the project/MCP/usage readouts; a Chat-context draft passes NO fallback
directory so an active project's branch cannot leak, and managed Chats
never render or warm the Project repository section.

When the panel cannot fit, it can still appear as an overlay inside the chat
column (toggle `workStatusOverlayOpen` from the header equalizer).

**Structure**: every readout is a labelled row (icon, name, trailing value);
rows group into named sections; sections render nothing when they have no
rows (presence reporting → the card collapses upward, and fully-empty
collapses away; exception: when the user hid every section the card stays
with a localized empty state + section controls). Separator via CSS
`:not(:first-child)`.

**Section order** (durability, not category):

1. **Session** (`chat.workStatus.section.session`): session goal row
   (status dot with the composer-button colour mapping; objective text or
   latest audit note; usage "{used}/{budget} tokens"; actions Pause/Resume →
   `setSessionGoalStatus`; row click → SessionGoalDialog via "Manage goal"),
   Context (percentage toward the model context limit; unrounded display;
   store-default-limit fallback when the model exposes none; click → opens
   the context overview), Cost ("Session {session} · Subagents
   {subagents}"; rides along only with a context percentage; never a
   cost-only row).
2. **Project** (`...section.project`): attention row (git operation in
   progress: "Merge/Rebase/Cherry-pick/Revert/Bisect in progress"), Branch
   (with ahead/behind; click → git surface), Changes ("{count} file(s)
   changed"; from git status, NOT session summaries; suppressed while a
   worktree bootstrap is pending; click → working-tree diff), Pull request
   + Checks ("Draft", "Checks: {count} failed/running/passed"; read-only,
   follows the freshest remote-keyed PR entry; click → PR surface).
3. **Usage** (`...section.usage`): see §G.1; collapsed headline = shortest
   window of the composer's provider; explicit refresh button.
4. **Turn stats** (`...section.telemetry`): response speed (header-only
   headline; computed from the final assistant message's output tokens over
   union of nonempty text intervals; never falls back to whole-turn speed),
   Whole turn, Model time, Tool time, Average TTFT, Steps, Tokens ("{input}
   ↑ · {output} ↓" with full counts in the tooltip; input excludes cached;
   output includes reasoning across steps), Cache (hit share), Cost (per
   provider; zero may be legitimate). Computed only while expanded,
   authoritatively idle, and the session has a completed turn; one
   committed result keeps the panel stable during the next active turn;
   identity = runtime+directory+session. Each metric row is one hover/keyboard
   target for a shared 750ms-delay tooltip (portal outside the scroller)
   explaining the metric (exact descriptions in keys
   `chat.workStatus.telemetry.*Description`).
5. **Subagents** (`...section.subagents`): one row per child session: title
   ("Subagent" fallback), status phrase ("is working" / "needs permission" /
   "asked a question" / "Idle" on an explicit idle record / "No live status" when
   unknown; idle alone is not evidence of completed work), per-row cost = that child's whole subtree
   rollup; blocked rows aggregate its permission/question state; click →
   opens that child session's chat (embedded panel/mobile/VS Code navigate
   instead of nesting). The section self-opens when subagents appear where
   there were none (that edge only); the expanded list caps at 8 rows and
   scrolls independently.
6. **Tasks** (`...section.tasks`): the session's todos; icons and
   strike-through match the composer todo dropdown; completed items STAY
   (record of the session, not a queue); sorted by status (in progress →
   pending → completed) stable within rank; rows include delayed full-text
   tooltips.
7. **MCP** (`...section.mcp`): per-server rows; the toggle connects/
   disconnects (`chat.workStatus.mcp.toggle` = "Toggle {name}"); status
   doubles as button: "Sign in" (needs auth), "Failed" (reconnect).
8. **Pinned messages** (`...section.pinned`): pinned context messages; pin
   icon click unpins ("Unpin from context"/"Unpin message"); text click
   jumps the transcript to `#message-<id>` (clears the hash first so a
   repeat press works); unavailable materialized lazily ("Pinned message"),
   and the section materializes the session ONLY when a pin resolves to
   nothing.
9. **Context sources** (`...section.contextBreakdown`): linked GitHub/Linear
   threads first, then "Skills", "MCP servers", "Agent memory" counts,
   pinned notes/plans ("note", "plan", "{count} pinned"); agents and tools
   are deliberately absent (agents do work, not context; `Agent.tools` is an
   override map, not a registry).

**Actions table** (row → destination): Context → context overview; Changes →
working-tree diff (`diffScope: 'working'`); Branch → git surface; Pull
request/Checks → PR surface; Subagent → that child session (chat tab,
read-only); Goal row → goal dialog; Goal pause/resume → status set; MCP
switch/status → connect/reconnect; Pinned pin icon → unpin; Pinned text →
jump via `#message-<id>` hash.

**Connectivity-lever data rules**: MCP, usage, skills, agent memory,
Linear/GitHub logins are all owned by the connected instance; a runtime
switch drops all of them (generation-guarded stores) and the panel loads its
own (silently, through the background-network gate), keyed by
`isConnected`; usage waits for instance initialization before its first
fetch; skills load per-directory when the service is on; the repository
section subscribes to git-refresh hints and refreshes its directory's shared
Git cache itself.

**Panel state**: user preference `workStatusPanelEnabled` (header toggle) +
per-section hidden list via an equalizer-icon dialog (`workStatusExpandedSections`
persisted by section id; hidden stored refined: `workStatusHiddenSectionsExplicit`
marker + list; empty list = all enabled; UI-store v21 migration removes the
old automatic telemetry hiding unless the explicit marker exists).
`workStatusPanelVisible` (transient, NOT persisted) tells the header/Git rail
to drop the readouts the panel carries. Scroll offset persists
(`workStatusScrollTop`), reset on session change, restored at ref attach,
written once per animation frame. Collapse-on-context-panel animation:
closes at the context panel's curve/duration, slides-out+fade when switched
off, content dropped after the collapse; stays mounted wherever it could
ever show.

### H.7 Skill-mention instruction (exact string)

When the user names a skill inline (`/name`) without selecting it from the
picker, the send attaches a synthetic instruction part:

`The user explicitly mentioned these skills in their message: /name1, /name2.
Use the corresponding skill tool when it is relevant to accomplishing the
user's request.`

Matching is against the skill registry's exact casing (the name is echoed
back to the model as a skill to load). `(src: ChatInput.tsx:227-234)`

### H.8 Slash-command text handling

- Commands with arguments: OpenCode commands only when the argument follows
  on the same line; a starter chip of type `command` inserts `"text "` +
  existing draft, of type `skill` inserts `"text\n" + draft`.
- A local command is never queued as text: queueing runs it instead
  (`planLocalSlashCommand(..., queuedHint=true)`).
- Prompt-command failures restore everything consumed: text, confirmed
  mentions, files, comment drafts, and pending synthetic context.
- Unknown `/token`: stays plain prose (registry membership is authority).

### K. Consolidated label index (chat-adjacent strings)

Quick index `key → English` for the labels named above (en catalog):

| Key | English |
|---|---|
| `chat.liveActivity.title` | Activity |
| `chat.liveActivity.changedFile/Files` | Changed {count} file(s) |
| `chat.liveActivity.explored` | Explored codebase |
| `chat.liveActivity.researched` | Researched the web |
| `chat.liveActivity.ranCommand(s)` | Ran {count} command(s) |
| `chat.liveActivity.usedSubagent(s)` | Used {count} subagent(s) |
| `chat.statusRow.modelStatus` | {model} is {status} |
| `chat.statusRow.tasksTitle` | Tasks |
| `chat.statusRow.summary.activeLeft` | {active} active · {left} left |
| `chat.toolPart.awaitingResponse` | Awaiting response... |
| `chat.toolPart.noOutputProduced` | No output produced |
| `chat.toolPart.output` / `error` | Output / Error: |
| `chat.toolPart.showRawJson` / `showFormattedJson` | Show raw JSON / Show formatted JSON |
| `chat.toolPart.lspErrors` / `moreErrors` | LSP errors / +{count} more errors |
| `chat.recap.label` / `.aria` | Recap: / Session recap |
| `chat.suggestion.applyAria` / `.dismissAria` | Use suggested message / Dismiss suggestion |
| `chat.timeline.title` | Conversation Timeline |
| `chat.timeline.description` | Navigate to any point in the conversation or fork a new session |
| `chat.timeline.actions.*` | Actions / Revert from here / Fork from here / Previous turn / Latest |
| `chat.timeline.relative.*` | just now / {count}m ago / {count}h ago / {count}d ago |
| `chat.timeline.noTextContent` | [No text content] |
| `chat.queuedMessage.*` | Queued messages / +{count} file(s) / (empty) / edit / send / Remove from queue / Drag to reorder |
| `chat.queuedMessage.toast.*` | Couldn't queue the message. It's back in the composer. / Couldn't load the queued message. Please try again. |
| `chat.btw.*` | btw session / Ask in this btw session… / Starting btw session… / Working… / Ask your question / Cancel this BTW question / Collapse/Expand/Destroy/Keep as a separate session (panel actions) / Failed to {create|destroy|keep} the btw session |
| `chat.goal.status.*` | Active / Evaluating… / Paused / Blocked / Budget reached / Complete |
| `chat.goal.action.*` | Pause / Resume / Mark complete / Remove goal / Cancel / Save goal / Start goal |
| `chat.goal.usage.*` | {used} tokens / {used}/{budget} tokens / {turns} continuations |
| `chat.goal.button.*` | Set a session goal / Manage session goal / Start a goal with the next message / Goal armed — tap to disarm / Goal running — tap to cancel it |
| `chat.goal.counter.aria` | Goal objective length limit |
| `chat.goal.cancelDialog.*` | Cancel this goal? / The agent will stop working toward this goal automatically. / Keep goal / Cancel goal |
| `chat.changedFiles.title` / `.actions.*` | Changed files / Open {path} / Show more ({count}) / Collapse |
| `chat.promptNavigator.*` | Prompt navigation / Current prompt / Load more prompts |
| `chat.revertIndicator.redoAria` | Redo — restore reverted messages |
| `chat.history.loadOlder` | Load older messages |
| `chat.emptyState.*` | OpenCode is not reachable / Start a new chat / What are we working on? / What are we working on in {project}? |
| `chat.container.returnToParent.*` | Return to parent session / Return to: {title} / label "Parent" |
| `chat.container.sessionLoadError.*` | Session could not be loaded / (offline description) / (auth description) / Try again |
| `chat.autoReview.*` | Code review loop is running / Waiting for reviewer / Waiting for implementer / Review session / Open / Stop |
| `chat.draftStarters.*` | Add a starter / Search commands and skills… / Nothing to add / Built-in / Commands / Skills / Remove / Remove / sharedTitle; share/makePersonal |
| `sessions.aiRename.*` | Rename with AI / Generating session title... / Checking completed turns... / Available after the first completed reply. / (failure toast) / (unsupported in VS Code) |
| `sessions.sidebar.session.untitled` | Untitled Session |
| `sessions.sidebar.bulkActions.*` | Archive / Delete / {count} selected / Move to folder / Archived {count} session(s) / Failed to archive {count} /
Restored/Deleted variants |
| `sessions.sidebar.session.menu.*` | Rename / Copy session ID / Pin/Unpin session / Share / Copied / Copy link / Unshare / Export Markdown / Move to worktree / New worktree... / Run fusion / Open in Side Panel (beta) / Open in Mini Chat Window / Session menu |
| `sessions.sidebar.header.*` | New session / Add project / Scheduled tasks / New multi-run / Archive / Search sessions / Select sessions / Exit selection / Sort projects (Manual, A → Z, Z → A, Newest, Recent) / Display mode / All projects / One project / By worktree / Flat list / Show recent section / Sticky project headers / Collapse all / Expand all / {count} match(es) / Esc to clear / Search sessions... |
| `sessions.sidebar.group.*` | (empty/archive/retry strings quoted in §D.2; PR statuses in §D.3) |
| `sessions.sidebar.session.status.*` | Pinned session / Permission required / 1 pending question / Session active / Unread updates / Active for {duration} / Last turn {duration} / Moving to worktree |
| `miniChat.*` | New session / Session / Default agent / No model / Running / Retrying / Idle / Pin above other windows / Unpin window / Open in main window / Session unavailable / (unavailable description) |
| `chat.dictation.*` | Start dictation / Dictation / Downloading speech model… {percent} / Listening... / Transcribing... / Transcription failed / Discard dictation / Insert transcript / Insert and send / Retry transcription / Discard recording |
| `chat.workStatus.*` | Work status / Session / Project / Subagents / Tasks / MCP / Pinned messages / Usage / Turn stats / Context sources / Merge-Rebase-Cherry-pick-Revert-Bisect in progress / {count} file(s) changed / Untitled pull request / Draft / Checks / {count} failed-running-passed / Done / Subagent / is working / needs permission / asked a question / Skills / note / plan / Agent memory / MCP servers / {count} pinned / Sign in / Failed / Toggle {name} / Open changes-Git panel-pull request-{name} / Manage goal / Pause / Resume / Unpin message / Pinned message |
| `chat.workStatus.telemetry.*` | Response / Whole turn / Model time / Tool time / Average TTFT / Steps / Tokens / Cache / Cost (+ full-row description strings, ended-`Description` keys) / {input} ↑ · {output} ↓ |
| `chat.textSelection.*` | Add to input / Comment / By the way… / Open a BTW draft with the selection / Comment on selection / Add an optional comment... / Attach / Add to notes / Add to current chat / Save selected text to notes / (toasts) |
| `chat.questionCard.*` | Summary / (no answer) / Input needed / From subagent / Question {index} / Select multiple / recommended / Other… / Your answer / Submit / Next / Dismiss / Copy as Markdown / Copy as JSON / copied / failed / no longer pending / try again |
| `chat.permissionCard.*` | Permission Required / From subagent / Patterns: / Working Directory: / Timeout: / Request: / Headers: / Body: / Action: / Details: |
| `header.services.*` (usage) | Remaining / Used / No rate limits reported / refresh failed (stale) |

`(src: packages/ui/src/lib/i18n/messages/en.ts)`

---

## Harness ports (OpenCode-dependent concepts)

Every item below names the concept and what the port must decide instead.

| # | Concept | Where used | Port guidance |
|---|---|---|---|
| 1 | `provider/providerID`, `model/modelID` + metadata (`modalities`, `limit.context/output`, `cost`, `knowledge`, `release_date`, `variants`) | ModelControls picker, message footers, attachment modality warning, context usage %, effort/thinking | Substitute your own registry; keep three layers: provider → models → variants. Display names via provider+model name; marquee truncation UX is surfaces-level. |
| 2 | Agent (persona) concept: `mode: primary|subagent|all`, description, model config, permission ruleset, temperature/topP | Agent pickers, cycle-agent shortcut, badge coloring, permission summaries in tooltips | Model as persona palette of your harness; keep only primary personas selectable; subagents exist as child sessions (task tool). |
| 3 | Tool taxonomy + per-tool presentation (read/write/edit/bash/grep/glob/task/question/webfetch/todos…) | ToolPart, activity groups, status chip phrases, permission card body | Define your tool catalog; the UI needs: status labels per tool (or a fallback "using {tool}"), navigation tools (file read/skill), edit/write diffs, bash output streaming, task child-session projection, question tool. |
| 4 | Part model (text/reasoning/tool/file/step/subtask) | Everything in §C | Own catalog; keep the rendering roles (§0.3) and synthetic-part instruction channel. |
| 5 | Message finish reasons (`stop`, aborted, retry) | Turn collapse boundaries, error callouts, "final answer" detection for live activity | Map your terminal reasons: the UI needs a "final answer" signal distinct from tool-call-only ends. |
| 6 | Permission + question requests (metadata payloads per tool) | §F | Define request shapes per action kind; the UI contract is: id, session, tool, metadata(incl. diff/content/url/patterns), respond/reject. |
| 7 | Session metadata PATCH channel | pins, linked issues, btw links, assist payload, goals | Provide a versioned metadata namespace + optimistic patch endpoint. |
| 8 | Directory/project/worktree model | sidebar zones, composer draft target, mini chat labels | Projects = root paths; worktrees = alternate directories of a project; sessions are bound to a directory. |
| 9 | Quota providers (coded names codex/claude/google + window labels) | §G usage | Your plan/quota sources; keep the (provider, window{valueLabel,usedPercent,remainingPercent,resetAt}) shape and the alias-free matching rule by provider id. |
| 10 | Skills/commands registries (directory-scoped) | composer pickers, slash handling, starters | Registry membership must be authority for highlighting; scoping by directory is a display rule. |
| 11 | `summary`/compaction machinery | compaction generations, `/compact`, session summarize | A `finish=summary`-ish flow; the UI only needs "this message is a compaction summary" + quote boundaries. |
| 12 | Share links, export, revert/fork primitives | §D.6 actions | Reimplement: share URL create/destroy, markdown export, message-level revert + fork-with-instructions. |
| 13 | Session events (created/updated/compacted, git refresh hints, worktree-changed) | live updates of list/panel | Any event stream with those semantics; 04 owns the transport; the UI needs the observable state (04's doc). |
| 14 | Small-model helpers (title generation, selection distillation, assist recap/suggestion) | AI rename, add-to-notes, recap/suggestion | Any capable side model; provide server-side job shape (assist watchers) or client fallback. |
| 15 | Tokens/cost accounting per message | footers, context readout, work status | Keep per-message token breakdown fields; missing values must hide rows (never zero). |

*(End. Suite doc: 02 payloads, 04 state, 06 files/diffs, 08 auth/trust,
11 mobile, 12 multi-run/goals/scheduled, 14 theme/settings/shortcuts,
15 MCP.)*
