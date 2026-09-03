# Built-in tools

## Discovery and context economy

Every ordinary provider step receives a deterministic foundational surface, with `tool.search`
first: `tool.search`; `fs.list`, `fs.read`, and `fs.search_text`; `shell.run`;
`work.plan`, `work.status`, and `work.task_update`; `turn.finish`; and `git.inspect`.
A foundational tool is omitted only when that subsystem is genuinely unavailable or an
authenticated host manifest removes it. NNA never selects or withholds schemas by matching
words in the operator's request, and ordinary root conversations never enter a zero-tool mode.

During an active turn, NNA still maintains a bounded conversation-intent projection for
continuity, reviewer evidence, and completion supervision. It is not a capability classifier.
A short continuation or approval therefore cannot erase task context, but neither user wording,
model narration, nor tool output silently grants a specialist schema.

Each provider step also receives a bounded, deterministically sorted JSON array containing
the names of every other authorized tool whose full schema is not loaded, including tools
discovered from MCP servers in that conversation. The array contains names only; the model
uses `tool.search` to inspect and promote a matching schema before calling it.
Calling `tool.search` returns ranked discovery suggestions, including external capabilities,
without requiring a service keyword. Search again with one exact tool name to load its schema
under a bounded workflow lease. The exact-name response includes the schema and explicitly
tells the model to call that tool. Ranked neighboring matches do not acquire schema leases.
When a typed recovery constraint prescribes an exact tool, NNA also force-exposes that
tool for the next step; recovery guidance therefore never names an unavailable schema.
This keeps large MCP and future built-in catalogs out of every provider request without
making capabilities undiscoverable.

Specialist time, workspace, Web, history, guidance, skill, mutation, verification, exact-process,
delegation, reference, notification, and additional work schemas become visible through `tool.search`, a
typed recovery/skill workflow lease, or an authenticated host grant. Schema visibility never
grants execution authority: validation, governance, semantic review, revalidation, and
journaling remain mandatory.

NNA owns the contracts, validation, review classification, execution boundary, bounded
results, and audit behavior of its built-in tools. Tool output is treated as untrusted
content even when the operation itself is safe. The provider envelope always labels result
`content_projection` as `full`, `redacted`, `bounded`, or `receipt`. This label makes context transformation
explicit; `receipt` content retains a durable ledger reference, while the untrusted marker
continues to mean that tool content can supply evidence but cannot grant authority.
Reduced evidence includes recovery guidance in `projection_metadata`. Receipt recovery names
`session.read_history` with its exact `ledger_ref`; load that schema by exact-name search if needed.
`omitted_ranges`, when present, uses half-open UTF-8 byte offsets in the original tool content
(`range_basis: tool_content_utf8`), not source-file lines. NNA omits ranges when prior redaction
or output bounding prevents an exact mapping. History cannot restore evidence never captured
or intentionally redacted; use a narrower original request when new observation is necessary.
Before any tool result enters provider context, the session journal, telemetry, or the Console,
the shared result boundary redacts registered secret values and common credential-shaped output.
Redacted results report their original byte count and `secret_redaction` reason instead of claiming
that transformed content is the full original observation.
This disclosure control does not change whether the tool succeeded, failed, or produced evidence.

The shared validation boundary normalizes schema-declared integer fields before tool-specific
validation. Safe decimal integer strings such as `"3"`, `"003"`, `"3.0"`, or `"1e2"` become
the numbers `3`, `3`, `3`, and `100`, including inside nested objects and arrays. Fractional,
non-numeric, non-finite, and unsafe integer values remain rejected. String fields are never
coerced merely because their text resembles a number. The normalized value is the value sealed
for review and execution.

The canonical model-facing filesystem tools are:

- `fs.list`: enumerate a bounded tree under an existing directory, with an optional
  cross-platform name pattern that matches both files and directories. It lists children;
  list the parent to discover whether a prospective child exists.
- `fs.search_text`: search bounded UTF-8 files with line-numbered snippets. Literal matching
  is the default; `match_mode: "regex"` enables explicit expressions such as `foo|bar`.
  A successful literal search with no matches remains a negative observation, not a failure.
  When its query contains expression syntax, the result suggests `match_mode: "regex"` without
  assuming that expression matching was the operator's intent.
  NNA transparently uses `rg` when available and falls back to its bounded native search.
