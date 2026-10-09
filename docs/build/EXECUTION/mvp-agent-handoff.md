# MVP executor handoff: framework first

Status: execution map, not release certification. Recheck both repository heads and the [alpha ledger](../ALPHA.md) before starting. The source-installed Windows journey has reached authenticated Chromium and Electron, native setup, a governed turn, restart, and native-owned removal in disposable fixtures. A fresh disposable prebuilt first-install smoke reached public activation, both authenticated doors, and NND-only removal on NND `20261009-10` / NNA `20261009-1`. Upgrade, rollback, and interruption recovery still need complete installed acceptance.

Read [PLAN](../PLAN.md), [the ledger](LEDGER.md), [native slot activation](nnd-slot-activation-guide.md), [prebuilt payload](nnd-prebuilt-payload.md), and [verification](05-verification.md) first. The complete C and F scope remains in [settings](03-settings.md) and [feature parity](04-feature-parity.md). This file supplies a dependency graph and handoff rules for multiple agents; it does not reduce those acceptance criteria.

## Current gates and first testable milestone

| Gate | Current evidence | Required next result |
| --- | --- | --- |
| Source module journey | The disposable source-installed pair has passed browser and desktop attach, native setup, new UI-created approved and denied reviewed turns with visible Activity rows in both doors, restart, and NND-only removal. See the exact gates in [ALPHA](../ALPHA.md). | Close the remaining A5 alpha surface checks and operator-trial gate without treating source acceptance as prebuilt proof. |
| Immutable payload | NND exports a pinned prebuilt payload; NNA stages an inert verified slot. A fresh short-path Windows first-install smoke proved unchanged selection before activation, then selected the exported slot. | Exercise upgrade and interruption recovery against retained prior state. |
| Native activation | A fresh installed run completed the retained trial, terminal retirement, cleared witness, public controller attachment, Chromium and Electron attach, and removal. Earlier incomplete runs retain their barriers. | Exercise failure recovery and compatible upgrade/rollback. |
| Stable launcher | The prebuilt installer created a stable anchor and shortcuts; the smoke attached Electron from the selected slot. | Prove direct shortcut launch, selected-generation recheck, and upgrade behavior. |
| Complete MVP | The C1 census, C4–C7 settings, F1–F10 and W-id installed journeys remain open. | V1–V6 evidence against exact installed NNA/NND builds. Existing settings controls and native feature adapters are partial progress, not blanket parity. |

The **first operator-testable framework checkpoint** is the isolated source-installed [Windows alpha](../ALPHA.md): native setup, governed approval and denial in both UI doors, service survival, and NND-only removal, with the remaining A5 checks closed. It is narrower than the requested MVP and does not certify a prebuilt installer. Prebuilt activation, upgrade, rollback, and the complete C/F feature scope remain follow-on gates.

## Serial framework spine

Each line is a separate logical slice. Native dependency commits land before NND consumers. A failed or uncertain slice preserves exact evidence and stops dependent work.

1. **NNA retirement foundations** — promote and validate the private decision, cleanup, terminal commit, cleared witness, and same-owner native admission transition in that order. ADRs 0062–0066 describe their invariants. Keep the selected service lease and registry mutex where required; never infer shutdown from a dead parent or absent file. Real Windows process-death and ACL cases must exercise interruption prefixes. No public capability is advertised yet.
2. **NNA public activation** — complete public controller publication only after the cleared witness and live native admission transfer; then release the registry mutex while the same service lease remains held. Add durable ordinary-startup reconciliation that validates the terminal/cleared pair and process generation, plus exact private-controller authentication. Expose `nna nnd service activate-slot` and an exact-operation recovery/status CLI only after their native contracts, refusal cases, and idempotency are tested. Names here are target names; inspect current dispatch before coding. Do not offer a caller-controlled bypass flag.
3. **NND selected launch** — finish the candidate read-only resolver/desktop launcher against the public activation contract. Recheck selected NNA identity, package slot, completion/health, and generation immediately before attach. Desktop, Start Menu, and login entries use the stable command. Preserve browser code isolation and NNA TUI independence.
4. **Prebuilt install and upgrade** — production `install.ps1` detects one selected compatible NNA or guides a pinned dependency install, verifies its capabilities after installation, validates a trusted NND payload, stages it, invokes native activation, and reports completion only after authenticated health. Upgrade must retain the prior executable/state pair until trial and rollback decisions settle; pointer rollback alone cannot undo a data migration. Define dependency artifact provenance and checksum acquisition before promising unattended download. Keep the source-build installer explicitly separate.
5. **Prebuilt distribution acceptance** — on an isolated ordinary Windows profile, run new install, setup-required recovery, browser and desktop attach to one service/session, installer/desktop exit survival, independent TUI turn, reboot/login policy, failed stage/activation recovery, compatible upgrade, and NND-only uninstall/reinstall. Use exact build commits, versions, payload hash, NNA installation/data identity, operation receipts, and sanitized logs. Promote prebuilt distribution only when this observed path passes.

