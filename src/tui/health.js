// SPDX-License-Identifier: Apache-2.0
import { isIntermediateToolStatus } from '../experience/tool-lifecycle.js';

const SERVICE_SECTION = 'Services';
const CONVERSATION_SECTION = 'Conversation';
const DIAGNOSTICS_SECTION = 'Diagnostics';
const HEALTHY_STATUS = 'HEALTHY';
const DEGRADED_STATUS = 'DEGRADED';
const MAX_HEALTH_ERRORS = 12;
const DEFAULT_TEXT_LIMIT = 140;
const HEALTH_ACTION_LABEL = 'Up/Down choose | Enter inspect | Esc back';
const DETAIL_ACTION_LABEL = 'Scroll | Esc back';
// This allowlist defines the stable operator-facing component order; arbitrary payload keys are not displayed.
const RUNTIME_COMPONENTS = Object.freeze([
  'installation', 'configuration', 'runtime_bounds', 'persistence', 'data_permissions',
  'reviewer', 'reviewer_llm', 'ledger', 'governance', 'sandbox', 'memory', 'hooks',
  'events', 'forensic_telemetry', 'extensions', 'stale_locks', 'context_pressure',
]);

export function healthOverlay(value, session, options = {}) {
  const summary = healthSummary(value, session);
  const items = [
    { id: 'provider', label: 'Provider', badge: summary.provider.up ? 'up' : 'down', detail: `${summary.provider.endpoint} | ${summary.provider.models} model${summary.provider.models === 1 ? '' : 's'} available`, section: SERVICE_SECTION },
    { id: 'mcp', label: 'MCP servers', badge: summary.mcp.badge, detail: summary.mcp.detail, section: SERVICE_SECTION },
    { id: 'turns', label: 'Recent turns', badge: `${summary.turns.success}/${summary.turns.total} healthy`, detail: summary.turns.detail, section: CONVERSATION_SECTION },
    { id: 'errors', label: 'Recent errors', badge: summary.errors.length === 0 ? 'clear' : `${summary.errors.length} found`, detail: summary.errors.length === 0 ? 'No recent failed turns, tools, reviews, or service checks' : summary.errors[0], section: CONVERSATION_SECTION },
    { id: 'runtime', label: 'Runtime details', badge: value?.installation?.version ?? '', detail: 'Installation, limits, persistence, governance, hooks, and telemetry', section: DIAGNOSTICS_SECTION },
  ];
  const overall = summary.provider.up && summary.mcp.down === 0 ? HEALTHY_STATUS : DEGRADED_STATUS;
  return Object.freeze({
    ...selectableOverlay('health', 'Runtime health', [
      `${overall} | checked ${formatHealthTime(value?.checked_at)}`,
      `Conversation ${session?.name ?? session?.id ?? 'active'} | ${summary.turns.total} recent turn${summary.turns.total === 1 ? '' : 's'} | ${summary.errors.length} issue${summary.errors.length === 1 ? '' : 's'}`,
      '', 'Choose a section to inspect. /support retains the complete diagnostic snapshot.',
    ], items, options.selectedId ?? (summary.errors.length > 0 ? 'errors' : 'provider')),
    healthSnapshot: value,
    actionLabel: HEALTH_ACTION_LABEL,
  });
}

export function healthDetailOverlay(section, value, session) {
  const summary = healthSummary(value, session);
  const definitions = {
    provider: ['Provider health', providerHealthLines(summary.provider)],
    mcp: ['MCP health', mcpHealthLines(value?.mcp)],
    turns: ['Recent turns', recentTurnLines(session)],
    errors: ['Recent errors', summary.errors.length > 0 ? summary.errors : ['No recent errors or denied operations.']],
    runtime: ['Runtime details', runtimeHealthLines(value)],
  };
  const [title, lines] = definitions[section] ?? definitions.runtime;
  return Object.freeze({ ...detailOverlay(`health-${section}`, title, lines), parent: 'health', healthSection: section, healthSnapshot: value, actionLabel: DETAIL_ACTION_LABEL });
}

export function handleHealthOverlayAction(action, workspace) {
  const projection = workspace.projection;
  const current = projection.overlay;
  if (current?.kind === 'health' && action?.action === 'submit' && Array.isArray(current.items)
    && Number.isInteger(current.selected) && current.selected >= 0 && current.selected < current.items.length) {
    const selected = current.items[current.selected];
    projection.openOverlay(healthDetailOverlay(selected.id, current.healthSnapshot, projection.active()));
    return true;
  }
  if (current?.parent === 'health' && action?.action === 'back') {
    projection.openOverlay(healthOverlay(current.healthSnapshot, projection.active(), { selectedId: current.healthSection }));
    return true;
  }
  return false;
}

function healthSummary(value, session) {
  const records = healthRecords(session);
  const turns = records.filter((record) => record.type === 'turn_result').slice(-10);
  const successful = turns.filter((record) => ['completed', 'needs_input'].includes(record.outcome)).length;
  const models = Array.isArray(value?.provider?.models) ? value.provider.models.length : 0;
  const servers = Array.isArray(value?.mcp) ? value.mcp : [];
  const ready = servers.filter((server) => server.state === 'ready').length;
  const down = servers.filter((server) => !['ready', 'disabled'].includes(server.state)).length;
  return {
    provider: { up: value?.provider?.status === 'ready', status: value?.provider?.status ?? 'unknown', endpoint: value?.provider?.endpoint ?? 'not configured', models, code: value?.provider?.code ?? null },
    mcp: { ready, down, total: servers.length, badge: servers.length === 0 ? 'none configured' : down > 0 ? 'degraded' : 'up', detail: servers.length === 0 ? 'No MCP servers configured' : `${ready} up | ${down} down | ${servers.length} configured` },
    turns: { total: turns.length, success: successful, detail: turns.length === 0 ? 'No completed turns in this conversation' : `${successful} completed normally | ${turns.length - successful} need attention` },
    errors: recentHealthErrors(value?.provider, servers, records),
  };
}

