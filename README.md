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

## Desktop surface

The desktop GUI is one of NNA's own surfaces. It has no separate product name and
no separate release identity. See
[ADR 0073](docs/architecture/0073-desktop-surface-identity.md).

**Parked.** The `desktop/` subtree has been removed from the working tree and its
former preservation branch is retired; the root backend (`src/desktop-*.js`), its
suites, and the payload contract remain on main and stay tested. The retired
branch was fully merged before deletion, so no desktop GUI subtree exists to
restore without rebuilding it from history.

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
let the installer offer a local Docker deployment when Docker is available. The `/websearch`
manager can add ordered fallback SearXNG profiles after installation. The Telegram
gateway is optional; configure it only if you want to communicate with NNA remotely through
an authorized Telegram account. Interactive WebBrowse is also optional: the installer skips
an existing valid Playwright Chromium runtime, or offers to download one when it is absent.

When installation finishes, open a new terminal if instructed and launch the Console:

```sh
nna
```

Releases use the canonical `YYYYMMDD-<iteration>` identifier documented in
[the versioning policy](docs/VERSIONING.md).

Installed Consoles perform a silent, non-blocking check of the official repository's `VERSION`
no more than once every 24 hours. When a newer version exists, `update available` appears at
the far right of the footer; offline or failed checks do not delay startup or display noise.
Updates are always operator-initiated:

```sh
nna update --check
nna update
```

`nna update` resolves the repository's `main` branch to an immutable commit, reads `VERSION`
from that exact commit, downloads that pinned source snapshot, validates the
product and version, reuses the idempotent installer without repeating onboarding, verifies
the installed command, and restores the prior installed runtime if installation fails. It
never installs an unpinned moving branch and never replaces `~/.nna` user data.

The per-user productization layer adds Windows, Linux, and macOS installers,
stable home-scoped application data, safe marker-checked uninstallers, and native installer
test coverage. See [per-user installation](docs/INSTALLATION.md).
Reinstalling replaces the complete `installed` application payload while preserving
managed runtimes and all home-scoped session/configuration data.
Remove NNA with `nna uninstall`. A directly attached operator must complete a randomized
confirmation challenge; agents, scripts, redirected input, and flags cannot authorize
removal. The operator can retain or permanently delete `~/.nna`.

## Using NNA as OpenChamber's OpenCode

NNA can serve as the OpenCode runtime behind
[OpenChamber](https://openchamber.dev/), presenting NNA's session engine through
the OpenCode 2.x API that OpenChamber drives. See
[the protocol document](docs/OPENCODE_PROTOCOL.md) for the full compatibility
contract.

Two integration modes exist:

**Spawned (recommended).** OpenChamber starts and stops NNA itself, the way it
starts its own OpenCode. Run once to point the host at NNA:

```sh
nna opencode enable
```

This records the NNA launcher in the host's spawn environment and clears any
attach-mode variables from an earlier setup. After that, simply start
OpenChamber: it runs `nna opencode serve --stdio --hostname <host> --port <port>`
as its OpenCode child, and closing OpenChamber stops NNA with it. To return
OpenChamber to its bundled OpenCode, run `nna opencode disable`.

**Detached service.** NNA runs on its own and OpenChamber attaches to it:

```sh
nna opencode start    # detached managed service
nna opencode stop     # stop it
nna opencode status   # runtime and wiring state
```

In this mode NNA publishes the OpenChamber binding (`OPENCODE_HOST`,
`OPENCODE_SERVER_PASSWORD`, `OPENCODE_SKIP_START`) so a launch of OpenChamber
attaches to the running service. `enable` also installs a sign-in script that
starts the detached service at login; `disable` removes it.

`disable` clears **both** wirings, because either one alone keeps OpenChamber off
its own OpenCode: the spawn pointer (`OPENCODE_BINARY`) and any attach binding
`start` left behind (`OPENCODE_SKIP_START` and its companions). The attach names
are cleared when NNA can prove the binding is its own — either because every value
matches this install's configuration, or because `OPENCODE_SKIP_START` is `true`
and `OPENCODE_HOST` names this install's own bind address. That second proof
matters: a credential that rotated, or a binding written by a different build or
data root, still pins OpenChamber to a port nothing listens on, and the strict
value-for-value proof cannot see it. A binding at any *other* address is treated
as the operator's own and preserved.

`stop` keeps the strict proof, because stopping a runtime says nothing about what
the host should do next.

Sessions persist across restarts in both modes: the conversation list, titles,
archive state, and transcripts are stored durably and restored at the next boot.
Deleting a session in OpenChamber removes it permanently, including its journal.

Provider setup for this surface is separate from the Console's provider
configuration: connect API keys in OpenChamber's own provider settings, which
writes an OpenCode-format configuration NNA reads. Credentials are stored in an
isolated encrypted vault and bound to the endpoint where they were connected.

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
directory, copy, move, delete, governed Node/npm and Bun project verification, reviewed
`process_run` and `shell_run`, configured WebSearch, public WebFetch,
and packaged NNA
self-guidance. Root sessions may act outside their working directory when requested; NNO and
other hosted sessions remain bounded by their execution manifest. Reads are deterministically
reviewed; mutations require exact authenticated intent and applicable recovery/review state. Submit commands
may include a bounded
`attachments` array of `{ "path", "mime_type" }` descriptors. Temporarily failed images
can be retried by identity with `attachment_retry` or removed with `attachment_remove`.
Memory and MCP remain disabled unless explicitly configured. Provider connect,
first-token, idle, and overall deadlines are distinct. Trusted local inference uses a
deadline-owned native transport without a hidden HTTP body timeout; during a silent stream,
successful content-free health probes renew the inherited no-byte lease without overriding
explicit operator deadlines. Local no-progress work
parks for operator attention after three equivalent failures while unique progress may continue under
the generous step limit. Contributions and feedback are welcome and voluntary;
they are not additional license conditions.

See the [runtime architecture](docs/architecture/0001-runtime.md),
[recovery architecture](docs/architecture/0003-recovery.md),
[Reliability Engine architecture](docs/architecture/0013-reliability-engine.md),
[generated repository graph](docs/architecture/repository-graph.md),
[attachments, memory, and MCP architecture](docs/architecture/0004-attachments-memory-mcp.md),
[operator-product architecture](docs/architecture/0005-operator-product.md), and
[durable conversation work](docs/architecture/0008-conversation-work.md).
