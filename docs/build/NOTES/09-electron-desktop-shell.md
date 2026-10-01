# NOTES 09 - Electron desktop shell

P12b-51 completes the authenticated server-to-desktop updater path. The
embedded server receives the packaged Electron updater callbacks and exposes
the documented `/api/openchamber/update-check` and
`/api/openchamber/update-install` routes behind the API auth gate. Install
rechecks and downloads the selected package, acknowledges before scheduling
`quitAndInstall`, and reports synchronous or late installer failures through
status polling. Polls during an active operation do not mutate Electron's
shared pending-update state; a reported late failure clears on retry. Standalone
servers retain their safe unavailable/unsupported response. Source and GUI
acceptance remain separate from this route-level verification.

P12b-49 adds `ssh-remote-command.mjs`, a bounded remote shell-script runner
for the managed SSH work. It derives the executable, options, and destination
from the validated catalog command, uses a fixed `sh -s` remote command, and
sends script bytes through stdin with the local shell disabled. Scripts and
captured output are bounded, and each command has a maximum deadline. The
current external-server tunnel path does not use this runner yet.

P12b-46 starts native updater work with `updater-policy.mjs`: production feed
selection defaults to GitHub, a loopback feed is available only to a test
build with runtime opt-in, Windows ARM64 selects its dedicated manifest, and
Linux updates require a writable packaged AppImage and parent directory.
Version ordering is pure and tested. This does not yet configure `autoUpdater`
or expose update check/download/install operations.

P12b-47 configures packaged `electron-updater` and exposes native check,
download, and apply operations only to the trusted local main frame. Download
progress is sent to the taskbar and preload subscribers. The renderer still
needs update controls and state handling; restart grace, rollback after an
asynchronous installer error, and the authenticated server updater adapter are
not implemented yet.

P12b-48 adds the desktop update controls to General settings. The renderer
shows availability, release notes, download progress, retryable errors, and
the install action after download. Download invoke waits up to 30 minutes so
large packages do not outlive the IPC reply window.

P12b-50 completes the native apply boundary: macOS checks `/Applications`,
the main window geometry is persisted, and installation is deferred so the
IPC reply can flush. The invoke remains open for up to 15 seconds, while
preload waits up to 30 seconds. A late installer error still rolls back the
shell's quitting state and reports to live windows; update listeners are
removed on app exit.

P12b-39 adds `ssh-config-reader.mjs` to the explicit Electron package file
allowlist. It expands user SSH config Include globs with bounded asynchronous
enumeration, home-directory containment, cycle/symlink rejection, descriptor
identity validation, and a 1 MiB aggregate read cap. It does not establish an
SSH process or tunnel; catalog entries remain configuration-only.

P12b-40 adds an external-server tunnel manager. Electron starts OpenSSH with
`shell:false`, enforces a loopback-only local forward, and marks a connection
ready only after `/health` identifies `NotNativeDesktop`. Lifecycle IPC is
local-main-frame-only and status events are buffered by preload. Removing an
instance tears down its process; duplicate connects and remove/cancel/reconnect
races have regression coverage. New entries target an existing remote server
on port 57123. P12b-41 allows a ready tunnel to be probed and adopted as the
active runtime. P12b-42 allows explicit selection to open the shared auth gate
when the compatible endpoint requires login; startup still falls back locally.
Managed remote install/start, desktop-specific password login issuance, and
installed GUI acceptance remain outstanding.

P12b-43 adds the Mini Chat window entrypoint: session windows deduplicate by
runtime/session while draft windows remain independent; the renderer receives
bounded non-secret context in its URL and initializes before mount. Creation is
local-main-frame-gated, pinning is window-local and Mini-Chat-only, native
chrome follows the platform policy, and background throttling is disabled.
This slice uses the existing UI entry with a `miniChat=1` query flag rather
than adding a separate HTML entrypoint; the Mini Chat layout mounts only the
chat surface with its own native window controls.

P12b-44 connects the existing `new_mini_chat` customizable shortcut to the
same Mini Chat launch handler used by the main-window toolbar button. The
dispatcher continues to protect AltGr text entry on Windows.

P12b-45 implements `desktop_remote_password_login` for local-main-frame
callers. The renderer sends its runtime key, password, and trust choice; the
main process resolves local or saved direct/SSH destinations from native
state, sends the bounded password login request, and persists the issued token
in the matching local/host slot. The response must confirm authentication,
the host must remain unchanged through the request, and the shared host-catalog
mutation lock must be clear before persistence. If the session response does
not contain a client token, the cookie-backed client-creation fallback uses
the server's `label` field. Relay-only targets and unsaved URLs are rejected.

