# Repository graph

This bounded map is generated from NNA's production JavaScript. It is a navigation aid, not an authority source: code and accepted architecture decisions remain authoritative. The complete module adjacency list lives in [repository-graph.json](repository-graph.json).

Rebuild with `npm run graph:build`. Use `npm run graph:check` for a focused check; the normal `npm run check` gate also fails when source relationships drift from the committed graph. Generated artifacts contain only repository-relative paths, declared component ownership, static local imports, and Node.js module names.

## Ownership topology

This diagram captures the intended engine boundaries. The tables below are measured from imports.

```mermaid
graph LR
  agentic_engine["Agentic Engine"]
  governance_engine["Governance Engine"]
  experience_engine["Experience Engine"]
  reliability_engine["Reliability Engine"]
  gateway["Gateway"]
  persistence["Persistence"]
  providers["Providers"]
  tools["Tools"]
  guidance["Guidance and extensions"]
  integrations["Integration surfaces"]
  foundation["Product foundation"]
  experience_engine -->|submits operator work| agentic_engine
  gateway -->|submits remote work| agentic_engine
  integrations -->|submits hosted work| agentic_engine
  agentic_engine -->|requests authority decisions| governance_engine
  agentic_engine -->|requests reliability decisions| reliability_engine
  agentic_engine -->|dispatches model requests| providers
  agentic_engine -->|records durable evidence| persistence
  agentic_engine -->|coordinates tool execution| tools
  tools -->|executes reviewed actions| governance_engine
  providers -->|reports route observations| reliability_engine
```

## Component inventory

| Component | Modules | Imports from | Imported by |
|---|---:|---|---|
| Agentic Engine | 19 | Agentic Engine, Governance Engine, Guidance and extensions, Integration surfaces, Persistence, Product foundation, Providers, Reliability Engine, Tools | Agentic Engine, Experience Engine, Gateway, Integration surfaces, Product foundation, Tools |
| Governance Engine | 10 | Governance Engine, Persistence, Product foundation, Reliability Engine, Tools | Agentic Engine, Experience Engine, Governance Engine, Guidance and extensions, Product foundation, Tools |
| Experience Engine | 87 | Agentic Engine, Experience Engine, Gateway, Governance Engine, Guidance and extensions, Integration surfaces, Persistence, Product foundation, Providers, Reliability Engine, Tools | Experience Engine, Product foundation |
| Reliability Engine | 43 | Product foundation, Providers, Reliability Engine, Tools | Agentic Engine, Experience Engine, Gateway, Governance Engine, Persistence, Product foundation, Providers, Reliability Engine, Tools |
| Gateway | 4 | Agentic Engine, Gateway, Integration surfaces, Persistence, Product foundation, Providers, Reliability Engine | Experience Engine, Gateway, Product foundation |
| Persistence | 11 | Persistence, Product foundation, Reliability Engine | Agentic Engine, Experience Engine, Gateway, Governance Engine, Integration surfaces, Persistence, Product foundation, Providers, Tools |
| Providers | 16 | Persistence, Product foundation, Providers, Reliability Engine | Agentic Engine, Experience Engine, Gateway, Integration surfaces, Product foundation, Providers, Reliability Engine |
| Tools | 43 | Agentic Engine, Governance Engine, Guidance and extensions, Integration surfaces, Persistence, Product foundation, Reliability Engine, Tools | Agentic Engine, Experience Engine, Governance Engine, Reliability Engine, Tools |
| Guidance and extensions | 9 | Governance Engine, Guidance and extensions, Product foundation | Agentic Engine, Experience Engine, Guidance and extensions, Product foundation, Tools |
| Integration surfaces | 10 | Agentic Engine, Integration surfaces, Persistence, Product foundation, Providers | Agentic Engine, Experience Engine, Gateway, Integration surfaces, Product foundation, Tools |
| Product foundation | 81 | Agentic Engine, Experience Engine, Gateway, Governance Engine, Guidance and extensions, Integration surfaces, Persistence, Product foundation, Providers, Reliability Engine | Agentic Engine, Experience Engine, Gateway, Governance Engine, Guidance and extensions, Integration surfaces, Persistence, Product foundation, Providers, Reliability Engine, Tools |

## Strongest observed component dependencies

Counts represent static local imports. Same-component imports are included because they reveal the internal cohesion of each subsystem.

| Importer | Imported component | Imports | Importing modules |
|---|---|---:|---:|
| Experience Engine | Experience Engine | 156 | 51 |
| Product foundation | Product foundation | 146 | 70 |
| Experience Engine | Product foundation | 77 | 54 |
| Tools | Product foundation | 53 | 34 |
| Tools | Tools | 52 | 19 |
| Reliability Engine | Reliability Engine | 49 | 23 |
| Agentic Engine | Product foundation | 39 | 15 |
| Agentic Engine | Agentic Engine | 30 | 9 |
| Providers | Product foundation | 21 | 14 |
| Integration surfaces | Product foundation | 16 | 10 |
| Agentic Engine | Reliability Engine | 13 | 8 |
| Experience Engine | Providers | 13 | 8 |
| Governance Engine | Product foundation | 13 | 10 |
| Tools | Reliability Engine | 12 | 5 |
| Agentic Engine | Tools | 11 | 6 |
| Product foundation | Providers | 10 | 8 |
| Reliability Engine | Product foundation | 10 | 9 |
| Guidance and extensions | Product foundation | 9 | 8 |
| Persistence | Product foundation | 9 | 9 |
| Experience Engine | Persistence | 8 | 7 |
| Product foundation | Persistence | 8 | 6 |
| Integration surfaces | Integration surfaces | 8 | 4 |
| Agentic Engine | Providers | 7 | 2 |
| Product foundation | Experience Engine | 7 | 5 |

## Process entry points

- `src/cli.js`
- `src/elevation-helper.js`
- `src/forensic-telemetry-worker.js`
- `src/index.js`
- `src/update-check-worker.js`

Source fingerprint: `sha256:8b1a906554b6db2d97515287f5955b9e9f5936aa97f89a99cca096d7b94f179c`.
