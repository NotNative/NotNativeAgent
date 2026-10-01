# Progress Log

Goal: full cleanroom build of NotNativeDesktop per docs/planning (see `PLAN.md`).

## 2026-09-30 · P12 web splash uses the stored locale

A small ordered bootstrap module reads the stored locale and updates the splash
copy and document language before the main app module runs. All locale catalogs
now translate the loading line, and runtime language changes keep `<html lang>`
in sync for assistive technology and spellcheck. Adversarial review confirmed
the ordering and fallback paths; web splash tests (3/3), i18n store tests (9/9),
and workspace typechecks pass.

## 2026-09-30 · PWA install prompt and manifest icons

The manifest now supplies 192px and 512px PNG icons, allowing eligible
browsers to raise `beforeinstallprompt`. Browser surfaces show an explicit
Install/Dismiss toast; accepted, declined, and failed native prompts retire
the consumed event, and dismissal is scoped to the tab session. The auditor
fixed the stale-toast/consumed-prompt case and confirmed prompt actions cannot
be submitted twice. Push notifications remain open. Full web tests pass
(1264/1264), web typecheck and production build pass, and release gates pass.

## 2026-09-30 · P7 terminal appearance follows the active theme

Terminal PTYs now receive the resolved theme mode and surface colors at creation,
and visible sessions receive appearance updates when the theme changes. The
existing terminal appearance route carries those updates to Mode 2031-aware
applications. Adversarial review found no confirmed defects; focused terminal
tests (6/6), UI typecheck, and diff checks pass. Shiki and diff consumers remain
open under E6.

## 2026-09-30 · P12b-51 authenticated desktop updater bridge (20260930-78)

The embedded server now passes authenticated `/api/openchamber/update-check`
and `/api/openchamber/update-install` calls to Electron's native updater. Install
rechecks and downloads before acknowledging, then starts the restart after the
HTTP response; update-status polling exposes late installer failures and
supports retry. The adversarial audit fixed a shared pending-update race,
late-failure visibility, and retry lockout. Full Electron tests pass (203/203
with two Windows symlink tests skipped), full web tests pass (1,247/1,247),
workspace typechecks pass, and the artifacts-only Windows package builds.
Packaged GUI acceptance and actual NSIS installation remain outstanding.

## 2026-09-30 · P13 source integration verification (20260930-77)

The local server smoke passes through health, auth, session creation, prompt
delivery, status, and control events. The cross-repository source smoke also
passes against `D:\ProjectRepo\NotNativeAgent`, covering authenticated
bootstrap, capabilities, provider diagnostics, model walkthroughs, live events,
prompt/delegation, restart-recovered child transcripts, steering, goal audits,
autonomous continuation, completion, and the origin gate. The adversarial
review found no concrete false-pass issue in that harness. This verifies the
source-tree contract journey; packaged-install and native-window GUI acceptance
remain open for P12/P13. Deferred rows D/E and the long-term VS Code/mobile
deferrals remain tracked above.

## 2026-09-30 · P12b-50 updater install and rollback (20260930-71)

Native update apply now checks the macOS Applications-folder requirement,
persists window geometry before install, defers `quitAndInstall()` until the
IPC reply can flush, and holds the invoke open for a bounded grace period.
The adversarial review found that a late installer error could leave the shell
quitting after the IPC grace; the listener now survives that window, reports
the error, rolls back shell state, and permits retry. Updater listeners are
removed at app exit. The install invoke timeout is 30 seconds. Full Electron
tests pass 182/182 and workspace typechecks pass.

## 2026-09-30 · P12b-49 bounded SSH remote-command runner (20260930-70)

Added a packaged remote-command primitive for managed SSH provisioning. It
uses the sanitized saved destination and fixed `sh -s` remote command, sends
scripts on stdin without a local shell, and bounds scripts, output, and process
time. Adversarial review fixed `StdinNull`/`SessionType` options that could
silently suppress script execution, trailing output loss on `exit`, and an
unhandled asynchronous stdin `EPIPE`. Four focused tests and the full Electron
suite pass. Managed package installation, server startup, forward adoption,
and disconnect cleanup still need to consume this runner.

## 2026-09-30 · P12b-46 updater policy primitives (20260930-67)

Added the deterministic native updater policy base: production GitHub feed
selection, E2E-build-only loopback feed override, Windows ARM64 channel
selection, Linux AppImage and parent-directory writability, and semantic
version ordering. Adversarial review caught and fixed same-day version
ordering and AppImage replacement-directory checks. Full updater setup,
check/download/install IPC, and UI progress delivery remain open.

## 2026-09-30 · P12b-47 native updater lifecycle bridge (20260930-68)

Packaged Electron configures `electron-updater` with the sealed feed/channel
policy and explicit downloads. The local main frame can check, download, and
apply a pending update through IPC; taskbar and progress events are bridged to
the renderer. Adversarial review found and fixed a missing apply IPC route.
Electron tests and typechecks pass, and the artifacts-only Windows x64 package
builds. Renderer update UI, restart grace/error rollback, and authenticated
server updater adapter remain open.

## 2026-09-30 · P12b-48 desktop update controls (20260930-69)

General settings now exposes native check, download, progress, and install
actions for Electron. A failed download clears its busy progress state so it
can be retried; download IPC uses a 30-minute response window to support large
or slow packages. Adversarial review confirmed both edge cases and found no
additional concrete UI defects. Managed SSH install/start and updater restart
grace/server-client integration remain open.

## 2026-09-30 · P12b-45 desktop password login/token issuance (20260930-66)

Electron now completes the session gate's password flow against the local
service or the active saved direct/SSH host. Main-process IPC resolves the
destination from native host state, issues a device token, and stores it in
the local token slot or matching host record. It rejects unsuccessful 200
responses, arbitrary destinations, host changes during login, and catalog
mutations in progress. The adversarial review fixed the unauthenticated-200
token acceptance case and the fallback endpoint's required `label` field.
Focused Electron tests pass 40/40 across login, host-config, and IPC suites;
UI auth tests pass 15/15 and workspace typechecks pass. Managed remote
install/start, desktop updater, and installed GUI acceptance remain open P12.

## 2026-09-30 · P12b-44 Mini Chat shortcut wiring (20260930-65)

The registered `new_mini_chat` action now opens the same current-session or
draft Mini Chat as the toolbar control. The adversarial review confirmed it
uses the existing customizable shortcut router and preserves the Windows
AltGr text-entry guard. UI tests pass 1453/1453 with one worker and workspace
typechecks pass. Managed remote install/start, password login issuance,
updater, and installed GUI acceptance remain open P12 work.

## 2026-09-30 · P12b-43 Mini Chat window (20260930-64)

The desktop shell can now open a separate Mini Chat window for the current
session or a fresh draft. Session windows are deduplicated by runtime and
session; the renderer receives bounded URL context and seeds its session view
before mounting. Local-main-frame IPC gates creation, pinning is restricted to
Mini Chat, and the window follows the documented platform chrome and remains
active while hidden. Adversarial review found and fixed the missing platform
chrome/background-throttling contract. UI tests pass 1453/1453 with one
Vitest worker, Electron IPC tests pass 22/22, and workspace typechecks pass.
Managed remote install/start, password login issuance/persistence, updater,
and installed GUI acceptance remain open P12 work.

## 2026-09-30 · P12b-42 SSH auth gate entry (20260930-63)

Explicit selection of a connected, API-compatible remote now adopts its
endpoint when the probe reports that login is required, letting the existing
session gate prompt the user. Startup keeps its local fallback on the same auth
response. The adversarial review confirmed the scope and fixed a tunnel-loss
race where fallback could be skipped while another catalog operation was busy.
It also traced an intermittent Windows SSH config-reader rejection to unsafe
numeric inode comparisons; descriptor and path stats now use BigInt identity
checks with a large-inode regression. Full Electron tests pass 155/155, full UI
tests pass 1451/1451, and workspace typechecks pass. Password login
issuance/persistence, managed remote install/start, and installed GUI
acceptance remain open P12 work.

## 2026-09-30 · P12b-41 SSH runtime adoption (20260930-62)

Ready SSH tunnels can now be probed and selected as active desktop runtimes,
using an `ssh:<id>` runtime key. Startup and explicit host switching route only
through the manager's current ready local endpoint; failed health or auth
checks fall back to local. Disconnecting, removing, or losing the active tunnel
returns the renderer to local before the endpoint goes away. The adversarial
audit fixed the bridge result-unwrapping contract, active-instance removal,
and repeated fallback retry defects. Electron tests pass 153/153; UI tests pass
1449/1449; workspace typechecks pass. A first parallel Electron test run had a
single non-reproducing SSH config reader failure; isolated and full reruns pass.
Password prompting, managed remote install/start, and installed GUI acceptance
remain open P12 work.

## 2026-09-30 · P12b-40 External SSH tunnel lifecycle (20260930-61)

Electron can now start an OpenSSH local forward to an already-running
NotNativeDesktop server, verify the tunneled `/health` identity, and publish
connect/cancel/disconnect status through local-main-frame IPC to Settings.
New catalog entries use the external-server mode on remote port 57123. The
process uses argv with `shell:false`, disables agent/X11 forwarding and
unrelated configured forwards, and is torn down on edits/removal or app exit.
Adversarial review fixed duplicate-connect, cancellation/reconnect ordering,
false-ready, invalid-edit teardown, and removed-instance ghost-status cases.
Focused IPC/transport tests pass 29/29; catalog UI tests pass 3/3; workspace
typechecks pass. Managed install/start, password prompting, runtime selection
through the tunnel, and installed GUI acceptance remain open P12 work.

## 2026-09-30 · P12b-39 SSH config Include reader (20260930-60)

The SSH settings reader now expands bounded recursive `Include` globs within
the user's home directory. It caps files, bytes, include depth, patterns, and
matches; skips cycles and symlinks; and validates the opened file identity
before reading, including on Windows where `O_NOFOLLOW` is unavailable. The
reader is included in the Electron packaging allowlist. Focused reader/IPC
tests pass (21/21), the artifacts-only Windows x64 package builds, and the
adversarial review's simulated path-swap regression passes. This remains
configuration import only; live SSH transport is still outstanding.

| Phase | Doc(s) | Status |
|---|---|---|
| P0 scaffold + shell | 01 | ✅ done 2026-07-21 (typecheck ×3 · vitest 6/6 · vite build · prod-serve + echo-loop smoke) |
| P1 harness seam | 02 | ✅ done 2026-07-22 (typecheck ×3 · vitest 11/11 incl. in-process contract tests · vite build · live smoke: LF-8 event sequence, Last-Event-ID replay, messageID echo, permission 404-settled) |
| P2 sync engine | 04 | 🔶 done 2026-09-16 (typecheck ×3 · vitest 84/84 across 12 suites · gates+smoke · adversarial sub-agent review: P0+P1 fixed in-slice, residuals registered) |
| P3 chat UI | 05 | 🔶 P3a+P3b+P3c done 2026-09-16 (P3a: chat spine; P3b: model picker/starters/timeline/prompt-rail/BTW fork/focus mode; P3c: work-status panel §E.9 subset + §E.3/§E.4 recap+suggestion band; P3b+P3c adversarial review: P0×2 + P1×9 fixed; 122 vitest · tsc ×3 · gates+smoke · P3d/P4+ per NOTES 05 §A + review register) |
| P4 server/API | 03 | 🔶 P4-1..3 done 2026-09-16 (P4-1: fs read+git status/check pre-proxy w/ containment; P4-2: settings/themes/projects-config/context + git log/branches; P4-3: fs write family (mkdir/write/delete/rename atomic+root-refusal) + session-folders §5.22 (last-writer-wins, 413, sync write queue); P4-1 review escaped-fixes landed, P4-2 review P1×4 fixed, P4-3 review QUEUED; web 23/23 · UI 122 · gates+smoke) |
| P5 themes/settings | 14 | 🔶 P5-1..6 core done 2026-09-17 (themes, settings registry/persistence, i18n, shortcuts, settings window/pages/search/recorder); NNA-backed capability pages remain in progress. |
| P6 review | 06 | ✅ done 2026-09-17 (P6-1 fs domain + FilesView core; P6-2 diff + git view; P6-3 plan/comments/worktrees core; P6-3b inline comment lifecycle + live worktrees; per-slice adversarial reviews fixed; 359 UI · 48 web · gates+smoke+graph) |
| P7 terminal | 07 | ✅ done 2026-09-17 (P7-1 server core: WS codec v3, sanitizer, theme responses, shells, node-pty, runtime, command plane; P7-2 client: Transport/store/observer/TerminalView v1; adversarial reviews fixed; 389 UI · 94 web · gates+smoke+graph) |
| P8 remote/security | 08 | ✅ done 2026-09-20 (all 15 checklist steps delivered + reviewed: P8-1a-d auth/creds/gate/passkeys · P8-2a-c + P8-3a relay primitives/host · P8-4a/c pairing+tunnels · P8-5a relay client face · P8-5b pairing/auth UX wired · P8-5c CLI connect-url · P8-6 SSH contract faces · P8-7 reverse-proxy posture · P8-8 §12 invariants sweep (42 rows, E-08-1..69); ui 608/64 · web 511/36 · typecheck ×4 · gates+graph+smoke; deferred rows in NOTES/08 §D/§B) |
| P9 autonomy | 12 | ✅ done 2026-09-30 (goals, scheduled tasks, snippets/starters, message queue UI, multi-run/fusion, session orchestration, live goal/scheduled feedback, adversarial reviews; full web/UI releases through 20260930-2) |
| P10 knowledge/context | 15 | ✅ done 2026-09-30 (isolated context storage and durable migration, notes/plans/todos, shared plans, agent memory/tool/runtime, session knowledge/riding, context pins, skills/catalog/install, MCP config/runtime, obligatory context, file/image guards, system reminders, BTW, and H.2 assist generation; adversarial reviews, web/UI suites, and graph/quality gates) |
| P11 preview | 13 | 🔶 Windows dev-server discovery, loopback readiness probe, isolated Electron guest, bounded DOM snapshot, identity-bound broker IPC, governed NNA browser open/snapshot/inspect/click/scroll/type/capture/history, user element/region/freehand screenshot drafts, server-owned staged/unstaged diff snapshots, explicit NNA model explanation, and the secure raw dev-tunnel host/direct/relay panel seam delivered 2026-09-30; walkthrough source selectors, generation lifecycle, UI lifecycle wiring, durable identity-bound cache, model selection/readiness, cache-backed metadata, direct model transport, rich chapter/stop schema, and strict provider response-schema requests delivered 2026-09-30; installed-GUI acceptance remains |
| P12 Electron | 09 | 🔶 installable Windows x64 shell, in-process web service, native terminal bundle, tray, source installer, launch-at-login, remote SSH lifecycle, password token issuance, Mini Chat, native updater controls, and authenticated server updater bridge delivered; packaged installation and native-window GUI acceptance remain |
| (deferred) VS Code | 10 | long-term deferred |
| (deferred) Mobile | 11 | long-term deferred |

## Log

- 2026-09-30 · **P12b-38 SSH catalog UI bridge.** The Remote Instances page
  now reads and edits SSH definitions, loads user `~/.ssh/config` host aliases,
  and adds/removes entries through the native local-main-frame bridge. The
  bridge unwraps invoke results and subscribes to bounded status events; the
  preload buffers early status events and validates phases and ports. Audit
  fixed rapid-click duplicate mutations with a synchronous operation lock.
  Focused settings/bridge tests pass 5/5, full UI suite passes 1447/1447,
  Electron suite passes 138/138, and all workspace typechecks pass. Live
  connection/status production remains pending.

- 2026-09-30 · **P12b-37 SSH placeholder isolation.** SSH placeholder hosts
  now carry a sanitized `transport: 'ssh'` marker. The generic host chooser
  hides them, direct-host probes and manual switches reject them until an SSH
  transport exists, and startup never probes their loopback URL as a remote
  server. This also stays safe when the SSH instance catalog is corrupt and
  its IDs cannot be read. An adversarial review confirmed the corruption case;
  boot, host-config, SSH, and IPC tests pass 47/47.

- 2026-09-30 · **P12b-36 SSH catalog CRUD IPC.** Exposed the renderer's
  existing config, upsert, create-from-command, and remove calls through the
  trusted desktop main frame. Main-process writes preserve the saved-host
  reconciliation path; generated ids use UUIDs, while edit/remove preserve the
  current catalog semantics. The adversarial review found that a corrupt
  persisted catalog could otherwise be mistaken for empty and overwritten;
  writes now fail closed while reads retain their safe empty-view fallback.
  The focused SSH + IPC suite passes 24/24. Live status events and
  connect/disconnect transport remain for later slices.

- 2026-09-30 · **P12b-35 SSH instance catalog foundation.** Added bounded
  SSH instance normalization, a shell-free argv tokenizer/parser, and local
  main-frame IPC for reading and saving definitions. Saving reconciles SSH
  ids with saved-host records through the atomic preferences writer; removed
  SSH defaults fall back to local, and collisions with direct/relay hosts are
  rejected. Secrets are retained only when settings storage is explicitly
  enabled. The adversarial audit blocked quoted/attached OpenSSH config and
  provider-loading options, constrained forwarding hosts, and preserved
  backslashes in quoted Windows paths. Focused SSH + IPC tests pass 23/23.
  This establishes the persisted catalog contract; connection lifecycle,
  process control, SSH config import, and UI wiring remain.

- 2026-09-30 · **P12b-34 saved-host probe IPC.** Added the §3.1 remote-host
  probe command for the trusted local main frame. Callers provide only a saved
  host id; Electron selects its sanitized URL and stored credentials, preserving
  server identity checks, query stripping, redirect rejection, and bounded
  probe deadlines without allowing renderer-chosen credential destinations.
  Relay-only hosts are rejected by this direct probe. Adversarial review found
  no additional defects. IPC + probe suites: 29/29.

- 2026-09-30 · **P12b-33 native window IPC core.** Added the §3.1 window
  controls for focusing, fullscreen state, title, app version, close, minimize,
  maximize toggle, and current maximize state. Each operation targets the
  calling BrowserWindow; mutating titles are bounded and reject controls. The
  adversarial review caught embedded-frame privilege inheritance; commands now
  require the invoking BrowserWindow's own trusted local main frame, with a
  regression proving secondary local windows remain usable. Focused IPC suite
  passes 13/13.

- 2026-09-30 · **P12b-32 native Electron startup repair.** Launching the
  workspace Electron binary exposed a runtime-only `ReferenceError`: main
  passed `ipcMain` to the invoke face without importing it. The named import
  is now present; a second launch started the embedded mock server, passed
  health readiness, and navigated the main window. The adversarial review
  found no further concrete initialization defects. Electron: 118 tests;
  syntax check and artifacts-only package pass. The computer-use bridge still
  exposes no native app window, so visual GUI acceptance remains open.

- 2026-09-30 · **P12b-31 mixed direct/relay pairing fallback.** Mixed pairing
  links now disclose all direct candidates and the relay destination in the
  native consent prompt. The importer probes direct addresses first and uses
  the encrypted relay only when none pass health and identity checks; it saves
  the relay descriptor and client token without retaining the one-time grant.
  The adversarial review caught a full-catalog duplicate check that missed
  already-saved relay identities; this now matches by server id. Focused
  Electron pairing tests pass (20/20).

- 2026-09-30 · **P12b-30 saved relay host switching and restore.** Remote
  Instances now identity-checks a saved relay descriptor, verifies API
  compatibility and authentication through E2EE, then adopts that same tunnel
  for the live runtime. Relay defaults boot locally until the trusted renderer
  restores the tunnel; failed probes keep the local runtime available. Main
  process selection is serialized with catalog writes, verifies the probed
  descriptor/token/headers still match, and startup retries temporary pairing
  locks for a bounded window. Startup restore now confirms the selected host
  remains the saved default, so a late probe cannot override a newer choice.
  Full UI: 1,442 tests; Electron: 115 tests;
  typecheck and focused relay tests pass. Mixed direct/relay fallback remains.

- 2026-09-30 · **P12b-29 relay-only pairing integration.** The native
  deep-link importer now consents to relay-only links, delegates redemption to
  the trusted local renderer over the bounded bridge, and saves the token plus
  public relay descriptor under the catalog lock. The one-time grant is
  stripped, existing direct-host metadata is preserved by server identity, and
  cancellation writes nothing. Thirty-three focused Electron tests, four
  renderer handler tests, 111 full Electron tests, and 1,438 UI tests pass.
  Mixed direct/relay fallback and live
  relay switching remain pending.

- 2026-09-30 · **P12b-28 relay redemption IPC bridge.** Added a bounded
  one-shot main/renderer request seam so Electron can retain native consent
  and catalog ownership while the local renderer runs the E2EE tunnel. Requests
  are capped, timeout and renderer-destruction paths settle them, and results
  use collision-checked request ids and accept only a token plus optional label.
  Six focused tests and all 106 Electron tests pass. Main/preload
  and UI event wiring remains pending.

- 2026-09-30 · **P12b-27 relay pairing redemption core.** Added the
  renderer-side relay redemption primitive required by the pairing contract:
  the one-time grant is used only to open a throwaway E2EE tunnel, the device
  dedupe key is sent through `/api/client-auth/pairing/redeem`, responses are
  size-bounded and validated, and the tunnel closes on every outcome. Five
  focused tests and UI typechecking pass. The full UI suite passes 1,433
  tests. Wiring consent, catalog persistence,
  relay runtime switching, and direct/relay candidate fallback remains pending.

- 2026-09-30 · **P12b-26 saved-host deep links.** Added bounded
  `openchamber://host/<id>` parsing and startup/reload queuing. Links are
  serialized through the same host-catalog lock and compatibility/auth probe as
  the settings switch; success reloads the local shell with the newly selected
  runtime, while missing/busy/override failures show a native warning. Focused
  parser and IPC checks (16), workspace typecheck, and adversarial review pass.

- 2026-09-30 · **P12b-25 remote instance chooser and live switching.** Added a
  Remote Instances settings page backed by desktop-local IPC. A selection is
  identity/API/auth probed, persisted as the default, and applied to runtime
  URL, token, headers, and storage namespace without closing settings; failed
  probes keep the local runtime active and leave the remote retryable. The
  adversarial audit fixed active-vs-default confusion and found a CORS gap:
  standalone remotes could pass Electron probing but reject renderer traffic.
  The server now supports the exact stable `notnative-ui://app` origin for
  credentialed CORS and browser writes, while rejecting lookalikes. Validation:
  99 Electron tests, 1,427 UI tests (single worker), focused CORS tests, and
  workspace typechecks passed.

- 2026-09-30 · **P12b-24 remote desktop boot integration.** Electron keeps
  the packaged UI local while initializing API clients from an authenticated,
  compatibility-probed saved or explicit remote host; failures fall back to the
  local runtime. Boot credentials/config are exposed through local-main-frame
  IPC only. Pairing verifies the relay-advertised server identity before
  sending its one-time secret to a direct candidate. The adversarial audit added
  regressions for missing/mismatched identity. Full Electron tests (98),
  typecheck, package build, quality gates, and graph checks pass.

- 2026-09-30 · **P12b-23 desktop boot target policy.** Added a pure resolver
  for explicit environment URLs, saved defaults, local fallback, and versioned
  probe results. It strips URL query/fragment data before probing, never inherits
  credentials into environment overrides, rejects invalid explicit overrides
  instead of falling through to a different saved host, and falls back locally
  if a probe throws. Adversarial review confirmed these two failure cases and
  added regressions (10/10 resolver tests pass). Electron boot integration is
  recorded in P12b-24 above.

- 2026-09-30 · **P12b-22 public API compatibility route.** The server now
  answers unauthenticated `GET /api/version` with its product version, runtime,
  process start time, optional stable server id, and the supported runtime URL
  compatibility capability. The route is registered before the general API
  auth gate and sends `Cache-Control: no-store`. Integration test confirms the
  public response contract.

- 2026-09-30 · **P12b-21 bounded Electron host probe.** Added the remote-host
  preflight used by the planned desktop boot router: optional server identity
  check before bearer headers, bounded `/api/version` and `/auth/session`
  checks, explicit auth/incompatible/wrong-service/update results, one deadline
  across fetch plus body reads, and a single longer retry only after an
  unreachable result. Adversarial review fixed query-string leakage and fail-open
  server identity handling; focused host-probe tests pass (15/15). Main boot
  routing remains pending.

- 2026-09-30 · **P12b-20 consent-gated pairing import.** Native consent now
  displays every possible direct destination with query values redacted and
  warns that the pairing secret goes to the first healthy candidate. The shell
  bounds health/redeem responses, rejects redirects, stops if the link expires
  during probing, redeems once, and persists the returned token under a locked
  saved-host catalog update. Relay-only import and switching the running app to
  a remote host remain pending. Adversarial review fixed candidate disclosure,
  duplicate-ID bypass, redirect leakage, host-cap interleaving, and lock-release
  ownership hazards. The full Electron suite passes (69/69).

- 2026-09-30 · **P12b-19 v2 pairing deep-link parsing.** The shell now
  recognizes bounded `openchamber://connect?v=2&p=…` payloads, validates UTF-8
  base64url JSON, expiry, all candidate forms, direct URL credentials, and P-256
  relay keys, then sorts candidates by priority. This slice only parses; the
  native consent, candidate probe, redeem, and host persistence are implemented
  in P12b-20; switching the running app to a remote host remains pending.
  Focused deep-link tests pass (5/5).

- 2026-09-30 · **P12b-18 session and focus deep links.** Electron now registers
  the `openchamber` protocol on Windows/macOS, parses bounded session and focus
  actions from launch argv, Windows/Linux second-instance argv, and macOS
  `open-url`, and delivers session links through the preload event face. Links
  received during splash/startup or a renderer reload wait for the trusted UI
  document to finish loading. The adversarial audit found and fixed a queue
  that could otherwise remain pending after a later reload. Focused parser and
  full Electron tests pass (53/53); connect pairing and host-switch links
  remain planned work.

- 2026-09-30 · **P12b-17 local host identity IPC.** The desktop exposes its
  local server client token and a stable per-install UUID only to the desktop
  main frame on the loopback or packaged UI origin. Missing or malformed
  install ids are regenerated and persisted; token reads return an empty value
  when unset. Adversarial audit found oversized/control-character stored
  tokens could be returned over IPC; reads now enforce the same 8,192-character
  and control-character policy as saved-host writes. Focused identity/host/IPC
  tests pass 13/13, and workspace typecheck passes.

- 2026-09-30 · **P12b-16 validated saved-host catalog.** Electron now stores a
  bounded host list, default id, first-choice marker, and optional local client
  token update through schema-sanitized local-only IPC. Direct URLs, request
  headers, and relay descriptors are sanitized; relay public keys are imported
  before persistence to reject invalid curve points. Adversarial audit found
  and fixed the invalid-key acceptance case. IPC/schema tests pass 9/9 and
  workspace typecheck passes. Boot-time host routing and chooser UI remain.

- 2026-09-30 · **P12b-15 atomic Markdown replacement.** Markdown saves now write
  a unique temp file beside the destination and atomically rename it into
  place. Windows retries only transient `EPERM`/`EACCES`/`EBUSY` errors using
  the documented bounded backoff; other platforms get one attempt. Failed
  replacement retries temp cleanup on Windows and leaves an existing target
  intact. Adversarial audit caught the cleanup retry edge and it is fixed;
  focused tests and workspace typecheck pass, with final build gates pending.

- 2026-09-30 · **P12b-14 validated desktop local-path actions.** The shell now
  validates readable files and traversable directories before open/reveal,
  rejects special files, surfaces resolved Electron shell failures, and uses
  argument-vector app launches only on macOS. The shared UI wrappers require
  Electron IPC plus a local loopback or packaged `notnative-ui://app` origin;
  path IPC also requires the desktop main frame. Focused Electron/UI tests and
  workspace typecheck pass. Adversarial re-review caught and fixed a frame-list
  confusion that could grant a remote main frame local privileges when a
  trusted local child frame was also present; build gates passed after repair.

- 2026-09-30 · **P12b-13 guarded file utilities and custom-origin IPC.** The
  desktop main frame can read bounded files under the home/temp roots and save
  Markdown through the native picker. Credential directories/files are denied,
  symlink escapes are rejected, and reads stream under a 50 MiB cap. Adversarial
  review also found the custom `notnative-ui://app` origin was rejected by the
  IPC/navigation/permission gates because Node reports it as opaque; exact
  scheme+host matching now restores trusted access while rejecting lookalikes
  and credentials. Focused tests pass 6/6; full workspace checks pending.

- 2026-09-30 · **P12b-12 first-party notification permission gate.** Electron
  now allows notification permission only for the desktop main frame at the
  exact loopback app origin; the embedded preview partition remains deny-all.
  Adversarial review found and fixed a same-origin iframe permission-check
  leak by requiring the main frame in both request and check handlers.
  The v28 source installer completed and NNA reports it valid; health and web
  asset checks passed. Typechecks, Electron syntax checks, and quality gates
  passed. Native delivery, dedupe, and notification-click routing remain
  incomplete; the visible permission interaction could not be exercised because
  CUA exposes no native app windows. Tests were not run.

- 2026-09-30 · **P12b-11 launch at login.** General settings now expose
  Windows/macOS login startup through a main-frame-gated Electron IPC command.
  Windows source installs preserve the main script argument and start hidden
  behind the tray; when no tray is available, the app shows its window instead
  of becoming inaccessible. The adversarial audit caught and fixed that
  tray-failure case. The v27 source installer completed and NNA reports the
  package valid; the installed server health and web asset checks passed.
  UI/web typechecks, Electron syntax checks, quality gates, version and graph
  checks passed. Tests were not run. The settings toggle still needs native
  Electron-window interaction, unavailable in this host's CUA app inventory.

