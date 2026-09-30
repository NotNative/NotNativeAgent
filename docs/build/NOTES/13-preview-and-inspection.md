# 13 — Preview and inspection build notes

## P11-26: relay dev-tunnel branch (2026-09-30)

The Electron bridge owns one loopback route per `runtime` key. Before
transferring control it pauses the accepted socket, creates a real
`MessageChannelMain` pair, and posts `openchamber:relay-dev-tunnel-connect`
with a connection id and the requested upstream port. A renderer bridge can
wait on one route operation while refusing a second same-target open, so
repeated opens reuse the pending socket rather than creating a second listener.

The renderer refreshes the short-lived runtime URL token and opens the virtual
relay websocket. Only after readiness does it announce `ready`; `data` messages
use `Uint8Array` bytes in both directions, and either close propagates to the
other side. The source remains isolated when port transfer fails. A connection
that does not become ready within 15 seconds is closed. Errors during endpoint
cancellation or token refresh reject the caller instead of escaping async event
callbacks.

`MessagePortMain` readiness uses its native event API, with a test-compatible
fallback. Closing a route detaches its port before destroying the source to
avoid duplicate close handling. Endpoint changes close all routes, and
webContents death closes that webContents' routes. The focused tests pin the
actual two-frame transfer shape, readiness timeout, buffered bytes,
bidirectional close, endpoint cleanup, and death cleanup.

## P11-25: raw dev-tunnel direct client seam (2026-09-30)

The web-package client accepts a WebSocket connector and creates one local
`127.0.0.1` listener per connection. Cache identity is `runtime|bootstrap|
port`, so repeat opens with or without test/bootstrap differentiation reuse a
single upstream port through one `ws(s)` websocket without replaying
`ready`/`close` against an already-settled socket. The source socket is paused
for at most 15 seconds while the upstream connects; buffered bytes are capped
at 256 KiB, and overflow, timeout, connector failure, or local-source close
destroys that connection only. Conversion occurs only after an http(s) origin
guard; relay-virtual/non-special schemes are rejected before `ws` conversion.

The panel's `resolveBrowsableUrl` changes a server-side loopback target only
for a real local/Electron runtime. The null runtime is a no-op; absent desktop
IPC throws an explicit selection error. Decision results are cached by runtime
and source port; reachable direct ports are reused, implicit ports are
normalized, and already-tunnel ports are skipped before opening a nested
bridge. Display restoration uses the exact origin cached at open time, so an
mapped `localhost`/`127.0.0.1`/IPv6 target still shows the original URL. An
endpoint reset discards in-flight opens by generation, removes cached mappings,
and makes a best-effort close-all call over the existing selection seam. A
tunnel failure never falls back to the plain URL.

## P11-24: raw dev-tunnel security host (2026-09-30)

`/api/dev-tunnel?port=<1..65535>` is an exact route: query values and protocol
are strict, subpaths are not accepted by URL-token allowlisting, and
unavailable ports return a safe 403 after a fresh `dev-servers` check. The
auth postures follow the preview contract: browser origins are allowlisted;
credentialless client authentication may connect; credentialless non-client
authentication is refused; a short-lived URL token is accepted only for the
exact path in the existing allowlist; and the existing development auth-off
local-only mode remains explicit.

The server synchronously reserves at most 64 raw sockets per host. Source
socket data is paused during a stalled 5-second dial; when connected, reads
pause while the websocket's queued bytes exceed 1 MB and resume on the 20 ms
poll. Closing either side closes the peer, with per-socket maps and exceptions
isolated. Discovery-fresh check callback ownership and listener-broadcast
error paths have focused regressions.

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

## P11-15: governed preview history (2026-09-26)

- `nnd_browser { action: "history", direction: "back"|"forward", expectedUrl }`
  moves only within the Browser pane's existing isolated-guest history. It
  cannot supply a new URL. NNA consumes a fresh, single-use snapshot URL and
  private observation identity; the renderer checks these against the current
  guest and its URL before dispatch. Missing history is an explicit refusal.
- The command replaces the guest with the selected history entry. Its receipt
  means navigation was requested, not settled; a new snapshot is needed for
  page content. Snapshots and further mutations remain blocked until the
  replacement guest reports load completion, including a same-URL history
  entry. Timeout or disconnection leaves the outcome uncertain and never
  reuses the consumed observation for a duplicate navigation.

