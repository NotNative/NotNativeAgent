# 15 — Knowledge, Context, Skills (memory, project context, skills/MCP, obligatory context, BTW)

Part of the **NotNativeDesktop cleanroom reference**. This document specifies
OpenChamber's "institutional memory" stack: session knowledge, agent memory,
project context (notes/todos/plans), the skills system, MCP management, the
obligatory-context system, the BTW side conversation and the session assist
channel, plus snippets, draft starters, magic prompts, and the todo pipeline.

Audience: engineers and agents with **zero access to the original repository**.
Everything needed to reimplement the behavior is inline. Cites of the form
`(src: ...)` are traceability pointers only — never required reading.

Cross-references into sibling documents: **02** harness replacement + tool
injection authority (managed-tool catalog, model sizes); **03** master HTTP
route table (this doc's route tables are per-subsystem summaries; 03 is the
single authority); **04** sync/reconnect/store persistence mechanics;
**05** chat UI (composer, autocompletes, work status rendering); **06** plan
view/editor; **07** project actions and scheduled-task execution; **12**
goals and the auto-review run loop; **14** settings surfaces (`skillCatalogs`,
`agentMemoryToolEnabled`, `sessionRecapEnabled`, `sessionSuggestionEnabled`,
global draft starters).

Anything marked **[HARNESS PORT]** is a contract with the agent harness that
this re-implementation must provide on its own equivalent. A consolidated list
of those ports is in Section K.2.

---

## A. Overview — the "institutional memory" stack

### A.1 The layered picture

OpenChamber composes agent context from five distinct layers. Each layer has one
owner, one storage location, and one injection moment. They never share state,
and a failure in one must never blank another.

| # | Layer | Written by | Storage | Reaches the model through |
|---|---|---|---|---|
| 1 | **Session knowledge** (pinned notes + plans + memory index) | user pins; agent memory writes | assembly only, no dedicated file | synthetic text part on outgoing prompts (3 moments, see B.4) |
| 2 | **Project context** (notes, todos, plan bodies) | user; "add to notes" actions | server data dir, one JSON + plan markdown files per project | only when pinned into layer 1 |
| 3 | **Agent memory** | the agent itself, via a tool | server data dir, one JSON per scope (global + per project) | index titles ride layer 1; bodies read back via tool |
| 4 | **Obligatory context** (pinned messages) | user pins chat messages | session metadata (harness session record) | re-sent as one synthetic turn after compaction |
| 5 | **Side channels** (BTW fork, session assist recap) | user `/btw`; background small model | separate session (BTW) or session metadata (assist) | never enters the main thread's prompt |

Holding rules that the whole stack obeys (src:
packages/web/server/lib/session-knowledge/DOCUMENTATION.md):

- **Server-owned text assembly** — what a session must be told is decided and
  assembled on the OpenChamber server, so sessions with no UI at all (queued,
  dispatched) get the same context; browsers only fetch the assembled block.
- **Delivery recorded with the session, not the tab** — the delivered
  signature lives in session metadata, so a closed tab cannot cause a repeat
  and a post-compaction summary cannot leave a tab believing the agent still
  holds the block.
- **A source that fails never blanks the rest** — an unreadable memory store
  still delivers the pinned notes; a failed memory scope is omitted from the
  index rather than announced as empty (which would teach the agent to store
  again what it already has).
- **Nothing in the stack may fail the send** — "no block this time": a
  message without its background costs the agent context; a failed send costs
  the user their message.

### A.1b Client store catalog (knowledge-adjacent)

| Store | Persisted? | Owns | Spec |
|---|---|---|---|
| `useProjectContextStore` | no (cache) | per-project notes/todos/plans snapshot, write chains | D.8 |
| `useAgentMemoryStore` | no | memory snapshot, write chain, load sequencing | C.9 |
| `useSkillsStore` | partial (`selectedSkillName`) | per-directory skills, CRUD restart handling | E.5 |
| `useSkillsCatalogStore` | no | catalog sources/items, scan + install | E.5 |
| `useMcpStore` | no | live MCP status/diagnostics per directory | F.3 |
| `useMcpConfigStore` | partial (`selectedMcpName`) | config lists + edit draft | F.3 |
| `useSnippetsStore` | no | snippet list + expansion | I.1 |
| `useTodosPersistStore` | yes (safe storage, LRU 50) | last-seen session todo snapshots | J.1 |
| `useBtwStore` | no | per-parent btw panel presentation state | H.1 |
| `useAutoReviewStore` | yes | auto-review run states | J.5 |
| `useContextStore` | yes | session model/agent selections, usage meter | G.8 |
| `useDirectoryStore` | via safe storage | current/home directory + history | G.8 |
| `useUIStore` fields | yes | `projectContextTab`, `agentMemoryViewedAt` | C.9 |

### A.2 Where files live

- `OPENCHAMBER_DATA_DIR` — OpenChamber server data dir, default
  `~/.config/openchamber`. Holds `settings.json`, `magic-prompts.json`,
  `skills-catalog-cache.json`, `skills-github-meta.json`, and the `agent-tool/`
  plugin file. No harness involvement — OpenChamber-owned storage.
- `OPENCODE_CONFIG_DIR` — the harness config dir (OpenCode: `~/.config/opencode`).
  Holds the harness user config JSON, `skills/`, `snippet(s)/`. **[HARNESS
  PORT]** every read/write here is reimplemented against the target harness's
  own config layout.
- `projectsDir` — per-project storage root. `<projectId>` is the **bounded
  stem** of the project path: the id itself up to 200 characters,
  `path_sha256_<256-bit hex digest>` beyond that, so any checkout depth yields
  a filesystem-acceptable folder name. Nothing ever composes a storage path
  from the raw project id (src: packages/web/server/lib/projects/project-id.js).
- **Chats root** — managed directory of ordinary chat sessions, default
  `~/.config/openchamber/chats` (configurable; the client discovers it from
  the harness along with home). Every dated per-session directory beneath it
  (`<chatsRoot>/YYYY-MM-DD/session-<uuid>/`) resolves to the root for all
  knowledge purposes, so ordinary chats share **one** Chats knowledge owner
  (`openchamber:chats`) instead of an unreachable per-session store.
- `<userConfigRoot>` — the harness user config root (holds global agent
  memory `memory.json`).

### A.3 What "openchamber" session metadata means

All OpenChamber-owned keys live under `session.metadata.openchamber`:

| Key | Owner | Shape |
|---|---|---|
| `project_context_pins` | Session knowledge (B) | `{ notes: string[], plans: string[] }` |
| `knowledge_context_delivered` | Session knowledge (B) | string signature |
| `context_obligatory_messages` | Obligatory context (G) | `Array<{ id, createdAt, role: 'user'\|'assistant' }>` |
| `context_obligatory_last_compaction_message_id` | Obligatory context (G) | string |
| `btwSessionID` | BTW (H) | string (fork id) |
| `kind: 'btw'`, `originalSessionID`, `btwBoundaryMessageID` | BTW (H) | on the fork session |
| `btwPromoted` | BTW (H) | true on a promoted fork |
| `assist` | Session assist (H.2) | `{ recap, suggestion, forMessageID, generatedAt }` |
| `linked_issues` | Session-linked threads (J.4) | `Array<LinkedIssue>` |

Shared reading/writing rules (src:
packages/ui/src/lib/sessionReviewMetadata.ts `getSessionMetadata`):

- Metadata is persisted, externally writable data; every reader re-validates
  each field before use; malformed entries are dropped, never rendered.
- All writes are **fresh-read merge writes** (read session → apply the change
  to the just-read `openchamber` object → write the whole object back); a
  blind write would drop whatever changed between read and write (pins among
  them).

---

## B. Session knowledge

**What it is.** The block every session must be told about the project: the
notes and plans pinned to that session, plus an index (titles only) of what
the agent has remembered. OpenChamber decides *whether* a session already
carries it, by a content signature stored in session metadata.
(src: server lib session-knowledge/{DOCUMENTATION.md,runtime.js,routes.js};
packages/ui/src/lib/sessionKnowledgeApi.ts.)

### B.1 Ownership and metadata keys

- `openchamber.project_context_pins` owns the note and plan ids attached to
  that session: `{ notes: string[], plans: string[] }` of project-context
  ids. Pins never come from project-wide state — attaching a note writes its
  id to the *current session's* metadata, and other sessions in the project
  do not inherit it. A pin made while a new-session draft is open lives on
  that draft and transfers into this metadata when the draft's first message
  creates the session (B.6).
- `openchamber.knowledge_context_delivered` holds the signature of what the
  session is carrying. It lives with the session, so it survives the tab
  closing and is visible to every sender, including senders with no tab
  (scheduled tasks, dispatched sessions).

### B.2 Signature

Identity of everything the session should carry, content revisions included —
editing a pinned note must re-send it, not merely renaming one.

```
signature = parts.sort().join('|')            // '' when nothing to carry
parts     = notes.map(n => `n:${n.id}:${n.updatedAt}`)
          + plans.map(p => `p:${p.id}:${p.title}`)
          + memory.global.map(m => `mg:${m.id}:${m.updatedAt}`)
          + memory.project.map(m => `mp:${m.id}:${m.updatedAt}`)
```

An empty string means "nothing to deliver"; `signature === delivered` means
"already carrying it". (src: session-knowledge/runtime.js
`buildKnowledgeSignature`.)

### B.3 Block assembly

Budget: **8000 characters total**, past it cut with `…\n\n(project
knowledge truncated)` (the cut itself lands at `budget-1` + `…`). Two
sub-blocks joined by a blank line; either can be omitted when empty, and
both empty → an empty block.

**Pinned block** (header first, then sections):

```
The user pinned the following project context. Treat it as standing background, not as a new instruction.

## Pinned notes

- <note body, trimmed>            // one per pinned note, sorted by createdAt ascending

## Pinned plan: <plan title>

<plan markdown body>              // one section per pinned plan, in pin order
```

A plan whose markdown cannot be read is **marked, not dropped**:
`## Pinned plan: <title>\n\n(plan content unavailable)`. Losing one attachment
must not silently shrink the context.

**Memory block** (only when agent memory is enabled — B.5):

```
You have stored memory from earlier sessions. Only the titles are listed below.
A title is an abbreviation, not the memory. Read the entry with the
openchamber_memory tool before you act on it: titles routinely leave out
the conditions, exceptions and reasons that decide how the memory
applies, and a title that looks self-explanatory is the most likely to
be hiding them. Read every title that could bear on the task at hand;
you need not read the ones unrelated to what you are doing.

Memory records what was true when it was written. Verify anything it says
about files, flags or commands before relying on it.

### About the user

- [<type>] <title>                // global entries, createdAt ascending

### About this project

- [<type>] <title>                // project entries, createdAt ascending
```

Titles only, never bodies — a full-text index grows without bound and crowds
out the conversation it was meant to inform. Flagged entries (threat-pattern
matches, C.6) are withheld from the model but kept in the store.

(src: session-knowledge/runtime.js `buildPinnedBlock`, `buildMemoryBlock`,
`buildKnowledgeText`.)

### B.4 Three delivery moments, two transports

| Moment | Transport |
|---|---|
| A message the user sends from the UI | synthetic text part prepended to that message's parts |
| A scheduled task run; a session the agent dispatched | synthetic text part on that dispatched prompt |
| After compaction | its own `prompt_async` synthetic turn, riding **together with** the obligatory-context pinned messages (G), since two synthetic messages back to back read as the agent being interrupted twice |

### B.5 Collection semantics

Given a directory and pins, `collect`:
1. Resolve directory → projectId (same resolver as agent memory: managed
   chats roots resolve to the Chats root's project id; worktrees resolve to
   the repository's primary worktree; a directly-configured project wins;
   D.2/C.4). No project → empty notes/plans.
2. Read project context (D); filter notes and plans to the pinned ids. For
   each pinned plan read its markdown body (trimmed); a failed plan read
   yields `body: ''` ("content unavailable"); a failed context read yields no
   notes/plans (the block continues with memory only).
3. If agent memory is enabled (both switches, C.7): read both scopes; drop
   `flagged` entries; a scope that **failed to load is left out entirely** —
   the index never announces "you have no memories".
4. Memory disabled → `memory: { global: [], project: [] }` regardless.

`collectSummary` is the display variant: pinned note bodies / plan titles and
memory **counts**; deliberately does not read plan bodies (the panel states
counts and names, not content). Used by work status and the project panel
(B.7).

### B.6 The send path (UI) — flow F1

1. Composer submit reaches `sendMessage` in the session UI store. If the
   draft is a new-session draft, `materializeOpenDraftSession` creates the
   session first, passing the draft's pins as creation metadata
   **[HARNESS PORT: session create with metadata]**:
   `{ openchamber: { project_context_pins: draftPins } }` (omitted when both
   lists are empty). A chat draft's directory is prepared first (G.3). If
   session creation fails on a chat draft, the just-created chat directory is
   deleted (best-effort cleanup).
2. `GET /api/session-knowledge?directory=<dir>&sessionId=<id>` (or omit
   `sessionId` for a not-yet-created draft). Response `{ text, signature }`;
   text empty = already carrying it.
3. If `text` is non-empty, prepend one synthetic part
   `{ text, synthetic: true, systemContext: 'session-knowledge' }` ahead of
   all additional parts, so it reads as background before the message it
   accompanies, and send through the harness
   **[HARNESS PORT: message send with synthetic parts]**.
4. Only when the send route resolved to an actual prompt (other delivery
   modes — queue-only and the like — do not reach the model) does the client
   `POST /api/session-knowledge/delivered { directory, sessionId, signature }`.
   Recorded after the send resolves, never before: a failed send must carry
   the block again.