- 2026-09-30 · **P12b-10 installed package walkthrough (20260930-25).** The
  NNA-aware source installer completed, and `nna nnd package status` reported
  the installed package registered and valid at version 20260930-25. The
  installed Electron server bound its stored loopback port, health returned
  version 20260930.0.25, and the UI document plus its JS/CSS assets returned
  HTTP 200; the browser rendered the UI. The desktop host exposed no native
  application windows to CUA, so the native-window visual walkthrough remains
  unverified. Installer/runtime adversarial audit found and corrected the stale
  evaluation record; no runtime defect was confirmed.

- 2026-09-30 · **P12b-9 content-verified Electron build stamp.** The artifact
  pipeline now writes a deterministic stamp over the source inputs, package
  version, server/UI outputs, settings registry, tray icons, and staged `node-pty`
  runtime. `install.ps1 -SkipBuild` validates that exact stamp and rebuilds on
  missing, stale, or changed content instead of relying on mtimes and warning
  while reusing stale code. The stamp check passed for the fresh artifacts;
  adversarial review found and fixed an artifact-hash gap for Vite's generated
  assets. The corrected stamp, Electron artifact build, typechecks, quality
  gates, version check, and graph check all passed. Tests were not run.

- 2026-09-30 · **P12b-8 native zoom lock.** Electron content zoom now starts
  at 100%, rejects pinch zoom through visual zoom limits, and resets native
  wheel zoom requests so the product's own scaling controls stay authoritative.
  Adversarial review found and fixed the pre-application timing edge in
  Electron's `zoom-changed` event. Syntax checks, all workspace typechecks,
  quality gates, and the artifacts-only Electron package build passed; tests
  were not run.

- 2026-09-30 · **P12b-7 bounded renderer recovery.** The main Electron window
  now auto-reloads after recoverable renderer exits (`abnormal-exit`, `crashed`,
  `oom`, `memory-eviction`) with a 100 ms delay and a maximum of three reloads
  per rolling minute. Clean exits and unrecognized reasons only log; destroying
  the window cancels pending recovery. The existing tray Open App path remains
  the manual escape after the budget is exhausted. Adversarial review found no
  confirmed defects; Electron syntax checks, all workspace typechecks, quality
  gates, and graph currency passed. Tests were not run.

- 2026-09-30 · **P12b-6 tray boot-retry recovery.** When startup reaches a
  server handle but its health probe times out, the stopped tray's failure card
  now offers a bounded health recheck. The retry IPC accepts only the trusted
  desktop main frame, serializes concurrent attempts, and reopens the app only
  after health succeeds; it never starts a second server or changes the
  import-time port. Failures before a server handle exists retain explicit
  restart guidance. Adversarial review caught and fixed a destroyed-window
  path that could replace the failure card with the unhealthy app origin.
  Electron syntax checks, all workspace typechecks, quality gates, and graph
  currency passed; tests were not run.

- 2026-09-30 · **P11-32 cache-backed walkthrough stop metadata.** Generated
  stops now carry server-owned scope, path, rename path, and line positions;
  chapters may include a bounded summary. Cache format v2 validates and
  persists these facts, and cache hits re-check them against the current
  snapshot. The UI validates response structure, metadata, uniqueness, and
  payload bounds before installing a narrative. A metadata-mismatched but
  otherwise valid cache record is evicted and regenerated rather than causing
  repeat 409 failures. UI/web typechecks passed; focused regression cases were
  added but not run in this slice.

- 2026-09-30 · **P11-34 rich walkthrough schema (seal 20260930-18).** Model
  answers now carry a title and focus line, bounded chapters with icon and
  blurb, and titled/weighted stops that may anchor up to 14 current hunks.
  Server normalization resolves every alias to current snapshot metadata;
  cache v3 validates the full narrative and its anchors; the client validates
  the same shape and displays the grouped explanation for each selected hunk.
  Adversarial review fixed a cache rejection for prose containing escaped line
  breaks. Both typechecks and quality/graph gates passed; tests were not run.

- 2026-09-30 · **P11-35 provider-structured walkthrough output.** The bounded
  walkthrough JSON Schema is now sent through OpenAI Chat Completions,
  Anthropic Messages, and Google GenerateContent structured-output fields when
  the catalog marks the selected model capable. An explicit schema refusal
  retries once with JSON mode/prompt-only JSON; response normalization remains
  authoritative. Adversarial review found no confirmed defect. Web/UI
  typechecks and production web build passed. Tests were not run. Installed
  desktop acceptance remains pending: no native target window is exposed in
  this session, and NSIS generation is disabled pending the NNA-aware installer.

- 2026-09-30 · **P11-30 durable walkthrough cache.** Successful explanations
  now persist under the server data directory, keyed by the exact capture
  signature, bounded hunk IDs, repository root, source, provider/model identity,
  and active language. Cache lookup still revalidates the live snapshot and NNA
  session/workspace ownership and only skips the model call. Persistence is
  bounded to 64 entries, 8 MiB, and 30 days with atomic replacement and
  malformed-entry discard; unresolved identity disables caching rather than
  attributing an answer to the wrong model. Audit fixes include the capture
  signature, harness `Session.model` identity, and timestamp validation. Full
  web tests 1221/1221, focused UI walkthrough tests 17/17, both typechecks,
  quality, and graph gates passed.

- 2026-09-30 · **P11-29 walkthrough lifecycle UI wiring.** Added canonical
  source-aware progress and cancel client calls, explicit stage display, and a
  cancel control. Cancellation reports false or failed server acknowledgements instead of
  pretending a local detach was an abort, and late results remain ignored after
  a confirmed cancel. Progress watchers receive abort signals so superseded,
  settled, or unmounted runs do not keep polling.

- 2026-09-30 · **P11-28 walkthrough generation lifecycle.** Attached
  in-memory collection/assembly jobs to repository-root plus source identity,
  reused a still-running promise instead of racing the model, exposed explicit
  progress and cancel states, and composed the model deadline with the
  cancellation signal. Stale diff signatures remain rejected after assembly;
  malformed progress/cancel descriptors fail explicitly. Restart intentionally
  clears progress, settled jobs do not persist, and a durable content-addressed
  cache remains deferred until layout/model identity is stable. Web 1213/1213,
  UI 1408/1408, both package typechecks green.

- 2026-09-30 · **P11-27 walkthrough source selectors.** Added branch, commit, and pull-request source selectors beside working-tree scopes; server-owned merge-base, first-parent/root commit, and bounded future-proof PR descriptor capture; source-aware generation with stale-source guards; UI source state and focused assertions. Adversarial review fixed source-loss, 40-hex signature validation, root-commit leakage, and malformed query handling. UI 1408/1408, web 1209/1209, both package typechecks green.

- 2026-09-30 · **P11-26 relay dev-tunnel branch.**
  Electron main binds a loopback route per upstream target, pauses each
  accepted socket, transfers one `MessageChannel` port to the trusted renderer,
  and pipes `ready/data/close` through the existing relay tunnel. Route reuse
  awaits a shared pending open; readiness has a 15-second budget; token refresh
  and virtual-socket failures reject their connection promise; close and errors
  move in both directions. The bridge closes only its route or webContents and
  closes all routes on endpoint change; transfer failure destroys only that
  source. Adversarial review fixed port event handling, pending-open races,
  duplicate close paths, async callbacks, transfer isolation, and stronger
  frame-shape tests. Node bridge tests 4/4, direct-client 6/6, panel seam
  9/9, and web/UI typechecks passed.

- 2026-09-30 · **P11-24/25 raw dev-tunnel host and direct client.**
  The security host upgrades only the exact `/api/dev-tunnel`, rechecks
  discovery before every connection, enforces the three auth postures plus the
  URL-token exception, synchronously caps 64 sockets per host, applies a 5 s
  stalled-dial timeout and 1 MB WS backpressure, and closes peer sockets
  symmetrically. The direct client binds a per-connection loopback port and
  `ws(s)`-requires an http(s) runtime; it reuses keyed bootstrap/base port
  pairs, pauses during a 15 s handshake, bounds pending bytes to 256 KB,
  destroys only the failing connection, and exposes a selection seam. Panel
  logic resolves loopback targets with implicit 80/443 and per-runtime caches,
  never falls back to the unsafe plain URL, restores the original origin for
  display, and invalidates plus closes stale bridges when the runtime changes.
  Adversarial review fixed alias-origin restoration, endpoint-switch races,
  stale bridge cleanup, and a failed local source leaving a pending websocket.
  Focused security/transport/client/panel suites 29/29 and both typechecks
  passed.

- 2026-09-30 · **P10-64 durable project-context migration.**
  Normal reads now project legacy notes/todos without consuming them; the
  plan-link path and explicit context mutations durably adopt the isolated
  document before bounded legacy keys are removed, while unrelated config
  values remain. Alias conflicts, malformed lists, unsupported plan paths, and
  other malformed input fail before handoff; repeated and concurrent projected
  readers converge. Config PUT preserves unseeded keys and rejects changed
  context-owned echoes after ownership handoff. The final adversarial audit
  aligned §D.5 documentation with that deferred-adopt contract. Focused
  storage/route/plan suites 34/34 and web
  server typecheck passed.

- 2026-09-30 · **P10-65 locale-calendar and D8 fixture pins.**
  Added a genuine DOM locale-calendar test for non-ASCII weekday chips in
  German with the locale's first-day walk order, over the existing pure
  weekInfo/off-by-one/midnight-zone pins. Added concrete HTTP fixtures to the
  D8 project-context API: a 404 missing-authority response remains distinct
  from a malformed authoritative body, and pin-only PATCHes omit the note
  body so text edits never ride a pin update. No `supportsCalendarData`
  fake exists in the repository or planning record; the genuine browser
  DOM/Intl behavior and real response shapes were preferred.

- 2026-09-30 · **P10-63 H.2 small-model generation.**
  Added the production small-model generation port for documented OpenAI,
  Anthropic, and Google providers. Model resolution follows explicit request,
  settings override, session preferred provider/model, harness small model,
  and a readiness-filtered authenticated-family fallback; restricted providers,
  public-key sentinels, malformed selectors, and exhausted output bounds fail
  closed. Direct first-pass calls carry bounded body, context, prompt, system,
  and output constraints, then normalize responses into recap/suggestion
  content. The live session-assist runtime consumes harness read/patch ports,
  applies the preferred pair and settings filters/clamps, and writes idle
  assistance only through server-owned metadata. Adversarial review landed
  naming, budget, URL, credential, readiness, exhaustion, and timeout fixes;
  focused small-model/assist tests 12/12 and web server typecheck passed.

- 2026-09-29 · **P10-56 live project-panel knowledge pins.**
  Notes and saved plans now offer live-session pin/unpin through the additive
  route when the companion rail has a real session; draft behavior remains
  unchanged for null targets. The panel seeds toggle state from summary,
  adopts authoritative returned sets, serializes actions, disables controls
  while targets are unavailable, reports tab-local errors, and discards stale
  responses when the live session changes. Truth: focused panel/draft/summary
  suites 61/61 excluding the unrelated schedule test; full UI otherwise 1,369+
  passed with that same deterministic date-boundary test.

- 2026-09-29 · **P10-57 session-assist trigger contract.**
  Added the H.2 assist metadata validator/merge and an isolated generation
  lifecycle. Live idle events arm a 60-second timer; non-idle status, newer
  user activity, runtime changes, deletion, or in-flight staleness invalidate
  generation. The write path re-reads session and assistant identity, clamps
  recap/suggestion, merge-writes `metadata.openchamber.assist`, and refuses
  stale generation. Adversarial review fixed numeric-looking identity
  coercion; focused tests 6/6 and web typecheck passed.
- 2026-09-29 · **P10-61 system reminders.**
  Added the §G.7 idempotent synthetic-reminder wrapper and the composer
  first-send/draft rider. An enabled response-style profile emits one reminder
  part, resolved from configured custom instructions or a bounded preset
  description (concise fallback for malformed storage; a blank custom profile
  emits no rider). Active BTW sessions never receive it. Focused reminder and
  composer-integration tests covered the wrapper, selection, first-send,
  materialization, and BTW exclusion; adjacent composer coverage 26/26 passed.
- 2026-09-29 · **P10-62 markdown image grants.**
  Added the §G.6 server authority for assistant-authored local images. The
  route re-reads assistant text, parses inline and reference images with
  fence/span/escape handling, accepts only exact referenced sources, and
  resolves files only under the workspace or the approved OS temp root.
  Openers, realpath, and size/format checks gate each file; verified outside
  files receive a path-bound, raw-only ten-minute grant consumed by `/api/fs/raw`.
  The chat renderer refuses unprepared local images and uses the same guard for
  inline, list, heading, and quote contexts. Focused parser+route tests 6/6 and
  adjacent markdown tool-card tests 9/9 passed; web/UI-server typechecks passed.
- 2026-09-29 · **P10-60 outside-file grants.**
  Added the §G.5 desktop resolver for outside-workspace file reads. Workspace
  membership checks are separator/drive aware; only an enabled local-host
  approval can produce a grant. Grants are cached under normalized keys with a
  five-second renewal buffer, alias and granted-path entries share the token,
  and concurrent requests deduplicate. Relative and drive-relative inputs fail
  closed, workspace-root comparisons are normalized, and transport failures,
  failed approvals, malformed replies, and nonfuture expiries return the safe
  no-grant shape; expired cache entries re-mint through the same host. Six focused resolver
  tests and UI typecheck passed.
- 2026-09-29 · **P10-59 context-file open guard.**
  Added the §G.4 validator for context-rail file links. Document/image/media
  and known-executable extensions bypass text decoding; regular text files use
  a fresh bounded read with a 10 MiB stat preflight, NUL binary sniff, and a
  20,000-line ceiling. Transport failures classify true 404 responses as
  missing and permission/unknown/server errors as unreadable, while empty
  paths fail immediately; fresh-read length overflow also classifies as
  too-large after stale stat data. Focused guard tests 7/7 and UI typecheck
  passed.

- 2026-09-29 · **P10-58 session-assist read surface.**
  The composer band now reads only server-owned `metadata.openchamber.assist`,
  validates and fails closed, anchors independently of a trailing user message,
  requires the completed assistant anchor and idle readiness, and enforces the
  60-second quiet window plus a bounded timestamp age. Recap and suggestion are
  independently controlled; the suggestion chip still only fills the composer.
  The Settings Session assistance section adds the two default-on controls.
  Adversarial review removed an unhandled "dismiss" seam. Focused chat suites
  cover 46 files and 367 tests; web and UI typechecks pass.

- 2026-09-29 · **P10-55 work-status knowledge summaries.**
  The work-status panel shows server-owned pinned note excerpts, plan titles,
  and global/project memory counts in a Knowledge sources section. A five-second
  bounded cache refreshes by target, a successful unpin locally removes the
  row, empty targets never call the route, and unavailable reads stay isolated
  from other panel sections. Truth: focused summary/work-status suites 22/22;
  full UI blocked by unrelated deterministic schedule once-date test.

- 2026-09-29 · **P10-54 session-knowledge send rider.**
  Client prompt sends now request server-assembled pinned plan/note and agent
  memory knowledge, prepend it as a labeled synthetic part, and record the
  delivered signature only after the actual prompt resolves. Discovery errors
  and unavailable knowledge never block sends; failed deliveries retry later.
  An ambiguous send confirmed to have landed also records delivery. Truth:
  focused rider/recovery/BTW/multirun suites 36/36; full UI 1,365/1,365.

- 2026-09-29 · **P10-51 draft project-context pins.**
  Notes can be pinned into a bounded `{ notes, plans }` draft while a new
  session is active. The first send carries targets through fresh-read
  creation metadata, verifies the PATCH identity, and sends the prompt; success
  clears draft pins while any materializing-stage failure preserves them.
  Adversarial review fixed pin-state rerender and malformed stored-pin
  normalization. Truth: UI typecheck green; focused pin suites 14/14; full UI
  1,347/1,347 and web 1,158/1,158; graph current at 549 modules.

- 2026-09-29 · **P10-50 chat-row context pins.**
  User and assistant transcript rows now provide pin/unpin actions backed by
  the same validated fresh-read metadata PATCH used by work-status pins.
  Successful commits update only the target session record; failures preserve
  local metadata, clear busy state, and report an error. Unmounted controls
  suppress stale completion toasts and UI writes. Same-session pins continue
  to serialize writes while concurrent external callers remain last-writer.
  An adversarial audit found no additional concrete defect. Truth: UI
  typecheck green; chat/session pin regression suites 8/8.

- 2026-09-29 · **P10-49 work-status context pins.**
  Context pins now ride a fresh generic session metadata PATCH with bounded
  validation and stored-pin ordering. The expanded work-status ledger reports
  the saved-pin count and offers pin/unpin. Adversarial review added session
  targeting, message validation, serialized same-session writes, metadata-only
  commit behavior, stale-action ownership, and cross-session failure isolation;
  it also records that cross-process metadata writes still lack CAS. Truth:
  UI typecheck green; context-pin suite 5/5; full UI 1,338/1,338. Release
  gates and hash sealing follow in this slice.

- 2026-09-29 · **P10-48 compaction restoration.**
  The server now runs the obligatory-context runtime on `session.compacted`:
  it validates bounded pin metadata, skips child/replayed/already-cursor
  events, fetches pinned messages independently, combines pending knowledge
  with restorable pins, reuses the pre-compaction model, and records the
  cursor with a fresh metadata read. Adversarial review corrected child
  sessions, metadata keys, pins outside the latest-window, stale memory
  delivery state, and legacy model mode. Truth: typecheck green; context and
  memory focused suites 10/10; full web 1,158/1,158 and UI 1,333/1,333;
  graph current. Release-quality gates and hash sealing follow in this slice.

- 2026-09-29 · **P10-47 MCP share import.**
  Settings can now import a JSON object map of MCP definitions through the
  existing layer-aware config routes. New entries create; same-name records in
  the same loaded source scope update; invalid values and transport refusals
  are reported by name without stopping other entries. Fresh list reads gate
  all writes, runtime switches abort in-flight imports, and the file input
  resets after every read so edited shares can be reselected. Adversarial
  review fixed user-scope overwrite through a dominating project preview and
  added cross-scope/list-failure/switch/reselection regressions. Truth:
  typecheck green; 37 focused store/page tests, full UI/web suites, quality
  gates, graph, and production build green; release seal pending.

- 2026-09-29 · **P10-46 MCP settings page.**
  The Settings MCP section now edits bounded OpenCode config records by
  workspace, adds/removes environment/header rows, controls enablement, performs
  two-step deletion, and reports the deferred-restart outcome. Runtime statuses
  are separate; Connect/Test/Disconnect and protected OAuth start/code callback
  actions use the P10-45 stores. Adversarial review fixed swallowed
  connect/disconnect errors, stale scoped drafts/actions after workspace
  switches, stale busy state, authorization starts without URLs, and opening
  non-HTTP(S) authorization links. Truth: typecheck green; 5 focused page
  regressions, full UI 1,327/1,327, web 1,151/1,151, quality gates, graph, and
  production build green; release seal pending.

- 2026-09-29 · **P10-45 MCP stores.**
  The UI gained runtime status keyed by workspace, health aggregation,
  in-flight/TTL refresh control, diagnostics, runtime resets, and honest
  connect/disconnect/test/auth outcomes. The config store gained directory
  maps, TTL force reload, deferred-restart mutation results, draft/body
  builders, and persistence for selected server. Adversarial review fixed
  project-directory creation in both private and mock layers, stale remote
  headers when clearing headers, and cleanup/readback failures that could
  leak or falsely report an authenticated connection. Truth: typecheck green;
  26 focused UI store tests, 18 focused MCP web tests, full UI/web suites,
  quality gates, and production build pending the final seal.

- 2026-09-29 · **P10-44 MCP config layer.**
  The server now reads/writes bounded `mcp` records in user and project
  OpenCode config files, preserves unknown config fields, exposes scope
  provenance, creates/patches/deletes by source layer, and returns deferred
  restart payloads. Audits fixed implicit null scopes, whitespace-only OAuth
  persistence, and project-path alias lock divergence. Seven focused tests,
  web typecheck ×3, quality gates, current graph, smoke, production build,
  CSS gate, and release seal passed.

- 2026-09-29 · **P10-43 configured Git identities.**
  Skill catalog server now accepts bounded credential-free profiles, resolves
  explicit IDs before scan/install, sends a fixed `ssh -i` SSH command, keys
  cached scans by resolved profile, and supplies profile candidates on real
  401 authentication failures. Bounded `ssh://` catalog sources are accepted;
  HTTPS and local-file rules remain unchanged. Truth: ui 1,296/1,296 (149 files), web
  1,133/1,133 (88 files), typecheck ×4, 537-file quality gates, current graph,
  smoke/build/release+, hash and version seal.

- 2026-09-29 · **P10-42 install cancellation.**
  One-skill installs now own an AbortSignal, expose cancellation for the exact
  captured source/workspace/skill, and return a distinct cancelled outcome
  instead of a server error. Runtime resets abort active requests and clean
  pending state. Relay transport now rejects already-aborted direct and
  connect-queued requests before allocating or sending a stream.

- 2026-09-29 · **P10-41 captured identity picker.**
  A qualified 401 auth response now opens identity choices only for the
  captured source, workspace, scope, target, and skill. Choosing one replays
  the exact request with its profile ID. Audit fixes preserve configured
  source identities between unrelated retries and accept identity payloads
  only from genuine 401s. P10-43 closes the server-side profile resolution.

- 2026-09-29 · **P10-40 catalog conflict resolution.**
  A 409 install response now opens a captured decision card only for the
  requested scope and managed target, offers individual skip/overwrite and
  global skip-all/overwrite-all, and retries the same source, workspace,
  scope, target, and skill. Malformed conflict metadata remains a non-conflict
  failure. Audit fixes prevented cross-target preflight deadlock and rejected
  invalid conflict payloads at transport. Identity dialogs and API-level
  cancellation remain pending.

- 2026-09-29 · **P10-37 skills catalog store.**
  The UI gained a per-source configured-catalog store with a 3-hour scan cache
  and per-worktree/cache refresh bypass. Catalog failures retain prior sources,
  per-checkout scan failures keep prior data, install readiness is checked
  before transport, conflict/auth shapes remain structured. Runtime switches
  clear runtime state, and a generation token isolates reset-time races.
  API-level install cancellation remains pending.

- 2026-09-29 · **P10-38 skills catalog browse page.**
  The previously idle Settings route now browses configured sources through
  the catalog store, follows the active workspace, and preserves prior data on
  read failures. Refresh bypasses the selected source cache. Audit fixes key
  scans by source/workspace, keep the latest overlapping response, and clear
  catalog state via a runtime-epoch reset. Selection, conflict, identity, and
  install controls remain pending.

- 2026-09-29 · **P10-39 per-skill install controls.**
  Catalog items gained user/project scope and OpenCode/agents target controls.
  One selected skill installs with the active workspace, refreshes its source
  after success, and retains the row on rejection. Audit fixes block duplicate
  requests, isolate runtime resets and captured status, and include per-skill
  in-flight guards. Conflict decisions and identity selection remain pending.

- 2026-09-29 · **P10-36 skills catalog client transport.**
  The UI gained a typed `runtimeFetch` boundary for skill listing, catalog
  sources, configured/ad-hoc scans, and installation. It preserves structured
  auth/network/invalid-source/conflict errors, encodes query fields once, guards
  source IDs, and enforces directories for project installs. Store and page
  wiring remain pending.

- 2026-09-29 · **P10-35 selected skill catalog installer.**
  `/api/config/skills/install` performs one bounded sparse checkout per request
  and installs user/project selections into managed OpenCode or agents targets.
  Conflict decisions are prechecked and post-checked; clones and temporary files
  are isolated and removed. Symlinks, oversized trees, escaped targets, and
  invalid frontmatter fail without following unsafe paths. The batch remains
  fail-fast and does not roll back already-installed siblings.

- 2026-09-29 · **P10-34 configured source scan cache.**
  Configured catalog scans now have a persisted three-hour success cache keyed
  by canonicalized repository/subpath/identity. Hits share in-flight scans,
  global scans cap at two, writes are debounced atomic, and malformed cache
  data behaves as cold. `refresh=true` bypasses the cache. Per-checkout
  installed state is recomputed, not cached.

- 2026-09-29 · **P10-33 configured source scan route.**
  `/api/config/skills/catalog/source` resolves a curated or custom `sourceId`,
  applies its default/custom subpath and identity, and reuses the bounded
  one-shot Git scanner. Unknown IDs, malformed refresh flags, and scanner
  failures return structured errors. Persisted cache and refresh bypass remain
  pending.

- 2026-09-29 · **P10-32 ad-hoc Git skill scanner.** POST
  `/api/config/skills/scan` clones one HTTPS/owner-repository or local Git
  source at depth one with the planned blob filter fallback and scans bounded
  SKILL.md files without following symlinks. Items expose repository identity,
  frontmatter, warnings, installability, and installed state. Unreachable,
  auth-required, invalid, and unknown failures return structured kinds. Identity
  selection and persisted scanning cache remain pending.

- 2026-09-29 · **P10-31 skill catalog contract shell.** New
  `/api/config/skills/catalog` exposes the merged curated/custom source list,
  exactly one `itemsBySource: {}` map, and best-effort GitHub stars and push
  time. Requests are bounded to APIv3, authenticated OAuth-free HTTPS, a 2.5 s
  timeout, two at a time, only GitHub targets, and a five-minute in-memory
  cache with per-repository dedupe. Star counts and timestamps are independently
  rejected when malformed; host paths are decoded after split validation. Git
  item scanning remains pending.

- 2026-09-29 · **P10-30 configured custom skill source inventory.** The
  additive source inventory now merges sanitized `skillCatalogs` settings
  after the four curated identities. Records point to HTTPS or owner/repository
  sources, carry safe relative subpaths and optional Git identity references,
  deduplicate IDs, never override curated IDs, skip malformed values, and cap
  custom sources at 32. Full E.4 scanning and installation remain pending.

- 2026-09-29 · **P10-29 skill catalog source inventory.** The server now
  exposes the four curated source identities planned for the skills catalog:
  Anthropic, OpenAI, Cursor, and Matt Pocock. This read-only diagnostic is an
  additive source inventory, not yet the full E.4 catalog route; enrichment,
  custom sources, item scanning, and installation remain pending. A focused
  source-shape regression passed after the audit corrected missing OpenAI and
  contract metadata.

- 2026-09-29 · **P10-28 managed skill supporting files.** Managed skill
  directories now expose bounded read/write/delete support for `files/*`,
  including nested paths. Guards reject traversal, absolute paths,
  SKILL.md contents, and every link segment; writes stabilize the eventual
  parent against the canonical skill root before mutation. The audit added
  lstat checks and a nested-junction regression for read/write/delete
  boundaries. Twenty-eight focused tests and web typechecks passed.

- 2026-09-29 · **P10-27 managed skill delete.** DELETE now resolves exact
  user/project scope, allows only managed OpenCode roots, and removes the
  whole skill directory with restart deferral. A second delete is 404.
  Nonabsolute project scopes are 400. The fresh adversarial reviewer fixed
  the relative-directory defect and added its regression. Twenty-five
  focused tests and web typechecks passed.

- 2026-09-28 · **P10-26 managed skill update and rename.** PATCH now
  supports bounded content edits and pure managed renames with a 2 MiB wire
  cap, exact scope lookup, race-safe hard-link publication, and restart
  deferral. Pure rename preserves content while updating the opening
  frontmatter name and directory. Adversarial audit fixed cross-scope PATCH,
  opening-block rename rewriting, mixed rename/content bodies, and
  checkout validation. Twenty-three focused tests and web typechecks
  passed.

- 2026-09-28 · **P10-25 managed skill create API.** OpenCode skill create
  now validates exact names/body shape, requires nonempty instructions,
  rejects frontmatter line injection, bounds request wire size, resolves
  both managed roots, and uses race-safe hard-link commit. Existing names
  and targeted files return 409; responses return restart deferral. The
  adversarial audit fixed empty payloads, newline injection, drive-relative
  roots, file-as-checkout handling, oversized parses, and Windows overwrite
  races. Eighteen focused tests and web typechecks passed.

- 2026-09-28 · **P10-24 configured OpenCode skills.paths.** The server now
  discovers extra skill roots from OpenCode JSON config layers with
  `~/` expansion and project scope. Missing, malformed, oversized,
  relative, and drive-relative values are ignored. The adversarial audit
  added a 1 MiB read cap, root/path dedupe, one Git worktree resolution, and
  pre-join XDG root validation. Eleven focused tests and web typechecks
  passed.

- 2026-09-28 · **P10-23 OpenCode cache discovery.** Skill scans now include
  the three specified OpenCode cache roots at user scope. `XDG_CACHE_HOME`
  is validated as absolute before joining, covering drive-relative Windows
  edge cases, and exact duplicate roots are deduplicated. Eight focused
  regressions and web typechecks passed after adversarial audit fixed the
  cache-home validation defect.

- 2026-09-28 · **P10-22 OpenCode config-root discovery.** Skill scans now
  include absolute `OPENCODE_CONFIG_DIR`, `~/.opencode`, and each contained
  project-worktree-ancestor `.opencode` root in both legacy and plural
  layouts. User/project scope, source labeling, OpenCode visibility, and the
  200-item bound are preserved. Seven focused regressions and web typechecks
  passed after the adversarial audit fixed a fixture-frontmatter defect.

- 2026-09-28 · **P10-21 bounded ancestor skill discovery.** Local skill
  scans now canonicalize the checkout, find its Git worktree root through a
  bounded `rev-parse` subprocess, and scan ancestor `.claude` and `.agents`
  roots only inside that worktree. Path-case normalization covers Windows
  drive-letter differences while preserving user/root ordering, external
  flags, and the 200-item bound. Two focused regressions and web typecheck
  passed; adversarial audit fixed one Windows case-sensitivity defect and
  found no further concrete issue.

