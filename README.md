# NotNativeAgent

NotNativeAgent (NNA) is a local-first, model-agnostic agent runtime built to make capable
language models useful, observable, and safe to operate. Its engine provides reviewed
tool execution, durable steering, bounded recovery, long-horizon context compression and
compaction, concurrent
cancellation, and non-replaying session resume through a consistent lifecycle and NDJSON
projection. Images, optional attributed memory, governed MCP tools, and extension adapters
use the same state, cancellation, privacy, and review boundaries.

The **NNA Console** adds a state-first TUI, authenticated allow-once
reviewer escalation, isolated multi-conversation projections, fair local-provider
scheduling, read-only health, redacted governance audit and diagnostic bundles, plain
one-shot mode, optional durable goal/task progress, and recoverable session-data deletion. Additional security, visual-design,
native-platform, and live-server release validation remains pending; see
[release readiness](docs/RELEASE_READINESS.md).

## Getting started

Download or clone the repository, open a terminal in its root directory, and run the
installer for your platform:

```powershell
# Windows PowerShell
.\install.ps1
```

```sh
# Linux or macOS
sh ./install.sh
```

Follow the installer prompts to configure an OpenAI-compatible provider endpoint, optional
authentication key, and default model. The installer also checks supporting dependencies
and preserves an existing NNA configuration when upgrading.

WebSearch setup is highly recommended. You can point NNA at an existing SearXNG endpoint or
let the installer offer a local Docker deployment when Docker is available. The Telegram
gateway is optional; configure it only if you want to communicate with NNA remotely through
an authorized Telegram account. Interactive WebBrowse is also optional: the installer skips
an existing valid Playwright Chromium runtime, or offers to download one when it is absent.

When installation finishes, open a new terminal if instructed and launch the Console:

```sh
nna
```

Releases use the canonical `YYYYMMDD-<iteration>` identifier documented in
[the versioning policy](docs/VERSIONING.md).

The per-user productization layer adds Windows, Linux, and macOS installers,
stable home-scoped application data, safe marker-checked uninstallers, and native installer
test coverage. See [per-user installation](docs/INSTALLATION.md).
Reinstalling replaces the complete `installed` application payload while preserving
managed runtimes and all home-scoped session/configuration data.
Remove NNA with `nna uninstall`. A directly attached operator must complete a randomized
confirmation challenge; agents, scripts, redirected input, and flags cannot authorize
removal. The operator can retain or permanently delete `~/.nna`.

## Operator responsibility

You are responsible for the models, tools, credentials, permissions,
instructions, integrations, provider destinations, mission authority, and
resources you configure, and for deciding whether resulting agent actions are
appropriate. Reviewer, ledger, governance, sandboxing, and recovery controls
reduce risk; they do not guarantee safety. Reviewer approval is authorization
under available evidence, not proof that an operation is harmless. The software
is provided under Apache-2.0 without warranty; Sections 7 and 8 govern warranty
and liability.

## Run the milestone

Node.js 24 or newer is required. No npm package installation is needed; the platform
installers validate an existing runtime or install a verified per-user Node 24 LTS binary.

```sh
npm test
node src/cli.js host
node src/cli.js --config manifest.json
node src/cli.js --config manifest.json -p "Hello"
npm run release:check
```

For an installed command, run `install.ps1` on Windows or `install.sh` on Linux from the
repository root, open a new terminal if needed, and use `nna`. Durable sessions and
reviewer records live under `~/.nna` instead of the launch directory.

On a new installation, the installer asks for an OpenAI-compatible provider URL and an
optional API key, discovers the endpoint's `/v1/models` catalog, and accepts either the
displayed number or exact model name. Existing provider profiles are detected and left
unchanged. Use `-SkipProviderSetup` on Windows or `--skip-provider-setup` on POSIX for an
unattended installation.

After installation, the normal entry point is simply:

```sh
nna
```

It loads `$HOME/.nna/config/manifest.json` and launches the Console. On first run,
NNA uses explicit `NNA_PROVIDER_ENDPOINT` plus `NNA_MODEL` settings, discovers a compatible
loopback provider on common local ports, or asks for the endpoint and model, then saves the
validated configuration. `nna -p` runs one prompt and exits, while `nna host` exposes the
structured parent-process protocol. Explicit `nna tui`, `nna text`, and `nna headless`
aliases remain available.

Send one UTF-8 JSON object per line. Initialize first, then submit:

```json
{"version":"1.0","type":"initialize","request_id":"init-1","manifest":{"persistence":"ephemeral","provider":{"id":"local","endpoint":"http://127.0.0.1:11434/v1","model":"model","trust_zone":"loopback"}}}
{"version":"1.0","type":"submit","request_id":"submit-1","content":"Hello"}
```

Stdout is protocol-only; diagnostics use stderr. The current tool snapshot includes
bounded host-visible discovery, glob, text search, read, write, exact edit, metadata,
directory, copy, move, delete, reviewed `process.run` and `shell.run`, configured WebSearch, public WebFetch,
and packaged NNA
self-guidance. Root sessions may act outside their working directory when requested; NNO and
other hosted sessions remain bounded by their execution manifest. Reads are deterministically
reviewed; mutations require exact authenticated intent and applicable recovery/review state. Submit commands
may include a bounded
`attachments` array of `{ "path", "mime_type" }` descriptors. Temporarily failed images
can be retried by identity with `attachment_retry` or removed with `attachment_remove`.
Memory and MCP remain disabled unless explicitly configured. Provider connect,
first-token, idle, and overall deadlines are distinct; local no-progress work
stops after three equivalent failures while unique progress may continue under
the generous step limit. Contributions and feedback are welcome and voluntary;
they are not additional license conditions.

See the [runtime architecture](docs/architecture/0001-runtime.md),
[recovery architecture](docs/architecture/0003-recovery.md),
[attachments, memory, and MCP architecture](docs/architecture/0004-attachments-memory-mcp.md),
[operator-product architecture](docs/architecture/0005-operator-product.md), and
[durable conversation work](docs/architecture/0008-conversation-work.md).
