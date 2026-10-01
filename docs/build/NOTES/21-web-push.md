# Web Push contract and implementation

Source: doc 01 §3.3 and doc 03 §5.37. Browser/PWA Push is planned; native
mobile/APNs remains with the long-term mobile deferral.

## Registration foundation

The authenticated API supplies `/api/push/vapid-public-key`, subscription
POST/DELETE, and visibility GET/POST before the harness proxy. Registration
needs a UI cookie session or registered client credential; anonymous local
open access and URL tokens cannot register a destination. The durable store
hashes credential ownership and never stores raw UI credentials. Responses
never disclose the VAPID private key, subscriptions, or subscription secrets.
Each request captures its authenticated owner once. A renewed credential can
rebind an existing browser subscription only with both original subscription
keys; endpoint knowledge alone cannot transfer ownership.

`push-subscriptions.json` contains one validated P-256 VAPID key pair and
bounded subscriptions. Locked read/merge/write preserves concurrent owners;
private temporary files, fsync, and atomic replacement preserve acknowledged
state. Invalid existing storage fails closed rather than rotating the key
and invalidating every installed browser subscription. Encoded key points,
authentication secrets, HTTPS endpoints, collection sizes, and body sizes
are validated at the owning boundary. Visibility is a bounded in-memory lease
and expires after 30 seconds without a heartbeat.

Visibility now aggregates per-window leases within each authenticated owner.
`clientId` identifies a mounted surface and `sequence` orders its reports;
hidden or delayed reports from one tab cannot clear another visible tab.
Ordering tombstones expire after five minutes, and capacity is bounded to
32 surfaces per owner and 1,000 owners without evicting active leases.
Legacy `{visible}` callers retain an independent legacy lease.

The shared RuntimeAPIs Push member now has a typed browser adapter for these
routes. Its fetch path uses the active runtime and credentials, validates
acknowledgements, and propagates failures.

