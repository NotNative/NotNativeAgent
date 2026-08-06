# Per-user installation

NotNativeAgent uses the release identifier recorded in `VERSION` and is a dependency-free
JavaScript application requiring Node.js 24
or newer. The application and fallback Node runtime install per-user without
administrator or root access. Linux may request `sudo` only when system download/archive
utilities are missing. Install from the root of an extracted, trusted release after
verifying its `RELEASE_MANIFEST.sha256`.

Both installers present the same concise stage-oriented progress: runtime readiness,
application payload, protected user data, launchers, optional WebSearch, and an installed-CLI
verification. Successful checks use `[OK]`; intentionally retained or skipped work uses
`[--]`. Color is used only on an interactive terminal and is automatically disabled for
redirected output or when `NO_COLOR` is set. The progress display adds no artificial delay.

## Optional WebSearch setup

Both installers preserve and detect `$NNA_HOME/config/web-search.json`. When it is
already enabled, WebSearch setup is skipped without probing or replacing the saved
endpoint. Interactive installs offer either an existing SearXNG URL or a local
Docker deployment.

Windows automation can use `-WebSearchEndpoint URL`, `-DeployLocalSearch`, or
`-SkipWebSearchSetup`. Linux and macOS equivalents are `--websearch-endpoint URL`,
`--deploy-local-search`, and `--skip-websearch-setup`.

## Optional Telegram gateway setup

Interactive installs can configure a Telegram BotFather token and authorize one numeric
Telegram user ID. The token prompt is hidden, the resulting local configuration inherits
the protected `$NNA_HOME` permissions, and the bot is validated before the gateway is
enabled. An existing configured gateway is preserved on later idempotent installs.

Windows automation can use `-TelegramBotToken TOKEN -TelegramUserId ID` or
`-SkipGatewaySetup`. Linux and macOS equivalents are `--telegram-token TOKEN
--telegram-user-id ID` and `--skip-gateway-setup`. Supplying secrets on a command line can
expose them to process inspection; interactive entry or the gateway's environment-variable
token reference is preferred. Windows installs register a hidden per-user startup entry.
Linux uses a user systemd service when available and otherwise starts the bounded detached
runtime. See [TELEGRAM_GATEWAY.md](TELEGRAM_GATEWAY.md) for ongoing management.
During a Windows install, NNA also checks for the historical elevated
`\NotNativeAgentGateway` scheduled task. It removes the task only when its sole action is
the known legacy `wscript.exe "%USERPROFILE%\.nna\gateway.vbs"` launcher. Windows may show
a UAC prompt for that cleanup; a same-named task with any other action is preserved.
The uninstallers stop the gateway and remove the NNA-owned login-startup entry before
removing application files; gateway configuration remains with retained user data.

## Dependency handling

Both installers validate the executable and major version of an existing `node` command.
When Node.js 24 or newer is unavailable, they download the latest official Node.js 24 LTS
prebuilt archive from `nodejs.org`, match it against the release's `SHASUMS256.txt`, and
install it inside the per-user NotNativeAgent application directory. The generated
launcher is bound to the validated executable; it does not silently switch runtimes later.

The installers also detect the optional `rg` executable. When it is absent during an
interactive install, they explain that native search remains functional and offer to install
ripgrep with an available system package manager (`winget`, Chocolatey, or Scoop on Windows;
Homebrew, `apt`, `dnf`, `yum`, or `zypper` on Unix-like systems). Existing installations are
left alone and non-interactive installs never acquire it implicitly. Use
`-SkipRipgrepSetup` on Windows or `--skip-ripgrep-setup` on Linux/macOS to suppress the offer.
NNA validates discovery after installation and always retains its bounded JavaScript search
fallback.

Linux additionally validates `curl`, `tar`, `xz`, and `sha256sum` before downloading a
runtime. If one is missing, the installer uses `apt-get`, `dnf`, `yum`, or `zypper` and
requests `sudo` only for those system utility packages. It fails with explicit guidance
when neither the tools nor a supported package manager are available. Set
`NNA_SKIP_DEPENDENCY_INSTALL=1` on Linux or pass `-SkipDependencyInstall` on Windows to
require a preinstalled compatible Node instead. `NNA_FORCE_BUNDLED_NODE=1` and
`-ForceBundledNode` are conformance and managed-deployment controls.

macOS validates its built-in `curl`, `tar`, and `shasum` commands, downloads the official
`darwin` archive for the current Intel or Apple Silicon architecture, and verifies it
with SHA-256 before extraction. Missing platform utilities cause a clear failure; the
installer does not install Homebrew or mutate system package state.

## Windows

Run PowerShell from the release root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

