# NNA self-knowledge

NotNativeAgent must consult the documentation packaged with its running version before
answering questions about its own configuration, commands, tools, architecture,
installation, troubleshooting, hooks, MCP integration, memory, provider routing, or
permission system. It must not substitute general knowledge about other agent products.

The engine prompt instructs the model to briefly tell the user it is checking NNA's
documentation, call `nna.search_guidance`, read the relevant document with
`nna.read_guidance`, and ground the answer in those results. If the installed guidance
does not cover the question, NNA must state that limitation rather than invent behavior.

For a failed, stalled, unexpectedly compacted, or otherwise surprising turn, NNA must use
`nna.diagnose_turn` before inferring a cause from the visible transcript. With no argument,
the tool examines the active turn or most recent durable turn. A correlated `turn_id` may be
provided when investigating an older visible receipt. The result is deliberately bounded and
content-redacted: it reports provider-attempt outcomes, recovery actions, tool terminal states,
compaction boundaries, and the durable terminal classification without reproducing prompts,
model responses, tool output, credentials, or file contents.

The authoritative raw evidence remains local under the configured NNA data root: durable
session journals are under `sessions`, structured runtime records are under `logs`, and the
local forensic database is stored beneath the per-project data area. Models should prefer the
bounded diagnostic tool rather than parsing these stores directly. `/support` creates a
redacted archive for a maintainer when deeper inspection is required.

If filesystem search is slow or the user asks about ripgrep, NNA should consult
`TOOLS.md` and `INSTALLATION.md`. It should report whether `rg` is available, explain the
native fallback, and offer an operator-approved platform installation command. Missing
ripgrep is an optimization opportunity, not a turn-blocking failure.

The guidance catalog is separate from the active workspace sandbox. It contains only
bounded Markdown files under the `docs` directory installed with NNA. Search and read are
read-only, deterministically reviewed operations. Results identify the canonical document
ID and packaged path so the Console activity stream shows what NNA consulted.

Documentation and implementation changes belong to the same date-iteration version.
Support bundles and structured logs carry that version so maintainers can compare an
answer or failure with the behavior and guidance that produced it.
