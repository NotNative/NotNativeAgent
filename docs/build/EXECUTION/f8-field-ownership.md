# F8 field-ownership map — knowledge, context, memory, skills, MCP

Status: `implemented-unverified` for every row until an installed run observes
it (see [DEFERRED-VERIFICATION](../../DEFERRED-VERIFICATION.md)). This map is
the F8.1 artifact: for each field family, who owns the durable record, what
scope it lives in, where the value comes from, and which GUI surface renders
it. Explicit notes are kept distinct from agent memory throughout — notes and
plans are user-authored documents; memory is what the engine recorded.

Legend: **Owner** = the process whose store is authoritative. **Writer** = the
only code path allowed to change it. NNA stays READ-ONLY in this repository;
NND never writes NNA files directly.

## 1. Session organization (BTW, pins, identity) — NND-owned

| Field | Owner / record | Writer | Scope | GUI |
| --- | --- | --- | --- | --- |
| BTW child marker (`btwMarker`) | NND `packages/web/src/server/routes/session-org.ts` over `<dataDir>/session-org.json` | `btw.setMarker` op (explicit `promoted` override supports rollback) | per directory + session | `chat/btw-panel.tsx` |
| BTW parent link (`btwChildOf`) | same store | `btw.setChild` / `btw.clearChild` ops | per directory + session | `chat/btw-panel.tsx`, `chat-view.tsx` |
| Message context pins (`messagePins`) | same store (empty write is a tombstone) | `pins.setMessages` op via `chat/context-message-pins.ts` queue | per directory + session | transcript pin buttons, work-status panel |
| Project context pins + delivered signature (`contextPins`, `knowledgeSignature`) | same store | `pins.setContext` op via `server/session-knowledge/knowledge-runtime.ts` (serialized per session) | per directory + session | knowledge summary routes; no direct pin editor |
| Multi-run identity (`multiRun`) | same store | `multiRun.set` op from `lib/multirun/create.ts` (title parse stays the fallback) | per directory + session | multi-run launcher/fusion dialog |
| Legacy metadata fallbacks (`openchamber.*` in session metadata) | NNA session metadata, written only through the harness PATCH | legacy read paths in `chat/btw-org.ts`, `chat/context-message-pins.ts`, `session-knowledge/metadata.ts` | per session | none (read-only fallback) |

Provenance notes: the session-org store is the single NND-owned durable
record; native session PATCH accepts only title/archived-time, so no NND
feature may ride session metadata anymore. New writes must add a store op,
and the family must be added to `native-alpha-surface.ts` CLOSED_FAMILIES
when it is NND-owned and mutable.

## 2. Session knowledge assembly — NND-assembled, NNA-sourced inputs

| Field | Owner | Writer | Scope | GUI |
| --- | --- | --- | --- | --- |
| Pinned note/plan blocks, memory blocks, delivered signature gating | NND `server/session-knowledge/knowledge-runtime.ts` | assembly only; delivery recorded into the session-org store (§1) | per project + session | `chat/session-knowledge-summary.ts`, knowledge summary route |
| Project id resolution | NND harness project route | read-only | per directory | — |
| Notes/plans content | NND `server/project-context/context-store.ts`, `plan-store.ts` | NND stores (§3) | per project | context pages |

## 3. User-authored notes / plans / todos — NND-owned documents

| Field | Owner | Writer | Scope | GUI |
| --- | --- | --- | --- | --- |
| Project notes (`context-store.ts`) | NND `server/project-context/` | context store save path | per project (projectId) | context management pages |
| Plans (`plan-store.ts`, `shared-plans.ts`) | NND `server/project-context/` | plan store save path; `legacy-plan-migration.ts` migrates atomically and keeps originals on validation failure | per project | plan surfaces |
| Todos (`todo-schema.ts`) | NND | todo schema writers | per project/session | work-status panel rows |

Explicit notes/plans are user documents; they are pinned into knowledge
through §1 context pins and must never be merged into engine memory.

## 4. Agent memory — engine-affecting, NNA-native operations

| Field | Owner | Writer | Scope | GUI |
| --- | --- | --- | --- | --- |
| Memory entries | NNA memory store via native memory operations | NNA memory tool; NND only calls the native operation | global + per project | memory surfaces |
| Ownership classification | NND `server/project-context/agent-memory-ownership.ts` | read-only classification | per entry | — |
| Enablement | NND `server/project-context/agent-memory.ts` (`agentMemoryEnabled`) | settings | per product | settings |

## 5. Skills — NNA-native inventory, management in progress

| Field | Owner | Writer | Scope | GUI |
| --- | --- | --- | --- | --- |
| Skill catalog / installed inventory | NNA native skills routes (catalog read) | NNA | user/project scope | settings skills page |
| Install / remove / edit | NNA-side gap (catalog-only route today) | — | — | — |

No NND code may write OpenCode skill directories and present the result as
applied to NNA; the legacy OpenCode writer path is mock-runtime-only.

## 6. MCP configuration — NNA-native, read-projected

| Field | Owner | Writer | Scope | GUI |
| --- | --- | --- | --- | --- |
| MCP server inventory / status / presence | NNA native MCP routes projected by NND `nnd-mcp` projection | NNA | per config scope | settings MCP page |
| MCP save / preview | NND native MCP API `POST /v1/nnd/configuration/mcp` (`mcpSave`/`mcpPreview`/`mcpOperation`) | native editor only | per config scope | native MCP editor |
| OAuth / import / env fields | NNA-side gap (not implemented in `nnd-*-routes`) | — | — | — |

A configured server and a connected usable tool are different states; the GUI
must never label configuration saved as tool connectivity.

## 7. Obligatory context / grants

| Field | Owner | Writer | Scope | GUI |
| --- | --- | --- | --- | --- |
| Context-obligatory ports | NND `server/context/nna-context-obligatory-ports.ts` | NNA-native context delivery | per session | composer band recap |

Bounded assembly, stable content identities across compaction, and
no-duplicate-on-reconnect are acceptance properties of §2 + §7, owned by the
session knowledge assembly and its delivered signature.
