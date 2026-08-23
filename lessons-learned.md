# Lessons Learned: NNA Agent-Harness Efficiency Investigation

Date: 2026-08-23

## Purpose

This document explains what we learned while investigating why NotNativeAgent (NNA) took substantially longer than OpenCode to complete a comparable agentic task using the same Qwen3.8-27B model on the same local hardware.

The objective was not to turn NNA into OpenCode. The objective was to identify which harness behaviors caused excessive reasoning, delayed useful action, duplicate work, and context growth—and determine whether those problems could be corrected without sacrificing NNA's identity, governance, semantic review, permissions, or telemetry.

## Executive summary

The model itself was not the primary problem, and NNA's identity/system prompt was not the cause of the 32,000-token reasoning events.

The poor behavior resulted from several interacting harness-level factors:

1. Verbose provider-facing tool descriptions and schemas caused Qwen to deliberate excessively before selecting a tool.
2. Making a direct file-writing tool visible during the initial native-thinking request triggered planning runaway, even when its schema was compact.
3. NNA's Qwen reasoning-off control was not honored by LM Studio because the request omitted the host-compatible `reasoning_effort: none` field.
4. Qwen sometimes emitted many identical tool calls in one response. NNA executed and replayed all of them, multiplying side effects and consuming the context window.
5. Output limits and provider hints helped only after reasoning suppression worked, and neither was sufficient as a hard behavioral invariant.
6. Repeated tool results were replayed until recovery boundaries were reached, allowing small loops to become large context costs.

After correcting those interactions in the locally installed runtime, NNA retained its governance and telemetry while completing:

| Validation | Observed result |
|---|---:|
| Original NNA comparison run | 234m 58s |
| Governed ocean-scene validation | approximately 46s |
| Inspect–edit–verify coding validation 1 | 27.8s |
| Inspect–edit–verify coding validation 2 | 27.7s |
| First useful tool in final validation | 2.44s |
| Final replay size in final validation | approximately 7.2K estimated input tokens |

These results demonstrate that NNA can approach the target harness's useful-action timing without removing its review or governance mechanisms.

## Scope and method

The investigation used a log-first comparison between:

- The 234m 58s NNA session `session_4fd19fcd-e3c8-4d40-af3d-12f0708f0a69`.
- The 46m 45s OpenCode session `ses_fde0a34eaffe5UDgQeH67zjO1b`.

The comparison examined provider latency, token accounting, context replay, reasoning replay, tool schemas, duplicate calls, recovery, compaction, review latency, verification loops, and time to a working artifact.

Changes were then tested against the locally installed copy of NNA. The repository implementation was deliberately left unchanged during experimentation. Variables were changed individually or through small factorial tests, and a content-free diagnostic probe recorded only timing and cumulative counts for reasoning, visible text, tool fragments, and transport bytes.

This distinction matters: the conclusions below are behavioral findings supported by controlled installed-runtime experiments. They are not assumptions inferred from reading the production source code.

## What we learned

### 1. Tool definitions actively shape model behavior

Provider-facing tool definitions are not passive API documentation. Their names, descriptions, argument names, constraints, and combinations influence how the model plans.

A single original `fs.list` definition produced a correct call in approximately 3.6 seconds. A compact shell definition also produced a useful call quickly. However, either the original verbose shell description or its original parameter block was independently sufficient to recreate a 90-second-plus reasoning run.

This means tool-schema size is an incomplete metric. Semantic density, prescription, and capability composition matter in addition to byte count.

**Lesson:** NNA should retain rich internal tool contracts for validation and governance, but models should receive a separate, deliberately concise provider-facing facade.

### 2. Direct write visibility changed the model's planning mode

The compact combination of `fs.list`, `fs.read`, and `shell.run` produced an initial tool call in approximately 3.6 seconds. Replacing `fs.read` with compact `fs.write_text`, while holding the model, prompt, hardware, and other controls constant, produced more than 6,000 reasoning characters in 30 seconds without a tool fragment.

When write capability was hidden during the orientation request and revealed after the first grounded observation, the same model called a tool in roughly 2.4–3.2 seconds and then created artifacts normally.

