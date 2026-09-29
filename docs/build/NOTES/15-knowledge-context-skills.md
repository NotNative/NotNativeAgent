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
  chat-owner/worktree resolution, the agent-memory tool/session/runtime, MCP,
  and the remaining local skill roots/CRUD surfaces.

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

## P10-13: explicit workspace note/todo copy (2026-09-26)

The legacy Workspace files disclosure offers an opt-in scan of
`.opencode/nnd/general-notes.md` and `todos.json` through the existing
workspace-files API. The operator sees the note text and todo list before a
confirmation. Missing files are empty; ambiguous read errors or malformed
todos prevent submission. The server validates both inputs before a single
context-store mutation under the project lock, appends rather than replaces,
and commits atomically. Source-derived deterministic IDs make an identical
retry a no-op; a conflicting existing imported todo returns 409 rather than
silently overwriting it. The original files remain in the workspace.

This flow is intentionally bounded by the current 3,000-character note and
500-todo context limits. It does not split longer note files, migrate session
plans, remove legacy files, or automatically keep the two stores in sync.
The user must explicitly choose the project-owned copy as the active record.
Adversarial review bound the note identity to its source file, not its body:
a changed source now returns 409 rather than appending a contradictory note.
Duplicate stored note IDs also make import fail closed.

## P10-14: shared project plans (2026-09-28)

The project-context read accepts an absolute checkout scope. It validates the
checkout and either the default `.openchamber/plans` folder or the `plansDir`
named by `<repo>/.openchamber/project.json`, then appends every safe markdown
file after personal plans. A file claimed by a manifest entry is hidden from
the generic unclaimed list and remains available under its original ID with
`shared: true`. Unclaimed files use `shared:<file>`.

Share moves one project plan into the shared folder and retains its ID.
Unshare moves a claimed plan back and clear its flag; reclaiming an unclaimed
team file creates a fresh manifest ID. Collisions receive deterministic
numeric suffixes. Raw editing and deletion go directly to the shared file.
The server rejects missing checkout, missing plans folders, unsafe symlinks
or markdown names, traversal, Windows reserved names, and bodies above
512 KiB. It distinguishes missing checkout/folder/files as 400/404 rather
than reporting every storage error as 500.

Internal share/unshare, edit, and delete operations share one
plans-directory lock and recheck the manifest/file inside each mutation.
This prevents an edit after a delete or transfer from recreating an orphan
file. External teams that edit the same markdown without the lock remain
outside the application's locking contract.

UI share/unshare and update requests include checkout scope and use the
matching POST/PUT methods. The Plans context keeps only results from the
latest load, and committed transfer responses replace the stale context.
Adversarial review added route mapping for checkout input errors and fixed
the share-transition client accidentally issuing GET requests that the
server had never registered.

## P10-15: local skill read discovery (2026-09-28)

NND now exposes `GET /api/config/skills` and `GET /api/config/skills/:name`.
The first slice scans only user and project `.claude/skills` and
`.agents/skills` trees. It uses the planned Claude/agents visibility flags and
scans `.agents` after `.claude` so an agents file wins a same-name dedupe.
Frontmatter is checked only in the opening YAML block, so prose later in a
skill cannot rewrite its displayed name or description.

Discovery initially stayed deliberately read-only because managed root CRUD
authority was not implemented. Listing or resolving a planned
filesystem skill also avoids avoidable directory scans when the external
flags would hide it. The route still returns the external flags with list
results. Harness SDK built-ins, supporting-file payloads, UI wiring, and
restart handling remain.

## P10-16: agent memory storage routes (2026-09-28)

Agent memory now has isolated `global` and per-project stores, one lock per
home, atomic temporary-file writes, and the C.1 read/PATCH/delete surface.
Missing files are empty while malformed stores fail. Creation dedupe accepts
an exact title or a high-confidence restatement. Full global/project stores
reject a new entry and return the stored titles, while a save under an
existing title can still consolidate the same store.

Every threat pattern runs on save, read, and update. Flag signatures are not
persisted and are never echoed in create results. Read projections are sorted
newest-first and stay within the 60/200 scope caps. Entries with invalid or
missing timestamps normalize to now or their valid `createdAt`, so a corrupt
field cannot survive into `null` on the next round trip.

The HTTP routes are dual-gated by the runtime availability flag and web
setting. Combined-scope reads flag global/project failures separately.
Unknown updates are 404, validation is 400, and storage failures are 500.
Panel memory UI, scope resolution from a directory, the managed memory tool,
session-index delivery, and change notifications remain.