Doc 09 (1762 lines) is enormous (full parity = checklist §15 rows 1-14). This file
carries the slice map + adaptation deltas. **P12a-v1 is the installable shell** —
the shortest honest path to "run the installer, evaluate the app on Windows" —
remaining P12 slices ride after it.

## A. Slice map

- **P12a (this slice) — installable shell v1, win-x64:**
  1. `packages/electron/` workspace: `main.mjs` (boot per §1.2/1.3 v1 subset),
     `preload.mjs` (minimal §3.4 face), `package.json` (electron + electron-builder
     devDeps; `build` config per §14.1 win/nsis subset).
  2. Server hosting (§2.1): upstream uses **in-process, never a sidecar**.
     NND keeps that as its current Electron fallback, but ADR 0020 and the
     user's NNA-owned add-on direction supersede it for the target deployment:
     an installed NND web service must be independently runnable and then
     supervised by NNA, while Electron becomes an attaching shell.
     `main.mjs` sets NOTNATIVE_* env BEFORE a dynamic ESM import of the server
     bundle, then `startServer()`. The packaged app CANNOT run raw TS (Electron's
     Node lacks type-stripping), so `scripts/electron-build.mjs` bundles
     `packages/web/src/server/index.ts` → `packages/electron/dist-server/server.mjs`
     (esbuild, platform=node, ESM, external: node-pty; also external any
     future native). UI: `vite build` output staged to
     `packages/electron/resources/web-dist`; server serves it via NOTNATIVE_DIST_DIR.
     Server tweaks (additive): `NOTNATIVE_DIST_DIR` env override for DIST_DIR;
     `startServer()` also returns `{ dispose }` (idempotent, same shutdown body;
     signal handlers stay). Port: stored-port → 57123 → ephemeral (§2.1.3
     pre-import selection).
  3. Boot flow v1 subset: app name + AppUserModelId `dev.notnative.desktop`
     (`.dev` unpkgaged), proxy-bypass `<-loopback`, single-instance lock
     (focus existing), chdir homedir, console→`<userData>/logs/main.log`
     (append + 7-day pruning; electron-log dep DEFERRED, delta D-09-8),
     splash data: URL → wait server `/health` → navigate to
     `http://127.0.0.1:<port>/` (D-09-1), preload identity
     `__NOTNATIVE_ELECTRON__={runtime:'electron',arch,trayEnabled:false}`
     (moved from dom-ready injection in P11-4), init-script injection:
     `__NOTNATIVE_SURFACE__='desktop'`, `__NOTNATIVE_PLATFORM__`,
     `__NOTNATIVE_HOME__`, boot outcome `{target:'local',status:'ok'}` (D-09-2),
     `powerMonitor resume → openchamber:system-resume`-equivalent
     `notnative:system-resume` (D-09-11), window options §4.1 v1
     (1280x800, min 800x520, contextIsolation true, nodeIntegration false,
     sandbox false per §1.1), navigation/new-window guards (§4.5: deny
     window.open, http/https via shell.openExternal, keep navigation on the
     local origin), quit-path: `before-quit` → server dispose (§1.7 v1:
     no keep-awake/updater).
  4. Packaging (§14.1 v1): appId `dev.notnative.desktop`, productName
     `NotNativeDesktop`, version via `-c.extraMetadata.version=<nnd VERSION>`;
     win `nsis` oneClick perMachine:false, NO signing (auto-discovery off);
     files: main/preload/dist-server/resources; node_modules asarUnpack NOT
     attempted for node-pty (D-09-5); artifact
     `NotNativeDesktop-Setup-<version>-win-x64.exe`.
  5. On-system loop (the user's ask): package → install through the NNA-aware
     `install.ps1` source installer → launch installed exe → verify `/health`
     + `/` + asset serve from the installed root; results recorded in
     docs/build/EVALUATION.md. The NSIS target is currently disabled pending
     NNA-aware package registration/validation.

- **P12b (in progress):** delivered: tray/close-to-tray/menus, scripted
  source install with NNA package registration, window geometry persistence,
  boot-failure recovery, bounded renderer crash recovery, native zoom lock,
  source/artifact build freshness, Windows/macOS launch-at-login (§10.6), and
  the renderer-to-native notification path with dedupe, hidden-window gating,
  retained native references, click-to-session routing, and settings-gated
  completion/error/question/subtask event production (§10.2), the privileged
  `notnative-ui://app` protocol (§6.3), and guarded Markdown save/file read
  IPC (§3.1, §12.2-12.3). The custom-origin sender gate compares exact scheme
  and host because Node reports custom-scheme origins as opaque; credentials
  embedded in URLs are rejected. Validated local open/reveal IPC and the
  shared-UI local-origin wrappers (§12.5, §13.2), plus atomic Markdown save
  with bounded Windows rename retries (§12.4), and validated saved-host
  catalog storage and local client-token/install-id IPC (§2.8/§3.1) are also
  delivered. Install ids are persisted UUIDs, generated once and repaired if
  malformed; token reads stay local-origin-only. Strict `openchamber://session`
  and `openchamber://focus` links now enter through startup argv, second-instance
  argv, or macOS `open-url`; session actions queue across UI startup and reload.
  The bounded v2 `openchamber://connect` payload parser is in place, including
  expiry, direct URL, relay key, and candidate-order validation. Pairing import
  now requires native consent, probes bounded direct candidates, rejects HTTP
  redirects, redeems once, and stores the client token in the validated host
  catalog while holding the shared catalog mutation lock. Before redemption,
  pairing verifies the relay-advertised server id against the direct endpoint's
  health response. Bounded `openchamber://host/<id>` links switch only to an
  existing saved host through the same identity/API/auth probe and catalog lock;
  they queue across startup/reload and report failure through a native warning.
  Renderer-side relay pairing redemption now opens a grant-scoped throwaway
  E2EE tunnel, sends the deduplicated pairing request, bounds and validates the
  response, and always closes the tunnel. Relay-only deep-link pairing now
  obtains native consent, redeems through the trusted local renderer, and saves
  the token and grant-free public relay descriptor while holding the catalog
  lock. A bounded one-shot main/renderer bridge carries redemption requests to
  the trusted local renderer and accepts only a token/label result.
  The bounded Electron host probe now implements the identity-first,
  compatibility/auth checks and unreachable-only retry policy required by §2.6.
  The server exposes the unauthenticated `/api/version` compatibility contract;
  a pure boot-target policy now resolves env/default targets, validates probe
  outcomes, and falls back locally on invalid overrides or probe failure. Main
  boot consumes the policy and initializes the renderer with the selected API
  runtime through local-main-frame IPC.
  The Remote Instances settings page now selects saved direct and relay-only
  hosts. Relay selection performs identity, compatibility, and authentication
  checks over E2EE, then adopts the probe tunnel. Startup holds the main runtime
  on local until the renderer restores a saved relay default; a bounded retry
  tolerates an in-flight pairing catalog lock, and main verifies the descriptor
  and credentials did not change after probing. Standalone servers admit the
  exact packaged UI origin for CORS. Saved-host `openchamber://host/<id>` links
  use the validated direct switch path. The core calling-window controls from
  §3.1 now target the invoking BrowserWindow and require its trusted local main
  frame. The direct host probe IPC accepts a saved host id and sources
  credentials exclusively from that sanitized catalog record. Mixed
  direct/relay pairing links now
  disclose every approved recipient before network access, probe direct
  candidates first, and fall back to their supplied relay only when no direct
  health/identity check passes. Relay pairing retains the catalog lock and
  grant-free persistence rules. The SSH instance catalog foundation now parses
  shell-free SSH commands, sanitizes persisted entries, and reconciles SSH ids
  with saved-host defaults atomically. It deliberately blocks `-F`, `-I`,
  `ProxyCommand`, `LocalCommand`, `RemoteCommand`, `KnownHostsCommand`, and provider-loading
  options; arbitrary SSH config files and executable providers are not accepted
  by this contract. Local-main-frame IPC now also exposes the UI store's config,
  upsert, create-from-command, and remove operations over that persistence
  contract. Mutations fail closed if persisted SSH rows are corrupt so an edit
  cannot silently erase recoverable entries. SSH placeholders are explicitly
  marked and excluded from direct host probing/switching until SSH transport
  exists; the marker still protects startup if the instance catalog is corrupt.
  The Remote Instances page now edits SSH commands and imports direct `Host`
  aliases from the local SSH config through a bounded main-frame-only read;
  the external SSH connect/disconnect tunnel and status production now work.
  Remaining implementation acceptance: installed GUI walkthrough and NSIS
  install/upgrade validation. Managed SSH remote-host acceptance and cross-
  process arbitration remain separately tracked in NOTES/20 and section B2.

- **D-09-45** SSH definitions are parsed as argv without invoking a shell.
  Executable config/provider hooks, remote-command options, and config-file flags are rejected, secrets
  are persisted only under explicit settings-storage consent, and forwarding
  hosts are normalized before specification construction. Catalog updates
  reconcile saved-host ids and defaults in one atomic preferences write.

- **D-09-44** `desktop_host_probe` is exposed only to the trusted local main
  frame and accepts a saved host id rather than a renderer-selected URL. Main
  resolves the direct endpoint, bearer token, request headers, and expected
  server id from the sanitized host catalog before invoking the bounded probe;
  relay-only records cannot enter this direct probe path.
- **D-09-42** The Electron entry point imports `ipcMain` before constructing
  the invoke face. Source syntax and unit tests do not evaluate the Electron
  entry module, so a native launch check is retained: startup must reach the
  embedded server health gate and navigate the main window. On this host the
  process passed that gate, but the computer-use bridge exposed no app window
  for visual acceptance.

## B. Adaptation deltas (registered)

- **D-09-1** The packaged UI is served through the privileged
  `notnative-ui://app` protocol (§6.3); development continues to use the
  server-served loopback URL for dev parity.
- **D-09-2** Electron starts its local server and UI, then selects the API
  runtime from an explicit `OPENCHAMBER_SERVER_URL`, the saved default host, or
  local fallback. Remote selection requires the version/auth probe; failed
  probes fall back locally with a bounded boot outcome.
- **D-09-3** Preload exposes `__NOTNATIVE_DESKTOP_INVOKE__`; the main-process
  allowlist includes `desktop_open_external` (http/https only),
  `desktop_get_boot_info`, `desktop_host_switch`, browser-control register/unregister/claim/result,
  relay dev-tunnel open/close/close-all, and the tray boot-health retry.
  Browser-control, host switching, and retry require the trusted main frame; the remaining
  local commands use the local sender gate. No MessagePort relay protocol
  (§3.3), no `window.__OPENCHAMBER_DESKTOP__` wholesale mirror.
- **D-09-4** Tray, menu, close-to-tray, window geometry, boot-health retry,
  renderer recovery, native zoom lock, Windows/macOS launch-at-login, and the
  renderer-to-native notification path are implemented. Main-frame-only IPC
  delivers notifications with dedupe, hidden-window gating, retained native
  references, and click-to-session routing; notification clicks are buffered
  across document/React startup. Completion, error, question, and subtask events
  honor notification settings; settle alerts exclude child sessions and the
  focused session. The desktop main frame can request permission. File reads
  are bounded to real files under the home or temp roots, reject common
  credential locations, and stream at most 50 MiB. Markdown save uses the
  native picker and writes UTF-8. Deep links, SSH, updater, Mini Chat,
  keep-awake, relay-aware routing, and host deep links remain deferred to P12b rows above.
- **D-09-25** Local open/reveal commands require the desktop main frame at the
  exact loopback or packaged UI origin. Paths must exist and be readable;
  directories also require traversal access, and special files are rejected.
  Reveal opens a directory or selects a file; Electron error strings are
  returned as failures. App-specific open is macOS-only and uses an argument
  vector; Windows/Linux return the documented unsupported error.
- **D-09-26** Markdown saves write a unique same-directory temporary file,
  then atomically rename it into place. Windows retries only `EPERM`, `EACCES`,
  and `EBUSY` with the §12.4 bounded backoff; all other platforms and errors
  get one attempt. Failed saves remove the temporary file and preserve an
  existing target.
- **D-09-27** Saved host records are schema-sanitized and capped at 100 entries
  before atomic persistence in shell preferences. Direct URLs reject
  credentials and fragments; auth/cookie headers and relay private key fields
  are dropped; P-256 relay public keys are imported during validation so
  malformed points fail at save time. Host get/set IPC is limited to the
  desktop main frame on the loopback server or packaged UI origin. The catalog
  is used by boot routing and Remote Instances settings.
- **D-09-28** The Electron shell accepts only bounded `openchamber://focus` and
  `openchamber://session/<id>` actions. Startup and second-instance argv are
  parsed on Windows/Linux; macOS `open-url` is handled directly. Session links
  are buffered across splash/startup and renderer reloads, then delivered via
  the existing preload event face. Pairing (`connect`) links now pass through
  native consent and bounded direct or relay redemption. Direct host selection
  is available in Remote Instances settings and saved-host deep links; relay host
  selection is available in Remote Instances settings. Unknown link actions
  are ignored.
- **D-09-29** The deep-link parser recognizes v2 pairing payloads only after
  strict base64url/UTF-8/JSON bounds, expiry checks, and all-candidate shape
  validation. Direct candidates must be credential-free HTTP(S); relay keys
  must import as P-256 public keys. Candidates are sorted by finite priority.
  Consent-gated import tries those candidates in priority order, checks bounded
  `/health` responses, forbids redirects, and redeems the one-time secret only
  at the first healthy candidate. Expired-during-probe links are stopped before
  redemption. The client token is stored in the saved-host catalog under a
  shared mutation lock; the Remote Instances page can probe and switch to a
  saved direct or relay-only host live. Mixed direct/relay fallback remains
  pending.
- **D-09-30** The desktop pairing importer requires native user consent before
  network access, redacts candidate query values in the dialog, and discloses
  every possible secret recipient. Health and redemption responses are bounded;
  redirects are rejected to keep the secret on the approved origin. Redemption
  is serialized and shares a lock with host-catalog IPC through persistence,
  preventing concurrent UI updates from exceeding the catalog cap.
- **D-09-31** Electron's host probe is implemented as an isolated, testable
  preflight. When an expected server id is available, it checks `/health`
  without credentials before bearer-bearing requests. `/api/version` must
  advertise `api.runtime-url.v1`, and `/auth/session` must succeed. Fetch and
  bounded response reads share a deadline; only unreachable probes receive one
  longer retry. The API compatibility surface and boot routing consume it.
- **D-09-32** The server's public `/api/version` route returns product version,
  runtime, process start time, optional `serverId`, and the conservative
  `{ apiVersion: 1, minClientApiVersion: 1, capabilities: ['api.runtime-url.v1'] }`
  contract. It is registered before global `/api/*` auth so clients can
  classify a host before sending credentials.
- **D-09-33** A pure desktop boot-target resolver implements environment-target
  precedence, saved-default lookup, remote compatibility outcomes, and local
  fallback. Invalid explicit environment URLs cannot silently select a saved
  remote, and thrown probes cannot prevent local boot. Electron's main process
  uses this policy to configure renderer API clients while the shell UI remains
  local.
- **D-09-34** Boot runtime configuration is available only to the desktop local
  main frame through `desktop_boot_config_get`. The config contains the selected
  API base, client token, safe request headers, runtime key, local origin, and
  bounded boot outcome. Pairing with a relay identity requires an exact
  `/health` server-id match before sending the one-time secret to a direct URL.
- **D-09-35** Remote Instances settings reads the host catalog and active
  runtime over local-main-frame-only IPC. Direct switching persists the chosen
  default, takes the shared host-catalog lock, runs identity/API/auth preflight,
  and returns the selected runtime to the renderer. Relay-only switching probes
  identity/API/auth over E2EE, verifies the catalog record still matches the
  probed credentials under the same lock, and adopts that open tunnel. Failed
  probes keep local runtime active while preserving the selected default for a
  later retry.
- **D-09-36** The API server admits the exact stable `notnative-ui://app`
  packaged renderer origin for credentialed CORS and browser writes even when
  `NOTNATIVE_DESKTOP_UI_ORIGIN` is unset. A configured exact origin remains
  additionally supported; suffix/lookalike origins receive no CORS trust.
- **D-09-37** `openchamber://host/<id>` accepts a single bounded saved-host id.
  The shell queues it across startup and renderer loading, serializes multiple
  host-link requests, and uses the existing catalog lock and direct-host probe. A
  successful switch reloads the local shell so the per-document runtime config
  is refreshed; missing hosts and switch conflicts show a native warning.
- **D-09-39** The relay pairing bridge caps concurrent requests, assigns
  collision-checked one-shot request ids, expires unanswered work, and settles
  requests when the renderer is destroyed. Its accepted result shape excludes
  the relay grant and pairing secret. Main/preload/UI wiring is complete.
- **D-09-38** Renderer-side relay pairing redemption uses the link's optional
  one-time grant only for the throwaway E2EE connection, applies a 15-second
  request deadline and 64 KiB response bound, validates the returned client
  token, and closes the tunnel in `finally`. Grant-free catalog and runtime
  integration are recorded in D-09-40.
- **D-09-41** Mixed pairing links disclose direct and encrypted relay
  destinations in one native consent prompt. Direct candidates are probed in
  priority order; only when none pass health and expected-identity checks does
  redemption fall back through the relay bridge. The existing catalog lock,
  capacity checks, and grant-free relay persistence remain in force. At catalog
  capacity, duplicate detection also matches an already-saved relay server id.
- **D-09-40** Saved relay-only defaults keep Electron's injected boot runtime on
  the local server with a `relay-pending` outcome. The trusted renderer probes
  the stored descriptor over E2EE, then asks main to confirm the same relay key,
  token, and request headers under the catalog lock before adopting the tunnel
  and switching. Startup retries a busy catalog lock with capped backoff. Main
  keeps renderer-reload injection local so a reload rebuilds the ephemeral
  tunnel instead of addressing the virtual `tunnel.invalid` origin directly.
- **D-09-5** node-pty stays EXTERNAL in the server bundle. The packaging
  pipeline now stages its runtime JS, license, and platform native binaries
  beside `dist-server/server.mjs` under `dist-server/node_modules/node-pty`.
  NSIS lists this native package as a separate explicit extra resource;
  electron-builder's generic `dist-server` copy skips nested `node_modules`.
  It verifies package resolution and Windows native-addon loading in both
  Node and Electron-run-as-Node before building either shell artifact. The
  historical v1 installer omitted this dependency, so terminal creation
  failed with a module-load error. The unpacked Windows x64 artifact now
  passes a real PTY command spawn/output/exit smoke in Electron-run-as-Node.
  The packaged server's HTTP create plus WebSocket snapshot/output/exit path
  also passes a real Windows x64 Electron-run-as-Node probe. GUI rendering,
  actual NSIS installation, and other platforms remain unverified.
- **D-09-6** Data dir stays the server default `~/.notnative-desktop`
  (NOT userData) so the packaged app and `pnpm start` share state. Electron
  userData holds only shell prefs (port seed) + logs. Delta vs §1.6.
- **D-09-7** LAN bind + password gate wiring (§2.1.2/§2.9 scopes) not wired
  in the shell v1: always loopback. Server-side auth still applies.
- **D-09-8** electron-log dependency deferred; hand-rolled append logger with
  the same intent (file `info`, console off in packaged; server logs bridge
  through console override).
- **D-09-9** Login at startup is exposed on Windows and macOS from General
  settings through main-frame-gated IPC and Electron's login-item API. Windows
  starts the source-install script with `--hidden`; if tray creation fails, the
  window is shown so a background launch cannot strand the user. Linux remains
  unsupported.
- **D-09-10** Security: preload requires sandbox:false (matches doc), so the
  preload process is privileged — mitigated by the invoke allowlist + sender
  framing check (§11.1 v1). webSecurity stays default-on; the window only ever
  loads the local origin or http(s) via explicit openExternal hand-off.
- **D-09-11** system-resume event name is the sealed `notnative:*` brand
  (doc text shows the reference brand; our control vocabulary is ours).
- **D-09-12** version pairing: electron-builder gets the product version via
  extraMetadata override at package time; packages/electron/package.json keeps
  0.0.1 like ui/web (outside the pairing gate). The SERVER version surface now
  agrees: main sets NOTNATIVE_APP_VERSION=productVersion() before the bundle
  import and ENV.version reads it (packaged → app.getVersion(); unpackaged
  script install → the ROOT package.json version, falling back to
  app.getVersion() only when that manifest is missing - the old direct
  app.getVersion() surface leaked the electron BINARY version, probed live as
  /health 44.4.3). Verified live: packaged install /health = 20260921.0.3;
  script install /health = 20260921.0.6 (source runs keep the 0.0.1
  placeholder). The boot log line still prints app.getVersion() (the binary
  identity); /health carries the product identity.
- **D-09-13** ESM bundle interop: the esbuild server bundle ships a
  createRequire banner (`const require = createRequire(import.meta.url)`) —
  CJS deps (ws) require() Node builtins and die at import without it.
  electron-package.mjs audits the banner marker into every build.
- **D-09-14** runtime JSON siblings: esbuild copies no data files, so
  settings-registry.json (read relative to import.meta.url by settings-gate)
  is staged into dist-server/ by the pipeline (SIBLING_DATA list; a missing
  entry fails packaging, not the desktop at boot).
- **D-09-15** dist-server ships OUTSIDE app.asar (extraResources) and
  resolveServerBundle prefers that loose copy — ESM import() of asar-internal
  files is loader-version-dependent; the loose file is deterministic. (Found
  the hard way: first packaged boot died on selfDir() resolving to
  `app.asar\main.mjs\dist-server\` — main.mjs selfDir is now dirname-based.)
- **D-09-16** tray (reference launcher pattern, modeled on the row-bot
  launcher): Electron Tray owns status feedback (starting → running/stopped,
  tooltip + regenerated menu), menu is exactly [Open <App> (default,
  restore-or-create window) | Open Web UI in Browser (default browser,
  enabled only when running) | — status line — | Quit]; window close HIDES
  while a tray is active (service outlives the window); Quit does
  dispose → app.quit → 8 s hard watchdog (dispose is disposed-guarded
  server-side, so the before-quit double-call is a no-op); boot failure with
  a tray stays alive in the stopped state (no tray → legacy exit 1). Icons
  are generated dependency-free PNGs (scripts/electron-tray-icon.mjs,
  running=teal ring; starting shares the gray stopped PNG); tray misses
  degrade to window-only mode. Status-line honesty: 'stopped' renders
  "Server stopped", never the stale
  "Server starting…" (P12b-1 audit). ipc invocation face extracted to
  ipc-face.mjs (file-cap hygiene; behavior byte-identical, verified against
  866926b^ main.mjs).
- **D-09-17** scripted source install: repo-root install.ps1 (row-bot
  action-pattern parity) copies the source into
  `%LOCALAPPDATA%\NotNativeDesktop`, pnpm-installs there, repairs the
  electron postinstall, builds shell artifacts (`electron-package.mjs
  --no-nsis`), stamps `packages/electron/install-mode.txt` (`script`), and
  creates Desktop + Start Menu shortcuts targeting electron.exe + main.mjs.
  The marker gives the SCRIPTED install product identity (userData
  `%APPDATA%\NotNativeDesktop`, AppUserModelId without `.dev`) while a repo
  checkout keeps the `… Dev` split — the two can co-exist on one machine.
  NSIS packaging is currently disabled until the installer can perform
  NNA-aware package registration/validation; `install.ps1` is the supported
  install path.
- **D-09-18** P12b-1 adversarial-audit fixes (tray + scripted install).
  Windows install.ps1: install REFUSES while the install-tree electron.exe
  is running (Get-Process path match; robocopy now also captures its stdout
  to robocopy-out.log, and its own diagnostics — which go to stdout — are
  shown tail-first on a failure instead of being sunk by 1>$null);
  -Uninstall refuses the tree drop with tray-quit guidance (exit 2;
  shortcuts still removed) and -PurgeData degrades gracefully (per-dir
  SilentlyContinue + "partially erased" honesty; locked files stay behind).
  Upgrade semantics are documented behavior: merge-only copy (robocopy /E,
  never /MIR — /MIR would hard-delete arbitrary files in a user-supplied
  -InstallDir); upstream-deleted files linger until a full reinstall; every
  runtime artifact is regenerated wholesale by --no-nsis so lingering orphans
  are inert. -SkipBuild requires bundle + settings-registry.json + both tray
  PNGs and the staged node-pty runtime (a torn prior build rebuilds instead
  of booting half-built). The build writes a content stamp over build inputs
  and produced artifacts; -SkipBuild reuses only an exact version/source/
  artifact match and rebuilds when the stamp is missing, stale, or mismatched.
  Electron shell: boot failure with a tray swaps the splash
  spinner for a local failure page (data: URL, error text + main.log path +
  tray-quit/log guidance; textContent only, no HTML injection). If a server
  handle exists, the page also offers a bounded health-check retry; failures
  before a handle exists require quitting and restarting the app;
  trays' stopped state says "Server stopped"; recoverable renderer crashes
  auto-reload at most three times in a rolling 60-second window, while clean
  exits and other reasons only log. Open App remains the manual reload escape
  after the recovery budget is exhausted. A boot failure with an existing
  server handle offers a bounded health-check retry from the failure card;
  startup failures before a handle exists still require restarting the app.
  The retry never starts a second server or changes the import-time port.
  electron-package --no-nsis prints an integrity
  oracle (sha256: server bundle, settings-registry.json, both tray PNGs +
  a sorted-rel-path recursive digest of packages/web/dist) and SKIPS
  resources/web-dist staging (consumed only by electron-builder; the
  artifacts-only install serves packages/web/dist directly — the staged copy
  was dead weight and is not even migrated by robocopy's /XD resources).
  install.sh parity (STATIC ONLY — written and reviewed without a bash host,
  still not executed): bash-only guard as first statement; data-erasure is
  now opt-in via --purge-data (--keep-data accepted as no-op) matching
  install.ps1; purge also erases electron userData dirs; install dir with
  whitespace is refused (desktop-entry Exec/Icon cannot quote it); macOS
  electron binary path (dist/Electron.app/Contents/MacOS/Electron) replaces
  the always-false dist/electron check; desktop entry Exec args are quoted
  and Icon points at the generated tray PNG (an ELF binary never renders as
  a freedesktop Icon). Honest deployment note: these fixes live in the REPO;
  the running script-installed instance keeps the pre-fix code until the
  next scripted install run (install dir was NOT patched in the audit).

- **D-09-19** Main-window geometry is now persisted alongside the stored
  loopback port in `nnd-shell-prefs.json`. Move/resize/mode changes debounce
  for 300 ms; close-to-tray and quit persist immediately. Restore uses the
  normal (unmaximized) bounds, chooses the overlapping display or primary
  work area if that display disappeared, clamps position and size, then
  restores maximized/fullscreen mode (fullscreen takes precedence if both
  flags are present). The prefs writer uses a same-directory temporary file
  and replace, so an interrupted write leaves the prior port and geometry
  intact. Malformed settings fall back to the 1280×800 first-run window. This
  is shell-local state, not NNA session state. The 20260925.0.44 unsigned NSIS
  build passed; its app.asar contains the new state modules plus tray and IPC
  modules, and packaged terminal spawn and HTTP/WebSocket smokes passed.
  Actual installed-GUI geometry behavior still needs a visible shell probe.

- **D-09-20** P12b resilience and freshness: the tray failure card rechecks
  health only when the failed boot left a server handle; retry IPC is main-frame
  gated and never starts a second server. Recoverable renderer exits reload at
  most three times per rolling minute, and Chromium page zoom is pinned to
  100%. `electron-package --no-nsis` writes a source/artifact content stamp;
  `install.ps1 -SkipBuild` rebuilds unless version, build inputs, and all
  required outputs match it. The artifact digest includes Vite's generated
  JS/CSS assets and the staged native runtime. Auditors fixed the retry-card
  replacement race, the pre-application wheel-zoom race, and omissions in the
  initial artifact hash.

- **D-09-21** Launch-at-login accepts only a boolean through the trusted main
  frame. Startup launches hide behind the tray when available; a missing tray
  falls back to a visible main window. The General settings control reports OS
  support and operation failures rather than optimistically changing its state.

- **D-09-22** The default Electron session allows only `notifications` requests
  from the main BrowserWindow's main frame at the exact loopback app origin.
  Its permission-check handler applies the same window, frame, and origin gates;
  the isolated preview session continues to deny every permission.

- **D-09-23** Packaged UI assets load from the privileged `notnative-ui://app`
  origin, while API, SSE, and WebSocket traffic stays on the per-instance
  loopback server. The protocol handler confines reads to the packaged web
  root, serves extensionless routes through the SPA entry, rejects missing
  assets and noncanonical authorities, and preserves asset MIME/cache headers.
  The trusted renderer origin has an exact-origin CORS and browser-write
  exception; only its UI session cookie is rewritten to `SameSite=None; Secure`
  because Chromium otherwise omits `SameSite=Strict` cookies on the cross-site
  loopback request. Other cookies and origins retain their policy. The server
  admits the exact stable `notnative-ui://app` origin for CORS and browser writes
  so standalone remotes can serve the packaged renderer without per-server CORS
  setup; lookalike origins remain denied. Relative UI API requests and terminal
  sockets now use the configured runtime base. A bundled Electron probe
  confirmed that only the `None; Secure` cookie crosses to loopback.
  `LOAD_SERVER_UI=1` retains the loopback development mode.

## B2. First-install residuals (P12a audit, 2026-09-22 — registered not fixed)

- node-pty was external AND unshipped in the original v1 installer. The
  current build stages it outside asar next to the server, checks native
  addon loading, and passes a real packaged Electron-run-as-Node PTY spawn.
  The packaged HTTP/WebSocket terminal flow passes under Electron-run-as-Node;
  GUI rendering, actual NSIS installation, and non-Windows platforms still
  need acceptance coverage.
- Dual-instance sharing of ~/.notnative-desktop (packaged + dev `pnpm start`):
  settings mutations use a shared config lock and lazy seeding publishes with
  atomic no-replace semantics (P13). Queue dispatch arbitration remains open;
  occurrence-claim machinery exists only for scheduled tasks (P9-3).
- Port handoff race: selectPort test-binds then closes before the server
  binds — a second process can win the gap (~ms). Failure mode is a clean
  boot abort with main.log evidence, not a wrong-port bind.
- IPC allowlist accepts any `data:text/html` frame forever (own splash
  allowance): reachable only from same-origin hosted content; blast radius is
  openExternal(http/https) + boot info (port/version). v1-acceptable under
  the D-09-3 allowlist design.
- Install dir is `%LOCALAPPDATA%\Programs\@notnativeelectron` (package name,
  matching the reference app's convention) while productName/exe/userData say
  NotNativeDesktop; uninstall leaves logs+prefs (standard Electron posture).

## C. Facts pinned by probe (doc-09 rows we must honor byte-exact)

- **D-09-24** Settings PATCH handlers serialize read/modify/write across server
  processes with the shared preferences config lock. Lazy seed creation uses
  atomic no-replace publication, so a concurrent first write cannot be
  clobbered by a delayed GET. Queue delivery still needs cross-process claims.

- link head `openchamber://connect?v=2&p=` is SEALED by the pairing suites —
  deep-link registration (P12b) registers the `openchamber` scheme VERBATIM.
- UI globals contract: `packages/ui/src/types/globals.d.ts` (NOTNATIVE_*
  family incl. `__NOTNATIVE_ELECTRON__`, `__NOTNATIVE_DESKTOP_BOOT_OUTCOME__`)
  — main.mjs injection must satisfy it, no new globals without a ui type row.
- env family: NOTNATIVE_PORT / NOTNATIVE_HOST / NOTNATIVE_DATA_DIR /
  NOTNATIVE_UI_PASSWORD / NOTNATIVE_RUNTIME + NEW NOTNATIVE_DIST_DIR (§2.1.4
  DIST_DIR analog).
