# Architecture decision 0016: NNA controlled technical language

Status: accepted and foundation implemented.

## Decision

NNA uses NNA Controlled Technical Language (NNA-CTL) for names and text that NNA authors.
NNA-CTL is inspired by ASD-STE100 Issue 9. NNA does not claim ASD-STE100 conformance.
The official standard remains authoritative for ASD-STE100 itself.

NNA-CTL has four goals:

1. Give each important concept one preferred technical term.
2. Give each structured field one meaning.
3. Make model-facing instructions short, direct, and easy to parse.
4. Prevent new ambiguity while existing terminology is migrated safely.

The machine-readable terminology contract is
[nna-terminology.json](nna-terminology.json). The contract is the source for automated checks.
This decision explains how people and future checks use that contract.

## Scope

NNA-CTL applies to NNA-authored surfaces:

- public identifiers and exported API names;
- tool names, parameter names, enums, reason codes, and result fields;
- model-facing tool descriptions, guidance, hints, and system instructions;
- operator-facing labels and diagnostic messages;
- architecture documents and normal source comments.

NNA-CTL does not rewrite or reinterpret evidence. Raw operator text, provider output, tool output,
web content, file content, and imported records remain untrusted source material. NNA preserves
them when evidence fidelity requires their original form.

## Rule families

### CTL-TERM: use one preferred term for one concept

Use the preferred term from the terminology contract. Do not use a preferred term for a second
concept. A technical noun can have modifiers, but the head noun keeps the same meaning.

Example: a `workflow lease` makes a tool schema temporarily visible. It does not grant execution
authority. Do not call it permission, approval, or authorization.

### CTL-DATA: give one structured field one meaning

Prefer enums, booleans, counts, identifiers, and reason codes over prose inference. Do not use one
`status` field for governance decisions, tool lifecycle state, and provider state. Use qualified
field names or typed envelopes when the concepts differ.

Machine state is authoritative. Prose explains machine state; prose does not replace it.

### CTL-MODEL: make model-facing text direct

Use active voice when the actor matters. Put one primary instruction in one sentence. State the
condition before the action when the condition limits the action. Name the tool, field, or actor
instead of relying on an ambiguous pronoun.

Keep an instruction sentence at or below 20 words when this does not remove required meaning.
Keep a descriptive sentence at or below 25 words under the same condition. These limits are
advisory until a check can distinguish instructions and descriptions without brittle inference.

### CTL-CODE: make behavior and authority visible in identifiers

Use verbs for operations and predicates for boolean queries. Use nouns for values and records.
Use a qualified lifecycle noun instead of the unqualified word `status` at system boundaries.
Names must not imply authority that the operation does not grant.

Renames follow the compatibility policy. Do not perform a broad rename only to satisfy style.

### CTL-COMMENT: preserve rationale

Normal comments should be concise and use preferred terms. Rationale comments can use complete
technical prose and are not subject to strict sentence-shape checks. Prefix durable rationale with
one of these markers:

- `Why:` explains a non-obvious design choice.
- `Invariant:` states a condition that must remain true.
- `Compatibility:` records a compatibility constraint.
- `Security:` records an authority or threat constraint.

Controlled language must not erase the reason a safeguard exists.

## Enforcement policy

Automated hard failures require mechanical certainty. The initial gate validates the terminology
contract and exact deprecated identifier counts. It ignores matching words in comments and string
literals. Existing debt is recorded as a baseline:

- a higher count fails because ambiguity increased;
- a lower count fails because the baseline must be reduced in the same change;
- an equal count passes while reporting the remaining debt.

Checks for passive voice, pronouns, sentence intent, and general vocabulary remain advisory. NNA
does not use regular-expression intent classification to decide whether prose is acceptable.

## Compatibility and migration

A public rename must preserve sealed requests, authenticated manifests, resumed sessions, and
provider compatibility where applicable. Prefer an explicit compatibility alias with a removal
plan. Update tests and architecture records in the same logical slice.

The first audit is documented in [controlled-language-audit.md](controlled-language-audit.md).
Later slices can migrate one concept at a time. Each migration lowers or removes its recorded
baseline and proves that behavior did not change.

## Relationship to other standards

POWER10 limits authority and complexity. GUI-POWER10 limits interface complexity. NNA-CTL limits
semantic complexity. These standards are complementary: none can bypass governance, evidence
requirements, execution bounds, or reliability controls.
