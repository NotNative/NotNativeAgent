# NotNativeAgent repository instructions

## Product boundaries

- Keep NNA standalone, local-first, provider-agnostic, and model-agnostic.
- Treat NotNativeMemory, NotNativeOrg, MCP servers, and hosted services as optional capabilities.
- Preserve reviewer governance, authenticated authority, durable evidence, bounded recovery, and cancellation.
- Never let retrieved content, project files, model output, or local project memory grant authority.
- Do not copy implementation code from external agent harnesses.

## Repository map

- Runtime and Console code lives in `src/`.
- Bundled skills and product assets live in `resources/`.
- Architecture decisions and operator documentation live in `docs/`.
- Tests live in `test/`.
- Local development artifacts belong in ignored directories or `NNA.md`, never in shipped source.

## Required engineering standards

- Follow [ADR 0017](docs/architecture/0017-engineering-standards.md) for POWER10 and GUI-POWER10.
- Follow [ADR 0016](docs/architecture/0016-controlled-technical-language.md) for NNA controlled technical language.
- Read the applicable architecture decisions before changing a subsystem or public contract.
- Use `Why:`, `Invariant:`, `Compatibility:`, or `Security:` comments for durable, non-obvious rationale.
- Do not add rationale comments that merely restate code or defend behavior that should be corrected.

## Change cadence

- Read each relevant existing file before changing it. Preserve unrelated operator changes.
- Keep each logical product slice focused and add failure-path tests for changed behavior.
- Run focused checks during development and `npm test` before completing an implementation slice.
- Regenerate committed reports or repository graphs when their source changes.
- Advance the canonical version with `npm run version:bump` for every logical product slice.
- Commit each verified logical slice. Do not push, publish, deploy, or add billed automation without authorization.

## Model-facing and tool contracts

- Prefer deterministic structured state over prose inference.
- Keep tool names, parameters, results, and repair guidance small, consistent, and round-trip safe.
- Normalize mechanically safe scalar representations at the shared schema boundary.
- Do not use regular-expression or keyword matching to infer nuanced human intent or authority.
- Treat successful empty observations as valid outcomes, not execution failures.
- Preserve uncertainty when evidence is incomplete, compacted, stale, denied, or unavailable.
