# Reliability review resolution

Date: 2026-08-28.

This record reconciles the two NNA self-autopsies against the implemented runtime. A finding is
resolved only when code, tests, or an explicit compatibility decision addresses it. The reviews
remain useful evidence, not authority; NNA preserves stronger governance and evidence invariants
when a suggested repair conflicts with them.

## Runtime and recovery findings

| Review concern | Resolution |
|---|---|
| Compaction replay fabricated tool arguments | Resolved by `519d782`. Provider replay now keeps exact model-authored arguments or omits the complete request/result exchange. NNA does not digest arguments inside an assistant tool call because that would again fabricate model history. |
| Fixed active-context record tail defeated compaction | Resolved by `aef01f2`. Active context has no implicit record-count cap; pressure policies and durable compaction own reduction. |
| Search compaction ignored the canonical file filter | Resolved by `0ecdad1`. Supersession keys include `file_glob`. |
| Process-output overflow discarded all evidence | Resolved by `b54d707`. A failed overflow retains bounded diagnostic evidence and does not claim successful verification. |
| Approval expired behind an earlier long-running sibling tool | Resolved by `59f3dc5`. NNA reviews each sequential request or parallel group immediately before execution. |
| Reviewer event timeout contradicted configurable review time | Resolved by `1f13894`. Registration derives the mandatory event deadline from the configured semantic-review deadline plus settlement grace. |
| Completion prose could drive a turn to the global step ceiling | Resolved by `b57d95b`. Language-derived no-progress categories have local forced-continuation limits; unchanged durable work parks for operator attention. |
| Timing-sensitive tests waited for transient states | Resolved by `11e269a`. Tests assert durable outcomes instead of requiring observation of a transient lifecycle state. |

## Tool and provider contract findings

| Review concern | Resolution |
|---|---|
| Tool-surface name and planner disagreed | Resolved by `db4ce00`. Eligibility, foundational tools, internal tools, and workflow leases have one source of truth and do not imply execution authority. |
| Hidden numeric, format, item, and byte bounds | Resolved by `dc5d57e`. Provider descriptions mechanically include locally enforced constraints. Grammar keywords remain omitted for broad local-provider compatibility; runtime validation stays authoritative and repair-complete. |
| `tool.search` failures hid the violated query boundary | Resolved by `6b49d54`. Failures identify the field, accepted bounds, and received shape without echoing sensitive content. |
| Bundled tool counts and category lists drifted | Resolved by `0818c2b`. A maximal 47-tool fixture is exact and fails on an unreviewed addition, removal, or conditional omission. |
| Character and UTF-8 byte limits were conflated | Resolved by the shared schema audit and provider-visible constraint summaries. Runtime validation retains separate character and UTF-8 byte checks. |
| Successful empty discovery appeared as failure | Resolved by `e9911dd`. Negative observations use successful lifecycle state plus typed observation outcomes. |
| Tool result `status` mixed lifecycle and review decisions | Resolved by `e8fb623`. New records use `toolLifecycleStatus` and `reviewOutcome`; one compatibility reader handles legacy journals. |
| Failure ownership used arbitrary substring matches | Resolved by `db68893`. Qualified failure domains and exact historical overrides determine category and boundary. |
| Transient model-dialect failures accumulated forever | Resolved by `fb7bdae`. Successful observations exponentially decay failure counters; tool-contract learning remains separate and shadow-only. |

## Governance and model-facing findings

| Review concern | Resolution |
|---|---|
| Greeting text could revoke safe reads | Resolved by `78b6440`. Natural-language greeting patterns cannot change deterministic safe-tool eligibility. Every call still crosses mandatory governance. |
| Audit wording plus a file-extension heuristic denied an unnamed source artifact | Reviewed and retained as a fail-closed authority boundary. The observed request asked for a read-only audit, so denial of an unnamed source-file mutation was correct. An authenticated request to write or build a script does not match the read-only contradiction and can reach semantic review. Allowing a permissive reviewer to approve the read-only case failed AC-AUTH-05, AC-HEAD-10, and AC-SEC-03 by manufacturing mutation authority. |
| Reviewer schema accepted any outcome string and had no repair | Resolved by `c848068`. The provider schema enumerates four outcomes and one bounded repair attempt receives a separate receipt under the same logical review. |
| Prompt text over-directed model workflow | Resolved by `2f4dd51`. Grounding now distinguishes unverified knowledge and evidence from authority while removing broad prescribed workflows. Machine governance enforces effects; prose does not replace it. |
| Model-facing prose and rationale had no measurable baseline | Resolved by the NNA-CTL gate and `controlled-language-report.json`. The report covers the maximal bundled-tool input surface and explicit rationale markers without regex-based intent scoring. |

## Recommendations not adopted literally

1. NNA does not replace historical write arguments with hashes inside assistant tool calls. Exact
   replay or whole-pair omission preserves the invariant that past model output remains valid model
   output.
2. NNA does not send every JSON Schema constraint to every provider. Several local grammar
   compilers reject otherwise valid schemas. The documented projection carries exact constraints;
   the shared validator supplies precise in-band repair. A future provider capability can preserve
   grammar keywords only after conformance tests prove that capability.
3. NNA does not turn advisory prose metrics into semantic pass/fail rules. Report freshness and
   exact terminology regressions are mechanical gates; intent and writing quality remain review
   judgments.