Do not start step 4 from an inert slot or private trial. Do not merge a stable launcher merely because it resolves valid package bytes; activation completion and live health are separate facts. No step may create NND auto-accept or Full control. NNA Default, Auto-review, and Unattended retain native reviewer governance.

## Parallel work after the activation contract freezes

Agents may work in separate worktrees on these lanes while the serial spine proceeds. Freeze shared native schema and ownership first; if a lane needs a new contract, merge its NNA prerequisite before its NND consumer. Rebase and retest on the actual promoted pair.

| Lane | Owned work | Depends on | Acceptance before merge |
| --- | --- | --- | --- |
| C census and settings | NNA native catalog/configuration/secret and external-store contracts; NND `packages/ui/src/components/settings/`, `packages/web/src/server/harness/nna.ts`, settings client and `settings-coverage.json`. Divide by settings family with nonoverlapping files. | Native setup/auth; C1–C3. | Every configurable key classified and mapped; typed control or justified noneditable disposition; native save/readback/effective apply, conflict and restart cases in both doors. C4–C7 remain open until all families pass. |
| F1/F2 identity and observations | NNA workspace/session admission and durable projection/activity; NND project, session identity and sync reducers. | Activated service identity. | Two roots plus worktree, restart, revocation, replay-gap and stale-cursor cases; no synthetic project or fabricated complete history. |
| F3/F4 chat | NNA governed submission, questions and session lifecycle; NND composer, attachment, timeline, fork/BTW and recovery surfaces. | F1/F2 and relevant C routes. | Real provider turn, mandatory reviewer denial, one-use operation identity after lost response, restart/reload, attachment delivery, fork and export in both doors. |
| F5–F8 visibility/context | Native model helper, file/browser, skills/MCP/memory contracts; NND respective server adapters and UI panels. Split by F package to avoid shared reducer and route conflicts. | F1–F3 and C. | Each W-id's real native success, refusal, restart, scope and browser-only case; no legacy OpenCode writer counted as NNA effect. |
| F9/F10 orchestration/presentation | Native goal/queue/schedule authority and NND durable intent, multi-run, attention, localization and accessibility. | F1–F8, C and persistent service. | At-most-once admitted occurrence, crash recovery, child scope, browser/desktop state parity and required W-id journeys. |

Ownership rule: NNA owns engine state, permissions, reviewer, configuration validation, persistent native service and execution receipts. NND owns installation UX, web/Electron presentation, per-device layout, and explicitly NND-owned organization data. A browser field, transcript, cached projection, or NND SQLite row cannot grant native authority. Assign one agent to each shared contract file at a time; other agents consume a frozen versioned fixture and may submit contract-change requests. Keep TUI tabs separate from NND sessions.

## Executor verification and stop rules

Use isolated worktrees and private fixture roots. Read `AGENTS.md` and existing scripts in each repository. For a code slice, run focused failure-path tests, the repository-required full suite, graph/language/quality gates, the relevant real NNA/NND integration, and installed Windows acceptance where the claim needs it. NND baseline commands include:

```powershell
pnpm --filter @notnative/ui test
pnpm --filter @notnative/web test
pnpm typecheck
node scripts/installed-source-acceptance.mjs D:\ProjectRepo\NotNativeAgent
node scripts/release-gates.js --write-hashes
node scripts/release-gates.js
```

Use the current NNA supported bounded full-test command and its graph/language/quality scripts; inspect `package.json` rather than copying an old invocation. A source-installed acceptance run is a regression gate, not prebuilt proof. Add a separate immutable-payload installed acceptance harness with ordinary-user, missing/incompatible/two-NNA selection, failure injection, upgrade, uninstall and independent TUI cases. Never run a fixture against operator data. Preserve uncertain failed fixtures for investigation.

After each logical slice, an independent adversarial agent traces only plausible failures through visible behavior, durable state and retry. Apply confirmed repairs, rerun affected checks, bump `yyyymmdd-<increment>`, regenerate repository graph/reports, seal if applicable, and commit. Record exact NNA/NND commits, commands, real outcomes, native contract version, reviewer findings and open W/settings rows in the ledger. A passing mocked test or aggregate test count cannot close V1–V6.

Stop the affected acceptance or mutation and report `blocked` when public activation cannot reconcile a crash prefix, child/lease identity is uncertain, controller admission precedes completion, or selected NNA identity changes. A settings write without native validation/application evidence or a feature requiring a missing native operation is an implementation gap: build and verify the native prerequisite first. Report `blocked` only if its authority or contract cannot be resolved from the owning NNA code and plan. Do not paper over these with UI-only states, fallback execution, automatic retry of unknown side effects, or a parity exclusion. Ask the implementation lead for a contract decision only after reproducing the concrete gap and documenting its downstream failure.
