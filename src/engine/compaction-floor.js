// SPDX-License-Identifier: Apache-2.0
import { buildContext } from '../context.js';
import { ContractError } from '../ids.js';
import { measureCompactionInput } from './compaction-measurement.js';

export function compactionFloorDiagnostic(engine, active, plan, bestCandidateTokens, bestProjection, lastError) {
  const staticEnvelope = measureCompactionInput(engine, plan.route,
    buildContext(engine.config, [], '', active.contextMeasurementEnrichment ?? active.enrichment,
      Number.MAX_SAFE_INTEGER), active, plan.planned);
  return {
    before_estimated_tokens: plan.beforeEstimatedTokens,
    best_candidate_estimated_tokens: Number.isFinite(bestCandidateTokens) ? bestCandidateTokens : null,
    static_envelope_estimated_tokens: staticEnvelope.estimated_input_tokens,
    static_envelope_exceeds_ceiling: staticEnvelope.estimated_input_tokens > plan.validationBudget
      || staticEnvelope.reserved_total_tokens > plan.planned.windowTokens,
    floor_status: 'bounded_attempt_diagnostic',
    compaction_attempts: 3,
    last_failure_code: lastError?.code ?? null,
    admissible_ceiling_tokens: plan.validationBudget,
    protected_record_count: bestProjection?.protectedRecordCount ?? null,
    oversized_protected_records: bestProjection?.oversizedProtectedRecords ?? null,
    largest_sections: staticEnvelope.sections?.slice().sort((a, b) => b.estimated_tokens - a.estimated_tokens)
      .slice(0, 4).map(({ id, estimated_tokens }) => ({ id, estimated_tokens })) ?? [],
  };
}

export function compactionFloorError(diagnostic, lastError, providerRejected) {
  // Compatibility: a provider rejection remains a provider-context-limit failure;
  // bounded candidates cannot establish a structural floor unless the static envelope exceeds capacity.
  const reason = providerRejected ? 'provider_context_limit'
    : diagnostic.static_envelope_exceeds_ceiling ? 'context_compaction_irreducible' : lastError.code;
  const error = new ContractError(reason, providerRejected
    ? 'provider rejected the input and bounded compaction cannot produce a smaller request'
    : `bounded compaction could not fit complete provider input within ${diagnostic.admissible_ceiling_tokens} tokens; reduce attachments, tool schemas, or protected conversation input`);
  error.detail = diagnostic;
  return error;
}
