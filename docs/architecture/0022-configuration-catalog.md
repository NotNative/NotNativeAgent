# Architecture decision 0022: Descriptive native configuration catalog

Status: static manifest foundation in `20261002-12`. Scoped HTTP adapters and GUI
coverage remain separate required work. No catalog metadata grants authority.

## Decision

Native structural keys and scalar rules are shared executable descriptors, rather
than a second GUI schema copied from prose or normalized configuration. Existing
validators consume `MANIFEST_KEYS`, `CONFIGURATION_KEYS` and 44 numeric
`CONFIGURATION_RULES`. The extraction preserves native acceptance, error codes,
legacy migrations, unset/null/zero behavior, inheritance and computed defaults.
`config-bounds.js` retains its existing public scalar helper exports.

`CONFIGURATION_CATALOG` is a pure, frozen, serializable descriptor containing 223
manifest fields and dynamic entries. `buildConfigurationCatalog` checks exact key,
structural path, family and scalar-rule coverage. New unclassified fields fail;
they never acquire editability through an inferred name or permissive fallback.
Finite route roles and TUI bindings come from their existing native owners.

The catalog reads no files, environment values, credentials or working directory.
It does not synthesize effective defaults by resolving a fixture manifest. Numeric
constraints occur once in `scalar_rules`; field validation references those rules.
Literal, inherited, computed, absent and authority-derived defaults remain distinct.
Parser fallback is separate from effective configuration inheritance and migration.

## Descriptor boundaries

Each field has an explicit classification, type, validation owner, default and
sensitivity. Provider singular/plural alternatives share logical identity. Credential
entries describe references and source-dependent fields, never credential values.
MCP fields carry transport conditions, distinguishing stdio command/args/cwd from
HTTP endpoint fields. Ordinary unsupported keys still warn where the native
validator historically warned; descriptor extraction does not tighten that policy.

Permission posture, mission, authenticated-host grants, hosted skills, migration
markers and generated capability state are not generic editable settings. In
particular, provider streaming resolves to true and is not an editable effective
toggle. Telemetry retention remains an optional string. Copied MCP tool effects
retain their actual permissive acceptance and downstream normalization evidence.

`source_layers` describes resolution stages, including explicit manifest selection;
it is not an authorized write-scope list. `editability.available` remains false until
the scoped native adapter is implemented. Application metadata distinguishes runtime
publication, new-session requirements, construction-time consumers and invocation
preferences; untraced effects remain explicitly unverified. General runtime validation
does not prove every coordinator or session applied a saved setting.

## Verification

Independent scalar review compared 1,036 original-versus-extracted resolution cases
and observed identical configurations or error codes/messages. Cases include numeric
boundaries, invalid types, both provider forms, all route roles, zero/null/absence and
legacy timeout combinations. Focused scalar/authority/Dream/source-publication tests
passed. Independent catalog review repaired explicit source precedence and MCP
transport conditions, and strengthened unclassified structural coverage. Catalog,
rules and keys passed 20 focused tests. Full validation identified two missing
scalar error-code registrations; the repaired focused catalog/failure taxonomy
suite passed 27 tests. The exact frozen Windows build then passed 1,822 tests,
with eight skips and zero failures. Quality and current graph/language checks
passed for 444 production modules. Windows is the executed platform.

## Next executable slice

Add authenticated native catalog and selected-source read/preview/save/repair routes.
Use ADR 0021 exact-byte revisions, bounded typed intents and operation receipts.
Validate the whole resolved result with the actual native resolver and hosted
authority options. Expose explicit presence/value and effective source separately;
return saved revision and pending runtime application honestly. Do not return raw
unknown file fields or credential values. Require independent scoped authorization
for every action; catalog editability cannot authorize a write.

Manifest descriptors do not cover nonmanifest stores. Web search/fetch, gateway,
OpenCode compatibility, trust, secrets, hooks, skills, environment, installation and
updates require their existing native normalizers and typed action adapters. The NND
coverage ledger remains partial until those families and installed GUI effects are
verified. This static module enables none of those mutations or release claims.
