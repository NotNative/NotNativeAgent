# 13 — Preview and inspection build notes

## P11-1: live dev-server discovery (2026-09-26)

- Windows `netstat -ano -p TCP` is the first scanner backend. It is bounded to
  2500 ms, reports an unavailable scan distinctly from a successful empty
  result, and caches only successful scans for 3000 ms. Loopback/wildcard
  listeners are deduplicated by port, then the NND and managed/attached NNA
  ports, this process, and the doc-13 infrastructure set are excluded.
- The authenticated `GET /api/dev-servers` route answers a list or 503. The
  browser panel polls only while its empty state is visible; no candidate
  causes navigation without a user click. It validates canonical local URLs.
- A viewer using a non-loopback app origin cannot safely use a host-local
  `localhost` URL in an iframe; suggestions are suppressed until P11's remote
  preview tunnel exists. A loopback port-forward to a remote host cannot be
  distinguished by browser origin alone and remains a P11 tunnel concern.
- Linux/macOS listener backends, announced URLs, probe-url, Chromium webview,
  annotation, agent browser control, and walkthrough are not in this slice.

Verification: focused server and UI tests, both packages' typechecks, full
suite, graph, source smoke, and release gates.

## P11-2: loopback startup probe (2026-09-26)

- Authenticated `POST /api/system/probe-url` accepts only HTTP(S) URLs whose
  canonical host is `localhost`, `127.0.0.1`, or `[::1]`; credentials are
  refused. A 1500 ms GET uses manual redirects and no credentials. Any HTTP
  response (including a gateway 5xx) proves a listener answered, whereas a
  connection failure reports `ok:false` without failing the route.
- `0.0.0.0` is rejected: it is a wildcard bind address, not a loopback
  destination. This follows doc 13's loopback-only invariant and intentionally
  narrows doc 03's older host allowance.
- The browser's sandboxed iframe consumes this route in P11-3 below;
  Chromium/webview lifecycle and tunnel work remain P11 follow-ups.

## P11-3: browser startup wait (2026-09-26)

- Explicit user navigation to a loopback URL under a loopback app origin
  starts a readiness poll before the sandboxed iframe mounts. A 2xx–4xx
  answer mounts the frame; a gateway 5xx keeps the startup overlay for up to
  20 seconds before exposing the response. Connection refusal retries on a
  two-second cadence for up to 30 seconds, then shows Retry.
- An unavailable probe API is shown separately from a slow local server.
  Changing history, reloading, hiding the panel, or unmounting aborts the
  stale request and clears timers. Remote/LAN app origins skip the host-side
  probe because the viewer's loopback is not the NND host's loopback. A
  loopback-origin SSH port forward cannot be distinguished from a genuinely
  same-machine browser by origin alone, so host-local discovery/readiness may
  target the wrong machine in that setup until the preview tunnel exists.
- This is startup readiness only, not Chromium inspection, screenshot,
  annotation, or a remote preview tunnel.

## P11-4: isolated Electron guest preview (2026-09-26)

- The desktop Browser surface now mounts an Electron `<webview>` after the
  existing user-directed navigation and loopback readiness gate. The web
  runtime keeps the sandboxed iframe. Desktop HTTP is limited to loopback;
  HTTPS sites are allowed. Agent browser control is not advertised.
- The guest uses an in-memory `nnd-preview` partition. The main process
  rejects alternate partitions before attach, strips renderer-supplied
  preloads, enforces Node-off/context-isolated/sandboxed/web-security-on
  preferences, denies permission requests/checks and new windows, and
  prevents app-origin resources and unsafe top-level navigation. Electron
  identity is exposed by preload before the first UI script, eliminating
  the previous dom-ready identity race.
- The explicit Electron Builder file list includes the new guest-policy
  module; adversarial review caught that packaging requirement. The unsigned
  Windows NSIS package and packaged terminal/HTTP/WebSocket smokes passed;
  the ASAR contains the policy module. Pure policy tests and desktop UI tests
  cover the boundary. Installed GUI rendering,
  guest navigation lifecycle, DevTools, capture, annotation, remote tunnels,
  and NNA-granted agent control still need separate verification/slices.

## P11-5: desktop guest navigation lifecycle (2026-09-26)

- Successful top-level and same-page guest navigations update the address and
  browser history without recreating the webview or restarting its initial
  loopback-readiness probe. An explicit Go, back/forward, or Reload creates a
  fresh guest at the selected URL; the non-Electron iframe path is unchanged.
