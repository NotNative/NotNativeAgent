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
JSON. Payload URLs and image fields are ignored. Click handling reuses a
clean application home window or opens the same-origin home; it preserves
hosted conversation surfaces and credential query URLs. Session-specific
navigation depends on the remaining main GUI routing implementation.
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
Unsubscribe removes the server record before ending the browser subscription;
server failure leaves the browser subscription available for retry.

The mounted shell reports focused visibility immediately and every 20 seconds.
Writes are serialized, coalesced to the latest state, and bounded by a
five-second HTTP deadline. Page closure and shell disposal release the lease;
crashes are handled by lease expiry. BFCache restores reporting on pageshow.
Runtime changes do not send old cleanup reports into the newly selected
instance. LAN HTTP pages use getRandomValues nonces without requiring the
secure-context-only randomUUID API.

## Remaining delivery slice

Registration alone does not complete Web Push. Encrypted bounded outbound
delivery, event triggers, expired destination removal, notification settings
and visibility suppression in the sender, session
navigation from notifications, and live browser acceptance remain open. Registration
does not infer a public server origin from an arbitrary request field.
