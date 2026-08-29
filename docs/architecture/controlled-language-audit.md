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

## Migration findings

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

Status: measured and resolved for the maximal bundled-tool input surface. Migration risk was low.

The committed [controlled-language-report.json](controlled-language-report.json) inventories all
47 bundled tools under the maximal control fixture. It measures 177 purpose or input-schema prose
fields and 284 sentences. No sentence exceeds 25 words; the maximum is 24 words. The audit uses
`Intl.Segmenter` for lexical sentence and word boundaries. It does not infer intent from prose.

Two `status` candidates remain in `work.plan` task objects and `work.task_update`. Both name the
same closed task-lifecycle enum, and their containing tool and task object qualify the concept.
Renaming this compatible public field would add another model-facing spelling without separating
two meanings, so the audit accepts both uses.

### F. Rationale comments

Status: advisory baseline established. Migration risk is low.

Use `Why:`, `Invariant:`, `Compatibility:`, and `Security:` for durable design rationale in new
or materially revised code. Do not mechanically rewrite existing comments. The committed report
records exact marker counts from comment-leading syntax without guessing which ordinary comments
contain rationale. This baseline is advisory; it supports review without creating cosmetic churn.

## Gate boundaries

The current gate validates data with deterministic rules. It checks contract structure, unique
terms, unique identifiers, definition sentence length, declared replacements, and exact lexical
counts for deprecated identifiers. It excludes comments and string or template prose. It includes
JavaScript expressions inside template substitutions.

The gate also verifies that the committed report matches the maximal bundled-tool registry. It
reports lexical sentence length, exact unqualified boundary-field candidates, and explicit
rationale markers. The gate does not infer prose intent. It does not classify passive voice,
ambiguous pronouns, or synonyms with regular expressions. These concerns require human review.

## Completed sequence

1. Audited the maximal bundled-tool model-facing input surface.
2. Added a deterministic advisory report for sentence length, unqualified boundary names, and
   explicit rationale markers.
3. Kept semantic candidates advisory. Only report freshness and mechanically exact terminology
   regressions are hard failures.

Each slice must run the full test suite, advance the canonical version, and produce one focused
commit. NNA-CTL is a reliability control, not permission for broad cosmetic churn.
