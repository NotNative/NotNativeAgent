# Session notification routes

Sources: doc 03 §5.37/§5.39, doc 04 §F.10, and NNA's authenticated session
list, status index, metadata projections, and global event feed. Existing
permission authority remains with NNA, as recorded in note 18.

## Read surface

The gated routes expose `/api/session-activity`, `/api/sessions/snapshot`,
`/api/sessions/status`, `/api/sessions/:id/status`, `/api/sessions/attention`,
and `/api/sessions/:id/attention`. Status rows retain status, observation
timestamp, and retry metadata. Attention rows include status, the observed
status-change timestamp, last confirmed user-message receipt, current view
lease, and attention. An unknown initial status-change time is zero.

Initial reads and reconnects refresh from NNA through the harness adapter.
Concurrent refreshes share one request pair. Invalid, unavailable, oversized,
paginated, or concurrently superseded snapshots fail with 503 instead of
claiming idle or complete state. Live events update the same projection; a
session deletion removes its projection and local receipts. Maps and leases
are bounded. NND does not create an independent agent execution state.
Coverage includes owned status-index sessions missing from the default list,
including active archived sessions. Records disappear when neither source
covers them.

NNA metadata and unresolved questions/permissions remain attention sources
after the session is viewed. Unread completion is a separate display receipt;
opening a session cannot resolve an NNA blocker. Monotonic completion/read
markers distinguish events that share a wall-clock millisecond. Completion
observed during an active view remains read after that view is closed.

## Confirmed receipts

`POST /api/sessions/:id/view`, `/unview`, and `/message-sent` require an
authenticated UI session or registered client credential and an owned NNA
session projection. View/unview accept optional `clientId` and `sequence`.
Browser mounts use random client identities and increasing sequences; legacy
callers retain a separate lease. Leases expire after 30 seconds, so one tab
cannot hide another active tab and a crashed browser cannot retain a view.

The GUI reports selection, focus, blur, pagehide, BFCache pageshow, and a
20-second focused heartbeat. Runtime changes discard late replies and never
send old cleanup requests into the new instance. Confirmed prompt sends use
the canonical message-sent route. View and message-sent clear only the calling
credential's selected-session badge; unview preserves unread counts. The
previous internal badge reset endpoint remains available for older clients.

## Notification stream

`GET /api/notifications/stream` uses the same server-owned NNA feed as the
sender. It emits `notnative:notification-stream-ready`, notification events,
and session status/activity projections, with 20-second comment heartbeats.
Its `uiToken` is an opaque credential-owner identifier, not a reusable JWT or
client bearer. Status frames derive attention for the receiving credential;
receipt updates notify other windows. Revocation/expiry and slow consumers
close the stream. Cancellation removes subscriptions and heartbeat timers.

## Remaining coverage

The pending request map currently has `pendingCoverage: 'live-events-only'`.
NNA exposes question replies/rejections but no authoritative restored pending
form read endpoint. Empty observed pending data therefore does not prove that
no restored blocker exists. Metadata attention still projects needs-input and
approval states. Exact pending snapshot recovery remains required before full
notification-route acceptance can be claimed.

Installed-browser push/badge acceptance, optional model-authored notification
text, and first-registration public-origin handling also remain open in note
21. Native APNs and mobile remain within the approved mobile deferral.