## P10-17: memory ownership and panel surface (2026-09-28)

Memory stores now have explicit ownership metadata. A storage owner can be
passed directly for tool callbacks or derived from a session directory. The
mapper favors a configured project path (exact or contained), then the managed
chats root, and otherwise names an unregistered path by its canonical-path
digest. It does not make unregistered worktrees inherit a primary repository
store. Custom path-truth callbacks are rejected so paths cannot change relative
containment by a truthiness seam.

The Context rail adds a Memory tab over both scopes. The server owns reads,
edits, deletion, and missing-entry responses; the panel separates project and
global lists, flags unavailable scopes, keeps a failed draft, refreshes with a
state revision, and has no agent-owned create route. Server edits now announce
`notnative:agent-memory-changed`; the panel maps global and same-project
notifications to its revision refresh.

A private `/api/agent-tool/callback` now dispatches the four memory actions.
It accepts flattened or explicit `parameters`, maps legacy action aliases,
rejects on missing callback credentials, and resolves the context directory
through the canonical ownership mapper. Results use the planned tool shape:
summaries never repeat bodies, only `memory.read` returns a body, and
`sessionMemoryContent` projects safe title index lines for both scopes while
omitting a failed scope. The NNA plugin launch and session-knowledge route
remain separate integration steps.

## P10-18: memory prompt delivery (2026-09-28)

Server-owned prompt senders now share one agent-memory knowledge provider.
The queued, scheduled, and dispatched session paths resolve a canonical
owner from the target directory, deliver only the safe title index, and
record that exact signature after a send is accepted. A blank or already
delivered index carries no synthetic part; send failures do not record
delivery, so memory is carried again. Project list reads are bounded to
eight seconds rather than stalling prompt dispatch.

The provider subscribes to memory-change events and clears delivered
signatures, so the next send refreshes the title index. This is the
`sessionMemoryContent` delivery seam only: harness-side `openchamber_memory`
plugin injection and the broader pinned note/plan session-knowledge routes
remain pending.

## P10-19: memory callback launch contract (2026-09-28)

NND now gives a managed NNA child the private memory callback contract
through two server-only environment values. The callback URL must be an
exact loopback path, the bearer token must be forwardable, inherited values
are cleared, and a fresh token is generated only when memory is enabled at
managed boot. Attach mode receives no launch secret; externally owned
processes do not inherit NND authority.

The NND callback remains Bearer-token protected. NNA `20260928-9` consumes the
contract through `openchamber_memory`, validates its schema and callback URL,
bounds requests and replies, maps terminal status errors, and carries only the
current workspace as ownership context. The tool is registered only for root
NND engines, so delegated engines receive neither the callback nor extended
authority. Skills/MCP integration remains pending.

## P10-21: bounded ancestor skill discovery (2026-09-28)

`scanLocalSkills` now resolves the requested project through its real path,
asks bounded Git `rev-parse --show-toplevel` for the containing worktree, and
scans `.claude/skills` then `.agents/skills` at every ancestor from the
requested checkout up to that worktree root. If Git does not report a root or
the response is not contained in the canonicalized checkout tree, discovery
falls back to only the requested directory. Relative containment is checked
with normalized paths, including Windows drive-letter case differences. The
Git command is bounded to two seconds, no stderr or stdin is exposed, and the
result remains filesystem contained; there is no recursion into sibling
worktrees. User roots still run first, each root still preserves
`.claude` before `.agents`, automatic dedupe still favors the later source,
and the 200-item scan bound remains accepted. Worktree-specific skill
conflicts and managed-server cache/CRUD behavior are not part of this slice.

## P10-22: OpenCode config-root discovery (2026-09-28)

Local skills now include the OpenCode read-only roots. The absolute
`OPENCODE_CONFIG_DIR` and `~/.opencode` root are scanned at user scope;
each canonical project/worktree-ancestor root is scanned at project scope
under `.opencode`. Both the harness legacy singular `skill` and the current
plural `skills` layouts are honored, with legacy scanned first so a current
same-name definition wins the existing last-write dedupe. The OpenCode
source remains visible even when external Claude/agents skills are disabled.
The 200-item bound, ancestor containment, and read-only behavior are
unchanged. Configured extra paths, local cache roots, harness SDK built-ins,
and managed skill CRUD remain outside this bounded step.

