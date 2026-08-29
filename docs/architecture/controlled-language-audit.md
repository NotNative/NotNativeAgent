# Controlled-language audit

Date: 2026-08-28.

Scope: NNA-authored production JavaScript, architecture decisions, tool contracts, and
model-facing terminology. This audit establishes migration work. It does not rename behavior-
sensitive interfaces.

## Result

NNA already has strong typed boundaries, but several names blur distinct concepts. The largest
risk is not grammar. The largest risk is a name that makes visibility look like authority, or a
generic field that carries unrelated lifecycle states.

The foundation gate now protects 40 preferred terms and seven deprecated identifiers. The first
terminology migration removed every deprecated identifier from production source:

| Deprecated identifier | Occurrences | Preferred identifier | Finding |
|---|---:|---|---|
| `PROVIDER_NATIVE` | 0 | `TOOL_SURFACE_ELIGIBLE` | “Native” implied ownership or permanent presence. The set only establishes surface eligibility. |
| `providerVisible` | 0 | `isToolSurfaceEligible` | “Visible” did not explain that the result grants no execution authority. |
| `expose` | 0 | `grantWorkflowLease` | The operation creates a bounded lease. The old verb hid its duration and purpose. |
| `PROVIDER_NATIVE_TOOL_NAMES` | 0 | `TOOL_SURFACE_ELIGIBLE_NAMES` | The old name implied provider ownership or permanent availability. |
| `CORE_TOOL_NAMES` | 0 | `FOUNDATIONAL_TOOL_NAMES` | The old name did not identify the model-facing foundation concept. |
| `ALWAYS_EXPOSED` | 0 | `FOUNDATIONAL_TOOL_NAMES` | Availability depends on installed subsystems and authenticated host ceilings. |
| `INTERNAL_NATIVE_TOOL_NAMES` | 0 | `INTERNAL_TOOL_NAMES` | “Native” did not describe the internal tool category. |

The zero baselines prevent these names from returning. Future deprecated terms use the same
ratchet: a migration lowers the matching baseline in the same change.

## Findings for later slices

### A. Tool-surface eligibility names

Status: resolved in version `20260828-6`. Migration risk was medium.

NNA now names eligibility, foundational tools, internal tools, and workflow leases explicitly.
Provider receipt fields and reason values did not change. Tests verify provider surfaces, trusted
handoffs, tool-search leases, lease consumption, and authenticated host manifests.

### B. Overloaded lifecycle fields

Status: resolved in version `20260828-8`. Migration risk was high.

New session records now store tool state in `toolLifecycleStatus` and review state in
`reviewOutcome`. Provider projections use `tool_lifecycle_status` and `review_outcome`. The
provider projection retains `status` as a compatibility alias, but that alias contains only the
tool lifecycle state. One central compatibility reader interprets old session records whose
`status` field contains either kind of state.

Do not replace every local variable named `status`. Local variables with one obvious type are not
the problem. The migration target is a public or durable field with more than one meaning.

### C. Compaction request signatures

Status: resolved. Migration risk was medium.

The compaction signature now reads canonical `file_glob`. A regression test proves that a newer
search supersedes an older search only when their paths, queries, and file filters are equal.

### D. Review decisions and tool results

Status: resolved in version `20260828-8`. Migration risk was high.

Keep `approve`, `deny_with_guidance`, `hard_deny`, and `escalate_to_operator` inside the typed
review-decision domain. Denied tool requests now have the lifecycle state `denied`; their review
outcome remains separate. Failure reason codes remain separate from both domains.

### E. Model-facing prose

Priority: medium. Migration risk: low when changed in bounded groups.

Audit tool `purpose`, `description`, `guidance`, and `hint` fields against the glossary. Shorten
sentences only when all conditions and consequences remain explicit. Preserve raw evidence and
durable rationale comments.

### F. Rationale comments

Priority: medium. Migration risk: low.

Use `Why:`, `Invariant:`, `Compatibility:`, and `Security:` for durable design rationale in new
or materially revised code. Do not mechanically rewrite existing comments. Add stronger checks
only after the repository has an explicit rationale baseline.

## Gate boundaries

The current gate validates data with deterministic rules. It checks contract structure, unique
terms, unique identifiers, definition sentence length, declared replacements, and exact lexical
counts for deprecated identifiers. It excludes comments and string or template prose. It includes
JavaScript expressions inside template substitutions.

The gate does not infer prose intent. It does not classify passive voice, ambiguous pronouns, or
synonyms with regular expressions. These concerns require human review or a future advisory
analyzer with measured precision.

## Planned sequence

1. Audit model-facing tool text in bounded tool families.
2. Add advisory reports for sentence length and unqualified boundary names.
3. Promote an advisory rule to a hard gate only after false positives are mechanically excluded.

Each slice must run the full test suite, advance the canonical version, and produce one focused
commit. NNA-CTL is a reliability control, not permission for broad cosmetic churn.
