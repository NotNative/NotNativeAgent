# Workspace URL router

> **Historical implementation note — 2026-10-01:** Retained for contracts and dated evidence.
> Current scope, ownership, remaining work, and acceptance are defined by
> [PLAN](../PLAN.md) and the [execution audit](../EXECUTION/01-architecture-audit.md).
> Old mock-only, auto-accept, lifecycle, and deferral instructions are superseded.
> A recorded test pass is limited to its stated version and surface.


Source contract: doc 01 §12. The shell uses query parameters without a router
library; NNA remains the authority for session identity and directory.

## Application and history

`settings` is resolved case-insensitively against the settings catalog.
`home`, `general`, `preferences`, and `openchamber` land on General; unknown
nonempty sections also land there. Settings take precedence over session,
tab, and file fields. Opening, navigating, and closing the settings window
updates history; Back/Forward updates the already mounted page. A bare URL
closes settings and preserves the selected session.

Initial normalization replaces history. Later explicit changes push history
only when the destination differs. Serialization writes settings alone while
open, otherwise the selected session; legacy tab/file fields are consumed
without being serialized. Unrelated host parameters and hashes survive.
Embedded, mini-chat, credential URLs, and VS Code keep their identity queries.
Forced desktop/mobile surfaces support normal routes and preserve `surface`.
Route application does not grant permissions or
dismiss pending NNA requests.

## Context routes

Legacy `tab=git|diff|terminal|files` opens the operator rail within the chat
layout. `tab=chat` returns to chat. A file with `tab=diff` or no tab opens the
stacked diff view. Context requests wait for the resolved session directory
and the displayed chat identity, including the cold-session transition hold.
Compact layouts reveal the rail; docked layouts open its panel. Explicit
route targets can reveal a hidden pane. Normalization must retain a cold
tab intent until the bootstrap supplies its workspace.

Git and stacked diff share the Changes rail entry. The stacked view retains
its mounted state when another pane is selected. File links use the current
Git status workspace prefix, reveal the requested entry, and scroll to it;
an unavailable target has visible feedback. A new link resets a narrowed
scope so a staged-only or working-only file can be found. Later refreshes
do not repeatedly force the operator back to that entry.

## Verification scope

Parser, history, deferred session, and cold directory tests cover the routing
boundary. Actual SettingsWindow and OperatorRail tests cover retained page
navigation, hidden pane selection, directory switches, stacked file diffs,
and pane retention. DiffView tests cover nested workspace paths, manual
collapse, unavailable files, and scope transitions. Full UI/typecheck and
release gates are required for this slice. Live browser/PWA notification
acceptance and the remaining server notification routes remain separate work.
