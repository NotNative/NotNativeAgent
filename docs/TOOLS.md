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
The kernel publishes the detected operating system and native shell as authoritative model
context, and the tool schema identifies exactly what `auto` means on the current host. Shell
syntax is never translated between interpreters. Models should prefer `auto`, request a
non-native interpreter only after positive discovery, and prefer structured NNA tools or
`process.run` over shell-built discovery loops. Shell calls should keep one coherent purpose
and avoid unnecessary nested substitutions, deeply nested quoting, or combined mutation and
verification. Reliability signals classify fragile compound scripts for review without imposing
an arbitrary command-length rejection.
The complete script, working directory, and interpreter are sealed into the reviewer request;
NNA then owns interpreter argv, cancellation, output bounds, and process-tree cleanup.
An interpreter launch failure returns `shell_interpreter_unavailable` with the detected host,
native fallback, and a durable instruction not to repeat the unavailable shell.
Both process tools accept a bounded `accepted_exit_codes` list that must contain zero. The
default is `[0]`; additional codes are appropriate only for focused commands whose documented
result protocol uses them, such as `diff` or `grep` returning one for a negative predicate.
An unexpected nonzero exit is recorded as completed nonzero rather than a launch failure, remains
unsuccessful evidence, and is shown as an amber Console result. Compound scripts should keep
mutations separate from verification, and `pipefail` pipelines should avoid early-closing consumers
such as `head` when an upstream `SIGPIPE` would be mistaken for a failed check.

Installed programs such as SSH, Git, Docker, and native system utilities may be invoked through
`process.run` for exact argv or `shell.run` for terminal workflows. The agent should not wrap a
shell inside `process.run`. On Windows, `powershell.exe` is the normal Windows PowerShell 5.1 entry point. `pwsh` identifies the
separately installed, cross-platform PowerShell 7 product and is used only after discovery or
an explicit operator request. Unix-like hosts likewise may provide `sh`, `bash`, or another
shell, and a shell wrapper is used only when its syntax is necessary.
Generated multi-statement interpreter programs should not be nested inside `node -e`,
`python -c`, or similar argv. The agent stores the source as a bounded draft with `ref.store`
and supplies `stdin_ref` to `process.run`, using the interpreter's stdin form such as
`node -` or `python -`. Short, simple inline expressions remain allowed; inline interpreter
requests are classified for review, and a failed inline request leaves durable guidance to use
the draft/stdin route instead of repeating the fragile escaping structure.
The reviewer requires the operation to be a reasonable, proportionate way to carry out
authenticated user intent. Ordinary intermediate commands and targets derived from prior
results need not be named verbatim. A concrete contradiction, scope divergence, or
disproportionate irreversible effect remains a denial.

`system.elevate` is the local root Console's one-shot operating-system elevation boundary.
It runs one exact resolved executable and argv after mandatory semantic review, a fresh
operator confirmation, and native Windows UAC or Unix-like `sudo` authentication. NNA
temporarily returns control of the terminal while the operating system authenticates and
then restores the Console. Approval is never remembered for the session or workspace, and
NNA never requests, reads, stores, or forwards the administrator password. The agent should
first try the operation with the current user's authority and use `system.elevate` only when
the operating system reports that greater authority is required. Passwords, API tokens, and
other literal secrets are forbidden in the elevated request.

The tool is intentionally absent from hosted NNO sessions, headless manifests, Telegram,
and sub-agents. A Console reached through SSH can use it only when that connection owns a
real pseudo-terminal, such as a normal interactive SSH login or `ssh -t`; without a TTY,
`sudo` cannot authenticate and the operation fails closed with guidance. NNA does not add
the user to `sudoers`, create a persistent privileged daemon, or grant a reusable elevated
shell.

Its requested deadline returns a typed timeout immediately
after requesting tree termination. External effects are therefore reported with unknown
certainty and are never automatically retried. POSIX termination escalates from `SIGTERM`
to `SIGKILL`; Windows has both tree and direct-process termination paths. Remaining
process requests are review-required because
repository programs and package scripts may still have effects. The deterministic packet
labels simple argv separately from opaque package scripts, large argv sets, dynamic flags,
and wildcard/regex-like patterns so complexity cannot disappear behind an apparently safe
executable name.

