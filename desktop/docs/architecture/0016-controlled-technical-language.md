# Architecture decision 0016: NND controlled technical language

Status: accepted.

## Standard

NND-CTL/1 is NotNativeDesktop's controlled technical language. It is inspired by ASD-STE100
Issue 9 without claiming ASD-STE100 conformance. Its purpose is a shared, unambiguous
vocabulary for code, contracts, reviews, and model-facing prose.

The authoritative source is `docs/architecture/nnd-terminology.json` (the term registry,
schema `nnd.controlled-technical-language.v1`). Gates enforce it; the prose below explains
intent, not the gate mechanics.

## Rules

1. Use a registered term for its concept. Do not coin synonyms in code identifiers or
   model-facing text: harness, not backend; runtime, not instance; directory, not
   project or folder; session, not conversation; part, not chunk; dispatch, not emit.
2. Prefer active voice, present tense. One instruction, one action.
3. Keep procedural sentences short. In model-facing prose, keep sentences at or below
   25 words. Definitions in the registry are held to the same bound.
4. Qualify reactive or judgment statements with their condition. Do not present a
   heuristic as a guarantee.
5. Avoid unqualified boundary fields (`decision`, `result`, `status`) for concepts that
   carry a qualifier; name the qualifier (for example `qualityGatesResult`).
6. Document intent with the rationale markers: `Why:`, `Invariant:`, `Compatibility:`,
   `Security:` as comment prefixes where a rule would otherwise read as adventurous.
7. Preserve failure evidence. Controlled language never trades away actionable context
   for style; it sharpened how that context is expressed.

## Enforcement

`scripts/controlled-language-gates.js` validates the registry contract, scans production
sources for identifier-level term fidelity, ratchets deprecated identifiers with recorded
baselines (never grow; shrinking lowers the baseline), counts rationale markers, and
audits model-facing prose fields when tools exist. It writes
`docs/architecture/controlled-language-report.json`; the report must not go stale in
`npm run check`. Regenerate with `pnpm run language:report`.

Sources collect from `packages/ui/src`, `packages/web/src`, and `scripts`, excluding
tests and type declarations.

## Amendments

New terms join the registry first, identifiers and all; the change is not done until
the report regenerates and `npm run check` passes. A genuinely irrelevant rule is marked
`NOT_APPLICABLE` in review evidence, not silently skipped.