**Lesson:** Capability timing is as important as capability availability. Progressive disclosure can reduce planning ambiguity without permanently removing functionality.

### 3. The reasoning-off control was host-incompatible

NNA treated Qwen as a binary-thinking model and sent only:

```json
{
  "chat_template_kwargs": {
    "enable_thinking": false
  }
}
```

LM Studio did not honor that field by itself. The diagnostic stream continued to contain hidden reasoning for minutes, even though NNA's manifest said thinking was disabled.

Sending both controls solved the problem immediately:

```json
{
  "reasoning_effort": "none",
  "chat_template_kwargs": {
    "enable_thinking": false
  }
}
```

Post-tool reasoning then measured zero.

**Lesson:** Reasoning controls must be qualified against the model-and-host combination. Model-family assumptions alone are insufficient, and telemetry should describe effective wire fields rather than desired configuration.

### 4. Output ceilings do not substitute for correct reasoning control

Lowering the output ceiling did not stop the long delays while the provider continued emitting hidden reasoning. Once the host-compatible reasoning-off fields were present, an 8,192-token post-tool ceiling became useful for bounding malformed or repetitive tool-call output.

**Lesson:** Token ceilings are containment controls. They cannot repair an ineffective reasoning-mode configuration.

### 5. Provider parallel-call settings are hints, not guarantees

With reasoning disabled, Qwen sometimes generated large batches of repeated calls. Observed responses included 10 effectively identical writes, 53 repeated writes across several files, and smaller duplicate batches.

Sending `parallel_tool_calls: false` dramatically reduced the behavior, but occasional duplicate pairs still occurred.

**Lesson:** Provider settings should reduce risk, but the harness must enforce its own invariants before executing side effects.

### 6. Duplicate execution caused context growth

Before deduplication, NNA executed every valid repeated call and replayed every result. One subsequent provider request grew to roughly 35,000 estimated input tokens. The base prompt was not consuming the context window; duplicated assistant calls and duplicated tool results were.

An exact-call guard using the tool name plus canonicalized arguments prevented duplicate execution and replay. Each suppression was recorded with assembled, retained, and suppressed counts plus provider-call correlation.

**Lesson:** Deduplication belongs before execution and before transcript capture. It must be governed and observable rather than silently discarding model output.

### 7. Governance was not the dominant source of latency

In successful validations, semantic-review calls generally took approximately 0.8–1.2 seconds. Permissions, reviewer decisions, tool lifecycle events, results, token receipts, and terminal records remained active.

The large delays occurred inside primary-model reasoning and repeated generation, not inside the governance path.

**Lesson:** Improving provider interaction and loop control can deliver large performance gains without weakening review.

### 8. The NNA identity prompt was exonerated

Substituting the OpenCode prompt did not prevent a 32,000-token reasoning event. Restoring NNA's original prompt remained compatible with fast tool use and successful completion. In one comparison, the restored NNA prompt also used fewer estimated initial input tokens than the OpenCode prompt under test.

System-message ordering and flattening were reasonable request-hygiene improvements, but they did not cause or cure the runaway behavior.

**Lesson:** NNA does not need to surrender its identity to become efficient. Prompt replacement would have treated a visible difference as the root cause without experimental support.

### 9. Recovery guidance cannot compensate for an unsuitable active tool set

In one experiment, write capability was intentionally unavailable. The model eventually repeated the same successful 16-line read twelve times. Recovery guidance escalated, but the model did not change strategy, and replay grew to approximately 21,000 estimated input tokens before the hard boundary stopped the turn.

**Lesson:** Recovery should consider whether the currently exposed capabilities can satisfy the next required action. Repeating textual guidance is not enough when the available action space is wrong.

### 10. Local-provider silence is a separate failure mode

One response emitted partial tool fragments and then stopped delivering bytes for more than two minutes. This was neither hidden reasoning nor a large context. Trusted-local provider routes currently allow stream deadlines to be unset unless explicitly configured.

**Lesson:** NNA should distinguish active reasoning, active tool generation, transport activity, and total transport silence. A no-byte watchdog can recover a stalled stream without penalizing a slow but active local model.

## The successful control pattern

The installed-runtime candidate used this sequence:

