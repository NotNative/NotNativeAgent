# Architecture decision 0055: External-store settings need a shared writer boundary

Status: native HTTP gateway timeout capability implemented; GUI integration pending.

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

The gateway Console/CLI mutation path and `saveGatewayConfig` now use the same
manifest mutex as this private intent. CLI changes derive from the latest
document while holding the lock, so concurrent authorizations accumulate and a
racing native timeout save either commits before the CLI update or fails its
stale revision. First-party writes preserve unknown raw fields and never put
the token in transaction receipt payloads. Uncertain publication remains an
error; the caller must inspect current state rather than assuming a save.

The native `/v1/nnd/configuration/gateway` route derives the gateway file path
and selected identity from the installed NNA service. Read, catalog, preview,
save, and operation lookup require the scoped native principal. The route
accepts only the bounded timeout intent and projects only timeout, identity,
revision, and durable receipt fields. It never projects the token, authorized
users, unknown raw fields, or gateway enablement. Saved receipts say
`not_applied` and direct the operator to restart the gateway. NND browser and
desktop GUI acceptance remains to be completed. WebFetch trust origins, gateway enablement and
authorized users are separate authority-grant designs and are not part of this
timeout intent. Existing gateway processes need restart before a saved timeout
affects polling; a receipt must never claim live application.
