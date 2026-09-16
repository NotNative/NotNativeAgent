# Architecture Governance

Enforcement that stands over the code. ADRs 0016/0017 define them; `scripts/` apply them.
All gates compose in `pnpm run check`.

| Artifact | Purpose | Owner doc |
|---|---|---|
| `0016-controlled-technical-language.md` | NND-CTL (STE-inspired) standard | term registry + language gates |
| `0017-engineering-standards.md` | POWER10 + GUI-POWER10, enforced mechanically by `scripts/quality-gates.js` | — |
| `nnd-terminology.json` | term registry (CTL-TERM-001…) for NND-CTL | 0016 |
| `controlled-language-report.json` | generated NND-CTL evidence; must never go stale | 0016 |
| `dependency-registry.json` | runtime dependency inventory + review dates | 0017 |
| `repository-graph.json` / `.md` | generated module/component map + ownership topology | generated |
| `nnd-terminology.json` → `scripts/controlled-language-gates.js` | registry validation, deprecated-identifier ratchet, rationale markers | 0016 |

Wait-noted: release evidence (`RELEASE_MANIFEST.sha256`, `RELEASE_VERSIONS.json`) belongs to
`scripts/release-gates.js`; publish-era artifacts (installers, platform conformance) land
with P12.
