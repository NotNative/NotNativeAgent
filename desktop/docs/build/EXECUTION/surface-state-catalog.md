// SPDX-License-Identifier: Apache-2.0
# Surface-state catalog (W-26)

Every operator surface states what it is doing truthfully: empty ≠ loading ≠
error, errors offer the recovery action, and copy never borrows data it does
not have. This catalog pins the exact strings per surface (05 §I; 05 §J#24).
All statuses are implemented-unverified until the installed V-gates run.

| Surface | State | Exact copy | Evidence |
| --- | --- | --- | --- |
| Chat transcript | Empty (no messages) | "Session is open, nothing has been sent yet." | `packages/ui/src/chat/transcript.tsx` (`chat-empty`), test `transcript-hydration.test.tsx` |
| Chat transcript | Hydration / boot | `Skeleton` (three pulse rows) before the store has the transcript | `packages/ui/src/chat/transcript.tsx` |
| Chat transcript | Older-page failure | "Could not load older messages. Retry above." + the retry button | `packages/ui/src/chat/transcript.tsx` (`load-older-messages`) |
| Chat transcript | Windowed history | "Show N older turns" (virtualization expander) | `packages/ui/src/chat/turn-window.ts`, `turn-window.test.tsx` |
| Sidebar workspace zone | Loading | "Loading sessions…" | `packages/ui/src/chat/session-sidebar.tsx` (`zone-empty`), test `session-sidebar-workspaces.test.tsx` |
| Sidebar workspace zone | Error | "Could not refresh sessions." + "Try again" retry button | same, `sidebar-sessions-error` |
| Sidebar workspace zone | Empty | "No sessions in this workspace yet." | same |
| Archive | Empty | "No archived sessions yet." | `packages/ui/src/chat/archive-view.tsx` |
| Archive | No search match | "No archived sessions match this search." | same |
| Timeline | Empty session | "No messages in this session yet" | `packages/ui/src/chat/timeline-dialog.tsx` |
| Timeline | No search match | "No messages found" | same, test `timeline-search.test.tsx` |
| Command palette | No command match | "No matching command" | `packages/ui/src/chat/command-palette.tsx`, test `command-palette.test.tsx` |
| Scheduled tasks | Empty | "No scheduled tasks for this project yet" (`scheduledUi.empty`) | `packages/ui/src/components/scheduled/scheduled-tasks-dialog.tsx` (`scheduled-empty`), `scheduledText.ts` |
| Worktrees | Empty | "No worktrees for this project yet." (`worktrees.empty`) | `packages/ui/src/lib/i18n/messages/en-runtime.ts`, test `worktrees-view.test.tsx` |
| Git status | Stale | "Could not refresh Git status; showing the last known result. Git changes are disabled until status recovers." | `packages/ui/src/lib/i18n/messages/en-git-ui.ts` (`gitUi.staleStatus`) |
| Terminal | Native session | "Terminal is unavailable for native sessions." | `packages/ui/src/components/MainLayout.tsx` |
| Permissions/questions | No open requests | presence-collapsed (no row rendered; nothing implies silence is consent) | `packages/ui/src/chat/blocking-cards.tsx`, W-32 prohibition |
| Usage / rate limits | No quota data | "No rate limits reported" — presence-collapsed, never borrows another provider's number | `packages/ui/src/chat/work-status.ts` (`usageRows` §G), test `p3c-work-status.test.ts` |
| Session assist | Missing recap/suggestion | section omitted (no fabricated recap) | `packages/web/src/server/session-assist/session-assist-runtime.ts` |
| AI rename suggestion | No small model | "No small model is available for suggestions" toast; nothing auto-applied | `packages/ui/src/chat/suggest-name.ts`, test `session-suggest-name.test.tsx` |
| Notifications receipt | Continuity probe | `{ delivered, chainHead, intact, anchored, prefixDigest, records }` (structured, no prose) | `packages/web/src/server/notifications/routes.ts`, test `delivery-receipt.test.ts` |
| Native alpha | Mutations while native review unverified | 409 `native_alpha_surface_unavailable`: "This action is unavailable in the installed native alpha until native review is verified." | `packages/web/src/server/routes/native-alpha-surface.ts` |
| Workspace recovery | Stale authority | explicit recovery controls (prompt/rename/fork blocked with "resynchronizing" refusals) | `packages/ui/src/chat/workspace-recovery-controls.tsx`, test `actions-recovery.test.ts` |

Copy rule: every error row names the recovery action (Try again / Retry /
Reconnect); every empty row says nothing is there rather than implying data
is loading; missing data renders as an absent section, never a fabricated
number (§G).