- Main-frame load failures are shown in the browser chrome; aborted loads and
  subframe failures do not masquerade as page failures. A stopped guest
  renderer is reported with a manual Reload path. When a hidden pane destroys
  its guest, the latest navigated URL is restored on reveal. Adversarial
  review caught that restoration requirement.
- This does not yet implement Chromium crash auto-retry, page-title/favicons,
  DevTools, capture/annotation, remote tunnels, or NNA agent control.

## P11-6: user-requested page snapshot (2026-09-26)

- The desktop guest now offers an explicit Inspect page control. A self-contained
  read-only script runs inside the guest and returns a capped visible-text and
  interactive-element summary: 6000 text characters, 120 elements, 80-character
  labels, bounds, and explicit total/truncation counts. It does not read form
  input values or host application state. Non-desktop iframe preview does not
  expose this control.
- Guest results are validated after crossing the process boundary. Navigation,
  hide, reload, and guest crash invalidate pending inspections; an unresolved
  script times out at 15 seconds. Adversarial review fixed stale same-URL
  results, a stuck busy control, and unbounded guest URL/title fields.
- This is a local user-facing DOM summary, not NNA agent control. The NNA tool
  callback, capability-scoped broker, screenshot capture, and annotation still
  require separate slices.

## P11-7: in-process browser-control broker (2026-09-26)

- A server-owned broker now models ten browser actions, per-request ids,
  desktop-client capability registration, claim-before-action ownership,
  exact-owner results, timeout/abort settlement, and disconnect/disposal.
  `browser.open` can reach a panel opener; other actions require a capable
  desktop client. Claims are limited to clients that actually received that
  request, not clients that registered later.
- The adversarial review fixed delivery/claim races and made failures after
  an accepted mutating action explicitly indeterminate, preventing a caller
  from assuming a timed-out or disconnected action changed nothing.
- This is deliberately in-process and not yet exposed as an HTTP route. The
  Electron IPC bridge must bind claim/result to the authenticated desktop
  connection identity; a requester-supplied client id must never grant a
  capability. NNA tool registration and page-action execution remain next.

## P11-8: desktop broker bridge (2026-09-26)

- The running server now hands its one broker to the Electron main process.
  Only the top-level NND frame can register a capable client through preload;
  main derives its broker identity from `event.sender.id`, never renderer
  payload. The isolated guest has no preload. Request, claim, and bounded
  result messages stay on this IPC path; no browser-control HTTP route or
  query-token capability was added. A direct invoke-face test verifies that
  child frames cannot register and that claim/result ignore a spoofed client
  id in renderer payload.
- The visible Browser pane registers and can answer `browser.open` and bounded
  read-only `browser.snapshot`. Other actions return a clear unsupported
  result. A hidden/unmounted pane unregisters, and main drops its broker client
  on main-frame reload, renderer crash, or window destruction. Snapshot work
  is bounded to 15 seconds and stale results are suppressed. Adversarial
  review caught these lifecycle cases and listener cleanup.
- This is still not an NNA tool. The tool callback and policy/governance
  registration remain required before an agent can issue a request. Installed
  GUI behavior has not yet been confirmed visually.

## P11-9: governed NNA desktop browser tool (2026-09-26)

- The managed NNA child receives a one-process loopback callback URL and a
  fresh secret. NND accepts only `browser.open` and read-only
  `browser.snapshot` at that private callback; normal UI sessions, URL tokens,
  and attach-mode NNA cannot invoke it. The callback hands actions to the
  same identity-bound desktop broker used by Electron's top-level frame.
- NNA registers `nnd_browser` only for its NND integration sessions. It uses
  the ordinary tool catalog, exact-name search lease, governance review,
  cancellation, and audit path. Open URLs are HTTPS or numeric-loopback HTTP
  without embedded credentials; the callback response is byte-bounded.
  A disconnected or hidden desktop fails explicitly. Adversarial review
  found that retaining the callback secret in NNA's process environment
  could expose it to later child processes; NNA now consumes and removes
  the environment pair during integration startup.
- This first governed slice advertises only actions the Browser pane actually
  implements. Click/type/scroll, screenshot capture, element annotation,
  remote-browser relay, and walkthrough remain P11 follow-ups. NND's web
  shell still has no embedded guest-control capability.

## P11-10: read-only computed-style inspection (2026-09-26)

- `nnd_browser { action: "inspect", selector }` now reads one element from the
  isolated desktop guest. The script accepts a bounded CSS selector as data,
  uses `querySelector` without evaluation, and returns a small computed-style,
  label, and bounding-box record. Input values, cookies, and arbitrary page
  globals are not read.
