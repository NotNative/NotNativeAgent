# Native reviewer and vision binding GUI

Status: candidate NND settings slice against NNA ADR 0050's typed
`bind_route` contract.

The reviewer and vision settings page shows the authenticated native effective
provider/model pair. When both fields in one role advertise `operation:
bind_route`, user scope, and `nnd.configuration.manage`, it offers a paired
editor. Provider choices come from the selected user manifest's native view;
project-only providers are not offered. A model may be entered explicitly, and
changing the provider starts with that profile's default model. The GUI sends
one `bind_route` operation through the native preview and save endpoints with
the source and resolution revisions from the same view. It retains the
operation ID for receipt lookup if the outcome is uncertain.

NNA decides provider ownership, trusted-project shadowing, authorization,
validation, and persistence. The GUI shows conflicts and denied writes as
native errors and never writes provider and model as independent scalar fields.
A saved receipt says `not_applied`; activation or a native restart is a separate
operator action. Primary and subagent route binding remain on their existing
surfaces. This slice does not claim all provider configuration is editable.
