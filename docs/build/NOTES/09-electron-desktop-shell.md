# NOTES 09 - Electron desktop shell

Doc 09 (1762 lines) is enormous (full parity = checklist §15 rows 1-14). This file
carries the slice map + adaptation deltas. **P12a-v1 is the installable shell** —
the shortest honest path to "run the installer, evaluate the app on Windows" —
remaining P12 slices ride after it.

## A. Slice map

- **P12a (this slice) — installable shell v1, win-x64:**
  1. `packages/electron/` workspace: `main.mjs` (boot per §1.2/1.3 v1 subset),
     `preload.mjs` (minimal §3.4 face), `package.json` (electron + electron-builder
     devDeps; `build` config per §14.1 win/nsis subset).
  2. Server hosting (§2.1): **in-process, never a sidecar** (hard invariant).
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
     `http://127.0.0.1:<port>/` (D-09-1), init-script injection:
     `__NOTNATIVE_ELECTRON__={runtime:'electron',arch,trayEnabled:false}`,
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
  5. On-system loop (the user's ask): package → install (NSIS silent) →
     launch installed exe → verify `/health` + `/` + asset serve from the
     installed root; results recorded in docs/build/EVALUATION.md.

- **P12b (queued):** privileged `notnative-ui://app` protocol (§6.3) +
  geometry persistence (§1.6) + tray (§10.1) + close-to-tray + menus (§10.3) +
  autostart/login-item (§10.6) + deep-link `openchamber://connect` handler
  (§5 — link head stays openchamber:// per the sealed pairing payload) +
  IPC catalog growth (§3.1: file read/write guards §12.2-12.5, notifications
  §10.2) + renderer crash recovery (§12.1) + host chooser/multi-instance
  remote (§2.3/2.8) + updater (§9) + Mini Chat (§4.6) + SSH bridge body
  (desktopSshStore seam is already the UI-side contract, P8-6).

## B. Adaptation deltas (registered)

- **D-09-1** UI load mode v1 = server-served same-origin window URL, NOT the
  privileged custom protocol. Dev-parity consequence: the window behaves like
  the browser build; no `openchamber-ui://`/`notnative-ui://` handler yet.
- **D-09-2** Boot outcome always `{target:'local',status:'ok'}` post-health;
  no remote/env/default-host resolution ladder (§2.3) until multi-host
  management lands. UI has no desktopBoot.ts validation surface yet — it boots
  exactly like web (splash releases on first answered /auth probe).
- **D-09-3** Preload v1 exposes `__NOTNATIVE_DESKTOP_INVOKE__` with an
  allowlist: `desktop_open_external` (http/https only), `desktop_get_boot_info`.
  No MessagePort relay protocol (§3.3), no `window.__OPENCHAMBER_DESKTOP__`
  wholesale mirror.
- **D-09-4** Tray/menus/notifications/deep-links/SSH/updater/Mini Chat/
  window-restore/close-to-tray/keep-awake all deferred to P12b rows above.
  Close = quit (window-all-closed quits the app after server dispose).
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
  The packaged HTTP/UI terminal flow and other platforms remain unverified.
- **D-09-6** Data dir stays the server default `~/.notnative-desktop`
  (NOT userData) so the packaged app and `pnpm start` share state. Electron
  userData holds only shell prefs (port seed) + logs. Delta vs §1.6.
- **D-09-7** LAN bind + password gate wiring (§2.1.2/§2.9 scopes) not wired
  in the shell v1: always loopback. Server-side auth still applies.
- **D-09-8** electron-log dependency deferred; hand-rolled append logger with
  the same intent (file `info`, console off in packaged; server logs bridge
  through console override).
- **D-09-9** `--background` login-item path deferred (no autostart surface yet).
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
  NSIS packaging remains available but secondary.
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
  of booting half-built) and WARNS
  when watched sources are newer than the stored bundle (freshness oracle,
  warning-only). Electron shell: boot failure with a tray swaps the splash
  spinner for a local failure page (data: URL, error text + main.log path +
  quit-and-reinstall guidance; textContent only, no HTML injection);
  trays' stopped state says "Server stopped"; Open App reloads a crashed
  renderer document instead of re-showing it (ensureMainWindow never
  re-invokes boot — a failed boot is terminal for the process, retry is a
  registered residual). electron-package --no-nsis prints an integrity
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

## B2. First-install residuals (P12a audit, 2026-09-22 — registered not fixed)

- node-pty was external AND unshipped in the original v1 installer. The
  current build stages it outside asar next to the server, checks native
  addon loading, and passes a real packaged Electron-run-as-Node PTY spawn.
  The packaged HTTP/UI terminal flow and non-Windows platforms still need
  acceptance coverage.
- Dual-instance sharing of ~/.notnative-desktop (packaged + dev `pnpm start`):
  queue dispatch and settings writes assume one server; occurrence-claim
  machinery exists only for scheduled tasks (lands P9-3). Cross-process
  arbitration is a P13 integration-verify item.
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

- link head `openchamber://connect?v=2&p=` is SEALED by the pairing suites —
  deep-link registration (P12b) registers the `openchamber` scheme VERBATIM.
- UI globals contract: `packages/ui/src/types/globals.d.ts` (NOTNATIVE_*
  family incl. `__NOTNATIVE_ELECTRON__`, `__NOTNATIVE_DESKTOP_BOOT_OUTCOME__`)
  — main.mjs injection must satisfy it, no new globals without a ui type row.
- env family: NOTNATIVE_PORT / NOTNATIVE_HOST / NOTNATIVE_DATA_DIR /
  NOTNATIVE_UI_PASSWORD / NOTNATIVE_RUNTIME + NEW NOTNATIVE_DIST_DIR (§2.1.4
  DIST_DIR analog).
