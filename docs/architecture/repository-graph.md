# Repository graph

This bounded map is generated from NotNativeDesktop production sources. It is a navigation aid:
code and the accepted architecture decisions remain authoritative. The complete module
adjacency list lives in [repository-graph.json](repository-graph.json).

Rebuild with `npm run graph:build`; `npm run graph:check` fails when source relationships
drift from the committed graph. Artifacts contain only repository-relative paths, declared
component ownership, static local imports, and bare Node module names.

## Ownership topology

The diagram states intended boundaries; the tables below are measured from imports.

```mermaid
graph LR
  sync_engine["Client sync and state engine"]
  harness_facade["Harness SDK facade"]
  runtime_io["Runtime adaptation"]
  ui_shell["UI shell"]
  web_server["Web server"]
  web_entry["Web entrypoints"]
  gates["Quality gates"]
  foundation["Product foundation"]
  ui_shell -->|subscribes to engine state| sync_engine
  ui_shell -->|issues interim legacy calls (slated for removal in P2)| harness_facade
  sync_engine -->|issues harness requests| harness_facade
  sync_engine -->|rides runtime fetch, runtime key, and persistence| runtime_io
  web_entry -->|mounts the shell| ui_shell
  web_server -->|shares mirrored wire constants and event types| harness_facade
  gates -->|audits production sources| foundation
```

## Component inventory

| Component | Modules | Imports from | Imported by |
|---|---:|---|---|
| Client sync and state engine | 39 | Harness SDK facade, Runtime adaptation, UI shell | Runtime adaptation, UI shell |
| Harness SDK facade | 4 | Runtime adaptation | Client sync and state engine, Runtime adaptation, UI shell, Web server |
| Runtime adaptation | 170 | Client sync and state engine, Harness SDK facade, UI shell | Client sync and state engine, Harness SDK facade, Quality gates, UI shell |
| UI shell | 161 | Client sync and state engine, Harness SDK facade, Runtime adaptation | Client sync and state engine, Runtime adaptation |
| Web server | 205 | Harness SDK facade | Quality gates, Web entrypoints |
| Web entrypoints | 13 | Web server | — |
| Quality gates | 23 | Runtime adaptation, Web server | — |
| Product foundation | 0 | — | — |

## Strongest observed component dependencies

| Importer | Imported component | Imports | Importing modules |
|---|---|---:|---:|
| UI shell | Runtime adaptation | 230 | 96 |
| UI shell | Client sync and state engine | 77 | 37 |
| UI shell | Harness SDK facade | 64 | 52 |
| Client sync and state engine | Harness SDK facade | 51 | 36 |
| Quality gates | Web server | 15 | 4 |
| Runtime adaptation | Harness SDK facade | 9 | 6 |
| Client sync and state engine | Runtime adaptation | 9 | 8 |
| Web entrypoints | Web server | 9 | 3 |
| Web server | Harness SDK facade | 9 | 9 |
| Harness SDK facade | Runtime adaptation | 4 | 2 |
| Client sync and state engine | UI shell | 4 | 3 |
| Runtime adaptation | Client sync and state engine | 3 | 2 |
| Runtime adaptation | UI shell | 2 | 2 |
| Quality gates | Runtime adaptation | 1 | 1 |

## Process entry points

- `packages/ui/src/main.tsx`
- `packages/web/src/main.tsx`
- `packages/web/src/server/index.ts`
- `scripts/dev.mjs`

Source fingerprint: `sha256:e7fe16c36bb57a4ad29d05f84eccada2ae2c928a935d579b1a1c3bfcf9417adf`.
