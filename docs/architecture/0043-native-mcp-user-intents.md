# Native MCP user-manifest intents

Status: private NNA configuration contract. NND GUI adoption and installed
application proof remain separate work.

NNA owns MCP definitions. The generic scalar configuration endpoint does not
edit `mcp_servers`, and an OpenCode MCP file is never an NNA configuration
source. This contract accepts one bounded, typed user-manifest change by server
ID: create a disabled stdio or credential-free HTTP server, patch enablement or
finite deadlines, or delete one existing server. Create defaults `trusted` to
false. It does not accept raw tokens, OAuth settings, header values, credential
bindings, trust elevation, or whole-array replacement.

`GET /v1/nnd/configuration/mcp` returns only ID, transport, enablement, trust,
and numeric deadlines, with installation/data identity, source and resolution
revisions, and a project-shadow flag. Destinations, commands, arguments,
credential references, and unknown manifest fields stay inside NNA. A patch
omits unchanged fields; NNA applies it to the selected raw user entry, so a
redacted field need not round-trip through the GUI. A trusted project
`mcp_servers` array replaces the entire user array in layered resolution; any
user edit while it is present fails with `configuration_source_shadowed`.

`POST /preview` validates native resolution and returns a redacted candidate
view without persistence. `POST /save` uses the same installation/data,
source-revision and resolution-revision preconditions plus an operation ID.
NNA rechecks them inside the manifest transaction and its validation step,
stores an actor-bound idempotency receipt, and exposes uncertain outcomes via
`GET /operations/:id`. Receipts say `not_applied`. A saved user manifest needs
native activation or restart; only newly created sessions after that step can
consume its MCP configuration. Existing sessions and current runtime inventory
are not represented as changed by a successful save.

Next work must add NND typed controls and native credential-reference and trust
governance flows. The OpenCode draft and import path require an explicit mapping
preview and cannot be reused as an NNA request. Tests must prove current-session
nonapplication and new-session consumption in an installed NND/NNA pair.
