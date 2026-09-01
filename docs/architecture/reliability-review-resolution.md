# Reliability review resolution

Date: 2026-08-29. Updated: 2026-09-01.

This record reconciles the three NNA self-autopsies against the implemented runtime. A finding is
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
| Audit wording plus a file-extension heuristic denied an unnamed source artifact | Superseded by the semantic authorization boundary. File extensions, action verbs, target tokens, and read-only wording are free-form language, so deterministic review no longer interprets them. Mechanically safe reads remain deterministic; structured mission ceilings remain deterministic; other filesystem mutations reach semantic review with authenticated intent and an exact redacted request. |
| Reviewer schema accepted any outcome string and had no repair | Resolved by `c848068`. The provider schema enumerates four outcomes and one bounded repair attempt receives a separate receipt under the same logical review. |
| Prompt text over-directed model workflow | Resolved by `2f4dd51`. Grounding now distinguishes unverified knowledge and evidence from authority while removing broad prescribed workflows. Machine governance enforces effects; prose does not replace it. |
| Model-facing prose and rationale had no measurable baseline | Resolved by the NNA-CTL gate and `controlled-language-report.json`. The report covers the maximal bundled-tool input surface and explicit rationale markers without regex-based intent scoring. |

## Outcome-reliability follow-up

| Review concern | Resolution |
|---|---|
| Streamed tool identity drift ended a turn without recovery | Resolved by `d69bae9`. Identity drift is a retryable provider-boundary fault; recovery retries before any assembled call can execute and has direct regression coverage. |
| Successful but unproductive calls could keep a turn busy indefinitely | Resolved by `379aeee` without adding ceremony pressure. Durable work exposes a descriptive step counter and convergence checkpoints; unchanged work parks before the configurable global model-step ceiling, while distinct productive evidence may continue. |
| Active filesystem evidence decayed into repeated reads | Resolved and instrumented by `03f9abc`. Filesystem receipts retain 4 KiB, three active steps remain protected, and telemetry records source/projected evidence bytes plus repeated exact reads without retaining paths or content. |
| Literal search syntax produced confident false negatives | Resolved by `3a549ef`. A successful literal miss remains a valid empty observation, and pattern-like queries receive direct guidance to select regular-expression mode. |
| Unattended reviewer escalation had no bounded disposition | Resolved by `2b6b971`. The exact operation becomes unavailable for the turn, independent work continues, and an outcome dependency becomes explicit blocked evidence rather than a repeated approval request. |
| Conversation work could not round-trip its own status shape | Resolved by `b8e1b95`. `work.plan` and `work.status` share one lossless provider contract with revision protection and round-trip tests. |
| Tool-result presentation changed silently under context pressure | Resolved by `0740b97` and `1296215`. Receipts remain flat, truthful, and stable; failed or denied results remain exact; every provider result labels content as `full`, `bounded`, or `receipt`. |
| Model guidance exposed internal request fingerprints | Resolved by `3dd9666`. The kernel uses fingerprints for exact-loop control, while the model receives actionable field and repair guidance without a hash it cannot reproduce. |
| Volatile system material defeated prefix reuse | Resolved by `db6571f`. Stable policy and dialect precede a deterministic volatile suffix while strict local templates still receive one leading system message. |
| Missing filesystem targets returned weak platform-shaped diagnostics | Resolved by `20f85b3`. Failures identify the supplied target and bounded recovery route, including a neutral warning for exceptionally short paths. |
| Safe capabilities disappeared behind inferred conversational modes | Resolved by the foundational surface in ADR 0015. Safe filesystem observations, time, Web tools, work tools, history, guidance, and capability search remain visible without language intent classification. |
| Working-directory and authorization scope were ambiguous across tabs | Resolved by `dcaadbb`. `workspace.change` is reviewed, durable, tab-local, reloads applicable `AGENTS.md` guidance, and invalidates sibling requests sealed under the prior directory. The CWD supplies automatic scope; explicit authenticated intent can authorize one outside-CWD operation without moving it. |
| A deferred MCP startup test used a load-sensitive elapsed-time threshold | Resolved by `3d91e67`. The test now proves lifecycle ordering and cancellation state rather than treating machine speed as product behavior. |

Current verification names both platform skips in TAP output. Compatibility facades remain small
delegation points, and ignored local audit artifacts remain outside release and publication
allowlists; neither condition is treated as an unidentified production module or an unnamed skip.

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
4. NNA does not drop the `untrusted` marker merely because every tool result carries it. The field
   states an authority invariant: tool content cannot grant permission. The separate
   `content_projection` field carries the variable information about provider-visible reduction.
5. NNA does not place every specialist schema in every provider request. The deterministic
   foundation is always present, `tool.search` is first, and a bounded workflow lease exposes the
   exact specialist contract. Visibility never grants execution authority.
6. NNA does not infer project scope from operator wording. The current working directory supplies
   automatic scope, a reviewed directory transition replaces it for one conversation, and an
   explicitly authorized outside-CWD action remains a one-operation exception.