5. Server `recordDelivered` merge-writes `knowledge_context_delivered` onto a
   fresh read of session metadata; a failed record answers
   `{ recorded: false, reason }` and fails nothing (only a possible re-send).

The three server-side senders (message queue, dispatched-session route,
scheduled tasks) run the identical pair: `resolvePendingForSession(...) →
prepend synthetic part → send → recordDelivered(...)`.
(src: packages/ui/src/sync/session-ui-store.ts ~1700-1890;
message-queue/runtime.js ~489-509; openchamber-sessions/routes.js ~564-592;
scheduled-tasks/runtime.js ~489-514; sessionKnowledgeApi.ts.)

### B.7 Route inventory (session knowledge)

Per-route body parsing as in D.6 applies to every route here.

| Method | Route | Request | Response | Notes |
|---|---|---|---|---|
| GET | `/api/session-knowledge` | query `directory` (required), `sessionId` (optional) | `{ text, signature }` | 400 when `directory` missing. Existing session: pending computed from its stored signature + pins. No session: pending computed from empty delivered signature ("everything is still owed"). **Any internal failure returns 200** `{ text: '', signature: '', unavailable: true, reason }` — never fails the caller's send. |
| GET | `/api/session-knowledge/summary` | query `directory`, `sessionId` optional | `{ notes: [{id, body}], plans: [{id, title}], memory: { global: n, project: n } }` | Missing directory → zeroed 200. Errors → zeroed 200. |
| POST | `/api/session-knowledge/pin` | json `{ sessionId, directory, kind: 'note'\|'plan', id, pinned: boolean }` | `{ pins: { notes: string[], plans: string[] } }` | 400 on missing/invalid fields. Reads the session fresh, merges pin set, **also clears `knowledge_context_delivered`** so the next send re-delivers with the new pin state. |
| POST | `/api/session-knowledge/delivered` | json `{ sessionId, directory, signature }` | `{ recorded: true }` or `{ recorded: false, reason }` | Always 200; failure only means a possible later re-send. |

(src: session-knowledge/routes.js.)

**Re-delivery on edit.** The signature covers revisions (`updatedAt`) and
content (plan title), so any create/edit/delete of a pinned note or plan — or
of any memory entry — changes it, and the next send in that session
re-delivers the whole block. No route needs to actively "unpin from history".

### B.9 UI reading surfaces

- Work status "context sources" section:
  `fetchSessionKnowledgeSummary(directory, sessionId)` — 5-second client-side
  cache per `(directory, sessionId)`, locally invalidated on pin/unpin/deliver.
  Shows pinned note names, plan titles, memory counts, plus unpin affordances
  calling the pin route with `pinned: false` (src:
  components/chat/work-status/WorkStatusContextSection.tsx).
- Project panel pins (ProjectNotesTodoPanel): in a draft reads/writes
  `newSessionDraft.projectContextPins` directly; in a live session calls the
  pin route and adopts the returned pins (B.7).
- The knowledge **assembly** is never done in the browser.

---

## C. Agent memory