## P11-16: user element annotation draft (2026-09-26)

- The visible isolated Electron Browser pane offers **Annotate element**.
  The user points and clicks one visible page element through a renderer-owned
  shield above the webview. The guest never receives the selection click, even
  if its page registered capture-phase listeners first. A read-only guest hit
  test resolves the marked element using viewport-relative coordinates.
  Escape or the toolbar toggle cancels by removing the shield. No guest DOM
  overlay or event listeners are installed.
- The renderer validates the bounded page URL, tag, selector, label and
  viewport bounds, then checks that the selected page is still the same guest
  and top-level URL. A separate bounded comment field explicitly adds
  structured text to the existing chat draft. It does **not** send a message
  or call an agent/browser tool. Page-derived label text is marked untrusted.
- This is deliberately an element-only first slice. Region/drawing marks and
  screenshot attachment/compositing from the planning contract remain pending;
  the UI and draft say that no screenshot is attached. The iframe transport
  never offers annotation.

## P11-17: bounded element annotation screenshot (2026-09-26)

- On explicit **Add to chat draft**, the renderer rechecks the selected guest,
  exact URL, navigation revision, viewport dimensions and scroll, plus the
  selected element's current bounds. It captures only that Electron guest's
  visible viewport and checks the page again after capture. A page change,
  failed decode, timeout, or excessive image size leaves the selected element
  and comment in place for retry; no partial composer text is added.
- Composition uses the measured captured-image-pixel/guest-CSS-pixel ratios,
  draws a resolved translucent fill and outline on the **whole viewport**, and
  emits a bounded JPEG data URL. It does not create a blob URL or capture the
  host window. The composer accepts the image and structured text as one
  acknowledged draft change, with the image present before text claims it.
  The handoff is idempotent for a repeated annotation ID and never sends the
  draft. This extends the element-only marker; region/drawing marks remain
  future work. The iframe transport still does not offer annotation.

## P11-18: user-drawn region annotation (2026-09-26)

- The desktop Browser pane also offers **Annotate region**. A drag on the
  renderer-owned shield marks a rectangle; pointer capture keeps the drag
  out of the guest, and Escape, pointer cancellation, or the toolbar control
  removes the selection. A rectangle smaller than 8 × 8 guest CSS pixels is
  refused. Blur clears an active drag; a shield geometry change during a drag
  refuses the selection instead of combining mismatched coordinates. This is
  a viewport region, not an element or page-wide drawing.
- A read-only guest script verifies the exact top-level URL and returns
  bounded viewport/scroll metadata with the rectangle in guest CSS pixels.
  **Add to chat draft** rechecks the same guest, navigation revision, URL,
  viewport and scroll before and after a bounded guest-only capture. The
  image compositor maps the rectangle using the measured capture-pixel to
  guest-CSS-pixel ratios. Failures retain the comment and selection for an
  explicit retry, without a partial draft update.
- The image and structured region text are handed to the composer atomically;
  no message is sent automatically. Element annotation remains available,
  and neither annotation mode is exposed through the iframe transport or the
  agent browser tool.

## P11-20: deterministic diff walkthrough foundation (2026-09-26)

- The right rail adds a Walkthrough pane, also opened explicitly from Changes. Opening it reads the current local working-tree Git status and staged/working per-file patches. It does not invoke NNA, a model, or a remote service.
- A bounded parser uses the shared unified-diff model to present one navigable stop per actual hunk, in deterministic file/scope/patch order. Each stop shows the file, scope, old/new line anchors and the original diff rows. This is visibly labelled a deterministic preview, not an AI explanation or finding.
- The snapshot signature includes branch, complete status codes and all fetched patch text. A visible panel rechecks on focus and every 15 seconds, marking its existing stops stale when the source changes; only the user's Refresh replaces them. Read failures warn that currency cannot be verified. Oversized changes refuse rather than silently truncate, and omitted binary file scopes are disclosed.
- This is the substrate for planning doc 13 F/G, not its narrative pipeline: content-addressed server hunk ids, model selection/generation, cache, chapter grouping, and PR/branch/commit scopes remain follow-up work.

