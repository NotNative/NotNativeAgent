# NotNativeDesktop — Build Plan

Cleanroom re-implementation of OpenChamber per `docs/planning/`. Harness strategy: the
agentic backend will be **NotNativeAgent (NNA)**, integrated later; until then the app
runs against a **mock harness** implementing the doc-02 wire contract. Seam isolation is
mandatory: all harness traffic flows through the server's `harness/` adapter so an NNA
adapter drops in without touching UI/sync code.

Ordering (user-approved): suggested reading order, shells limited to Electron.
VS Code (10) and Mobile (11) are **long-term deferred** — their contracts stay noted in
doc summaries but no code is written for them.

## Phases

| Phase | Source doc(s) | Deliverable / verification gate |
|---|---|---|
| P0 Scaffold + app shell | 01 | pnpm monorepo; web server boots (health/auth-session/SSE control); UI boots to initialized shell (splash→sidebar/header/chat placeholder); vitest passes; `pnpm dev` loop verified |
| P1 Harness seam | 02 | `harness/` adapter implementing P-01…P-24 ports in mock form; SDK-facade client in UI (`{data,error}` convention, `/api` base, directory scoping, event stream); wire examples from doc 02 as fixtures |
| P2 Sync/state engine | 04 | Event pipeline → reducers → stores; bootstrap/reconnect/recovery; optimistic sends + failure taxonomy; ordering; retention; persistence keys; correctness invariants tested |
| P3 Chat UI | 05 | Composer, message-part renderers, work-status labels, sidebar/session UX, question/permission flows, command palette |
| P4 Server surface | 03 | Route table (~253) implemented in layers as UI needs them; fs/git/projects; disk layout; env table; CLI (`notnative`) with `--json/--quiet`, exit codes |
| P5 Themes/settings | 14 | Token table, theme system, settings registry + snapshot gate, shortcuts, i18n scaffold (en first) |
| P6 Review surfaces | 06 | File browser/editor (CM6), diff system, git view, worktrees, plan view, inline comments |
| P7 Terminal | 07 | v3 wire protocol, PTY lifecycle (Windows ConPTY path), xterm renderer (ghostty evaluated), project actions |
| P8 Autonomy | 12 | Session goals, scheduled tasks, message queue, multi-run/fusion |
| P9 Knowledge/context | 15 | Knowledge blocks, memory tool surface, project context, skills, MCP config, snippets |
| P10 Preview/inspection | 13 | Dev-server discovery, preview embedding, element inspection, walkthrough pipeline |
| P11 Remote/security | 08 | Password scrypt/JWT, passkeys, URL/device tokens, tunnels, pairing links, relay (contract-level; broker validated at build time) |
| P12 Electron shell | 09 | In-process server, IPC bridge + security gating, boot outcome, tray/menu/updates/packaging |
| P13 Integration verify | all | End-to-end run of core journeys; deferred-items register reviewed; NNA integration notes written |

Deferred (no phase yet): 10 VS Code, 11 Mobile/Capacitor. Mini Chat window + embedded
session-chat iframe ride in with P12 (they are Electron-surface features).

## Working rules

- Read one doc at a time → write `docs/build/NOTES/<nn>-*.md` (contract extraction +
  implementation deltas) → implement → verify (typecheck + vitest + dev-run smoke) →
  update `PROGRESS.md`.
- Every deviation/approximation gets a row in the Deferred/Delta register (`PROGRESS.md`).
- Mock behavior must be shaped by doc-02 wire examples, never invented silently.
- Never import from planning docs at runtime; they are build-time references only.