- 2026-09-28 · **P10-20 managed memory consumption.** NNA
  `20260928-9` now validates the exact NND loopback callback, consumes and
  clears its launch secret, exposes `openchamber_memory` only on root NND
  sessions, bounds schema/output/action failures, rejects secret-like saves,
  and excludes delegated engines. NNA full check passed at 1,615 tests with
  3 skipped. The remaining P10 surface is skills/MCP integration.

- 2026-09-28 · **P10-19 memory callback launch contract.** NND now mints
  the memory callback credential only when agent memory is enabled at
  managed NNA boot, validates its loopback URL before spawn, strips any
  inherited callback env values, and registers the bearer-protected
  callback only for the managed child. Attach mode receives no launch
  secret. NNA-side consumption is delivered by P10-20. Adversarial audit found
  no desktop-side defect; 29 focused tests plus web typecheck passed.

- 2026-09-28 · **P10-18 memory prompt delivery.** Added a server-owned
  agent-memory knowledge provider and wired the queued, scheduled, and
  dispatched session send paths. Delivery carries only the planned safe
  title index, records per session only after acceptance, catches lookup
  failures, and invalidates delivered signatures on memory-change events.
  Project discovery is bounded to eight seconds. Adversarial audits fixed
  test isolation, canonical-action event emission, byte-bounded callback
  reads, explicit-parameter scope drift, panel refresh looping, partial
  store failures, type coercion, and delivery timeout. The managed NNA
  plugin remains pending; web 1,085 tests and UI 1,254 tests passed, with
  focused provider tests and typecheck green after the timeout fix.

- 2026-09-28 · **P10-14 shared project plans.** The canonical Plans tab now
  lists every safe team markdown plan after personal plans, distinguishes
  claimed and unclaimed shared rows, and scopes reads/edits/deletes/transfers
  to a checkout directory. Share preserves the original manifest ID while
  unshare preserves the plan; unclaimed plans use `shared:<file>` and gain an
  ID only when brought back into project context. Team configured `plansDir`
  is honored; symlinks, traversal, reserved names, and oversized bodies are
  rejected. Adversarial review added checkout-error route mapping and fixed a
  share/unshare integration request using the wrong HTTP verb; the internal
  transfer/update race is serialized by a plans-directory lock. The complete
  web suite had 1,062 passing tests plus a one-off unrelated e2e teardown
  timeout that passed cleanly when rerun.

- 2026-09-28 · **P9-5c multi-run launcher integration.** Wired a real UI
  launcher and service adapter through git detection, worktree creation and
  rollback, model catalog selection, optimistic dispatch, and the SyncEngine
  session registry. Adversarial review fixed worktree metadata being written to
  the project-root store instead of the worktree child store, stale post-launch
  directory routing, project/source metadata, missing model variants, model
  picker positioning, and launcher guards for unavailable NNA routes and expired
  auth. Mid-launch dismissal controls are disabled. Setup commands, bootstrap
  waiting, settings persistence, fusion, and grouped-run review surfaces remain
  pending.

- 2026-09-28 · **P9-5b multi-run creation service.** Added the headless launch
  orchestration for group validation, project selection, git detection,
  isolation defaults, duplicate model indexes, worktree creation and rollback,
  per-run partial tolerance, setup-command persistence, and detached prompt
  dispatch.
  Adversarial review caught setup commands never being forwarded, dispatch
  being awaited instead of fire-and-forget, the model/file/agent context
  omitted from the dispatch call, and session-flow failure leaving the already
  created worktree in place. A second review hardened Git-safe identity handling
  and reserved `g1`-style group names that would otherwise round-trip as
  run-group markers. Launcher wiring landed in P9-5c; fusion remains pending.

- 2026-09-28 · **P9-5a multi-run identities.** Added the pure title bundle
  for group slugs, model slugs, ordinary runs, run groups, duplicate indexes,
  worktree names, fusion titles, and mandatory parse-round-trip segmentation.
  Adversarial review caught unusable fusion sessions because the parser
  rejected the `fusion` suffix; it now round-trips both run and fusion titles
  while rejecting malformed identities. Launcher/store wiring remains P9-5b.

- 2026-09-28 · **Activity continuity slice sealed.** Extracted the operator
  Activity surface to keep rail code under the 500-line gate and preserved
  behavior plus file/last-turn filtering. Adversarial review found that
  activity merge matched only record IDs, so a same-ID record from another
  session could replace real evidence; the merge key now includes session ID,
  with a collision regression test.

- 2026-09-28 · **Activity file and last-turn filters.** The live session log
  now filters completed, NNA-authored file changes and the latest turn's
  explicitly correlated turn/tool evidence. Correlated tool rows can jump to
  their prompt; a turn ID alone no longer produces an empty evidence expander.
  Adversarial review caught a false fallback to an older turn when the newest
  turn lacked correlation. That case now stays unattributed instead of
  displaying older work as the last turn.

- 2026-09-28 · **Last-turn file evidence in Changes.** NNA now projects the
  owning prompt request ID with sanitized parent tool evidence. Changes offers
  Session and Last turn scopes, with the latter matching only completed file
  mutations explicitly correlated to the latest authored turn and still in
  current Git changes. Legacy uncorrelated events are not guessed into a turn.
  The view remains navigational: current diffs can contain later edits, and
  bounded Activity history may omit older file evidence. An adversarial
  review found no concrete defect in this slice.

- 2026-09-28 · **Session evidence in Changes.** The selected session's
  completed file-tool evidence is now matched to current staged and working
  Git paths, including nested workspaces. The section says when a file was
  touched during the session without attributing later edits to the agent;
  committed or reverted paths no longer appear in its current-change list.
  Saved Activity loads when the pane opens, including when NNA configuration
  arrives later, with an explicit unavailable/retry state. Stale Git status
  disables its diff links. Adversarial review fixed the late-configuration
  history-recovery race. Evidence remains bounded, so an empty match is not
  proof that no file was ever touched.

- 2026-09-28 · **Context rail session identity and compact usage.** The normal
  docked Context pane now shows the selected session title, its NNA-configured
  route when known, and an honest context meter without requiring maximization.
  Unknown limits remain unknown; long message history and detailed usage cards
  remain in the expanded view. Adversarial review caught a cross-model/provider
  percentage mismatch in reported assistant usage; the limit now belongs to
  the assistant message that supplied the token count.

- 2026-09-28 · **Local branch creation in Changes.** The Branches dialog now
  offers a named Create & switch action from the current branch. The server
  validates the name, refuses an existing branch, stale current-branch view,
  or dirty tracked/untracked work, and shares the repository lock with sync
  and checkout. Adversarial review caught a concurrent-HEAD race: creation
  now pins the inspected commit as its start point and rechecks HEAD before
  the switch. An unborn repository remains supported. Remote tracking and
  alternative start points are still separate workflows.

- 2026-09-28 · **Deliberate local branch switching in Changes.** The Branches
  dialog now searches branches and can switch to an existing local branch.
  The server requires the current branch to match the inspected view, rejects
  dirty tracked or untracked work, serializes checkout with sync, and reports
  the actual checked-out branch. Changes refreshes after a switch and keeps
  remote branches read-only. Adversarial review fixed cross-workspace dialog
  state, a status-refresh failure misreported as success, a pre-checkout poll
  overwriting the new branch, and a branch-list request hanging on network
  rejection. Remote tracking, branch creation, and dirty-tree commit/stash
  workflows remain separate work.

- 2026-09-28 · **Recoverable Changes status failures.** The Changes pane
  now distinguishes a failed Git status load from an indefinitely pending
  request and offers an explicit retry. When a refresh fails after a previous
  success, the pane labels its rows as last-known and pauses staging,
  discarding, committing, and syncing until a fresh status succeeds. The
  adversarial review caught both stale-row mutation risk and a retry window
  that briefly re-enabled controls; Retry now bypasses a cached status and
  keeps controls disabled until its request completes successfully.

- 2026-09-28 · **Visible branch tracking in Changes.** The status route now
  separates branch from upstream in porcelain headers (including ahead,
  behind, gone, detached, and unborn cases). The Git header shows no upstream,
  up-to-date, divergence counts, or a missing upstream only when the status
  projection supports that claim. Compact rail actions wrap onto their own
  row instead of crowding the branch and sync state. Adversarial review caught
  a mixed-snapshot branch label; branch and tracking now render from the same
  polled status and detached HEAD has no misleading upstream chip.

- 2026-09-28 · **Safe first-push sync.** A new local branch without tracking
  can now use Sync branch or Commit & sync when one remote is available, or
  when the branch/repository explicitly selects a push remote. NND probes the
  target ref, refuses an existing branch, and requires it to stay absent
  through the push before installing tracking. Missing or ambiguous remotes
  remain actionable errors. Adversarial review also caught a stale configured
  upstream and concurrent local-branch advancement; neither can be reported
  as a fully synced first push.

- 2026-09-28 · **Real Git branch sync from Changes.** `Commit & sync` now
  commits locally, then invokes an explicit server-owned sync: require a
  configured upstream and clean worktree, fetch, rebase behind commits, and
  push only the selected branch's upstream ref. A separate Sync branch action
  can retry without another commit. Failures distinguish a successful local
  commit from an unsynced remote; rebase conflicts remain in Git for deliberate
  operator resolution rather than being silently discarded. Isolated local
  remotes cover push, divergent rebase, dirty refusal, and push.default scope.
  Adversarial review pinned the source commit and suppressed configured tag or
  submodule pushes, so a branch switch or Git preference cannot silently
  broaden the action to other refs.

- 2026-09-28 · **Changes group navigation.** The Git surface now labels
  staged and working groups with their file counts and lets each collapse
  independently. Bulk stage/unstage remains available in a collapsed group;
  selected diff and commit draft stay in place while scanning long lists.

- 2026-09-28 · **Readable maximized Activity.** The installed desktop GUI
  showed log events spanning an ultrawide monitor. Maximized Activity now
  centers its header, event rows, empty state, and live-tail control in a
  bounded reading column; the docked pane retains its full usable width.
  Adversarial review caught the live-tail control before release.

- 2026-09-28 · **Expanded Context message ledger.** Maximized Context now
  presents the newest 100 loaded messages in reverse order with role, part
  kinds, reported input/output tokens, and timestamp. It labels the loaded
  window honestly and never renders prompt text, tool output, or reasoning
  content in the ledger. The docked rail keeps actionable governance and
  subagent status ahead of long history; adversarial review caught and fixed
  this layout regression.

- 2026-09-28 · **Context-to-subagent handoff.** Each NNA-projected child in
  the Context pane now opens its own transcript directly, without leaving the
  active workspace. This uses the same session pointer as the navigator; the
  child transcript's steer control still requires NNA authorization. Adversarial
  review caught compact layouts retaining the foreground Context pane; the
  handoff now returns to chat there so the transcript is actually visible.

- 2026-09-28 · **Session pins.** The sidebar can pin/unpin a session with a
  visible marker; runtime/workspace-scoped pins persist locally and remain
  reachable beyond the 50-recent-session cap without disrupting lifecycle
  ordering or delegated hierarchy. Deletion clears the pin. Adversarial review
  caught and fixed the undefined-directory global-session case. The conflicting
  pinned-first language in the earlier ordering plan was reconciled with the
  explicit no-reorder interaction rule in doc 05 §D.12.

- 2026-09-28 · **Live delegated activity in the session navigator.** A child
  row now shows a short label from NNA's enumerated turn phase (for example,
  using a tool or waiting for a model). Attention and failure remain more
  prominent; idle, absent, or malformed phase data yields no guessed activity.
  The same selector powers Context, so the two surfaces agree. Adversarial
  review traced completion and recovery and found no concrete defect.

- 2026-09-28 · **Delegated-session navigator hierarchy.** Recent child
  sessions now appear beneath their NNA-known parent even when that older
  parent falls beyond the sidebar's recent-row cap. A child follows its
  parent's folder for presentation without mutating folder membership; the
  NNA-projected agent label is visible on the row. Missing-parent subtrees
  remain discoverable in an explicit unavailable group, including within a
  directly filed folder. Search does not mistake a filtered-out parent for a
  missing one. Adversarial review fixed inherited Unfile controls and filed
  missing-parent placement; tests cover nested and cyclic relationships.

- 2026-09-28 · **Readable chat at the compact/docked boundary.** The operator
  rail and chat column now share a 1100-pixel breakpoint instead of docking at
  1024 pixels, where the minimum 280-pixel pane could leave less than 480
  pixels for chat beside the 288-pixel session list. Below 1100 pixels the
  surface opens full-width with a return-to-chat control; at the boundary the
  dock leaves at least 491 pixels for chat. The responsive classes, focus
  handoff, and resize affordance switch together. Adversarial review found no
  concrete defect; 1120 UI tests and the production CSS build pass.

- 2026-09-28 · **Responsive operator panel width.** Installed desktop
  inspection found a previously saved 300-pixel Context pane cramping NNA
  route and governance rows on an ultrawide display. Untouched pane widths
  now follow the viewport without being saved as deliberate preferences, and
  the title bar has a Fit control that clears only the current pane's override.
  Manual resize remains per runtime/workspace/surface. Adversarial review
  fixed Fit-after-narrow-window restoration and a drag-back-to-start miss.

- 2026-09-28 · **Child transcript header.** A delegated session now shows
  its NNA-projected title and agent identity above the transcript, with the
  capability-gated steering toggle there instead of in a substitute bottom
  composer. A known parent has a one-click return action; an unavailable
  parent is labelled without a misleading link. The review preserved access
  to the child transcript and operator rail when the parent composer was in
  expanded focus mode.

- 2026-09-28 · **Local skill read discovery.** The capability surface now has
  read-only `.claude`/`.agents` skill list and detail APIs. The server honors
  external/runtime disabling, dedupes colliding names in the planned scan
  order, and parses only the opening frontmatter. Project skills are not
  marked renamable until managed-root CRUD exists; agents roots, caches,
  configured paths, built-ins, ancestor traversal, CRUD, and UI wiring remain.

- 2026-09-28 · **Gated agent memory stores.** Agent-owned global and project
  homes now support panel read/patch/delete through dual-run gates. The store
  keeps creation dedupe, per-scope capacity, newest-first capped projection,
  atomic writes, and re-derived injection flags out of durable form. Full-store
  errors name existing titles and an existing-title save can consolidate.
  Tool callbacks, directory scope resolution, session delivery, and Memory UI
  remain.

- 2026-09-28 · **Memory ownership and panel.** Session directories can map to
  project or managed-chats memory owners before storage access, with
  unregistered paths using digest-scoped stores instead of inheriting a
  registered repository store. The Context rail adds a scoped Memory panel for
  user edit/forget, including failed-scope and injection warning states;
  agent-created memory still waits on the managed tool.

- 2026-09-28 · **Memory callback and change stream.** A token-protected
  private callback dispatches four memory actions through the canonical
  owner mapper; title-only session projection and
  `notnative:agent-memory-changed` are available. NNA plugin launch and
  session-knowledge delivery remain.

- 2026-09-28 · **Guarded Files saves.** The editor now sends its original file
  content as a write precondition. The server compares it immediately before
  replacement and returns a typed conflict if another writer changed, removed,
  or made the target unverifiable; the UI keeps the draft, pauses auto-save,
  and requires review before an explicit overwrite. The adversarial audit
  also prevented overlapping saves, temporary-file collisions, and stale
  save completions from modifying a newly selected file. The compare/rename
  boundary is synchronous within NND, but cannot exclude an unrelated OS
  process writing at that exact instant.

- 2026-09-28 · **Runtime switch subscriber reset.** Switching NNA endpoints now
  notifies the registered session engine, auth gate, settings, and theme
  consumers after the new endpoint is active and before the DOM view-change
  event can unmount them. One failing subscriber cannot suppress the others;
  tests cover fan-out, unsubscribe, and ordering. This prevents stale
  cross-runtime state when changing connected instances.

- 2026-09-28 · **Files draft continuity.** Dirty editor text now has an
  in-memory lease scoped to runtime, workspace, and path, surviving navigation
  away from the full Files view and return within the same app run. Recovery
  pauses auto-save, verifies both file metadata and fresh baseline content,
  and requires an explicit two-step overwrite when the disk cannot be proven
  unchanged. Failed discard/reload preserves the draft; runtime/workspace
  switches remount the editor instead of reusing another scope's text. This
  does not persist drafts across app restarts or make filesystem writes atomic
  against simultaneous external writers.

- 2026-09-28 · **Installed NNA startup recovery.** A first-launch NNA child
  exit was observed after install while a subsequent launch succeeded. The
  managed desktop now makes one bounded retry only for exit-before-readiness,
  surfaces a sanitized NNA diagnostic code or exit status if the retry fails,
  and retains its child error listener after readiness so a shutdown error
  cannot crash the Electron host. The cause of the initial exit remains
  unconfirmed; persistent configuration failures still stop startup.

- 2026-09-28 · **Files inspection beside chat.** Added a read-only Files
  operator pane with searchable tree, bounded text preview, binary/oversize
  fallback, and an explicit handoff to the full editor. The pane retains its
  selection across surface switches and defers file reads and pending search
  while hidden. A successful root-list retry now clears its stale error.
  User confirmed typing works in the installed v20260928-3 desktop composer.

- 2026-09-28 · **Worktrees in the operator rail.** The existing live worktree
  manager now has a docked presentation beside chat. Its create form stays
  mounted across rail-surface switches within the same workspace;
  the full-screen modal entry point remains available. Existing saved rail
  layouts discover the new icon, and hiding its form releases keyboard focus.

- 2026-09-28 · **Commit draft continuity.** Changes commit text now survives
  switching workspaces and opening the full Git view during the same app run.
  Drafts stay in memory, are isolated by runtime/workspace, and a completed
  commit cannot erase text revised while its request was in flight. Rejected
  commit requests now show an error while retaining the draft for retry.

- 2026-09-28 · **Changes pane continuity.** Once opened, the Changes workbench
  stays mounted while another operator surface is foregrounded. Its selected
  diff and unsubmitted commit text survive a surface switch, while Git polling
  pauses when hidden. The retained instance is runtime/workspace-scoped.
  Adversarial review prevented an old Activity-to-Changes review request from
  replaying after switching away from and back to a workspace.

- 2026-09-27 · **Operator rail workspace continuity.** The open/closed state
  of the right-side pane now follows its workspace and runtime, alongside the
  existing selected surface and saved width. Returning to a workspace restores
  the operator's deliberate choice without carrying another workspace's state.
  Adversarial review prevented a viewport-derived default from being silently
  stored as a user preference.

- 2026-09-27 · **Activity history states and recovery.** The logs-style rail
  now distinguishes no selected session, loading a saved NNA snapshot, a
  genuinely empty history, and unavailable history. A failed snapshot offers
  Retry while still displaying live evidence. Adversarial review corrected
  filtered empty states that could otherwise falsely say there were no
  failures or requests for attention before history had loaded.

- 2026-09-27 · **GUI expanded Context overview.** The maximized Context
  surface now centers its session summary and groups NNA-governed details in
  readable cards. It distinguishes estimated NNA context from provider-reported
  token use, labels message counts as loaded (because transcript history can
  be paged), and shows only available last-assistant token fields. Adversarial
  review prevented a mixed-source percentage from appearing beside an unknown
  NNA context limit.

- 2026-09-27 · **GUI operator-pane expansion.** The right-side Context,
  Activity, Changes, Notes, Browser, and Terminal surfaces can expand over the
  chat column for focused inspection and restore to their saved dock width.
  The surface stays selected and mounted across expansion. Adversarial review
  corrected a selected-icon click that could otherwise leave an opaque
  maximized icon strip over the chat.

- 2026-09-27 · **GUI workspace navigator.** The selected workspace remains
  visible in the sidebar before its first session. Project groups can fold
  without losing their new-session/folder actions; search temporarily reveals
  matching sessions in folded groups and folders without changing the saved
  fold state. Duplicate project basenames show path context. An adversarial
  audit corrected fold/search lifecycle and archived-directory normalization.

- 2026-09-27 · **PB-8 older transcript pages.** The chat transcript now
  exposes NNA's older-message cursor through a load-more control with retry,
  retains the viewport anchor when rows prepend, and keeps pagination state
  scoped to the selected session and store. NNA's companion route pages root
  history beyond its former 200-message display window and survives a child
  live-preview cursor settling into a completed message. Browser-level
  confirmation of this new control still needs a long real session; focused
  and integration tests cover the wire behavior.

- 2026-09-27 · **PB-7 installed GUI transcript hydration.** Installed-app
  visual QA exposed a session that stayed on its loading skeleton: the
  session-message loader was implemented but never called on chat navigation.
  The transcript now hydrates the selected session, shows a retry action when
  loading fails (including an empty cached bucket), and preserves already
  resolved empty sessions without repeat reads. Adversarial review added
  regression coverage for both failure and empty-session behavior. The Windows
  installer also now tolerates pnpm's non-fatal version-probe warning under
  PowerShell's strict error mode. Installed `20260927-5` GUI QA confirmed an
  existing transcript opens, Activity displays a failed-turn event, and the
  Context and Browser operator surfaces open from the right rail.
  Installer adversarial review also caught the missing-command case: a
  nonexistent `pnpm` could leave PowerShell's prior successful exit code
  unchanged, so preflight now checks command discovery explicitly.

- 2026-09-27 · **PB-6 local NNA bootstrap.** The source NND installers can
  offer to invoke the sibling NNA installer when NNA is absent. Non-interactive
  runs require an explicit opt-in flag; an invalid existing NNA is not silently
  replaced. NND verifies the new installation before touching its own tree.
  This development convenience does not define a distributable NNA download;
  NSIS remains gated until that path has equivalent bootstrap/registration.

- 2026-09-27 · **PB-5 NNA-first install prerequisite.** The NND installer
  discovers a usable NNA before changing the install tree and reports that NNA
  must be installed first when missing. The POSIX source installer now also
  registers and deactivates its package through the NNA CLI. The installed
  NND server process remains an internal module entrypoint, not a supported
  standalone product installation. The NSIS builder is gated until its EXE can
  implement the same NNA prerequisite or bootstrap and package registration.
  NNA-owned service supervision is pending.

- 2026-09-27 · **PB-4 browser ownership split.** The Windows installer
  verifies that the downloaded Electron executable launches and reports its
  embedded Chromium version after dependency
  installation. NND-owned NNA sessions expose only the visible `nnd_browser`
  tool when its browser callback is configured; they do not inherit NNA's
  Playwright browser. TUI/headless NNA continues to use Playwright regardless
  of whether NND is installed. A callback without a connected Electron
  controller returns an unavailable error; a standalone service started with
  the bridge disabled advertises no interactive browser tool. A persistent
  controller attachment seam remains work.

- 2026-09-26 · **PB-3 standalone installed-service entrypoint.** A validated
  installed NND package can run its built web server in Node without an
  Electron window, on explicit loopback port only. Stdout carries a bounded
  readiness frame while diagnostics go to stderr. The standalone path disables
  the NNA browser tool because no Electron guest/IPC controller exists; it
  must not advertise a capability that would time out. NNA supervision,
  shell attachment, and a remote browser bridge remain pending.

- 2026-09-26 · **PB-2 installed activation gate.** The scripted Electron
  installation identifies its root to the managed NNA child. NNA now checks
  the registered package's canonical root and current version/assets before
  starting that desktop integration; drift or deactivation refuses startup.
  Source/dev runs retain the pre-registration path. The web-service owner is
  still Electron, so independent NNA daemon supervision remains pending.

- 2026-09-26 · **PB-1 installed package registration.** NND's Windows installer
  writes a versioned NNA integration manifest after building and asks the
  co-installed NNA to validate/register the built server and web bundle.
  Uninstall deactivates the exact package before deleting it. NNA's status
  revalidates identity and version drift. This is metadata registration only:
  Electron still supervises the web service and local NNA child, so NNA-owned
  lifecycle, persistent browser door, LAN consent, and NND-first install
  reconciliation remain open MVP work.

- 2026-09-26 · **P11-23 staged/unstaged walkthrough scope.** All uncommitted,
  Staged, and Unstaged selection is carried through capture, freshness checks,
  and revision-bound model generation. Untracked files belong only to the
  Unstaged scope; switching scopes cannot reuse prior prose.
- 2026-09-26 · **P11-22 explicit walkthrough explanation.** The selected
  session can request a bounded model-only explanation of the current diff.
  NND checks session/workspace and revision before and after inference; only
  server-resolved hunk IDs survive model output normalization. Known
  sensitive paths are omitted, and the UI discloses model egress. Caching,
  source choices, and generation lifecycle remain follow-ups.
- 2026-09-26 · **P11-21 server-owned diff snapshot.** The Walkthrough pane
  consumes one authenticated, bounded working-tree snapshot with staged,
  working, and regular untracked changes. The server assigns content-derived
  hunk IDs and a revision signature; two captures must match or the request
  refuses as stale. Adversarial review corrected tracked symlinks, literal
  directory pathspecs, and incremental aggregate-size enforcement. Model
  explanations and non-working-tree sources remain follow-ups.
- 2026-09-26 · **P11-20 deterministic diff walkthrough foundation.** The
  right rail and Changes can open a user-invoked, local-only sequence of
  bounded real Git hunks with staged/working scope and file/line anchors.
  Full status/patch revision checks disclose staleness without replacing the
  reader's current stops; no model generation or remote send occurs. Narrative
  generation, richer source scopes, and the server cache remain P11 work.
- 2026-09-26 · **P11-19 freehand screenshot annotation.** The host-owned
  shield collects bounded multi-stroke drawings without page input. Explicit
  Use drawing and Add revalidate the guest/viewport, composite measured-ratio
  strokes onto a bounded screenshot, and append image plus structured text to
  the current draft without sending. Adversarial review fixed unrelated
  pointer-cancel and preview-resize failures. Installed Electron pointer
  routing still needs a GUI walkthrough.
- 2026-09-26 · **P11-18 user-drawn region annotation.**
  The host shield supports pointer-drag region selection beside element
  selection. A read-only guest verifies the page and viewport before a
  measured-ratio rectangle is composited onto a bounded screenshot. The
  comment and image enter the current composer draft atomically on explicit
  Add; nothing is sent automatically. Adversarial review fixed blur recovery
  and refusal after a mid-drag shield geometry change. Installed pointer
  routing remains subject to GUI walkthrough.
- 2026-09-26 · **P11-17 highlighted annotation screenshot.** Explicit Add
  revalidates the same guest, page and selected element, captures a bounded
  viewport JPEG, draws a measured-ratio highlight, and appends the image and
  structured text atomically to the current chat draft. Adversarial review
  fixed session-switch, consecutive-annotation, stale-element, and maximum
  text-boundary failures. Nothing is sent automatically; installed Electron
  pointer routing still needs a GUI walkthrough.
- 2026-09-26 · **P11-16 user element annotation draft.** A host-renderer
  pointer shield lets the user mark one element without delivering the click
  to the guest. A bounded comment appends labelled page context to the chat
  draft; it never auto-sends. Editable values are withheld, page labels are
  marked untrusted, and screenshot/region annotation remains pending. Installed
  Electron pointer routing still needs a GUI walkthrough.
- 2026-09-26 · **P11-15 governed browser history.** Back/forward uses the
  existing preview history only, with a fresh single-use page observation and
  an unsettled navigation receipt; replacement guest readiness gates the next
  snapshot. The installed NND↔NNA smoke passed.
- 2026-09-26 · **P11-14 bounded desktop-guest capture.** The governed NNA
  tool captures the exact observed guest viewport to a bounded JPEG in its
  managed session area and returns a path for `image_inspect`. This is not a
  remote-tab or arbitrary-script capture. A 256-file per-session quota preserves
  transcript-referenced images; global retention remains open. Annotation
  remains pending.

- 2026-09-26 · **P11-13 bounded exact-page typing.** The governed NNA
  browser tool can replace one visible text/search input or textarea on an
  exact observed page. Sensitive fields are excluded and the receipt omits
  typed content. A timed-out write blocks later observations until its guest
  script settles. Capture and annotation remain pending.

- 2026-09-26 · **P11-12 governed viewport scroll.** The NNA browser tool can
  scroll one observed page up, down, to top, or to bottom. The guest reports
  post-scroll position after two animation frames; stale pages and malformed
  readback fail explicitly. Type and capture remain pending.

- 2026-09-26 · **P11-11 exact-page click.** The governed NNA browser tool can
  activate one visible, enabled element only on the URL it observed. The
  receipt distinguishes activation from settled page effect and directs a
  fresh snapshot after uncertainty. Type/scroll/capture remain pending.

- 2026-09-26 · **P11-10 read-only element inspection.** The NNA browser tool
  can inspect computed styles and bounds for one CSS selector in the isolated
  desktop guest. Selector, result, and navigation are bounded and checked at
  each boundary. Agent page mutation is not enabled yet.

- 2026-09-26 · **P11-9 governed NNA browser tool.** The NND-owned NNA child
  can discover `nnd_browser` through its normal tool catalog and request
  governed browser open/snapshot actions through a private loopback callback.
  The callback uses the existing desktop broker and is absent in attach mode.
  Richer page actions and capture remain pending.

- 2026-09-26 · **P11-8 desktop browser-control bridge.** The Electron main
  frame now registers with the in-process broker through a narrow preload
  IPC face. The Browser pane can claim and answer open and read-only snapshot
  requests; unsupported actions answer explicitly. Guest pages cannot use the
  bridge. Adversarial review fixed hung/stale snapshots and registration
  cleanup across hide, reload, and renderer death. NNA has not yet been given
  a governed tool callback, so this remains an internal capability.

- 2026-09-26 · **P11-7 browser-control broker core.** NND now has a
  capability-aware in-process request broker with first-claim ownership,
  request-specific delivery, abort/timeout handling, and explicit uncertainty
  if a claimed mutating action loses its result. The requested adversarial
  review fixed claim/delivery races. It is not exposed to web clients or NNA
  yet; desktop IPC identity binding and the NNA tool are the next seam.

