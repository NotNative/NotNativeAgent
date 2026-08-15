# Code review remediation ledger

Review: `7657f8f7-d2ca-4ad9-9134-1e70ebb9b52a`

Completed: 2026-08-15

## Coverage

- Raw findings reviewed: 1,973
- Exact duplicate findings: 47
- Unique findings dispositioned: 1,926
- Files covered by the review: 267 of 267
- Unique findings left undispositioned: 0
- Severity inventory: 21 critical, 525 high, 611 medium, 769 low
- Category inventory: 872 maintainability, 718 bug, 209 security, 97 performance, 16 style, 9 documentation, 5 other

Every unique finding was checked against the implementation and its surrounding contract. Reasonable findings were implemented, often with stronger input validation, bounded resource handling, failure preservation, cleanup, immutable data, named constants, explicit contracts, safer serialization, clearer naming, or focused regression coverage. Exact duplicates inherit the disposition of their matching unique finding.

The review's naming guidance was applied as well as functional/security guidance. In particular, the unconventional timestamp identifiers `began` and `beganProjection` no longer occur as variables in production code, tests, or scripts.

## Implemented themes

- Added or tightened input, result-shape, identifier, path, timestamp, configuration, and lifecycle validation.
- Preserved primary failures while making cleanup, audit, telemetry, and secondary failures observable.
- Hardened filesystem, process, Git, MCP, HTTP, WebFetch, WebSearch, clipboard, attachment, secret, and integration boundaries.
- Added bounded output, byte, record, collection, concurrency, deadline, and retention behavior.
- Replaced fragile serialization/equality paths with bounded, cycle-aware, stable, or deep comparisons where their inputs can be non-JSON-native.
- Improved atomicity and conflict detection for durable configuration, profile, secret, session, and task state.
- Consolidated repeated literals and mappings, clarified compatibility aliases, and normalized misleading or inconsistent names.
- Added defensive TUI state checks without swallowing errors that are intentionally handled by the central Console command pipeline.
- Added regression coverage for audit degradation, malformed evidence, cleanup failure, concurrency, boundary validation, and UI rendering cases.

## Rejected or intentionally retained findings

The following finding families were rejected because the proposed change was factually incorrect, would weaken an explicit contract, or would break compatibility. Closely duplicated findings share the same rationale.