## P11-19: user-drawn freehand annotation (2026-09-26)

- The desktop Browser pane also offers **Draw on page**. The host-owned shield
  captures pointer strokes without forwarding drawing gestures to the guest.
  Up to eight strokes of 128 points each are retained; each must cover at least
  eight guest CSS pixels. Escape cancels, while pointer cancellation or window
  blur discards only the active gesture. The user explicitly confirms the
  drawing with **Use drawing** before entering a comment. The host guards
  pointer cancellation by ID and holds preview geometry across strokes, so an
  unrelated pointer or a mid-drawing resize cannot silently shift the marks.
- A read-only guest script checks the exact page URL and converts normalized
  stroke points to bounded viewport CSS coordinates. The renderer validates
  viewport/scroll metadata and rechecks guest identity, navigation revision,
  URL, viewport and scroll around guest-only screenshot capture. The compositor
  uses measured capture-pixel/CSS-pixel ratios to draw the strokes onto the
  screenshot. A failed capture leaves the comment and selection available for
  retry without partial draft text.
- **Add to chat draft** atomically attaches the marked screenshot and structured
  drawing details. It never sends the message. Element and region modes remain
  available; the iframe transport and agent browser tool do not gain drawing.

## P11-23: staged/unstaged walkthrough scope (2026-09-26)

- The Walkthrough header now selects All uncommitted, Staged, or Unstaged. The server filters patch collection and file-scope limits accordingly; untracked files are part of Unstaged only. Each scope has a distinct revision signature even if its hunk bodies happen to match another scope.
- Switching scope clears the prior preview and model prose. Refresh, freshness checks, and explicit model generation all carry the selected scope, so a model explanation cannot silently move from staged to working changes. Branch, commit, and PR choices remain follow-ups.

## P11-22: explicit model explanation on the current diff (2026-09-26)

- The Walkthrough pane adds an explicit **Generate explanation** action for a selected NNA session. The NND server rechecks the snapshot revision, checks that the NNA session belongs to the selected workspace, and sends only an aliased, 64 KiB-bounded hunk digest to NNA's `nnd.walkthrough.generate` route. Known sensitive-path hunks are omitted; the UI warns that other code may still contain secrets and that the configured model receives the digest. No agent turn or tool call is made.
- NNA's model-only route is separately permissioned, scheduled, deadline-bound and output-bounded. NND accepts model output only as plain-text chapter/explanation prose; it resolves aliases to the server-owned hunk IDs, drops invented or repeated aliases, refuses invalid output, and rechecks the diff revision before display. Prose is displayed beside the real hunk with provider/model attribution and a verification warning.
- This is an in-memory, working-tree-only narrative slice. Content-addressed review caching, model override/picker, branch/commit/PR sources, generation progress/cancel, and deeper generated-file exclusions remain P11 follow-ups.

## P11-21: server-owned working-tree diff snapshot (2026-09-26)

- `GET /api/git/walkthrough-snapshot?directory=…` now owns the deterministic
  Walkthrough preview's Git capture, hunk parsing and revision signature.
  It rides the normal authenticated Git route group and is read-only. The
  client no longer builds IDs or combines status with individually timed diff
  requests. Only the explicit Walkthrough pane calls it; there is no model
  invocation or remote send.
- The endpoint reads staged and working scopes separately, includes regular
  untracked files without staging, preserves rename metadata, and labels
  binary-only scopes rather than inventing text hunks. IDs hash the hunk
  header and body under scope and repository-relative path; equal repeats
  receive `-2`, `-3`, etc. The returned SHA-256 signature covers the branch
  status record and all bounded patches. Each capture is performed twice;
  disagreement returns `409 snapshot-stale` with a retry message, never a
  mixed-source tour. The panel's existing focus/15-second staleness check
  compares these server signatures and still requires user Refresh to replace
  visible stops.
- Limits are 60 file scopes, 200 hunks and 750,000 patch bytes. Paths remain
  within the requested workspace, including realpath checks; symlinked or
  oversized untracked files fail explicitly. The endpoint currently supports
  only working-tree scope and deterministic preview. Narrative generation,
  cached chapters and branch/commit/PR source descriptors remain pending.
