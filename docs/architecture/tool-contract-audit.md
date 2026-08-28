# Model-visible tool contract audit

Audit date: 2026-08-28
Scope: all 47 bundled tools installed by `ToolRegistry` with the maximal regression fixture: MCP status/test control, skill registry, root subagent control, conversation-work store, Telegram notifications, elevation broker, and session history. The exact expected names are asserted in `test/bundled-tool-contracts.test.js`; adding, removing, or conditionally omitting a bundled tool now changes the audit mechanically. Dynamically loaded MCP and extension tools are governed by the same generic schema validator but require a separate provider-specific semantic audit.

## Method

The audit compared each tool's JSON schema, normalization aliases, runtime validator, provider projection, and recovery result. The regression suite now requires every bundled schema to:

- accept one closed object (`additionalProperties: false`);
- declare every required property exactly once;
- document every top-level property;
- retain those descriptions in the actual provider projection; and
- keep exact-text and line-range edit selectors in separate contracts;
- normalize safe strings for every schema-declared integer at the shared boundary; and
- keep internal routing discriminators out of sealed model-facing arguments.
- preserve exact assistant-authored native tool-call arguments whenever a call is retained through compaction; and
- render locally enforced numeric, string, item-count, UTF-8 byte, and format constraints into provider-visible descriptions without sending grammar keywords rejected by local providers.

## Results

| Area | Tools audited | Result |
| --- | --- | --- |
| References | `ref.store`, `ref.inspect` | Hardened. Kind-specific normalization is explicit, unknown fields fail at the shared shape boundary, and model-authored draft values are capped at 32 KiB. Larger observation-owned references remain internal and do not consume provider output. |
| Filesystem observation | `fs.list_directory`, `fs.read_text`, `fs.read_lines`, `fs.glob`, `fs.search_text`, `fs.metadata`, `fs.read`, `fs.list` | Pass. Defaults, path/pattern roles, and receipt behavior are provider-visible; numeric safety bounds remain runtime-enforced. |
| Filesystem mutation | `fs.write_text`, `fs.edit_text`, `fs.edit_lines`, `fs.delete_file`, `fs.create_directory`, `fs.copy_file`, `fs.move_file`, `fs.directory` | Fixed. `fs.write_text@2`, `fs.edit_text@4`, and `fs.edit_lines@3` are disjoint and bound model-authored payloads to the practical provider envelope. Stateful receipt and target failures remain runtime evidence, not hidden argument grammar. |
| NNA guidance/diagnostics | `nna.search_guidance`, `nna.read_guidance`, `nna.diagnose_turn`, `nna.list_sessions`, `nna.mcp_status`, `nna.mcp_test` | Pass. Selector conflicts and exact-id behavior are now visible through retained field descriptions. |
| Web and images | `web.search`, `web.fetch`, `web.browse`, `image.inspect` | Hardened. `web.browse` remains one session-oriented action tool to avoid eight competing browser schemas; its provider-visible action field gives the exact argument mapping for every action. `image.inspect@2` emits a normalized verdict whose visual authority can be superseded only by newer visual evidence. |
| Discovery and execution | `tool.search`, `process.run`, `shell.run`, `system.elevate`, `project.verify` | Pass. Interpreter, stdin-reference, accepted-exit-code, verification-scope, and elevation requirements are provider-visible; host/runtime availability is correctly validated after shape validation. |
| Repository/code | `git.inspect`, `code.diagnostics` | Pass. Selectors and path bounds match runtime validation. |
| Skills and delegation | `skill.search`, `skill.load`, `agent.run` | Pass. Role/id/task contracts are closed and bounded. |
| Durable work | `work.plan`, `work.status`, `work.goal`, `work.task_add`, `work.task_update` | Pass with documented relational rules. Atomic plan replacement is intentionally retained; completion evidence and blocking detail requirements are visible. |
| Notifications/history | `notification.telegram`, `session.search_history`, `session.read_history` | Pass. Message, filters, indexes, and surrounding-record bounds match runtime checks. |
| Host time | `system.time` | Pass. Calendar and elapsed offsets share bounded integer normalization, including weeks, without embedding a volatile timestamp in the system prompt. |

## Defects corrected

1. Provider projection removed every property description. Models saw types and enums but not defaults, conditional requirements, examples, or "do not combine" rules. The registry now uses the documented projection.
2. `fs.edit_text@2` combined two mutually exclusive selector grammars (`find` versus `start_line`) that JSON Schema did not encode. The two modes now have separate provider-visible tools.
3. Schema-repair continuation guidance was generic. It now includes the exact rejection and instructs the model to rebuild from the currently presented fields.
4. Tool-contract learner observations could be treated like model defects. They now enter a version-keyed shadow ledger only; failures and validated repairs are deduplicated but cannot alter prompts.
5. Malformed JSON at an observed token ceiling was classified from `finish_reason` alone. Usage-at-limit evidence now also identifies truncation.
6. Several valid schemas advertised model-authored strings far larger than a 32k-token provider could close as JSON. Full writes, line replacements, exact-edit anchors/replacements, and model-stored drafts now use provider-safe bounds; larger files remain supported through incremental edits and observation-owned references.
7. A successful call cleared schema recovery immediately, allowing the same oversized call shape to recur later in the turn. Output-truncated calls now create a deduplicated turn-scoped action repair that keeps later action steps concise and disables optional model thinking for that turn.
8. Repeated browser checks after a workspace mutation could hash identically to an older observation. Progress evidence now includes the observable workspace revision, while genuinely unchanged checks in the same revision still consume the no-progress budget.
9. DOM inspection could be narrated as if it disproved a visual defect. Visual verdicts now remain active until newer image evidence supersedes them, and completion supervision rejects absolute visual-pass claims that conflict with the latest verdict.
10. Integer-like provider values such as `"3"` failed before otherwise valid tool-specific validation. The shared schema boundary now normalizes safe integer strings recursively across every bundled, MCP, and extension tool. `fs.read` also leaked its internal full-versus-lines discriminator as an apparent `mode` argument; routing now lives in resolved metadata while old sealed requests retain an execution-only compatibility path.

## Residual policy

Some failures are intentionally runtime-only: missing files, stale receipts, unavailable executables, unsafe destinations, review denials, and external state drift cannot be expressed as argument grammar. They return precise in-band evidence and do not count as learned schema lessons. The payload audit also confirmed that the remaining model-authored free-text fields are bounded at or below 32 KiB (the browser fill value is 20,000 characters); larger internal observation and result bounds do not advertise model-authored payloads. Any future tool that adds a second mutually exclusive selector to one schema will fail the contract regression test until it is split or explicitly redesigned.

For compatibility with local OpenAI-style grammar compilers, the provider projection still omits JSON Schema regex and numeric/string-size constraint keywords. Required fields, types, enums, semantic descriptions, and mechanically rendered constraint summaries remain visible; the shared validator returns the same exact accepted range or format when a bound is violated. UTF-8 byte ceilings are internal schema constraints, stripped from transport grammar but included in those summaries. This is an intentional transport-compatibility boundary rather than a second runtime contract.