## P10-24: configured OpenCode skills.paths (2026-09-28)

The scanner now reads `skills.paths` through bounded OpenCode JSON config
layers: `OPENCODE_CONFIG`, per-user config roots, and
`.opencode/opencode.json` at each canonical worktree ancestor. It accepts an
array of strings, expands `~/`, and scans accepted paths before project
`.claude`, `.agents`, and `.opencode` roots with `project` scope. Missing,
malformed, oversized, non-command `paths`, and drive-relative or relative
path values are ignored.

Adversarial audit added a 1 MiB regular-file read cap, deduplicated config
roots and matching paths, reused a Git worktree resolution, and validated
`XDG_CONFIG_HOME` before joining. This avoids drive-relative values such as
`C:` becoming an unintended root or consuming otherwise available scan
budget. The 200-item bound remains unchanged. SDK built-ins and skill
mutation routes remain pending after this bounded scan step.

## P10-25: managed skill create API (2026-09-28)

`POST /api/config/skills/:name` now creates only OpenCode-managed skills.
It validates the planned lowercase/hyphen name, exact request shape,
one-line 1-500 description, nonempty instruction body within 512 KiB,
`opencode` source, and user/project scope. Project scope must resolve to a
real directory; user scope writes under `OPENCODE_CONFIG_DIR/skills` or
`~/.opencode/skills`; project scope writes under
`<canonical checkout>/.opencode/skills`.

A 2 MiB request wire cap precedes JSON parsing. An existing same-name scan
or target returns 409 before mutation. Creation writes an exclusive
temporary file and commits it with a hard link, mapping `EEXIST` to 409 so
a same-name race cannot overwrite Windows targets; failed attempts remove
the temporary. Responses always return the planned deferred-restart payload.
Discovery labels both managed user and project OpenCode roots as
`renamable: true`, while cache and configured-extra roots remain external.

## P10-26: managed skill update and rename (2026-09-28)

PATCH now supports either a pure `{ renameTo }` request or bounded content
update. It resolves only a managed OpenCode skill in the exact requested
scope, validates the 2 MiB wire body, and accepts planned fields only. A
content patch replaces the opening SKILL.md through an exclusive temporary
plus unlink/hard-link publication; failures clean the temporary. Pure rename
copies content, rewrites only the `name` line in the opening frontmatter
block, publishes the new directory target by hard link, and removes the old
file only after the target exists.

Conflicts on existing names/targets return 409; missing and nonmanaged skills
return 404/403. Mixed rename/content bodies and nonabsolute project scopes
return 400. Adversarial audit fixed cross-scope mutation, regex-based
frontmatter overwrite, mixed-body confusion, and checkout validation. Update
and rename responses return the same restart deferral. Delete and
supporting-file routes remain pending.

## P10-29: skill catalog source inventory (2026-09-29)

The server now exposes an additive read-only diagnostics route,
`GET /api/skills/catalog/sources`, with the four curated source identities
from the planned catalog: Anthropic, OpenAI, Cursor, and Matt Pocock. Each
entry uses the planned `id`, `label`, `source`, and nullable
`defaultSubpath` fields, so later catalog and install code can key on stable
contract names rather than a different inventory shape. The adversarial
review corrected a missing OpenAI entry and three metadata-shape
inconsistencies before the focused regression.

This route intentionally does not claim the E.4
`/api/config/skills/catalog` contract. Enrichment, item scanning, repository
auth, conflict resolution, and installation remain pending.

## P10-30: configured custom skill source inventory (2026-09-29)

The same additive route now appends sanitized entries from the registered
`skillCatalogs` instance setting. Custom records preserve their `id`, `label`,
`source`, `subpath`, and `gitIdentityId` names; unset subpath and identity
values become `null`. HTTPS repository URLs, case-insensitive absolute Git
paths, and owner/repository references are accepted, while command-leading,
whitespace, literal, HTTPS-credential, absolute or traversal-like subpaths,
and control characters are not. Only the
first 32 valid entries are exposed; entries are deduplicated, cannot shadow a
curated ID, and malformed or corrupt settings cannot remove the curated four.

This remains source configuration only. Catalog enrichment, source scanning,
cache and identity handling, conflicts, and installation are still E.4
backlog work.

## P10-31: skill catalog contract shell (2026-09-29)