- `fs.read`: read up to 1 MiB of UTF-8 text or, when `start_line`/`line_count` are supplied,
  at most 400 numbered lines. It returns a SHA-256 snapshot tag and an internal receipt for
  exactly what was observed. Its public arguments are only `path`, `start_line`, and
  `line_count`; complete-file versus numbered-window selection is internal metadata, not a
  model-facing `mode` argument.
- `fs.directory`: create or remove a directory. Creation is recursive and idempotent by
  default. Removal is non-recursive unless requested and remains review-required and bounded.
  Filesystem roots, the home directory, the active workspace root and its ancestors, and the
  NNA data root cannot be mutation targets. The canonical arguments are `action` and `path`;
  the runtime also normalizes common unambiguous spellings such as `operation` and
  `directoryPath` before review.
- `fs.write_text`: atomically create or replace a provider-safe text payload of at most
  32 KiB. Larger implementations are split across files or completed with focused edits. Missing parent
  directories for a new target are created as part of the same governed operation. A
  successful full write records the resulting content as authored state, allowing an
  immediate follow-up edit without a redundant read. For an existing file
  inside the workspace, the runtime may take a bounded request-local transaction snapshot,
  bind its digest to review, and revalidate it immediately before commit. `path` and `content`
  remain the canonical arguments, while common unambiguous `filePath`/`file_path` and `text`
  spellings are normalized before the request is sealed. The snapshot is
  content-free in the review packet and cannot authorize another operation. Existing files
  outside the workspace still require an explicit `fs.read` receipt.

The granular `fs.list_directory`, `fs.glob`, `fs.metadata`, `fs.read_text`, `fs.read_lines`,
`fs.create_directory`, `fs.edit_lines`, `fs.copy_file`, `fs.move_file`, and `fs.delete_file`
definitions remain installed for compatibility and specialist/internal workflows. They are
not competing choices in a fresh model-facing catalog.

`shell.run` is the normal model-facing execution tool for authenticated build, test, install,
and other terminal intent. `process.run` is not loaded into that ordinary task surface. It
remains installed, governed, and discoverable for cases that specifically require one exact
executable and argv without shell interpretation. Hosted or host-ceilinged sessions that have
`process.run` but no `shell.run` receive it as the execution fallback.

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
`shell.run` accepts one readable terminal workflow, including ordinary command-line programs,
pipelines, redirection, expansion, or multiple commands. It selects Windows PowerShell 5.1 on Windows
and `sh` on Unix-like hosts unless the caller explicitly chooses another supported interpreter.
The kernel publishes the detected operating system and native shell as authoritative model
context, and the tool schema identifies exactly what `auto` means on the current host. Shell
syntax is never translated between interpreters. Models should prefer `auto`, request a
non-native interpreter only after positive discovery, and prefer structured NNA tools over
shell-built discovery loops. Shell calls should keep one coherent purpose
and avoid unnecessary nested substitutions, deeply nested quoting, or combined mutation and
verification. Reliability signals classify fragile compound scripts for review without imposing
an arbitrary command-length rejection. A conservatively parsed PowerShell `Get-ChildItem`
pipeline is classified as a read-only filesystem observation when every stage is a passive
projection, formatting, sorting, measurement, or `Out-Null` command. Subexpressions, script
blocks, mutation commands, unsafe redirection, and unknown stages keep the call review-required.
The proven read-only effect is used consistently by governance, effect certainty, progress
accounting, and Console presentation. The same closed grammar recognizes selected PowerShell
host observations for processes, services, event logs, CIM/system facts, disks, volumes, and
network state. Output-only projection and `Format-*` stages remain read-only; a script block,
unknown stage, or mutating command keeps the complete request review-required. Consequential
commands, including disk formatting, are not categorically prohibited: semantic review compares
the exact action and target with authenticated user intent. Shell execution is foreground by default and should
terminate within the reviewed call. Detachment primitives such as PowerShell `Start-Process` or
`Start-Job`, POSIX `nohup`, `disown`, or background `&`, and equivalent runtime flags are detected
as lifecycle-changing requests. They are denied with corrective guidance unless authenticated
user intent explicitly requests the persistent or background process; explicit intent permits
semantic review but never bypasses it. This preserves a small tool surface without silently
allowing a child process to outlive the reviewed call and active turn.
The complete script, working directory, and interpreter are sealed into the reviewer request;
NNA then owns interpreter argv, cancellation, output bounds, and process-tree cleanup.
An accepted exit code means that the interpreter process completed under its declared protocol.
It does not prove that every diagnostic inside a compound script succeeded. Process results record
observed stdout and stderr byte counts. `stderr_present` identifies a non-empty stderr stream without
turning the call into a failure. `reduced_by_script` identifies shell syntax that suppresses diagnostic
output, so the model must preserve uncertainty about checks that might have been hidden.
An interpreter launch failure returns `shell_interpreter_unavailable` with the detected host,
native fallback, and a durable instruction not to repeat the unavailable shell.
Both process tools accept a bounded `accepted_exit_codes` list that must contain zero. The
default is `[0]`; additional codes are appropriate only for focused commands whose documented
result protocol uses them, such as `diff` or `grep` returning one for a negative predicate.
An unexpected nonzero exit is recorded as completed nonzero rather than a launch failure, remains
unsuccessful verification evidence, and is shown as an amber Console result. Its first distinct
invocation counts as diagnostic progress because the command ran and returned bounded negative
evidence; repeating identical tool arguments does not earn progress again, even when incidental
output changes. Compound scripts should keep
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

