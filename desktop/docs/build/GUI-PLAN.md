# GUI planning map

Updated 2026-10-01; amended for the 20261011-6 canonical installer/lifecycle shape
(dumb-copy installers, NNA-branded shortcuts, `nna desktop` operator commands,
service-linked tray). The executable build sequence is [PLAN](PLAN.md), whose
Product and completion contract pins that shape.
NND is a separately installed optional GUI product backed by independent NNA.
The NNA TUI keeps its own identity, tabs and sessions. Browser and Electron are
interfaces to the installed NND service, whose lifecycle NNA supervises.
**Folded 20261012-2:** the NND repository now lives inside the NNA repository at
`desktop/` (one repo, one version, one gate run, one commit); internal identity
remains NND/NotNativeDesktop and user-facing surfaces are NNA-branded.

## Current implementation guides

| Guide | Agent responsibility |
|---|---|
| [Architecture audit](EXECUTION/01-architecture-audit.md) | Read ownership and confirmed gaps before changing existing code; the installer/lifecycle findings are superseded by the 20261011-6 canonical shape — execute installer work from [02](EXECUTION/02-installation-lifecycle.md) as amended |
| [Installation and lifecycle](EXECUTION/02-installation-lifecycle.md) | Execute L1–L6: native supervision, renewable authority, attach, installer and release identity |
| [All NNA settings](EXECUTION/03-settings.md) | Execute C1–C7: field inventory, source/effective values, native mutations, GUI controls and coverage |
| [Chat and visibility parity](EXECUTION/04-feature-parity.md) | Execute F1–F10: native workflows and complete W-01–W-117 mapping |
| [Verification and handoff](EXECUTION/05-verification.md) | Execute V1–V6: installed journeys, recovery, upgrade, release evidence |

## Existing material and its role

| Document | Role |
|---|---|
| [SECTION-1 feature inventory](GUI-PLAN/SECTION-1-feature-inventory.md) | Stable UX requirements; native-policy amendments govern interpretation |
| [SECTION-2 snapshot](GUI-PLAN/SECTION-2-current-state.md) | Historical 2026-09-22 observation; not current implementation status |
| [SECTION-3 reference map](GUI-PLAN/SECTION-3-reference-map.md) | Historical upstream path traceability; no authority to copy code |
| [SECTION-4 earlier slices](GUI-PLAN/SECTION-4-slice-plan.md) | Historical A–G implementation chronology; not the next-agent sequence |
| [NOTE 17 experience](NOTES/17-nnd-gui-north-star.md) | GUI interaction intent, interpreted through current ownership and native contracts |

The native adapter exists. Mock behavior remains useful for isolated tests, but
cannot establish production parity. Feature completion requires the actual NNA
operation, clear unavailable/error states, recovery, and installed acceptance.
The first deployment is Windows on one computer. Remote, NNO organization contexts,
VS Code, native mobile and other OS installers remain outside that gate.
No chat or visibility capability is silently deferred by those platform exclusions.
