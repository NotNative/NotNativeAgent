# P10 knowledge/context build notes

## P10-1: storage boundary (2026-09-26)

`GET /api/project-context/:projectId` and `PUT .../todos` now use
`projects/<projectId>/context.json`, while general project settings and
scheduled-task metadata remain in `projects/<projectId>.json`. The todo writer
uses an atomic temporary-file rename and the same project lock as config and
scheduled-task writers. Missing context is empty; malformed context is an
error and is never replaced with an empty document.

When the new context file is absent, the read path accepts legacy `notes`,
`projectNotes`, `todos`, `projectTodos`, and `plans` values in the config file.
It keeps the old file intact and seeds the new file on the first todo write.
Ambiguous aliases or a nonempty `projectPlanFiles` list fail closed to avoid
hiding content. This is intentionally less than the full D.5 migration in
planning document 15: plan-file copy-in, removal of legacy keys after a
durable migration, and convergence across multiple processes are still owed.
Config PUT preserves these legacy keys before seeding and rejects attempted
changes through the wrong route. Once a valid context file exists, config PUT
can remove its now-redundant legacy keys.

The shared config-lock queue now consumes rejected bookkeeping outcomes; the
actual rejected operation still reaches its caller. A deliberate malformed
context test exposed the previous unhandled-rejection behavior.

## Remaining P10 slices

- Finish legacy plan-file migration and durable legacy-key cleanup.
- Add notes and plan CRUD, safe markdown file ownership, shared plans, and
  attachment lifecycle.
- Bind the UI context tabs and project todos to this canonical store; add
  chat-owner/worktree resolution and memory/skills/MCP surfaces.

Do not label P10 complete until the planning document's contracts and
failure paths are covered by tests and UI verification.

## P10-2: note lifecycle API (2026-09-26)

The isolated context store now has note create, patch, and delete operations
under its write lock. The routes accept bounded JSON, reject blank bodies,
limit note bodies to 3000 characters and projects to 200 notes, and return
404 for absent note IDs. Creation records source, optional message origin,
and timestamps; patch accepts only body and legacy pinned fields. Each
successful mutation commits one atomic context file update. The notes UI
and session attachment behavior are not yet connected.

## P10-3: transitional context notes panel (2026-09-26)

The operator rail now offers a separate Context tab when its directory
resolves to an NNA project in the live global project roster. The longest
worktree-path match wins with a path-segment boundary; invalid IDs are not
sent to the context route. The tab reads and mutates notes through the NND
context HTTP API, adopts committed server responses, keeps local drafts on
failure and project switches, and retains the last loaded snapshot when a
refresh fails. Stale refreshes cannot overwrite committed mutations; bad
stored note rows surface a warning instead of silently disappearing.

The existing General notes and Todos tabs still use their repo-local files.
This additive presentation deliberately avoids hiding those files before a
safe migration and unified owner resolver are built. Chats ownership,
external worktrees not represented in the roster, session pinning, and a
full note/todo/plan panel remain follow-ups. Symlink/junction aliases are
not canonicalized in the browser: an unresolved or ambiguous owner hides
the Context tab rather than guessing a project.

## P10-4: personal plan lifecycle backend (2026-09-26)

Personal plans now use markdown files under the context-owned `plans/`
directory, addressed through a validated manifest ID and base filename.
Create writes the markdown before the manifest; delete removes the manifest
before the file; update writes raw markdown verbatim through a temporary file
and refuses to recreate a missing target. The read route returns parsed title
and body plus raw source. Ambiguous IDs/case-folded filenames, multiline
titles, and linked plan paths fail closed. The general project config file
is not modified. A local actor swapping filesystem entries concurrently can
still race path-based checks; the data directory should remain owner-private.

This is personal-plan CRUD only. Team shared plans, share/unshare, session
attachments, and a canonical plan UI remain unimplemented.

## P10-5: bounded legacy plan-link migration (2026-09-26)

When `context.json` is absent, legacy `projectPlanFiles` records shaped as
`{ id, path, createdAt? }` are migrated under the shared config lock. Existing
markdown under the NND projects data root is copied into the current plan
directory with a deterministic base filename, then the context file is
atomically committed. Only after that commit are legacy context keys removed
from project config. Missing markdown links are dropped; malformed or
out-of-store links fail visibly without a context commit. Repeated reads
converge on the new file; context mutations use the same unlocked-in-lock
read path to avoid deadlock.

