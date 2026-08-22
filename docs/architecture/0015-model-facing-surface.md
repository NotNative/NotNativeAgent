# Architecture decision 0015: compact model-facing surface

Status: accepted and implemented.

NNA keeps its complete governed capability registry while presenting a smaller task-specific
surface to each provider step. The always-visible set is exactly `tool.search`, `fs.list`,
`fs.read`, `fs.search_text`, `web.search`, `web.fetch`, and `web.browse`. Authenticated task
intent activates the canonical mutation and coordination tools `fs.directory`,
`fs.write_text`, `fs.edit_text`, `shell.run`, `work.plan`, and `agent.run`, plus narrowly
specialized diagnostics, session history, and notification tools. An active turn maintains a
bounded conversation-intent projection from recent authenticated operator statements, with its
accepted request retained as an anchor through later steering. Both tool selection and reviewer
evidence use that projection, preventing a cross-turn continuation, additive clarification, or
permission from accidentally erasing the task vocabulary that activated its tools. A
`work.plan` can improve coordination and operator visibility, but tool continuity does not
depend on a plan existing.

This is a model-facing context decision, not an authority decision. Hidden schemas remain
installed and governed. Exposure never bypasses validation, sealed-request binding, semantic
review, revalidation, execution limits, or journaling. An execution manifest can still remove
a capability entirely.

`tool.search` is the escape hatch for authorized capabilities that task selection did not
load. A successful search keeps bounded matching schemas visible until a validated call
consumes the selected tool. An exact-name query also returns the input schema and explicit
next-step guidance. Provider-definition assembly does not age discovery state, because route
qualification, retry, and review may assemble definitions more than once before the primary
model receives another actionable step.

Ordinary build, test, install, and terminal intent activates `shell.run`; `project.verify`
is selected only by explicit verification intent and `process.run` does not compete in the
routine surface. Both remain installed as internal compatibility/specialist capabilities. Hosted or
manifest-ceilinged registries that provide `process.run` without `shell.run` use it as the
execution fallback, preserving capability without widening the normal root surface.

The kernel prompt is organized as short, named invariant sections: role and scope,
communication and authority, context, action and verification, grounding, NNA self-knowledge,
and completion. Host- or operation-specific coaching belongs in the relevant tool definition
and its in-band errors. Specialized workflows belong in skills or attributed project guidance.
Runtime state machines own recovery and enforcement. The general action section asks the model to
acknowledge briefly, choose the smallest useful next action after each request or tool result, invoke a
needed tool in the same response, and adapt from returned evidence. It keeps private reasoning concise
and permits completion only when the request is satisfied or specific operator input is required. This is
medium-agnostic execution guidance that avoids oversized front-loaded artifacts and prolonged speculative
planning without prescribing a visible Thought/Action/Observation protocol.

Legacy granular tools remain installed so sealed requests, old manifests, resumed sessions,
specialized skills, and internal recovery do not lose functionality. They are hidden from the
ordinary catalog and are not competing aliases for fresh model decisions.

The intended result is broad freedom of approach with few simultaneous choices. Small and
medium models spend less context selecting between overlapping mechanisms, while governance
and receipts remain independent of model compliance.