**What it is.** What the agent has learned and chose to keep, in two scopes.
Memory is what the **agent** writes for itself via the `openchamber_memory`
tool; the notes surface (D) is what the **user** writes. Keeping the stores
apart is what stops an agent mistake from landing in the user's notes.
(src: server lib agent-memory/*; agent-tool/runtime.js; useAgentMemoryStore.ts;
agentMemoryApi.ts; agentMemoryBadges.ts.)

### C.1 Storage schema

```json
{ "version": 1, "entries": [ { "id": "...", "title": "...", "body": "...",
  "type": "fact", "createdAt": 0, "updatedAt": 0, "sessionId": "...",
  "flagged": true } ] }
```

| Path | Scope | Caps |
|---|---|---|
| `<projectsDir>/<projectId>/memory.json` | project (about this codebase) | 200 entries |
| `<userConfigRoot>/memory.json` | global (user; reaches every project) | 60 entries |

- `id` — non-empty string (server default `crypto.randomUUID()`); `title`
  clamped to **60 chars** on write; `body` clamped to **2000 chars**, trimmed,
  required non-empty; `type` one of `fact`/`preference`/`reference`
  (invalid → `fact`); `createdAt`/`updatedAt` non-negative epoch ms
  (invalid → now / createdAt).
- `sessionId` recorded when the agent supplied it. `flagged` — present only
  when `title+body` trips a threat pattern (C.6); **re-derived on every
  read**, never trusted from the file.
- Reads return entries sorted by `updatedAt` descending, dropping above-cap
  overflow (most recently updated kept).
- Writes serialize through a per-scope in-process lock
  (`key = 'global' | 'project:<projectId>'`) and land via write-temp + rename.
- **Missing file is authoritative empty; malformed JSON or a non-object is a
  thrown failure** — an agent that read "no memory" from a corrupt file would
  rewrite everything it thought it had lost (src: agent-memory/runtime.js).

### C.2 Dedupe ("restatements replace")

On create, before the capacity check (replacing never grows the store, so a
full store must still be able to correct itself):

1. **Exact title match** (case-insensitive) → that entry is superseded:
   rewritten with the new `title`/`body` (`type` only when the new `type` is
   valid), `updatedAt: now`, same id; result `replaced: true`.
2. **Wording overlap** — tokenize (`title + body`) of every stored entry:
   lowercase, split on non-letter/number (unicode-aware), tokens of length ≥ 3,
   minus a fixed English stop-word list (`a an and are as at be but by for from
   has have in into is it its not of on or that the their them they this to was
   were when with`). Overlap = shared tokens / incoming tokens; a stored entry
   with overlap ≥ **0.75** (highest score wins) supersedes when the incoming
   token count ≥ **4**. Shorter entries do not fuzzy-match ("use bun" vs
   "use npm" share half their tokens); only exact-title match.
3. Otherwise: a genuinely new entry. When the scope is already full, the save
   **fails with an error that lists every stored title** and instructs the
   agent to consolidate (merge overlapping entries by saving under an existing
   title; delete stale ones; retry — all in the same turn). A bare "full"
   would leave the model a dead end when the useful move is one only it can
   judge. (src: agent-memory/runtime.js `create`.)

### C.3 Update and delete (panel-only)

`PATCH`-style update exists so an entry worded badly enough to mislead is
fixable where it is read; the agent corrects by re-saving the same memory, so
update is for the panel alone. It patches only the supplied fields among
`title`/`body`/`type`, requires at least one, rejects blank `title`/`body`,
bumps `updatedAt`. Unknown id → `null` (404 at the route). Delete is by id;
already-absent id → `deleted: false` (404 at the route).

### C.4 Scope resolution (directory → project)

Project memory scope is **always derived from the session's directory, never
from the model's input** — an agent-named id could file one checkout's memory
under another, invisibly
(src: agent-memory/actions.js header; agent-memory/project-resolution.js).
Resolver order:

1. Directory inside a **managed chats root** (configured chats root; legacy
   `~/.config/openchamber/chats`) → project id of that root.
2. Directory equals a configured project path → its own id (a worktree
   deliberately registered as a project wins over git topology).
3. Otherwise the git **primary worktree root** of the directory and its id
   (a read failure or non-git falls through).
4. Fall back to the directory itself.

A step-2 read failure does not lose the memory — the git-derived root still
converges worktrees onto one store.

### C.5 The `openchamber_memory` tool — full schema

Injected into the managed agent process as part of a generated plugin file
(cross-ref 02 for injection mechanics and the `openchamber` /
`openchamber_web` siblings; the schema is restated here because its storage,
dedupe, threats and gating live in this subsystem). The `oneOf`/enum
descriptions below are the exact strings the model sees.

```jsonc
{
  "description": "Keep what you learn across sessions, so the user does not have to explain the same thing twice. Use one action per call. The session already lists the titles of what is stored. A title is an abbreviation, not the memory: read the entry with memory.read before acting on it, because titles leave out the conditions and exceptions that decide how the memory applies, and the ones that look self-explanatory hide them most often. Save something only when it will still be true in a later session — a stable preference, a project convention, a decision and its reason, or a hard-won pointer. Do not save one-off task state, anything you can read from the code, secrets or credentials, or anything the user asked you not to keep. Choose the scope deliberately: global is about the user and reaches every project, so put a project's conventions in project scope. What you save is shown to the user as unreviewed until they confirm it, so save plainly and say what you saved when it matters.",
  "args": {
    "action": {
      "type": "string",
      "enum":   ["memory.read", "memory.list", "memory.save", "memory.delete"],
      "oneOf":  [{ "const": "memory.read", "description": "Read the full text of one memory listed in the session index. The index shows titles only, and a title omits the conditions that decide how the memory applies, so read before acting rather than working from the title. Requires title (as the index spells it) or memoryId; scope is optional and both stores are searched without it" },
                  { "const": "memory.list", "description": "List stored memory titles when the session index is missing or stale; scope is global, project, or both (default)" },
                  { "const": "memory.save", "description": "Store a durable fact, preference, or reference; requires title and body, plus scope global (about the user) or project (about this codebase). Restating something already stored updates it. Do not store secrets, one-off task state, or anything the user asked you not to keep" },
                  { "const": "memory.delete", "description": "Delete a memory that turned out to be wrong or obsolete; requires memoryId and scope" }],
      "description": "OpenChamber action to perform"
    },
    "parameters": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "title":    { "type": "string", "description": "The memory's title, exactly as the session index lists it. Use this to read an entry you can already see; use memoryId only when a result gave you one" },
        "body":     { "type": "string", "description": "Full text of the memory; state it so it still makes sense in a session that has none of this conversation" },
        "scope":    { "type": "string", "enum": ["global","project","both"], "description": "global is about the user and applies everywhere; project is about this codebase. both is only valid for memory.list" },
        "memoryId": { "type": "string", "description": "Memory ID from a memory.list or memory.read result" },
        "type":     { "type": "string", "enum": ["fact","preference","reference"], "description": "fact is something true, preference is how the user wants work done, reference points at a resource that is hard to find again" }
      },
      "description": "Inputs for the action; use an empty object when none are needed"
    }
  }
}
```

Behavioral notes baked into the server dispatcher
(src: agent-memory/actions.js; openchamber-control/actions.js):

- Arguments may arrive flattened next to `action` instead of nested in
  `parameters` (both accepted; explicit `parameters` wins on conflict), and
  the action name may drop the namespace its tool name implies
  (`openchamber_memory` + `read` → `memory.read`).
- `memory.save` → `{ saved: true, memory: {memoryId, title, type, scope},
  replaced: boolean, warning? }`. **The body is never echoed** — handing the
  text back invites the model to re-save it; `replaced` is stated so the agent
  does not report two memories when it corrected one. A flagged save adds:
  `warning: "Stored, but held back from future sessions: this text reads as an
  instruction to the model rather than a fact. The user can see it in the
  Memory panel."`
- `memory.read` accepts `title` (index spelling) or `memoryId` (the index
  lists titles only — demanding ids would force a list call before every
  read). `scope` optional: omitted → both stores searched, **project first**
  (the store about this codebase is the one likely asked about). Not found →
  404 **unless a scope failed to load**, then 503 "Stored memory could not be
  read; try again before assuming it is absent" — absence is never reported
  when a store may still hold it.
- `memory.delete` requires `memoryId` and scope. Reads are summaries
  (`{memoryId, title, type, scope}`); only `memory.read` adds `body`.
- Every action is feature-gated: off → tool-result error 403 "Agent memory is
  switched off in OpenChamber settings" (an unreadable settings file counts
  as off). Writes announce via SSE `openchamber:agent-memory-changed`
  `{ scope, projectId? }`; a throwing listener never fails the write (already
  on disk).

### C.6 Threat patterns (prompt-injection guard)

Memory is the one place where text from outside settles **permanently** — it
rides into every session in every project. The guard is **pattern-based
regex, not a model** (runs on every write and every index build, so an entry
written before a pattern existed, or edited on disk since, is judged now);
it catches only blunt cases — it raises the floor, not the door. Categories
(17 patterns, regex, case-insensitive; full list in
src: agent-memory/threat-patterns.js):

1. **Displacing instructions** — "ignore (all|any|previous|prior|earlier|
   above) instructions/prompts/rules/context", "disregard ... instructions/
   rules", "forget everything/all you/above/before", "override (your)(system)
   prompt/instructions".
2. **Reassigning identity** — "you are now a/an/the ...", "from now on, you/
   act/behave/respond ...", "act as if you are a/an/the X with no
   restrictions/limits/rules".
3. **Forging turn structure** — lines starting `system:`/`assistant:`/
   `developer:`, `<|im_start|>`-style special tokens, `[/INST]`-style brackets.
4. **Attacking guardrails** — "bypass/disable/turn off (all) safety/security/
   guardrails/filters/restrictions", "developer mode enabled/on/activated".
5. **Exfiltration** — "print/reveal/repeat/output/show (me) (your|the) (system
   prompt|instructions|initial prompt)", "send/post/upload/exfiltrate (the|
   your) (api key|token|credentials|secrets|env)".

Match result: the **regex source string (first 80 chars)** returns, unified
across `title + "\n" + body`. A match **never deletes**: the entry is stored,
flagged, kept out of what sessions are told, and shown in the panel with a
warning. Silently dropping it would hide the attempt from the only person
able to judge it.

### C.7 Feature gating ("shipping dark")

Two switches, both required: (1) **Availability gate** — env
`OPENCHAMBER_MEMORY_ENABLE` must be one of `1/true/yes/on` (trimmed,
case-normalized), read per call, never captured at import; unset → **no tool,
no routes, no session index, no settings row, no panel tab** — absent rather
than switched off, which would invite turning on something never announced.
(2) **Settings switch** — `settings.agentMemoryToolEnabled` (OpenChamber
settings.json; default **false**; UI toggle per 14): the env variable alone
does not enable memory (`enabled = envFlag && setting === true`).

The managed plugin is generated with `includeMemory = envFlag && setting` at
session start; the HTTP routes and the tool dispatcher additionally gate per
call, because the tool lives in the managed child only until it restarts —
between switching off and restart, ungated writes would accumulate where
nobody can see them (src: agent-tool/runtime.js; agent-memory/actions.js).
Pinned notes and plans are unaffected by the memory switch.

### C.8 HTTP routes (agent memory)

Scope is a **query parameter** of every route, never part of the path: global
and project memory are the same resource with two homes, and getting the scope
wrong must fail loudly rather than silently write global memory from a
project-scoped call. Validation failures 400; storage failures 500.

| Method | Route | Request | Response | Notes |
|---|---|---|---|---|
| GET | `/api/agent-memory` | query `scope=global` or `scope=project&projectId=<id>` | full store `{ version, entries }` | no create route — the agent creates through the tool |
| GET | `/api/agent-memory/all` | query `projectId` optional | `{ global, project, globalFailed, projectFailed }` | one request for both scopes so the panel cannot render one scope while the other reads as gone; scope-level failures are flagged, not dropped silently |
| PATCH | `/api/agent-memory/:memoryId` | json `{ title?, body?, type? }` + scope query | `{ entry, entries }` | 404 when unknown; 400 on missing fields/invalid type |
| DELETE | `/api/agent-memory/:memoryId` | scope query | `{ deleted: true, memoryId }` | 404 when unknown |

Feature-off gate wraps all four: **404 with `{ error: 'Agent memory is
disabled', disabled: true }`** — flagged, not merely 404, because a missing
entry answers 404 too and a client that cannot tell them apart would report a
deleted memory as the feature being off. A settings file that fails to read
→ **503** "availability is unknown" (an unreadable setting must not silently
expose a surface the user may have turned off).

Client interpretation: 404 + `disabled: true` payload →
`AgentMemoryDisabledError`; a plain 404 stays an error.
(src: agent-memory/routes.js; agentMemoryApi.ts.)

### C.9 UI store and badges

**useAgentMemoryStore** (src: useAgentMemoryStore.ts) — a snapshot cache with
serialized writes:

- `load(projectPath, { maxAgeMs? })` — loads both scopes via
  `/api/agent-memory/all` (projectId bounded-stem of `projectPath`).
  `maxAgeMs` skips the read when the same project's entries were loaded more
  recently; an owner change clears the held project list *before* the request
  starts; a **load-sequence counter** means only the newest load may write
  (turning the feature back on fires a load before the setting has finished
  being written — an older "disabled" answer must not latch it off).
- `globalFailed`/`projectFailed` never blank an already-held list;
  `AgentMemoryDisabledError` → `disabled: true, loaded: true`, lists cleared,
  path kept; other errors keep previous data and set flags+error. **A failed
  load never renders as "the agent forgot everything."**
- `saveEntry`/`deleteEntry` run through one serialized write chain; optimistic
  mutate, rollback + error on failure. `selectProjectMemoryForPath` returns
  the project list only when the store's `projectPath` equals the panel's
  owner — never one owner's entries under another's heading. `reset()` on
  runtime switch.

**Synchronization** (src: hooks/useAgentMemorySync.ts) — deliberately *not*
owned by the Memory tab (the session index is built from the loaded snapshot;
a user who never opens the panel would send messages with no memory index).
An app-level hook loads for the resolved project owner with a 60-second
freshness window and re-reads on the `openchamber:agent-memory-changed` SSE
event (the agent writes mid-turn through its own tool, so the next message's
index must be fresh).

**Badges** (src: lib/agentMemoryBadges.ts) — no review state stored
server-side. `memoryViewKey(scope, projectPath)` → `'global'` or
`'project:<projectPath>'`; per-scope "last viewed" marks live in the UI
settings store (`agentMemoryViewedAt`, per project so opening one project
cannot clear another's badges; cross-ref 14). `classifyMemory(entry,
viewedAt)` → `'new'` when `createdAt > viewedAt`, else `'changed'` when
`updatedAt > viewedAt`, else null (`viewedAt: 0` marks everything new). The
mark is **frozen while the tab is open** and advanced on the way out
(unmount): reading the live value would clear every badge the instant the tab
appeared. `countHighlightedMemories` feeds the tab count across both scopes.

**Panel** (src: MemorySection.tsx; ProjectNotesTodoPanel.tsx): the "Memory"
tab of the project panel; scope is a chip-group switch (project/global — never
one merged list, because which store an entry sits in is the most important
thing about it); entries rendered by the shared `KnowledgeCard` (D.8); editable
inline (PATCH); delete with an error toast on failure; feature-off hides the
tab and a persisted "memory" tab selection falls back to "notes".

### C.10 Flow F2 — memory written by the agent

1. Session index (titles) was delivered via session knowledge (B).
2. Agent calls `openchamber_memory` with `memory.save`; the plugin POSTs
   `{ input: {action, parameters...}, contextDirectory, tool:
   'openchamber_memory' }` to the loopback callback with the bearer token
   **[HARNESS PORT: managed tool callback]**.
3. Server resolves scope from `contextDirectory` (project) or explicit
   `scope: global`; runs dedupe/capacity; writes atomically; flags on threat
   pattern; announces SSE `agent-memory-changed` → UI stores re-read
   (useAgentMemorySync).
4. The next send in any session of that project computes a signature
   difference (memory ids are in the signature) → block re-delivered with the
   updated index.

### C.11 Flow F3 — panel edit/forget

`PATCH /api/agent-memory/:id?scope=...` (title/body/type, blank rejected) or
`DELETE ...` from the Memory tab; write chain serializes; optimistic
mutations roll back with an error toast when the call fails; the returned
entry is adopted; badges unchanged (an `updatedAt` bump may flip an entry to
"changed" on next view).

---

## D. Project context

Persistent per-project data the **user** writes: free-form notes, todos, plan
markdown files — plus the plan manifest and the team's shared plans folder.

(src: server lib project-context/{DOCUMENTATION.md,runtime.js,routes.js};
useProjectContextStore.ts; useProjectContextOwner.ts; projectContextApi.ts;
components/session/project-context/DOCUMENTATION.md.)

### D.1 Ownership split (files)

| Path | Owner | Contents |
|---|---|---|
| `<projectsDir>/<projectId>.json` | projects module (cross-ref 07/14) | worktree setup, draft starters, project actions, scheduled tasks |
| `<projectsDir>/<projectId>/context.json` | **project context, exclusively** | notes, todos, plan manifest |
| `<projectsDir>/<projectId>/plans/*.md` | **project context, exclusively** | personal plan bodies |
| `<projectsDir>/<projectId>/memory.json` | agent memory (C.1) | agent memory, project scope |
| `<repo>/<plansDir>/*.md` | project context (read/edit/delete/move) when team config names `plansDir` | shared plan bodies; the folder is the team's, any tool may write there |

The split exists because both files were once one, client-written with a
whole-file read-modify-write: adding a server writer would have made unrelated
features clobber notes across processes; separate files remove the shared
resource instead of coordinating access to it. **Nothing outside this module
may write `context.json` or the `plans` directory.** `projectId` = bounded
stem of the project path (A.2); route validation
`/^[a-zA-Z0-9._:-]+$/` rejects separators and traversal → 400.

### D.2 The Chats owner

Every directory beneath the managed chats root resolves to the Chats root
**before** project context and project memory are read, so ordinary chats
share one knowledge owner (`openchamber:chats`, projectRef.path = chatsRoot)
instead of an unreachable store per dated session directory.
(src: project-context/DOCUMENTATION.md; useProjectContextOwner.ts;
chatDirectories.ts.)

Client owner resolution (`resolveProjectContextOwner`), in order:

1. A new-session draft open with target `chat` → owner
   `{ id: 'openchamber:chats', path: chatsRoot }`.
2. Directory inside the configured or legacy chats root → same Chats owner.
3. Directory resolves to a configured project or one of its worktrees
   (`resolveProjectForSessionDirectory`: a worktree maps back to its project)
   → that project.
4. A concrete directory that resolves to nothing owns **nothing** (panel stays
   empty). A previous fallback to "active project" showed one project's
   knowledge under another's name; the active-project fallback applies only to
   states with no directory at all (a draft that has not landed).

The server uses the same worktree rule for memory (C.4); the client uses
`useProjectContextOwner` for both the panel and memory sync loads.

### D.3 Storage format (context.json)

```json
{
  "version": 2,
  "notes":  [{ "id": "", "body": "", "createdAt": 0, "updatedAt": 0,
               "source": "manual | selection | agent",
               "origin": { "sessionId": "", "messageId": "" } }],
  "todos":  [{ "id": "", "text": "", "completed": false, "createdAt": 0 }],
  "plans":  [{ "id": "", "file": "1700000000-title.md", "title": "", "createdAt": 0 }]
}
```

- `source` records where a note came from; `origin` links it back to the
  message it was distilled from (chat-selection captures). Legacy `pinned`
  fields may remain in files but are **ignored** (attachment ownership lives
  in session metadata B.1); the plan manifest's `pinned` field covers the
  legacy project-wide pin state only.
- Plan links store the **base file name**, never a path — moving the project
  storage directory cannot invalidate a reference, and a caller can never
  address a file outside the project's plans dir. `title` is denormalized
  into the manifest for one-read listing; `readPlan` returns the title parsed
  from the file, which wins if the two disagree.
- Limits: note body **3000 chars** (reject blank; blur-restores the last
  saved text), todo text **120 chars**, notes capped at **200 per project**
  (creation fails loudly past that instead of silently evicting).
  
### D.4 Shared plans

Every `.md` in the repository plans folder (default `<repo>/.openchamber/
plans`, or the `plansDir` named by the team config `<repo>/.openchamber/
project.json` — the custom folder replaces the default outright) is a plan.
`readContext` appends them after personal ones (`source: 'shared'` vs
`'personal'`) and reports the folder as `sharedPlansDir`. A shared plan not
claimed by a manifest entry is addressed as `shared:<file>`, its title parsed
from the file on every list; `readPlan`/`updatePlan`/`deletePlan` work on the
file directly (an update writes the raw document verbatim, so another tool's
formatting survives); `setPlanPinned` is 404 for such a plan. **sharePlan**
moves the markdown into the shared folder and keeps the manifest entry with
`shared: true` (the flag says which folder holds the file), so a session that
attached a plan still finds it, listed under its original id instead of
`shared:<file>`. **unsharePlan** moves it back and clears the flag; a plan
that only ever lived in the shared folder gains a manifest entry (and an id)
on the way in; name collisions get a numeric suffix; sharing is refused (400)
only when the checkout cannot be located.

### D.5 Legacy migration (v1 → v2)

`projectNotes` (a single string), `projectTodos`, `projectPlanFiles` once
lived in `<projectId>.json`. On the first read with no `context.json`: the
three keys move out and are deleted from the (bounded-name) config file,
every other key preserved untouched; the v1 note string converts to a single
`manual` note (empty string → no notes); plan links carrying absolute paths
convert to base names — a file already in the plans directory is used in
place, one referenced from elsewhere is **copied in** rather than dropped,
and a link whose markdown cannot be found at all is discarded. Legacy keys
are removed only after `context.json` is durably written, so any failure
leaves the migration to run again; repeat and concurrent reads converge on
identical content. The conversion lives in the **read path**, not a migration
pass, so every reader — including one racing a writer — sees one shape. A
sibling settings-runtime merge (`mergeProjectContextFiles`) merges context
lists by identity across project-storage changes and deliberately does *not*
convert a v1 note (this module owns that conversion; two implementations
would mean two definitions of one migration).

### D.6 Route inventory (project context)

`projectId` pattern-validated (400); malformed stored data / I/O failures
500. **Body parsing is attached per route** — there is no global JSON parser:
the generic harness proxy needs an unread request stream, so only allowlisted
`/api` prefixes get parsed, and a write route that forgets a body parser sees
`req.body === undefined` and rejects every request as malformed (a shipped
failure the route tests mount on a bare app to catch).

| Method | Route | Request | Response | Notes |
|---|---|---|---|---|
| GET | `/api/project-context/:projectId` | — | `{ version?, notes, todos, plans, todosRevision, sharedPlansDir }` | missing file is **200 empty**; unparseable → 500; todo revision is derived, not stored |
| PUT | `/api/project-context/:projectId/todos` | `{ todos: Todo[], expectedRevision }` | committed context + `todosRevision` | replaces the whole list only if the revision still matches; 409 on conflict |
| POST | `/api/project-context/:projectId/notes` | `{ body, source?, origin? }` | 201 `{ note, context }` | blank body rejected |
| PATCH | `/api/project-context/:projectId/notes/:noteId` | `{ body?, pinned? }` (only named fields) | `{ note }` | 404 unknown |
| DELETE | `/api/project-context/:projectId/notes/:noteId` | — | committed context | 404 unknown |
| GET | `/api/project-context/:projectId/plans/:planId` | — | `{ id, file, title, createdAt, pinned, source?, body, raw }` | 404 when link or markdown gone |
| POST | `/api/project-context/:projectId/plans` | `{ title, body }` (never a path) | 201 `{ plan, context }` | writes markdown before manifest |
| PUT | `/api/project-context/:projectId/plans/:planId` | `{ raw }` whole document | `{ plan, raw }` | refuses to recreate a deleted file (404); file name never changes |
| DELETE | `/api/project-context/:projectId/plans/:planId` | — | committed context | removes manifest entry before the file |
| PATCH | `/api/project-context/:projectId/plans/:planId` | `{ pinned }` | `{ plan }` | legacy project-wide pin only; **404 for `shared:` plans** |
| POST | `/api/project-context/:projectId/plans/:planId/share` | — | `{ plan, context }` | 400 without a shared dir; 404 unknown |
| POST | `/api/project-context/:projectId/plans/:planId/unshare` | — | `{ plan, context }` | 404 unknown |

All commits return the committed context so optimistic UIs adopt server truth.

### D.7 Invariants (project context)

- **Missing is not malformed:** missing `context.json` = authoritative empty;
  unparseable = 500 so the client preserves what it has instead of rendering
  one empty panel over intact disk data.
- **Writes serialize per project** (in-process lock chain) and land via
  write-to-temp + rename (crash cannot leave a half-written file).
- **`readContext` never takes the lock** (every mutator already holds it while
  calling; locking there would deadlock). The legacy migration it can trigger
  is safe unlocked (two atomic renames of identical content).
- **Plan create:** markdown first, then manifest; **delete:** manifest entry
  first, then file. Either partial failure leaves an inert unreferenced .md
  — the reverse order would leave a manifest entry that renders and fails to
  open.
- **Plan update takes the raw document**, not reassembled title+body; the
  file name is the stable identity and never changes with the title.
- **Note patch touches only named fields** (pin alone cannot roll back an
  edit that landed between two requests; editing does not reset a pin; pinning
  does not bump `updatedAt` because a pin is not a change to content).
- **A note body can be clamped but never blanked** (blank = unrequested
  delete).
- **Per-entry sanitization never fails the whole read** — a malformed todo or
  plan link is dropped; the rest loads.
- One failed note/todo/plan mutation never erases unrelated entries (client
  store: optimistic apply, rollback only the affected field group).

### D.8 UI data layer

**useProjectContextStore** (src: useProjectContextStore.ts) — per-project
entry cache `{ notes, todos, plans, sharedPlansDir, loaded, loading, error }`
keyed by the path-derived project id:

- `load(project, { force? })`: while a load is in flight, later-started
  mutation field groups are preserved over the snapshot at commit (per-group
  in-flight flags kept outside store state so writes do not re-render every
  consumer). Todo saves are optimistic with rollback; `createNote`/`createPlan`
  are **not** optimistic (ids/timestamps from the server — a placeholder row
  that cannot be edited/pinned/opened is worse than a brief wait).
  `saveNoteBody` rejects blank, adopts the committed note, and treats 404 as
  "note gone" (removes locally rather than erroring). Plan share/unshare
  update both `plans` and `sharedPlansDir` from the response. `reset()` clears
  caches and write chains on runtime switch; per-project write chains
  serialize saves against the server's own read-modify-write.

**projectContextApi** — HTTP only, resolves no storage paths, never reads
plan files from disk; every function **throws on failure** (an authoritative
read must never resolve to an empty value a caller could read as "nothing
here"). Exports a client-side `parsePlanMarkdown` (title from the first
`# heading`, else the first line) and the limits (3000/120), plus
`SavedProjectPlanTarget { projectRef, planId }` — a plan id is always carried
**with its owning project**, so no viewer ever guesses the project from the
current directory (which silently opened empty documents for Chats-owner
plans and for plans opened from a worktree the directory lookup missed).

**Panel** (src: components/session/project-context/* — container
ProjectNotesTodoPanel; sections; shared KnowledgeCard; useProjectTodoSend):

- Tabs (notes/todos/plans/memory) in the context rail + mobile workspace
  drawer. One container query filters all tabs; the tab bar shows match
  counts and the panel follows the search to a tab that has hits; filtering
  is display-only (mutations act on the full list).
- Shared `KnowledgeCard` shell for every entry list: a collapsed card opens
  on a click anywhere; an expanded card closes only via its collapse action
  (the body is editable; a stray click must not throw the editor away). Only
  one expanded at a time; collapsed notes clamp to a three-line preview.
  Per-note rows keep a local debounced draft; an external change is adopted
  only while that row is untouched since its last save ("Add to notes" from
  a chat selection must reach an open panel without overwriting typing).
  Completed todos sink to the bottom **for display only** (stored order is
  what the user dragged).
- Plans open in place: clicking a plan replaces the list with the lazily
  imported `PlanView` (cross-ref 06), given
  `savedProjectPlan={{ projectRef, planId }}`; leaving the section or project
  closes it; hosts with a fullscreen plan surface (mobile) keep theirs via
  `onOpenPlan`. Persisted plan tabs carry the owner (`projectPlanRef`); a
  saved-plan tab with an id but no owner is **dropped on rehydrate** rather
  than reopened against a guessed project.
- A load failure never blanks the panel (keep the last good snapshot; toast
  once, only when nothing had loaded yet); the panel never touches `/api/fs/*`
  and stores no plan paths; the active tab persists in the UI store, falling
  back to `notes` when a persisted `memory` tab's feature is off (C.9).

### D.9 Flow F4 — create/edit/delete a note

1. Composer in NotesSection → store `createNote(project, { body, source?,
   origin? })` (e.g. `source: 'selection'` + `origin` from a chat selection
   capture).
2. `POST .../notes` (201, not optimistic) → adopt `note` + committed context.
3. Edit: local debounced draft → `saveNoteBody` PATCH → adopt committed note.
   404 → row removed. Failure → restore previous body + error.
4. Delete: optimistic filter → DELETE → adopt context; failure → restore.
5. Pin: pin toggle calls the session-knowledge pin route (B.7) — attaching
   writes session metadata, not context.json. Other sessions unaffected.

### D.10 Flow F5 — plan lifecycle

Create (POST) → open in place (PlanView with owner) → autosave via
`planSaveQueue` (I.4) → optional `saveProjectPlan` PUT `{ raw }` → optional
share/unshare move → delete (DELETE). Addressed by id with its owning
project throughout; file names never re-derive from titles.

---

## E. Skills

A **skill** is a `<name>/SKILL.md` folder: YAML frontmatter (`name`,
`description`) plus markdown instructions, optionally with supporting files
in the same directory. The **harness** loads skills at session start
**[HARNESS PORT: skill loading]**; OpenChamber provides the editing surface,
the catalog/install pipeline, and the composer autocomplete — its list must
match what the agent can actually invoke.
(src: server lib skills-catalog/* and opencode/{skill-routes,skills,shared}.js;
useSkillsStore.ts; useSkillsCatalogStore.ts; skillVisibility.ts.)

### E.1 Discovery roots (server scan)

The OpenChamber scan walks (read-only; `<dir>` = the requested working
directory, ancestors stop at the git worktree root):

| Where | Scope | source label |
|---|---|---|
| `~/.claude/skills/**/SKILL.md`, `~/.agents/skills/**/SKILL.md` | user | `claude` / `agents` |
| `<ancestor>/.claude/skills/**`, `<ancestor>/.agents/skills/**` (from working dir up to worktree root) | project | `claude` / `agents` |
| harness config dirs (env `OPENCODE_CONFIG_DIR`, `~/.opencode`, project `<dir>/.opencode`) each with both `skill` (legacy singular) and `skills` subdirs | user or project (project when the dir is the working directory, user when it is a config dir) | `opencode` |
| harness config field `skills.paths: string[]` (extra dirs, `~/` expanded) | project | `opencode` |
| local cache dirs (`$XDG_CACHE_HOME/opencode/skills`, `~/.cache/opencode/skills`, `~/Library/Caches/opencode/skills`) | user | `opencode` |
| harness SDK `app.skills` (built-ins; location `<built-in>`) merged under local skills by name | — | `opencode` |

Server-side per-skill metadata: `name`, `path`, `scope` (`user`\|`project`),
`source` (`opencode`\|`claude`\|`agents`), `description` (SKILL.md
frontmatter), `group` (client parse: the folder between `skills/` and the
skill folder — `.../skills/automation-ai/ai-production/SKILL.md` →
`automation-ai`, flat layouts → undefined), `renamable` (true only under a
**managed root** OpenChamber controls and not `<built-in>` — rename-in-place
authority). The list route also answers what the browser cannot read: the
harness's external-skill env flags.

```jsonc
GET /api/config/skills?directory=<dir>
→ { "skills": [ { "name","path","scope","source","description","group",
                  "renamable", "sources": {...per-variant file info} } ],
    "externalSkills": { "claudeDisabled": bool, "allDisabled": bool } }
// claudeDisabled = OPENCODE_DISABLE_CLAUDE_CODE || ..._SKILLS (any non-empty
// value except 0/false enables a flag); allDisabled = OPENCODE_DISABLE_EXTERNAL_SKILLS
```
**[HARNESS PORT: env semantics + skill discovery rules must be mirrored.]**

### E.2 Client visibility filter (`filterSkillsByRuntimeFlags`)

OpenCode's own skill endpoint is *not* the authority (measured 1.18.14: it
lists only global and built-in skills, omitting project `.agents`/`.claude`
skills the agent demonstrably has). The client narrows the scan to what the
agent can invoke, mirroring the harness discovery rules:

- flags absent (older server/failed read) → pass everything through —
  filtering on a guess would hide skills that do work.
- `allDisabled` → no `claude`/`agents` roots; `claudeDisabled` → no `claude`
  root (agents unaffected); `opencode` root always allowed.
- Dedupe by name with **last-write-wins in scan order, `.agents` after
  `.claude`, so `.agents` wins a collision** (commonly `.claude/skills` are
  symlinks back into `.agents/skills`).

(src: packages/ui/src/stores/skillVisibility.ts.)

### E.3 Skill CRUD routes

| Method | Route | Notes |
|---|---|---|
| GET | `/api/config/skills` | see E.1. Directory resolution: explicit request param → `x-opencode-directory` header → active project → harness client dir; soft-fallback (listing user skills without a project is valid) |
| GET | `/api/config/skills/:name` | `{ name, sources (md exists/path/dir/fields/scope/source/supportingFiles + projectMd/claudeMd/userMd/userClaudeMd/userAgentsMd variants), scope, source, exists }` |
| POST | `/api/config/skills/:name` | create; body `{ description, instructions?, scope?, source?, supportingFiles?: [{path, content}] }`; `scope=project` requires a directory (400 otherwise). Always answers a deferred-restart payload: `{ requiresReload: true, message, reloadDelayMs }` — skills load at session start, so the harness child restarts (or the client waits for health and reloads) before the skill is live |
| PATCH | `/api/config/skills/:name` | update `{ description?, instructions?, supportingFiles?, targetPath? }`, or rename `{ renameTo }` (rename also returns `requiresReload: true`) |
| DELETE | `/api/config/skills/:name` | delete managed skill files; same restart payload |
| GET/PUT/DELETE | `/api/config/skills/:name/files/*filePath` | supporting-file read/write/delete; `isUnsafeSkillRelativePath` guard → 400 (traversal); 403 on EACCES/EPERM; 404 when skill or file missing |

Name rules (harness-side and installer):
`/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/` (1-64 chars, lowercase alnum +
hyphens; skill dir basenames). Writes land in managed user root
`<OPENCODE_CONFIG_DIR>/skills/<name>/SKILL.md` (legacy singular `skill/`
honored when it exists) or project `<dir>/.opencode/skills/<name>/` (legacy
`<dir>/.opencode/skill/` honored).
**[HARNESS PORT: your own skill dir layout must exist at these seams.]**

### E.4 Catalog (server side)

Two source families, `sources = [...curated, ...custom]`:

```jsonc
// curated (built into the server)
{ "id": "anthropic",    "label": "Anthropic",     "source": "anthropics/skills",  "defaultSubpath": "skills" },
{ "id": "openai",       "label": "OpenAI",        "source": "openai/skills",      "defaultSubpath": "skills/.curated" },
{ "id": "cursor",       "label": "Cursor",        "source": "cursor/plugins",     "defaultSubpath": "pstack/skills" },
{ "id": "mattpocock",   "label": "Matt Pocock",   "source": "mattpocock/skills",  "defaultSubpath": null }
// custom: settings.skillCatalogs (per 14):
{ "id", "label", "source", "subpath", "gitIdentityId" }
```

- `GET /api/config/skills/catalog` → `{ ok, sources (each with best-effort
  GitHub `stars`/`repoUpdatedAt`, null on failure), itemsBySource: {} }`.
- `GET /api/config/skills/catalog/source?directory&sourceId&refresh` → scans
  one git source. Pipeline: parse → clone (depth-1, `--filter=blob:none`
  fallback, `GIT_TERMINAL_PROMPT=0`, SSH identity via `core.sshCommand=ssh -i "<path>" -o
  IdentitiesOnly=yes` from the credential-free
  `gitIdentityProfiles: [{ id, name, sshKeyPath }]` instance setting;
  profile paths are absolute local paths without traversal; `identityId`
  plus the resolved profile joins the cache key; unmatched IDs fail closed
  as invalid sources) →
  walk SKILL.md files → items `{ repoSource, repoSubpath, skillDir, skillName,
  frontmatterName, description, installable, warnings }` (invalid names → not
  installable + warnings), enriched with
  `installed: { isInstalled, scope, source }`. Scan cache: key
  `normalizedRepo + subpath + identityId`, TTL 3 h, persisted to
  `skills-catalog-cache.json` (debounced atomic write; only `ok: true`
  cached); global concurrency **2** with per-key in-flight dedupe;
  `refresh=true` bypasses.
- `POST /api/config/skills/scan` — ad-hoc `{ source, subpath?, gitIdentityId? }`
  → same item shape; auth failure → **401** with
  `{ error: { kind: 'authRequired', identities: [{id, name}...] } }`
  (available git-identity profiles for the UI's selector).
- `POST /api/config/skills/install` — `{ source, subpath?, gitIdentityId?,
  scope: 'user'|'project', targetSource: 'opencode'|'agents', selections,
  conflictPolicy: 'prompt'|'skipAll'|'overwriteAll', conflictDecisions }` →
  `{ ok, installed: [{skillName, scope, source}], skipped, restart payload }`.
  - `scope=project` requires a resolvable directory (400); installs into
    `<dir>/.opencode/skills` (or `.agents/skills` for
    `targetSource: 'agents'`); user scope into the managed user skill dir
    (or `~/.agents/skills`).
  - Conflicts are checked **before cloning**: existing same-name skills →
    **409** `{ error: { kind: 'conflicts', conflicts: [{skillName, scope,
    source}] } }` unless the policy/decisions resolve them (per-skill
    decisions override the global policy).
  - Sparse checkout; symlinks rejected (real-path containment); temp dirs
    cleaned in `finally`.
- Error kinds across catalog routes: `authRequired`, `networkError`,
  `conflicts`, `invalidSource`, `unknown`.

### E.5 Skills stores (client)

**useSkillsStore** (src: useSkillsStore.ts) — per-directory caches:

- State: `skills` (ambient directory), `skillsByDirectory` (every loaded
  directory), `selectedSkillName` (persisted), draft, isLoading.
- `loadSkills(directory?)`: 5 s TTL per directory; in-flight dedupe; 3
  attempts (200 ms × attempt backoff); **on total failure keeps the previous
  list** — a failure never renders as "this project has no skills"; applies
  `filterSkillsByRuntimeFlags` (E.2); a generation counter keeps in-flight
  loads from writing into a new instance after a runtime switch
  (`resetForRuntimeSwitch` clears caches: two instances can share a directory
  key). Chat reads the **ambient** directory (active project → harness client
  dir); Settings/browse passes an explicit directory.
- CRUD (`createSkill`/`updateSkill`/`renameSkill`/`deleteSkill`) → invalidate
  the load cache, then handle the three restart payload branches:
  `requiresManualRestart` (upsert/remove locally immediately), **deferred
  restart** (optimistic local mutation + `emitConfigChange` so other stores
  listening on the `skills` scope reload), or `requiresReload` (blocking
  overlay, harness health polling up to 20 s with staged intervals, then
  reload skills and finish).
- Supporting files: read/write/delete through the `files/*` routes; local
  upserts re-derive `group` from the path.

**useSkillsCatalogStore** (src: useSkillsCatalogStore.ts): `sources` seeded
from client fallbacks (the same four curated) and replaced on load;
`itemsBySource` per-source caches + `loadedSourceIds`; 5 s TTL; per-source
in-flight dedupe; 3 s abort timeout on the catalog request; failures keep
previous sources and set `lastCatalogError` (the store never throws —
failures land in `lastScanError`/`lastInstallError`). `loadCatalog({
refresh? })`; `loadSource(sourceId, { refresh? })` (falls back to
`itemsBySource[sourceId]` from the catalog payload when the per-source route
fails); `scanRepo` (sets `scanResults`); `installSkills(request, {
directory? })` (post-success: invalidate skill caches, handle restart
branches, refresh catalog).

### E.6 Skills in the composer

`SkillAutocomplete` shows discovered skills of the **effective directory**
(what the composer sends to — session directory, or the Chats root for a chat
draft), reloading on open to stay fresh; filter `fuzzyMatch(name, query)`;
sort **project scope first, then name**; selection inserts the skill
invocation into the input (rendering per 05). The harness learns of the
invocation from the message text itself
**[HARNESS PORT: skill invocation syntax stays the harness's own]**.

### E.7 Install/update flow (F6)

Catalog page (Skills section; settings surface per 14) → `loadCatalog` lists
sources with GitHub stars/last-push → selecting a source lazy-loads its
scanned items (3 h cache; refresh bypasses) → per item install (pick scope +
targetSource; conflicts dialog: prompt/skipAll/overwriteAll + per-skill
decisions) → POST install → 409 conflicts or 401 identity picker → success
restarts/harness-reloads and refreshes via `loadSkills`. Updating an installed
skill goes through the CRUD routes (E.3), not the catalog — it has no version
notion (one repo head, cache TTL).

---

## F. MCP management

The MCP UI has two halves: **configuration** (which servers exist; stored in
the harness config files) and **runtime status** (what is connected now).
Both are **[HARNESS PORT]** seams.
(src: server lib opencode/{mcp.js,config-entity-routes.js}; useMcpStore.ts;
useMcpConfigStore.ts; components/sections/mcp/*.)

### F.1 Config model and storage

Servers live in the harness config `mcp` map, keyed by server name
**[HARNESS PORT: config-file layers and merge order.]**

| Scope | File | Notes |
|---|---|---|
| user | `<OPENCODE_CONFIG_DIR>/opencode.json` (harness config layer) | write target resolved through the config-layer reader (`getJsonWriteTarget`) |
| project | `<directory>/.opencode/opencode.json` | created on first project-scoped write |

Server names: lowercase alnum + hyphens/underscores
(`/^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/`). Entry shapes (post
sanitization; `name`/`scope` are UI-only fields stripped before writing):

```jsonc
// type local
{ "type": "local", "command": ["npx","-y","server"], "environment": {"K":"V"}, "enabled": true }
// type remote
{ "type": "remote", "url": "https://...", "headers": {"K":"V"}, "environment": {"K":"V"},
  "oauth": { "clientId": "...", "clientSecret": "...", "scope": "...", "redirectUri": "..." } | false,
  "timeout": 30000, "enabled": true }
```

- Remote keeps `url/environment/headers/oauth/timeout(/enabled)`; local keeps
  `command/environment(/enabled)`; `type` forced to `local`/`remote`;
  `environment`/`headers` normalize to flat record<string,string> (blanks
  removed); `timeout` stored only when a positive finite number; **`enabled`
  defaults to true**.
- `oauth`: explicit `false` disables OAuth; an object with any populated
  field is stored; `oauthEnabled: true` with no fields → `{}` (server-default
  OAuth discovery); absent → omitted.

### F.2 Config routes

| Method | Route | Notes |
|---|---|---|
| GET | `/api/config/mcp` | merged entries across layers; each with `scope` (`user`\|`project`) derived from which file supplied the entry |
| GET | `/api/config/mcp/:name` | 404 unknown |
| POST | `/api/config/mcp/:name` | create; body `{ scope?, ...entry }`; duplicate → create throws (500 with message) |
| PATCH | `/api/config/mcp/:name` | update merges into the layer that supplied the entry; unknown → 404 |
| DELETE | `/api/config/mcp/:name` | deletes from its source layer; empty `mcp` map removed |

All mutations **persist to disk immediately but defer the harness restart**:
response is the standard deferred-restart payload `{ requiresManualRestart |
restartDeferred | requiresReload, message, warning?, reloadDelayMs? }` so
settings edits do not interrupt live sessions (explicit "Apply & Restart" per
14/02). The client store refetches `force` after any accepted mutation.

### F.3 Runtime status and control ([HARNESS PORT])

Status per directory via the harness SDK `mcp.status()`:

```jsonc
{ "<serverName>": { "status": "connected" | "failed" | "needs_auth" | "needs_client_registration" } }
```

Actions (harness SDK): `mcp.connect(name)`, `mcp.disconnect(name)`,
`mcp.auth.start(name)` → `{ authorizationUrl }`,
`mcp.auth.authenticate(name)` (native full flow), `mcp.auth.callback(name,
code)` (manual code paste / callback page), `mcp.auth.remove(name)`.

**useMcpStore** (src: useMcpStore.ts) — state maps
`byDirectory`/`diagnosticsByDirectory`/`loadingKeys`/`lastErrorKeys`/
`refreshedAtKeys`, all keyed by normalized directory (backslash→slash,
trailing-slash trim; `__global__` when none):

- `refresh({ directory?, silent? })` — `silent` skips the loading flag;
  failures land in `lastErrorKeys`, not the panel; a generation counter drops
  in-flight writes on runtime switch — status is keyed by directory alone and
  two instances can hold the same path, so `resetForRuntimeSwitch` empties
  everything.
- `ensureFresh({ maxAgeMs, ... })` — deduped refresh when the last successful
  fetch is older than the window (panel remounts do not refetch on every
  session switch).
- Failed connect/auth attempts are stored as per-server **diagnostics**
  `{ status: 'failed', error }`, cleared once the server's next real status
  arrives. `connect/disconnect/completeAuth/clearAuth` refresh silently after
  the action; `clearAuth` also **disconnects** (removing tokens does not touch
  the live session, so the report would otherwise stay `connected`).
- `testConnection(name)` — records prior `connected` state, connects,
  refreshes, and if it was **not** connected before but now is, disconnects
  again (a test must not leave a connection behind; cleanup failure surfaces
  as `warning`). Returns `{ status, error?, warning? }`.
- `computeMcpHealth(statusMap)` → `{ connected, total, hasFailed,
  hasAuthRequired }` (auth-required counts
  `needs_auth | needs_client_registration`).

**useMcpConfigStore** (src: useMcpConfigStore.ts) — config list per directory
(ambient + by-directory maps, 5 s TTL cache, in-flight dedupe), a `mcpDraft`
editing model (draft fields mirror F.1 with `command: string[]`,
`environment/headers` as `{key,value}[]` rows, oauth booleans + fields,
timeout string), and `buildMcpBody` producing the route payload. Persistence:
only `selectedMcpName` (safe storage); configs always refetch.

### F.4 UI and auxiliary flows

- `McpPage`/`McpSidebar` — server list with scope chips, add/edit dialogs
  (local vs remote forms), status dots, per-server test/connect (rendering per
  05/14); `McpDropdown` — quick status in the composer area.
- OAuth: `startMcpAuthorization` opens the authorization URL;
  `McpOAuthCallbackPage` receives `?code=` and calls the callback action;
  `mcpImport` imports server definitions (JSON share format; duplicates fall
  through to update).
- `WorkStatusMcpSection` shows **connected** servers only in work status (a
  disabled server contributes nothing; counting it would contradict the list
  right above).

### F.5 Flow F7 — add a remote MCP server

Add-server form (name, remote, url, optional headers/env/oauth/timeout/scope)
→ `createMcp` POST (F.2) → server writes the entry into the scope's config
file (layer-aware), strips UI-only fields, sanitizes (F.1), returns a
deferred-restart payload → client refetches config (`force`), shows "Restart
to apply"; the eventual harness restart loads it
**[HARNESS PORT: restart/MCP module reload]** → status via useMcpStore
refresh: `needs_auth` → auth flows; `failed` → diagnostics; connected → done.

---

## G. Obligatory context

The system that decides which context the agent **must** see and re-applies it
after compaction. Three moving parts: pinned chat messages in session
metadata, a server runtime watching for compaction, and the project-knowledge
rider that travels with it.

(src: server lib context-obligatory/{DOCUMENTATION.md,runtime.js};
contextObligatoryMessages.ts; systemReminder.ts; contextFileOpenGuard.ts;
outsideFileGrants.ts; server lib markdown-image-grants/routes.js;
markdownImageAssets.ts; chatDirectories.ts; session-ui-store.ts.)

### G.1 Pinned messages

- Pinning a message (user or assistant) stores
  `openchamber.context_obligatory_messages: [{ id, createdAt, role }]`.
- Pin/unpin uses a **fresh-read metadata merge**
  (`withContextObligatoryMessage(metadata, message, pinned)`): read current
  metadata → filter the list by message id → append (pin) or keep filtered
  (unpin) → write the whole metadata back
  **[HARNESS PORT: session metadata PATCH]**. Every reader drops invalid
  entries (id: string, createdAt: finite number, role user|assistant).
- Unpinning is also offered from the work-status section (B.9), which reports
  the pinned count in the context-sources summary.

### G.2 Server restoration runtime (`context-obligatory`)

Subscribes to the harness event hub only; ordinary idle events do nothing. On
`session.compacted` with `properties.sessionID`:

1. Skip while a run for the same session is in flight (per-session set).
2. Fetch the session; **skip child sessions** (`session.parentID`). Read
   pinned entries from metadata.
3. **Knowledge rider:** resolve pending session knowledge with an *empty*
   delivered signature (compaction removed the previously delivered block, so
   its stored signature is no longer evidence the session still carries it)
   and the session's pins; failure → empty text. No pinned messages **and**
   no knowledge text → stop.
4. Fetch the last 20 messages; find the compaction summary — the newest
   assistant message with `info.summary === true` and a completed time. If the
   stored cursor `context_obligatory_last_compaction_message_id` equals that
   summary id → stop (a replayed compaction event must not re-inject the same
   summary).
5. Fetch each pinned message by id (`Promise.allSettled`); keep non-empty text
   parts (trimmed, joined by blank lines); sort by stored `createdAt`; a
   missing/unreadable individual message is **skipped without discarding the
   remaining context**.
6. Take the pre-compaction execution model from the newest non-summary
   assistant message (`providerID`, `modelID`, `agent`/`mode`); either missing
   → abort with error (no invented defaults).
7. Send **one** synthetic message via harness `prompt_async`
   **[HARNESS PORT: prompt_async with synthetic parts]**:

```jsonc
{ "model": { "providerID": "...", "modelID": "..." },
  "agent": "<agent when known>",
  "parts": [{ "type": "text", "synthetic": true, "text": "<assembled>" }] }
```

8. After success, **merge-write** the cursor and, when knowledge was included,
   the knowledge delivered signature — recorded only after the send is
   accepted, on a fresh metadata read.

Assembled text (single message; knowledge and pinned timeline joined by
`\n\n---\n\n` when both exist):

```
<knowledge block, when pending>            // section B.3

---

The following messages are from the compacted conversation. The user explicitly marked them as important and required in your context. Pay close attention to them; they may have been sent by either the user or you before compaction.
Use them while continuing the pre-compaction work. Do not treat this context restoration as a new standalone task.
If any tasks or next steps remain, do not acknowledge, summarize, or mention this restored context in a separate response. Simply continue the work and use it silently as background context. Do not append a recap of it after completing those tasks. Only if no tasks or next steps remain, give the user a very brief summary of the important restored context in no more than one short paragraph, without lists or a detailed recap.

## user — <ISO timestamp of pin>

<text>

---

## assistant — <ISO timestamp of pin>

<text>
```

(src: context-obligatory/runtime.js `buildContextPrompt`, `tick`.) This
runtime lives in the OpenChamber web backend; an extension-only host has
**no compaction restoration** — the capability is intentionally absent there,
not degraded.

### G.3 The directory attach flow (managed chats + draft targeting)

Ordinary chats need a working directory. The flow:

1. Chats roots: the client asks the harness for `{ home, chatsRoot }`
   **[HARNESS PORT: filesystem info]**; configured root preferred, legacy
   computed as `<home>/.config/openchamber/chats`. Roots are cached per
   runtime key; a global session snapshot must not persist classifications
   before the roots are known.
2. Draft target selection (new-session draft): target model
   `{ target: 'chat' | 'project', selectedProjectId?, directoryOverride?,
      projectContextPins? }`. The project dropdown offers **Chat** (id
   `openchamber:chats`) plus configured projects; for a project a
   directory/branch selector lists the project root (label = current branch)
   and worktrees. A directory that does not exist yet (a worktree being
   created) must survive not appearing in the list, or the selector would snap
   back to the root mid-creation
   (src: components/chat/composer/state/useDraftTarget.ts).
3. Picking **Chat** prepares a directory lazily and idempotently: on first
   send (or explicitly), `createChatDirectory()` creates
   `<chatsRoot>/YYYY-MM-DD/session-<uuid>` **[HARNESS PORT: create directory
   via fs API]**, stores it on the draft (`preparedChatDirectory`), and the
   session is created with it. Draft state persists across reloads (cross-ref
   04); a prepared-but-unused directory is cleared once consumed.
4. Failure/cleanup: if session creation fails on a chat draft, the created
   directory is deleted; `deleteChatDirectory` refuses to delete either
   shared root itself or anything outside it.
5. Stale-directory recovery: a directory override recovers to the active
   project's root **only** when the user has not explicitly changed target and
   no worktree request is pending (`resolveCreatableDraftDirectory` probes
   availability; an explicit user change aborts the recovery).
6. Directories are normalized per `useDirectoryStore` rules (G.8) before
   flagging "this is a chat directory" (`isChatDirectoryPath`).

The pin set drafted here rides into session creation as
`openchamber.project_context_pins` (B.6).

### G.4 Context file open guard

Where the context rail renders a file path (tool outputs, chat text), clicking
it must not open something unusable. `validateContextFileOpen(path)`: a known
binary/PDF/image extension → **ok** (FilesView previews or shows its
cannot-preview state; the guard never decodes these as text). Otherwise read
the content (shared files API or `/api/fs/read?path&optional=true&directory=
...`, `no-store`), then: content sniffed as binary text → `'binary'`; line
count > `MAX_OPEN_FILE_LINES` → `'too-large'`; read errors classified —
ENOENT-family → `'missing'`, else `'unreadable'`. i18n messages
`contextFileOpen.failure.tooLarge | missing | unreadable`; binary reuses the
files editor's cannot-preview message. (src: lib/contextFileOpenGuard.ts.)

### G.5 Outside-file grants (desktop)

Hosts may open files **outside the workspace** only with an explicit
host-provided permission token. `resolveOutsideFileReadOptions(path,
workspaceRoot, enabled)`: outside workspace and enabled →
`{ allowOutsideWorkspace: true, outsideFileGrant }`; the grant is requested
from the host (`requestExistingFileAccess`), cached per normalized path per
runtime with expiry minus a 5 s renewal buffer, in-flight deduped, and
re-minted transparently when expired; non-desktop runtimes get no grant; both
the granted and the normalized requested path are cached so either form hits.
(src: lib/outsideFileGrants.ts.)

### G.6 Markdown image grants (rendering agent-authored images)

Assistant messages may embed local images; renderers must not open arbitrary
files, so the server grants per message. **Server**
`POST /api/openchamber/sessions/:sessionId/markdown-image-grants`
(body `{ directory, messageId, sources: string[] (1..12) }`):

1. Validate the directory (server path validation; 400 otherwise).
2. Fetch the message from the harness; must exist, match `messageId`, and be
   an **assistant** message (404 otherwise).
3. **Assistant text is authoritative** — parse the message's text parts for
   referenced images. Two markdown image forms are recognized: inline
   `![alt](destination)` (including `<angle-bracket>` destinations and
   optional titles) and reference form (`[label]: destination` feeding
   `![alt][label]` or bare `![alt][]`). Parsing rules: code fences (toggled
   only by a same-character marker of at least equal length) and inline code
   spans excluded; backslash escaping respected when locating brackets and
   destinations; reference labels normalized (whitespace collapsed,
   lowercased). A source that is not referenced → `status: 'error'` (a remote
   client cannot mint grants for unreferenced paths).
4. Per referenced source: resolve against the directory (or an approved temp
   root for outside-workspace paths — agent work may legitimately build images
   into the OS temp dir); **realpath both sides** (lexical prefixes are not an
   authorization boundary); open with `O_NOFOLLOW`; require a regular file
   ≤ **10 MB** with a PNG/JPEG/GIF/WEBP signature →
   `ready | missing (ENOENT) | error (EACCES/EPERM/ELOOP or anything else)`.
5. A `ready` source **outside the workspace** additionally gets a minted
   path-bound raw-file grant `{ outsideFileGrant, expiresAt }` reused from the
   existing fs-grant mechanism; inside-workspace paths need none.

Response: `{ results: [{ source, status, path?, outsideFileGrant?, expiresAt? }] }`;
whole-route failure → 503.

**Consumer** (src: components/chat/markdown/markdownImageAssets.ts):
`prepareLocalMarkdownImages({ sources, directory, sessionId, messageId })`
calls the route and caches the prepared map (per runtime key + per
`(sessionId, messageId, directory, sources)`; ready entries until the
**minimum grant expiry**, non-ready briefly). Rendering: `http(s)://` and
validated `data:image/*` pass through (local size/signature validation,
≤ 10 MB); **local images refuse to load unless prepared**. VS Code (no
OpenChamber server) walks its local bridge instead: path stays inside the
workspace, `stat` + `/api/fs/raw` with the same caps.

### G.7 `wrapSystemReminder` and where reminders go

`wrapSystemReminder(text)` trims and wraps non-empty text in
`<system-reminder>\n…\n</system-reminder>` (idempotent — already-wrapped text
passes through). Consumers: the goal-arm intro line on session arm (12) and
the response-style instruction the composer appends for style-change sends
(05). A **client-side** convention riding ordinary synthetic parts; the
harness need only transmit message text verbatim.

### G.8 Adjacent, same-named: `contextStore` and `useDirectoryStore`

Not knowledge context — named here to prevent misimplementation:

- **`useContextStore`** (src: stores/contextStore.ts) — per-session UI state,
  not knowledge: model/agent/variant selections per session and per
  session+agent, context-window usage (token estimate from the last assistant
  message against model limits, cached per message id, recalculated when
  limits change), and the per-session agent edit-permission cycle
  (`ask→allow→full`; persisted maps with explicit array-Map rehydration and a
  `hasHydrated` gate; global fallback entry `__global__`). Cross-ref 05.
- **`useDirectoryStore`** (src: stores/useDirectoryStore.ts) — the app
  directory: current + history (back/forward/parent/home); home resolution
  chain (desktop-injected value → persisted storage → harness filesystem home
  → harness system info → process env → cwd → `/`); normalization
  (backslashes→slashes, drive-letter uppercase, trailing-slash trim, tilde
  expansion); persistence of `lastDirectory`/`homeDirectory`; VS Code
  workspace special case; a runtime-endpoint-change subscription re-resolving
  home from scratch (hosts switch in place; the previous host's cached value
  must not survive); directory switches invalidate file-search caches.

---

## H. BTW and session assist

### H.1 BTW — a side conversation forked from the main thread

`/btw <question>` forks the main session and sends the question there. The
fork inherits the full conversation as reference context; the question must
not be derailed by whatever task was in flight.
(src: packages/ui/src/lib/btw.ts, sessionBtwMetadata.ts; useBtwStore.ts;
components/chat/btw/*.)

**Metadata contract** (all under `metadata.openchamber`):

- Parent (the session `/btw` was typed into): `btwSessionID` — link to the
  active fork. The panel is derived from this link: appears only in the parent
  session, follows navigation, survives reloads.
- Fork: **replaces** (not merges) its inherited metadata wholesale with
  `{ kind: 'btw', originalSessionID, btwBoundaryMessageID? }`.
  `btwBoundaryMessageID` is the id of the last message cloned from the parent
  (identity, not an ordering key — message ids can roll over and client clocks
  differ).
- Promotion: the marker is **replaced, not deleted** — `btwPromoted: true`
  remains, because the boundary instructions are permanently in the transcript
  and the session must stay distinguishable from one that was never a side
  conversation.
- Unlink helpers remove `btwSessionID` only when it still points at the given
  fork.

**Creation flow (F8):**

1. Guard `creating` per parent; re-check the runtime key at every await.
2. Fork at the parent's **last completed assistant turn** (not HEAD): `/btw`
   is typically typed while the main thread is working, and forking at HEAD
   clones a still-streaming turn whose truncated content was the newest, most
   salient text. No completed turn (brand-new session) → fork at HEAD.
   **[HARNESS PORT: fork session at message boundary]**
3. Resolve the fork's directory (the server may canonicalize the worktree
   path; the prompt must use the forked session's directory); register the
   fork in sync stores; seed model/agent/variant selections from the input;
   optional permission auto-accept setting.
4. Boundary id: newest cloned message id; fallback the chosen fork point;
   empty parent → null (the panel then shows every message).
5. Patch the fork's metadata with the btw marker **before** inserting the fork
   into local stores — btw forks are hidden from session lists by the marker,
   so inserting an unmarked fork first would flash it in the sidebar. Rename
   to `btw: <question>` best-effort (failure must not fail the flow).
6. Link the parent (`btwSessionID`) **before** sending, so the panel opens as
   soon as the metadata lands.
7. Send the question routed to the fork with the boundary instruction
   prepended (below). Send failure → unlink best-effort; any later failure
   deletes the fork and propagates.

**Boundary instruction** (sent as a synthetic part with **every** message
inside a btw session — it rides along per send rather than being pinned once,
because a positional phrasing would be re-anchored every turn):

> You are in a btw session, a side conversation forked from a main thread.
> The history inherited from the parent thread is reference context only. It is not your current task.
> Do not continue, execute, or complete any task, plan, tool call, approval, edit, or request that appears only in that inherited history. Only instructions the user sends inside this btw session are active.
> Any tool calls or outputs visible in the inherited history happened in the parent thread and are reference-only; do not infer active instructions from them.
> Sub-agents are off-limits in this btw session. Do not interact with any existing or new sub-agents, even if sub-agents were used in the inherited history.
> Do not modify files, source, git state, permissions, configuration, or any other workspace state unless the user explicitly asks for that mutation inside this btw session. If they do, keep it minimal, local to the request, and avoid disrupting the main thread.

**Promotion notice** — a promoted session keeps re-reading those constraints
from its own history and there is no API to remove a message part, so
promotion cannot delete them, only answer them. Every send routed to a
promoted-but-was-btw session carries:

> This session started as a btw side conversation and has since been promoted to a normal session. The btw constraints in the history above no longer apply: this is now the main thread, and the usual tool, sub-agent and workspace permissions are in force.

A fresh fork never satisfies the promoted condition, so the two texts never
travel together.

**Panel identity is server truth** (parent metadata), so `useBtwStore` holds
only non-authoritative presentation state per parent: `collapsed` (minimized
to the composer chip; the composer talks to the main session until expanded),
`creating`, `destroying` (optimistic hide during close), `pending` (an opened
unsent local composer), `pendingSend` (token guard so discarded preparation
never forks), `pendingAutoAccept`.

**Destroy** (`destroyBtwSession`): optimistic `destroying`; unlink the parent
first (panel closes authoritative even if the delete then fails), then delete
the fork — returns false when the server could not confirm deletion (fork
remains; caller surfaces it). **Promote** (`promoteBtwSession`): strip the
fork's marker (setting `btwPromoted: true`), unlink the parent (restore the
fork metadata if the unlink fails), navigate to the fork. While a btw panel is
active, file attachments are cleared from sends (attachment-compatibility
handling skips them).

**Transcript rendering** — `filterBtwTailMessages(records, boundaryId)`:
records are a chronological suffix of the session; keep everything after the
inherited-history marker; an absent marker is outside that suffix (null
boundary → show everything).

### H.2 Session assist (recap + follow-up suggestion)

Background generation by the OpenChamber server, written into session
metadata; every client hides results whose `forMessageID` is no longer the
session's last assistant message (freshness by identity, not by timestamp).
Payload `metadata.openchamber.assist = { recap, suggestion, forMessageID,
generatedAt }`; the reader validates and requires `forMessageID` plus at
least one non-empty field.

Triggers (src: packages/web/server/lib/session-assist/runtime.js):

- Only **live** idle events arm generation; there is no backfill. A
  `session.status` idle event arms a per-session timer (**60 s quiet**);
  any other status invalidates (abort + clear). A user message arriving
  during the quiet window invalidates too (old `message.updated` replays are
  ignored by comparing creation time against the armed timestamp).
- Generation: guard the session is still current (not a child, no revert
  boundary, not archived — a revert clears the boundary before the next
  idle); load assistant turns paged (tail recent turns; char budget from the
  chosen small model minus system prompt and slack); choose the small model
  **preferring the session's own provider/model**, restricted to that
  provider (cross-ref 02 for sizes); expect `{"recap","suggestion"}` JSON
  (fenced-JSON tolerant extraction); timeouts: fetch 5 s, generation 120 s;
  `context-too-small`/`output-exhausted` failures stay quiet.
- Output clamps: recap ≤ **320 chars**, suggestion ≤ **500 chars**; toggles
  `sessionRecapEnabled`/`sessionSuggestionEnabled` (default on; cross-ref 14)
  filter fields; a **script-mismatch guard** drops generated Cyrillic/CJK
  text when the user's own authored language samples do not carry that script
  (quoted source and assistant replies cannot authorize a different script;
  no sample → leave it to the prompt).
- Write guard: only after re-reading that the last assistant message is still
  the one the generation targeted and the session is still the same — never
  fall back to a pre-generation metadata snapshot after a failed fresh read
  (that would overwrite dismissals and unrelated metadata). Merge-write onto
  fresh metadata; newer arming while a generation runs re-arms after
  completion; runtime change aborts. Consumer UI: recap card + suggested
  follow-up filling the composer (rendering per 05).
- Assist results render in the UI and live only in metadata — nothing injects
  them into a session prompt. The server runtimes that **send** anything to
  the harness are: the message queue (queued user messages), scheduled tasks
  (07), context-obligatory (G.2), session-goal (12), and dispatched-session
  prompts (B.6).

---

## I. Snippets, draft starters, magic prompts

### I.1 Snippets

`#name` files expand at send time. Storage:

| Scope | Dirs (preferred first; legacy singular honored when plural absent) |
|---|---|
| global | `<OPENCODE_CONFIG_DIR>/snippets/` (alt `<...>/snippet/`) |
| project | `<dir>/.opencode/snippets/` (alt `<...>/snippet/`) |

Format: markdown files `<name>.md` with optional YAML frontmatter
(`aliases: [..] | alias`, `description`). Name pattern
`/^[a-z0-9][a-z0-9_-]{0,79}$/i`. Loading order user→project with
last-registered winning; aliases registered unless they collide with a real
name; the same file can be visible under both global and project roots only
if duplicated.

Expansion (`POST /api/config/snippets/expand` `{ text }` → `{ text }`):
`#token` references (case-insensitive) replaced recursively; per snippet max
**15 expansions** (loop guard); `<prepend>…</prepend>` and
`<append>…</append>` blocks are hoisted out and joined
`prepend + inline + append` with blank-line separators; `<inject>` blocks are
stripped entirely; `#skill(` is never treated as a snippet (function-call
syntax). Send-path consumers: the composer expand (`expandText`) and the
server-side message-queue/dispatch/scheduled prompts
(src: openchamber-sessions/routes.js ~511, scheduled-tasks/runtime.js
~478/~611) — the registry is re-read per expansion, so a snippet edited
mid-queue applies to later sends.
Routes (all optional-`directory` aware; cross-ref 03):
`GET /api/config/snippets`, `POST /api/config/snippets/expand`,
`GET|POST|PATCH|DELETE /api/config/snippets/:name`; POST existing → 409 (the
client store falls back to update), 400 name/directory errors, 404 not found.

**useSnippetsStore** (src: stores/useSnippetsStore.ts): `snippets` +
`selectedSnippetName` + draft; 5 s load TTL with in-flight dedupe;
`expandText(text)` used pre-send when the text contains `#tag` patterns
(`/#[a-z0-9_-]+/i`); create falls back to update on 409; **no persistence**
(refetched). The composer autocomplete (`SnippetAutocomplete`, 05) lists
snippets by name/alias with known-trigger filtering.

### I.2 Draft starters

Chips pinned to the new-session draft/welcome screen. A starter is a
**reference**, not content: `{ type: 'command' | 'skill', name }`. Scope lives
in where the ref is stored, not in the ref itself — global refs in OpenChamber
settings (14), project refs in project config (projects module).

Built-ins (always pinnable, bespoke icons, seed the default global set):
`explore /explore`, `catch-up /catch-up`, `weigh /weigh`,
`plan-feature /plan-feature`, `craft-goal /craft-goal`,
`schedule-task /schedule-task`, `debug /debug`, `review /workspace-review`
(default global set = all eight). Human labels derive from the name
(`/simplify-code` → "Simplify code"); user-defined starters get fallback
icons (command: terminal-box, skill: book-open). Persisted refs are parsed
defensively (`sanitizeStarterRefs`: valid type + non-empty name, dedup by
`type:name`, malformed dropped). (src: packages/ui/src/lib/draftStarters.ts.)
Execution: clicking a chip inserts the command/skill invocation (or runs
it, per 05); the command bodies are the harness's commands and OpenChamber
magic prompts (I.3).

### I.3 Magic prompts (user-tunable prompt templates)

A catalog of prompt building blocks the UI composes into sends as a visible
message + hidden synthetic instructions. Catalog lives in code
(`MAGIC_PROMPT_DEFINITIONS`); per-id **overrides** live in
`<OPENCHAMBER_DATA_DIR>/magic-prompts.json` via: `GET /api/magic-prompts` →
`{ version, overrides: { id: text } }`; `PUT /api/magic-prompts/:id { text }`
(400 invalid id/empty/too long); `DELETE /api/magic-prompts/:id` (reset one),
`DELETE /api/magic-prompts` (reset all).

IDs come in pairs `<feature>.visible` / `<feature>.instructions`, except five
visible-only ones. Groups: Git, GitHub, Linear, Planning, Session. Full list
(41 ids):

- `git.commit.generate.*`, `git.pr.generate.*`, `git.conflict.resolve.*`,
  `git.integrate.cherrypick.resolve.*`
- `github.pr.review.*`, `github.issue.review.*`, `github.pr.checks.review.*`,
  `github.pr.comments.review.*`, `github.pr.comment.single.*`
- `linear.issue.review.*`
- `plan.todo.*`, `plan.improve.*`, `plan.implement.*`
- `session.summary.*`, `session.review.*` (visible+instructions),
  `session.reviewHandoff.instructions`, `session.reviewSession.visible`,
  `session.reviewSessionWithoutHandoff.visible`,
  `session.reviewFeedbackToImplementer.visible`,
  `session.implementationResponseToReviewer.visible`,
  `session.plan.*`, `session.craftGoal.*`, `session.scheduleTask.*`,
  `session.catchup.*`, `session.debug.*`, `session.weigh.*`,
  `session.explore.*`, `session.fusion.*`

Key semantics:

- `renderMagicPrompt(id, variables)`: effective template = override when
  present else default; `{{placeholder}}` replaced from the variable map;
  overrides fetched once and cached client-side; legacy single-string ids are
  split at the first newline into visible/instructions on read.
- **Instructions are never shown as the user's message** — they are attached
  as `additionalParts` with `synthetic: true` (the send pipeline renders each
  additional part as a synthetic part; visible text becomes the user message).
- Consumers (cross-refs): git generation (visible ask + instructions demand
  strict JSON like `{"subject","highlights"}`), GitHub/Linear review flows
  (review-visible starts a session from issue/PR context), conflict resolution
  (visible + step-by-step guardrails), plan improve/implement/todo (I.5/J),
  session commands ("/summary", "/workspace-review", "/handoff-review" set,
  "/plan-feature", "/craft-goal", "/schedule-task", "/catch-up", "/debug",
  "/weigh", "/explore", fusion), and the auto-review ping-pong messages (12).
- Settings page per id (search ids `magic-prompts.visible-prompt` /
  `.instructions` / `.reset-overrides`); VS Code bridges the same routes via
  its host bridge. (src: magicPrompts.ts; server lib magic-prompts/routes.js.)

### I.4 Plan save queue (data model shared with D/I; rendering cross-ref 06)

`createPlanSaveQueue()` — per-logical-document write queue: `schedule(key,
revision, write)` serializes writes in schedule order and skips revisions at
or below the last queued one (a flush of revision N can never run behind, or
twice behind, a debounced save of that revision); a failed write never
poisons the chain (it clears its own revision watermark so the caller can
retry that exact revision); `pendingFor(key)` awaits the chain (close-time
flushes); `reset(key)` forgets the watermark on fresh load (a stale watermark
must not swallow the first real edit).
(src: packages/ui/src/lib/planSaveQueue.ts.)

### I.5 Todo-related magic prompts

`plan.todo.visible` = `{{todo_text}}` (the todo itself as the visible
message); `plan.todo.instructions` = the synthetic guided-planning prompt
(batch-of-3-questions discovery → outline alignment → final plan);
`plan.improve.*`/`plan.implement.*` take `{plan_title, plan_path}` and
instruct read-file-first behavior with confirm/overwrite rules.

---

## J. Todos pipeline

| | Session todos | Project todos |
|---|---|---|
| Source | harness session state (`Todo` objects from the agent's todo tool) | user's shared list, context.json |
| Store | `useTodosPersistStore` (client cache of the last-seen snapshot) | `useProjectContextStore` (server truth) |
| Scope | one session | one project |
| Field shape | `{ id, content, status: 'pending'\|'in_progress'\|'completed', priority?...}` per harness | `{ id, text, completed, createdAt }` |

### J.1 Session todos cache

`useTodosPersistStore` persists the last-known todos per
`(runtimeKey, normalizedDirectory, sessionId)` under storage key
`openchamber-session-todos`, **version 2** with a blank migrate. Records
`{ todos, touchedAt }`; LRU eviction at **50 sessions** (drop oldest by
touchedAt); an empty array deletes the record (a session without todos must
not keep a stale list). Purpose: the session todo list renders immediately on
switch/remount before the next harness poll lands (rendering per 05).
(src: stores/useTodosPersistStore.ts.)

### J.2 Project todos surface

- `PUT /api/project-context/:projectId/todos` replaces the **whole list**
  (no patch route — a toggle must not persist half-typed notes alongside it,
  and an agent-authored note must not clobber a concurrent todo change). The
  revision compare occurs under the project write lock; stale clients must
  refresh before another whole-list write.
- Client: optimistic save (`saveTodos`) with rollback; completed items sink
  for display only; add/toggle/delete/clear all funnel through the container
  (`ProjectNotesTodoPanel`) because it already holds the display-sorted list.
- Text clamps to 120 (D.3 constants) — matches the server clamp.

### J.3 Flow F9 — send a project todo to an agent

1. Todo row → "send" affordance → `TodoSendDialog` picks target: the
   **current session** (appends a fenced markdown block of the todo text into
   the pending composer input), a **new session**, or a **new worktree
   session** (git projects only; generates a branch name), and model/agent.
2. New session/worktree: `renderMagicPrompt('plan.todo.visible', { todo_text
   })` visible message + `plan.todo.instructions` as a synthetic additional
   part; create session (`createSession(path)` or worktree creator; initialize
   selection store entries; set current session); `sendMessage(visible,
   providerID, modelID, agent, [], [], syntheticParts, variant)`.
3. The created session goes through the standard send pipeline, so session
   knowledge (B.6) attaches normally.
(src: components/session/project-context/useProjectTodoSend.ts.)

### J.4 Linked issues / PRs (metadata on the session)

A session can carry linked GitHub issues/PRs and Linear issues — a
**snapshot** (id, number/identifier, title, url, author, linkedAt), never a
reference; readers drop malformed entries. Stored as
`metadata.openchamber.linked_issues: [ LinkedGitHubIssue | LinkedLinearIssue ]`
with ids `owner/repo#number` (parsed from the URL; fallback `url#number`) and
`linear:<identifier>`; re-linking an existing entry replaces it (refreshing a
stale title); same metadata channel as pinned messages (G.1). Work status
renders them and opens the context-panel Linear view when openable in-panel
(Linear available + connected + not the dedicated mobile shell + a
directory), else a browser tab.
(src: packages/ui/src/lib/linkedIssues.ts; WorkStatusContextSection.tsx.)

### J.5 Auto-review runs (pointer)

`useAutoReviewStore` persists per-original-session review runs
`{ originalSessionID, reviewSessionID, directory, runtimeKey, status:
'running'|'completed'|'stopped'|'error', phase: 'waiting_for_reviewer'|
'waiting_for_implementer', iteration, maxIterations, lastForwardedMessageID,
expectedAssistantParentID, waitAfterCreatedAt?, error? }`; a runtime switch
marks that runtime's running runs stopped. The run loop is doc 12's; its
transfer messages are the magic prompts
`session.reviewFeedbackToImplementer.visible` /
`session.implementationResponseToReviewer.visible` (I.3).

---

## K. Injection matrix and harness ports

### K.1 What enters the model, through which port, when

| # | Content | Trigger | Port | Notes |
|---|---|---|---|---|
| 1 | Session-knowledge block (pinned notes full text; pinned plan bodies; memory title index) | every prompt send whose signature differs from delivered; also scheduled/dispatched sends; also the post-compaction turn | synthetic text part(s) — `synthetic: true`, `systemContext: 'session-knowledge'` | ≤ 8000 chars; not re-sent when signature matches; recorded only after successful send |
| 2 | Post-compaction restoration (pinned messages timeline, possibly + knowledge rider) | harness event `session.compacted` | harness `prompt_async` synthetic part | one message; cursor prevents replay; child sessions skipped |
| 3 | `openchamber_memory` tool | agent call | managed tool (02) → HTTP callback → tool output | bodies only leave the store via `memory.read` |
| 4 | BTW boundary / promotion notice | every send inside a btw fork / into a promoted session | additionalParts synthetic part | per-send by design |
| 5 | Magic prompt instructions (all ids ending `.instructions`) | composed sends (commands, git generation, reviews, plan flows) | additionalParts synthetic part | visible text is the user message |
| 6 | Session-goal arm intro | goal armed sessions (12) | synthetic part wrapped by `wrapSystemReminder` | client-side |
| 7 | Response-style instruction | style-change sends (05) | same wrap (`wrapSystemReminder`) | client-side |
| 8 | Snippet expansion results | `#tag` in sends | substituted into message text (server for queue/dispatch/scheduled; client for direct sends) | max 15 per snippet; prepend/append hoist |
| 9 | Managed tools (`openchamber`, `openchamber_web`) | agent calls | see 02 | listed for completeness of the tool surface |
| 10 | Appl. assist recap/suggestion | idle 60 s (H.2) | **none** — metadata only | never enters a prompt |

### K.2 Consolidated [HARNESS PORT] list

A target harness must expose (names are OpenChamber's; adapt; the managed-tool
trio and the plugin template are owned by doc **02**, this doc inlines only
the memory tool C.5):

1. **Session record with metadata** — create with metadata; read; patch with
   metadata merge (all namespace writes in this doc).
2. **Message send** — explicit parts (text + synthetic markers + attachments)
   for a session/directory, plus a queue-capable delivery mode.
3. **`prompt_async` equivalent** — fire-and-forget synthetic prompt with
   model/agent selection (compaction restoration).
4. **Session events** — `session.compacted` (sessionID + directory); assistant
   `summary` markers with completed time; `message.updated` envelopes carrying
   `directory`.
5. **Message history** — list (limit/pagination) + single message fetch.
6. **Fork session at message boundary** (BTW; review flows too).
7. **Skill discovery + loading** — scan roots per E.1 env-flag semantics;
   SKILL.md frontmatter; built-in enumeration; config `skills.paths`.
8. **Config layers** — user/project config JSON read-merge-write (mcp map,
   skill catalogs, draft starters, `skills.paths`).
9. **MCP runtime** — status; connect/disconnect; OAuth
   start/authenticate/callback/remove; restart after config change.
10. **Small-model generation** — describe + generate, preferred
    provider/model restriction (H.2; sizes in 02).
11. **Managed tool transport** — plugin injection via config-content env +
    loopback HTTP callback with per-machine token (02).
### K.2 Consolidated [HARNESS PORT] list

A target harness must expose (names are OpenChamber's; adapt). Catalog
authority note: the managed-tool trio (`openchamber`, `openchamber_web`,
`openchamber_memory`), their parameter-split rules and the plugin source
template are owned by doc **02**; this doc inlines only the memory tool (C.5):

1. **Session record with metadata** — create with metadata; read; patch with
   metadata merge (all namespace writes in this doc).
2. **Message send** — explicit parts (text + synthetic markers + attachments)
   for a session/directory, plus a queue-capable delivery mode.
3. **`prompt_async` equivalent** — fire-and-forget synthetic prompt with
   model/agent selection (compaction restoration).
4. **Session events** — `session.compacted` (sessionID + directory); assistant
   `summary` markers with completed time; `message.updated` envelopes carrying
   `directory`.
5. **Message history** — list (limit/pagination) + single message fetch.
6. **Fork session at message boundary** (BTW; review flows too).
7. **Skill discovery + loading** — scan roots per E.1 env-flag semantics;
   SKILL.md frontmatter; built-in enumeration; config `skills.paths`.
8. **Config layers** — user/project config JSON read-merge-write (mcp map,
   skill catalogs, draft starters, `skills.paths`).
9. **MCP runtime** — status; connect/disconnect; OAuth
   start/authenticate/callback/remove; restart after config change.
10. **Small-model generation** — describe + generate, preferred
    provider/model restriction (H.2; sizes in 02).
11. **Managed tool transport** — plugin injection via config-content env +
    loopback HTTP callback with per-machine token (02).
12. **Filesystem primitives** — home/chatsRoot info; directory create/delete;
    read/stat/raw APIs with optional-reading and directory scoping.
13. **Model limits metadata** — context/output limits + token accounting
    (usage meter; 05).

---

## L. Edge cases and invariants (cross-cutting)

### L.1 One failed entity never erases unrelated entities

- Project context: per-entry sanitization (D.7); load failure keeps the last
  snapshot; per-field-group commit fusion (a failing note save never reverts
  todos).
- Agent memory: `readAll` scopes fail independently (`globalFailed` /
  `projectFailed`); a scope that failed is **reported, never rendered as
  empty**; one flagged entry never removes others.
- Session knowledge: unreadable memory store still delivers the pinned notes;
  unreadable plan renders a placeholder; unreadable *scope* is omitted from
  the index rather than announced as empty.
- Btw: a failed rename never fails creation; a failed send unlinks and
  deletes the fork; promotion restores fork metadata if the unlink fails.
- Compaction restoration: a missing pinned message is skipped, not fatal;
  missing model info aborts cleanly rather than inventing defaults.

### L.2 Storage versioning and migrations

| Store | Version | Migration |
|---|---|---|
| context.json | 2 | v1 read-path conversion: single string → one `manual` note; absolute plan links → base names (copy-in/unusable-dropped); legacy keys removed from project config only after durable write (repeat reads converge) |
| memory.json | 1 | none yet; sanitize-on-read re-derives `flagged` |
| todos persist | 2 | blank migrate (cache only) |
| magic-prompts.json | `{version, overrides}` | legacy single-string keys split at first newline on read |
| skills catalog caches | TTL files | expiry enforced on read; missing/corrupt treated as cold cache |

### L.3 Privacy

- Notes, todos, plans, memory, snippets, draft starters, magic-prompt
  overrides — all local files under OpenChamber/harness dirs; knowledge
  assembly and the memory tool callback stay on loopback. What crosses to
  model providers is only what the harness sends (prompts, tool output).
- Memory **bodies** reach the model only when the agent reads them; the index
  ships titles. Memory threat patterns (C.6) exist because memory is the only
  externally-writable channel with cross-session permanence; snippets are
  user-authored, not injected externally, so they carry no equivalent guard.
- MCP `environment`/`headers`/oauth secrets live in the harness config in
  plaintext by design (harness contract): never log them; OpenChamber settings
  never include them.
- The desktop outside-file grant keeps files outside the workspace gated
  behind an explicit host permission.

### L.4 Eviction limits (summary table)

| Limit | Value | Enforced |
|---|---|---|
| Knowledge block | 8000 chars (append " (truncated)" marker) | B.3 |
| Notes | 200/project; body 3000; blank rejected | D.3 |
| Todos (project) | text 120; whole-list replace | D.3/J |
| Memory | project 200 / global 60; title 60 (server), body 2000 | C.1 |
| Memory overlap dedupe | ≥ 0.75 token overlap, ≥ 4 tokens | C.2 |
| Image grants | ≤ 10 MB; ≤ 12 sources/request; PNG/JPEG/GIF/WEBP only | G.6 |
| Assist | recap 320 / suggestion 500 chars; 60 s idle quiet | H.2 |
| Snippets | name ≤ 80 chars; ≤ 15 expansions/snippet | I.1 |
| Summary cache (client) | 5 s TTL per (dir, session) | B.9 |
| Skills scan cache | 3 h, persisted; 2 concurrent scans | E.4 |
| Session todos cache | 50 sessions LRU | J.1 |

### L.5 UI state vs persistent store consistency

- Optimistic writes keep a previous-value rollback; committed server context
  is adopted wholesale (the store never splices into a possibly empty local
  list — the caller might be an unmounted panel). Loads never blank on
  failure (project context, memory, skills, MCP status): "empty" is only ever
  an authoritative server answer.
- Load-sequence and per-directory generation counters prevent stale-actor
  writes across runtime switches (project context, memory, skills, MCP, chat
  draft, btw guards).
- Memory viewedAt marks are advanced on exit, not on entry, so the read
  moment is not destroyed by its own acknowledgement.
- Draft state (target, pins, prepared chat directory, permission toggle) is
  part of the persisted draft snapshot (04), so a reload returns to the same
  send surface — a saved plan tab without an owner is dropped (D.8) and a
  pinned memory tab falls back to notes (C.9).

### L.6 Known divergences to decide on reimplementation

- **Memory title clamp mismatch:** the server clamps stored titles to 60
  chars while the panel editor caps input at 120
  (`AGENT_MEMORY_TITLE_MAX_LENGTH`); a >60-char edit truncates silently
  server-side. Pick one number.
- **`pinned` on project plans** exists in the manifest (legacy project-wide
  pin) while sessions own the real attachment state (D.3/D.6) — keep both
  separated exactly as specified, or drop the legacy field entirely.
- **`contextStore` naming:** it is not knowledge context (G.8) — rename it in
  the reimplementation to avoid the trap.

---

## M. Build checklist

Minimum to stand this subsystem up against a new harness (testability order):

1. **Storage layer**: `projectsDir` bounded-stem ids; `context.json` reader
   with v1 migration; per-project write lock + atomic rename; `memory.json`
   store (C.1) with locks; chats-root resolution (A.2).
2. **Project context routes** (D.6) + API client contract (D.8); test the
   missing-vs-malformed distinction and note pin-patch isolation.
3. **Threat patterns** (C.6), exact patterns, run on write + read.
4. **Agent memory routes + action dispatch** (C.8, C.5 behaviors), scope
   resolution (C.4), two-switch gate (C.7).
5. **Session knowledge runtime + routes** (B): signature, byte-exact block
   builder, never-fail GET; verify all four senders run
   resolve→prepend→send→recordDelivered.
6. **Compaction restoration runtime** (G.2) with cursor, single-message
   assembly, rider integration.
7. **`openchamber_memory` managed tool** (02 transport; C.5 schema).
8. **Skills**: scan (E.1), visibility flags (E.2), CRUD routes with restart
   payloads (E.3), catalog + scan + install (E.4), stores (E.5), composer
   autocomplete (E.6).
9. **MCP**: config-layer routes (F.1/F.2), status/control stores (F.3), OAuth
   flows + import (F.4), draft model (F.1 shapes).
10. **Obligatory context**: metadata merge helpers + pin UI (G.1), compaction
    listener (G.2), work-status surfaces (B.9).
11. **BTW** (H.1): metadata contract, fork-at-last-completed-turn, per-send
    boundary/promotion texts, promote/destroy, panel states.
12. **Assist** (H.2): small-model service, toggles, clamps, write guard.
13. **Snippets** (I.1) expansion engine; **draft starters** (I.2); **magic
    prompts** catalog + override routes (I.3); todo pipeline (J.1-J.3) +
    todos persist store; plan-save queue (I.4).
14. **Grants/guards**: context file open guard (G.4), outside-file grants
    (G.5, desktop host), markdown image grants server + consumer (G.6).
15. **Settings wiring** (14): agent memory toggle + availability flag, custom
    skill catalogs, recap/suggestion toggles, draft starters.

---

## Appendix — route inventory by name (reference; master table = doc 03)

- **Agent memory** — `GET /api/agent-memory`, `GET /api/agent-memory/all`,
  `PATCH|DELETE /api/agent-memory/:memoryId`; tool callback (02):
  `POST /api/openchamber/agent-tool`.
- **MCP config** — `GET /api/config/mcp`,
  `GET|POST|PATCH|DELETE /api/config/mcp/:name` (runtime status/control is
  harness SDK only).
- **Project context** — `GET /api/project-context/:projectId`,
  `PUT .../todos`, `POST .../notes`,
  `PATCH|DELETE .../notes/:noteId`, `GET|POST .../plans`,
  `GET|PUT|PATCH|DELETE .../plans/:planId`,
  `POST .../plans/:planId/share`, `POST .../plans/:planId/unshare`.
- **Session knowledge** — `GET /api/session-knowledge`,
  `GET /api/session-knowledge/summary`, `POST /api/session-knowledge/pin`,
  `POST /api/session-knowledge/delivered`.
- **Markdown image grants** —
  `POST /api/openchamber/sessions/:sessionId/markdown-image-grants`.
- **Skills** — `GET /api/config/skills`,
  `GET /api/config/skills/catalog`, `GET /api/config/skills/catalog/source`,
  `POST /api/config/skills/scan`, `POST /api/config/skills/install`,
  `GET|POST|PATCH|DELETE /api/config/skills/:name`,
  `GET|PUT|DELETE /api/config/skills/:name/files/*filePath`.
- **Snippets** — `GET /api/config/snippets`,
  `POST /api/config/snippets/expand`,
  `GET|POST|PATCH|DELETE /api/config/snippets/:name`.
- **Magic prompts** — `GET /api/magic-prompts`, `PUT /api/magic-prompts/:id`,
  `DELETE /api/magic-prompts/:id`, `DELETE /api/magic-prompts`.

---

*End of document 15. Companion docs: 02 (managed tools + harness ports
authority), 03 (master routes), 04 (sync), 05 (chat UI rendering),
06 (plan editor), 07 (actions/schedules execution), 12 (goals + auto-review),
14 (settings).*
