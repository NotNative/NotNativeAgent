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
| Client sync and state engine | 38 | Harness SDK facade, Runtime adaptation, UI shell | UI shell |
| Harness SDK facade | 4 | Runtime adaptation | Client sync and state engine, Runtime adaptation, UI shell, Web server |
| Runtime adaptation | 121 | Harness SDK facade, UI shell | Client sync and state engine, Harness SDK facade, Quality gates, UI shell |
| UI shell | 103 | Client sync and state engine, Harness SDK facade, Runtime adaptation | Client sync and state engine, Runtime adaptation |
| Web server | 125 | Harness SDK facade | Quality gates, Web entrypoints |
| Web entrypoints | 9 | Web server | — |
| Quality gates | 18 | Runtime adaptation, Web server | — |
| Product foundation | 0 | — | — |

## Strongest observed component dependencies

| Importer | Imported component | Imports | Importing modules |
|---|---|---:|---:|
| UI shell | Runtime adaptation | 134 | 56 |
| Client sync and state engine | Harness SDK facade | 51 | 36 |
| UI shell | Client sync and state engine | 47 | 19 |
| UI shell | Harness SDK facade | 36 | 33 |
| Web entrypoints | Web server | 9 | 3 |
| Quality gates | Web server | 7 | 2 |
| Client sync and state engine | Runtime adaptation | 7 | 6 |
| Web server | Harness SDK facade | 5 | 5 |
| Harness SDK facade | Runtime adaptation | 4 | 2 |
| Quality gates | Runtime adaptation | 1 | 1 |
| Runtime adaptation | Harness SDK facade | 1 | 1 |
| Runtime adaptation | UI shell | 1 | 1 |
| Client sync and state engine | UI shell | 1 | 1 |

## Process entry points

- `packages/ui/src/main.tsx`
- `packages/web/src/main.tsx`
- `packages/web/src/server/index.ts`
- `scripts/dev.mjs`

Source fingerprint: `sha256:76f8d14a6cf1d629477ae2dd4af8a2e1de3339442d6655ca21e41746c9ad42d4`.