- 2026-09-26 · **P11-6 manual DOM snapshot.** The isolated desktop guest now
  has a user-triggered, read-only page summary with bounded visible text,
  interactive elements, and truncation counts. Input values stay out of the
  result; malformed guest results and stale navigation results are rejected.
  Adversarial review fixed stale same-URL inspections, unresolved-script busy
  state, and unbounded URL/title fields. This does not grant NNA browser control.

- 2026-09-26 · **P11-5 guest navigation lifecycle.** The desktop browser now
  follows in-page and top-level guest navigation in its address/history UI
  without remounting the page, distinguishes main-frame failure from aborted
  or subframe loads, and reports a crashed renderer. The requested adversarial
  review caught and fixed hidden-pane restoration after an in-guest
  navigation. Agent control remains unavailable.

- 2026-09-26 · **P11-4 isolated desktop guest preview.** The Electron
  Browser surface now hosts a Chromium `<webview>` in a nonpersistent
  `nnd-preview` partition, while browser/remote surfaces retain their
  sandboxed iframe. The shell strips guest preloads, forces Node off and
  context isolation/sandbox/web security on, denies guest permissions and
  popups, and blocks app-origin, non-HTTP(S), and non-loopback HTTP top-level
  requests. Renderer identity is exposed synchronously by preload before
  React boots. This is user-driven preview only: NNA agent control, capture,
  annotation, tunnels, and Chromium navigation tooling remain P11 work.
  Adversarial review fixed the NSIS file-list omission and a potential
  renderer-selected guest partition escape before attachment. Source gates,
  UI and web suites, and the unsigned Windows NSIS build passed; packaged
  Electron terminal and HTTP/WebSocket smoke checks passed, and the packaged
  ASAR contains the guest-policy module. Installed GUI rendering remains
  unverified.

- 2026-09-26 · **P10-13 opt-in legacy workspace copy.** The Workspace files
  disclosure now offers a scan/preview/confirm flow for its repo-local
  `general-notes.md` and `todos.json`. A bounded import route appends a note
  and normalized project todos under one project-context lock and one atomic
  context write. Deterministic source-derived IDs make retrying the same
  snapshot idempotent; conflicting reimports and malformed or oversized
  inputs fail without a partial import. The original files are never changed
  or deleted. Notes over 3,000 characters currently require manual handling;
  this is a safe common-case copy flow, not a claim that all legacy data is
  migrated. Session plans are not included. Adversarial review fixed a changed
  legacy note reimport that could have appended contradictory guidance, and
  made duplicate stored note IDs fail closed.

- 2026-09-26 · **P10-12 cross-tab search discovery.** A search query now
  loads a context snapshot and shows match counts for General note bodies,
  Todo text, and saved-plan titles. Count buttons navigate to the matching
  section. The snapshot can be refreshed explicitly, and a failed count
  read is shown as unavailable rather than zero. Per-tab display filtering
  and mutations remain tied to each section's own current context read;
  counts are labelled as a snapshot, not live authority. Adversarial review
  aligned counts with the rows each section can actually display when stored
  context contains malformed entries.

- 2026-09-26 · **P10-11 project-context list search.** The canonical Notes
  rail has one query for project-owned note bodies, todo text, and saved-plan
  titles. Each tab filters only its visible rows; todo mutations still submit
  the complete list, and note/plan drafts remain intact across query changes.
  The query does not search plan markdown bodies or legacy workspace files,
  and it does not create NNA prompt context. Cross-tab counts and unified
  loading remain future work. Adversarial review found and fixed a misleading
  search control on the legacy Workspace files tabs.

- 2026-09-26 · **P10-10 canonical Notes rail.** For a resolved NNA project,
  General, Todos, and Plans now open the project-owned context records by
  default. Existing repo-local note/todo files and the session plan remain
  accessible behind an explicit Workspace files disclosure, with no implicit
  migration or background legacy read. An unresolved owner retains the old
  three workspace-file tabs. Per-project drafts remain keyed to the project;
  adversarial audit and full UI tests passed. Safe migration and shared-plan
  ownership remain open.

- 2026-09-26 · **P10-9 todo panel refresh recovery.** If the operator hides
  and reopens the project-todo panel while a save is pending, the committing
  write now clears the loading state of any refresh it supersedes. Adversarial
  review also found and fixed a stale load-error banner after a successful
  write. Both interleavings have regression tests; no draft or committed list
  is dropped.

- 2026-09-26 · **P10-8 project-todo conflict guard.** Context GET now includes
  a revision of the todo list. The public whole-list PUT requires that revision
  and compares it under the project write lock; a stale client gets 409 without
  erasing another window's changes. The rail retains the draft and last saved
  list, blocks another write, and asks the operator to refresh. Unrelated
  note/plan writes do not invalidate a todo revision. Full UI/web tests and
  adversarial review passed. Legacy repo-local todos and canonical ownership
  consolidation remain open.

- 2026-09-26 · **P12 installed-path hardening.** Source installation now skips
  the top-level pnpm cache, bounds copy retries, and refuses source-overlapping
  install/uninstall targets. The current script-installed NND shell launched,
  but its managed NNA child could not boot because installed NNA predates the
  `nnd serve` command; installed NNA update awaits user approval.

- 2026-09-26 · **P10-7 additive project-context todos.** The rail exposes
  project-owned todos independently from the legacy repo-local file and NNA
  session tasks. Writes adopt committed context; malformed stored lists block
  editing, and route validation rejects invalid whole-list replacements.
  Legacy-file migration and cross-client conflict handling remain open.
- 2026-09-26 · **P10-6 additive saved-plans UI.** The operator rail now has a
  project-owned Saved plans tab alongside the older session PlanView. It
  lists context manifest entries and uses NND routes for create, raw markdown
  edit, and delete; unsaved editor text is retained by project. Adversarial
  review and release validation are in progress.

- 2026-09-26 · **P10-5 bounded legacy plan migration.** First read of a
  legacy absolute plan-link list now copies markdown from within NND's
  projects data root into context-owned plan storage, commits `context.json`,
  then removes the legacy keys from project config. The migration serializes
  with config/context writers and is repeatable after an interrupted copy.
  Out-of-store absolute links fail closed rather than granting arbitrary
  local-file read through the GUI. Adversarial review and release validation
  are in progress.

- 2026-09-26 · **P10-4 personal plan CRUD.** Context-owned markdown files and
  manifest records now have create/read/raw-update/delete routes. Create
  writes the file before its manifest; delete reverses that order to avoid a
  dangling visible link. File names are generated base names, not caller
  paths, and a missing target is not recreated by update. Adversarial review
  fixed raw-byte alteration, duplicate/case-colliding manifest links,
  linked-path escape, and multiline-title injection. Legacy plan links still
  require migration; release validation is in progress.

- 2026-09-26 · **P10-3 additive context notes panel.** An NNA project
  resolved from the live roster now exposes NND-owned notes as a separate
  operator-rail tab. The client API throws on failed or malformed reads and
  the panel adopts committed note mutations while preserving unsaved drafts
  after failures and project switches. Repo-local General notes/Todos remain
  visible until a safe migration can replace them. Adversarial review fixed
  stale refresh overwrite, endless initial loading, lost drafts, and
  ambiguous owner/data-warning cases.

- 2026-09-26 · **P11-3 browser startup wait.** A user-selected loopback
  preview under a loopback app origin waits for the bounded readiness probe
  before mounting its iframe; it retries for up to 30 seconds, holding a
  gateway 5xx for at most 20 seconds, then offers an explicit Retry. Remote/
  LAN viewers continue direct navigation because their `localhost` does not
  refer to the NND host. Adversarial review fixed stale readiness across
  hiding/history changes, a hanging probe, and premature 5xx rendering.

- 2026-09-26 · **P10-2 note lifecycle API.** Bounded note create, patch, and
  delete routes now mutate the isolated context file under the project lock,
  enforce body and count limits, and preserve unrelated context fields. The
  adversarial review corrected malformed-origin responses from 500 to 400;
  the UI and session pin/attachment flow remain separate P10 work.

- 2026-09-26 · **P10-1 project-context ownership boundary.** The existing
  context GET and todo PUT now read/write a separate per-project `context.json`
  under a shared project write lock. Legacy note/todo arrays seed it without
  overwriting project configuration; malformed or ambiguous data fails visibly
  instead of becoming an empty panel. Legacy plan-file links fail closed until
  their copy-in migration is built. The config-lock promise queue no longer
  emits an unhandled rejection for an expected write failure. This is a
  backend boundary only: notes/plans CRUD and UI adoption remain P10 work.

- 2026-09-26 · **Goal ID collision hardening.** A full web run observed one
  duplicate among 200 same-timestamp goal IDs because the implementation
  truncated eight random bytes to six hexadecimal digits (24 bits). Goal IDs
  now retain all 16 hexadecimal digits (64 bits); NNA accepts the longer
  opaque IDs, and persisted legacy IDs still parse. Adversarial review found
  no compatibility defect and updated the doc-12 example.

- 2026-09-26 · **P11-2 loopback preview readiness probe.** The auth-gated
  `POST /api/system/probe-url` route now accepts only credential-free loopback
  HTTP(S) URLs, bounds the GET to 1500 ms, does not follow redirects, and
  reports a gateway 5xx as an answering server rather than a transport
  failure. Adversarial review found no concrete defect. The iframe has not
  yet adopted startup waiting; that remains with P11's browser lifecycle.

- 2026-09-26 · **P11-1 live dev-server discovery.** The browser empty state
  offers actual Windows TCP listeners from a bounded `netstat` scan through an
  authenticated NND route, with 3 s success cache and honest 503 failures.
  It excludes app/NNA-owned and known infrastructure ports, refreshes while
  visible, and requires an explicit click to navigate. Remote/LAN viewers do
  not receive host-local `localhost` suggestions until the preview tunnel is
  built. Adversarial review fixed five concrete discovery/UX failures;
  non-Windows discovery and Chromium inspection remain later P11 slices.

- 2026-09-26 · **Node source-launch and release gate repair.** The root
  `start`, dev launcher, smoke command, web-package `start`, and CLI detached
  auto-start now opt into Node's TypeScript transformation for the server's
  parameter properties. The release gate launches its smoke child the same
  way; `smoke:test` and the CLI auto-start regression pass. Adversarial review
  found the two missed launch paths before this slice was sealed.

- 2026-09-26 · **P9 live goal gate recovery.** A profile settings write now
  wakes or stops the NNA goal runtime without requiring an unrelated session
  event. A separate exchange generation keeps the runtime's own goal CAS
  events from cancelling a valid audit, while disable/delete/busy transitions
  fence further writes and continuation sends. Only a known local pre-send
  refusal receives exact-revision CAS recovery and a resume marker; uncertain
  remote send outcomes are never retried automatically. Adversarial review
  traced and fixed the pre-slot and post-slot liveness races. The guarded
  callback passes the real NND↔NNA SSE smoke; web 930/930 and typecheck ×3.

- 2026-09-26 · **P9 event-driven autonomous-goal smoke.** An isolated real
  NNA child now drives the production NND event feed and goal safety timer
  through the complete audit/continuation loop. The probe verifies the live
  idle SSE event, two independent provider audits, one continuation, and the
  persisted complete verdict. Adversarial review tightened the probe so it
  cannot pass using requests from an earlier direct-loop test or a reconnect.

- 2026-09-26 · **P9 live autonomous-goal loop smoke.** The cross-repo
  source fixture now drives the production NND goal tick and audit exchange
  over a real NNA child with an isolated provider: an initial turn is audited,
  a CAS consumes one continuation slot, the continuation runs, and a second
  audit persists `complete` with provider/model attribution. This proves the
  core loop under controlled conditions; the event-timer/bootstrap path and
  external-provider behavior remain separate validation work.

- 2026-09-26 · **P9 snippet delete race hardening.** On Windows, a
  concurrent delete or file-sharing probe can raise `EPERM` between the
  existence check and unlink. The snippet store now re-probes and retries
  once: an already-gone target returns the not-found result, while a
  still-present permission failure remains an error. Adversarial review
  found no additional concrete defect. Focused route tests cover gone,
  transient, and persistent sharing violations.

- 2026-09-26 · **P9 goal audit bridge and long scheduled-objective fitting.**
  The authenticated NND↔NNA source smoke now exercises a real completed turn,
  its final provider affinity, the independent goal-audit route, and a stale
  revision refusal. The smoke runner enables Node type transformation for
  the existing TypeScript server entrypoint. Scheduled long objectives pass
  through the B.6.3 fit contract: bounded small-model distillation when a
  port is supplied, otherwise a 4,000-character head/tail excerpt with a
  visible trim marker; the full prompt remains in the chat message. The
  production distillation port is not yet bound, and a full autonomous
  audit-to-continuation run remains to be verified. Adversarial review fixed
  whitespace-only distillation output and found no defect in the smoke seam.

- 2026-09-26 · **P9-4e-ii the snippet UI half.** The composer's `#`
  picker rides the shared roster now: `snippets-source.ts` replaces the
  empty map (wholesale-visible loads, never-rejecting refresh that
  keeps the roster on refusals and hostile 200 bodies), the composer
  refreshes once per mount and inserts over the latest text, and the
  scheduled editor's `#` source rides the same roster (E-09-28 (d)
  parity held). The settings window gained a real Snippets page (the
  placeholder path is gone for the slug): roster management over the
  P9-4e-i family with the byte-equal name guard, inline text edits,
  deletes, and a refresh button, every change republishing the shared
  roster so composer stays in sync without a reload. The audit carried
  the E-09-28 (i) flag home and reproduced the composer's mention-merge
  guard as a per-render no-op (the token counter re-initialized every
  render — late responses compared 1 against themselves and the
  checker never fired); fixed with a cross-render ref, the span+kind
  guard at editor parity, and a pickerRef clear on insert, plus three
  red-then-green composer pins (late-token stall, kind swap, dead-entry
  resurrection). A hostile 200 without the roster array folded into an
  unhandled rejection (fulfilment-handler throws bypass the sibling
  catch) — guarded at the source and folded to the alert line on the
  page. Registered: the textRef render-currency posture, the one-Composer
  refresh count, snapshot-at-open on both picker surfaces, the row
  lifecycle constraints, and the unscape-checked-200 consumer rule.
  Composer pins 5/5, page 9/9, source 4/4, editor 19/19, window 26/26;
  UI 102 files/932, web 66/913 re-verified, typechecks clean, gates
  426 files, graph 426 modules. E-09-30..35. Next: the B.6.3 distill,
  then the P9 wrap.

- 2026-09-26 · **P9-4e-i the snippet config-entity family.** The server
  half of the snippet macro resolver landed: the `snippet-store.ts`
  (`<data-dir>/config/snippets/<name>.json`, names `[\w-]{1,64}`,
  `scope: 'global'` default, tmp+rename writes, corrupt-file skipping;
  expansion `#([\w-]+)` keep-unknown), the route family per doc 03
  §5.x verbatim (list/create/read/patch/delete plus the `POST /expand`
  route registered before the `:name` POST so the reserved word never
  shadows creation), mounted before the harness proxy, and the typed
  client `lib/snippets-api.ts` mirroring the ok-stamp envelope. The
  audit reproduced and fixed three Windows-grounded defects: case
  folding made a cross-case URL retitle (destroy) a stored snippet's
  identity (fixed: lookups resolve the stored entry's own case, never
  retitle, responses carry the stored name), reserved device names
  (`aux`, `com1`...) would have crashed stores on enforcement volumes
  (fixed: a platform-independent 400 before any store access), and a
  lost-race DELETE surfaced ENOENT (fixed: folds to the 404 arm).
  Registered: exact-case expansion keys, PATCH null-is-not-absent,
  single-decode traversal answers, content-type-agnostic bounded
  reader, `#([\w-]+)` parity with the composer's expansion. Routes
  19/19 (11 slice + 8 audit), client 4/4, web 66 files/913, UI 99
  files/913, typechecks both clean, gates 423 files, graph current.
  E-09-29 registers the slice. Next: P9-4e-ii — the composer picker
  source fed from the family plus the settings management page —
  then the B.6.3 distill.

- 2026-09-26 · **P9-4d-ii the editor dialog.** The scheduled-task editor
  is complete: the dialog shell (name, the schedule half with the client
  preview and §J.1 preference, save through upsert with create seeding
  the first catalog pair and PUTting with no state key, edit riding
  id/state/loopFile/unknowns, variant surviving only a kept pair, goal
  off dropping both goal fields), the execution half (catalog-fed model
  select with the unlisted-pair prepend, agent select, the prompt
  textarea riding the composer's autocomplete primitives with the
  latest-document insert rule, goal budget, auto-accept), and the
  tasks-dialog entry points gated on services ('+ new', per-row task
  edit, nested editor, list refresh after save; the list hook returns
  refresh now). The audit reproduced the '@' swap hole (a mid-pending
  '# ma' retyping could have repopulated the picker from a stale
  mention search and bound a kind-mismatched insert; fixed with the
  span+kind merge guard) and registered the snapshot governance (open
  snapshot + user edits, last-writer-wins, no optimistic concurrency),
  the raw-prompt storage, and the services store no-throw reality;
  carried a flagged composer follow-up (same hole without the kind
  check). Editor suite 18/18, dialog 20/20, UI 98 files / 909 tests,
  typecheck, gates (420 files), graph (420 modules). E-09-28 registers
  the slice. Next: the snippet macro resolver, then B.6.3 distill.

- 2026-09-26 · **P9-4d-i the schedule editor half.** The editor's
  schedule machinery: `schedule-form.ts` pure helpers (30-minute pill
  catalogue, preference-rendered pill labels, locale-first-day weekday
  chips over Intl weekInfo, zone choices, kind-seeded drafts, cron shape
  heuristics + example chips, never-emptying membership toggles, the
  schedule summary moved from the dialog, preview lines pairing the
  viewer stamp with the wall time inside the schedule zone) and
  `scheduled-task-schedule-editor.tsx` (kind tabs reseeding in the same
  zone, the zone select with the unlisted-zone option, pills/chips,
  once date/time inputs, the cron input with client-shape hint against
  example chips, and the sequence-guarded debounced next-runs preview
  riding the E-09-26 route). The audit reproduced the once-date seed
  showing zone-today at +14 offsets (fixed: zone-local wall tomorrow
  via the en-CA formatter) and pinned the browsers' weekInfo reality on
  all shipped locales, preview generation drops (stale + post-unmount),
  the unlisted-zone option collapse, and the preview-still-fires rule
  for client-failing cron shapes. Editor suite 21/21, dialog 20/20, UI
  97 files / 891 tests, typecheck, gates (418 files), graph (418
  modules). E-09-27 registers the machinery. Next: P9-4d-ii the
  execution half + dialog integration + Edit button + autocompletes.

