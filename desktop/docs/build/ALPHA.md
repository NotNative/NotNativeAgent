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

## Acceptance ledger at NND 20261009-12 / NNA 20261009-1

| Gate | Current evidence | State / next proof |
| --- | --- | --- |
| A1: independent installed service and two doors | Disposable source install, authenticated Chromium and Electron, surviving service, restart and desktop reattach passed on the pinned pair. | Verified for the disposable source fixture; operator profile and prebuilt distribution are separate gates. |
| A2: setup without provider | `installed-source-acceptance.mjs --native-setup-turn` starts without a manifest, observes denied execution, repairs through the visible NNA configuration form, activates through Providers, waits for the native model route, and checks authenticated same-window reload plus a governed text composer turn. NND `20261009-3` passed the combined desktop/browser missing-source journey. NND `20261009-4` passed a separate fresh installed `--native-malformed-setup-turn` journey with invalid-source repair, first turn, reviewed writes, attachments, restart, and desktop reattachment. | Verified for both missing and malformed source in disposable installed fixtures. |
| A3: core chat and files | Installed text-only, direct file, and composer file-only sends reached fixture providers; names survived restart; duplicate retry did not resend. Unsupported PDF was rejected before a native turn and remained a correctable draft. | Verified for fixture provider and Chromium; add a desktop-originated turn and remaining attachment failure cases. |
| A4: native review | Earlier installed multi-root F1 journey proved exact reviewer approvals, governed disk effects, and sibling-root refusals. A fresh NND `20261009-11` / NNA `20261009-1` source install sent distinct approved and denied writes from each Chromium and Electron composer. Each new UI-created session had the matching native reviewer decision and a visible completed or failed Activity row. The allowed fixture file contained the exact content; the denied file was absent. Attachment delivery, service restart, and desktop reattachment passed in the same journey. | Verified for the alpha's mandatory allow/deny journey on the pinned disposable pair. Broader review cases remain in the MVP F/verification gates. |
| A5: safe alpha surface | The installed native service refuses terminal access and NND-owned Git, file, queue, scheduled-task, plan, skill, both update-install aliases, and other out-of-scope mutations before route handlers. Private NNA-child browser and memory callbacks require their secret and refuse native-alpha effects. A route inventory test tracks literal registrations; focused tests cover the dynamic alias and private callbacks. NND `20261009-7` adds a default-closed Electron IPC allowlist and confines settings navigation to provider repair and native skill inventory; fresh installed setup observed IPC refusal. NND `20261009-9` filters native deep links to focus/session navigation and leaves legacy URL-handler registration to explicit development mode. Its installed `--native-attachments` journey observed 409 native-alpha refusal for both private callback paths and passed through restart and desktop reattachment. NND `20261009-12` closes legacy desktop IPC reads of local files, saved hosts, SSH configuration/status, mini-chat creation, and local client token. A fresh installed desktop renderer observed explicit refusals while native attachment and restart passed. | In progress: direct installed deep-link ingress proof (probe wired at NND `20261009-13`; the installed run is deferred to a daytime console and the three refusal/acceptance phases have not been observed yet) and remaining shell side-effect audit. |
| A6: installation and recovery | Source installer and prior transactional fixture journeys pass. NND `20261009-6` passed `--native-removal` in a fresh fixture with the service live before uninstall. The selected NNA lock-release wait, package/shortcut removal, service shutdown, and byte-for-byte NNA runtime/configuration plus retained NND data checks passed. NND `20261009-10` / NNA `20261009-1` passed a fresh short-path disposable prebuilt first-install smoke: inert stage, unchanged selection before activation, terminal native activation and public controller attachment, authenticated Chromium and Electron, stop, and NND-only uninstall. Failed activation fixtures remain preserved. | Source install/removal and prebuilt first-install smoke verified on the pinned pair; prebuilt failed activation, upgrade/rollback, reinstall, and operator trial remain open. |
| A7: operator trial | No operator installation or data migration has been performed for this milestone. | Open: use a named isolated profile only after A2–A6 pass; record feedback separately from MVP closure. |

An alpha gate is verified only by observed behavior on a pinned pair. A prior
version's evidence is a regression lead, not current-pair closure. Keep failed
fixture evidence until its owner and cleanup state are known.

## Fast execution order

1. Finish A5's direct installed deep-link ingress proof and shell side-effect
   audit; keep side-effecting routes and controls without native root and review
   guarantees fenced from alpha.
2. Publish a short source-installed alpha run sheet with exact supported
   controls, isolated profile setup, and recovery steps. Recheck the pinned
   A2–A4/A6 journey if the remaining surface work changes it.
3. Invite the operator into the isolated A7 profile. Log findings against
   alpha gates or the existing C/F/L/V packages without expanding alpha scope
   on each feedback item.

The broader [execution ledger](EXECUTION/LEDGER.md) remains the authority for
MVP package status. Alpha completion never promotes C/F/L/V rows by itself.
