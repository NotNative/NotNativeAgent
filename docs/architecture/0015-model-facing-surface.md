# Architecture decision 0015: stable model-facing foundation

Status: accepted and implemented.

NNA keeps its complete governed capability registry while presenting a stable foundational
surface to every ordinary provider step. The deliberately small deterministic order is:

1. `tool.search`;
2. `fs.list`, `fs.read`, and `fs.search_text`;
3. `shell.run`;
4. `work.plan`, `work.status`, and `work.task_update`;
5. `turn.finish`;
6. `git.inspect`.

A definition is omitted only when its subsystem is unavailable or an authenticated host
manifest ceilings it. Root conversations do not have a text-only or zero-tool phase. The
operator's wording is not classified with regular expressions, lexical relevance, or another
front-loaded intent matcher to decide which schemas exist.

Specialist schemas—including time, workspace transitions, web access, work creation, session
history, guidance, skills, mutation, browser automation, verification, exact-process execution,
delegation, reference storage, notifications, and future MCP tools—remain discoverable through
the name-only catalog. `tool.search` is first so the model can inspect and load the relevant
schema. Ranked results are discovery suggestions only. An exact-name search returns the input
schema and requests one bounded workflow lease; typed recovery and trusted handoffs may request
the same explicit lease with an attributed source. Lease admission checks the complete projected
count and byte budget before commitment. A committed lease is therefore guaranteed to remain on
the provider surface until its use allowance expires. If it cannot fit, the tool response reports
`schema_load_rejected` and the exact count-or-byte reason instead of silently evicting another
schema. Provider-definition assembly does not age lease state because qualification, retry, and
review can assemble definitions more than once before the model receives another actionable step.
Only a successfully sealed invocation consumes a use; reinsertion records actual-use order rather
than grant order.

Provider-surface planning has one bounded composition, not lifecycle-specific phases. Its
receipt identifies either `foundation_with_leases` or an authenticated `host_manifest`, attributes
each selected schema to the foundation or a committed workflow lease, and retains explicit
capacity reasons for any planner omission. Internal
turn states may still govern recovery or monitoring behavior, but they do not claim to select a
different tool catalog or schema budget.

This is a model-facing context decision, never an authority decision. Visibility and search do
not grant permission. Every call still passes schema validation, sealed-request binding,
governance, mandatory semantic review where classified, revalidation, execution bounds, and
journaling. Authenticated execution manifests remain hard capability ceilings and can provide
an exact surface, including no tools. Governance is never bypassed by the foundation, a search
result, a skill, recovery guidance, or model confidence.

NNA continues to maintain a bounded conversation-intent projection from authenticated operator
statements. It supports continuity, reviewer evidence, and completion supervision; it does not
select tools. A short continuation, clarification, or accepted assistant proposal can therefore
retain the task's meaning without silently granting or removing a schema.

The kernel prompt asks the model to respond first with a terse statement of intent, viewpoint,
and high-level action, then invoke the smallest useful visible tool in the same response. If the
foundation is insufficient, it calls `tool.search` before claiming a capability is unavailable.
If the operator explicitly asks to create, load, set, or track a goal or task list, the model
must persist that state with a work tool before beginning dependent work. Merely narrating a
plan is not a state change.

Legacy granular filesystem aliases remain installed for sealed requests, old manifests,
resumed sessions, specialist workflows, and recovery, but they do not compete in the
foundational catalog. The intended result is predictable affordance for small and local models
without paying the reasoning and token cost of irrelevant schemas on every step, while avoiding
brittle language gating or any reduction in governance.

`workspace.change` is the only model-callable persistent working-directory transition. It
validates one existing directory and always reaches mandatory semantic review. A successful
transition replaces that conversation's automatic filesystem scope, reloads applicable project
guidance, and persists across restoration. An explicit operator request can authorize one
outside-CWD operation without changing the CWD. Neither route changes a tool classification,
host capability ceiling, mission boundary, or governance policy.

Provider tool results use the versioned `nna.tool-result.v2` envelope. The canonical lifecycle,
review outcome, trust label, and content projection are distinct fields; `status` remains a
temporary lifecycle-only compatibility alias. Projection metadata states the original,
projected, and omitted byte counts plus the projection reason. Semantic receipts preserve a
small allowlist of outcome-critical metadata when nonessential metadata exceeds its bound.

Schema rejections include a bounded machine-readable repair for the affected field alongside
the human-readable error. Missing, unknown, mistyped, and out-of-enumeration fields identify
the corrective operation without echoing sensitive values. `work.plan` remains the atomic
whole-snapshot operation; `work.task_update` is the normal one-task transition and therefore
does not require the task title to be repeated.

Schema admission, provider projection, and invocation values share one 24-level structural
depth ceiling. Independent byte, field, collection, and 10,000-node limits continue to bound
model-controlled arguments; an admitted schema must not imply a lower hidden invocation ceiling.

Provider schema projection omits JSON Schema `default` annotations because NNA validation does
not insert omitted values. Descriptions may explain runtime fallback behavior, but the wire schema
must not imply a mutation that the validator never performs.

The unloaded-name catalog labels foundational, specialist, internal, and legacy compatibility
tiers while stating that classification grants no authority. Cold-evidence and work-cadence
counters state their scope. Repeated identical hook context is admitted once per turn, and
hook projections expose their grounding freshness and observation time instead of implying
that newly injected text is current evidence.
