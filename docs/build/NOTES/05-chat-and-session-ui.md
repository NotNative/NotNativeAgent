# NOTES 05 — Chat & session UI (from docs/planning/05)

> **Historical implementation note — 2026-10-01:** Retained for contracts and dated evidence.
> Current scope, ownership, remaining work, and acceptance are defined by
> [PLAN](../PLAN.md) and the [execution audit](../EXECUTION/01-architecture-audit.md).
> Old mock-only, auto-accept, lifecycle, and deferral instructions are superseded.
> A recorded test pass is limited to its stated version and surface.


## A. Scope decisions for the P3 split (implementation deltas vs spec)

The doc is 1,957 lines; chat ships in stages and NOTHING below relaxes the
contracts — this file records what lands per stage and why.

- **P3a (this slice)** — the chat product spine: session view + timeline
  (turn projection, sorted/live, streaming tail), composer (prompt language,
  keyboard policy, submit assembly, queue/steer, blocked-send, draft
  identity/persistence, input history), part catalog + tool cards (plain
  bodies; rich diff chunk defers to P6), status chip (§E.1 derivation incl.
  retry/waiting), question/permission cards (§F bodies + keyboard + send-while-
  blocked), sidebar v1 (zones/search/actions subset), header session tabs,
  engine mount + App rewire (P1 interim stores retire).
- **P3b** — model/agent pickers full UX (favorites/reorder/effort/tooltip),
  draft welcome chips + starters, timeline dialog, prompt navigator rail,
  BTW/fork/peek modes, multi-run entries, export/share, AI rename, dictation.
- **P3c** — work-status panel full contract (§E.9), usage readouts (§G),
  Doc E.2 recap/suggestion surfaces, Mini chat + embedded subagent surfaces.
- P5 (doc 14) owns theme tokens; P6 owns rich diffs; P7 owns terminal; i18n
  catalog lands at P5 — P3a ships English strings inline (label keys recorded
  in code comments only where contract-relevant).

## B. Branding + harness-port mapping applied

- "OpenCode" → the harness (NNA); metadata namespace `metadata.openchamber.*`
  → `metadata.nnd.*` with the same field families (btw link, assist, pins);
  linked issues/PR tracked per doc 06+.
- Part taxonomy = OpenCode's (text/reasoning/tool/step-start/subtask/file) —
  the mock harness already produces LF-8 shapes; renderer roles per §0.3 with
  unknown-safe filtering.
- Status phrases (§E.1) implemented verbatim as the status-chip derivation.
- Tool taxonomy per mock LF-8 (read/write/edit/bash/grep/glob/task/question);
  unknown → "using {tool}"; unknown part types render nothing (never throw).

## C. Contracts read off the ADR-0020 world (no re-decisions here)

- Sessions the UI renders come from the engine's directory child store
  (P2/doc 04); the renderable gate is the loader renderable rule.
- Turn state remains `SessionStatus` + streaming store until PA0020 swaps in
  projection frames; the mapping surface lives in `status-chip.tsx` only —
  one file to retarget.
- Question/permission replies ride engine actions (ownership routing per doc
  04 §E.4); session auto-accept store lands with P4+ (policy surfaces); the
  composer shield toggles per-session auto-accept flag that drafts transfer.

## D. Engine support deltas folded in (from the P2 review register)

- P2-4 partial: streaming reconcile now hooks `session.status` (busy) and
  settled paths in `engine-side-effects.ts` (was settle-only).
- P2-11 partial: `session-ordering.ts` comparator drops the `time.updated`
  tie-break (baseline desc → created desc → id asc, per §F.10).

## E. Deferred with a halo (not silently skipped)

- Unit: `CodeMirror` editor → textarea v1 (1 text doc; paste/drop/mentions
  work on plain text; IME/caret-measure rules noted for editor swap).
- Queue is client-held (draft store) until doc 03's server-owned queue (§B.10)
  lands; semantics identical at the UI layer, keys already namespaced.
- Dictation, usage quotas (needs quota provider registry from doc 02 P-13),
  onboarding (runs only when harness unreachable — current recovery screen is
  the ground), mini chat (doc 09 shell), embedded subagent iframe.
- Session row full context menu inventory (§D.6) — v1 ships: rename, copy id,
  archive, delete, pin (persisted), share/export/assist defer.
