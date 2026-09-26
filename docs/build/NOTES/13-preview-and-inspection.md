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
- The browser's sandboxed iframe does not yet consume this route for startup
  wait; Chromium/webview lifecycle and tunnel work remain P11 follow-ups.
