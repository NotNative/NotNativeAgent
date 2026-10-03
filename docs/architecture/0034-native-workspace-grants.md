# Architecture decision 0034: Native NND workspace grants

Status: dormant integration prerequisite in `20261003-2`.

The native NNA listener owns a durable, finite workspace grant catalog. Its primary grant is
the configured `manifest.workspace_root`; at most one additional root may be recorded. This
catalog does **not** change the current single-root session engine, principal workspace IDs,
`/path`, `/project`, or `/session`. Selecting the additional root remains unsupported until
per-session configuration, identity binding, restore, and event visibility are implemented.

`GET /v1/nnd/workspaces` requires `nnd.workspace.read` and returns the installation/data
identity, the catalog revision, primary and optional secondary grants, `selection_enabled:
false`, and `application: "not_applied"`. A missing catalog has revision `absent` and a
synthesized primary grant. Each grant contains an opaque stable `ws_` ID, canonical root,
device, and inode. Roots and their filesystem identities are verified on every read.
The primary ID follows the existing native principal's hash of the effective
configured workspace-root string, preserving single-root session ownership;
the secondary ID is derived from its canonical root. A stored primary ID from
another derivation fails closed and is not silently migrated.

`POST /v1/nnd/workspaces` requires `nnd.workspace.manage`. It accepts exactly
`installation_id`, `data_id`, `expected_revision`, `operation_id`, and `secondary_root`
(absolute path or `null`). The native service verifies both roots, rejects links and aliases,
and commits a complete catalog with manifest-transaction CAS and durable operation receipt.
The response reports `saved`, `unpublished`, or `unknown`, `before_revision`,
`persisted_revision`, `replayed`, and `application: "not_applied"`. An ambiguous outcome is
resolved with `GET /v1/nnd/workspaces/operations/:operation_id`, which requires read
permission. Operation IDs are scoped to the authenticated native actor and installation.

The catalog lives at `<NNA data root>/config/nnd-workspace-grants.json` and is never taken
from a browser principal or NND renderer path. A removed/replaced root, changed primary
manifest, malformed catalog, wrong installation/data identity, or stale revision fails
closed. Existing native execution remains on the primary workspace even when a secondary
grant is saved. A future selector must revalidate the stored grant at session creation and
restore and bind each session and child to exactly one root ID; merely adding both IDs to a
principal would incorrectly label and restore sessions under the current host design.