`GET /api/config/skills/catalog` now returns the planned `ok`, merged
`sources`, and empty `itemsBySource` shape. GitHub owner/repository and
HTTPS GitHub URLs receive best-effort `stars` and `repoUpdatedAt`; every other
source, timeout, non-2xx response, malformed body, and unusable field becomes
`null`. Metadata requests use APIv3, reject embedded userinfo and query/fragment
handling, run two at a time, obey a 2.5 s abort, preserve the original source
string, and cache a repository result for five minutes. Concurrent catalog
responses reuse one in-flight repository request. Encoded path joins are
rejected before decoding; a valid ISO `pushed_at` and an integer star count are
validated independently.

This is the metadata-only catalog shell. SKILL.md item scanning, persisted
scan cache, SSH identity handling, installation, and managed conflicts remain
planned E.4 work.

## P10-32: ad-hoc Git skill scanner (2026-09-29)

`POST /api/config/skills/scan` accepts bounded `{source, subpath?,
gitIdentityId?}` with an optional `directory` query and returns
`{ok, items}`. It accepts HTTPS and owner/repository sources for planned Git
scans, plus absolute local Git repositories for private source testing. Clones
are depth-one with a blob-filter fallback, `GIT_TERMINAL_PROMPT=0`, a bounded
buffer, and temporary directories removed in `finally`.

The scanner inspects only ordinary directories and regular `SKILL.md` files,
rejects symlink entries, caps files at 512 KiB and items at 200, and reads
paths after canonical containment checks. Each item reports `repoSource`,
`repoSubpath`, `skillDir`, `skillName`, `frontmatterName`, description,
warnings, `installable`, and installed skill state. Invalid directory names or
missing frontmatter remain visible but are not installable. Failures return
`authRequired` with an initially empty identity selector, `invalidSource`,
`networkError`, or `unknown`.

Git identity profiles are not yet available, so any nonempty selection is
rejected as unsupported. The scan is one-shot; no persisted result cache,
refresh key, concurrency cap, install path, conflict logic, or clone-based
source route is implemented yet.

## P10-36: skills catalog client transport (2026-09-29)

The UI now has a typed NND-origin transport for the delivered skill and
catalog APIs. Calls use the shared `runtimeFetch` path, preserve structured
server errors as `SkillApiError`, and expose auth identities plus conflict
payloads for the future dialog/store clients. Endpoints cover installed-skill
listing, merged catalog sources, configured-source scans with per-checkout
enrichment, ad-hoc scans, and installation.

URL construction encodes source IDs and checkout directories once, emits
`refresh=true` only on explicit request, and rejects source IDs containing
path, query, fragment, or control separators. Project installation requires a
nonempty directory before transport config-family coalescing. Scan and install
bodies contain only the documented fields and are serialized as JSON.

Focused transport tests pin the four endpoint forms, structured 401/409 error
payloads, project-directory guards, source-ID guards, and POST bodies. No store
or page UI is wired yet; this is the bounded client seam for that next slice.

## P10-35: selected skill catalog installer (2026-09-29)

`POST /api/config/skills/install` now installs one bounded sparse checkout per
request. The route accepts HTTPS, owner/repository, or absolute `file:` sources,
a Git-request subpath, user/project scope, and `opencode`/`agents` targets.
Body validation enforces 1-200 unique names, the documented field set, conflict
policies, and per-name conflict decisions. A project request must resolve to a
canonical checkout directory; Git identities remain intentionally unavailable
and return 400.

Conflict state is checked before cloning: selection names are checked in the
requested managed target and against other skill roots discovered in the same
scope. The route supports prompt, skip-all, overwrite-all, and per-skill
overrides for irrelevant and relevant conflicts; only true target conflicts are
skipped or overwritten. If no selections remain, the response succeeds with an
empty `installed` list. A conflict that changes after the preflight is rejected
rather than silently replaced.

Installation clones once into a unique temporary root with depth one, a
blob-filter first attempt with an unfiltered fallback, `GIT_TERMINAL_PROMPT=0`,
bounded buffers, and timeout controls. `git ls-tree` supplies the candidate
paths. Parsing is conservative: only `/`-separated repository paths whose
segments are nonempty and neither `.` nor `..` are accepted. Subpaths are
repo-relative prefixes and never interpreted as absolute paths. Every selected
name must find a matching `SKILL.md`; a sparse cone checkout captures its
skill directory, with a full checkout fallback.

