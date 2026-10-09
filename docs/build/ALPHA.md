# Windows testable alpha

Status: acceptance scope adopted for early operator testing; **not yet ready for
hands-on installation**. This is a narrower milestone than the broad Windows
MVP in [PLAN](PLAN.md). Open MVP packages and W-id obligations remain open.

## Purpose and boundary

Let one trusted Windows operator test the installed NNA-owned NND service,
browser and desktop doors, and a governed chat in an isolated profile and
workspace. The first alpha can use a source-built payload and an explicitly
configured native provider. It does not certify a prebuilt distributable,
general operator-machine upgrade, or feature parity.

The alpha must preserve NNA's independent TUI, native reviewer, authenticated
authority, durable session state, and explicit service ownership. It must not
offer auto-accept, a Full control mode, a mock execution fallback, or a second
NND-owned agent engine. Never use an operator's existing NNA data or source
repository as the disposable test profile.

## Operator journey required for first hands-on test

1. Select one exact NNA installation and one admitted local workspace. Install
   NND into a separate disposable profile without altering another NNA or NND.
2. With no provider configured, reach authenticated setup/status from Chromium
   and the desktop. Execution stays unavailable until native configuration is
   valid. Configure one provider through an explicit native-authority path.
3. Create a session, send text, then send an image and text file. Observe the
   provider input, settled reply, attachment names, and a rejected unsupported
   file whose draft remains correctable.
4. Exercise one mandatory reviewer denial and one permitted operation. The
   browser and desktop must show native outcomes without an approval bypass.
5. Close both interfaces while the service stays alive. Restart the native
   service, reattach both doors, recover the transcript once, and retry a lost
   acknowledgement without another provider turn.
6. Stop and remove the disposable installation without touching NNA, its TUI,
   credentials, or unrelated workspaces. Record versions, commits, failures,
   and the exact profile used.

## Acceptance ledger at NND 20261008-27 / NNA 20261008-8

| Gate | Current evidence | State / next proof |
| --- | --- | --- |
| A1: independent installed service and two doors | Disposable source install, authenticated Chromium and Electron, surviving service, restart and desktop reattach passed on the pinned pair. | Verified for the disposable source fixture; operator profile and prebuilt distribution are separate gates. |
| A2: setup without provider | `installed-source-acceptance.mjs --native-setup-turn` starts without a manifest, observes denied execution, repairs through the visible NNA configuration form, activates through Providers, waits for the native model route, and checks authenticated same-window reload plus a governed text composer turn. The supervised one-use ticket/stop smoke passed. | In progress: Chromium GUI setup-to-turn is covered on the source-installed pair; desktop setup-required access and malformed-source repair still need installed proof. |
| A3: core chat and files | Installed text-only, direct file, and composer file-only sends reached fixture providers; names survived restart; duplicate retry did not resend. Unsupported PDF was rejected before a native turn and remained a correctable draft. | Verified for fixture provider and Chromium; add a desktop-originated turn and remaining attachment failure cases. |
| A4: native review | Earlier installed multi-root F1 journey proved exact reviewer approvals, governed disk effects, and sibling-root refusals. | In progress: prove an actual reviewer denial and one permitted effect on this pinned alpha pair in both doors. |
| A5: safe alpha surface | The installed native service refuses terminal access and NND-owned Git, file, queue, scheduled-task, plan, skill, and other out-of-scope mutations before route handlers. The main GUI labels the native alpha boundary and disables its primary controls. The installed source journey checks the server refusal and visible notice. | In progress: audit remaining routes and secondary UI entry points against the same boundary, then prove native reviewer outcomes on this pinned pair. |
| A6: installation and recovery | Source installer and prior transactional fixture journeys pass; current attachment fixture cleans up after success. | In progress: one pinned-pair fresh install, failed setup, rollback/removal journey and preserved-state check. |
| A7: operator trial | No operator installation or data migration has been performed for this milestone. | Open: use a named isolated profile only after A2–A6 pass; record feedback separately from MVP closure. |

An alpha gate is verified only by observed behavior on a pinned pair. A prior
version's evidence is a regression lead, not current-pair closure. Keep failed
fixture evidence until its owner and cleanup state are known.

## Fast execution order

1. Fence the A5 side-effecting routes and controls that lack native root and
   review guarantees. Preserve the full implementation for later F packages.
2. Close A2 and A4 with one installed setup-to-reviewed-turn journey; include
   refusal and retry outcomes.
3. Close A6 on a disposable pinned-pair install and publish a short alpha run
   sheet with exact supported controls and recovery steps.
4. Invite the operator into the isolated A7 profile. Log findings against
   alpha gates or the existing C/F/L/V packages without expanding alpha scope
   on each feedback item.

The broader [execution ledger](EXECUTION/LEDGER.md) remains the authority for
MVP package status. Alpha completion never promotes C/F/L/V rows by itself.
