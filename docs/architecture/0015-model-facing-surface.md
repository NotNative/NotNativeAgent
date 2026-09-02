# Architecture decision 0015: stable model-facing foundation

Status: accepted and implemented.

NNA keeps its complete governed capability registry while presenting a stable foundational
surface to every ordinary provider step. The deterministic order is:

1. `tool.search`;
2. `system.time`;
3. `workspace.change`;
4. `fs.list`, `fs.read`, and `fs.search_text`;
5. `shell.run`, `web.search`, `web.fetch`, and `web.browse`;
6. `work.plan`, `work.status`, `work.goal`, `work.task_add`, and `work.task_update`;
7. `git.inspect`;
8. `session.search_history` and `session.read_history`;
9. `nna.search_guidance`, `nna.read_guidance`, and `nna.diagnose_turn`;
10. `ref.inspect`;
11. `skill.search` and `skill.load`.

A definition is omitted only when its subsystem is unavailable or an authenticated host
manifest ceilings it. Root conversations do not have a text-only or zero-tool phase. The
operator's wording is not classified with regular expressions, lexical relevance, or another
front-loaded intent matcher to decide which schemas exist.

Specialist schemas—mutation, browser automation, verification, exact-process execution,
delegation, reference storage, notifications, and future MCP tools—remain discoverable through
the name-only catalog. `tool.search` is first so the model can inspect and load the relevant
schema. A successful search creates a bounded workflow lease; an exact-name search also returns
the input schema and direct next-step guidance. Typed recovery and skills may create the same
explicit lease. Provider-definition assembly does not age lease state because qualification,
retry, and review can assemble definitions more than once before the model receives another
actionable step.

Provider-surface planning has one bounded composition, not lifecycle-specific phases. Its
receipt identifies either `foundation_with_leases` or an authenticated `host_manifest`. Internal
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
foundational catalog. The intended result is predictable affordance for small and local models,
without brittle language gating or any reduction in governance.

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

The unloaded-name catalog labels foundational, specialist, internal, and legacy compatibility
tiers while stating that classification grants no authority. Cold-evidence and work-cadence
counters state their scope. Repeated identical hook context is admitted once per turn, and
hook projections expose their grounding freshness and observation time instead of implying
that newly injected text is current evidence.
