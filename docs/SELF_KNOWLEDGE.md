# NNA self-knowledge

NotNativeAgent must consult the documentation packaged with its running version before
answering questions about its own configuration, commands, tools, architecture,
installation, troubleshooting, hooks, MCP integration, memory, provider routing, or
permission system. It must not substitute general knowledge about other agent products.

The engine prompt instructs the model to briefly tell the user it is checking NNA's
documentation, call `nna.search_guidance`, read the relevant document with
`nna.read_guidance`, and ground the answer in those results. If the installed guidance
does not cover the question, NNA must state that limitation rather than invent behavior.

Private NNA runtime configuration is not stored in the active project workspace. The model
must not search project files or source code to discover configured providers or MCP
servers. In the root Console, `nna.mcp_status` reports configured servers and whether each
belongs to the current conversation snapshot. `nna.mcp_test` independently negotiates a
configured server and returns its discovered MCP tool names without invoking them. Tools
added after a conversation began become invocable in a newly created conversation; an
application restart is not required.

For a failed, stalled, unexpectedly compacted, or otherwise surprising turn, NNA must use
`nna.diagnose_turn` before inferring a cause from the visible transcript. With no argument,
the tool examines the active turn or most recent durable turn. A correlated `turn_id` may be
provided when investigating an older visible receipt. `nna.list_sessions` enumerates a bounded
recent session catalog, and `nna.diagnose_turn` accepts an exact `session_id` so one Console can
inspect another Console's durable journal without guessing filesystem paths. The result is deliberately bounded and
content-redacted: it reports provider-attempt outcomes, recovery actions, tool terminal states,
compaction boundaries, and the durable terminal classification without reproducing prompts,
model responses, tool output, credentials, or file contents.

The bundled `/troubleshoot` skill coordinates this evidence-first workflow. It does not expand
diagnostic access or replace `/support`; it selects a session, reads bounded evidence and packaged
guidance, then explains the likely corrective action. `/support` remains the maintainer-facing
redacted archive when the bounded diagnostic is insufficient.

The authoritative raw evidence remains local under the configured NNA data root: durable
session journals are under `sessions`, structured runtime records are under `logs`, and the
local forensic database is stored beneath the per-project data area. Models should prefer the
bounded diagnostic tool rather than parsing these stores directly. `/support` creates a
redacted archive for a maintainer when deeper inspection is required.

If filesystem search is slow or the user asks about ripgrep, NNA should consult
`TOOLS.md` and `INSTALLATION.md`. It should report whether `rg` is available, explain the
native fallback, and offer an operator-approved platform installation command. Missing
ripgrep is an optimization opportunity, not a turn-blocking failure.

Standalone Console idle maintenance is inspected with `/dream`. Its deterministic
pipeline checkpoints classified telemetry, operational diagnosis, project-memory
proposals, NNM effect reconciliation, and read-only NNM hygiene. Each stage also emits a
content-free forensic lifecycle event. Authenticated host sessions cannot run the dream
scheduler. The presence of a checkpoint or a `skill.workflow_opportunity` candidate does
not imply that NNA edited project memory, wrote NNM data, changed its runtime, built a
skill, or activated one; those remain separately governed actions.

When the user explicitly asks about the active project, repository, codebase, or
workspace, NNA adds a bounded deterministic intake record before inference. It reports
verified structural names and bounded manifest metadata only. The model must still read
the relevant files before asserting their contents or behavior. Operators can inspect
the same evidence directly with `/project`.

The guidance catalog is separate from the active workspace sandbox. It contains only
bounded Markdown files under the `docs` directory installed with NNA. Search and read are
read-only, deterministically reviewed operations. Results identify the canonical document
ID and packaged path so the Console activity stream shows what NNA consulted.

Documentation and implementation changes belong to the same date-iteration version.
Support bundles and structured logs carry that version so maintainers can compare an
answer or failure with the behavior and guidance that produced it.
