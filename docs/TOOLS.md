# Built-in tools

## Discovery and context economy

`tool.search` is always visible and searches the complete registered catalog with a
bounded lexical relevance score. Core workspace and NNA self-guidance tools remain
visible; a small set of additional tools is selected from authenticated operator text.
Each provider step also receives a bounded, deterministically sorted JSON array containing
the names of every other authorized tool whose full schema is not loaded. This includes
tools discovered from MCP servers in that conversation. The array contains names only;
the model uses `tool.search` to inspect and promote a matching schema before calling it.
Calling `tool.search` exposes its bounded matches for later model steps in the session.
This keeps large MCP and future built-in catalogs out of every provider request without
making capabilities undiscoverable.

NNA owns the contracts, validation, review classification, execution boundary, bounded
results, and audit behavior of its built-in tools. Tool output is treated as untrusted
content even when the operation itself is safe.

The native filesystem tools are:

- `fs.list_directory`: discover a bounded directory tree.
- `fs.glob`: find files with a cross-platform glob without constructing a shell command.
- `fs.search_text`: search bounded UTF-8 files with line-numbered snippets. Literal matching
  is the default; `match_mode: "regex"` enables explicit expressions such as `foo|bar`.
  NNA transparently uses `rg` when available and falls back to its bounded native search.
- `fs.read_text`: read up to 1 MiB of UTF-8 text and return its SHA-256 snapshot tag and
  an internal read receipt.
- `fs.read_lines`: read at most 400 numbered lines from an exact snapshot. Receipts retain
  which line ranges were actually shown.
- `fs.write_text`: atomically create or replace a bounded text file. Replacing an
  existing file requires the digest returned by `fs.read_text`.

`process.run` executes one explicit executable with an argv array and `shell: false` at the
Node process boundary. Its cwd may be any accessible host directory for ordinary root NNA;
environment, duration, and combined output are
bounded, and cancellation terminates the process tree. Child environment inheritance is
an explicit allowlist of operating-system discovery, user configuration paths, locale,
temporary storage, shell/module discovery, and SSH-agent values. This includes foundational
Windows locations such as `ProgramData`, which Windows OpenSSH requires, and Unix home/XDG
locations used by user-scoped command-line tools. Arbitrary parent variables, credential
helpers, provider keys, cloud secrets, and other secrets are not forwarded. Shell interpreters, destructive
file-management programs, destructive Git cleanup/reset, inline interpreter payloads,
package scripts, and complex argv are classified for semantic review rather than hard-blocked.
`shell.run` accepts one readable script when shell behavior is actually needed: pipelines,
redirection, expansion, or multiple commands. It selects Windows PowerShell 5.1 on Windows
and `sh` on Unix-like hosts unless the caller explicitly chooses another supported interpreter.
The complete script, working directory, and interpreter are sealed into the reviewer request;
NNA then owns interpreter argv, cancellation, output bounds, and process-tree cleanup.

Installed programs such as SSH, Git, Docker, and native system utilities may be invoked through
`process.run` for exact argv or `shell.run` for terminal workflows. The agent should not wrap a
shell inside `process.run`. On Windows, `powershell.exe` is the normal Windows PowerShell 5.1 entry point. `pwsh` identifies the
separately installed, cross-platform PowerShell 7 product and is used only after discovery or
an explicit operator request. Unix-like hosts likewise may provide `sh`, `bash`, or another
shell, and a shell wrapper is used only when its syntax is necessary.
The reviewer requires the operation to be a reasonable, proportionate way to carry out
authenticated user intent. Ordinary intermediate commands and targets derived from prior
results need not be named verbatim. A concrete contradiction, scope divergence, or
disproportionate irreversible effect remains a denial.
Its requested deadline returns a typed timeout immediately
after requesting tree termination. External effects are therefore reported with unknown
certainty and are never automatically retried. POSIX termination escalates from `SIGTERM`
to `SIGKILL`; Windows has both tree and direct-process termination paths. Remaining
process requests are review-required because
repository programs and package scripts may still have effects. The deterministic packet
labels simple argv separately from opaque package scripts, large argv sets, dynamic flags,
and wildcard/regex-like patterns so complexity cannot disappear behind an apparently safe
executable name.
- `fs.edit_text`: replace an exact, normally unique text match. The request requires the
  current file digest; `replace_all` must be explicit for multiple matches.
- `fs.edit_lines`: replace an inclusive numbered range only when that complete range was
  displayed by `fs.read_lines` for the same file snapshot.
