// SPDX-License-Identifier: Apache-2.0
import { activeContextRecords, buildContext, measureContext } from '../context.js';
import { estimateContextTokens } from '../context-budget.js';
import { buildColdEvidence } from '../cold-context.js';
import { ContractError } from '../ids.js';
import { shouldInspectProject } from '../project-intake.js';

export async function buildReportedContext(
  engine, records, content, enrichment, active, budgetBytes, limitBytes, budget = null, options = {},
) {
  const resolvedGuidance = engine.projectGuidance?.resolve ? await engine.projectGuidance.resolve(records) : [];
  const projectGuidance = engine.grounding?.admitProjectGuidance
    ? (await engine.grounding.admitProjectGuidance(resolvedGuidance, {
      turnId: active.turnId, authorityRef: active.authority?.id,
      scope: `project:${engine.config.workspaceRoot}`,
    })).admitted : resolvedGuidance;
  if (!enrichment.projectIntake && content && shouldInspectProject(content) && engine.projectIntake?.inspect) {
    enrichment.projectIntake = await engine.projectIntake.inspect();
  }
  const baseEnrichment = {
    ...enrichment, projectGuidance, skillCatalog: engine.skills?.catalog() ?? [], work: engine.work?.snapshot(),
    toolConstraints: active.toolConstraints ?? [],
  };
  active.contextMeasurementEnrichment = baseEnrichment;
  active.contextLimitTokens = budget?.effectiveInputTokens ?? null;
  const rawContext = buildContext(engine.config, records, content, baseEnrichment, Number.MAX_SAFE_INTEGER);
  const rawContextBytes = measureContext(rawContext);
  const rawContextTokens = estimateContextTokens(rawContext);
  const projection = options.projectContext ? await options.projectContext({
    records, rawContextBytes, rawContextTokens,
    effectiveInputTokens: budget?.effectiveInputTokens ?? null,
  }) : null;
  const contextRecords = projection?.records ?? records;
  const providerRecords = activeContextRecords(contextRecords).slice(-512);
  const coldEvidence = buildColdEvidence(records, providerRecords, content);
  const resolvedEnrichment = { ...baseEnrichment, coldEvidence };
  recordColdEvidence(engine, active, coldEvidence);
  const context = buildContext(engine.config, contextRecords, content, resolvedEnrichment, budgetBytes);
  active.contextBytes = measureContext(context);
  active.contextTokens = estimateContextTokens(context);
  active.rawContextBytes = rawContextBytes;
  active.rawContextTokens = rawContextTokens;
  if (budget?.scaledTokens && active.contextTokens > budget.scaledTokens) {
    throw new ContractError('context_too_large', 'context exceeds conservative token bound');
  }
  if (engine.surface === 'interactive_tui') {
    await engine.output({
      version: '1.0', type: 'context_status', session_id: engine.sessionId,
      turn_id: active.turnId, bytes: active.contextBytes,
      limit_bytes: limitBytes,
      estimated_tokens: active.contextTokens,
      limit_tokens: budget?.effectiveInputTokens ?? null,
      compression_threshold_tokens: budget?.compressionThresholdTokens ?? null,
      compression_level_2_threshold_tokens: budget?.compressionLevel2ThresholdTokens ?? null,
      compression_level_3_threshold_tokens: budget?.compressionLevel3ThresholdTokens ?? null,
      compaction_threshold_tokens: budget?.thresholdTokens ?? null,
      compression_threshold: budget?.compressionThreshold ?? null,
      compression_level_2_threshold: budget?.compressionLevel2Threshold ?? null,
      compression_level_3_threshold: budget?.compressionLevel3Threshold ?? null,
      compaction_threshold: budget?.compactionThreshold ?? null,
      output_reserve_tokens: budget?.outputReserveTokens ?? null,
      parallel_capacity: budget?.parallelCapacity ?? null,
      raw_estimated_tokens: rawContextTokens,
      pressure_tier: projection?.tier ?? 'none',
      measurement: 'estimated', source: budget?.source ?? 'configured_bytes',
    });
  }
  return context;
}

export async function emitCurrentContextUsage(engine, active, stepId = active.stepId) {
  if (engine.surface !== 'interactive_tui') return;
  const records = [...engine.transcript];
  if (active.stepText.length > 0 && active.stepText !== active.committedStepText) {
    records.push({
      type: 'message', role: 'assistant', content: active.stepText, trust: 'model',
      turnId: active.turnId, stepId, partial: false,
    });
  }
  const enrichment = {
    ...(active.contextMeasurementEnrichment ?? active.enrichment),
    work: engine.work?.snapshot(), toolConstraints: active.toolConstraints ?? [],
  };
  const context = buildContext(engine.config, records, '', enrichment, Number.MAX_SAFE_INTEGER);
  active.rawContextBytes = measureContext(context);
  active.rawContextTokens = estimateContextTokens(context);
  await engine.output({
    version: '1.0', type: 'context_usage', session_id: engine.sessionId,
    turn_id: active.turnId, step_id: stepId,
    current_bytes: active.rawContextBytes,
    limit_bytes: active.contextLimitBytes,
    current_estimated_tokens: active.rawContextTokens,
    limit_tokens: active.contextLimitTokens,
    measurement: 'estimated',
  });
}

function recordColdEvidence(engine, active, catalog) {
  if (!catalog) return;
  active.coldEvidenceFingerprints ??= new Set();
  if (active.coldEvidenceFingerprints.has(catalog.fingerprint)) return;
  active.coldEvidenceFingerprints.add(catalog.fingerprint);
  engine.telemetry?.record('context.cold_evidence', 'indexed', {
    available_records: catalog.available_records, available_turns: catalog.available_turns,
    record_types: catalog.record_types, relevant_hints: catalog.hints.length,
    catalog_fingerprint: catalog.fingerprint,
  }, { turnId: active.turnId, stepId: active.stepId });
}

export function selectedContextLimit(config, routes) {
  const known = routes.slice(0, routes[0]?.budget ?? routes.length)
    .map((route) => route.contextLimitBytes)
    .filter((value) => Number.isInteger(value) && value > 0);
  return Math.min(config.limits.maxContextBytes, ...(known.length > 0 ? known : [config.limits.maxContextBytes]));
}