Before copying, each selected directory and `SKILL.md` is re-canonicalized
inside the real repository root. Symlinks are rejected, individual files are
capped at 512 KiB, each skill is capped at 8 MiB, and frontmatter `name` must
match the selected name. Project targets are rebuilt through canonical real-path
components and must remain inside the checkout. Targets and their file tree are
bounds- and type-checked without following symlinks. Existing non-symlink
targets are deleted only after their original overwrite decision is reconfirmed.
Temporary roots are removed even on failure.

Batch installation is deliberately fail-fast: if a later skill becomes
invalid, earlier skills in the same request may remain installed, and no
cross-skill rollback is attempted. Names are resolved within the single
requested clone, so one request cannot choose among multiple candidate
repositories or install two same-name skills. A target directory was not
discoverable during preflight when it lacked a regular `SKILL.md`, but is still
refused as a changed conflict during install. The first clone with a blob filter
still permits the resource-unbounded unfiltered fallback required for local
compatibility, and Git path-list parsing stays confined and conservative.
Focused regressions now cover reachable cross-target conflicts, oversized
sources, and control-character subpaths.

## P10-34: configured source scan cache (2026-09-29)

Configured catalog scans now use a persisted 3-hour success cache. The cache
key is a SHA-256 digest of the canonicalized local/Git repository, subpath, and
Git identity, not the source label or ID. Successful scans are debounced
atomically to `NOTNATIVE_DATA_DIR/skills-catalog-cache.json`; failures are not
cached. Requests for the same key share one in-flight clone, and source scans
are globally capped at two.

The persisted payload deliberately omits per-checkout installed state. Cache
hits, including payloads restored from disk, recompute installed skills against
the current request directory, so one checkout cannot inherit stale install
ownership from another. `refresh=true` bypasses an existing cache, rescans Git
HEAD, and overwrites the same key. The cache holds at most 64 sources and 200
items per source; unreadable or malformed cache data is treated as cold.

## P10-33: configured source scan route (2026-09-29)

`GET /api/config/skills/catalog/source` accepts `sourceId`, optional
`directory`, and optional `refresh=true` only. It resolves a source from the
merged curated/custom list, passes curated `defaultSubpath` or custom
`subpath`, and reuses the bounded one-shot Git scanner. Responses provide the
selected source,
stable `sourceId`, scanned items, and installed-state enrichment.

Unknown source IDs, malformed refresh flags, and invalid references respond as
`invalidSource`; scanner auth/network failures retain their structured shapes.

## P10-28: managed skill supporting files (2026-09-29)

`GET`, `PUT`, and `DELETE /api/config/skills/:name/files/*filePath` now edit
supporting files inside managed OpenCode skills after exact name-and-scope
resolution. Request and response bodies stay within the existing 2 MiB
wire cap. Paths reject empty, dot, traversal, absolute, Windows drive,
misencoded values, and every `SKILL.md` target. Every segment from the
canonical managed root through the resolved target is checked with `lstat`,
so a nested junction cannot spill reads, writes, or deletes outside the
skill directory. This closes an adversarial review case where a link in a
deeper asset path escaped for a nested write.

Writes create missing directories only after canonicalizing and validating
the eventual parent, publish through an exclusive temporary plus hard link,
and clean failed temporaries. Successful mutations return the same
deferred-restart payload. Storage failures map EACCES/EPERM to 403,
ENOENT/ENOTDIR to 404, oversized reads to 413, and other failures to 500.
Three focused HTTP cases, including a nested-junction boundary regression,
plus web typechecks passed.

## P10-27: managed skill delete (2026-09-29)

DELETE now removes only a managed OpenCode skill after exact name-and-scope
resolution. An empty directory means user scope and every requested project
directory must be absolute; otherwise DELETE returns 400 instead of leaking
a scanner exception. A managed skill is removed with its whole directory and
the same restart-deferral response; after a successful delete the next call
is 404. Nonmanaged skills remain 403 and storage failures remain 500.

## P10-23: OpenCode cache discovery (2026-09-28)

Local skill scan now adds the specified OpenCode cache roots at user
scope after config roots and before project roots: `$XDG_CACHE_HOME
/opencode/skills`, `~/.cache/opencode/skills`, and
`~/Library/Caches/opencode/skills`. `XDG_CACHE_HOME` is tested for
absoluteness before path joining, preventing drive-relative Windows values
such as `C:` from being silently transformed into drive-root paths. Exact
duplicate cache roots are scanned once; the 200-item bound and read-only
behavior remain unchanged.
