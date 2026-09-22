# GUI-PLAN — Wanted vs Implemented Gap Map & Slice Plan

**Status:** living document (v1). Owner: the GUI bring-up effort.
**Inputs:** `docs/planning/*.md` (cleanroom spec of OpenChamber v1.23.0),
workspace `D:\ProjectRepo\NotNativeDesktop` (implementation), reference
checkout `D:\ProjectRepo\External\openchamber` — **READ-ONLY** (never modify;
this plan writes documents only).

**Purpose:** single source of truth for closing the gap between what
NotNativeDesktop WANTS to be (per the cleanroom docs) and what exists today,
and for driving the "fully functional GUI" implementation slices by pulling
from the verified reference source layout.

## Section files

| # | File | Content |
|---|---|---|
| 1 | [GUI-PLAN/SECTION-1-feature-inventory.md](GUI-PLAN/SECTION-1-feature-inventory.md) | **Wanted feature inventory** — the acceptance list: every user-facing capability the planning docs want, with doc+§ citations and stable ids `W-01…W-115` |
| 2 | [GUI-PLAN/SECTION-2-current-state.md](GUI-PLAN/SECTION-2-current-state.md) | **Current state** — verified entry flow, what renders first, why the installed app looks almost empty, implemented/unimplemented/implemented-but-unwired tables (with file:line citations) |
| 3 | [GUI-PLAN/SECTION-3-reference-map.md](GUI-PLAN/SECTION-3-reference-map.md) | **Reference map** — per capability, the OpenChamber package + file path that implements it and what to port (UI component or server lib); bonus capabilities; deliberate deltas |
| 4 | [GUI-PLAN/SECTION-4-slice-plan.md](GUI-PLAN/SECTION-4-slice-plan.md) | **Slice plan** — ordered slices, per-slice user-facing acceptance guarantee, file targets, harness seams real vs mock, ordering constraints; SLICE-A labeled |

## Conventions

- Wanted capabilities carry stable ids `W-xx` (Section 1) so slices reference
  them directly.
- "Harness" = our agentic backend behind `packages/web/src/server/harness/*`.
  Objective adapter name: NotNativeAgent "NNA" (`NOTNATIVE_HARNESS=nna`).
  Contract owner: `docs/planning/02-opencode-harness-contract.md` (port
  catalog P-01…P-24). Today only `harness/mock` is registered
  (`packages/web/src/server/index.ts:21–25`).
- Reference citations in Section 3 use `OC:` as a shorthand for the
  read-only root `D:\ProjectRepo\External\openchamber`.
- All line numbers are from the current checkouts (2026-09-22).

## Section 4 slice plan (ordered), summarized

- **SLICE-A — "Alive session"** (`chat-alive`) *(smallest slice that makes the
  installed app look ALIVE)*: real streamed session end-to-end — open the
  mock-seeded session on boot, render streamed deltas live, run a real turn
  (prompt_async → session.next.* → part → settle), abort/retry, sessions
  restore after reload. No new harness work beyond what the mock already
  speaks; ship against `NOTNATIVE_HARNESS=mock`.
- SLICE-B (`review-band`): review surfaces default-converged with the
  implemented fs/git/diff/terminal stack; FilesView/DiffView/GitView stop being
  toggles and get real demand-driven bootstrapping + invalidation.
- SLICE-C (`session-product-b`): the rest of the doc 05 chat product on the
  mock (part renderer catalog incl. tool cards, permission/question flows,
  fixed sidebar, folders/archive, AI rename, timeline dialog), plus the
  session-mutations the server already lacks (PATCH rename channel).
- SLICE-D (`autonomy`): message-queue UI on the existing server runtime,
  goal routes + runtime + UI, scheduled tasks (server + UI), multi-run/fusion;
  wire the `openchamber:*`→`notnative:*` control events these need.
- SLICE-E (`nna-real`): the NNA harness adapter behind the seam (doc 02 P-list,
  minimal checklist first) — real streamed model output replaces the mock echo;
  fs/git/goals/keep tools go real.
- SLICE-F (`settings-shells`): settings parity (registry snapshot pipeline,
  pages for relay/tunnel/instances), Electron shell completion (deep links,
  tray/notifications, updater, geometry restore), notifications pipeline.
- Slice G (later/approve-gated): walk-through/preview/inspection stack
  (13), knowledge/memory/skills/MCP (15), relay UX completion, Mini Chat,
  i18n completeness (12 locales), shortcut parity (38 bindings).

Ordering hard rules: SLICE-A first (it is the acceptance hinge for everything
UI-visible). SLICE-B/C both depend on A's streaming loop only. SLICE-D needs
A + (for scheduled task runs) a real NNA. SLICE-E is required before D's
goals/scheduled runs produce real work and before F's notifications carry
real identity. Details and per-slice acceptance guarantees: SECTION-4.

## Non-goals / tracked separately

- VS Code extension (doc 10) and mobile/Capacitor surface (doc 11) have their
  own acceptance lists in their docs; this plan covers the Desktop/Web GUI +
  server + harness seam they share.
