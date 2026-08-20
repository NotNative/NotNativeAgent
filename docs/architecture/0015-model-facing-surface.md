# Architecture decision 0015: compact model-facing surface

Status: accepted and implemented.

NNA keeps its complete governed capability registry while presenting a smaller task-specific
surface to each provider step. The always-visible set contains `tool.search` and bounded
workspace observation primitives. Authenticated task intent activates coherent capability
families such as filesystem mutation, execution, web retrieval, NNA diagnostics, skills,
session history, conversation work, delegation, and notification. Terse continuations inherit
intent only from durable unfinished work or retained authenticated operator input.

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

Ordinary build, test, install, and terminal intent activates `shell.run` plus
`project.verify`; `process.run` does not compete in that routine surface. It remains installed
and discoverable when exact argv without shell interpretation is materially useful. Hosted or
manifest-ceilinged registries that provide `process.run` without `shell.run` use it as the
execution fallback, preserving capability without widening the normal root surface.

The kernel prompt is organized as short, named invariant sections: role and scope,
communication and authority, context, action and verification, grounding, NNA self-knowledge,
and completion. Host- or operation-specific coaching belongs in the relevant tool definition
and its in-band errors. Specialized workflows belong in skills or attributed project guidance.
Runtime state machines own recovery and enforcement.

The intended result is broad freedom of approach with few simultaneous choices. Small and
medium models spend less context selecting between overlapping mechanisms, while governance
and receipts remain independent of model compliance.
