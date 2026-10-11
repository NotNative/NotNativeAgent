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
| Client sync and state engine | 47 | Harness SDK facade, Runtime adaptation, UI shell | Harness SDK facade, Quality gates, Runtime adaptation, UI shell, Web server |
| Harness SDK facade | 42 | Client sync and state engine, Runtime adaptation | Client sync and state engine, Runtime adaptation, UI shell, Web server |
| Runtime adaptation | 235 | Client sync and state engine, Harness SDK facade, UI shell | Client sync and state engine, Harness SDK facade, Quality gates, UI shell |
| UI shell | 219 | Client sync and state engine, Harness SDK facade, Runtime adaptation | Client sync and state engine, Runtime adaptation |
| Web server | 234 | Client sync and state engine, Harness SDK facade | Quality gates, Web entrypoints |
| Web entrypoints | 13 | Web server | — |
| Quality gates | 91 | Client sync and state engine, Runtime adaptation, Web server | — |
| Product foundation | 0 | — | — |

## Strongest observed component dependencies

| Importer | Imported component | Imports | Importing modules |
|---|---|---:|---:|
| UI shell | Runtime adaptation | 378 | 150 |
| UI shell | Harness SDK facade | 139 | 97 |
| UI shell | Client sync and state engine | 116 | 70 |
| Client sync and state engine | Harness SDK facade | 60 | 42 |
| Harness SDK facade | Runtime adaptation | 39 | 36 |
| Quality gates | Web server | 26 | 8 |
| Client sync and state engine | Runtime adaptation | 15 | 13 |
| Runtime adaptation | Harness SDK facade | 12 | 8 |
| Harness SDK facade | Client sync and state engine | 9 | 9 |
| Web entrypoints | Web server | 9 | 3 |
| Web server | Harness SDK facade | 9 | 9 |
| Runtime adaptation | Client sync and state engine | 8 | 5 |
| Runtime adaptation | UI shell | 5 | 5 |
| Client sync and state engine | UI shell | 4 | 3 |
| Web server | Client sync and state engine | 3 | 3 |
| Quality gates | Runtime adaptation | 1 | 1 |
| Quality gates | Client sync and state engine | 1 | 1 |

## Process entry points

- `packages/ui/src/main.tsx`
- `packages/web/src/main.tsx`
- `packages/web/src/server/index.ts`
- `scripts/dev.mjs`

Source fingerprint: `sha256:d3b197cf363d5c852d0c13a563741f0c60eeeb7e68f6fd6b88a1271f9b585a3c`.