`project.verify` is the governed software-verification boundary. It reads a bounded regular
`package.json`, deterministically chooses the declared npm or Bun adapter, resolves the exact
package scripts and argv, and exposes that complete plan to review before starting a process.
The manifest digest is revalidated immediately before execution so a reviewed script cannot be
silently replaced. Supported scopes are `focused`, `affected`, and `full`; focused Node built-in
or Bun tests can receive explicit test paths, while unsupported affected selection falls back to
the repository script and says so. Results include exact commands, exit codes, bounded output,
the manifest digest, and a stable receipt id in the durable turn record. A completed non-zero
check is a failed tool result, not a green execution success. The Console aliases this boundary
as `/verify [focused|affected|full] [PATH ...]`.
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
- `web.browse`: operate one headless, ephemeral Chromium context for the current standalone
  NNA session. It can navigate, return bounded page text and stable element references,
  interact with a selected element, save a managed screenshot, and close itself. Read-only
  observation is deterministically safe after destination validation; screenshots, clicks, key
  presses, ordinary form entry, and Secret Broker field injection require semantic review. Every
  browser request and redirect is checked against the same exact-origin private-network
  trust policy as `web.fetch`. Hosted NNO sessions do not receive this root tool implicitly.

WebFetch and WebBrowse are independent retrieval paths. When WebFetch fails for an exact URL
supplied by the user or discovered through WebSearch, the agent uses WebBrowse to navigate to
that same URL and inspect the page before abandoning the source. It does not retry the failed
URL through WebFetch. If browser navigation is unavailable or also fails, it proceeds to another
exact discovered URL and reports an inability to verify only after reasonable retrieval paths
have been exhausted.

`web.browse fill_secret` accepts only a Secret Broker record ID and field name. The plaintext
is decrypted inside the trusted browser consumer after review, filled directly into the page,
and never returned in tool output or provider context. Injected values remain in an ephemeral
trusted-process redaction set so reflected page text is scrubbed from later inspection. Browser cookies and storage survive only
for the active NNA session in this release and are discarded on shutdown.

NNA also exposes three read-only self-inspection tools from every workspace:

- `nna.search_guidance`: search the packaged canonical NNA documentation.
- `nna.read_guidance`: read one document returned by the search.
- `nna.list_sessions`: enumerate bounded recent durable sessions for cross-Console troubleshooting.
- `nna.diagnose_turn`: inspect bounded, content-redacted lifecycle evidence for the active or most recent turn, or for an exact durable `session_id` returned by `nna.list_sessions`.
- `agent.run`: run one bounded foreground specialist through the configured Sub-agents provider route; available only to standalone root NNA and absent from hosted catalogs and search.
- `git.inspect`: inspect bounded repository status, working or staged diffs, and recent commit history through explicit read-only Git argv.

Conversation work uses four always-visible engine tools:

- `work.status`: read the current durable goal and ordered task list.
- `work.goal`: set, complete with evidence, or reopen the conversation goal.
- `work.task_add`: append one pending task.
- `work.task_update`: move a task between pending, in-progress, completed, and blocked;
  terminal states require evidence or a reason.

They mutate only bounded conversation work state in the existing session journal and grant
no filesystem, process, network, secret, or host authority. Hosted manifests must explicitly
grant their exact names before they appear.

Compacted history remains queryable without returning it wholesale to the provider:

- `session.search_history`: searches up to the newest 50,000 records in the active
  conversation and returns ranked, redacted snippets with stable record indexes.
- `session.read_history`: reads one exact indexed record plus at most three neighboring
  records on either side. The result is redacted and capped before reinjection.

These tools are read-only, conversation-local, and always visible in a standalone Console.
They do not search other sessions, bypass `/clear`, or widen a hosted manifest. A hosted
session receives them only when its authenticated tool grant names them explicitly.
When provider pressure or durable compaction removes records from the hot working set, NNA may
inject a bounded cold-evidence inventory with stable record indexes and up to three relevant
discovery hints. Those hints are not factual evidence. The agent reads the exact attributed
record through these tools before relying on it.

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