`system.elevate` remains disabled. Local interactive Windows Console sessions can use
`shell.run` with `privilege: "administrator"`, a `reason`, and a complete PowerShell script
(at most 8192 characters; no `stdin_ref`). The default remains ordinary user privilege.
Semantic review must approve before native UAC appears. There is no second NNA confirmation.
The Console remains visible and the workflow waits for UAC; `timeout_ms` starts after
authentication, not while waiting for the user. UAC cancellation or OS refusal is non-approval.
Process cancellation or missing results after launch retain uncertainty: inspect the target
before retrying. This is one operation, not a reusable administrator shell or service.
`accepted_exit_codes` may include documented Windows codes such as MSI 3010; that code reports
`reboot_required`, and NNA does not initiate a reboot. Verify the requested configuration or
installation afterward; a successful exit is not evidence that the user's objective was achieved.
Linux/macOS, headless, hosted, and unattended sessions must ask the user to run privileged
commands manually and continue from the supplied result. NNA never collects a sudo password.

`process.run` and `shell.run` reject `sudo`, `doas`, `pkexec`, `runas`, and PowerShell
`Start-Process -Verb RunAs` launchers. This keeps native elevation behind the reviewed
administrator contract. NNA does not add the user to `sudoers`, create a persistent privileged
daemon, request a password, or grant a reusable elevated shell. Remaining
process requests are review-required because
repository programs and package scripts may still have effects. The deterministic packet
labels simple argv separately from opaque package scripts, large argv sets, dynamic flags,
and wildcard/regex-like patterns so complexity cannot disappear behind an apparently safe
executable name.

`project.verify` remains the governed software-verification boundary selected for explicit
verification workflows. It reads a bounded regular
`package.json`, deterministically chooses the declared npm or Bun adapter, resolves the exact
package scripts and argv, and exposes that complete plan to review before starting a process.
Its `passed` field requires every requested check to be available and successful, with complete process evidence.
The receipt labels its evidence scope as `requested_project_checks`, not proof of the entire user objective.
Supply task-specific acceptance tests through focused test paths when those tests exist.
The manifest digest is revalidated immediately before execution so a reviewed script cannot be
silently replaced. Supported scopes are `focused`, `affected`, and `full`; focused Node built-in
or Bun tests can receive explicit test paths, while unsupported affected selection falls back to
the repository script and says so. Results include exact commands, exit codes, bounded output,
the manifest digest, and a stable receipt id in the durable turn record. A completed non-zero
check is a failed tool result, not a green execution success. The Console aliases this boundary
as `/verify [focused|affected|full] [PATH ...]`.
- `fs.edit_text`: make one bounded edit using an exact, normally unique `find` match and
  `content` as the replacement. An empty `content` deletes the selected text, and `all` must be
  explicit for multiple exact matches. Exact matching safely normalizes LF/CRLF differences.
  The runtime accepts the former `old_text`, `new_text`, and `replace_all` spellings plus common
  unambiguous aliases, but seals every accepted request into one canonical reviewed mutation.
  Conflicting aliases fail closed. The exact anchor is capped at 16 KiB, replacement content at
  32 KiB, and their combined UTF-8 payload at 40 KiB so the complete JSON call remains inside a
  practical local-provider output envelope.

