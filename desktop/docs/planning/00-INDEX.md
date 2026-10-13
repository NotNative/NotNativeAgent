# NotNativeDesktop — OpenChamber Cleanroom Build Reference

> **Reference status — 2026-10-01:** This document records OpenChamber behavior.
> Execute [the NND build guide](../build/PLAN.md) and its native-contract amendments.
> Reference auto-accept, managed-harness, TUI, and process-ownership details do not
> override NNA governance or the independent NNA/NND product boundary.
> Use the [document disposition audit](../build/EXECUTION/01-architecture-audit.md)
> and feature coverage guide before treating a reference requirement as executable work.


## 00-INDEX · Master Map

**Purpose.** This directory is a complete, self-contained re-implementation specification for
[OpenChamber](https://github.com/openchamber/openchamber) — an open-source workspace for running
and reviewing AI coding agents — produced so that a new team can rebuild its UI, UX, and
functionality on **their own agentic harness** (an OpenCode replacement) **without reading the
OpenChamber source**. Every doc here was written under that cleanroom rule: each contract is
spelled out inline; `(src: ...)` citations point back into the reference repo for traceability
only.

**Provenance.** Derived by read-only static analysis of OpenChamber monorepo at
version **1.23.0** (folder layout as of 2026-09-14). Harness integration facts were verified
against `@opencode-ai/sdk@1.18.30` type definitions. **Nothing was executed against a live
server or harness** — all contracts come from source/docs/tests reading. See "Declared gaps"
below for what each author flagged as approximated.

**Adaptation thesis.** OpenChamber is architected as: shared React UI (`packages/ui`) +
OpenChamber web server (`packages/web`) + thin native shells (Electron / VS Code / Capacitor).
Its server talks to OpenCode over a narrow REST+SSE surface, and the UI talks to the server.
When replacing OpenCode, the work concentrates on the seam catalog in
`02-opencode-harness-contract.md`; most UI, sync, and shell behavior is inspiration to
re-express against NNA, never code to copy. NNA remains the architectural authority:
NND is its installable GUI web-service integration package, and Electron is a shell
that renders the same web GUI. See ADR 0020 and `docs/build/NOTES/16-architecture-and-upstream-alignment.md`.

---

## 1 · Doc Map

| File | Lines | Domain — the questions it answers for an implementer |
|---|---|---|
| `01-architecture-and-app-shell.md` | 1341 | What the system is: package topology, the shared-UI adaptation layer (bridges, window globals), boot sequences for all five runtimes, app shell regions, URL routing, surface/runtime switching, PWA/install/update contracts, build & dev pipeline |
| `02-opencode-harness-contract.md` | 1484 | **The seam catalog.** Browser→server→harness two-tier contract; 47 browser SDK call rows + 21 server-side call rows; ~60 event types with wire examples; session/message/part/permission/question shapes; managed-vs-external mode matrix; 24 catalogue ports (P-01…P-24) a replacement harness must satisfy; injections (agent tools, system-prompt, knowledge/goal); minimal & full compatibility checklists |
| `03-server-and-api-reference.md` | 2028 | The OpenChamber server: boot/middleware/static serving, the complete `~253`-route table across 40 modules, fs/git/projects/auth deep specs, on-disk data layout, complete env-var table, full CLI spec (commands, flags, `--json`/`--quiet`, exit codes), startup services |
| `04-sync-and-state-engine.md` | 1653 | The client state machine: event pipeline → reducers → stores; bootstrap/reconnect/recovery sequences; optimistic sends + failure taxonomy; message ordering; retention/eviction; persistence keys; streaming representation; the sync correctness invariants with their enforcing mechanisms |
| `05-chat-and-session-ui.md` | 1957 | The chat product: composer control-by-control, message-part renderer catalog, work-status derivations (exact label strings), sidebar/session management UX, question & permission flows, usage/quota UI, command palette, empty/loading/error states per surface |
| `06-code-review-surfaces.md` | 1693 | Reviewing work: file browser + editor (CodeMirror6 config, autosave), Pierre-based diff system (hunk model, navigation, scroll anchoring), Git view action inventory, worktrees, Plan view, PR/Linear UX, inline comments + review flow, caching/invalidation triggers |
| `07-terminal.md` | 1316 | The terminal: v3 wire protocol (frames, keepalive timings), PTY lifecycle per platform (ConPTY/bash-pty patches, shell fallback chains), ghostty/vt renderer integration, IME/mobile input, reattach across devices, project-action execution flows, buffer/security invariants |
| `08-remote-access-and-security.md` | 2389 | Getting connected: full auth model (password scrypt/JWT, passkeys, URL/device tokens), complete E2EE private-relay spec (transcribed crypto, frames, flow control), tunnel providers/modes/profiles, pairing + `openchamber://connect` link format, SSH machine model, reverse-proxy requirements, threat matrix per transport |
| `09-electron-desktop-shell.md` | 1762 | The desktop shell: main process + in-process backend hosting, 60+ IPC/bridge commands with the security gating model, window/Mini Chat management, embedded browser panel security policy, SSH manager internals, full updater pipeline per platform, tray/menus/notifications/deep links, packaging matrix, renderer recovery |
| `10-vscode-extension.md` | 1786 | The extension: manifest contribution surface (commands/config/menus/l10n), webview message catalog (both directions), bridge runtime catalog (fs/git/settings/sseProxy/...), in-editor OpenCode lifecycle + upgrade, worktree bootstrap, quota provider matrix, CSP/asset strategy |
| `11-mobile-surface.md` | 1483 | Mobile: hosted mobile-web surface (tablet size classes, session tree, keyboard choreography, touch terminal) + Capacitor shell (plugin matrix, iOS/Android manifests, push notifications, deep links, pairing, secure token storage), serve-sim dev loop |
| `12-autonomy-and-orchestration.md` | 1651 | Making agents finish work: Session Goals (state machine + auditor exchange, verbatim), Scheduled Tasks (claim protocol, cron/DST semantics), Message Queue (both sides), Multi-run + Fusion (worktree fan-out, compare, adoption), orchestration glue, failure matrices |
| `13-preview-and-inspection.md` | 1075 | Seeing the work: dev-server discovery (`lsof`/`netstat`/proc heuristics), preview embedding UX, browser-control inspection protocol (element capture → payload → agent tool), Changes Walkthrough pipeline (system prompt + response schema, stage/step model), dev tunnels, security model |
| `14-theme-settings-system.md` | 1553 | The look & configuration: full token table (light/dark), 38 preset themes + custom-theme import format (transcribed), primitive/component inventory, icon + sprite system, ~160-key settings registry with snapshot generation + gate flow, settings page tree control-by-control, 12-locale i18n, 38 shortcut bindings |
| `15-knowledge-context-skills.md` | 2000 | Institutional memory: session knowledge blocks, agent memory (`openchamber_memory` tool, dedupe, threat rules), project context (`context.json` v2), skills catalog + lifecycle, MCP config layers, obligatory-context enforcement (dir attach, file grants, reminders), BTW/assist channels, snippets/starters/todos, prompt-injection matrix |

**Total: 15 docs, 25,171 lines (~2.1 MB).**

## 2 · Ownership Map (single canonical owner per cross-cutting mechanism)

Cross-references between docs follow these assignments. A doc may *reference* another's
contract but only the owner specifies it:

| Mechanism | Canonical owner |
|---|---|
| Harness seams, SDK calls, event shapes, tool injections, port catalog (`P-xx`) | **02** |
| Master HTTP route table, CLI, env vars, disk layout | **03** |
| Boot flows, runtime adaptation matrix, bridge/port interfaces at shell level | **01** |
| Client sync event pipeline, store semantics, reconnect/retention/optimistic taxonomies | **04** |
| Chat/message part inventories, status labels, composer behavior, question/permission UX | **05** |
| Diff data model + diff-viewer contract (Pierre), file browser, git/comment UX, invalidation triggers | **06** |
| Terminal wire protocol, PTY lifecycle, renderer | **07** |
| Relay E2EE, tunnels, pairing/link formats, auth/token model | **08** |
| Electron IPC + security policy, updater, tray/deep links | **09** |
| VS Code webview protocol + bridge + manifest | **10** |
| Mobile native layer, tablet layout, pair/touch UX deltas | **11** |
| Goals/scheduled/queue/multi-run-fusion semantics | **12** |
| Dev-server discovery, inspection payloads, walkthrough pipeline | **13** |
| Theme tokens, custom-theme format, settings registry, shortcuts, i18n | **14** |
| Knowledge/memory/context/skills storage + injection matrix | **15** |

## 3 · Suggested Reading Order

Repeated tools and skills are appended automatically.

Tier 1 — spine (read before anything else):
1. `00-INDEX.md` · 2. `01-architecture-and-app-shell.md` · 3. `02-opencode-harness-contract.md`

Tier 2 — product core:
4. `04-sync-and-state-engine.md` · 5. `05-chat-and-session-ui.md` · 6. `03-server-and-api-reference.md`

Tier 3 — by build-plan need, all standalone:
`06` (review) · `07` (terminal) · `12` (autonomy) · `15` (memory/context) · `13` (preview) · `08` (remote) — and shells `09 / 10 / 11` if you target those surfaces · `14` for the design-setttings base of everything above.

## 4 · Working Glossary

| Term | Meaning in OpenChamber |
|---|---|
| **Harness / harness port** | OpenCode, the external agentic backend (`P-xx` ports in 02). Replacement point for your own harness. |
| **Session** | A conversation with work context, bound to a directory (may live in a worktree). |
| **Worktree** | Git worktree; sessions can be created in isolated worktrees (multi-run, move-to-worktree). |
| **Live activity** | Session state derived from live channels (SSE/WebSocket), never from persisted history. |
| **Steering** | Sending a message while the agent works; OpenChamber either steers the in-flight turn or enqueues it. |
| **Part** | A rendered unit of a message (text, reasoning, tool call, todo, question, …). |
| **Permission / Question** | Harness-emitted blockers the UI must surface; auto-accept policy is a product feature. |
| **BTW** | Side-channel assistant queries (small model) alongside the main session. |
| **Session Goals** | Server-side loop: after each turn a small model audits progress and decides continue/stop/blocked, subject to limits. |
| **Multi-run / Fusion** | Same prompt to up to 5 models (optional per-run worktree) — then adopt a result or fuse strongest parts into a new session. |
| **Walkthrough** | AI-generated guided tour of a large diff, grouped into ordered steps. |
| **Preview / Inspection** | Embedded browser of the user's dev server; element selection captures screenshot/styles/errors back to the agent. |
| **Relay** | Private relay: end-to-end encrypted remote access without exposing ports. |
| **Connect link** | One-time `openchamber://connect?...` link used to pair devices/instances. |
| **Instance** | A server (local or remote) a client connects to; Desktop tracks several. |
| **Managed vs external OpenCode** | Spawned-and-driven by OpenChamber (full features: tools, goals, restart) vs pre-running external server (restricted matrix in 02). |
| **Mini Chat** | Small Electron chat window outside the main app. |
| **Registry snapshot** | Generated settings-registry JSON shared by web + VS Code (gate flat: don't hand-edit). |

## 5 · Consolidated Declared Gaps

Each doc's author flagged approximations. Treat these as review points before relying on the
stated behavior, and as polish targets for your own implementation (several are behaviors
*you may choose to improve* rather than replicate):

| Doc | Gap | Implication |
|---|---|---|
| all | Static analysis only — no code executed | Wire-level quirks (exact error bodies, timing jitter) are contract-level, not observed |
| 02 | Open-record events (`models-dev.refreshed`, `reference.updated`, `lsp.updated`) documented as opaque | Consumers treat them opaquely; a replacement harness may keep them opaque too |
| 03 | GitHub route responses summarized (mirror Octokit); some CLI output fields summarized | Re-implementers map to their own GitHub client; field-exactness here is low-risk |
| 06 | PierreDiffViewer spec'd at prop/option level (Pierre is an external lib) | You may substitute your own diff renderer behind the documented data model |
| 07 | Ghostty ABI option offsets tied to a pinned artifact revision | Re-derive renderer ABI if you swap or upgrade the renderer |
| 08 | Relay broker worker internals inferred from client/host behavior (broker is a separate project) | Contract asserted, not source-verified; validate during your relay build |
| 09 | SSH probe shell one-liners semantic, not verbatim; some Electron-version quirks flagged for revalidation | Preserve intent; re-measure timeouts on your runtime |
| 10 | `opencodeConfig.ts` (3277 lines) specified at contract level, not field-by-field; skills install mechanics summarized | Enough to rebuild flows; deep-field parity needs a follow-up pass |
| 11 | Android manifest lacks a custom-scheme intent-filter upstream (push-tap path is the working deep link) | Documented as-is; add your own scheme deliberately |
| 12 | 30-min watchdog records error but does not abort the session (inherited quirk); multi-run has no server-side persistence — grouping inferred from session titles; fusion prompt templates referenced by name | Candidates to harden in your implementation; template bodies live in locale/settings system (14/15) |
| 13 | i18n copy + TOC CSS not transcribed; delegated to 06/14 owners | Copy strings come from your i18n build anyway |
| 14 | 38 preset theme JSON bodies catalogued but not transcribed; settings-search item list summarized by pattern | Preset themes: import/derive from the custom-theme format spec; search list rebuilt from your own registry |
| 15 | Magic-prompt template bodies catalogued by id; VS Code MCP share format and skill `sources` field lists summarized; small-model size table deferred to 02 | Template bodies are product copy — you will author your own |

## 6 · Drift Note

These docs describe the baseline repo as of **v1.23.0 / 2026-09-14**. The separately
recorded v2.0.1 product-delta audit is not a replacement for that baseline. If your reference checkout moves,
re-run the affected deep-dive rather than patching prose. Docs intentionally avoid restating
how features *should* work — they state how this codebase *does* work, except where a doc
explicitly names a "hardening candidate" (§5) as a deviation you may take.
