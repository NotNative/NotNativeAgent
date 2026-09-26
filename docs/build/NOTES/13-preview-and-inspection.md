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
