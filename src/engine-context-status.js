// SPDX-License-Identifier: Apache-2.0
import { buildContext, measureContext } from './context.js';
import { estimateContextTokens } from './context-budget.js';
import { ContractError } from './ids.js';
import { shouldInspectProject } from './project-intake.js';

export async function buildReportedContext(engine, records, content, enrichment, active, budgetBytes, limitBytes, budget = null) {
  const resolvedGuidance = engine.projectGuidance?.resolve ? await engine.projectGuidance.resolve(records) : [];
  const projectGuidance = engine.grounding?.admitProjectGuidance
    ? (await engine.grounding.admitProjectGuidance(resolvedGuidance, {
      turnId: active.turnId, authorityRef: active.authority?.id,
      scope: `project:${engine.config.workspaceRoot}`,
    })).admitted : resolvedGuidance;
  if (!enrichment.projectIntake && content && shouldInspectProject(content) && engine.projectIntake?.inspect) {
    enrichment.projectIntake = await engine.projectIntake.inspect();
  }
  const context = buildContext(engine.config, records, content, {
    ...enrichment, projectGuidance, skillCatalog: engine.skills?.catalog() ?? [],
  }, budgetBytes);
  active.contextBytes = measureContext(context);
  active.contextTokens = estimateContextTokens(context);
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
