# NotNativeDesktop

A cleanroom re-implementation of [OpenChamber](https://github.com/openchamber/openchamber)
— a workspace for running and reviewing AI coding-agent work — built from the
static-analysis specifications in [`docs/planning/`](docs/planning/00-INDEX.md). No
OpenChamber source was read or copied; the planning docs are the sole contract.

- **Harness:** [NotNativeAgent](docs/architecture/0020-nna-ecosystem-topology.md)
  (NNA) owns the engine, governance, and lifecycle. NND is its optional GUI
  integration package, not an independently installed agent runtime. The
  installed NND package requires NNA first and registers with it during setup.
  A mock harness remains available for isolated development tests.
- **Surfaces today:** local web GUI and Electron desktop shell. VS Code and
  mobile are long-term deferred.
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
packages/electron                Electron shell (doc 09)
docs/planning    cleanroom specification (input)
docs/build       build-time notes, decisions, progress (our output)
```