Installed compatibility definitions retain the narrower historical operations:

- `fs.edit_lines`: replace an inclusive numbered range previously displayed by `fs.read_lines`.
  Replacement content is capped at 32 KiB; larger rewrites use multiple focused edits.
- `fs.delete_file`: permanently delete one regular file after semantic review and
  exact-content revalidation.
- `fs.metadata`: inspect bounded file or directory metadata without reading content.
- `fs.create_directory`: recursively create an accessible directory and any missing parent
  directories. It is idempotent: targeting an existing directory succeeds without changing it.
- `fs.copy_file` and `fs.move_file`: copy or move an exact-hash regular file to a new
  destination. They refuse overwrites and revalidate immediately before commit.

Every existing-file mutation is bound to runtime-observed state; knowing or guessing a digest
is insufficient. In-workspace whole-file writes and canonical text edits may use a transaction
snapshot owned by that single sealed request. Compatibility line edits, copies, moves, deletions,
and host paths require an explicit model-visible read receipt. New-file and new-directory creation are
exempt. Transaction snapshots never enter the reusable state-receipt ledger; a successfully
committed full write does, because the model supplied the complete resulting content.
When multiple already-reviewed whole-file writes or independent exact-text edits target the
same file in one provider batch, execution remains ordered. A successful NNA-authored state may
advance the trusted snapshot for the following mutation when its exact requested effect remains
valid. Changes not matching the latest runtime-authored digest continue to fail closed as
`tool_revalidation_drift`.

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

`workspace.change` replaces the current working directory for one standalone conversation. It
accepts one existing directory, reaches semantic review, and commits only after its journal record
succeeds. The next provider step receives the new workspace root and newly applicable `AGENTS.md`
guidance. Relative paths, project intake, sub-agent scope, and the Console tab projection use the
new directory. Sibling tabs remain unchanged, and durable restoration returns to the last committed
directory. A shell `cd` or `Set-Location` affects only that foreground process and cannot silently
change conversation state. Explicit authenticated intent may separately authorize one outside-CWD
operation; that operation does not change the CWD. Hosted execution manifests cannot expose or use
`workspace.change` because their canonical workspace ceiling is immutable.

`process.run` remains review-required. Bounded direct network diagnostics such as DNS lookup,
ping, traceroute, and exact PowerShell `Test-Connection` or `Resolve-DnsName` commands are
identified as non-mutating discovery. An authenticated request to find, resolve, or test a host
covers a diagnostic continuation from its hostname to an address returned by a prior tool. The
semantic reviewer receives a bounded, redacted, untrusted causal-evidence packet. The packet keeps
the newest causal tail and supplements it with relevance-ranked records from anywhere in the
bounded journal scan, including earlier in the same long turn. This prevents intervening work from
displacing prior evidence about the exact target under review. Tool output can connect targets but
can never grant authority. Shell composition or additional commands do not receive this
classification.

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
  interact with a selected element, save a managed screenshot, and close itself. Screenshot
  capture returns the durable PNG path as a completed browser result and deterministically exposes
  `image.inspect` for the following model step; `image.inspect` performs
  optional visual interpretation in a separate provider-backed tool step and returns a bounded
  pass, minor-caveat, material-issue, or uncertain verdict. Only a newer visual inspection can
  supersede that verdict; DOM text and console output cannot. Read-only
  observation is deterministically safe after destination validation; screenshots, clicks, key
  presses, ordinary form entry, and Secret Broker field injection require semantic review.
  Standalone root sessions may also propose an exact `localhost`, `127.0.0.1`, or `[::1]`
  development origin for semantic review. An approved loopback origin is admitted only while
  that origin is the active page; cross-port loopback requests, private LAN hosts, and WebFetch
  remain blocked unless separately trusted. Hosted NNO sessions do not receive this root tool
  implicitly.

