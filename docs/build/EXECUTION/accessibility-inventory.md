// SPDX-License-Identifier: Apache-2.0
# Accessible primitive inventory (W-99)

The complete inventory of accessible primitives the NND UI is built from,
each with its ARIA/keyboard contract and the test that pins it. These are
the primitives every surface composes; a new surface must reuse them rather
than inventing a new interaction pattern. All implemented-unverified until
the installed V-gates run with an assistive technology pass.

| Primitive | Contract | Evidence (pinned by) |
| --- | --- | --- |
| Live region (status) | `role="status"` + `aria-live` for async progress (stream attach, setup wizard busy, auth probing) | `transcript.tsx`, `completion-affordance.tsx`, `SessionAuthGate.tsx`, `AuthExpiredBanner.tsx` |
| Alert | `role="alert"` for failures (older-page load, sidebar refresh, auth expiry) | `transcript.tsx`, `session-sidebar.tsx`, tests `session-sidebar-workspaces` |
| Dialog | focus-trapped modal with labelled heading + Escape/overlay dismissal (timeline, scheduled editor, pairing, git dialogs, fusion dialog) | `timeline-dialog.tsx` (7 aria refs), `scheduled-tasks-dialog.tsx` (10), `PairingDialog.tsx`, `git-dialogs.tsx` (7) |
| Listbox / option | combobox-style selection with `aria-selected` on the owning row (command palette results, model picker, locale/theme selects) | `command-palette.tsx` + `command-palette.test.tsx` (aria-selected on `li`), `model-picker.tsx` |
| Toolbar / rail | `role`-labelled navigation regions with `data-open`/`data-suppressed` state and focus-return (operator rail, prompt rail, transcript header) | `operator-rail.tsx` (11 aria refs, keyboard reveal on viewport change — `compact-operator-layout.test.tsx`), `prompt-rail.tsx` |
| Tree | `aria-level`/expansion state with keyboard traversal (file tree, session hierarchy, worktree list) | `FileTree.tsx` (8 aria refs, `files-view.test.tsx`), `session-sidebar.tsx` (29) |
| Tabs | `role="tablist"`-style session/terminal/editor tabs with labelled close buttons and selection state | `session-tabs.tsx` (5), `TerminalView.tsx` (labelled tab close, 8 tests) |
| Toggle / checkbox | `aria-pressed` / `aria-checked` stateful buttons (context pins, review mode, execution goal) | `transcript.tsx` ContextPinButton (`aria-pressed`, pinned in `p10-session-message-pins`), `scheduled-task-execution-editor.tsx` |
| Text input | labelled inputs with described helpers; controlled values driven through native setters (composer, pairing fields, native bootstrap fields) | `composer.tsx` (`aria-label` on editor), `NativeBootstrapFields.tsx`, `scheduled-task-schedule-editor.tsx` (4) |
| Status summary | labelled data sections (`aria-label` on usage/governance panels, `data-testid` hooks for AT probing) | `work-status-panel.tsx` (8, `aria-label="Session usage"`), `operator-activity-surface.tsx` |
| Focus management | explicit focus return on dialog close, rail reveal, and session switch (no lost-focus traps) | `chat-view.tsx` (`returnToChatFocus`/`focusReturnOnOpen`), `operator-rail.tsx` reveal-and-restore (pinned by `compact-operator-layout.test.tsx`) |
| Reduced motion | `prefers-reduced-motion` forces static rendering of the celebration pulse; no other surface animates | `completion-affordance.tsx` + `completion-affordance.test.tsx` |
| Icon-only buttons | every icon-only control carries an `aria-label` (pin, close tab, annotate, capture) | `transcript.tsx`, `TerminalView.tsx`, `browser-annotation-controls.tsx` (5) |
| Skip/landmark structure | chat column, rail, and composer are stable landmarks (`data-chat-column`, `data-composer-bound`, labelled sections) | `MainLayout.tsx` (14), `chat-view.tsx` |

Keyboard contract baseline: every interactive primitive is reachable by
Tab in DOM order, activates with Enter/Space (native buttons/inputs, no
div-clicks), dialogs trap focus and return it on close, the palette and
timeline support arrow navigation (pinned by `command-palette.test.tsx` and
`timeline-search.test.tsx`), and no interaction depends on hover alone.