function healthRecords(session) {
  return [...(session?.historyRecords ?? []), ...(session?.records ?? [])];
}

function recentHealthErrors(provider, servers, records) {
  const errors = [];
  if (provider?.status !== 'ready') errors.push(`Provider | ${provider?.code ?? provider?.status ?? 'unavailable'}`);
  for (const server of servers) {
    if (!['ready', 'disabled'].includes(server.state)) errors.push(`MCP ${server.id} | ${server.state}${server.lastError ? ` | ${boundedText(server.lastError)}` : ''}`);
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.type === 'turn_result' && ['blocked', 'failed', 'incomplete', 'limit_reached'].includes(record.outcome)) errors.push(`Turn ${shortId(record.turn_id)} | ${record.outcome} | ${record.failure?.code ?? record.failure?.message ?? 'no reason recorded'}`);
    else if (record.type === 'tool_status' && !isIntermediateToolStatus(record.status)
      && !['succeeded', 'duplicate_ignored', 'cancelled'].includes(record.status)) errors.push(`${record.tool ?? 'tool'}${record.target ? ` (${boundedText(record.target, 90)})` : ''} | ${record.status} | ${record.reason_code ?? record.failure_reason ?? 'no reason recorded'}`);
    else if (record.type === 'review_status' && record.outcome && record.outcome !== 'approve') errors.push(`Review | ${record.outcome} | ${record.reason_code ?? 'no reason recorded'}`);
  }
  if (errors.length <= MAX_HEALTH_ERRORS) return errors;
  const omitted = errors.length - (MAX_HEALTH_ERRORS - 1);
  return [...errors.slice(0, MAX_HEALTH_ERRORS - 1), `+${omitted} more issue${omitted === 1 ? '' : 's'} not shown`];
}

function providerHealthLines(provider) {
  return [`Status      ${provider.up ? 'UP' : 'DOWN'}`, `Endpoint    ${provider.endpoint}`, `Models      ${provider.models}`, ...(provider.code ? [`Last error  ${provider.code}`] : []), '', 'The model catalog is counted here rather than printed. Use /model to browse models.'];
}

function mcpHealthLines(servers) {
  if (!Array.isArray(servers) || servers.length === 0) return ['No MCP servers configured.'];
  return servers.map((server) => `${server.state === 'ready' ? 'UP  ' : 'DOWN'} ${server.id} | ${server.state}${server.address ? ` | ${server.address}` : ''}${server.lastError ? ` | ${boundedText(server.lastError)}` : ''}`);
}

function recentTurnLines(session) {
  const turns = healthRecords(session).filter((record) => record.type === 'turn_result').slice(-10).reverse();
  if (turns.length === 0) return ['No completed turns in this conversation.'];
  return turns.map((turn, index) => {
    const usage = turn.usage ?? {};
    const tokens = Number(usage.total_tokens ?? usage.totalTokens);
    const elapsed = Number.isFinite(turn.elapsed_ms) ? ` | ${formatDuration(turn.elapsed_ms)}` : '';
    return `${index + 1}. ${String(turn.outcome ?? 'unknown').toUpperCase()} | ${shortId(turn.turn_id)}${elapsed}${Number.isFinite(tokens) ? ` | ${tokens} tokens` : ''}`;
  });
}

function runtimeHealthLines(value) {
  const lines = [`Checked       ${value?.checked_at ?? 'unknown'}`, `Version       ${value?.installation?.version ?? 'unknown'}`, `Runtime       ${value?.installation?.runtime ?? 'unknown'} | ${value?.installation?.platform ?? 'unknown'} ${value?.installation?.arch ?? ''}`, `Read only     ${value?.read_only === true ? 'yes' : 'unknown'}`, '', 'Components'];
  for (const name of RUNTIME_COMPONENTS) lines.push(`${name.padEnd(19)} ${value?.[name]?.status ?? 'unknown'}`);
  lines.push('', 'Full structured diagnostics are included by /support.');
  return lines;
}

function formatHealthTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : 'unknown';
}

function formatDuration(ms) { return Number.isFinite(ms) ? (ms < 1000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 100) / 10}s`) : 'unknown'; }
function shortId(value) { const text = String(value ?? 'unknown'); return text.length > 12 ? `${text.slice(0, 12)}...` : text; }
function boundedText(value, limit = DEFAULT_TEXT_LIMIT) { const text = String(value ?? '').replace(/\s+/gu, ' ').trim(); return text.length > limit ? `${text.slice(0, limit - 1)}...` : text; }


function detailOverlay(kind, title, lines) {
  return Object.freeze({ kind, title, lines: Object.freeze(lines.slice(0, 256).map(String)) });
}

function selectableOverlay(kind, title, lines, items, activeId) {
  const selected = Math.max(0, items.findIndex((item) => item.id === activeId));
  return Object.freeze({
    ...detailOverlay(kind, title, lines), selected,
    items: Object.freeze(items.slice(0, 256).map((item) => Object.freeze({ ...item }))),
  });
}