WebFetch and WebBrowse are independent retrieval paths. When WebFetch fails for an exact URL
supplied by the user or discovered through WebSearch, the agent uses WebBrowse to navigate to
that same URL and inspect the page before abandoning the source. It does not retry the failed
URL through WebFetch. If browser navigation is unavailable or also fails, it proceeds to another
exact discovered URL and reports an inability to verify only after reasonable retrieval paths
have been exhausted.

For visual verification of a workspace development server, use `web.browse navigate` on the
exact HTTP(S) loopback URL and then inspect or screenshot the page. Do not discover or launch an
installed browser through `shell.run`; NNA's managed browser keeps the observation ephemeral,
bounded, and reviewable. This is network navigation, not permission to read a `file://` URL.

`web.browse fill_secret` accepts only a Secret Broker record ID and field name. The plaintext
is decrypted inside the trusted browser consumer after review, filled directly into the page,
and never returned in tool output or provider context. Injected values remain in an ephemeral
trusted-process redaction set so reflected page text is scrubbed from later inspection. Browser cookies and storage survive only
for the active NNA session in this release and are discarded on shutdown.

NNA installs bounded self-inspection tools independently of the workspace:

- `nna.search_guidance`: search the packaged canonical NNA documentation.
- `nna.read_guidance`: read one document returned by the search.
- `nna.diagnose_turn`: inspect bounded, content-redacted lifecycle evidence using selector
  `current`, `latest`, `latest_failed`, or `list`, or an exact durable `session_id`/`turn_id`.
- `agent.run`: run one bounded foreground specialist through the configured Sub-agents provider route; available only to standalone root NNA and absent from hosted catalogs and search.
- `git.inspect`: inspect bounded repository status, working or staged diffs, and recent commit history through explicit read-only Git argv.

Conversation work has one atomic tool and four granular tools in the foundational surface:

- `work.plan`: atomically replace the bounded goal and ordered tasks; terminal states require
  evidence or a reason and at most one task may be in progress. Its result uses the same
  model-facing shape as its input. A blocked goal requires `goal_blocked_reason`, and every
  unfinished task must also be blocked. The optional returned `revision` prevents stale replacement.
- `work.status`: inspect the current durable goal and ordered tasks. When work exists, its result
  can be passed unchanged to `work.plan`.
- `work.goal`: create, update, complete, block, or reopen the durable goal.
- `work.task_add`: append one task to the current goal.
- `work.task_update`: update one existing task by its stable id.

They mutate only bounded conversation work state in the existing session journal and grant
no filesystem, process, network, secret, or host authority. Their presence does not require
the model to create a plan. When the operator explicitly asks to set, create, load, or track a
goal or task list, the model must persist it with one of these tools before beginning dependent
work. Hosted manifests retain their exact grants and never infer one work tool from another.

Compacted history remains queryable without returning it wholesale to the provider:

- `session.search_history`: searches up to the newest 50,000 records in the active
  conversation and returns ranked, redacted snippets with stable record indexes.
- `session.read_history`: reads by `record_index` or an exact receipt `ledger_ref`, not both.
  Ledger references select tool results within the newest 50,000 retained records.
  Up to three neighbors on each side are optional. Results are redacted and capped before reinjection.

These tools are read-only, conversation-local, and foundational when session history is
available.
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

The provider receives an immutable prompt-visible working set: the available foundational
tools remain loaded in deterministic order, while specialist schemas are added only by an
explicit workflow lease or authenticated host manifest. Root NNA includes `shell.run` in the
foundation; a hosted manifest may instead grant `process.run`. A host execution manifest may
ceiling the complete capability set, including to an empty list. Regardless of visibility,
every tool call remains unknown to governance until it passes the normal validation and review
pipeline.

The durable provider-surface receipt reports the composition actually enforced:
`foundation_with_leases` for a root conversation or `host_manifest` for an authenticated host
ceiling. It does not report orientation, action, recovery, or monitoring phases because those
labels do not change tool selection or its limits.
