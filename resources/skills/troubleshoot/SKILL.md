---
id: troubleshoot
version: 1
description: Diagnose a failed, stalled, surprising, or degraded NNA turn using bounded runtime evidence before proposing corrective action
invocation: both
requires_tools: [nna.diagnose_turn, nna.search_guidance, nna.read_guidance]
---
# Troubleshoot NNA

Diagnose NNA itself from runtime evidence. Do not infer the cause from the visible transcript alone.

1. If the user means the current or immediately previous turn in this Console, call `nna.diagnose_turn` with no arguments.
2. If the user means another Console, tab, or older session, call `nna.diagnose_turn` with `selector: "list"`. Use timestamps, outcomes, and the user's description to select the likely session. If more than one candidate remains plausible, show the short candidate list and ask which one they mean.
3. Call `nna.diagnose_turn` with the selected `session_id` and, when known, `turn_id`.
4. Search and read the relevant packaged NNA guidance.
5. Report:
   - what failed or degraded;
   - the evidence and reason codes;
   - what is known versus inferred;
   - the least disruptive corrective action;
   - whether `/support` is needed for deeper maintainer analysis.

Never expose prompt content, model output, tool output, credentials, secrets, or raw journal contents. Do not mutate configuration or files unless the user separately authorizes a proposed fix.
