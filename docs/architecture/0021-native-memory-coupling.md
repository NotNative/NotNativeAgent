# Native memory enablement controls

The NND configuration page offers `memory.enabled` and `memory.required` as
dedicated boolean controls only when the selected NNA catalog advertises both
fields as editable user settings and each has the exact
`editability.coupled_fields: ["memory.enabled", "memory.required"]` marker.
Older NNA catalogs can still expose the memory limits, but NND does not offer
the coupled boolean controls without this contract.

NND submits one existing typed native `set` or `reset` operation. Setting
`memory.enabled` to false also clears `memory.required`; setting
`memory.required` to true also enables `memory.enabled`. The form states that
effect before preview. Preview displays both effective values before and
after and verifies that a paired set produced both expected values. Save
reuses the exact previewed request, selected user source revision, resolved
revision, operation identity, and native receipt flow. A project shadow,
permission denial, or invalid native preview leaves Save unavailable. A saved
receipt remains `not_applied` until NNA's own activation or restart behavior.
