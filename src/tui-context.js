// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export function contextOverlay(session, config, options = {}) {
  const tokenAware = session.contextLimitTokens > 0;
  const utilization = contextUtilization(session, tokenAware);
  const compression = config?.limits?.contextCompressionThreshold ?? session.contextCompressionThreshold ?? 0.40;
  const compaction = config?.limits?.contextCompactionThreshold ?? session.contextCompactionThreshold ?? 0.75;
  const lines = [
    tokenAware
      ? `Prompt estimate: ${count(session.contextTokens)} / ${count(session.contextLimitTokens)} usable input tokens`
      : `Conservative context: ${bytes(session.contextBytes)} / ${bytes(session.contextLimitBytes)}`,
    `Utilization: ${utilization === null ? '--' : `${utilization}%`}`,
    `Compression starts: ${contextPercentText(compression)} | ${count(session.contextCompressionThresholdTokens)} estimated tokens`,
    `Full compaction starts: ${contextPercentText(compaction)} | ${count(session.contextThresholdTokens)} estimated tokens`,
    `Output reserved: ${count(session.contextOutputReserveTokens)} tokens`,
    `Loaded parallel capacity: ${count(session.contextParallelCapacity)}`,
    `Runtime source: ${session.contextSource ?? 'configured byte fallback'}`,
    `Hard byte ceiling: ${bytes(session.contextLimitBytes)}`,
  ];
  if (session.lastContextReduction) lines.push(
    `Last reduction: ${count(session.lastContextReduction.beforeTokens)} -> ${count(session.lastContextReduction.afterTokens)} tokens`,
  );
  if (options.status) lines.push('', options.status);
  const items = [
    contextItem('compression', 'Compression threshold', compression, 'Reduce settled history and tool payloads before prompt cost grows expensive'),
    contextItem('compaction', 'Full compaction threshold', compaction, 'Build a continuation artifact and compact aggressively before provider overflow'),
  ];
  return menu('context', 'Context', lines, items, options.selectedId ?? 'action:compression');
}

export async function runContextCommand(argument, workspace) {
  const [action, rawValue, ...extra] = argument.trim().split(/\s+/u).filter(Boolean);
  if (!action) return openContext(workspace);
  if (!['compression', 'compaction'].includes(action) || !rawValue || extra.length > 0) {
    throw new ContractError('context_command_invalid', 'Use /context, /context compression PERCENT, or /context compaction PERCENT.');
  }
  const value = parseContextPercent(rawValue), limits = workspace.activeConfig().limits;
  const compression = action === 'compression' ? value : limits.contextCompressionThreshold;
  const compaction = action === 'compaction' ? value : limits.contextCompactionThreshold;
  await workspace.configureContext(limits.maxContextBytes, compaction, compression);
  workspace.projection.openOverlay(contextOverlay(workspace.projection.active(), workspace.activeConfig(), {
    selectedId: `action:${action}`,
    status: `${action === 'compression' ? 'Compression' : 'Full compaction'} threshold saved at ${Math.round(value * 100)}%.`,
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

function contextItem(id, label, value, detail) {
  return { id: `action:${id}`, label, badge: contextPercentText(value), detail };
}

function menu(kind, title, lines, items, activeId) {
  return Object.freeze({ kind, title, lines: Object.freeze(lines), items: Object.freeze(items),
    selected: Math.max(0, items.findIndex((item) => item.id === activeId)), actionLabel: 'Up/Down choose | Enter edit' });
}

function count(value) { return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '--'; }
function bytes(value) {
  if (!Number.isFinite(value)) return '--';
  if (value < 1024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}
