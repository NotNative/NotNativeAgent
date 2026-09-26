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