- 2026-09-26 · **P9-4c-i the schedule preview machinery.** The editor
  surface needs "what will this schedule arm" before the task exists:
  `POST /api/openchamber/scheduled-tasks/preview` iterates the armer's
  own `computeNextRunAt` over a draft schedule (cursor = last + 1, the
  same claim-cursor shape the runtime uses, same 5 s due-slack), so
  previewed = armed by construction. Invalid drafts answer 200 with the
  collected prefix (the UI will render "unavailable"); only body/schedule
  shape errors are 400s; `count` clamps to 1..4 (default 4); `from` is
  honored only inside the year-9999 epoch window and folds to now beyond
  it. The audit reproduced two 500 classes on the pristine slice (hostile
  non-array `times`/`weekdays` escaping the compute branches; extreme
  finite `from` hitting Intl RangeError at the JS Date-range edge) and
  fixed both at the sanctioned layers (next-run branch guards; the
  route's `PREVIEW_EPOCH_MAX` fold), added the true-bytes daily pin the
  invariants-only test could not provide, and decided the client
  passes options through unclamped (server = sole validation authority).
  `previewNextRuns` in the typed client rides the E-09-24 envelope rule.
  Web 65 files / 894 tests (preview suite 10/10), UI 96 files / 870
  (client 20/20), typechecks, gates (416 files), graph (416 modules).
  E-09-26 registers the posture. Next: P9-4d the editor dialog.

- 2026-09-26 · **P9-4b the scheduled-tasks dialog.** The §H surface came
  alive in `components/scheduled`: the dialog (project selector riding
  the active directory's project, schedule summaries
  `daily/weekly/once/cron (+ tz)`, viewer-zone next/last run stamps,
  lastStatus badges), the toggle/delete split by ownership (loop tasks
  mutate their `.agents/loops` file through the PATCH route, plain tasks
  upsert; the loop delete confirms in-row because it removes the file
  and reconcile prunes the task), run-now with outcome-differentiated
  toasts (including the 200 `ok:false` errored-run body), and the
  loop-file editor handoff into FilesView. The C.10 control fanout got
  its first UI consumer: a `scheduled-task-ran` frame refreshes the open
  project's list through `useTaskRanFanout`. The hook keeps a
  view-ownership guard so slow loads of a previous project or frames
  through cancelled-but-pending subscriptions paint nothing stale
  (audit-reproduced), and the editor handoff targets the ACTIVE editor
  root, never the selected worktree (audit-reproduced). Shell wiring:
  `nnd:scheduled-tasks-open` + `nnd:files-open` window events, a
  `◷ tasks` header button, the dialog mount, and the FilesView
  tab-selection bridge in MainLayout. 20/20 dialog pins (96 files /
  865 tests UI-wide), typecheck, gates (416 source files), graph (416
  modules). E-09-25 registers the posture. Next: P9-4c the editor dialog
  (kind tabs, time pills, weekday chips, cron preview, IANA zone select,
  model/agent, prompt autocompletes, goal + auto-accept toggles).
- 2026-09-26 · **P9-4a scheduled-task UI data plane.** The typed §5.16
  client landed in `packages/ui/src/lib/scheduled-tasks-api.ts` — list/
  upsert/delete, loop-file PATCH/DELETE, manual run, scheduler status,
  plus `parseTaskRunEvent` for the C.10 control fanout — with the §C.1
  wire types mirrored locally and every failure folded into
  `{ok:false,status,error}` preserving the server's message. 20 tests
  (15 client + 5 through the REAL runtimeFetch transport) pin URL/method/
  body bytes incl. `%3A`/`%2F` id encodings (empirically verified
  against the real Hono router), the bare-task PUT vs `{task}` PATCH
  envelope asymmetry, the body-owned `ok:false` of an
  errored-but-completed 200 run (the audit caught a stamp that would
  have shown failed runs as successes), and the state-optional create
  input. E-09-24 registers the seam. UI suite 845/845 (95 files),
  typecheck, gates (413 source files), graph (413 modules). Next:
  P9-4b the ScheduledTasksDialog + entry point + live refresh, then
  P9-4c the editor dialog.
- 2026-09-26 · **P9 loop files + the scheduled-task route surface.** C.8
  `.agents/loops` files now drive tasks: `scheduled/loops.ts` (cron-only
  frontmatter, `enabled` defaulting FALSE, model split on the first
  slash, user/project scope shadowing with nearest-ancestor preference,
  the enabled-fence rewrite) and the locked `reconcileLoopTasks` in
  `task-config.ts` (revive/adopt/rename/keep-last-good/prune, run before
  every store read in `syncProject`). The doc 03 §5.16 route family
  landed in `routes/scheduled-tasks.ts` — list, upsert, delete, loop-file
  PATCH/DELETE (the file mutations), run-now, scheduler status — with
  loop-ownership gates on the general task routes, the 400/409 run-now
  mapping, and the `{running, queued, tasks}` status snapshot;
  `scheduled-service.ts` grew the optional `loopsFor`/`reconcileLoops`
  runtime ports over the harness tree. `routes/projects.ts`'s per-project
  config PUT no longer clobbers the managed `scheduledTasks` key. E-09-23 registers the NND mappings (project 400/404 semantics,
  id-legal names, zone/agent leniency, adoption-vs-rename identity,
  remove-as-orphan-prune, run-now mapping, status shape) and the settings
  config PUT now rides the per-project write lock with `scheduledTasks`
  preserved (C.9 discipline widened to the settings family; the P4-2
  todos PUT got the same lock). 29-test loops+routes suites plus a
  20-test audit regression file green; web 884/884 (64 files), typecheck,
  gates, graph (412 modules); adversarial review reproduced and fixed 6
  defect classes (adopted-id re-key churn on every sync, discovery-blind
  upsert gates on the id and file axes, unlocked config/todos
  read-modify-writes that could revert store patches, CRLF-to-LF churn in
  the enabled rewrite, plus the outright missing todos lock) with pins.
  Next: UI listeners + the API client + the scheduled dialogs
  (ScheduledTasksDialog/ScheduledTaskEditorDialog/scheduledTasksApi),
  snippet macro resolution, the B.6.3 distill call.
- 2026-09-26 · **P9 scheduled-task run pipeline on NNA.** The scheduled
  runtime's injected `runPipeline` port now has the real C.6 adapter behind
  it: `scheduled-pipeline.ts` (session create with the slot-zone wall-clock
  title, running event, B.7 goal planting with fresh-revision tolerance,
  slash resolution riding the queue's B.8 helpers, plain prompt parts in
  the knowledge -> prompt -> goal-intro order, warn-only auxiliary
  failures), `nna-scheduled-ports.ts` (production harness ports over
  `harnessRequest` + the 10 s/250 ms ready poll on `GET /command`), and
  `scheduled-service.ts` (lazy singleton over the P9-3a store ports,
  project enumeration, C.10 fanout as `notnative:scheduled-task-ran` with
  the `sessionId` wire name, boot + dispose wiring). Run errors stay with
  the runtime (missing worktree, blank session id, rejected dispatch);
  everything auxiliary degrades with a warning. 18-test pipeline suite
  green; web 835/835 (61 files), typecheck, gates (410 modules), graph;
  adversarial review reproduced and fixed 4 defects (blank knowledge
  recorded delivered though nothing sent, silent objective-store
  refusal, unattributed objective-file warn, intro budget sentence
  disagreeing with the payload's budget range). Next: P9-3d loop files
  + routes/SSE + manual-run 400/409 mapping + the settings-route
  `scheduledTasks` clobber fix.
- 2026-09-29 · **P9-3e scheduler clock-edge proof.**
  Timezone work and timer recursion are now documented and pinned: schedule
  occurrences use the selected IANA zone and absolute Epoch; spring gaps skip;
  fall-back repeats fold to their first instant; cron offsets follow
  cron-parser; long waits re-arm at the setTimeout cap without firing early;
  and startup skips a daily slot already missed instead of running it late.

- 2026-09-25 · **P9 scheduled-task runtime, claiming, completion.** The
  execution machine over the P9-3a store now actually runs tasks: the
  injected-pipeline runtime (`scheduled-ports` contracts, `scheduled-state`
  memory/timers/queue/slots, `scheduled-run` claim+watchdog+completion as
  standalone functions, `scheduled-claims` patch builders,
  `scheduled-runtime` composition) syncs projects on start (one unreadable
  project logs and skips, vanished projects shed timers), arms due timers
  carrying their exact slot (past slots never re-armed; overflow re-arms
  recursively at the setTimeout cap), and drives the FIFO queue under
  global 4 / per-project 2 slots. A due task CLAIMS its occurrence in the
  shared config (`patchIf`, 5 s slack on `lastScheduledFor`) before any
  dispatch — a sibling claim adopts the winner's task and re-arms from its
  slot; the claim itself advances `nextRunAt` so a mid-run crash cannot
  double-fire. The watchdog races the pipeline at 30 min default (timeout
  records the error, the session keeps running; a pipeline rejection is an
  error run, never silence). Completion consumes one-time tasks, writes the
  terminal patch with exactly one retry (double failure falls back to the
  in-memory terminal state + re-arm), and emits the C.7 event. Manual
  `runNow` refuses busy/capacity, never claims, runs paused tasks. 23-test
  runtime suite green; web 817/817 (60 files), ui 825/825 (93 files),
  typecheck, gates, graph; adversarial review reproduced and fixed 5
  defects (sync pipeline throw misclassified as claim failure, unguarded
  event emit, stop() timer resurrection via an inert latch, refused-claim
  memory adoption, fail-closed adopt normalization). Next: P9-3c wires the
  NNA harness behind `runPipeline` (C.6/C.10); P9-3d loop files +
  routes/SSE + the settings route's `scheduledTasks` clobber fix.
- 2026-09-25 · **P9 scheduled-task storage core.** The scheduled-tasks slice
  starts: the per-project task document (daily/weekly/once/cron schedules,
  execution with goal settings, runtime state) is stored in the existing
  project config JSON with unknown fields preserved verbatim at every level.
  Next-occurrence computation validates IANA zones through Intl (spring-
  forward gaps skip, fall-back repeats resolve to their first instant) and
  iterates cron with the newly registered cron-parser dependency, sharing the
  same call a future UI preview will use. Every write is an atomic whole-
  document rewrite under an in-process chain plus a cross-process `{pid, at}`
  file lock; state patches swap only the state object onto the raw stored
  record so a version-skewed sibling cannot strip fields; malformed configs
  are quarantined aside rather than overwritten. Adversarial review confirmed
  and fixed three defects before seal: a file-descriptor leak on every lock
  acquire, a state patch whose explicit `updatedAt: undefined` cleared the
  required field instead of falling back to now, and a dead cleanup comparison
  in the in-process chain map. It also registered the Lord Howe 30-minute
  fold resolving to the second occurrence, and the read-error/malformed
  conflation that quarantines unreadable-but-valid configs. Verification:
  794 web tests, 825 UI tests, typecheck, quality gates, 401-module graph.

- 2026-09-25 · **P9 goal continuation dispatch (send arming).** The goal loop
  now sends prompts: after a `continue` verdict or a skip-audit kick
  (aborted-turn re-kick, Resume), the exchange dispatches the verbatim
  continuation prompt as its last action — fresh re-read, loop-field
  coherence vs the persisted candidate, the 20-cap check (beyond: settle
  `blocked`/continuation limit, no send), a conversation-tail re-check
  against the tick's `tailId` (a newer message or an open reply refuses),
  one slot-consumption CAS (`turnsUsed+1`, `statusReason` cleared so a later
  cancel pauses a resumed goal), then a parts-only `prompt_async` submit.
  The body carries no model/agent/variant because NNA refuses per-prompt
  route overrides — its session-configured route governs (E-09-19). Refused
  or failed sends write nothing (no streak, no retry): the loop stays quiet
  and the next exchange re-decides from evidence. The UI auto-continuation
  label now states the live contract. Before: `continue` verdicts persisted
  accounting without ever continuing. Verification: 768 web tests, 825 UI
  tests, typecheck, quality gates, 396-module graph.

- 2026-09-25 · **P9 goal evaluator exchange (audit, no dispatch).** The
  safety runner's `ready` candidates are now consumed by an independent
  auditor exchange through NNA's authenticated, receipt-affinity-bound
  `goal-audit` route: NNA binds the call to the audited turn's final
  provider route (profile + model) and answers raw text; NND parses the
  bounded verdict, records the evaluation-route attribution, and settles or
  streaks through the id- and revision-guarded goal CAS. Verdicts follow
  doc 12 T3-T5: `complete` settles verified by audit, three consecutive
  `blocked` settle with the audit note, and the second consecutive audit
  failure/unavailability settles `progress audit unavailable` with the
  unadvanced cursor so the same turn is re-presented. Races (goal changed,
  stale evidence, busy seat) drop without streak writes; a pre-audit
  coherence guard refuses a tick whose candidate no longer matches the
  durable goal, so a user Pause/reactivate/budget edit inside the window
  can only refuse the loop, never be overwritten. `turnsUsed` stays
  untouched: sent continuations must consume the 20-cap slot at dispatch
  time (queued, E-09-18). Unattended prompts remain off; the
  auto-continuation-disabled label stays accurate. Adversarial review
  caught a mid-window goal edit surviving every runtime guard into the
  verdict write (a user's budget raise/reactivate would have been silently
  reverted); fixed with the pre-audit drop and regression coverage.
  Verification: 751 web tests, 824 UI tests, typecheck, quality gates,
  395-module graph, and the cross-repo source smoke now also proves the
  live audit wire (attributed receipt, raw audit answer on the same
  provider route, stale-revision conflict). Version: NND 20260925-73.

- 2026-09-25 · **P9 goal evaluator affinity.** NNA terminal records and
  owner-scoped goal evidence now retain bounded, non-secret provider profile
  and model IDs for the final route actually used by a turn, including
  fallbacks. This gives the forthcoming independent evaluator a same-provider
  target; missing legacy attribution must fail closed rather than pick a
  different default route. Adversarial review tightened both sides of the
  optional affinity contract to reject malformed IDs; NNA full check
  1566 pass/3 skip, NND web 725/725 and check passed. Versions:
  NNA 20260925-50, NND 20260925-72.

- 2026-09-25 · **P9 live goal safety runner.** A safety-only event runner now
  shares NND's existing NNA event feed and starts with the server when the
  NNA harness is selected. The profile setting gates all work, including
  existing in-flight ticks before they can start a CAS write. Startup/feed
  reconnect reconciles active goals; idle/update events arm quiet ticks;
  pause/delete/busy clears them. Adversarial review fixed Resume timer
  preemption and stale in-flight event races. It does not audit completion or
  send prompts; the UI's auto-continuation-disabled label remains accurate.
  Verification: 724 web tests, full typecheck/quality gates and 394-module
  graph pass.

- 2026-09-25 · **P9 NNA goal safety ports.** The tested production adapter now
  maps the pre-audit tick to authenticated NNA session/status/children/messages,
  owner-scoped evidence, revision-guarded goal writes and generation-keyed
  local objective reads. Review found NNA ignored the requested message-tail
  limit, so its harness route now validates and honors `?limit=1..200` without
  changing omitted-limit behavior. It is not booted yet; unattended dispatch
  remains off. Verification: 713 web tests, full typecheck/quality gates and
  393-module graph pass; NNA full suite 1,565 pass / 3 skip / 0 fail.

- 2026-09-25 · **P9 pre-audit NNA safety tick.** A testable server tick now
  waits for authoritative root/child idleness, an available objective and
  safe receipt evidence; it can CAS-settle hard stops after re-reading goal
  identity and revision. Adversarial review fixed a stalled Resume after a
  cancelled turn with no assistant output and objective unavailability
  suppressing hard stops. It does not yet send unattended prompts. Event
  timers, production adapter, NNA auditor and dispatch remain pending.
  Verification: 710 web tests, full typecheck/quality gates and 392-module
  graph pass.

- 2026-09-25 · **P9 goal audit contract.** NND now bounds and escapes the
  objective/latest-assistant prompt sent to a future independent evaluator,
  and parses a bounded JSON verdict with note/script safeguards. Adversarial
  review caught a mismatched-language note allowed by script present only
  beyond the prompt-visible text; fixed with regression coverage. NNA's
  session-scoped small-model port and the server tick remain pending; the
  contract alone does not turn on autonomous continuation. Verification:
  703 web tests, full typecheck/quality gates and 391-module graph pass.

- 2026-09-25 · **P9 NNA-native goal receipt decisions.** The web server now
  has a pure receipt-ordered decision core for token accounting, cancellation,
  failed/unknown outcomes, budget exhaustion and the 20-continuation cap.
  It refuses malformed or incomplete evidence rather than guessing token
  usage or skipping a lost cursor. The adversarial review fixed masked
  interruptions within receipt batches, a stalled explicit Resume and a
  missed committed-token floor. Verification: 698 web tests, server typecheck,
  390-module graph and full quality gates green. The event/tick runner, CAS persistence,
  evaluator and continuation dispatch remain pending; the UI still correctly
  says auto-continuation is not yet enabled.

- 2026-09-25 · **P9 NNA-native goal evidence.** NNA now projects a bounded,
  owner-scoped ordered window of safe turn receipts for goal accounting, with
  request ID, outcome, accounted token count and measurement class. NND seeds
  new goals' accounting cursor from the latest receipt, excluding pre-goal
  turns. The audit added a busy-turn arming guard and CAS ingress fence,
  complete truncation signals, valid request-ID parity and usage fallback.
  This replaces the incompatible OpenCode snapshot/lexicographic-ID
  assumptions for the NNA default. The tick that consumes the receipts is
  still pending; unknown usage and truncated windows must be handled there.

- 2026-09-25 · **P9 session-goal controls (pre-loop).** Root-session chat now has a
  goal strip and explicit manage panel behind `sessionGoalEnabled`: view the
  objective, status, progress note and token usage; set/edit a bounded objective
  and optional budget; pause, resume, mark complete, or clear. File-first
  objective staging uses the immutable key returned by NND, followed by NNA's
  id-and-revision CAS. A failed file stage falls back to inline objective text;
  stale metadata conflicts remove only the losing staged generation. The panel
  follows live NNA goal revisions. Adversarial review fixed stale status,
  delayed file reads overwriting edits, false post-CAS reload failures, and
  silent turn-stop failures. The panel explicitly labels auto-continuation as
  not yet enabled. Runtime ticks, send
  arming, schedules, and broad remote orphan-file quota remain pending.

- 2026-09-25 · **P9 objective-file API.** NND now has authenticated
  `PUT/GET/DELETE /api/goals/objective/:sessionId`, backed by atomic writes in its data
  directory. Session IDs and immutable generation keys are validated before filesystem
  access; content is trimmed and bounded to 5,000 characters, missing deletes are harmless,
  and a symlinked objective is refused on read. The key is stored in NNA goal metadata,
  preventing stale file-first edits from changing the winning objective. This enables live
  objective edits for the forthcoming autonomous tick;
  goal arming and the tick runtime are still pending.

- 2026-09-25 · **P9 goal persistence seam, NNA-native.** NNA now validates and
  durably stores one bounded goal per owned NND session, projects it as
  `metadata.nnd.goal`, and exposes a narrowly authorized, identity-and-revision-guarded goal
  route through NND's managed bridge. The NND goal core and write helper use
  this namespace and route shape rather than upstream generic metadata
  replacement. Integration and source smoke cover write/read/clear and
  restart recovery, same-id write conflicts, and failed-persistence rollback.
  An adversarial review caught the same-goal lost-update race and added the
  server-owned durable revision. This is the storage prerequisite, not the autonomous
  goal loop: objective files, audit ticks, controls, and schedules remain.

- 2026-09-25 · **Subagent route configuration from Agents Settings.** NNA
  exposes a separately authorized, validated saved subagent provider/model
  route. Agents Settings distinguishes saved from running routing, lets the
  operator select a provider profile and model, and requires explicit
  activation before new sessions adopt the change. Existing sessions retain
  their engines. This is configuration only: NNA still governs whether each
  session may delegate. The cross-repo smoke saves, activates, and restores
  the subagent route before exercising delegated work.

- 2026-09-25 · **NNA-native provider profile create/edit in Settings.** NND
  receives only `provider.profile.write` for profile creation and edits;
  existing `provider.manage` clients remain compatible, while the narrower
  principal cannot delete profiles. The form submits endpoint, model, display
  name, and an optional credential environment-variable name, never credential
  values. It does not display saved endpoint paths or credential bindings, and
  leaving the optional edit fields blank preserves their NNA-managed values.
  Saving changes does not silently activate them for new sessions. The
  adversarial review fixed stale Add-form values after a successful create;
  regressions cover duplicate avoidance and Secret Broker binding preservation.

- 2026-09-25 · **In-process provider-route activation for future sessions.**
  NNA can explicitly adopt saved provider profiles and role routes for
  sessions created afterward without restarting the managed child or
  interrupting current turns. Existing sessions retain their original engine
  config and NNA checks prompts against each session's own route. Settings
  exposes a separate apply action when any saved provider routing differs;
  activation never silently follows a save. Cross-repository smoke exercises
  save, apply, and restoration. The adversarial review identified a cached
  composer-default regression and a stale-specialist-profile risk. The fixes
  refresh the default, preserve each existing session route, and adopt all
  provider routing atomically for future sessions.

- 2026-09-25 · **NNA-native Agents catalog.** The Agents Settings page now
  reads built-in delegation role IDs and the configured running subagent route
  from NNA through an authenticated, read-only projection. It does not expose
  role instructions, endpoints, credentials, or imply that a role is granted
  in every session; NNA still decides invocation authority per session.
  Cross-repository smoke confirms the live projection.

- 2026-09-25 · **Primary-model override in provider Settings.** The route
  control now displays the actual configured model (which may differ from the
  profile default), accepts an explicit model ID override, and disables blank
  or no-op saves. It continues to report saved-versus-running drift and never
  restarts or switches an active NNA session. Adversarial review found no
  confirmed defect; focused and full UI tests pass.

- 2026-09-25 · **NNA-owned primary provider selection.** Settings can now
  explicitly choose a configured profile's default model as the saved primary
  route. A narrow `provider.route.manage` grant permits this one action without
  granting profile creation, edit, or deletion. NNA validates and persists the
  route, returns both saved and running identities, and NND says that restart
  is required before new sessions use it; existing sessions are not switched.
  Cross-repository smoke exercises route change and restore. Adversarial review
  fixed a compatibility regression so legacy read-only provider stores retain
  inventory access without the new mutation method.

- 2026-09-25 · **Configured versus running provider route.** NNA's provider
  inventory now includes the running NND engine route and configured primary
  route alongside manifest-backed profiles, read from one configuration
  snapshot. Settings labels them separately, honors primary-route model
  overrides, and warns only when the actual route identities diverge; a
  restart is required for the running process to adopt manifest changes.
  Cross-repository source smoke verifies the running-route projection.

- 2026-09-25 · **Provider diagnostics in Settings.** NND now offers explicit
  per-profile model discovery and configured-model catalog checks through NNA's
  authenticated provider endpoints. The managed principal gains only
  `provider.discover` and `provider.test`, not mutation authority; credentials
  and network I/O stay in NNA. Results say catalog membership, not inference
  health, and are cleared on profile refresh so a stale success cannot follow
  changed configuration. Source smoke covers both actions through the managed
  NND↔NNA adapter.

- 2026-09-25 · **NNA-native Skills visibility and runtime roots.** NND-owned
  NNA sessions now discover NNA's bundled/user skills and trusted-project
  skills from the same roots as the integrated operator. Settings shows a
  read-only, on-demand discovery catalog for newly created sessions; existing
  sessions may retain their earlier catalog. The projection excludes skill
  bodies and source paths, and discovery errors are path-free. Cross-repository
  smoke verifies the catalog while the adversarial review pinned catalog
  changes between sessions and the disclosure failure case.

- 2026-09-25 · **NNA-backed MCP inventory.** NNA now projects an authenticated,
  read-only configured-server inventory (`id`, transport, enabled, trusted) from
  its resolved process configuration. NND's MCP Settings page names this as
  configuration, not live connection health, and distinguishes denial from an
  empty inventory. Destinations, commands, headers, and credentials stay inside
  NNA. Cross-repository source smoke asserts the allowlist through the managed
  adapter; live health, testing, and management remain future capability work.

- 2026-09-25 · **Provider capability center, read-only first slice.** Settings
  now reads NNA's public provider-profile inventory through the authenticated
  harness seam and identifies the active route, model, and endpoint origin. It shows
  denial/unavailability distinctly from an empty inventory and never renders
  credential bindings. The managed NND principal receives `provider.read` only;
  profile writes and provider probing remain NNA-side future work.

- 2026-09-25 · **Authored session attention in the navigator.** NNA now
  projects a completed needs-input turn as session attention, independently
  from the idle transport state. Root attention is reconstructed from its
  durable Activity on restart; completed child attention survives the child
  snapshot. A new root turn clears the projection as soon as it starts.
  NND shows only validated NNA attention/phase badges in root and child rows,
  replacing the prior inert blocked-badge stub.

- 2026-09-25 · **Context rail evidence clarity.** Context now distinguishes
  no selected session, no NNA projection yet, and sections the operator hid.
  It summarizes the latest NNA-authored tool Activity for the selected
  session as an event, without calling a completed tool active or guessing
  from transcript text.

- 2026-09-25 · **Activity-to-Changes file evidence.** Successful NNA
  filesystem mutations now project a bounded workspace-bound review path
  into live and durable parent/child Activity. The rail offers a Changes jump
  only while that original workspace is selected. NND refreshes Git status
  for the jump and opens a read-only preview only if the path remains changed;
  an unavailable check and an absent change are distinguished. Nested
  workspaces translate paths against the Git root without granting Git file
  routes access to sibling paths. Shell edits and other unclassified changes
  still have no inferred file link.

- 2026-09-25 · **Changes file preview.** A filename in Git/Changes now opens
  a read-only, scoped diff preview in the current pane. Stage/Unstage stays
  on its explicit button, so inspection cannot mutate the index. The preview
  uses the existing diff parser, bounds large patches, and ignores a stale
  response after file or project selection changes. Adversarial review fixed
  stale project rows and added a bounded, read-only patch for untracked files.
  This is a local review
  surface, not yet a direct Activity-to-changed-file navigation link.

- 2026-09-25 · **Expandable tool Activity evidence.** NNA now projects a
  bounded, redacted allowlist from authored tool-status events into live
  Activity and saved parent/child snapshots: file-path targets for an explicit
  path-only tool allowlist, plus effect, reason code, elapsed time, and exit
  code when present. Shell commands, process arguments, search queries,
  delegated task text, raw tool arguments, and output remain excluded.
  NND validates the structured detail and lets the operator
  expand a tool row without losing the live log position. The tool row is
  still not a link to a separate durable tool receipt; that stronger
  correlation/navigation remains future work.

- 2026-09-25 · **Activity attention hierarchy.** A governed `needs_input`
  turn now emits a distinct `attention` Activity state instead of looking
  completed. The rail gives authored attention and failures stronger visual
  weight and a dedicated "Needs input" filter, while completed progress
  stays quiet. The state survives NNA's bounded saved snapshot and NND's
  live/snapshot merge.

- 2026-09-25 · **Activity turn evidence navigation.** NNA now attaches the
  submitted prompt's durable message ID to parent-turn Activity frames and
  retains that bounded reference in authenticated snapshots. NND validates
  the optional reference through live and restored records and offers
  "View prompt" only when the exact message is loaded in the active session.
  Adversarial review found and fixed the prior Activity-ID bound that silently
  dropped valid turns with long session and request IDs.
  Tool, notice, and child-turn rows still need typed links to their own
  authoritative evidence; this slice does not infer those targets from log
  text or temporary streaming IDs.

- 2026-09-25 · **Desktop window-state restoration.** Electron's main window
  now saves normal geometry and display mode on a short debounce, flushes it
  before hide/quit, and restores within a visible display work area after a
  monitor change. Port and geometry share the existing shell-local prefs
  without clobbering each other; writes replace the file atomically. The shell
  package explicitly includes its local runtime modules. Pure tests cover
  removed monitors, invalid state, size limits, mode precedence, and an
  interrupted preferences replace. The unsigned NSIS build passed; app.asar
  contains each imported shell module, and the packaged terminal smokes pass.
  Installed-GUI geometry remains unverified visually.

- 2026-09-25 · **Operator rail panel configuration.** The docked rail now
  exposes local panel order and visibility controls. Preferences are isolated
  by runtime and directory, malformed saved values are repaired, and the last
  visible panel cannot be hidden. Hiding the selected panel moves to another
  visible surface without discarding the mounted Notes/Browser/Terminal pane.

- 2026-09-25 · **Bounded harness event replay.** NNA's authenticated event
  stream now includes SSE cursor IDs and retains a count- and byte-bounded
  in-memory replay suffix. NND ignores the non-replayable connection receipt
  as a cursor and always reconciles snapshots on SSE reconnect.
  Reconnects replay only post-cursor events visible to the same principal and
  full workspace grant. NND's existing proxy forwards `Last-Event-ID` and its
  snapshot reconciliation remains the fallback for expired or restarted
  cursors. Durable cursor storage and explicit gap signaling are still open.

- 2026-09-25 · **Reconnect phase reconciliation.** NND now compares a
  candidate session GET against live-event revisions, tombstones, and the
  latest description before applying it, so a delayed read cannot roll a
  phase backward or revive a deleted child. Bootstrap now captures its
  revision baseline before the list requests and preserves live updates and
  deletions over stale results. Accepted descriptions replace the full record,
  allowing NNA corrections to remove metadata. This remains snapshot recovery,
  not full SSE cursor replay.

- 2026-09-25 · **Live delegated turn phases.** NNA-owned child sessions now
  project validated semantic phases through their own session metadata and
  live update events. The Subagents row uses the child's phase only while its
  own transport status is active; permission/question evidence retains
  precedence. Adversarial review ensured completed snapshots report idle
  after restart instead of regressing to unknown live status.
  The source smoke holds a real delegated provider call and verifies the
  child-specific `waiting_provider` projection through NND, including idle
  restoration. NNA full suite, NND UI/web suites, typechecks, and quality
  gates pass.

- 2026-09-25 · **NNA-authored turn phase in Context.** NND-created engines now
  emit their semantic phase from NNA, and the authenticated session projection
  carries the validated phase into the Work rail. The source smoke observes a
  real `waiting_provider` frame during a governed turn. Generic busy/idle
  remains replica bookkeeping; this does not claim the complete replayable
  13-state wire contract. Adversarial review fixed stale idle recency and
  mid-stream/tool phase lag. NNA full suite, NND UI/web suites, typechecks,
  quality gates, and cross-repo source smoke pass.

- 2026-09-25 · **Canonical NNA goal/tasks in Context.** NNA now projects its
  durable conversation-work revision, goal, and ordered task statuses into
  authenticated session metadata and emits a live session update after a
  committed work change. NND reads that projection in the Work rail rather
  than the OpenCode-compatible todo cache; an absent or malformed snapshot
  never invents a goal, and a temporarily missing config cannot revive stale
  todos when a canonical snapshot is present. Evidence and staged completion
  stay inside NNA. Adversarial review fixed the config-arrival race; NNA,
  NND UI/web, typecheck, quality gates, and cross-repo source smoke pass.

- 2026-09-25 · **Completed child Activity recovery.** NNA now saves recent,
  sanitized child Activity with each completed child transcript snapshot when
  its NND catalog is durable. NND reopens the log after NNA restarts; the
  source smoke proves the authenticated wire read. Older child snapshots
  without Activity reopen with an empty log. This remains bounded operational
  history, not a governance audit or SSE replay cursor.

- 2026-09-25 · **Completed child transcript recovery.** NNA now keeps a
  bounded, display-only snapshot of each completed delegated session when
  the NND session catalog is durable. After NNA restarts, NND's existing
  child-session list and transcript view can reopen that history under the
  original parent and complete owner grant. A restored child is not busy and
  has no steering capability. The source smoke now restarts a durable NNA
  process and verifies these wire behaviors; NNA also restores authenticated
  authority origins for the parent.

- 2026-09-25 · **Authenticated Activity snapshots.** NNA now retains a bounded
  sanitized per-session Activity view and serves it through an owner-scoped
  read route; root snapshots survive an NNA restart when its session catalog is
  durable. NND merges saved rows when Activity opens and during reconnect,
  retaining a newer live correction if an older read finishes late. A failed
  read does not clear visible evidence. The source smoke checks completed root
  and child Activity through the NND proxy. This is recent operational history,
  not a full audit ledger or SSE cursor replay.

- 2026-09-25 · **Single-project General Notes draft lease.** An unsaved
  General Notes draft now survives in-app project switches in memory. A second
  project's General Notes remains read-only until the first draft is saved or
  explicitly discarded; no navigation-triggered write occurs. Save failures
  retain the draft. If the original project's read fails on return, Save
  remains disabled and Retry load can recover without overwriting ambiguous
  file state. This protects in-app switches, not process crashes or reloads.

- 2026-09-25 · **Per-session NNA configured routes.** NNA now projects only
  provider/model IDs from each engine's configured route into authenticated
  session metadata. Child sessions carry their distinct delegated route even
  after completion. The Context rail prefers this per-session identity over
  the root-only `/config` fallback; it never treats a configured route as
  proof of the provider/model that answered a particular turn. The cross-repo
  smoke uses separate primary and delegated provider IDs and checks both.

- 2026-09-25 · **Configured model in Context.** Root NNA sessions now show
  the same configured primary model identity as the composer, or an explicit
  unavailable label when NNA configuration omits it. Delegated child Context
  does not borrow that root model label because NNA may route subagents to a
  different model; the selected session must exist before the row appears.

- 2026-09-25 · **Notes pane continuity.** Once opened, General Notes and
  Todos retain in-memory drafts across their tabs and other operator surfaces;
  no save is issued just for navigation. A hidden plan editor deactivates and
  reloads when reopened. The subsequent single-project draft lease protects
  General Notes across project switches without retaining mounted project panes.

- 2026-09-25 · **Notes read-safety.** General Notes, project Todos, and the
  plan editor now treat only an explicit file-service `not-found` response as
  a new blank document. Access failures, missing API routes, and malformed
  todo data remain read-only instead of exposing a blank editor that could
  overwrite an existing project file. Focused UI regressions cover denied and
  ambiguous reads; the plan editor disables edits/saves until a valid load.

- 2026-09-25 · **NNA governance in Context.** NNA now publishes only its
  review-posture enum and classified governance-record health/counts in
  authenticated session metadata. The Context rail shows those NNA-owned
  values plus pending permission/question counts, while malformed or absent
  data stays absent. No raw decision, evidence, argument, or credential is
  projected into the GUI.

- 2026-09-25 · **Resizable operator dock.** Desktop right-side surfaces now
  have a labeled title and a draggable, keyboard-operable resize boundary.
  Width is restored per non-transient runtime, project directory, and surface;
  compact mode remains full-width and does not inherit a desktop pixel width.
  The dock preserves a usable chat column by clamping its maximum width.

- 2026-09-25 · **Activity live-tail rail.** The session Activity surface now
  keeps authored evidence in arrival order, offers All/Turns/Tools/Notices/
  Failures filters, and follows the latest row only while the reader remains
  at the bottom. Scrolling into history holds position and reveals a counted
  Jump to live action when new rows arrive. Harness-authored redactions and
  corrections still replace evidence by stable id; no transcript text is
  inferred into the log.

- 2026-09-25 · **Live delegated status in Context.** Subagent rows now
  subscribe to the global live-status projection. Pending permission and
  question evidence outrank a concurrent busy status. An explicit idle record
  is labelled “Idle”; a child without any live-status evidence is
  labelled “No live status,” never “Done” by inference. Locally optimistic
  prompt status now reaches the global index immediately. UI regressions cover
  status arrival and blocker transitions.

- 2026-09-25 · **Cross-project terminal lease.** The app shell now owns one
  10-minute terminal keepalive across all visited project directories. Terminal
  panels retain only their visible observer/stream; navigating from project A
  to B no longer drops A's reaper protection. Hidden panels still make no
  5-second listing requests. A focused regression test covers the switch and
  removal of exited sessions from subsequent touches.

- 2026-09-25 · **Compact operator surfaces.** Below the desktop-width
  side-by-side threshold, chat now offers an explicit Surfaces door to
  foreground Context, Activity, Changes, Notes, Browser, or Terminal. The
  selected pane remains the rail's single surface; Return to chat restores
  keyboard focus to the opener. A width increase keeps chat visible through
  the `xl` layout rule instead of leaving it concealed by compact state. An
  audit fixed both resize focus directions and keeps the terminal controller
  mounted in composer focus mode. Hidden terminal panes pause their active
  stream and 5-second observer. The app-level keepalive owner followed in the
  next slice.

- 2026-09-25 · **NNA configured-model composer boundary.** The authenticated
  NNA bridge projects its configured primary provider/model identifiers without
  connection or credential metadata. NND shows that route, hides unsupported
  agent and auto-accept controls, and disables per-prompt model selection for
  NNA sessions; NNA rejects mismatched model or agent submissions. If config
  bootstrap fails, the composer blocks instead of falling back to mock.
  Cross-repo source smoke and focused composer/route tests cover the path;
  governed per-turn overrides remain planned NNA engine work.

- 2026-09-25 · **Production GUI layout restored.** A live 1280×800 browser
  inspection found that Vite shipped the design tokens but no Tailwind
  utilities from `packages/ui/src`: the session UI collapsed into a text
  column. The web stylesheet now explicitly registers web and shared-UI
  sources. Rebuilt CSS grew from 12.27 KiB to 50.85 KiB; the desktop-width
  session/sidebar/operator-rail layout renders correctly. The browser probe
  opened Activity, sent a mock prompt, and observed turn-start, assistant
  output, and turn-complete evidence. A CSS utility gate now runs after web,
  Electron, and release builds, and rejects the previous broken artifact.
  This validates the mock browser door, not the native app window or real NNA.

- 2026-09-25 · **Packaged terminal command plane acceptance.** The unpacked
  Windows x64 Electron executable now boots its packaged server bundle with
  isolated mock-harness data, answers `/health`, creates a real terminal via
  HTTP, and delivers the expected snapshot, output, and clean exit over the
  terminal WebSocket. NSIS packaging runs this bounded probe after the native
  PTY probe. GUI rendering and actual installed-app behavior remain to test.

- 2026-09-25 · **Packaged terminal native acceptance.** The unpacked Windows
  x64 executable now passes a bounded real `node-pty` command spawn/output/
  exit probe under Electron-run-as-Node; the NSIS build runs this gate after
  artifact verification. This closes the missing-native-
  runtime/ABI check for that packaged artifact. The full packaged HTTP/UI
  terminal route and non-Windows artifacts remain unverified.

- 2026-09-25 · **Installable shell artifact integrity.** The packaging
  pipeline now stages the external `node-pty` runtime and native binaries
  beside the server bundle for both script-install and NSIS paths. An
  isolated Node and Electron-run-as-Node probes check that the staged package
  and all Windows native addons load; the NSIS gate checks their presence
  again in `win-unpacked` because electron-builder's generic extra-resource
  copy otherwise excludes nested `node_modules`;
  the artifact digest includes the native tree. NSIS reporting now selects
  the exact version just built, so an older installer cannot be reported as
  the new release. A live packaged Electron terminal-create test is still
  outstanding.

- 2026-09-25 · **Live child-steering source loop.** The isolated provider
  holds a real delegated child turn open while the smoke reads NNA's
  child-specific capability through NND, submits an explicit steer, and
  observes both the steered user text and provider acknowledgment in the
  child's retained transcript. After the turn completes, the capability
  disappears and a late steer is rejected. This proves the NNA/NND wire
  authority transition; it is not yet a human GUI interaction test.

- 2026-09-25 · **Real delegated-session source loop.** The cross-repository
  smoke now makes the local provider fixture request NNA's `tool_search`,
  then `agent_run`. A constrained fixture reviewer approves only the exact
  task named in authenticated operator intent. The smoke checks that NNA
  creates a child session, NND lists it under the parent, and the completed
  child's assistant transcript remains readable through NND while its
  steering grant is absent. This covers one completed child; restart
  recovery now has an NNA host gate and a cross-repository restart gate, while
  multiple concurrent children still need a cross-repository gate.

- 2026-09-25 · **Governed source prompt loop.** The cross-repository smoke
  now starts a tiny loopback OpenAI-compatible fixture, submits a prompt via
  NND `/api/session/:id/prompt_async`, verifies NNA actually called the
  fixture, verifies the provider received the intended user text, waits for
  a normally completed NNA turn, and finds the marker in an assistant
  transcript part returned through NND. No external provider, credential, or
  model cost is involved. This proves the basic source harness turn and
  projection, not a complete interactive browser session.

- 2026-09-25 · **Live bridge events and cancellation.** The source smoke now
  subscribes through NND to NNA's real `/global/event` stream, observes the
  connection opener and the matching `session.created` frame, and closes the
  stream. NND's adapter binds the downstream request abort signal to the
  upstream fetch for the stream lifetime, so a closed browser request need
  not leave an NNA subscriber behind. Focused cancellation tests cover both
  a request waiting for headers and one already streaming.

- 2026-09-25 · **Real source bridge smoke.** `npm run integration:smoke --
  <path-to-NNA-source>` starts a source NNA child with an isolated temporary
  data root, sends NND API requests through the real adapter, and checks
  authenticated health (including a 401 negative control), root-list filtering,
  the empty child endpoint, session create/rename/delete,
  transcript read, and the browser-origin write gate. It uses an isolated
  local provider fixture for both the basic prompt loop and one delegated
  child transcript. This validates the two
  current source trees without changing the older installed NNA in the user
  profile; packaged installation and UI interaction remain separate gates.

- 2026-09-25 · **Unsafe browser-write guard.** The NND server now rejects
  unsafe HTTP requests from opaque and foreign browser origins before auth,
  NND routes, and the NNA proxy. Same-origin and reverse-proxy requests remain
  admitted, as do non-browser calls without Origin. A valid device bearer may
  cross origins for `/api/*`; an arbitrary Authorization header does not grant
  an exception. Vite's dev proxy preserves HTTP Origin and stamps the
  browser-visible Host for same-origin dev writes; only WS upgrades rewrite
  Origin for the existing WS gate. This closes the open-auth simple-request path from an
  untrusted preview guest; it does not make the guest page trusted.

- 2026-09-25 · **Manual Browser preview (P11 subset).** The operator rail now
  accepts user-entered HTTP(S) addresses, defaults loopback dev servers to
  HTTP, and offers back/forward/reload/external-open controls. The embedded
  page is an opaque-origin sandboxed iframe without a privileged bridge;
  NND's own listener and credential-bearing URLs are rejected, and NND's
  HTML refuses framing even after a guest redirect. The wider pane retains
  its history while another rail surface is
  selected. Browser inspection, annotation, capture, dev-server discovery,
  Electron guest partition, and NNA-granted agent control remain P11 work;
  some sites cannot render in an iframe. The preview sandbox itself is not
  a CSRF boundary; the separate server-side unsafe-write gate is required.

- 2026-09-25 · **Broad-suite validation repair.** The auth route test now
  establishes its temporary data home before server modules capture `ENV`,
  avoiding writes into the operator's profile during tests. The mock-tool SSE
  assertion waits for the terminal frame instead of racing the REST response.
  Neither change alters production route or event ordering.

- 2026-09-25 · **NNA-estimated Context rail.** NNA emits numeric context
  measurements for desktop-owned engines and projects the latest estimate into
  authorized session metadata. The rail shows estimated use, known limit, and
  percentage without treating them as billed usage or inventing a zero when
  evidence is absent. Source context text is never projected. Durable replay
  across NNA restart remains separate work.

- 2026-09-25 · **Live subagent transcripts and list contracts.** NNA streams
  bounded child text and tool lifecycle evidence under the child session ID,
  reconciles the preview to the completed transcript, and supports late-open
  reads. Root/child list filters and parent-scoped child reads match NND's
  client. The list is bounded but has no cursor yet.

- 2026-09-25 · **NNA-governed subagent transcript steering.** NNA now lists
  active and recently completed child sessions under their parent and serves a
  bounded child transcript view. The NND transcript remains read-only by
  default. A child-specific capability probe reveals an explicit steering
  toggle only while NNA grants it; submission rechecks the grant and confirms
  the engine accepted the steer. An unaccepted or uncertain response leaves
  the draft in place. Child discovery and activity replay across NNA service
  restart remain open work.

- 2026-09-25 · **NNA-backed session controls.** The managed local principal
  now carries separate NNA grants for title update, turn abort, and session
  removal. NNA owns the matching authenticated routes and durable title
  update. Removing a desktop session closes its engine and removes the
  catalog entry while retaining the NNA journal for recoverable inspection;
  it is not secure erase. Archive/fork/revert still need NNA contracts.

- 2026-09-25 · **NNA workspace-aware boot restoration.** NND now uses the
  authoritative session directory when reopening a saved session whose
  governed NNA workspace changed. It creates that directory's child store
  and updates the saved pointer. Boot-open waits for an authoritative list;
  failure or timeout cannot reopen a stale cached session. The seeded welcome
  fallback is limited to the exact root session in the boot directory.
  Focused boot tests and UI typecheck pass. The broader Vitest run currently
  has unrelated web-suite failures in mock tool event ordering, auth settings,
  and relay cleanup; these also reproduce in isolation.

- 2026-09-25 · **NNA-first product default and installed-runtime discovery.**
  NND now defaults to NNA in product boot; its source dev launcher still
  explicitly selects the deterministic mock unless overridden. On Windows,
  managed mode reads a validated NotNativeAgent installation descriptor and
  invokes its recorded Node runtime plus installed CLI with `nnd serve`, avoiding PATH and
  `.cmd` shell ambiguity. Portable installs retain an explicit-command/PATH
  route. Readiness accepts only NNA's exact `http://127.0.0.1:<nonzero-port>`
  protocol origin. Audits also fixed async web-entry handling, post-readiness
  stdout draining, spawn-error sanitization, and child cleanup if later NND
  boot fails. Focused launch/adapter tests: 19/19; server typecheck and entry
  syntax checks green.

- 2026-09-25 · **Managed NNA local-child MVP.** With
  `NOTNATIVE_HARNESS=nna`, NND now defaults to spawning `nna nnd
  serve`, accepts only one bounded `protocol: "1.0"` loopback readiness record,
  keeps its endpoint/token server-only, and mints a fresh NNA principal per
  request. Attach mode remains explicit (`NOTNATIVE_NNA_MODE=attach`). An
  unexpected child exit becomes a visible 502 harness-down response rather
  than an empty session list; NND disposal owns child termination. Electron
  awaits asynchronous NND startup before its health probe. Adversarial audit
  fixed that Electron Promise/handle fault and rejected non-base64url tokens
  that would fail during HTTP header construction. Focused adapter/launcher
  tests: 13/13; server typecheck and Electron syntax check green.

- 2026-09-24 · **Architecture and upstream-alignment audit.** User direction
  confirmed that NND is an NNA-installed GUI web-service integration package;
  Electron renders that web surface, while NNA remains the engine, governance,
  lifecycle, and listener-policy authority. ADR 0020, PLAN, DECISIONS, and the
  planning index now make the loopback-default/explicit-LAN rule and local-contract
  ownership explicit. A product-level v2.0.1 OpenChamber delta audit is recorded in
  NOTES/16 without copying source, assets, or dependencies; it creates an
  NNA-first evaluation backlog rather than a parity commitment.

- 2026-09-24 · **Targeted GUI scan.** A no-copy, feature-level inspection of the
  local OpenChamber GUI layout and maintained component documentation produced
  NOTES/17: NND's seven-surface GUI north star (workspace shell, navigator,
  conversation, NNA context rail, review band, capability center, and desktop
  doors), mapped to the NNA projections each surface needs. GUI-PLAN now links
  this product-shape companion; W-ids and implementation sequencing remain in
  the existing inventory and slice plan.

- 2026-09-24 · **Right-side workspace decision.** User direction expanded the
  GUI north star with a persistent docked workspace rail: Context, an NNA
  projection/evidence Activity log, Changes, project Notes (general notes/todos/plans),
  Browser, and Terminal. NOTES/17 defines the safety boundary (NNA-authoritative
  events, no default private reasoning or secrets) and pane behavior. GUI-PLAN adds
  W-116 and a future `operator-rail` slice before autonomy/capability expansion.

- 2026-09-24 · **Delegated-session transcript decision.** Subagents are now
  explicitly first-class child sessions in the GUI plan: nested live rows in the
  session navigator, demand-loaded replayable transcripts, parent-return navigation,
  and read-only-by-default action policy. W-117 and the `operator-rail` slice record
  the NNA contract requirements for correlation, replay, redaction, and authority.
  The child transcript additionally has an opt-in, hidden-until-authorized **Steer
  subagent** toggle that reveals its steering composer without granting authority.

- 2026-07-21 · Read 00-INDEX + 01 in full. Scoping decisions recorded (harness=NNA
  later + mock now; web spine → Electron; defer 10/11; stack per DECISIONS.md).
  Writing P0 scaffold.
- 2026-07-21 · **P0 done.** Monorepo (pnpm·Node24-native-TS·Hono·Vite7·Tailwind4·
  zustand5), runtime lib (globals, url/auth/fetch-bridge+HP-6 coalescing, endpoint
  switch, surface stamp, splash, startupTrace, chunkRecovery), harness seam + mock
  harness (echo loop, SSE /api/event), control SSE, auth-session/url-token stubs,
  App boot state machine (10× retry → recovery screen), MainLayout skeleton
  (sidebar/header/chat/rail), vitest 6/6, production bundle served by the Node
  server. Verified: /health, /auth/*, /api/session echo POST→reply, / + assets 200.
  Known limits: agent sandbox cannot spawn esbuild → dev-loop (`pnpm dev`) is a
  user-terminal step; browser visual check pending user eyes at http://127.0.0.1:3902.
- 2026-07-22 · **P1 done.** Doc 02 read in full (1484 lines) → `NOTES/02-harness-contract.md`.
  Mock harness rewritten as contract implementation (`server/harness/mock/{index,store,sim,
  events,fixtures}.ts`): bare-payload wire (D12), §6 shapes via new `ui/lib/nna/types.ts`,
  LF-8 turn simulation (transcription deltas → durable part), §5.1 envelope + ring replay
  w/ Last-Event-ID, v1+v2 permissions, questions, todos, fork/abort/revert/summarize/share,
  providers/models/agents/commands/tools-ids/path/project, `x-nnd-directory` header transport.
  Server proxy adds session-list sanitation (§3.2 keep-list). UI SDK facade (`nna/client.ts`)
  grows to the §3.4 catalog with §3.5a directory transport + ascendingId message ids; events
  client unwraps envelopes; sessions store keeps authoritative status map; ChatView busy
  pill; control stream standardized to `notnative:*` data frames. New in-process contract
  tests (messageID echo, 204+events, replay, abort-mid-part, permission 404-settled).
  Also: P0 mojibake repaired; harness naming centralized (`server/lib/harnessNaming.ts`).

- 2026-09-16 · **P2 done (resumed + completed by new agent).** Interrupted build
  repaired: sync-engine corruption (stray parens, missing view-store, bogus
  allSettled-concurrency) + repo-wide NUL/mojibake sweep (15 files; box-drawing
  comment dividers). Brand unified nna→nnd paths (`lib/nnd`), VITE_NND_URL.
  Engine split to POWER10 caps: pipeline-queues/attempts, transcript/blocking
  reducers, bootstrap(+directory/enrichment), engine-{instance,recovery,
  materialization,watchdog,message-poll,side-effects,actions,support}, view-store.
  84 vitest tests per NOTES §J.2 hinges (queues: 4 coalescing keys + barriers +
  frames + caps; reducer: freshness/chronology/terminal-part/dedupe/no-op/
  tombstone; routing precedence; child-store scheduler+eviction; loader
  inflight/expansion/tail/generations; optimistic taxonomy; ordering/timing;
  signature merge; batch primitive publication). Quality suite added
  (quality-gates POWER10 hard caps TS-aware, controlled-language NND-CTL with
  32-term registry + report, repository-graph, bump-version, release-gates,
  in-process smoke) wired to `pnpm run check`.
  Adversarial review dispositions (sub-agent): FIXED — runtime-reset scheduler
  brick (manager.reset, §11.2), primitive field publication in batches
  (sessionRevision/Total/deletedRevision), mergeBootstrapLists closed hierarchy,
  global bootstrap at start, eviction sweep interval, signature guard reads
  post-fetch state (no resurrect/loss), archive echo carries the stripped record
  (global cached bucket + status retirement), pipeline interrupt/heartbeat
  classification + real disconnect reasons. REGISTERED for later phases:
  control-frame normalization seam (P2-2), routing scan/info.directory (P2-3),
  streaming reconcile hooks + bounds (P2-4), per-dir watchdog cooldowns +
  discovery insert (P2-5), recovery runtime guards (P2-6), lifecycle action
  completeness (P2-7), optimistic revert-branch + ownership dirs (P2-8), loader
  complete-flag/deletion-merge (P2-9), bootstrap pagination + project.current
  abort rule (P2-10), covered-snapshot settle + ordering tie-break (P2-11),
  minor churn/bounds items (P2-12) — full list in NOTES/04 §"Review register".

- 2026-09-16 · **ADR 0020 accepted (both repos), design freeze.** Ecosystem framing
  locked: NNA = root headless-first harness (TUI native, GUI-less core, add-on
  activation contract; NNO today, NND as second package); NND = GUI integration
  package + standalone remote client (client-only mode needs the NND web service
  installed in the target NNA); NNO = business layer above; delegated contexts spawn
  per consumer with run-as entitlement; loopback default + token handshake; network
  exposure = explicit opt-in gate; NNA projection (13-state) = sole turn-state
  authority; surfaces own their sessions/config; governance owns decisions (mode
  ladder is settable, not decidable, client-side); lifecycle split (NNA core owns
  commands, NND-local owns tray/shell face). NND registry grew four terms
  (integration package, engine context, projection frame, shell). PLAN.md re-scoped:
  P4 → NND web-service package routes (not a standalone server), P11 promoted to
  client core, P12 = shell delivery vehicle; ecosystem phases PA/PB/PC appended.
  NNA-side stub written: NotNativeAgent/docs/architecture/0020-ecosystem-integration.md
  (add-on contract, package activations, concerns incl. NNA harness-surface gap and
  console ADR 0018/0019 reconciliation registered, integration robustness noted as
  future NNA work). No product code changed; gates stay green (84/84, tsc ×3).

- 2026-09-16 · **P3a done (chat spine).** Doc 05 read in full (1957 lines) →
  NOTES/05 staging. Built under packages/ui/src/chat/: prompt-language
  (4-key tokenizer+triggers+shell transitions+§H.7 instruction exact),
  keyboard-policy (§B.5 exact), send-planner (§B.9/§F.4 taxonomy: local
  command/queue/steer/blocked-authority + §B.9 error mapping), turns
  projection renderable gate + §E.1 status derivation tool-phrase table,
  drafts (identity, tombstones, §B.10 client-held queue), input-history
  (§H.4 recall+overlays), composer v2 split to fit POWER10 matrix (real
  idle-flush queue, shell mode → runShell action, reactive catalog,
  draft-restore on failure returns column to draft), transcript (tail
  dedupe, synthetic filtering, skill/reasoning/tool/subtask/unknown-safe,
  §E.1 chip, §F cards incl. Alt+Enter/Alt+Shift+Enter/Alt+Backspace newest-
  wins), sidebar (§F.10 lifecycle ordering — engine-level tie-break fix
  applied), session tabs (left-neighbor close, digit keys renderable-only,
  no tombstones), engine mount (App rewired; P1 interim session store
  retired from the wire path; runShell/abort actions via routing).
  Adversarial review: P0-1 openSession no longer denies pending requests
  (§F.4/GUI-POWER10 #2); P1×11 fixed in-slice (tail dup, real queue,
  draft-failure restore, picker sources, shell no-op, reactive catalog,
  card keyboard, sidebar updated-sort, tab neighbor/tombstone, POWER10
  split, synthetic leak). P2-residuals recorded (§I error card, subtenants
  subtree scope, Other… input, retry tick, unbounded maps list, §E.9 panel).
  105 tests incl. 21 new chat gates; engine +2 (P2-4 partial reconcile,
  P2-11 tie-break) verified.

- 2026-09-16 · **P3b done (chat depth).** model-catalog (3-layer
  provider→model→variant layers, favorites persisted per runtime, effort
  cycle Default→variants both directions, §A.2 collision display labels),
  ModelPicker popover (search, Favorites+provider groups, current marker,
  star toggle, Left/Right effort within row), starters §H.5 (two groups,
  insert rule commands 'text ' vs skills sha 'text
', hover X remove), composer P3b props (expanded/focus mode, /btw →
  runShell-style fork via actions.fork + banner, model selection round-trip),
  timeline dialog §A.7 (newest-first, search, revert/fork/scroll actions,
  no-text placeholder), prompt rail §A.8 (≥2 prompts teleport instant),
  engine actions: rename (PATCH title), fork (returns new session id),
  revert (to-message), MainLayout /timeline via 'nnd:timeline-open' event,
  /undo //redo → last user message revert. Deferred with halo: BTW peek
  panel + promote/destroy (fork-open only in P3b), AI rename small-model
  service (P4+), starters DnD reorder + shared marker (P5 settings),
  model tooltip metadata (P5). 113 tests (+8 catalog/starters gates).

- 2026-09-16 · **P3c done (work-status §E.9 subset + §E.3/§E.4).** work-status
  selectors + panel-gate (§E.9 identity rule: computed only while
  sessionStatusReady + idle + completed turn; committed stats SURVIVE the next
  active turn — review caught the broken wiring), panel (presence-collapsed
  sections Session/Project/Turn stats/Subagents/Tasks, catalog-resolved
  context limit, §G no-borrow rule honored, no fabricated 0% on tokenless
  totals, no cost-only row), recapFor v2: metadata.nnd.assist + `generatedAt`
  60s quiet window + anchor freshness; §E.4 suggestion chip in the composer
  band FILLS the composer (never sends) via the nnd:composer-fill channel
  (shared with /undo). Adversarial review fixed: P0-1 fork children now
  REGISTER + ENQUEUE ensure-session-messages materialization (they were
  skeleton-forever), P0-2 /undo vs /redo split (keep-point truncate +
  composer refill vs unrevert+refetch) with 'nnd:composer-fill'; P1×9:
  expanded keyboard policy wired, model selection reaches promptAsync, shell
  on draft no longer creates a prompt session, timeline anchors
  (id=message-*) + replaceState hash + error toasts + Escape, panel committed
  stats wired, context% suppresses tokenless totals + catalog limit, recap
  branded + quiet + suggestion surface. Register: §I cards, picker metadata
  tooltips, starters add-dialog + DnD, BTW peek/promote, §E.9 MCP/Pinned/
  context-sources rows + equalizer persistence,subscription, cycleVariant per-row variant, transient-runtimeKey guard for
  persistence namespaces, POWER10 span-heuristic blindness to TSX (tracked
  in gates backlog). 122 tests (+9).
  subscription, cycleVariant per-row variant, transient-runtimeKey guard for
  persistence namespaces, POWER10 span-heuristic blindness to TSX (tracked in
  gates backlog). 122 tests (+9).

- 2026-09-16 · **P4-1 done (server surface first layer).** /api/fs list,
  search (NND extension — bounded server walk for the remote-first mention
  picker), git-dirs + /api/git check/status(light) mounted BEFORE the /api
  harness proxy (Hono order). Workspace containment DEVICE-AWARE (relative()
  returns absolute strings cross-drive on Windows) + realpath root gates;
  adversarial review: P0-1 cross-device enumeration and P0-2 junction escapes
  (proven route-level on this host) FIXED; P1: git-dirs scope-bound +
  root-excluded, search .git boundary, git unborn-branch parse ("No" → name),
  composer mention source /api/fs/search with monotonic token + query-match
  staleness guards. Web package gains its own vitest suite (workspace-
  resolution note: pnpm install needed CI=true + --no-frozen-lockfile).
  Registered: symlink transparency deviation (links listed but boolean-
  neutralized unless target realpath stays in scope), gitignore
  approximation, plans-dir lazy-empty case, parse light/drop of merge/rebase
  states (P4-2 with full §5.13 files), rename `old -> new` path shape.

- 2026-09-16 · **P4-3 done (fs write family + session-folders).** /api/fs
  mkdir/write/delete/rename (P4-3): all four handlers workspace-bound with
  the SAME device-aware + realpath containment as the read routes; write is
  atomic tmp+rename; rename relies on single-?directory-scope (both targets
  containment-checked); delete refuses the scope root; mkdir rejects
  allowOutsideWorkspace outright (§5.14 grant rule). /api/session-folders
  §5.22: last-writer-wins by updatedAt (`ignored:true`), 4MiB cap after
  parse (413), malformed stored snapshots → 500 with documented strings,
  single-flight write queue, atomic rename. Refactored to sub-functions to
  clear the 60-line function gate that fired mid-slice. Review: QUEUED
  (context budget) — first next-session item before P5; risk areas: write
  no-op check missing (registered P5), content-no-op false-positive on
  registerFile-gated routes, session-folders corruption semantics.
  23/23 web tests (+7).

- 2026-09-16 · **P5-1 done (theme token system core).** design-system.css
  authored from doc 14 §B.1 table verbatim (light `:root` + dark `.dark`
  shadcn-style aliases in oklch, shell/environment tokens, glass clusters per
  variant) + generated-token SEED (surface/interactive/status/pr/chat/tools/
  loading clusters condensed to base variables — runtime themes overwrite
  whole blocks via the css generator at doc-14 E.6) + §B.2 radius scale
  (0.25/0.4375/0.5625/0.75rem) + fonts/motion + §B.3 semantic typography
  (web/desktop column) + §B.2 `@theme inline` utility mappings. web index.css
  re-imports the sheet; body now uses token variables (no more hardcoded
  hex). ThemeProvider: Delta D8 RESOLVED — `system` mode follows matchMedia
  both directions; `.dark`/`.light` root classes drive the block switch.
  Tests read the CSS as a fixture (both-variant coverage, seed presence,
  typography values) + jsdom provider tests (classes persist, system
  follows). 130 UI tests (+8). Registered: 38 preset themes + custom theme
  import format (E.6) + settings registry snapshot gate (P5-2), VS Code
  webview typography column (P10), i18n catalog + shortcuts (P5-3).

- 2026-09-17 · **P5-2 done (theme system per doc 14 §E).** lib/theme/: types  (Theme/E.6 interchange shape), color (hex canonicalization + darken/
  lighten/mix/contrast), validation (isValidTheme §E.6 subset + diagnostics),
  pr-colors (withPrColors, partial-pr merge), derive (seed→FULL-schema
  expansion, no half-mapped tokens), presets/ (brand pair, flexoki, 14 pair
  families, 6 singles ⇒ 38 built-ins per NOTES/14 C.1 resolution),
  themes.ts (registration order, app-light/app-dark alias map, defaults),
  css-generator + css-blocks (single `nnd-theme-variables` element, dual
  scope emission :root+.dark / :root+:root:not(.dark), !important alias
  block, ALL §B.1 runtime clusters, camelCase→kebab syntax tokens, config
  fonts/transitions, typography re-emission), storage (runtimeKey-scoped
  `notnative.theme.v2:*`, legacy seed mapping incl. single-theme ids, splash
  mirror incl. branded `notnative.themeMode`, all-or-null parse), custom.ts
  (GET /api/config/themes, client re-validation, withPrColors wrap).
  ThemeProvider: mode+light/dark PAIR, system matchMedia both ways (D8),
  transition suppression (2 frames, nnd-theme-switching), browser chrome
  (body bg + plain/media theme-color metas in place), write intent rides the
  SETTER (adoption/OS flips never write — flip-flop tests pinned), reload
  w/ 500 ms spinner floor. Adversarial review (sub-agent): P0 splash-mirror
  split fixed (+index.html system resolution), P1×5 (custom pr wrap,
  flip-flop tests, color math table, exact derivation values, meta in-place)
  + P2 nits (alias dedupe, non-hex edge filters, seed persist, meta patch,
  NOTES declarations). 181 UI tests (+14). web 23/23 · gates+smoke+graph.

- 2026-09-17 · **P5-3 done (settings registry + snapshot gate + persistence).**
  lib/settings/: parsers (bool/str/trim/int/num/oneof/list/set/record/
  modelRef caps), registry.ts = SINGLE TABLE with 186 fields (§F.5 inventory
  + F.4 LOCAL_DEVICE_KEYS + DESKTOP_SHELL_KEYS as first-class; deferred
  groups registered in NOTES/14 §D with their phases), autoSaveKeys() derived.
  scripts/registry-snapshot.mjs (root script registry:snapshot) → checked-in
  `packages/web/src/server/lib/settings-registry.json`; staleness gate test
  re-renders and fails on drift (§F.6 procedure enforced). Server:
  settings-gate.ts (snapshot-only key gate: unknown/computed/local/device/
  owner dropped; secret accepted-never-returned; ?surface= query param with
  header fallback) + settings-store.ts (§F.3 split store: preferences.json
  `{version:1,fields}`, settings.json rollback mirror w/ legacy keys kept,
  seed-once, unparseable-preferences discipline, atomic 0600 writes,
  kind→surfaces[kind]→base GET resolution, kind values never on base) +
  routes rewired: /api/config/settings registry-gated, /api/notnative/
  settings UNIFIED onto the same store (two-store drift from P0/P4 retired).
  Client engine: lib/settings/persistence.ts — cached GET (2s TTL + HP-6
  in-flight dedupe), updateDesktopSettings (filter → echo suppression →
  pending merge → 200 ms debounce → keepalive PUT), lifecycle flushes,
  save-state module (6 s error reset, notnative:settings-save-state),
  settings-synced event ({bootstrap, adoptTheme grades}) consumed by
  ThemeProvider for §E.3 bootstrap theme adoption (wired; adoption triggers
  when a server doc actually carries theme fields — no writer does yet, so
  inert by design until P5-4+ theme writes). fs-write no-op
  (identical content → unchanged:true, no mtime churn). P4-2 settings tests
  updated to registry semantics; new suites: ui registry/parse/persistence
  (200 total), web p5-3 settings + fs no-op (31 total). gates+smoke+graph.

- 2026-09-17 · **P5-5 done (shortcuts engine, doc 14 §I).** lib/shortcuts/:
  config (§I.1 table mirrored 1:1, 36 bindings incl. literal ctrl+/[, prefix
  families, internals), bindings (chord grammar: aliases cmd/meta→mod,
  option→alt, two-chord cap, empty-token rejection, bare-prefix ≥1-of-mod|
  ctrl incl. mod+alt per §I.1; mac ⌃⌥⇧⌘ vs Ctrl/Alt/Shift named display +
  named-key labels; §I.2 conflict rule; browser-risk feedback; authority
  rules), schema (lookups + effectiveShortcutCombo override→default +
  overrideIsPermitted), registry (first-bound wins + NEXT-IN-LINE
  re-acquire on removal; nested suspend), dispatcher (armed mod+k FAMILY
  with sibling candidates, 3000ms lazy expiry + boundary pins, Escape
  consumed only while armed, mismatch clears w/o passthrough, digit
  prefixes before normal chords, editable policy w/ AltGraph yield,
  IME-composition rules incl. armed-second eligibility w/ preventDefault
  decision pinned, mac/non-mac mod≡Ctrl aliasing, capture-phase second-key
  listener), hooks (single window router, symmetric install/uninstall,
  per-component useKeybind(s)). recorderConflict shaped for §I.3
  (exact/prefix/none + replaceable + overrides-aware). Adversarial review
  (sub-agent): P0 bare-prefix router crash fixed; P1×5 fixed (router
  teardown closure, capture listener, AltGraph, arming editable gate,
  registry re-acquire, recorderConflict API, vacuous IME test rewritten,
  mac-ctrl pin); P2 pins (expiry boundaries, display labels, corrupt
  tokens, key whitelist). Deferred to the settings-UI slice: recorder
  page + main-app router wiring + §I.4/§I.5 ownership; §J formatters with
  first Intl consumers. 250 UI tests (+30). web 33/33 · gates+smoke+graph.

- 2026-09-17 · **P5-6 done (settings UI core).** components/settings/:
  primitives (§A.3 blocks + settingsItem anchors incl. section anchors),
  page-tree registry (§G.2: 6 built pages + landing notes for the rest —
  never a silent gap), SettingsWindow (§G.1 chrome + §G.6 search jump w/
  per-control highlight + close-refusal while recording + registry
  suspension §I.2), pages appearance/chat/sessions/notifications/general/
  shortcuts (§G.4/§G.5 subsets bound to the P5-3 registry through the
  settings store; recorder dialog §I.3 w/ risk + conflict feedback and
  confirm-stays-local), lib/shortcuts/recorder.ts (pure §I.3 machine),
  lib/settings/{store,apply,font-options} (§F.3 apply step + §B.3/§B.4
  appliers bound at app boot), lib/format/time.ts (§J), ShellShortcuts
  (§I.2 router install mac-aware + open_settings/cycle_theme), theme pair
  writes to the registry on user intent (§G.4), MainLayout gear + ?settings=
  deep link. Adversarial review (sub-agent): P0×2 fixed (jsdom
  scrollIntoView crash + jump assertions; cycle_theme invalid hook), P1×8
  fixed (boot bind, anchor orphans + §G.6 resolution gate test,
  customize-only rows, theme registry writes, mojibake sweep + new
  quality-gate scan, isMac plumb, suspension + prefix invalidation,
  opencodeBinary allowEmpty), P2 cluster (recorder pins, cornerRadius/goal
  caps, single-sourced slugs). Registered deferrals E12–E18 (Base-UI dialog
  upgrade, page i18n key sweep, deep-link history, notification permission
  gating, voice/about slugs, recorder-dialog test file, control-form
  deltas). 280 UI tests · web 33/33 · gates+smoke+graph.

- 2026-09-17 · **P6 done (review surfaces, doc 06).** Four slices committed 2026-09-17
  (commits f195bbb, 652f774, f5e76d5, 1322c66): P6-1 fs domain + FilesView core
  (stat/read/raw routes, tabs store, FileTree dialogs, editor load/autosave/image/binary),
  P6-2 diff + git view (diff-model, first-party DiffViewer, git-router, GitView),
  P6-3 plan + comments + worktrees core (PlanSaveQueue, draft store, capture chain,
  WorktreesView), P6-3b inline comment lifecycle v1 + live worktrees + shell wiring.
  Adversarial sub-agent reviews fixed per slice (P0 clusters incl. transport throw,
  file-diff containment, cross-device enumeration-adjacent worktree paths, composer
  data losses); registered E-06-4..18 in NOTES/06. 359 UI · 48 web · gates+smoke+graph.

- 2026-09-17 · **P7 done (terminal, doc 07).** Two slices committed 2026-09-17
  (commits 8be1140, 758cfe6): P7-1 server core (WS codec v3, history sanitizer,
  theme-response answering, shells family, node-pty ConPTY backend, TerminalRuntime
  create/restart/kill lifecycle, idempotent command plane, loopback-gated upgrader),
  P7-2 client (TerminalTransport, terminal store + observer, TerminalView v1 with
  line-buffer renderer, MainLayout pane). Adversarial reviews fixed (incl. real ConPTY
  end-to-end gates); registered E-07-3..23 in NOTES/07. 389 UI · web 94 ·
  gates+smoke+graph.

- 2026-09-18 · **P8-1a delivered (doc 08 steps 1-2), resumed by new agent.** Pairing
  v2 payload contract (strict encoder, link head `openchamber://connect?v=2&p=`,
  16384 triple cap, v1 rejected) + remote-client credential store (hash-only, dedupe-
  replace, bearer auth, sticky relay, 60 s lastUsed throttle, revoke/purge) + 18 tests
  (`p8-1-auth-core.test.ts`). Adversarial review pass fixed P0x4 + P1 cluster; registered
  E-08-1..10 in NOTES/08. Ledger reconciled this session: P6/P7 rows + log entries
  added; phase renumbering adopted (doc 08 = P8; PLAN.md P11→P8, autonomy/knowledge/
  preview shift to P9/P10/P11) to match working slice numbering.

- 2026-09-18 · **P8-1b delivered (doc 08 step 3) with adversarial sub-agent
  review.** Hand-rolled HS256 (secret env → jwt-secret file 0600 → memory,
  atomic persistence + rotation), scrypt password verifier, per-IP login
  rate limit (10/5min → 15min lock, strict no-IP budget, env overrides),
  login flow (trustDevice 7d, desktop-only client-token mint tied to the
  cookie TTL, Cache-Control no-store), bearer-first session/bearer/URL-token
  authentication, URL-token mint/allowlist/60 s TTL bound to the parent JWT
  or `client:<id>`, global /api gate after the /auth routes (Hono order
  proven by script), cookie-only /api/auth/reset rotation, terminal upgrade
  gate slot (E-07-3). Review fixed P1×2 (secret-file persistence, 64 KiB
  bounded login body) + P2×4 + gate caps; registered E-08-11..16 in
  NOTES/08. 149 web (+37 p8-1-auth-ui) · 389 UI · gates+smoke+graph+version.

- 2026-09-18 · **P8-1c delivered (doc 08 step 4: scope classifier + tunnel
  gate).** §2.9 classify (tunnel host match / local names with private
  sockets / no-tunnel local / unknown-public same as tunnel; Host header
  falls back to the URL hostname — undici constructed requests carry none),
  newest-only bootstrap tokens w/ clamped TTLs + null-disables, one-time
  redeem, in-memory tunnel sessions (Lax cookie, lastSeenAt refresh), the
  /connect?t= route (rate limit 20/5min per IP + 5 no-IP + 10min lock,
  302 → /, no-store), stop/replace artifact revocation ('tunnel-revoked'),
  tunnel-scope locks on /auth (login/reset 403, url-token mint bearer-only,
  session row per §2.9 with E-08-18 bearer precedence), apiTunnelGate
  (device credentials pass at any scope; anonymous path needs the tunnel
  cookie), composed terminal upgrade predicate. Registered E-08-17/18 in
  NOTES/08. 162 web (+13 p8-1-tunnel) · 389 UI · typecheck green.

- 2026-09-18 · **P8-1c review fixed (sub-agent).** P1 `::ffff:` mapped
  sockets now classify private (desktop LAN was tunnel-locked under an
  IPv6 listener) + P2 redeem order (mint-before-consume) + P2 gate cap
  extraction; 7 new tests (mapped sockets, cookie-header garbage,
  mint/consume postcondition, ui-cookie fail-closed, open-mode url-token
  rejection, connect Set-Cookie matrix, rate-block record churn). 169 web
  · 389 UI · gates+graph green.

- 2026-09-18 · **P8-1d delivered (doc 08 step 5: passkeys server family).**
  @simplewebauthn/server v14 added; WebAuthnCeremony seam (real adapter +
  injectable fixtures), disabled-unless-password posture, HMAC passphrase
  binding store (`ui-passkeys.json` strict-read + atomic rewrite) that
  clears on password/secret change, per-rpID scoping + origin derivation,
  5-min one-shot challenge bookkeeping pinned to the ceremony's own
  challenge, session-cookie-only registration + excludeCredentials,
  anonymous authentication over the login rate limiter issuing the exact
  password-login cookie/mint/tail (trustDevice + desktop mint), revoke by
  id AND rpID, GET/DELETE /api/passkeys management, tunnel-scope 403
  family, and the auth-reset passkey purge (E-08-3 complete). Registered
  E-08-20..22 in NOTES/08. Adversarial review (sub-agent) fixed P0×2 —
  expected-origin ports (rpID drops the port, origin keeps it; scheme-
  default 80/443 suppressed) verified against the REAL adapter, and the
  granted session cookie was being dropped by the passkey finalize —
  driven now by a route-level E2E with a server-built synthetic P-256
  authenticator (real CBOR/COSE) — plus P1×2 (corrupt userID regeneration,
  transports allowlist/caps) and the machinery split for file caps.
  184 web (+15 p8-1-passkeys) · 389 UI · typecheck+gates green.

- 2026-09-18 · **P8-2a delivered (doc 08 relay steps 6/7: identity + Layer 2
  + Layer 3 primitives).** RelayIdentityStore (strict regeneration gate,
  serverId formula, ECDSA IEEE-P1363 URL auth verified through WebCrypto
  as the worker would, ws/wss query rows), E2EE derivation chain
  (ECDH→HKDF→two AES-GCM keys, IV prefix+BE counter, fail-closed decrypt
  incl. replay/regression/version/GCM, 64 KiB cap), handshake grammar
  (reduced JWKs, capability flags), tunnel codec byte contract (types
  1-13, 5B header, odd stream ids, fragmentation with the 16 MiB
  assembler bound, empty-body single chunk, payload shape guards).
  Registered E-08-23 in NOTES/08. 195 web (+11 p8-2-relay-primitives) ·
  389 UI · typecheck green.

- 2026-09-18 · **P8-2a review fixed (sub-agent).** P1×2 (chunk-size cap
  enforcement at MAX_TUNNEL_PAYLOAD_BYTES; BigInt-stepped wire counter
  with a 2^53 exactness gate — Number() collapse probe-verified) + P2×4
  (final-chunk assembler bound hole, 256-group pending flood cap, guard
  strictness registered E-08-24, concurrent-mint singleflight) + test
  junk replaced with real negative verification rows. All byte/parameter
  contracts probe-proven (serverId order, P1363 sig, IV offsets, WHATWG
  ws/wss rows). 201 web (+6) · 389 UI · gates+graph green; E-08-25
  registered (a-e pending bounds/bigint/singleflight+LWW/fresh-ts/
  outbound-cap deferrals).

- 2026-09-18 · **P8-2b delivered + reviewed (doc 08 §3.3/3.4/3.11 host
  side).** Host control machine (outbound authenticated control socket,
  30s ping / +10s pong grace, exponential reconnect 1s×2 cap 30s,
  nonzero close → lastError, owner-guarded opens/closes; the inverted-
  ternary reconnect wedge found and fixed), data legs (open timeout w/
  clear-on-open, host-handshake responder integration, recv/send chain
  discipline, 90s idle reaper swept at 30s), established-frame ROUTING
  fix (duplicate hello re-answers the SAME ready; a different fingerprint
  closes 1008; other text closes 1011 — the broker previously dead-routed
  the responder), no-listener crash guard on CONNECTING teardown (P1),
  one-close-decision guards, and a loopback fake worker (worker-parity
  auth verify, 4001 replacement, upgrade gate, verbatim forwarding) as a
  test-only prosthesis. E-08-26a–g + broker timing constants registered.
  9 gates in p8-2-relay-host.test.ts · 210 web (+9) · 389 UI ·
- 2026-09-18 · **P8-2c delivered + reviewed (doc 08 §3.5-3.9, Layer 3 host side).**
  Batch container codec + OutboundFrameBatcher (150ms/24KiB/32 defaults,
  payload-types-only buffering, setup-first flush, leading-edge instant,
  caps-on-received, enqueue-serialization w/ the self-deadlock found),
  downstream scheduler (credit window 64KiB→1MiB fixed accounting,
  DeliveryAck 8B BE strict boundary validation, stream-zero outside the
  ledger, queue caps, cancel semantics; adaptive heuristics deferred
  E-08-27), host dispatcher (§3.9: allowlists + synthetic-json 403/400,
  header hygiene + relay-connection/origin injection, buffered bodies
  only-at-StreamEnd w/ zero-frame/deadline guards, >512KiB live web
  ReadableStream duplex, response chunking, WS sub-streams w/ fragments +
  clamped closes + 1008 refusals, duplicate-stream aborts, Ping→Pong,
  detached lifecycle pump). Review fixed P1×3 (batch dead-lock, window
  ledger dead-loop, undici live-body rejection) + P2×5. 18 suite tests.
   228 web (+18) · 389 UI · typecheck + gates + graph (250 modules) green.
   typecheck+gates green.
- 2026-09-18 · **P8-3a delivered + reviewed (doc 08 §3.12/3.13/3.15 + §3.5-3.9
  assembly, checklist step 8 tail).** Relay host service lifecycle (demand
  reconcile via allSettled any-wins/throw-aborts; relay-config.json machine
  store E-08-28; 60s demand poll + 30s claim watcher), machine claim
  (relay-host.lock tryClaim/forceClaim/release w/ synthetic-liveness probe,
  ESRCH stale claimable, EPERM alive, corrupt==no-claim, write-failure
  pre-lock posture via tri-state outcome E-08-29), standby takeover
  (foreign claimant stand-down + 120s grace, boot instant reclaim),
  passive hold-out env (NOTNATIVE_RELAY_HOST off/on + ELECTRON_DEV with
  the on-override), enable/disable/status §3.15 routes (16KiB bounded
  reader, ws/wss normalization w/ default fallback, relayUrlLocked), the
  §3.13 relay candidate (getPairingCandidate + ensureEnabledForPairing
  force-claim), /health serverId E-08-2 (shared identity singleton +
  fail-soft peek), and the PRODUCTION leg mux (leg-host: mixed-mode L2
  demux E-08-30 — §3.7 wires tag or bare frame, dispatcher entry —
  fragment assembler, dispatcher, batcher offerEncoded, loopback-adapters
  RealLoopbackSocket `ws` production dial w/ origin+relay-connection
  injection; broker terminateLeg + negotiated capabilities on
  onLegEstablished; /health batch-window env consumption). Review fixed
  P0×2 (dispatcher 511-line cap -> request-body.ts extract; the REAL
  0x01 batch-tag collision — a bare HttpRequest frame byte was misread as
  the [0x01] container tag and 1011'd every spec-compliant client leg;
  shipped the parse-validated demux rule: 0x01 is a container only when an
  exact multi-segment run of buffered-type frames parses, bare fallback
  otherwise) + P1×3 (claim write-failure stood hosts DOWN — tri-state
  claimed/contended/write-failed E-08-31; disable() killed the poll/
  watcher de-lifecycling the service; unhandled-rejection surface on the
  direct carrier paths) + P2×3 (dead env helper consumed by leg batches,
  bounded enable body, batcher timer unref).   45 suite tests across three
  files (lock+config 17, service+routes+health 22, production wire 6: HTTP
  E2E incl. a bare-frame leg, WS upstream both ways + closes, replay
  closes 1011). 273 web (+45) · 389 UI · gates+smoke+graph (257) ·
  version 20260918-8 sealed (a1e4f83 + ledger 36a764f).
- 2026-09-18 · **P8-4a delivered + reviewed (doc 08 step 9 server half + E-08-13
  family; adversarial ses_f48d0a552ffejimD2JyQP6KHkP).** Pairing session
  store (client-pairing-sessions.json 0600, one-time secret via create/
  redeem replies only, mint retry-safe tail, sweep retention inactive+TTL,
  sync store posture E-08-32) + the /api/client-auth route family: redeem
  anonymous pre-gate (10/5 min sliding window keyed raw-socket:pairingId,
  success clears bucket, one generic error for every failure class incl.
  429 + Retry-After), gated authority family (manage = UI session |
  desktop-local | open; plain tokens self-only; pairing reads
  manage-gated), pairing sessions create/list/cancel (§5.5 candidate
  math: serverUrl primary 10, request-origin extra 20 when
  different+not-loopback, https->tunnel type, empty label -> unset,
  loopback fallback refused w/ 400 'No usable pairing candidate',
  wildcards rejected, includeRelay true -> ensureEnabledForPairing
  force-claim + 503 when unavailable, default -> legacy
  getPairingCandidate, false -> never; dedupe), §3.13 candidates refresh
  (socket local-address first, interface scan, relay last, serverId
  rides, never URL-token-authorized pinned by test) + transports view
  (LAN from server bind: concrete non-loopback passthrough, wildcard
  LAN-IPv4 scan, loopback -> null), and the §3.12 reconcile call sites
  (create/cancel/redeem/revoke/purge fire-and-forget; index.ts demand
  joins hasActiveRelaySession() beside hasActiveRelayClients()). Shared
  bounded-body reader extracted (lib/http/read-bounded.ts). Review fixed
  P0 (auth-family singletons defaulted dataDir '' — stock boot 500'd
  pairing create and split-brained the identity dir; now ENV.dataDir) +
  P1×2 (redeem IO faults were masked as the attacker-facing generic 400
  after minting — typed InvalidPairingSessionError vs PairingStoreFault,
  consume-on-confirm stamp rollback, faults 500 without charging the
  bucket; GET pairing reads were any-bearer — manage authority now) +
  P2 cluster (registrar split, empty-label unset posture, cancel-of-used
  404 E-08-33g, 0700 dirs, wildcard serverUrl rejection, reconcile on
  ensure-failure exits). 42 tests (store 15: formats/TTL/hash-only/
  one-generic-error matrix/label precedence/retry-safe/sweep/persistence/
  corrupt-reset/ENV-default/save-fault rollback; routes 27 across two
  files w/ a shared harness: rate keying incl. socket-split buckets +
  clear-on-success + fault-no-record, wire byte-equality of auth error
  classes, exact 201/200 shapes, no-store, loopback exclusion, origin
  extra dedupe, cancel 404-already-gone/used, authority matrix, drain
   jars, authority matrix, drain
   fixtures, password-mode rows + URL-token refusal). Web 315 (+42) · UI
   389 · gates+smoke+graph (261) pending final seal.

- 2026-09-18 · **P8-4c delivered + reviewed (doc 08 step 10: tunnels).**
  Capability registry + §4.2 normalize/validate (fallbacks vs unsupported,
  intent matching, ~ home-containment, host/token rules, 400/422/500
  mapping); §4.3 drivers — cloudflared quick (temp HOME/USERPROFILE on
  win32, URL both-streams, 30 s kill+cleanup+exact text), managed-remote
  (--token-file 0o600 temp never argv, stdout drained not logged, ready/
  fatal sets + 6 s liveness + 20 s hard fail, cleanup on exit/stop),
  managed-local (guarded reads ≤256 KiB, yaml/JSON ingress hostname,
  --config only when requested), ngrok quick (env→config-check authtoken
  remediation, API 5 s gate, JSON+4040 harvest https-first, summarize);
  §4.4 profile store (cloudflare-managed-remote-tunnels.json 0600
  promise-locked, sanitize+dedupe id/hostname, upsert conflict removal +
  corrupt heal, legacy named-tunnels migration, token-free views);
  §4.7 service (mutex one-controller, same-config reuse vs replacement
  with tunnelId persistence, failure path detach-without-revoke, stop
  retained w/o controller, lazy dead-controller resync, §4.4 token
  chain) + §4.6 routes (check/providers/doctor+CLI flag/status/token
  upsert/start connectUrl/stop) + seven §11.2 settings keys (canonical
  registry + snapshot, token secret) + TTL wire-up + §4.7 startup env
  tunnel (NOTNATIVE_TUNNEL_*) + shutdown dispose. Adversarial review
  (ses_f4859e55bffevrAmsmKa493OW0) fixed
  P1×2 (tunnel-scope visitors could start/stop tunnels + write run-token
  profiles — operator guard E-08-37; TTL wire junk disabled expiry) +
  P2 cluster (USERPROFILE/APPDATA quick isolation, rmSync retries+guarded
  stop, /connect socket-key limiter, yaml parse echo, doctor mode 400,
  settings PUT bounded, ngrok listener dedupe, spawnSync timeouts,
  .bat/.cmd launch exclusion, buildRequest type-junk 400s) — deltas
  E-08-34..40. 44 tests (core 15, profile-store 12, providers 22, ngrok
  12, service 11, routes 14 across three helpers) + settings-store seed
  fix E-08-40. Web 401 (+44 net w/ scratch removal) · UI 389 ·
  gates+smoke+graph (276) — seal 20260918-10.
- 2026-09-19 · **P8-5a delivered + reviewed (doc 08 step 7 tail + the
  client half of steps 11-12: relay client face).** The ui-side relay
  mirror (`packages/ui/src/lib/relay/` — browser-safe Uint8Array +
  globalThis crypto, dual-compile with the server tsconfig): Layer 2
  E2EE (crypto.ts, hello/ready grammar, fail-closed counters), client
  initiator (handshake.ts), Uint8Array Layer 3 codec with the
  [0x00]/[0x01] mixed-mode container demux + fragment assembler
  (tunnel-codec.ts), §3.8 ack ledger (16 KiB inline + 10 ms tail,
  keepalives excluded, per-handshake reset — tunnel-acks.ts), ambiguous
  transport tagging, §3.10 fetch lanes (streamed bodies, probe
  content-types, abort/body-cancel/StreamAbort semantics, 204/205/304
  null bodies), WS surface (native shape, readyState only via real
  frames, 1006/1012 close mapping, send-before-open exact text),
  tunnel-client state machine (inbound-driven keepalive w/ options,
  §3.11 backoff base ×2^cycles cap 30 s/60 s offline-hidden, queued
  connect attempts, terminal close retention, closed-generation
  watermark, lane/listener releases, fail-closed send errors), client
  outbound §3.7 batching (negotiated, setup/keepalive flush-first,
  batchWindowMs honored). Runtime integration: runtime-tunnel singleton
  (byte-equal descriptor reuse incl. grant + canonical JWK, terminal
  reuse refused, adopt joins status fan-out), runtime-switch activates
  BEFORE the §6.0 mint, runtime-fetch routes through the tunnel with
  coalescing, runtime-auth mint rides the tunnel + §2.6 mint-failure
  clears the token, runtime-socket sanctioned op. Host side: E-08-27
  heuristics LIVE in downstream.ts (grow on blocked-head latch +
  near-best RTT ≤ minRtt+50, halve > minRtt+100 floor 64 KiB cap 1 MiB,
  once per checkpoint = acked + POST-adjust window, stream-zero-first
  rounds, `now` seam) + scheduler.sendNow (terminal rows bypass the
  queue but stay ledger-accounted — the review caught every mirrored
  WsClose/StreamAbort row failing the channel 1011). Adversarial sub-agent
  review (ses_f46d2dbf9ffeh137n5voMf8NWt): P0×1 + P1×7 fixed in-slice
  (P0-1 accounting seam E-08-41; P0-2 backoff off-by-one; P1 lanes
  leak, adopt status-blindness, WS local-close echo, body-read settle,
  mint clears, downstream test gap, terminal reuse) + P2 cluster
  (timer detaches, watermark, Request inputs, >16 MiB guard,
  bodyless-status belt, stream-zero-first rounds, dead-code trims) —
  deltas E-08-41..49. Tests: ui 428/53 (+39: relay-primitives 21,
  fake-broker tunnel-client 14, runtime-tunnel 4) + web 413/31 (+13:
  p8-5a E2E 6 — the REAL client over the production host-service leg
  incl. the >64 KiB ack-driven response, WS codes + post-close fetch,
  leg replacement; p8-5a-downstream-window 6 deterministic suites).
   Typecheck both tsconfigs · gates+smoke+graph (294) — seal 20260919-1.

- 2026-09-20 · **P8-5b delivered + reviewed (doc 08 §2.5/2.8/5.8/6.1/6.6-6.7 +
  app wiring).** Client faces: connection-payload (both §5.1 parsers +
  16384 cap + v2-only), pairing-client (§5.6/5.7 candidate racing w/
  identity-gated direct probes + relay-last throwaway tunnel + scope
  forms incl. the relay-consent mapping), pairing-qr (§5.8 1024px L),
  pairing-watch (§6.1 close reasons), passkeys client lib (§2.5
  ceremonies w/ transport-tolerant status-0 degrade), runtime-auth-expiry
  (§2.8 classifier + 15 s confirm probe + focus watch + send-guard
  predicate), and the §6.6/6.7 components (SessionAuthGate stages +
  AuthExpiredBanner + pairing dialog family). App wiring: gate above
  App in the provider tree (locked visitors never boot the app), banner
  under the MainLayout header, composer send guard (button + Enter),
  splash released on the gate's first answered probe, trust-device key
  rebranded 'notnative.uiAuth.trustDevice'. Adversarial sub-agent review
  (ses_f3ee2b0a7ffe67K6YxJaLot3Yj) fixed P0×1 (passkey ceremonies wedged
  the gate on transport failure) + P1×3 (relay consent dropped from the
  create body; tunnel-lock re-entry cleared the expiry store; dialog
  rendered while open:false) + P2×1 (ghost ThemeSystemProvider comment);
  registered E-08-50..52 (no ThemeSystemProvider layer; sequential
  probe/support assembly; relay-consent includeRelay:true with the
  anywhere-preflight refusal). Web-parity harnesses pinned the payload
  byte-parity + route shapes. ui 577 tests (+149 vs the P8-5a seal) ·
  web 438 (+25) ·
  typecheck ×4 · gates green — seal 20260920-1.

- 2026-09-20 · **P8-5c delivered + reviewed (doc 08 §5.9 connect-url + the
  doc 03 CLI framework seed).** packages/web/src/cli/: shared parser
  (long/inline/short/-no-x aliases, usage exit 2), output engine (S10
  modes, --json-over--quiet, decorations TTY-gated, warnings reach
  piped stdout), instances (probe + detached auto-start with real log
  fds + 30 s readiness + kill-on-timeout + instance record), connect-url
  (exact §5.9 resolution order, direct+optional relay candidates with
  the shared identity lazy-mint, pairing session written DIRECTLY to
  the on-disk store, link via the shared ui encoder, [RELAY_STARTING]/
  [LAN_UNREACHABLE] advisories, qrcode-terminal --qr, S5.9 --json
  shape, --quiet link-only), dispatch/help/roster + bin entry
  (`notnative`, exit codes 0..5). Adversarial review
  (ses_f3e4ff5b2ffelKEKfunoIX2JMs) fixed P0×1 + P1×5 + P2×4: P0 the
  pairing store was a boot singleton — CLI-created sessions were
  invisible to a live server (every CLI link would fail redeem);
  every store op now refreshes from disk (last-writer-wins posture)
  + pid-stamped tmp names; P1 --lan flag missing, dispatch refused
  flags-only/positionals, help pages split, orphaned child killed on
  readiness timeout + record removal + exit 5, quiet warnings to
  stderr; P2 HTTPS case-sensitivity, port junk parsing, address token
  guards. Registered E-08-53..57. Live smoke: auto-start +
  discovery-drop-in both verified against real servers. web 483 tests
  (+29) · ui 577 (+0) · typecheck ×4 · gates green — seal 20260920-2.

- 2026-09-20 · **P8-6 delivered + reviewed (doc 08 §7 SSH machines, the
  UI-ownable half).** The §7.2 instance contract ships as
  lib/desktopSsh.ts (strict normalizer + sshCommand parser with
  program-word exclusion + value-flag vocabulary, timeout bounds
  E-08-58, remote-LAN password rule, plaintext-store confirm rule,
  random-port retry helper, sshRuntimeKey 'ssh:<id>' E-08-61),
  lib/desktopSshImport.ts (~/.ssh/config alias rows + bridge-guarded
  read, E-08-63), and lib/desktopSshStore.ts (the §7.3 store: bridge
  seam only — the UI never spawns ssh (§7.4), pushed statuses keyed
  by id w/ strictly-older pushes dropped + equal-stamp replacing
  (E-08-59), in-place upserts, trigger-honest bridge-less posture
  (E-08-64), secret mirror verbatim with no echo paths (E-08-60)).
  Electron internals (master channel, installers, bundle upload,
  forward lifecycle, host-key prompts) are doc 09/P12 as the slice
  states; the Remote Instances UI page mounts with P12. Adversarial
  review (ses_f3e23db48ffewK6wydq4mPWhyV) fixed P1×5 + P2×4 (program
  word, -q boolean, listener survives config failure, silent
  bridge-less failures, untraceable create refusal; row-order jump,
  status port rule, stale statuses on setBridge, guard bypassed).
  Registered E-08-58..64. ui 599 tests (+22) · web 483 (+0) ·
  typecheck ×4 · gates green — seal 20260920-3.

- 2026-09-20 · **P8-7 delivered + reviewed (doc 08 §9 reverse-proxy
  posture).** lib/http/request-security.ts (origin consumption: HOST
  equality only — protocol never compares, candidates Host /
  x-forwarded-host / publicOrigin + packaged-client origins
  case-folded; absent Origin passes; bare-host regex with the IPv6
  bracket arm + default-port canonicalization), wired into the
  terminal WS upgrade (destroy on disallowed Origin; doubled-Origin
  joins and fails closed), plus doc 08 §9 hygiene: X-Robots-Tag
  noindex,nofollow middleware + /robots.txt disallow-all + an onError
  belt, and the dev vite proxy now sends origin:=apiTarget (E-08-66,
  §3.9 dialer parity) so the §9 gate does not kill dev terminals.
  SSE header rows pinned through a live stream body. Cookie Secure,
  passkey rpID, redeem raw-socket limiter, compression-one-layer
  (still doc 03/P4) were already sealed by their owning suites.
  Adversarial review (ses_f3e09f794ffe7LZlAYllgOdVxZ) fixed P1×3 + P2×2
  (IPv6 origins never matched; dev proxy would have killed every dev
  terminal WS; doubled-Origin fail-open; unstamped hono-default 500s;
  case-sensitive packaged origins). Registered E-08-65/66. web 503
  tests (+13) · ui 599 (+0) · typecheck ×4 · gates green — seal
  20260920-4.

- 2026-09-20 · **P8-8 delivered — P8 PHASE COMPLETE (doc 08 §12
  invariants sweep, checklist step 15).** The audit ran all 42 §12.1-12.5
  rows: 30 already pinned by their owning suites, 9 new pins, 2
  gap-fixed, 3 registered; the matrix lives in NOTES/08 §D.
  New sweep suite p8-8-invariants-sweep (static no-leak rows: no
  Authorization/cookie logging in server src; 0o600 on every secret
  store except the E-08-29 host-lane; no-store helper discipline;
  tunnel bodies token-free; ui runtime/relay never persist) + runtime
  rows (duplicate host dials; failChannel payloads). GAP-FIXED:
  decodeTunnelFrame foreign numerals now CodecError in both mirrors
  (E-08-69); redactSensitiveUrl landed as lib/redact-url.ts (E-08-67,
  wiring P12). Registered E-08-67..69; §6.4/6.5 identity-gated probe
  cluster rides P12 (E-08-68). web 511 tests (+8) · ui 608 (+9) ·
  typecheck ×4 · gates+graph (326)+smoke — seal 20260920-5.

- 2026-09-20 · **P9-1 delivered + reviewed (doc 12 message-queue server
  runtime, checklist step 7 — §D.1-§D.5).** packages/web/src/server/queue/
  (9 modules): D.1 item contract (parse matrix 400s, 200k content cap,
  attachment coercion, context metadata required, 103/100 previews),
  D.2 store (message-queue.json v1, monotone revision per mutation,
  pid-tmp atomic writes, corrupt rename-aside + write-disable-on-read-
  failure re-enabled by the reconcile beat, 20/50-session limits —
  newest-kept / oldest-evicted-never-in-flight), D.3 delivery loop
  (500 ms idle quiet timer, abort-hold 2 s, per-ITEM backoff
  2 s×2→60 s cap, LIVE idle verification (status-map absent + the
  2-message tail complete), head re-read, §D.3.6 exact part order w/
  the composer-parity slash expansion ($ARGUMENTS/$1..$N
  last-absorbs/append), command-vs-prompt routing (command route only
  sans context), onPromptSent hooks, broadcast-first behavioral),
  D.4 in-memory TTL holds (auto-release backstop wakes survive the
  holder's death — review P1), D.5 route family (snapshot/enqueue/
  take/takeAll/full-permutation order/item+session delete/hold;
  409 in-flight; every reply carries directory incl. emptied queues)
  + `notnative:message-queue.updated` broadcast on the control stream,
  alphabetical reconcileAll + startup load-then-reconcile.
  Adversarial review (ses_f3d3abec2ffeaO2aJ2zinI31je) fixed P1×3 + P2×2:
  P1 held queues strand forever when the asserting UI dies (schedule
  the expiry's own wake), P1 write-disable re-enable was dead code
  (reconcile probes now), P1 delete replies could drop the directory
  (memory-only entries); P2 take-over-empty bumped revisions, P2
  abort stamps never vacuumed. Registered E-09-1..14 (brand rows,
  knowledge seam, quiet-coalescing earliest-arm, catalog load
  degrades to prose, feed stop posture, legacy id/createdAt parse).
  Builder agent (ses_f3dba4e26ffePW1CAscFFAL7t8 + fixer
  ses_f3d56f27dffeTQu3hrCWPtTDSj; adversarial ses_f3d3abec2ffeaO2aJ2zinI31je).
  web 585 tests (+74 across 5 suites) · ui 608 (+0) · typecheck ×4 ·
  gates green — seal 20260920-6.

- 2026-09-21 · **Build-path repair + build gate (assessment slice).** Full independent
  verification of 20260921-2: typecheck ×4 green · ui 608/608 · web 586/586 ·
  gates+smoke+graph green · seal manifest honest (release:check green pre-edit).
  The only real failure: `pnpm build`. `packages/web/src/index.css` imported
  `../ui/src/styles/design-system.css` — resolves to the nonexistent
  `packages/web/ui/…`; the line was BORN wrong at P5-1 (2026-09-16, verified in
  commit 3f70fc6) and rotted unnoticed because no seal since P1 actually ran
  `vite build` (release-gates only spawns quality-gates + smoke; D7: the builder
  sandbox could not spawn esbuild). Fix: `../../ui/src/styles/design-system.css`
  (the vite JS alias `@notnative/ui` does not apply to Tailwind's CSS resolver).
  Gate hole closed: `scripts/release-gates.js` now runs the web production build
  via the web package's own vite CLI (dist stays manifest-excluded). The seal
  machinery proved honest both directions: it flagged the pre-fix mismatch and
  required this re-seal. Adversarial sub-agent audit ran before the seal.
  Sealed as 20260921-3. New `docs/build/EVALUATION.md` seeded with the
  verified-working / known-broken matrix this assessment produced.

- 2026-09-22 · **P12a installable shell — FIRST INSTALL ON THIS SYSTEM.**
  Electron v1 subset (doc 09 + NOTES/09 D-09-1..15): in-process server (never
  sidecar), port stored→57123→ephemeral via test-bind before bundle import,
  env set pre-import, loopback-only, splash→health→navigate boot chain,
  preload allowlist + sender framing, NSIS oneClick perMachine unsigned.
  Pipeline `scripts/electron-package.mjs`: vite → stage web-dist → esbuild
  server (node-pty the lone external; createRequire banner + bundle audits)
  → sibling-data staging → electron-builder → installer + sha256. First
  packaged boots exposed three packaged-only defects no source-checkout gate
  could see: selfDir() file-vs-directory (boot died "bundle missing
  app.asar\main.mjs\…"), ESM bundle without require for CJS deps (ws →
  "Dynamic require of events"), runtime settings-registry.json unstaged
  (ENOENT). All fixed + regression-guarded in the pipeline. Version surface
  unified (NOTNATIVE_APP_VERSION, D-09-12). Independent verification on
  hardware: silent /S install (and silent uninstall — dir gone), boot chain
  in main.log, /health 200 version=20260921.0.3, / 200, /assets 200, port
  persisted; terminal-create degrades to a clean JSON error (node-pty
  unshipped by design, D-09-5 — P12b ships it). App left RUNNING on :57123
  for user evaluation. Adversarial audit: auditor stalled after the 3-defect
  proof chain; orchestrator completed probes (pty shape live-probed, IPC
  framing, port TOCTOU, dual-instance dataDir, version surfaces) — five
  residuals registered in NOTES/09 §B2, none release-blocking. Builder
  agent stalled mid-verify and was takeover-released; both its fixes and the
  orchestrator's landed green. web 586/586 · ui 608/608 · typecheck · gates
  + graph (336 modules) · installer sha256 53de3fa76c9ec36d66fb502c0dae7602
  a0d3a46505400b551573f37566c4075d. Sealed as 20260921-3.

- 2026-09-22 · **P9-2a PARTIAL — goals core layer committed; goal rounds exhausted.**
  Session-goal runtime arrives in two steps; this commit ships the foundation
  and an exact resume map. ON DISK + SEALED (20260921-4): `goals/goal-constants.ts`
  (§B.2 all twelve constants verbatim, settle reasons, notification titles),
  `goals/goal-payload.ts` (§B.1 schema, tolerant-bounded parse, clamps,
  objective-file id shape validated BEFORE fs, `${ts36}${rand6}` goal ids),
  `goals/goal-metadata.ts` (namespace-preserving read-modify-merge for
  PATCH /session/{id}, goal-only removal that keeps sibling keys, §B.5.1
  id-guard), `goals/goal-state.ts` (T1–T17 as pure payload transforms —
  arm/pause/resume/reactivate/settle/continue, refusal-as-null contract,
  settle always resets both streaks). Tests: builder's p9-2a-goal-payload
  suite + orchestrator's p9-2a-goals-core (25 tests incl. the constant pin,
  hostile-input clamps, fs-shape guard, T17 refusal, 20-continue counter
  alignment, resume-fresh-tolerance). One defect found by the new tests and
  fixed: armGoal accepted an objectiveless goal the parser would later
  disown. web 644/644 (43 files) · typecheck · gates+graph(340) · smoke ·
  build green; NOT UI-touched.
  RESUME (P9-2b, next session): tick runtime B.5 (quiet windows, gates in
  evaluation order, accounting B.5.4), evaluator exchange + small-model
  module (doc 02 §7.4 + injectable provider seam + deterministic mock),
  mock session-metadata persistence (store has only time.*), routes
  (arm/pause/resume/clear + objective PUT/GET/DELETE) into app.ts,
  createSessionGoal + B.6 prompts, deferred-by-order items: T9/B.5.6
  length-recovery, truncation derivation edges, SSE, notifications. Then
  P9-3 scheduled tasks (doc 12 §C 606–935; §J items 3–6; hinges: two
  processes ≠ double-run, DST cron equality, once→enabled:false), P9-4 UI
  batch (queue D.6–D.8 + goal controls B.8 + task dialog), P9-5 multi-run/
  fusion (E) + F.1, P10 doc 15 (§M checklist, 1928), P11 doc 13 (§L, 1013),
  P12b (tray, openchamber://connect verbatim, updater, node-pty shipping,
  stale-dist build-stamp), P13 integration verify. The P12a installer remains
  installed and running on this machine.

- 2026-09-22 · **P12b-1 tray + scripted source install (user directive pivot).**
  User: the packaged NSIS flow is not intuitive; the GUI is nearly empty.
  Deliverable 1 landed: repo-root `install.ps1` (row-bot action-pattern
  parity) copies source → `%LOCALAPPDATA%\NotNativeDesktop`, pnpm-installs,
  repairs electron postinstall, runs `electron-package.mjs --no-nsis`
  (artifacts only), stamps the scripted-install identity marker, and creates
  Desktop + Start Menu shortcuts; `install.sh` written for POSIX parity
  (UNVERIFIED on this host — no bash/WSL distro; registered). Tray slice in
  `packages/electron/tray.mjs` mirrors the reference launcher: status
  feedback (starting/running/stopped icon+tooltip), menu [Open App (default)
  | Open Web UI in Browser | status | Quit], close-hides-to-tray (service
  outlives window), Quit = dispose→quit→8s watchdog, boot-failure stays
  alive in stopped state when trayed. Icons generated dependency-free
  (`scripts/electron-tray-icon.mjs` raw PNG encoder). IPC invoke face
  extracted to `ipc-face.mjs` (file cap). Scripted install gets product
  identity via `install-mode.txt` (userData `%APPDATA%\NotNativeDesktop`,
  AUMID without `.dev`) — repo checkout and installed copy co-exist. Version
  surface fix: unpackaged `app.getVersion()` returns the ELECTRON version
  (probed: /health said 44.4.3) — main now reads the root manifest
  (probed: /health 20260921.0.6). Live evidence: full scripted install
  executed (exit 0: copy/pnpm/build green/2 shortcuts), launched VIA the
  desktop shortcut, boot chain in `%APPDATA%\NotNativeDesktop\logs\main.log`
  (port fallback 57123→61776 while repo-dev instance held 57123, tray line,
  server ready, window navigated), /health 200 + /assets 200. Pipeline
  failures en route and fixed: PS parser mojibake (em dash → pure ASCII),
  and the big one — vite/pnpm stderr under $ErrorActionPreference=Stop
  aborted install.ps1 twice (NativeCommandError); native calls now route
  stderr to log files via a Continue-region helper (Invoke-Native), exit
  codes authoritative. D-09-16/17 registered. NOTE: running app predates
  main.mjs version fix → installed copy patched in place (single-file copy),
  full tree refresh lands with the next reinstall. Deviation registered:
  this infra slice is behaviorally verified; the adversarial audit agent
  fires on the committed tree next round (fixes land as follow-up).

- 2026-09-22 · **P12b-2 GUI-PLAN sweep delivered + SLICE-A `chat-alive` wiring
  (user directive #2 begins).** Sweep agent delivered GUI-PLAN.md (index) +
  Sections 1–4: wanted feature inventory W-01…W-113 with doc cites,
  file:line-verified current state (top reason the GUI looks empty: boot never
  opens a session — the restore pair had zero call sites), OpenChamber port
  map, and the ordered slice plan A→G. SLICE-A implemented in-session:
  `openInitialSession` (engine-instance.ts) priority chain — existing
  selection wins; validated last-active pointer (exists in the authoritative
  list AND same directory); non-archived seeded welcome demo; else honest
  empty draft — executed after the initial resync resolves; boot-open also
  enqueues the message tail load (`'boot-open'` added to
  MaterializationReason) so the transcript doesn't skeleton forever (found:
  NOTHING loaded session messages on sidebar click either — events/child
  pivots were the only enqueue sources). Restore pair fully wired:
  onSelectSession + MainLayout open/openDraft call
  persistLastActiveSession. Welcome mock copy refreshed. Tests
  sync/__tests__/parts-boot-open.test.ts 7/7; ui 615/615 (65 files,
  worker-capped under memory pressure); typecheck ×4 green (cross+server
  clean, ui+web-ui green after reason-union fix). Live: artifacts rebuilt,
  redeployed to the installed tree (dist + assets + version source),
  relaunched via shortcut; /health `20260922.0.1`; boot chain green; bundle
  contains the boot-open reason. GUI-PLAN marked SLICE-A task-1 landed.
  NOTE: `desktopUiPassword` is now set on this machine (sweep observed
  04:48Z) — the installed app boots to the auth gate by design.

- 2026-09-22 · **P12b-3 SLICE-B `review-band` + installer audit fixes + web-only
  runner + hidden boot (seal 20260922-3).** Builder delivered SLICE-B 7/7
  guarantees: Files tree with git status dots/badges + 15 s visible-gated
  cadence + hint-driven restat; Diff per-scope stacks with >500-line gate +
  scope-aware single-hunk apply (version-locked against the server contract) +
  §5.8 scroll anchoring; Git stage/unstage/discard/commit optimistic with
  rollback; worktrees verified; Terminal seam un-stubbed
  (`createRealTerminalApi` over the PTY transport singleton, web RuntimeAPIs);
  review panes bound to the ACTIVE harness directory (`'/'` literal removed);
  refresh-hints bus + buffered hidden-window replay wired through Files/Diff/
  Git/FileTree (+ store applyStatus/invalidateStatus). ui 646/646 (73 files),
  web 644/644, tsc ×4 zero, gates 350 files, graph 350 modules; builder
  deferred §6.7 checkout/merge/stash routes, untracked-diff render, retained
  hidden panes, hunk kbd nav, i18n sweep, shared poller (all in the notes
  file). Adversarial audit of P12b-1 landed its approved fix set: honest tray
  stopped label, terminal boot-failure page (no splash forever; Open App no
  longer re-splashes), crashed-renderer reload, running-service guards +
  graceful purge reporting, robocopy stdout diagnostics, -SkipBuild
  completeness + staleness warning, artifacts integrity oracle
  (deterministic digests, live-verified), artifacts-mode skips dead
  web-dist staging, install.sh parity set (static-only), NOTES/09 D-09-12/16
  corrected + D-09-18 registered. Web-only runner scripts/web-serve.mjs
  (user-requested preview without the desktop window); auth-gate copy
  registered i18n-side (useOptionalI18n + GATE_KEY + drift test). New:
  `--hidden` electron boot (tray-only first paint; boot FAILURE still shows
  its page deliberately). SLICE-A loop live-proven on the wire (23 deltas,
  status transitions, abort → MessageAbortedError → idle) against the
  web-only preview at :58080.

- 2026-09-22 · **P12b-4 SLICE-C `session-product-b` (seal 20260922-4).** User
  confirmed the whole loop in their own testing ("double-click → tray →
  window → backend connects — so it's a start") → GUI depth continues.
  Builder landed all 5 slice tasks: tool cards
  (chat/tool-cards.tsx + markdown-lite.tsx hardened dependency-free
  renderer) with running/settled/error states, JSON view modes, live bash
  output pane; mock tool-demo lifecycle (`tool`/`bash`/`fail` triggers, full
  event chain inside doc-02 shapes); sidebar product — folders store +
  collapsible zones + archive/restore + REAL session rename (stale P4 toast
  deleted); blocking cards per doc 05 §F (bash/edit/write/webfetch bodies,
  Alt-stack reply semantics, question tabs + Summary with [[label]]/custom
  Other rule, honest 404); server-owned message queue UI
  (useMessageQueueStore: revision-gated snapshots, optimistic add with
  restore, full-permutation reorder, take-for-input, clear + follow-up
  steering setting) with composer QueueChipsRow + broadcast wiring; timeline
  fork-from-any-turn (fill-not-send, ESC-first close) + reactive prompt rail
  with hover preview. Truth: ui 683/683 (79 files, +37 confirmed twice),
  web 648/648 (44 files, mock tool-trigger tests), tsc ×4 zero, gates 357
  files, graph current. Deferred in notes: §6.7 server auto-accept runtime,
  queued attachments envelope, hold/take-all chips, rail windowing,
  timeline-dialog dedicated test file. Install channel: build-step stdout
  now captured (build-out.log) so artifact integrity digests surface during
  installs; failure diagnosis is tail-first.
- 2026-09-22 · **P12b-5 SLICE-A acceptance closed — the installed app now
  boots ALIVE (user report: "all I see is … No session selected").** User's
  installed copy ran a 09:54 UI bundle (installer robocopy had skipped fresh
  web dist) — but TWO real defects were hiding underneath and are now fixed
  with observation-verified acceptance (fresh headless profile, prod server,
  CDP drive): (1) sidebar lifecycle ordering STRIPPED session records down to
  {id,parentID,time} before sorting, so every row rendered "Untitled
  Session" and row-open lost its directory — orderSessionsByLifecycle is now
  generic/identity-preserving and the wrapper returns the ORIGINAL
  objects (session-ordering.ts, chat/session-sidebar.tsx:257); (2) boot-open
  raced its decision: `recovery.resyncDirectory('initial')` short-circuits
  on a fresh boot (zero reconnect candidates), so the .then fired against an
  EMPTY list and the Welcome fallback never matched — new
  sync/boot-open-readiness.ts `awaitAuthoritativeList()` waits for
  `sessionListSource === 'authoritative'` (bootstrapDirectory sets status
  'complete' BEFORE phase 3), failure, or a 6 s cap before
  openInitialSession runs (engine-instance parts rewired). Verified live
  end-to-end on the mock harness: boot auto-opens the seeded welcome session
  (real title, real directory), full transcript renders, and the session
  tab strip shows the open tab; unthrottled window streams the typed turn with the busy chip
  ("mock-smart is preparing"/"weighing options…") and deltas settle in <1 s;
  mid-flight `stop` button exists and clicking it settles the turn with the
  doc-05 aborted error face ("The running turn was aborted"); reload restores
  the same session with history via the persisted pointer. Truth: ui
  689/689 (80 files, +6: readiness ×5 + ordering identity ×1), web 648/648,
  tsc ui+web targets green, gates 358 files, graph rebuilt current,
  smoke:test passed (ses_kx05yrgx). Mock welcomeSeed copy already honest
  (mock status + NNA next + demo triggers) — left unchanged. Registered
  defect observation (non-blocking): mock harness answers 400 to the §9.4
  `/api/global/event/ws` upgrade, pipeline falls back to SSE per design
  (WS_FALLBACK_WINDOW_MS) — NNA adapter owns the real WS bridge (D16).

## Delta/Delayed register

- **2026-09-30 · P11-31 walkthrough model readiness (seal 20260930-15).**
  Walkthrough now resolves one bounded model snapshot from provider inventory,
  credential evidence, harness config, `walkthroughModelOverride`, and the
  captured digest. The readiness endpoint rejects malformed source admission and
  reports the corresponding empty, generated-only, no-model, no-login,
  unsupported-JSON, or context-budget refusal explicitly.
  NND sends the selected `providerID/modelID` to NNA, requires response
  attribution to match session and request, and isolates durable-cache and job
  keys by that model; progress/cancel now carry the same model. The UI exposes
  Default chain/catalog pickers, persists the feature override, shows bounded
  readiness, and retains the pending model across picker changes. Windows
  context budget uses bounded `context - output`; public API-key sentinels are
  not treated as logins. Adversarial audits fixed the
  context/cache/job/progress races and malformed IDs. Truth: pnpm check 583/583
  production files, graph current for 583 modules, all typechecks green, UI
  1414/1414 (167 files, +2 focused readiness/lifecycle tests), web 1226/1226
  (103 files, +17 focused readiness/generation/progress/cancel tests). Remaining
  walkthrough work: richer chapter/stop schema, direct small-model transport,
  and P12b installed-GUI acceptance.

- **2026-09-30 · P11-33 direct small-model walkthrough transport.** Walkthrough
  generation now uses the web server's bounded OpenAI/Anthropic/Google transport,
  with request cancellation, timeout classification, provider attribution,
  readiness/context budget checks, and cache/job identity bound to the selected
  model. The legacy NNA transport remains available to existing injected route
  callers. UI reports unsupported providers explicitly. Adversarial review found
  the Google request omitted `systemInstruction`, so the direct request lost the
  instruction treating diff text as untrusted; it now carries the instruction
  alongside the structured response format. The focused walkthrough and
  small-model tests pass (23/23), the full web suite passes (1252/1252), and
  the UI suite passes (1456/1456) with workspace typechecks green. The snapshot
  integration test now has a 15-second budget because Windows Git process
  contention exceeded its former 5-second default during the full suite.
  Quality gates and the 602-module graph pass; artifacts-only Electron packaging
  succeeds at version 20260930-84.

- **2026-09-30 · P12 packaged UI protocol.** Packaged Electron now serves UI
  assets through `notnative-ui://app`, with root-confined path resolution,
  extensionless SPA fallback, asset MIME/cache preservation, and strict
  authority validation. Runtime API, SSE, socket, and file/image requests use
  the loopback server origin. Exact-origin CORS admits the packaged renderer;
  only its UI session cookie receives `SameSite=None; Secure` so the cross-site
  loopback fetch can authenticate. A bundled Electron probe confirmed the
  cookie behavior. Adversarial review found and fixed relative API paths and a
  terminal WebSocket origin bug. Focused UI tests 51/51, web security tests
  26/26, typechecks, Electron syntax checks, and protocol tests 5/5 passed.
  Full suites also exposed pre-existing incomplete walkthrough-schema fixtures
  (UI 1419/1422, web 1234/1236); those are registered for the next slice.

- **2026-09-30 · P11 walkthrough schema closure.** The chapter/stop/hunk
  fixtures now match the bounded generated-response contract, readiness tests
  pin unsupported-provider precedence separately from context-budget refusal,
  and prompt assertions inspect the decoded user message. The adversarial audit
  found that cache validation trimmed legal Git filenames; cached paths now
  preserve exact bytes and reject a supplied malformed `oldPath` while still
  allowing the field to be omitted. Full UI tests pass (1422/1422), full web
  tests pass (1238/1238), and all workspace typechecks pass.

| # | Item | Phase landing | Note |
|---|---|---|---|
| D1 | Mock harness semantics | P1 (doc 02) | P0 ships `/health`,`/auth/*`,`/api` proxy + control SSE only |
| D2 | Real auth (password/passkey) | P8/P12 | ✅ Local password/passkey auth and desktop credential issuance shipped; relay/tunnel flows retain their separately documented credential limits. |
| D3 | PWA manifest endpoint, SW update UX | P4 | ✅ Web manifest endpoint is linked; browser-only service-worker updates show a user-approved Reload action. |
| D4 | GitHub/Linear/push integrations | P3/P4 | API members stubbed behind RuntimeAPIs optional fields |
| D5 | Git/files RuntimeAPIs bodies | P6 | All shared Files methods and 13 existing Git operations route through RuntimeAPIs; the web adapter supplies the scoped server clients. |
| D6 | Electron globals/boot outcome | P12 | ✅ Runtime globals are injected and bounded boot-target outcomes are covered by desktop-boot tests; packaged GUI acceptance remains open. |
| D7 | dev loop (`pnpm dev`) verification | P0 | ✅ Verified in the current workspace: API `/health` and Vite UI both returned HTTP 200 on isolated ports. |
| D8 | `system` theme variant via matchMedia | P5 (doc 14) | ✅ System mode tracks `matchMedia` changes in both directions (ThemeProvider tests). |
| D9 | PWA manifest link + install/push hooks | P4/P11 | ✅ Manifest endpoint/link, 192px/512px icons, and browser Install/Dismiss prompt shipped; packaged-app routing tested. Push notifications remain open. |
| D10 | mobile surface | long-term | renders desktop tree + console warning |
| D11 | control-stream consumers | P2 (doc 04) | Baseline sync, queue/interruption, memory, and scheduled-task consumers are shipped; new event types add consumers with their owning slices. |
| D12 | bare harness payloads | P1 | `{data,error,response}` synthesized in UI facade; v2 surface keeps `{data}` on the wire |
| D13 | seam renames | P1 | `x-nnd-directory`, stdout line `notnativeagent server listening on <URL>`, `NNA_*` env, `notnative:*` control events — coordinated pass pending NNA |
| D14 | mock scope boundary | P1 | mock = §12.1 + early §12.2 items; lifecycle/spawn/Basic-auth (P-01/03/22) belong to the future NNA adapter, not the mock |
| D15 | wire-name duplication | P1 | `server/lib/harnessNaming.ts` mirrors `ui/lib/nna/constants.ts`; both files change together |
| D16 | WS event bridges | P2 (doc 04) | P1 ships SSE only; §9.4 WS frame vocabulary recorded in NOTES/02 |
| E1 | typographyWatcher static-sheet substitution | P5-1..3 done | ✅ Static-sheet values match; root `rem` scaling and appearance application are implemented in settings/apply. |
| E2 | non-EN locales partial catalogs w/ en fallback | P5-4 | per-locale parity = authoring work; resolve chain per doc 14 §H.2 |
| E3 | 38 preset palettes self-authored seeds | P5-2 done | originals untranscribed (doc gap §M); NOTES/14 C.1/E.2 interpretation recorded |
| E4 | iframe theme sync + VS Code adapter | defer (P10/P12) | no embedded/vscode surface until those phases |
| E5 | custom-theme import UX (Appearance→Reload) | P5-3 | ✅ Appearance exposes Reload; the client reloads validated themes from GET /api/config/themes. |
| E6 | syntax/terminal/diff theme consumers | P6/P7 | ✅ Terminal PTY appearance, fenced-code palette, and diff semantic colors follow the active theme (2026-09-30). No Shiki renderer is present in this build. §E.8 conversion contracts recorded in NOTES/14 |

- **2026-09-30 · P12 managed SSH bundle foundation.** Added a bounded,
  platform-neutral gzip/USTAR payload builder for the verified server bundle,
  settings registry, runtime manifest, launcher, and web assets. The builder
  preflights source metadata, caps total archive size and entry count, and
  rejects symlinks and unsafe archive paths. This prepares artifact transfer;
  managed SSH setup/start now consumes the payload through the transport and
  lifecycle. Focused tests cover bundle contents and resource bounds; real
  remote-host acceptance remains open.

- **2026-09-30 · P12 managed SSH artifact transfer.** Added a bounded SSH
  uploader that streams the archive on stdin to a fixed remote `tar` command,
  stages each attempt under a fresh private directory, and enforces SSH
  forwarding/agent/X11 restrictions. Transfer is now implemented and tested;
  remote dependency installation, startup supervision, and readiness handoff
  are now connected to the SSH transport and exposed through an explicit UI
  opt-in. Managed mode requires a Unix-like remote with Node.js 22.18+ plus
  npm or bun; the normal tunnel health check gates ready status. `keepRunning`
  records per-instance remote ownership and rediscovers the existing server
  after a desktop restart. Portable tar interoperability is verified against
  Windows bsdtar; real remote-host acceptance remains open.
- **2026-09-30 · P13 shared settings arbitration.** Settings mutations from
  both HTTP route families now take the shared cross-process config lock and
  reread the canonical document after acquiring it. Lazy preference seeding
  publishes with atomic no-replace semantics, preventing an unlocked GET from
  overwriting a concurrent PATCH. A two-process regression preserves disjoint
  concurrent updates; the seed publisher was verified on Windows/NTFS. Full
  web tests pass (1248/1248) and web typecheck passes.
  Queue dispatch arbitration is now delivered; installed GUI acceptance
  remains open.
- **2026-09-30 · P13 queue arbitration audit.** Confirmed that two servers can
  load and dispatch the same persisted head because the in-flight marker was
  process-local. The follow-up implementation adds shared queue mutation locks
  and per-session dispatch claims; restart remains at-least-once if a send was
  accepted upstream before its durable removal.
- **2026-09-30 · P13 origin-gate smoke precision.** Adversarial review found
  that the source smoke's rejected request used `text/plain`, allowing the
  content-type validator to mask a missing origin check. It now sends valid
  JSON with `Origin: null`; the NNA source integration smoke passes with that
  isolated assertion. The in-process smoke still does not cover NND's listener,
  auth middleware, Electron, or installed GUI behavior.
- **2026-09-30 · P13 cross-process queue arbitration.** Queue API reads and
  mutations now refresh and serialize under the queue file's shared lock.
  Per-session OS-visible claims prevent simultaneous sends and protect the
  active head from take, delete, reorder, clear, and capacity eviction across
  runtimes. Claims survive ordinary retries, release on disposal so durable
  items can replay after restart, and are reclaimed when the owner PID exits.
  Adversarial review fixed reorder/head mismatch, deleted-session claim leaks,
  and stale failure retries. Queue suites pass (78/78); full web suite passes
  (1251/1251); workspace typechecks pass. Delivery is at-least-once across an
  upstream-accepted POST whose acknowledgment is lost. Holds/backoff remain
  per-runtime by the existing queue contract.
- **2026-09-30 · P13 Windows test-worker bound.** Vitest now caps package suites
  at four workers by default. The unbounded UI command exhausted this host's
  memory and OS threads; with the cap, the normal `pnpm --filter @notnative/ui
  test` and web test commands both pass (1456/1456 and 1252/1252). Workspace
  typechecks and the web production build pass; adversarial review found no
  config/glob defect. Version 20260930-85.
- **2026-09-30 · P12 managed SSH archive interoperability.** A real system-tar
  round trip exposed malformed USTAR headers: the magic/version fields had
  been written into the checksum area. The builder now writes canonical
  USTAR magic, version, and checksum fields. Windows bsdtar lists and extracts
  the generated archive with content checks; adversarial review found no
  remaining defect. Real remote-host acceptance remains open. Version
  20260930-86.
- **2026-09-30 · Deferred-register evidence refresh.** Reconciled auth,
  desktop boot, system-theme, event-consumer, typography, and custom-theme rows
  with current implementation and tests; narrowed the RuntimeAPIs stub row to
  Git/files. The current `pnpm dev` loop was exercised on isolated ports: the
  API health route and Vite UI both returned HTTP 200. Focused evidence suites
  passed (143 tests across UI, web, and Electron). Version 20260930-88.
- **2026-09-30 · P12 web RuntimeAPIs files adapter.** The required scoped
  directory-list, search, and directory-create methods now delegate through
  the web runtime adapter to the shared filesystem client. The full web suite
  passes (1253/1253) and workspace typechecks pass. The rendered Files view
  still calls that shared client directly; moving its consumers behind the
  RuntimeAPIs seam and wiring Git/optional file methods remain open. Version
  20260930-89.
- **2026-09-30 · P12 Files runtime-neutral facade.** All shared UI Files
  consumers now call through the registered RuntimeAPIs adapter, and the web
  adapter implements the complete existing Files client surface. File errors
  are transport-neutral. Full UI tests pass (1457/1457), full web tests pass
  (1253/1253), and both package typechecks pass. Git RuntimeAPIs remains
  deferred. Version 20260930-90.
- **2026-09-30 · P12 Git runtime adapter.** The complete existing 13-operation
  Git client now has a typed RuntimeAPIs contract and runtime-neutral facade;
  the web adapter delegates to the existing scoped server client. Git status
  derivation stays transport-free. The adversarial review found no confirmed
  defects. Full UI tests pass (1458/1458), full web tests pass (1254/1254), both
  package typechecks pass, and the production web build is covered by release
  gates. Version 20260930-91.
- **2026-09-30 · P4 PWA manifest discovery.** The HTML shell now links the
  existing manifest endpoint. Adversarial review found the custom Electron UI
  origin could not serve the API-generated manifest; the protocol now forwards
  only that exact route, preserving query parameters and HEAD. Manifest route
  tests pass (2/2), Electron protocol tests pass (6/6), web suite passes
  (1256/1256), and web typecheck passes. Install/push hooks and service-worker
  update UX remain open. Version 20260930-92.
- **2026-09-30 · P4 PWA update UX.** Browser-hosted web sessions register an
  update-only worker and can explicitly activate a waiting version from an
  accessible toast. The worker leaves fetch/auth traffic network-owned.
  Adversarial review fixed cross-tab activation and superseded-waiter races;
  full web tests pass (1260/1260), web typecheck passes, and release gates pass.
  Version 20260930-93.