- `fs.delete_file`: permanently delete one regular file after semantic review and
  exact-content revalidation.
- `fs.metadata`: inspect bounded file or directory metadata without reading content.
- `fs.create_directory`: create one new directory under an accessible existing parent.
- `fs.copy_file` and `fs.move_file`: copy or move an exact-hash regular file to a new
  destination. They refuse overwrites and revalidate immediately before commit.

Every existing-file mutation requires an internal receipt for the supplied digest; knowing
or guessing a digest is insufficient. Whole-file writes, copies, moves, and deletions require
a whole-file read. New-file and new-directory creation are exempt.

`code.diagnostics` is an optional LSP client. It speaks bounded JSON-RPC over stdio to a
local language-server executable explicitly configured in `~/.nna/config/lsp.json`; NNA
does not install or download a language server. Launching the configured server remains
review-required because that process is outside NNA's deterministic read boundary.

For an ordinary root NNA session, relative paths start at the working directory and absolute
or parent-relative paths may address any location accessible to the operating-system identity.
Canonical link resolution determines the real review target; symlinks are not treated as an
automatic denial. The working directory is the primary risk boundary: authenticated mutations
of Git-tracked files and creation of new targets are deterministically recoverable, while
untracked/external/destructive effects reach the semantic reviewer. Explicit user intent can
authorize a destructive result when the proposed operation and scope match it. Hosted sessions
(including NNO sessions) retain a hard canonical workspace ceiling from their execution manifest.
Device namespaces, Windows reserved device stems, control characters, and non-portable
trailing-dot/space segments remain rejected consistently on every platform.

`process.run` remains review-required. Bounded direct network diagnostics such as DNS lookup,
ping, traceroute, and exact PowerShell `Test-Connection` or `Resolve-DnsName` commands are
identified as non-mutating discovery. An authenticated request to find, resolve, or test a host
covers a diagnostic continuation from its hostname to an address returned by a prior tool. The
semantic reviewer receives that recent result as bounded, redacted, untrusted causal evidence;
tool output can connect targets but can never grant authority. Shell composition or additional
commands do not receive this classification.

The Console command `/diff` shows the text changes NNA has recorded during the active
conversation runtime; `/diff PATH` narrows the view to one file. This ledger is observational
and does not replace Git or another durable version-control system.

The global WebSearch tool is:

- `web.search`: query the configured SearXNG JSON API and return bounded source
  summaries. Its endpoint may intentionally be loopback, private-network, or public;
  that exception applies only to this tool and does not relax other network tools.
- `web.fetch`: fetch up to 1 MiB of UTF-8 text from an explicit public HTTP(S) URL or an
  exact private origin deliberately trusted through `/webfetch`. Redirects and DNS answers
  are revalidated, and the native HTTP(S) connection is pinned to the validated address
  while retaining the original Host/TLS server name. Untrusted loopback, private,
  link-local, reserved, credential-bearing, non-text, and over-sized destinations or
  responses are rejected. Origin trust never acts as a subnet wildcard.

NNA also exposes three read-only self-inspection tools from every workspace:

- `nna.search_guidance`: search the packaged canonical NNA documentation.
- `nna.read_guidance`: read one document returned by the search.
- `nna.list_sessions`: enumerate bounded recent durable sessions for cross-Console troubleshooting.
- `nna.diagnose_turn`: inspect bounded, content-redacted lifecycle evidence for the active or most recent turn, or for an exact durable `session_id` returned by `nna.list_sessions`.
- `agent.run`: run one bounded foreground specialist through the configured Sub-agents provider route; available only to standalone root NNA and absent from hosted catalogs and search.
- `git.inspect`: inspect bounded repository status, working or staged diffs, and recent commit history through explicit read-only Git argv.

The guidance tools read only documentation shipped with the running NNA version. The turn
diagnostic reads only bounded, content-redacted lifecycle fields from NNA's own journal.

When `rg` is unavailable, the agent should explain that search still works through the native
fallback and offer platform-appropriate installation help rather than claiming the task is
blocked. Typical commands are `winget install --id BurntSushi.ripgrep.MSVC --exact` on
Windows, `brew install ripgrep` on macOS, and the distribution package manager's
`install ripgrep` command on Linux. Installing software remains an operator-authorized action.

The provider receives an immutable prompt-visible working set: essential tools remain
loaded, relevant tools are selected lexically for the authenticated request, and the
always-visible `tool.search` capability provides on-demand discovery of the remaining
catalog. A host execution manifest may ceiling the complete tool capability, in which
case the provider receives an empty tool list and requests remain unknown at governance.
