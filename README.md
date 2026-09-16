# NotNativeDesktop

A cleanroom re-implementation of [OpenChamber](https://github.com/openchamber/openchamber)
— a workspace for running and reviewing AI coding-agent work — built from the
static-analysis specifications in [`docs/planning/`](docs/planning/00-INDEX.md). No
OpenChamber source was read or copied; the planning docs are the sole contract.

- **Harness:** [NotNativeAgent](docs/build/DECISIONS.md) (NNA) is the target agentic
  backend. NNA is not yet GUI-integrated, so the app currently runs against a **mock
  harness** implementing the documented wire contract. The seam is isolated behind
  `packages/web/src/server/harness/` — an NNA adapter is a drop-in.
- **Surfaces today:** web/PWA (primary). Electron desktop shell is the delivery target
  (phase P12). VS Code and mobile are long-term deferred.
- **Start here:** `docs/build/PLAN.md` · `docs/build/PROGRESS.md` · `docs/build/DECISIONS.md`

## Dev loop

```bash
pnpm install
pnpm dev          # API :3902 + Vite UI :5180 → open http://127.0.0.1:5180
pnpm test         # unit/contract tests (vitest)
pnpm typecheck
pnpm build && pnpm start   # production UI bundle served by the Node server
```

## Layout

```
packages/ui      @notnative/ui   shared React UI: shell, stores, sync engine, runtime adaptation
packages/web     @notnative/web  server (Node+Hono) + HTML/JS entrypoints + harness adapters
packages/electron (later)        Electron shell (doc 09)
docs/planning    cleanroom specification (input)
docs/build       build-time notes, decisions, progress (our output)
```
