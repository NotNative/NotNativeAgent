# Native memory setting coupling

The authenticated native configuration preview/save endpoints retain their
existing typed `set` and `reset` operations for `memory.enabled` and
`memory.required`. A `set` now follows the same coupled behavior as NNA's TUI:

* Setting `memory.enabled` to `false` also writes `memory.required: false`.
* Setting `memory.required` to `true` also writes `memory.enabled: true`.
* Setting either field to the other boolean value writes only that field.
* Reset removes only the named explicit field, so normal defaults and source
  precedence determine the resulting value.

One request cannot contain operations for both fields. The paired writes are
atomic within the selected user manifest and preserve unrelated memory settings
and unknown private source keys. Preview shows both resulting values without
writing. Save uses the existing source/resolution compare-and-swap and returns
`application: not_applied`; it does not change a running session. If a trusted
project source owns either field that a paired operation would write, the
operation fails with `configuration_source_shadowed` before persistence.

The native catalog marks both fields with
`editability.coupled_fields: ["memory.enabled", "memory.required"]` only when
the save contract is available. A GUI must require that marker before offering
the coupled controls, use preview to show both resulting values before save,
and refresh after the persistence receipt. Older catalogs without the marker
cannot promise the paired behavior.
