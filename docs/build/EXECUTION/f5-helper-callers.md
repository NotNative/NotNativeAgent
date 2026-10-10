# F5 helper-caller inventory

Status: inventory at NND `20261010-9` / NNA `2709a6c4` (20261009-5). It answers
04-feature-parity F5 item 1: which model helper callers already ride native
operations, and which still resolve providers through legacy wires. It is the
scope source for the F5 rewiring slice; findings here do not close anything.

## The legacy seam

`server/lib/small-model/provider-ports.ts` resolves providers through the
legacy provider catalog (`GET /config/providers`, line 33) and, when no
explicit auth file is set, defaults to OpenCode's
`~/.local/share/opencode/auth.json` (lines 114-122; `NNA_AUTH_FILE`
overrides). The census `known_mismatches` row for this file (F5) stays open
and stays true. `routes/small-model.ts` exposes `/api/small-model` and
`/api/small-model/generate` over this seam.

## Callers

| Caller | Today's wire | Native operation | Verdict |
| --- | --- | --- | --- |
| Desktop notification text (`notifications/model-text.ts:37`) | Production path (no ports injected) calls `generateNativeNotification` → `POST /v1/nnd/sessions/:id/notification-text` (`native-text.ts:13`, NNA `nnd-notification-routes.js:7-14`); `SmallModelPorts` injection selects the legacy path (tests) | Exists | Native; no action |
| Git walkthrough (`routes/git-walkthrough-generate.ts`) | Default path rides the native `POST /v1/nnd/sessions/:id/walkthrough` (`:339-344`). The explicit-model selection branch (`:325-338`) instead calls legacy `generateSmallModel`, pulling provider identity through `provider-ports` | Exists, but rejects a model override: the body must carry exactly `revision` and `digest` (NNA `nnd-walkthrough.js:16`), and the call uses the resolved primary route | Mixed; the explicit-model branch cannot move to the native call without dropping per-request model choice — a product decision, not a free rewire |
| Session assist recap/suggestion (`session-assist/nna-session-assist.ts:68`) | Always legacy `generateSmallModel` → `provider-ports` | None: NNA ships no assist/recap operation (grep over `src/nnd-*.js` finds none) | NNA-side gap first; NND cannot drop the legacy wire without losing the feature |
| Goal audit (`goals/nna-goal-safety-ports.ts:64`) | Native `POST /v1/nnd/sessions/:id/goal-audit` (`nnd-operator-routes.js:10`) | Exists | Native; no action |
| Goal objective distillation (`goals/goal-distill.ts`) | Abstract `DistillPort`; production wiring folds to the registered trim fallback (the P-11 small-model adapter is not wired) | None | No legacy wire in production; honest fallback, no action |
| AI session rename | No caller found in NND web or UI source (no rename/assist naming route or component) | — | Absent here; if the feature exists it lives outside NND's helpers |
| `/api/small-model` HTTP surface (`routes/small-model.ts:67,76`) | Legacy resolution end to end | — | Legacy; kept only while legacy callers remain, listed on the alpha surface |

## Consequence for the F5 rewiring slice

Neither remaining legacy caller has a free native replacement: the walkthrough
explicit-model branch would lose per-request model choice (the native route
binds to the primary route only), and session assist has no NNA operation at
all. The walkthrough branch does keep a bounded native fallback possibility
(catch the legacy failure and retry model-less through the native route), but
the removal of `provider-ports` legacy reads — the census F5 mismatch row —
requires either an NNA assist operation or an explicit product decision to
retire the legacy small-model surface. This inventory records those
requirements; it does not work around them, and the guide keeps the mismatch
row open.