| Finding family | Disposition and evidence |
| --- | --- |
| SPDX `OPTIONAL_DEPENDENCY_OF` is invalid | Rejected. It is a defined SPDX 2.3 relationship; all three critical duplicates were false. |
| POSIX `0o077` misses group-read permission | Rejected. `0o077` includes every group and other permission bit, including group read. The intent is now named/documented. |
| `null instanceof ContractError` throws | Rejected. JavaScript `instanceof` with a nullish left operand evaluates to `false`; it does not throw. |
| Cap a content hash before hashing | Rejected. Truncating before hashing destroys the identity guarantee and creates avoidable collisions. Input/output bounds remain enforced at the owning boundary. |
| Add local try/catch to every awaited TUI command | Rejected where applicable. The Console serializes, awaits, and reports command errors centrally; local catch-and-swallow logic would hide actionable diagnostics. |
| `/attachment` in managed-attachment usage is a typo for `/attach` | Rejected. `/attach` queues a new path, while `/attachment retry/remove` manages admitted attachments. |
| `/bundle` and `/support` must accept identical syntax | Rejected. `/bundle create PATH` is a compatibility alias; `/support PATH` is the canonical command. This is now documented inline. |
| Detached Windows uninstall should await final child exit | Rejected. The child deliberately waits for the parent to exit before removing the installation, so awaiting final exit would deadlock. Spawn admission errors are now observed. |
| `-ExecutionPolicy Bypass` alone creates a separable integrity boundary | Rejected. The installed CLI and uninstall script share the same user-writable trust boundary; the script independently validates its marker and challenge. |
| Pinned HTTP lacks certificate pinning | Rejected. The primitive pins the DNS-selected address against rebinding while Node HTTPS still performs normal certificate/hostname verification using the original host/SNI. |
| `NNA_HOME` must reject arbitrary absolute operator paths | Rejected. An explicit absolute override is the documented operator-controlled data-root contract. |
| Resume path traversal through `sessionId` | Rejected. `requireExternalId` excludes separators and traversal syntax before the identifier is joined to the session root. |
| NNO activation `relative()` escape check misses `foo/..` | Rejected. `realpath` and `relative` operate on normalized canonical targets; an outside target begins with `..`. |
| Loopback integration host should be externally configurable | Rejected. Loopback-only binding is a security boundary for the authenticated local NNO child service. |
| Integration readiness token should not be on stdout | Rejected. Stdout is the single atomic protocol channel consumed by the authenticated parent; stderr or a side file would break the IPC contract. |
| Public `src/index.js` exports are dead because internal tests import direct modules | Rejected. Repository-local import frequency does not determine the supported downstream barrel API. |
| Node crypto needs a browser/WASM fallback | Rejected. NotNativeAgent is an explicitly Node-hosted runtime and depends throughout on Node APIs. |
| `ContractError.retryable` is dead | Rejected. Retryability is consumed by provider, MCP, attachment, telemetry, failure-envelope, and recovery paths. |
| Context threshold ordering should use epsilon after clamping | Rejected. Equal thresholds after clamping are invalid by contract; accepting them with an epsilon would weaken strict tier ordering. |
| Group the flat active-engine state object into nested objects | Rejected. Its flat shape is a downstream engine contract; grouping would be a broad compatibility change unrelated to correctness. |
| Synchronous dream pause/resume must be awaited | Rejected. Those lifecycle methods are intentionally synchronous. |
| `providerReasoningControls('off')` nests `chat_template_kwargs` incorrectly | Rejected. The returned shape is already the expected top-level provider request shape and is covered by conformance tests. |
| Unknown reasoning modes should be tolerated | Rejected. Reasoning modes are a closed, validated provider contract; silent forward acceptance would send unsupported controls. |
| Dream should default disabled | Rejected. Idle maintenance is intentionally opt-out for standalone mode and forcibly disabled for authenticated hosted execution. |
| Empty `webbrowse` invocation is invalid | Rejected. No argument intentionally selects the read-only status operation. |
| `NO_COLOR=''` should mean false | Rejected. `NO_COLOR` is a presence-based ecosystem convention; an empty value still disables color. |
| Invalid environment booleans should warn and continue | Rejected. Configuration is intentionally typed and fail-fast rather than silently changing runtime behavior. |
| Empty tool-catalog context should be an empty string | Rejected. `null` is the established optional-context sentinel and prevents accidental blank prompt sections. |
| Support arbitrary Ctrl keys such as Ctrl+Space | Rejected. Configurable Ctrl bindings intentionally cover letters; named non-letter controls have explicit decoder actions. |
| Log from the detached update worker | Rejected. The worker is launched with stdio disabled and is best-effort; interactive update commands and persisted update state are the diagnostic surfaces. |
| Top-level await is incompatible | Rejected. The package is ESM and its supported Node runtime provides top-level await. |
| Apache license appendix placeholders should be replaced | Rejected. Those placeholders are part of the verbatim standard Apache-2.0 license text. |
| NOTICE must duplicate all third-party notices | Rejected. Required dependency attributions are maintained in `THIRD_PARTY_NOTICES.md`; speculative contributor names or pre-2026 dates were not invented. |
| Missing `20260804-5` release entry | Rejected absent evidence. Release history is an artifact ledger, not a required contiguous integer sequence; no hash or artifact exists to reconstruct a missing entry safely. |

## Verification

- `node scripts/quality-gates.js`: passed for 267 production files.
- `npm run check`: passed with 764 tests, 0 failures.
- Focused suites were run after each remediation batch in addition to the full suite.
- Identifier search for `began` and `beganProjection`: no variable occurrences (an unrelated prose sentence still uses the ordinary English word "began").

`npm run release:check` is not a code-quality pass/fail signal for this dirty remediation worktree. It currently reports stale sealed release artifacts and platform evidence (including missing native macOS evidence and older Windows/Linux evidence versions). Those artifacts must be regenerated and signed in the normal cross-platform release process; fabricating them during source remediation would be incorrect.
