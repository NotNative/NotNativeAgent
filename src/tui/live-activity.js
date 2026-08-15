// SPDX-License-Identifier: Apache-2.0
import { synthwaveActivityIndicator } from './colors.js';
import { formatTurnElapsed } from './status-line.js';

const UNICODE_SPINNER = Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
const ASCII_SPINNER = Object.freeze(['|', '/', '-', '\\']);
const MAX_AGENT_ROLE_GRAPHEMES = 24;
const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

export function liveActivityLine(session, capabilities) {
  if (!session.activeTurnId || ['idle', 'needs_input', 'failed'].includes(session.state)) return null;
  const frames = capabilities.unicode === false ? ASCII_SPINNER : UNICODE_SPINNER;
  const frame = capabilities.reducedMotion ? 0 : (capabilities.animationFrame ?? 0);
  const marker = capabilities.reducedMotion ? (capabilities.unicode === false ? '*' : '•') : frames[frame % frames.length];
  const now = Number.isFinite(capabilities.now) ? capabilities.now : Date.now();
  const elapsed = Number.isFinite(session.turnStartedAt)
    ? ` · ${formatTurnElapsed(Math.max(0, now - session.turnStartedAt))}`
    : '';
  return `  ${marker} ${liveActivityLabel(session)}${elapsed}`;
}

export function decorateLiveActivity(line, animationFrame) {
  const activity = line.match(/^  ([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏•|/\\*-]) (.+)$/u);
  return activity?.[1] && activity[2] ? synthwaveActivityIndicator(activity[1], activity[2], animationFrame) : null;
}

function liveActivityLabel(session) {
  const { state } = session;
  if (state === 'preparing') return 'Preparing…';
  if (state === 'waiting_provider') return 'Waiting for model…';
  if (state === 'streaming') return 'Responding…';
  if (state === 'awaiting_approval') return 'Reviewing tool use…';
  if (state === 'running_tool') return runningToolLabel(session);
  if (state === 'recovering') return 'Recovering…';
  if (state === 'cancelling') return 'Cancelling…';
  return 'Working…';
}

function runningToolLabel(session) {
  const latest = new Map();
  for (const record of session.records ?? []) {
    if (record.type !== 'tool_status' || record.turn_id !== session.activeTurnId) continue;
    const id = record.tool_request_id ?? record.provider_call_id ?? record.tool;
    if (id !== null && id !== undefined) latest.set(id, record);
  }
  const running = [...latest.values()].filter((record) => record.status === 'running');
  if (running.length === 0) return 'Running tool…';
  const first = running[0];
  const detail = [first.tool, first.target ? `(${singleLine(first.target)})` : ''].filter(Boolean).join(' ');
  if (running.every((record) => record.tool === 'agent.run')) {
    const roles = agentRoleCounts(running);
    return `${running.length === 1 ? 'Sub-agent active' : `${running.length} sub-agents active`} · ${roles}…`;
  }
  if (running.length === 1) return `Running ${detail || 'tool'}…`;
  return `Running ${running.length} tools · ${detail || 'working'}…`;
}

function singleLine(value) {
  return String(value).replace(/\s+/gu, ' ').trim();
}

function agentRoleCounts(records) {
  const roles = new Map();
  for (const record of records) {
    const role = truncateGraphemes(
      singleLine(record.target ?? '').split(' · ', 1)[0] || 'agent', MAX_AGENT_ROLE_GRAPHEMES,
    );
    roles.set(role, (roles.get(role) ?? 0) + 1);
  }
  return [...roles].slice(0, 3).map(([role, count]) => `${role}${count > 1 ? ` x${count}` : ''}`).join(' · ');
}

function truncateGraphemes(value, maximum) {
  const graphemes = GRAPHEME_SEGMENTER
    ? [...GRAPHEME_SEGMENTER.segment(value)].map((entry) => entry.segment)
    : Array.from(value);
  return graphemes.slice(0, maximum).join('');
}
