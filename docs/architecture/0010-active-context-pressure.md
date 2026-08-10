# Active Context Pressure

NNA treats a model's context window as a working resource, not a target to fill. Local-model
prefill latency often becomes operationally expensive well before the provider rejects a
request, so pressure management is active during a turn and deliberately conservative.

## Pressure stages

| Effective input use | Provider projection |
|---|---|
| Below 25% | Full eligible conversation projection. |
| 25% | Older settled tool payloads become bounded receipts; the newest three active steps remain verbatim. |
| 35% | A deterministic continuity checkpoint replaces older active work; the newest two active steps remain verbatim. |
| 45% | Aggressive checkpoint projection retains the active request and newest active step. |
| 60% | Full transcript compaction begins. |

The denominator is the discovered model window after the bounded output reserve. A configured
compaction threshold below 60% intentionally wins; a higher legacy or operator value cannot
delay the local-model safety boundary. When discovery is unavailable, NNA uses its
validated byte ceiling as a conservative fallback.

## Long-horizon compression

Pressure is not the only checkpoint trigger. NNA also refreshes its continuation after 12
completed turns, when settled tool-result payload reaches 10% of the effective input window,
or when a fingerprint proves that retained checkpoint records drifted. Only records after the
latest checkpoint contribute to the interval and payload triggers.

Compaction preserves the active turn and five newest completed turns under normal conditions.
Older tool exchanges become typed, redacted, ledger-backed receipts containing the tool,
material target, outcome, effect certainty, concise result, result fingerprint, and durable
ledger reference. Filesystem, search, shell, web, MCP, and sub-agent calls use category-aware
reducers. The durable transcript is never rewritten, and legacy checkpoints without retained
record fingerprints remain compatible.

## Reliability boundaries

- Pressure is reevaluated before every provider call, including calls made after tool results.
- Provider projections never rewrite or delete journal records.
- The active user request is always retained.
- Full compaction protects the newest two active model/tool steps rather than the entire active
  turn, so audits and research runs can shed settled work while continuing.
- Deterministic checkpoints record the objective, bounded model-reported progress, and settled
  tool receipts. The agent can retrieve exact older evidence from session history when needed.
- Compaction has no lifetime per-turn count. It stops only after repeated attempts against the
  same unchanged source fail to make progress.
- Pressure tier, raw projected tokens, checkpoint fingerprints, and retained-step counts are
  emitted to local telemetry.

## Optional memory integration

NNA owns continuity and works without NotNativeMemory. When the NNM client bundle is installed,
it may subscribe to `context.checkpoint:post` and append the checkpoint to NNM's verbatim
continuity layer. That subscription is nonblocking and performs no semantic write or additional
LLM analysis, so an unavailable NNM server cannot stall the active NNA turn.

This mechanism is distinct from LM Studio prompt/KV caching. Provider cache tuning can improve
prefill cost further, but NNA does not currently assume a particular host's caching behavior.
