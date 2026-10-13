// SPDX-License-Identifier: Apache-2.0
# Native model-input delivery matrix (W-113)

The explicit matrix of every path a model input takes from the operator
surface into the harness. Each row states the wire contract, where it is
implemented, and the test that pins it. Every row is currently
**implemented-unverified**: the `verified` column can only be earned by the
installed V-gates (real NNA harness observations), which is exactly the
honesty rule — mock/CI success never closes parity.

| # | Delivery path | Wire contract | Implementation | Pinned by | Verified (installed) |
| - | ------------- | ------------- | -------------- | --------- | -------------------- |
| 1 | Optimistic echo (live send) | `prompt_async` with a client-minted ascending `messageID`; the optimistic draft keeps that id until the `message.updated` echo reconciles it | `sync/session-actions.ts` `optimisticSend` + `addOptimisticDraft` | `actions-recovery.test.ts` §optimistic send | ⏳ owed |
| 2 | Definite-failure rollback | non-ambiguous send failure removes the optimistic draft and restores the previous status | `handleSendFailure` + `loaderOptimisticRemove` | `actions-recovery.test.ts` "rolls back a DEFINITE failure" | ⏳ owed |
| 3 | Ambiguous-failure confirmation | transport-tagged/5xx/timeout failures NEVER blind-rollback: reconnect-bound confirmation refetch (≤3 attempts at 250·2ⁿ⁻¹) confirms-in-place or rolls back only when provably absent | `isAmbiguousSendFailure` + `confirmSendLanded` | "CONFIRMS-in-place for an ambiguous landing", "waits for reconnect inside the confirmation window" | ⏳ owed |
| 4 | Text part | `{ type: 'text', text, synthetic?, systemContext? }` | `native-prompt-parts.ts` `promptWireParts` | upload test "text part passes through" | ⏳ owed |
| 5 | Native file upload | `uploadAttachment` → `{ type: 'file', upload_id }`; upload failure is transport-tagged (ambiguous) and rolls back through row 3; browser data URLs never enter prompt bodies | `promptWireParts` nativeUploads branch | "uploads native files before submitting a file-only prompt with a stable reference" | ⏳ owed |
| 6 | Non-native file reference | `{ type: 'file', url, mime, filename }` passthrough (desktop-owned storage) | `promptWireParts` else branch | same suite | ⏳ owed |
| 7 | Session-knowledge preflight part | pending session knowledge rides as the first `synthetic` `systemContext: 'session-knowledge'` text part; its delivery is recorded only after the send lands | `pendingKnowledge` + `recordKnowledge` | knowledge delivery tests (`session-knowledge` suite) | ⏳ owed |
| 8 | Steer / queue delivery | `prompt_async` carries `delivery: 'steer' \| 'queue'`; busy-session sends route through the server-owned queue with restore-to-composer on queue failure | `dispatchPrompt` + `composer-queue.ts` + `useMessageQueueStore` | queue store + composer-queue tests | ⏳ owed |
| 9 | Model/agent selection | `model: { providerID, modelID, variant? }` + optional `agent` on every prompt | `optimisticSend` input → `dispatchPrompt` | composer model-picker pins | ⏳ owed |
| 10 | Blocking-request answers | permission/question replies are NOT model inputs via prompt; they route to the NNA-owned review ports and fail closed for NNA runtimes | `replyToPermission` / `replyToQuestion` | `actions-recovery.test.ts` §blocking requests | ⏳ owed |

Contract invariants that hold across all rows: client-minted ids always
ascend; an ambiguous failure never double-sends (confirmation before
rollback); the failure evidence log (`getSendFailureLog`) records every
outcome (`confirmed` / `rolled-back` / `unconfirmed`) with its confirmation
attempts; stale-authority sends are refused before and after dispatch.

The installed V-gate runs must observe rows 1–5 and 7–8 against the real
harness (send → echo reconciliation, a forced failure and recovery, and an
ambiguous-failure confirmation) before any row may flip to `verified`;
runs are collected in `DEFERRED-VERIFICATION.md`.
