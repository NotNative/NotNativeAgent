# ADR 0014: Context compression safety and measurement

## Status

Accepted.

## Decision

Context compression is a Reliability Engine projection. It may reduce the context sent to
a provider, but it never rewrites authenticated authority or the durable session journal.
A reduction is acceptable only when its guarantee is explicit, its effect is measurable,
and any omitted evidence has a deterministic recovery path.

NNA classifies compression work into four classes:

| Class | Meaning | Permitted behavior |
|---|---|---|
| `lossless` | The provider projection retains the same literal information. | Exact structural transformations and content-identity detection. |
| `recoverable` | Detail may leave the provider projection but remains addressable in the durable journal. | Typed ledger-backed receipts, bounded excerpts, and duplicate-result receipts. |
| `semantic` | Meaning is represented in a validated continuation rather than retained verbatim. | Schema-validated continuation refinement with deterministic fallback and exact journal recovery. |
| `protected` | Automatic rewriting could alter authority, policy, or active evidence. | No ordinary automatic reducer. Emergency context fitting remains bounded, explicit, and ledger-backed. |

Authenticated user input, system contracts, tool schemas, checkpoints, and content actively
needed by the current step are protected. Settled tool exchanges may be recoverable when the
complete record remains in the journal. Assistant continuation may use the semantic class
only through the validated continuation path.

## Cache-aligned semantic compaction

Semantic compaction may reuse the exact message-and-tool prefix of the oversized provider
request and append one bounded compaction instruction. This path is adaptive rather than
assumed: it activates only after the current process has observed a positive cache-hit
counter for the same provider profile and model. Cache evidence is bounded in memory and
does not enter the durable transcript or alter recovery semantics.

The aligned request preserves the prefix messages and tools exactly. A standalone semantic
request remains the deterministic default when there is no route-specific evidence, when
the route differs, or after the provider has rejected the prompt for size. Regardless of
request mode, schema validation is insufficient by itself: the refined continuation must
fit its summary budget and produce a strictly smaller projected context. Otherwise NNA
records the failed semantic attempt and retains the deterministic continuation fact.

Telemetry identifies standalone versus cache-aligned requests, observed cache-token
evidence, prefix bytes and fingerprint, and original versus projected bytes without
persisting the operator's content in those fields.

## Content-identity duplicate receipts

At an existing context-compression boundary, NNA fingerprints the exact UTF-8 content of
successful tool results. When an older cold payload is byte-identical to a later result and
the receipt saves at least 512 bytes, the provider projection may replace the older payload
with `nna.duplicate-result-receipt.v1`.

The receipt identifies the original and later record through request/provider-call
identifiers, ledger references, and a SHA-256 content digest. The
newest result and all protected records remain unchanged. Failed results, small payloads,
and unresolved exchanges are not content-deduplicated. Request/result structural pairing is
preserved, and the source transcript is never mutated.

This extends same-tool/same-target supersession to identical evidence returned through
different request shapes or tools without claiming that merely similar results are equal.

## Efficacy and equivalence

Every active-pressure or full-compaction projection records a
`context.compression_efficacy` measurement containing:

- source and projection fingerprints;
- pre/post bytes and tokens, absolute savings, and reduction ratios;
- reducer name, safety class, affected-record count, and directly attributable bytes where
  available; and
- tokenizer identity, exactness, and whether counting degraded to the conservative fallback.

History search/read telemetry records whether retrieval followed context compression and
the returned byte and estimated-token cost. This makes rediscovery visible alongside prompt
savings. Net savings may be negative; telemetry must not hide a false economy.

Recorded-session evaluations compare completion status, ordered material tool decisions,
and final outcome between an uncompressed baseline and a compressed run. A byte or token
reduction alone is not evidence of an equivalent agent outcome.

## Tokenizer identity

The dependency-free UTF-8 estimator remains the universal fallback. It estimates ordinary
ASCII from serialized bytes while counting non-ASCII UTF-16 units individually so combining
characters, emoji, and finely split non-Latin scripts cannot inherit an English-only ratio.
A provider or host may
inject a model-specific token counter, including a Qwen tokenizer, but every measurement
records its bounded identity and whether its count is exact. A failing, invalid, or
unavailable counter degrades to the conservative estimator rather than blocking execution.
NNA does not treat `cl100k_base` or any other unrelated tokenizer as exact for every model.

## Invariants

1. The journal is the evidence source; compression changes only the provider projection.
2. Authenticated user instructions are never rewritten by prompt-reframing heuristics.
3. Tool descriptions and schemas are never automatically shortened for token savings.
4. Content identity means exact bytes, not semantic similarity.
5. A recoverable receipt carries enough provenance to locate exact durable evidence.
6. Tokenizer provenance accompanies token counts, and fallback is explicit.
7. Compression value includes rediscovery cost and task-outcome equivalence.
8. New reducers must declare a class, bounds, recovery behavior, and verification evidence.
9. Provider cache reuse is an evidenced optimization, never a correctness dependency.
10. Semantic refinement is accepted only when its measured projection strictly converges.
