# Architecture decision 0055: External-store settings need a shared writer boundary

Status: private gateway timeout transaction prerequisite; no HTTP endpoint or GUI
capability is advertised.

The WebSearch, WebFetch, and Telegram gateway settings are separate JSON files,
not fields in the NNA user manifest. Existing Console, CLI, installer, and TUI
writers read a document and replace it with a temporary-file rename without
the native manifest mutex. An NND save endpoint using a revision check alone
could report success while a concurrent first-party writer immediately replaces
its result from a stale snapshot. The gateway token and authorized-user list
also make a broad document editor an unsafe way to expose one benign scalar.

`nnd-gateway-timeout-transaction.js` prepares the narrow
`polling_timeout_seconds` intent. It requires the native read/manage permission,
selected installation and data identity, user scope, exact source revision and
resolution revision, and a bound operation ID. It edits only the timeout, keeps
unknown raw keys and the private token inside NNA, validates the complete
gateway document, and returns durable `saved`/`unpublished`/`unknown` receipts
with `not_applied` status. Missing or invalid source files require separate
repair. Reads and proposed saves enforce the gateway loader's 65,536-byte
limit, even though the underlying manifest transaction store permits larger
documents. Native principal subject IDs retain their admitted printable text
shape and are hashed into receipt keys without exposing them in the key. The
external gateway store has no project layer, so its resolution
revision equals the source revision and `project_shadowed` is false; a future
public route must not claim manifest project inheritance for this store.

The transaction remains private until first-party writers use the same
coordination boundary or a stronger shared transaction API. A subsequent native
HTTP route must derive the gateway path and selected identity from trusted
installation state rather than client input. It also needs a bounded public
projector and error taxonomy, then NND browser
and desktop GUI acceptance. WebFetch trust origins, gateway enablement and
authorized users are separate authority-grant designs and are not part of this
timeout intent. Existing gateway processes need restart before a saved timeout
affects polling; a receipt must never claim live application.
