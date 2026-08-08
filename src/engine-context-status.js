// SPDX-License-Identifier: Apache-2.0
import { buildContext, measureContext } from './context.js';
import { estimateContextTokens } from './context-budget.js';
import { ContractError } from './ids.js';
import { shouldInspectProject } from './project-intake.js';

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
  const resolvedEnrichment = {
    ...enrichment, projectGuidance, skillCatalog: engine.skills?.catalog() ?? [], work: engine.work?.snapshot(),
  };
  const rawContext = buildContext(engine.config, records, content, resolvedEnrichment, Number.MAX_SAFE_INTEGER);
  const rawContextBytes = measureContext(rawContext);
  const rawContextTokens = estimateContextTokens(rawContext);
  const projection = options.projectContext ? await options.projectContext({
    records, rawContextBytes, rawContextTokens,
    effectiveInputTokens: budget?.effectiveInputTokens ?? null,
  }) : null;
  const contextRecords = projection?.records ?? records;
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
      compaction_threshold_tokens: budget?.thresholdTokens ?? null,
      output_reserve_tokens: budget?.outputReserveTokens ?? null,
      parallel_capacity: budget?.parallelCapacity ?? null,
      raw_estimated_tokens: rawContextTokens,
      pressure_tier: projection?.tier ?? 'none',
      measurement: 'estimated', source: budget?.source ?? 'configured_bytes',
    });
  }
  return context;
}

export function selectedContextLimit(config, routes) {
  const known = routes.slice(0, routes[0]?.budget ?? 1)
    .map((route) => route.contextLimitBytes)
    .filter((value) => Number.isInteger(value) && value > 0);
  return Math.min(config.limits.maxContextBytes, ...(known.length > 0 ? known : [config.limits.maxContextBytes]));
}
