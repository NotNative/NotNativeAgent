// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { createMenuOverlay } from './surface-engine.js';

export function contextOverlay(session, config, options = {}) {
  const tokenAware = session.contextLimitTokens > 0;
  const utilization = contextUtilization(session, tokenAware);
  const level1 = config?.limits?.contextCompressionThreshold ?? session.contextCompressionThreshold ?? 0.40;
  const level2 = config?.limits?.contextCompressionLevel2Threshold ?? session.contextCompressionLevel2Threshold ?? 0.55;
  const level3 = config?.limits?.contextCompressionLevel3Threshold ?? session.contextCompressionLevel3Threshold ?? 0.70;
  const compaction = config?.limits?.contextCompactionThreshold ?? session.contextCompactionThreshold ?? 0.75;
  const lines = [
    tokenAware
      ? `Projected provider prompt: ${count(session.contextTokens)} / ${count(session.contextLimitTokens)} usable input tokens`
      : `Conservative context: ${bytes(session.contextBytes)} / ${bytes(session.contextLimitBytes)}`,
    `Projected utilization: ${utilization === null ? '--' : `${utilization}%`}`,
    `Raw conversation estimate: ${count(session.rawContextTokens)} tokens${rawPressure(session)}`,
    `Compression level 1: ${contextPercentText(level1)} | ${thresholdCount(session, level1, session.contextCompressionThresholdTokens)} estimated tokens`,
    `Compression level 2: ${contextPercentText(level2)} | ${thresholdCount(session, level2, session.contextCompressionLevel2ThresholdTokens)} estimated tokens`,
    `Compression level 3: ${contextPercentText(level3)} | ${thresholdCount(session, level3, session.contextCompressionLevel3ThresholdTokens)} estimated tokens`,
    `Full compaction starts: ${contextPercentText(compaction)} | ${count(session.contextThresholdTokens)} estimated tokens`,
    `Output reserved: ${count(session.contextOutputReserveTokens)} tokens`,
    `Loaded parallel capacity: ${count(session.contextParallelCapacity)}`,
    `Runtime source: ${session.contextSource ?? 'configured byte fallback'}`,
    `Hard byte ceiling: ${bytes(session.contextLimitBytes)}`,
  ];
  if (session.contextCompaction) lines.push(
    `Compaction active: ${count(session.contextCompaction.beforeTokens)} -> target <= ${count(session.contextCompaction.targetTokens)} tokens`,
  );
  if (session.lastContextReduction) lines.push(
    `Last reduction: ${count(session.lastContextReduction.beforeTokens)} -> ${count(session.lastContextReduction.afterTokens)} tokens`,
  );
  if (options.status) lines.push('', options.status);
  const items = [
    contextItem('level1', 'Compression level 1', level1, 'Replace settled activity with compact receipts'),
    contextItem('level2', 'Compression level 2', level2, 'Checkpoint settled work and retain fewer active steps'),
    contextItem('level3', 'Compression level 3', level3, 'Use the most aggressive compression before full compaction'),
    contextItem('compaction', 'Full compaction threshold', compaction, 'Build a continuation artifact and compact aggressively before provider overflow'),
  ];
  return menu('context', 'Context', lines, items, options.selectedId ?? 'action:level1');
}

export async function runContextCommand(argument, workspace) {
  const normalizedArgument = typeof argument === 'string' ? argument.trim() : '';
  const [action, rawValue, ...extra] = normalizedArgument.split(/\s+/u).filter(Boolean);
  if (!action) return openContext(workspace);
  const normalizedAction = action === 'compression' ? 'level1' : action;
  if (!['level1', 'level2', 'level3', 'compaction'].includes(normalizedAction) || !rawValue || extra.length > 0) {
    throw new ContractError('context_command_invalid',
      'Use /context, /context level1 PERCENT, /context level2 PERCENT, /context level3 PERCENT, or /context compaction PERCENT.');
  }
  const value = parseContextPercent(rawValue), limits = workspace.activeConfig().limits;
  const thresholds = {
    level1: limits.contextCompressionThreshold,
    level2: limits.contextCompressionLevel2Threshold,
    level3: limits.contextCompressionLevel3Threshold,
    compaction: limits.contextCompactionThreshold,
  };
  thresholds[normalizedAction] = value;
  const { level1, level2, level3, compaction } = thresholds;
  await workspace.configureContext(limits.maxContextBytes, compaction, level1, level2, level3);
  workspace.projection.openOverlay(contextOverlay(workspace.projection.active(), workspace.activeConfig(), {
    selectedId: `action:${normalizedAction}`,
    status: `${normalizedAction === 'compaction' ? 'Full compaction' : `Compression ${normalizedAction}`} threshold saved at ${Math.round(value * 100)}%.`,
  }));
}

export function contextPercentText(value) { return `${Math.round(Number(value) * 100)}%`; }

function openContext(workspace) {
  workspace.projection.openOverlay(contextOverlay(workspace.projection.active(), workspace.activeConfig()));
}

function parseContextPercent(raw) {
  let value = Number(String(raw).trim().replace(/%$/u, ''));
  if (value > 1) value /= 100;
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new ContractError('context_threshold_invalid', 'Context threshold must be a percentage between 1 and 99.');
  }
  return value;
}

function contextUtilization(session, tokenAware) {
  if (tokenAware) return Math.min(100, Math.round((session.contextTokens / session.contextLimitTokens) * 100));
  if (session.contextLimitBytes > 0) return Math.min(100, Math.round((session.contextBytes / session.contextLimitBytes) * 100));
  return null;
}

function rawPressure(session) {
  if (!Number.isFinite(session.rawContextTokens) || !(session.contextLimitTokens > 0)) return '';
  return ` | ${Math.max(0, Math.round((session.rawContextTokens / session.contextLimitTokens) * 100))}% of usable input`;
}

function contextItem(id, label, value, detail) {
  return { id: `action:${id}`, label, badge: contextPercentText(value), detail };
}

function menu(kind, title, lines, items, activeId) {
  return createMenuOverlay(kind, title, lines, items, { activeId, actionLabel: 'Up/Down choose · Enter edit' });
}

function count(value) { return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '--'; }
function thresholdCount(session, ratio, recorded) {
  if (Number.isFinite(recorded)) return count(recorded);
  if (Number.isFinite(session.contextLimitTokens)) return count(session.contextLimitTokens * ratio);
  return '--';
}
function bytes(value) {
  if (!Number.isFinite(value)) return '--';
  if (value < 1024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}
