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
