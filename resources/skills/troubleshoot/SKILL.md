---
id: troubleshoot
version: 1
description: Diagnose a failed, stalled, surprising, or degraded NNA turn using bounded runtime evidence before proposing corrective action
invocation: both
requires_tools: [nna_diagnose_turn, nna_search_guidance, nna_read_guidance]
---
# Troubleshoot NNA

Diagnose NNA itself from runtime evidence. Do not infer the cause from the visible transcript alone.

1. If the user means the current or immediately previous turn in this Console, call `nna_diagnose_turn` with no arguments.
2. If the user names a tab or conversation title ("Short Story", "verify-fix"), call `nna_diagnose_turn` with `tab_label` set to that title exactly as the operator wrote it. If the result is `tab_label_ambiguous`, choose among its `candidate_session_ids` with the user's context or ask which one they mean.
3. If the label is unknown or absent, call `nna_diagnose_turn` with `selector: "list"`. Entries may include `tab_labels`, the operator-facing Console tab names or Desktop conversation titles; use those first, then timestamps and outcomes. If more than one candidate remains plausible, show the short candidate list and ask which one they mean.
4. Call `nna_diagnose_turn` with the selected `session_id` and, when known, `turn_id`.
5. Search and read the relevant packaged NNA guidance.
6. Report:
   - what failed or degraded;
   - the evidence and reason codes;
   - what is known versus inferred;
   - the least disruptive corrective action;
   - whether `/support` is needed for deeper maintainer analysis.

Never expose prompt content, model output, tool output, credentials, secrets, or raw journal contents. Do not mutate configuration or files unless the user separately authorizes a proposed fix.