This is narrower than OpenChamber's arbitrary absolute-path copy-in: NND
does not let a client-controlled legacy config link become a read capability
for unrelated local files. Recovery of links outside NND's projects data root
requires an explicit future import flow.

## P10-6: additive saved-plans panel (2026-09-26)

The operator rail's Notes surface now exposes a separate Saved plans tab for
a resolved NNA project. It lists the context manifest, opens plan markdown by
ID, and offers create, raw edit, and delete through the NND context API.
It remains separate from the existing session PlanView and retains per-project
editor drafts across project switches; neither old plan files nor session
plans are implicitly replaced. Shared plans and an integrated PlanView
adapter are follow-ups.

Adversarial review added discard confirmation for dirty markdown when opening
another plan or closing the editor, and confirmation before deletion. Pending
responses are fenced to the mounted project editor. A raw markdown save updates
the manifest title as well as the file, so the list reflects heading edits.

## P10-7: additive project-context todos panel (2026-09-26)

The operator rail now offers Project todos for resolved NNA projects, alongside
the older repo-local Todos tab and separate from NNA session tasks. It loads the
context store and adopts the committed response after add, toggle, and delete.
Failed writes preserve the last saved list and the new-item draft; drafts are
retained per project across switches. Malformed stored entries disable editing
instead of being silently omitted from a whole-list replacement. The public
PUT route rejects malformed and duplicate IDs, blank or overlong text, invalid
flags/timestamps, lists over 500 items, and bodies over 256 KiB before changing
the context file. Adversarial review fenced stale refreshes after writes and
aligned malformed-data detection with writer constraints.

Unifying the older repo-local file and session todo-to-project capture remain
future work.

## P10-8: project-todo revision guard (2026-09-26)

The public context GET and todo PUT responses carry a SHA-256 revision of the
current todo list. Whole-list PUT now requires `expectedRevision`; the server
compares it under the project config/context write lock before committing.
A stale client gets 409 with no write. This is deliberately todo-specific:
note and plan mutations do not force a harmless todo editor conflict. The
NND rail keeps its last saved list and unsent draft on conflict, disables
editing until a successful refresh, then uses the fresh revision. Internal
store migration helpers still have an unconditional writer; the public API
does not. Legacy repo-local todos and session todo capture remain separate.

## P10-9: todo panel refresh recovery (2026-09-26)

The todo rail fences refresh responses while a write is pending. When the
operator hides and reopens the panel during that write, the eventual write
settlement also clears the superseded refresh's loading state. A successful
commit clears a refresh error that arrived during the write; its committed
response is the newer source of truth. Focused interleaving tests cover both
cases.

## P10-10: canonical Notes navigation (2026-09-26)

When the active directory resolves unambiguously to an NNA project, the Notes
rail now starts on project-owned General notes. Its primary General, Todos,
and Plans tabs use the isolated context API. The previous repo-local General
note and todo files and session PlanView are still reachable under a labelled
Workspace files disclosure; nothing is imported or deleted by opening the
rail. Legacy content is not read until its tab is opened. Without a resolved
project owner, the three old workspace-file tabs remain the fallback. This
settles the navigation default, not the outstanding safe data migration or
shared-plan contract.

## P10-11: display-only context search (2026-09-26)

A single search field on the canonical Notes rail filters project-owned note
bodies, todo text, and saved-plan titles in their respective tabs. It does
not alter the underlying lists: a filtered todo toggle still sends all
stored todos, including hidden rows. New-note and new-plan drafts survive
query changes. The query is UI-local and never included in a prompt. Plan
markdown bodies and the separate Workspace files are not searched. This is
the first query slice; cross-tab match counts, follow-to-hit navigation, and
shared load state remain to be implemented. Adversarial review removed the
search field while a legacy Workspace file tab is selected, where the query
would otherwise appear to have no effect.

## P10-12: cross-tab search snapshot (2026-09-26)

Entering a project-context query loads one context snapshot for match counts
across note bodies, todo text, and plan titles. Count buttons jump to a tab;
the tab uses its own current read and display-only filter. An explicit refresh
rebuilds counts after external edits. A failed snapshot read shows unavailable,
not zero, and the UI labels counts as a snapshot to avoid claiming they are
live. This does not yet unify section data caches or search plan markdown
bodies, memory, skills, or legacy workspace files.
Adversarial review found that malformed stored rows could otherwise appear
in a match count but be suppressed by the destination section. Count guards
now mirror those sections, including the todo editor's whole-list fail-closed
behavior.