Protocol references: [VAPID RFC 8292](https://www.rfc-editor.org/rfc/rfc8292.html)
and the [W3C Push API](https://www.w3.org/TR/push-api/).

## Push service worker

The shipped worker displays a notification for every received push, with
bounded title/body/tag fields and a product fallback for missing or malformed
JSON. Payload URLs and image fields are ignored. A bounded session ID travels
as notification data and becomes an encoded same-origin `?session=` route.
Click handling focuses an exact destination window or opens it; it preserves
other drafts, hosted conversation surfaces, and credential query URLs.
Missing or invalid IDs fall back to the application home.
The worker still performs no fetch interception or precaching. Public assets
are included in the release hash manifest and version seal.

## Browser registration controls

Notification settings expose Register, Unsubscribe, and Refresh for a supported
secure browser connected to the application origin. Permission is requested
from the Register click, before worker/network awaits. Registration uses the
root application worker and the server's VAPID key; only acknowledged server
registration is reported as confirmed. A subscription found in the browser
alone is shown as existing and can be re-registered to renew ownership.
Failed operations retain retry controls and do not claim confirmed state.
Runtime identity/origin checks prevent continuing against a switched instance.
The browser includes its actual application origin during registration. The
server accepts HTTPS or HTTP loopback origins, rejects credentials, paths,
queries, fragments, and malformed values, and matches the value to the Origin
header when present and the request host/first forwarded host. Omitted origins
remain compatible with older clients.

After a successful subscription write, the server records the first validated
origin in `preferences.json` and the `settings.json` mirror under the shared
settings lock. The captured credential authority is rechecked at that boundary.
Existing configured origins are preserved, including legacy operator settings.
The registry marks this instance fact as server-owned: client autosaves and
ordinary settings patches cannot replace it. Terminal upgrades consume the
persisted origin without requiring forwarded-host headers on every connection.
Corrupt settings or failed persistence leave an explicit registration failure;
retry uses the existing browser subscription and reconciles a failed or missing
legacy mirror. Existing legacy origins enter the canonical store unchanged.
Unsubscribe removes the server record before ending the browser subscription;
server failure leaves the browser subscription available for retry.

The mounted shell reports focused visibility immediately and every 20 seconds.
Writes are serialized, coalesced to the latest state, and bounded by a
five-second HTTP deadline. Page closure and shell disposal release the lease;
crashes are handled by lease expiry. BFCache restores reporting on pageshow.
Runtime changes do not send old cleanup reports into the newly selected
instance. LAN HTTP pages use getRandomValues nonces without requiring the
secure-context-only randomUUID API.

## Encrypted outbound delivery

`NOTNATIVE_PUSH_SUBJECT` supplies the operator contact (mailto or public HTTPS).
Missing or invalid configuration disables sending. The notification master
and event preferences gate the shared server-owned harness event subscription;
the browser does not own this feed. Four destinations can send concurrently,
with a bounded queue of 32 notifications. Visibility on any interactive client
suppresses Web Push according to doc 03's push rule.

The `web-push` dependency generates RFC 8291 aes128gcm payloads and RFC 8292
origin-bound VAPID assertions from the persisted key pair. NND owns the HTTPS
transport: public-address checks on every DNS answer, a pinned selected
address, verified TLS hostname, no redirects, port 443, five-second DNS and
ten-second HTTPS deadlines, and a 3,000-byte payload cap. No UI or NNA bearer
credentials enter the outbound request. Transport responses are discarded
without buffering their bodies.

New subscription records include server-derived recipient authority. Session
expiry and JWT-secret epochs exclude expired/reset sessions; active client
records and token hashes exclude revoked/expired devices. Existing records
without this metadata require re-registration. The stored record, authority,
and visibility are rechecked immediately before dispatch, after DNS. A 404/410
removes only the unchanged expired registration, preserving a concurrent
replacement. Shutdown detaches the shared feed and aborts outbound HTTPS.

Protocol implementation: [web-push](https://github.com/web-push-libs/web-push).
Independent tests decrypt the actual wire record and verify ES256 VAPID claims;
these checks prove the transport contract, not live browser acceptance.

## Notification badges

The shared sender includes credential-owned unread counts with a process epoch
and increasing revision. Counts increment once per eligible notification and
owner, regardless of the number of browser destinations. State is process-local
and bounded to 1,000 owners, 256 session buckets per owner, and count 9,999;
server restart creates a fresh epoch and starts counts at zero.
Delivery captures the revision when a notification enters the queue. Session
and aggregate reset barriers invalidate older queued work and in-flight tickets;
resetting one session preserves queued notifications for other sessions.
Serialized Unicode payloads stay within the transport byte limit by shortening
body, tag, and title while preserving session identity and badge metadata.

Authenticated `/api/push/badge` reads the count. `/api/push/badge/reset` accepts
a bounded session ID and `view` or `message-sent`; it clears only that owner's
session bucket. Focused visibility clears that owner's aggregate count. The GUI
reports focused session selection and confirmed prompt sends; runtime changes
discard late reset responses. These internal routes do not replace the planned
canonical notification activity/view/message-sent surface.

The worker serializes badge changes and persists revision barriers in its own
small CacheStorage record. Delayed pushes cannot restore an older cleared count,
including after worker restart. Retired server epochs are rejected for push;
same-origin windows can report a current authenticated server response. Browser
badge failures never prevent notification display. API/application requests
remain network-owned with no worker fetch interception.
Window fallback calls are serialized. Responses are ordered by their confirmed
request sequence; failed requests and hidden beacons cannot discard a successful
clear. The worker remembers the latest epoch for up to 32 normalized server
origins. A late response from another tab cannot restore a retired epoch, while
an intentional return to another instance can restore its remembered current
epoch. Origin metadata contains no credentials.

Browser contract: [W3C Badging API](https://www.w3.org/TR/badging/).

## Remaining acceptance

Session links resolve through the authenticated global list or an explicit
unscoped SDK lookup. NNA supplies the directory; unavailable or mismatched
responses leave the current selection intact. Later global-list directory
moves update the selected session. Session/runtime changes invalidate pending
replies. An instance switch removes the previous session query while a
transport switch within the same instance preserves it. Explicit draft
navigation also cancels pending links and delayed saved-session restoration.
Boot restoration cannot override a linked session, and boot directory
hydration preserves an already selected session's directory. Session selection
updates the browser query, and popstate applies links without pushing history.
Settings links take precedence; hosted/embedded/VS Code surfaces keep their
identity queries. Settings history and legacy tab/file context routes are
implemented in [the workspace router](22-workspace-url-router.md).

The canonical notification SSE/activity/status/attention/view/message-sent
surface is implemented in [note 23](23-session-notification-routes.md), with
authoritative pending reads from current NNA and explicit live-event-only
coverage for older NNA versions without that read. Live browser acceptance
remains open under doc 03 §5.37. Badge count/reset behavior is implemented;
installed-browser badge acceptance remains required.
First-registration public-origin handling is implemented with the validated
request binding above. Enabled events request optional model-generated text
through NNA's owned notification inference route. Default uses NNA's primary
route; an explicit Small Model override must reference a profile configured in
that session and cannot widen the primary route's network trust zone. A changed
provider configuration can require a new session before the profile is available.
Only bounded assistant text and the classified fallback enter this tool-free
request. Strict output validation permits title/body changes only. Failure,
cancellation, unavailable models, and the five-second deadline preserve the
shared template/fallback. Two in-flight slots bound outstanding generation.
Delivery rechecks settings, pending question identity, session identity, and turn
revisions; later turns invalidate delayed text. Badge clear revisions are captured
before generation. Model-backed subtasks require a tracked parent projection.