The installer replaces the application payload at
`%LOCALAPPDATA%\NotNativeAgent\installed`, creates `nna.ps1` and `nna.cmd` launchers under
`%LOCALAPPDATA%\NotNativeAgent\bin`, and adds that bin directory to the current user's
PATH. It creates `%USERPROFILE%\.nna` with `sessions`, `reviewer-ledger`, `config`, and
`logs` subdirectories. Open a new terminal after installation.
PowerShell resolves `nna` to the `.ps1` launcher before the compatibility `.cmd` launcher,
so NNA can consume its guarded control keys and return directly without the Windows
`Terminate batch job` prompt. Command Prompt continues to use `nna.cmd`.

No machine-wide files, services, scheduled tasks, or administrator settings are
created. Managed installations can supply `-InstallRoot`, `-DataRoot`, and
`-SkipPathUpdate`. Installing Node itself remains per-user and does not invoke MSI or
Windows package management.

The simplest uninstall entry point is:

```powershell
nna uninstall
```

It opens the installed PowerShell uninstaller in a separate window so the bundled runtime
can exit before its own files are removed. An interactive uninstall asks whether to
permanently delete the marked `.nna` directory. Use `nna uninstall --delete-user-data` for
an unattended full removal or `nna uninstall --keep-user-data` to preserve sessions and
configuration without prompting. The underlying script remains available at
`%LOCALAPPDATA%\NotNativeAgent\uninstall.ps1` for recovery and managed automation. The
uninstaller validates both markers before removing anything when full deletion is requested.

## Linux and macOS

Run from the extracted release root:

```sh
sh ./install.sh
```

The application payload is replaced at
`${XDG_DATA_HOME:-$HOME/.local/share}/not-native-agent/installed` on Linux or
`$HOME/Library/Application Support/NotNativeAgent/installed` on macOS. The launcher is
created at `$HOME/.local/bin/nna`, and durable data is initialized under `$HOME/.nna`.
If `$HOME/.local/bin` is not already on PATH, the installer prints the required action
without modifying shell startup files.

The simplest uninstall entry point is:

```sh
nna uninstall
```

Interactive uninstall asks whether to delete `$HOME/.nna`. Pass `--delete-user-data` for
an unattended full removal or `--keep-user-data` to preserve data without prompting. The
underlying script is installed at
`${XDG_DATA_HOME:-$HOME/.local/share}/not-native-agent/uninstall.sh` on Linux and
`$HOME/Library/Application Support/NotNativeAgent/uninstall.sh` on macOS. Custom automation
may use `--source`, `--install-root`, and `--data-root` on install.

## Runtime paths

All installed surfaces use the same durable data root regardless of the current working
directory. `NNA_HOME` may override it, but it must be an absolute path. The Windows
launcher sets this variable when a custom data root was selected. Manifest
`workspace_root` remains separate: it controls the tool sandbox, not application state.

Installers apply restrictive per-user data permissions idempotently. Linux and macOS use
`0700` directories and `0600` marker/config files. Windows removes inherited access from
the NNA data root and grants recursive full control only to the installing user and the
SYSTEM principal. `/health` reports the runtime permission posture; Windows ACL
verification remains part of the native release audit.

Validate an installation with:

```sh
nna --version
nna --help
```

Then launch the product with `nna`. The first invocation creates
`$HOME/.nna/config/manifest.json` after checking explicit `NNA_PROVIDER_ENDPOINT` and
`NNA_MODEL` values, probing common loopback OpenAI-compatible endpoints, or collecting the
endpoint and model interactively. Later invocations load that manifest and open the TUI
without requiring arguments.

Native Windows, Linux, and macOS install/launch/uninstall checks remain part of the Node
test suite and can be run locally or by a maintainer's chosen CI system.

## Operator responsibility

Installing NNA does not transfer responsibility for the authority you configure or for
actions performed by the models, tools, credentials, MCP servers, hooks, and unattended
workflows you enable. NNA's deterministic policy, reviewer, permission, and audit controls
reduce risk; they are not guarantees. A reviewer approval is not proof that an operation
is harmless. The Apache License 2.0 warranty disclaimer and limitation of liability apply
to the installed software; see the top-level `LICENSE` file.

## Reinstallation and upgrades

Every installation stages a complete application payload and then overwrites only the
`installed` directory. Files left by an older application release cannot survive there.
Sibling directories—including `runtime` and `transitory`—and the separate `.nna` data
root are spared. Sessions, reviewer ledgers, logs, configuration, and user-created
runtime/transitory data therefore survive reinstall and upgrade. A compatible previously
downloaded Node runtime is reused when no suitable system Node is present.
# Installation
