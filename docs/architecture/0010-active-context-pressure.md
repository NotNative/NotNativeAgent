# Active Context Pressure

NNA treats a model's context window as a working resource, not a target to fill. Local-model
prefill latency often becomes operationally expensive well before the provider rejects a
request, so pressure management is active during a turn and deliberately conservative.

## Pressure stages

| Effective input use | Provider projection |
|---|---|
| Below 40% | Full eligible conversation projection. |
| 40% | Older settled history and tool payloads begin deterministic compression. |
| 55% | A deterministic continuity checkpoint replaces older active work; the newest two active steps remain verbatim. |
| 70% | Aggressive checkpoint projection retains the active request and newest active step. |
| 75% | Full transcript compaction begins. |

The denominator is the discovered model window after the bounded output reserve. Operators
configure the compression and full-compaction boundaries through `/context` or the Context
entry in `/config`; the two intermediate tiers are derived between them. Compression must
remain below full compaction. When discovery is unavailable, NNA plans against a conservative
65,536-token window with the configured output allowance reserved, as well as its validated byte
ceiling. Unknown capacity therefore activates
pressure controls instead of behaving like an unbounded token window.

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

At the same compression boundary, older successful tool results that are byte-identical to a
later result may become typed duplicate receipts when the replacement saves at least 512
bytes. The receipt carries the content digest and stable references to both durable records.
This content-identity pass works across different tools and request shapes, does not collapse
failures or protected active evidence, and never treats semantic similarity as identity.

## Hot context and cold evidence

The provider sees a bounded hot working set; it does not receive the entire durable session
merely because those records exist. NNA compares that provider projection with the complete
session ledger before each model call. When attributable records are absent from the hot set,
NNA injects a small engine-generated inventory containing only record counts, type counts, and
at most three query-relevant redacted discovery snippets with stable record indexes. The
inventory does not summarize all history and is explicitly neither evidence nor authority.

The agent must use `session.search_history` and then `session.read_history` before an omitted
record supports an assertion, decision, or action. This keeps older information available
without forcing every past tool payload back through a local model on every step. Simple,
self-contained requests do not trigger reflexive history searches. Full records remain in the
session journal, while content-free `context.cold_evidence` telemetry records inventory size,
type counts, hint count, and a deterministic catalog fingerprint.

## Reliability boundaries

- Pressure is reevaluated before every provider call, including calls made after tool results.
- Provider projections never rewrite or delete journal records.
- Omitted records remain deterministically discoverable; absence from hot context is never
  treated as proof that an event or decision did not occur.
- The active user request is always retained.
- Full compaction protects the newest three active model/tool steps rather than the entire active
  turn, so audits and research runs can shed settled work while continuing.
- Deterministic checkpoints record the objective, bounded model-reported progress, and settled
  tool receipts. The agent can retrieve exact older evidence from session history when needed.
- Compaction has no lifetime per-turn count. It stops only after repeated attempts against the
  same unchanged source fail to make progress.
- Pressure tier, raw projected tokens, checkpoint fingerprints, retained-step counts, source and
  projected tool-result bytes, checkpoint bytes, and repeated exact file-read counts are emitted
  to local telemetry. These measurements contain counts and byte totals, not paths or content.
- Compression efficacy records pre/post bytes and tokens, reducer attribution, tokenizer
  identity, and fallback status. History retrieval records rediscovery cost so nominal token
  savings cannot conceal repeated recovery work.

## Optional memory integration

NNA owns session-local continuity and works without NotNativeMemory. Cold-evidence inventory
and session-history retrieval are core NNA behavior. NNM remains an optional cross-session
semantic-memory integration rather than a prerequisite for finding this session's history.
When the NNM client bundle is installed,
it may subscribe to `context.checkpoint:post` and append the checkpoint to NNM's verbatim
continuity layer. That subscription is nonblocking and performs no semantic write or additional
LLM analysis, so an unavailable NNM server cannot stall the active NNA turn.

This mechanism is distinct from LM Studio prompt/KV caching. Provider cache tuning can improve
prefill cost further, but NNA does not currently assume a particular host's caching behavior.
