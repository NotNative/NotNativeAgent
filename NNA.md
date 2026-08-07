# NotNativeAgent Project Guidance

This repository is the source tree for NotNativeAgent (NNA), a standalone local-first
agent runtime and Console. Treat optional products and integrations as capabilities layered
onto NNA; do not make the standalone runtime depend on NotNativeMemory or NotNativeOrg.

## Repository map

- Runtime and Console code lives in `src/`.
- Bundled product assets, including built-in skills, live in `resources/`.
- Operator and architecture documentation lives in `docs/`.
- Tests live in `test/`; local development planning artifacts under `docs/planning/` are
  intentionally ignored and never shipped.
- Durable user configuration, sessions, and private runtime state live under `~/.nna`, not
  in this source tree.

## Working conventions

- Read relevant existing files before changing them and preserve established contracts.
- Keep behavior model-agnostic and reliable for local small-to-medium models.
- Preserve observable lifecycle evidence, bounded recovery, reviewer governance, and the
  security boundary between root NNA and authenticated hosted sessions.
- Built-in skills belong under `resources/skills/<skill-id>/`; workspace-specific skills
  belong under the workspace's `.nna/skills/` only when the user asks for a local skill.
- Run `npm test` for implementation slices. Run the broader release checks only when the
  change requires them.
- Advance the canonical `YYYYMMDD-<iteration>` version for each logical product slice.
- Do not add or enable hosted CI workflows, paid services, telemetry exporters, or other
  externally billed automation without explicit operator authorization.

<!-- nna:managed:start -->
## Current architecture

## Decisions and rationale

## Working conventions

## Verified environment

## Known problems

## Unresolved work
<!-- nna:managed:end -->
