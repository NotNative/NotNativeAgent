# Architecture decision 0015: stable model-facing foundation

Status: accepted and implemented.

NNA keeps its complete governed capability registry while presenting a stable foundational
surface to every ordinary provider step. The deterministic order is:

1. `tool.search`;
2. `fs.list`, `fs.read`, and `fs.search_text`;
3. `shell.run`, `web.search`, `web.fetch`, and `web.browse`;
4. `work.plan`, `work.status`, `work.goal`, `work.task_add`, and `work.task_update`;
5. `git.inspect`;
6. `session.search_history` and `session.read_history`;
7. `nna.search_guidance`, `nna.read_guidance`, and `nna.diagnose_turn`;
8. `ref.inspect`;
9. `skill.search` and `skill.load`.

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