1. Preserve the original NNA identity and policy prompt.
2. Expose compact observation-oriented tools for the initial request.
3. Allow native thinking for that short orientation step.
4. After the first tool result, expose compact search, write, and edit capabilities.
5. Send both LM Studio-compatible reasoning-off controls.
6. Apply an 8,192-token post-tool output ceiling.
7. Send and record `parallel_tool_calls: false`.
8. Deduplicate exact calls before execution and replay, recording every suppression.
9. Preserve the normal reviewer, permission, lifecycle, receipt, and terminal paths.

This was sufficient to meet the target timing on the tested tasks without converting NNA into a shell-only or minimally governed harness.

## Recommended engineering direction

### Provider-facing tool facade

Introduce an explicit separation between:

- Rich internal definitions used for governance, validation, execution, cataloging, and operator explanation.
- Compact provider definitions optimized for model selection and argument generation.

The provider facade should be versioned and tested as part of the model interface.

### Phase-aware capability selection

Capability disclosure should respond to turn state and evidence rather than expose the entire registry on every request. The policy must remain general-purpose and auditable, not task-specific.

### Host-qualified reasoning policy

Provider qualification should determine which reasoning fields the configured model host honors. The request manifest should record precisely what was transmitted.

### Harness-enforced call invariants

Use `parallel_tool_calls: false` as a hint, then enforce exact-call deduplication in NNA. Later work can add carefully bounded effect-aware repeat detection across model steps.

### Stronger stopping and liveness controls

- Stop or change strategy after 2–3 identical successful observations.
- Add a configurable local-provider no-byte timeout.
- Keep transport activity separate from semantically useful progress.
- Do not allow recovery text itself to grow indefinitely.

### Wire-accurate telemetry

Provider manifests should include the actual values of tool choice, parallel-call policy, output ceiling, reasoning effort, thinking flags, template arguments, capability phase, schema count, and schema bytes.

## Regression criteria

Future changes should be evaluated against measurable harness outcomes:

| Metric | Suggested target |
|---|---:|
| Time to first useful tool | less than 5s on a warm local model |
| Post-tool hidden reasoning | zero when off mode is selected |
| Duplicate side-effect execution | zero |
| Small inspect–edit–verify task | less than 60s |
| Final replay for a small task | less than 10K input tokens |
| Reviewer latency | reported separately from primary-model time |
| Identical successful observations | strategy change by repetition 3 |
| Governance and lifecycle coverage | 100% retained |
| Natural stopping | no unnecessary verification loop after success |

These should be tested across multiple task shapes. One greenfield visual task is insufficient to establish general harness quality.

## What should not be discarded

The investigation does not support removing:

- NNA's identity or policy prompt.
- Semantic review.
- Permission enforcement.
- Rich internal tool contracts.
- Native filesystem tools.
- Lifecycle, receipt, recovery, and forensic telemetry.

The core lesson is that governance richness and model-interface complexity do not need to be the same thing.

NNA can maintain a detailed, strongly governed internal system while presenting the model with a compact, progressively disclosed action surface.

## Evidence references

- Original NNA run: `session_4fd19fcd-e3c8-4d40-af3d-12f0708f0a69`
- Successful ocean validation: `session_d91445c6-c979-454c-9f2e-a8a1cd18eb3c`
- Successful coding validation: `session_76ba5d35-7063-492c-bdad-daf3d8de39b1`
- Clean final validation: `session_05a4a9bc-b14f-415d-86c9-12bfd42bd37d`
- Detailed experiment ledger: `C:\Users\Mongrel\.codex\visualizations\2026\08\22\01a02a61-05b4-7cd0-b186-0058bc81a537\nna-prompt-test\experiment-ledger.md`
- Consolidated installed-runtime findings: `C:\Users\Mongrel\.codex\visualizations\2026\08\22\01a02a61-05b4-7cd0-b186-0058bc81a537\nna-prompt-test\installed-candidate-findings.md`

## Status

The findings above have been validated in the locally installed NNA runtime. They have not yet been translated into production source changes. Any codebase implementation should preserve the experimental controls as independently testable policies rather than copying benchmark-specific conditionals.
