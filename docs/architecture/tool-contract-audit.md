# Model-visible tool contract audit

Audit date: 2026-08-24
Scope: all 46 bundled tools installed by `ToolRegistry` when optional controls are present. Dynamically loaded MCP and extension tools are governed by the same generic schema validator but require a separate provider-specific semantic audit.

## Method

The audit compared each tool's JSON schema, normalization aliases, runtime validator, provider projection, and recovery result. The regression suite now requires every bundled schema to:

- accept one closed object (`additionalProperties: false`);
- declare every required property exactly once;
- document every top-level property;
- retain those descriptions in the actual provider projection; and
- keep exact-text and line-range edit selectors in separate contracts.

## Results

| Area | Tools audited | Result |
| --- | --- | --- |
| References | `ref.store`, `ref.inspect` | Pass. Kind-specific normalization is explicit and unknown fields fail at the shared shape boundary. |
| Filesystem observation | `fs.list_directory`, `fs.read_text`, `fs.read_lines`, `fs.glob`, `fs.search_text`, `fs.metadata`, `fs.read`, `fs.list` | Pass. Defaults, path/pattern roles, and receipt behavior are provider-visible; numeric safety bounds remain runtime-enforced. |
| Filesystem mutation | `fs.write_text`, `fs.edit_text`, `fs.edit_lines`, `fs.delete_file`, `fs.create_directory`, `fs.copy_file`, `fs.move_file`, `fs.directory` | Fixed. `fs.edit_text@3` and `fs.edit_lines@2` are disjoint. Stateful receipt and target failures remain runtime evidence, not hidden argument grammar. |
| NNA guidance/diagnostics | `nna.search_guidance`, `nna.read_guidance`, `nna.diagnose_turn`, `nna.list_sessions`, `nna.mcp_status`, `nna.mcp_test` | Pass. Selector conflicts and exact-id behavior are now visible through retained field descriptions. |
| Web and images | `web.search`, `web.fetch`, `web.browse`, `image.inspect` | Hardened. `web.browse` remains one session-oriented action tool to avoid eight competing browser schemas; its provider-visible action field now gives the exact argument mapping for every action. |
| Discovery and execution | `tool.search`, `process.run`, `shell.run`, `system.elevate`, `project.verify` | Pass. Interpreter, stdin-reference, accepted-exit-code, verification-scope, and elevation requirements are provider-visible; host/runtime availability is correctly validated after shape validation. |
| Repository/code | `git.inspect`, `code.diagnostics` | Pass. Selectors and path bounds match runtime validation. |
| Skills and delegation | `skill.search`, `skill.load`, `agent.run` | Pass. Role/id/task contracts are closed and bounded. |
| Durable work | `work.plan`, `work.status`, `work.goal`, `work.task_add`, `work.task_update` | Pass with documented relational rules. Atomic plan replacement is intentionally retained; completion evidence and blocking detail requirements are visible. |
| Notifications/history | `notification.telegram`, `session.search_history`, `session.read_history` | Pass. Message, filters, indexes, and surrounding-record bounds match runtime checks. |

## Defects corrected

1. Provider projection removed every property description. Models saw types and enums but not defaults, conditional requirements, examples, or "do not combine" rules. The registry now uses the documented projection.
2. `fs.edit_text@2` combined two mutually exclusive selector grammars (`find` versus `start_line`) that JSON Schema did not encode. The two modes now have separate provider-visible tools.
3. Schema-repair continuation guidance was generic. It now includes the exact rejection and instructs the model to rebuild from the currently presented fields.
4. Tool-contract learner observations could be treated like model defects. They now enter a version-keyed shadow ledger only; failures and validated repairs are deduplicated but cannot alter prompts.
5. Malformed JSON at an observed token ceiling was classified from `finish_reason` alone. Usage-at-limit evidence now also identifies truncation.

## Residual policy

Some failures are intentionally runtime-only: missing files, stale receipts, unavailable executables, unsafe destinations, review denials, and external state drift cannot be expressed as argument grammar. They return precise in-band evidence and do not count as learned schema lessons. Any future tool that adds a second mutually exclusive selector to one schema will fail the contract regression test until it is split or explicitly redesigned.

For compatibility with local OpenAI-style grammar compilers, the provider projection still omits JSON Schema regex and numeric/string-size constraint keywords. Required fields, types, enums, and semantic descriptions are visible; the shared validator returns an exact accepted range or format when a bound is violated. This is an intentional transport-compatibility boundary rather than a second runtime contract.