- NNA, the private callback, and the desktop pane each validate the action.
  The renderer checks guest identity and current navigation before returning
  a result; invalid selectors, absent elements, and disconnected panes fail
  explicitly. Adversarial review caught editable draft text leaking through
  `textContent` used as a label; editable controls and descendants now omit
  text-derived labels. Click/type/scroll and visual capture remain pending.

## P11-11: exact-page browser click (2026-09-26)

- The first governed page mutation is `nnd_browser { action: "click", selector,
  expectedUrl }`. `expectedUrl` must be the exact URL observed from a recent
  snapshot; NNA validates it, NND's private callback bounds it, the Browser
  pane compares it with current navigation, and the guest checks `location`
  synchronously before activation. A stale page or disabled/hidden target is
  rejected without clicking.
- Success means a visible element was activated, not that navigation or a
  remote side effect settled. The receipt explicitly says `settled:false`;
  the next step is a fresh snapshot. Timeout or lost results are marked
  uncertain, so a caller must inspect before retrying rather than double
  clicking. The adversarial review additionally required a same-session,
  single-use successful snapshot URL before dispatch; stale concurrent
  snapshots cannot restore that evidence. The guest rejects covered,
  hidden, inert, and disabled targets, and a timed-out click blocks further
  snapshots/clicks until its guest script settles. Type/scroll/capture and
  richer page inspection remain pending.

## P11-12: governed viewport scroll (2026-09-26)

- `nnd_browser { action: "scroll", direction, expectedUrl }` supports only
  `up|down|top|bottom` in the isolated desktop guest. It requires the same
  session-local, single-use successful snapshot URL as click, and the guest
  rechecks the exact URL. A double-animation-frame readback reports the
  resulting position and whether the viewport reached either edge.
- The script cannot target arbitrary frames or execute model-supplied code.
  NNA and the private callback enforce a bounded direction/URL schema, and
  the renderer validates the numeric readback. A failed or timed-out scroll
  requires a new snapshot before retrying. Type/capture remain pending.

## P11-13: bounded exact-page typing (2026-09-26)

- `nnd_browser { action: "type", selector, expectedUrl, text }` replaces the
  value of exactly one ordinary input (`text` or `search`) or textarea in the
  isolated desktop guest. The text is capped at 2,000 characters; the receipt
  never echoes it. This does not press Enter, submit a form, or type into a
  remote browser outside the desktop guest.
- NNA requires and consumes the session's latest successful snapshot URL
  before dispatch. The private callback and desktop renderer validate the
  bounded fields, current page, and navigation revision; the guest rechecks
  `location.href` immediately before setting the field. Password/special
  input types, active autocomplete, sensitive field identifiers, disabled,
  readonly, hidden, inert, duplicate, and covered targets are refused.
- The guest uses the native value setter and dispatches bubbling `input` and
  `change` events. The receipt confirms event dispatch, not that the app
  accepted or saved the text (`settled:false`). A timed-out guest action keeps
  a mutation latch until its script settles; snapshots and subsequent
  mutations are blocked meanwhile. Capture/annotation remain pending.

## P11-14: bounded desktop-guest capture (2026-09-26)

- `nnd_browser { action: "capture", expectedUrl }` requires and consumes the
  latest successful session snapshot, including its private page observation
  identity. Only the currently mounted isolated Electron guest can capture;
  a stale navigation, missing guest, or concurrent page action is refused.
- The desktop captures the visible viewport via Electron's webview API, scales
  it to at most 1600 × 1200 pixels, and encodes a JPEG no larger than 150 KiB.
  The private callback transports the image only to the owned NNA child. NNA
  validates URL, dimensions, encoding, and JPEG bounds before exclusively
  writing a session-owned file; the model receives an exact path and can call
  its existing `image_inspect` tool. Image bytes are not added to model text or
  logged. A capture is an observation, not evidence that the page has settled.
- NNA preserves capture files so paths already referenced in a transcript stay
  usable. It refuses a 257th capture in one session with an explicit quota
  error; the operator can remove old files from that session's managed
  `runtime/browser/nnd-captures` directory before retrying. This bounds one
  session to about 38 MiB but does not yet impose a global retention policy
  across sessions; longer-lived installations need an explicit artifact-lifetime
  decision before automatic pruning.
- This first slice does not capture arbitrary tabs, remote web clients,
  offscreen/full-page content, or annotation overlays. Those remain separate
  work; a hidden or non-composited guest must fail explicitly.
