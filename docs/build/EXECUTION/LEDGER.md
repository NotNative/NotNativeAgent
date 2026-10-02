# Integration work ledger — NotNativeDesktop native NNA integration

Owner: lead implementation agent (this session).
Governing guides: [PLAN](../PLAN.md), [EXECUTION 01-05](../PLAN.md). Baseline:
NND `e425a25` / `20261001-42`; NNA `7363ad1c2f...` / `20261001-6`. Both trees
started clean (verified 2026-10-01). Status vocabulary follows guide 05:
`open`, `in-progress`, `blocked`, `implemented-unverified`, `verified`.

Ground rules (from the guides and both repositories' AGENTS/README):

- NNA stays independent; its TUI keeps tabs/sessions. NND is a separate optional
  package. NNA supervises the persistent NND service. Browser and desktop share
  NND's service and session collection. No auto-accept, no Full control, no TUI
  merge. NNA owns execution, governance, configuration authority, engine truth.
- Slice order: L1 first; independent inventories/tracing may run in parallel.
- Every slice: focused checks + `npm test`/`pnpm test`, adversarial review by a
  non-author, evidence update, graph/report refresh, version bump, verified
  commit (NNA dependencies commit before NND consumers).
- Distinguish `implemented-unverified` from `verified`. Mock success never closes parity.

## Grounded source facts (verified this session, 2026-10-01)

| Fact | Evidence |
|---|---|
| NNA has no `nna service` CLI; only `nna nnd serve` and `nna nnd package {activate,deactivate,status}` | `D:\ProjectRepo\NotNativeAgent\src\cli.js` dispatch + help text |
| `runNndIntegrationCommand` creates the engine host **before** the integration server; `readIntegrationManifest` throws on missing/invalid manifest; no setup-required state | `src\integration-cli.js` (`runActivatedIntegrationCommand`, `createIntegrationNndEngineHost`) |
| `nnd serve` emits one JSON ready frame to stdout; token in frame; no supervision, no singleton, no health module | `src\integration-cli.js`; no `service` case in `cli.js` |
| NNA activation contract: `nno-integration-activation.js` (NNO installed-manifest validation) vs `createNndLocalIntegrationActivation()` (unvalidated local activation; identity checked only when `NNA_NND_INSTALL_ROOT` is set via `assertRegisteredNndPackage`) | both files |
| `nnd-package.js` validates manifest `id: nnd-local`, ownership `nnd`, scope `local-gui`, protocol `1.0`, `VERSION = /^\d{8}-[1-9]\d{0,5}$/`, requires `packages/electron/dist-server/server.mjs` + `packages/web/dist/index.html`; registry `nnd-package.json` in config root | `src\nnd-package.js` |
| NND installed service entry exists but is only an NNA-launched child contract; sets `NOTNATIVE_NNA_MODE=managed`, `NNA_NND_INSTALL_ROOT`, disables browser bridge | `scripts\serve-installed.mjs` |
| Electron shell imports the server bundle **in-process** (`main.mjs` "Hard invariant: server runs IN-PROCESS"); tray `quitFromTray()` disposes the server handle; login item registers the **shell** (not a supervisor) | `packages\electron\main.mjs` |
| Shell uses stale `OPENCHAMBER_*` env names (e.g. `OPENCHAMBER_SERVER_URL`, `OPENCHAMBER_ELECTRON_LOAD_SERVER_UI`) alongside `NOTNATIVE_*` | `packages\electron\main.mjs` |
| Application port env: `NOTNATIVE_PORT`; dev ports 3902/5180/3000 per DECISIONS.md | `main.mjs`, `docs\build\DECISIONS.md` |

## Package ledger

| ID | Package | Depends | Status | Owner files | Evidence |
|---|---|---|---|---|---|
| L1 | Freeze activation contract | — | in-progress | NNA: `src\nnd-package.js`, `src\integration-cli.js`, new `src\nnd-service*.js` (proposed), `src\cli-options.js`/`cli.js`; NND: `scripts\serve-installed.mjs`, `install.ps1`, new service supervisor entry | this ledger row |
| L2 | NNA supervision/health/singleton | L1 | in-progress | NNA lifecycle modules; NND `serve-installed.mjs`, server wiring | — |
| L3 | Renewable principal attachment | L1-L2 | open | NNA `src\integration-principal.js`, `src\secret-broker.js`; NND `harness\nna.ts`, `nna-local.ts`, `server\env.ts`, `server\index.ts` | — |
| L4 | Shell/browser migration to service attach | L2-L3 | open | NND `electron\main.mjs`, `desktop-boot.mjs`, tray/IPC, `server\index.ts`, `serve-installed.mjs` | — |
| L5 | Transactional installer/upgrade/rollback | L1-L4 | open | NND `install.ps1`, package/stamp scripts, NNA registration, launch descriptors | — |
| L6 | Installed acceptance + release identity | L1-L5, C/F | open | docs/build/PROGRESS, evidence records, V gates | — |
| C1 | Settings census + contract ledger | L1 | open | NNA settings sources; NND `components/settings/*` mapping | — |
| C2 | Native resolution/concurrency (NNA) | C1, L2 | open | NNA `integration-cli.js`, `startup-configuration.js`, `configuration-sources.js`, `runtime-config.js`, `provider\profile-store.js` | — |
| C3 | NND settings transport/presentation | C2 | open | NND `harness\nna.ts`, `ui\lib\nnd\client.ts`, settings `window.tsx`, `search.ts`, settings pages | — |
| C4 | Providers/routes/engine controls | C3 | open | NND `pages\providers.tsx` etc. | — |
| C5 | MCP/skills/hooks/trust/project config | C3, C2 | open | NND `routes\mcp-config.ts`, `lib\mcp\*`, `stores\useMcpConfigStore.ts`, `pages\mcp.tsx` etc. | — |
| C6 | Non-manifest + TUI preferences page | C3, L | open | settings pages; NNA TUI prefs contract | — |
| C7 | Settings coverage/installed acceptance | C4-C6 | open | coverage report + installed probes | — |
| F1 | Projects/execution roots/session identity | L, C2 | open | NND routes/projects, git-worktrees, harness/nna-local, sync/session-actions, ui WorktreesView; NNA nnd-harness-routes, nnd-engine-host, nnd-session-description | — |
| F2 | Durable observations/recovery | L identity | open | NND sync/projection/activity; NNA nnd-projection, nnd-activity-snapshot, nnd-child-snapshot, nnd-session-registry, event-bus persistence | — |
| F3 | Composer/governed submission | F1-F2, C4 | open | NND chat/*, sync/session-actions, upload/question routes; NNA nnd-harness-routes, question broker | — |
| F4 | Session product/forks/BTW | F1-F3 | open | NND lib/nnd/client, sync/session-actions, chat/btw-*; NNA session host/catalog | — |
| F5 | Model helpers/route selection | C4, F1-F2 | open | NND small-model/lib walkthrough/goal-audit callers; NNA nnd-walkthrough, nnd-notification, nnd-goal-audit, provider scheduler | — |
| F6 | Files/review/plans/Git visibility | F1-F3, F5 | open | NND files/diff/git/plan components + lib/files/git/plan; server routes/git*, filesystem, GitHub/Linear | — |
| F7 | Terminal/preview/browser inspection | F1/F3, L | open | NND server/terminal, preview, components/terminal, lib/browser; NNA nnd-browser-tool | — |
| F8 | Knowledge/memory/skills/MCP context | F1-F3, C | open | NND server/session-knowledge, project-context, agent-tool, context; NNA skills/MCP/memory/console surfaces | — |
| F9 | Goals/schedules/queue/multi-run | F1-F5, F8, L | open | NND server/goals, scheduled, queue, session-orchestration, chat controls; NNA goal/ingress contracts | — |
| F10 | Workspace presentation/attention | F2-F9, C | open | NND rails, notifications, themes/i18n/shortcuts | — |

## Cross-repository contracts

The [activation contract](nnd-local-activation-contract.md) replaces the interrupted
agent's draft. Paired validators and review passed in NND 20261001-43 / NNA 20261001-7.
No existing supervisor, startup registration or installed acceptance is claimed.

## Recovery of the interrupted handoff

The handoff contained only this ledger, the contract draft and three untracked NNA
contract/test files. No implementation commit had landed after the pinned baseline.
The draft reversed NNA/NND process ownership, partitioned singleton ownership by
package root, omitted readiness facets and schema fields, and proposed a circular
release digest. These were repaired before L2 consumes the contract.

## L1 contract sub-slice evidence

Versions: NND 20261001-43; NNA 20261001-7. Contract validators and optional package
artifact admission are implemented. Legacy registration remains supported; explicit
service admission checks host capabilities. NND checks declared schema before startup
environment mutation. Paired source agreement and failure cases pass. Adversarial
review repaired a digest that could otherwise cover a helper instead of the server.

L1 remains in-progress: installed descriptor/independent TUI acceptance is outstanding.
L2 is not implemented; no new service capability is advertised. Full build completion
requires every remaining L/C/F/V row. NNA native-platform release certification is
separate from the source suite and has not been refreshed for this source slice.

## L1/L2 installation identity and singleton sub-slice

NNA 20261001-8 / NND 20261001-44. Source helpers now validate an explicitly selected
installed descriptor, contained native CLI/payload metadata and actual recorded
Node runtime. Canonical path identities preserve the same data identity across
installation moves; no PATH fallback or installed-file mutation occurs.

The Windows kernel named-pipe lock excludes concurrent and separate-process writers
for the same canonical data root, including junction/case aliases. Normal close is
idempotent and loss is observable. It contains no credentials or command protocol.
Service wiring, private Windows discovery storage and shared external-catalog locks
remain open. NND's paired endpoint contract also accepts explicit port 80 without
relaxing literal-loopback or valid-port checks.

Independent adversarial review found no further confirmed defects. Focused Windows
identity/lock/contract cases pass. Final full-suite and release evidence is recorded
in the paired commits. L1 still needs installed TUI independence acceptance; L2 remains
in-progress and service capabilities remain unadvertised. No installed operator
profile, startup entry, TUI state or running NNA was changed.
