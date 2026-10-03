# Native specialist route bindings

Status: bounded user-manifest mutation contract. It does not activate a saved
route, probe a provider, or change sessions already using another route.

The authenticated `POST /v1/nnd/configuration/preview` and `/save` endpoints
accept an operation with exactly `op`, `role`, `provider_id`, and `model`:

```json
{"op":"bind_route","role":"reviewer","provider_id":"local","model":"review-model"}
```

Only reviewer and vision roles are admitted. Provider IDs must be safe bounded
identifiers owned by the selected user manifest, including the legacy single
provider alias. Model names are nonblank strings of at most 256 characters and
cannot contain control characters. The operation writes provider and model as
one typed intent, preserving unrelated route tuning and unknown private source
keys. It cannot bind to a provider supplied only by a trusted project overlay.
A trusted project's provider or model assignment for the same role blocks the
user write. The ordinary native source and resolution revisions, subject-scoped
operation ID, permission `nnd.configuration.manage`, manifest transaction,
preview projection, and `not_applied` receipt apply unchanged.

`GET /v1/nnd/configuration/catalog` marks the paired reviewer and vision
provider/model fields available with `operation: bind_route`, both paired field
names, user scope, and required permission. Descriptive catalog metadata does
not itself grant permission. Primary and subagent route bindings retain their
existing dedicated contracts; they are not admitted through this operation.
The GUI must send the paired operation rather than independent scalar writes.
