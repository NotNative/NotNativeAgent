// SPDX-License-Identifier: Apache-2.0
import { synthwaveActivityIndicator } from './tui-colors.js';

const UNICODE_SPINNER = Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
const ASCII_SPINNER = Object.freeze(['|', '/', '-', '\\']);

export function liveActivityLine(session, capabilities) {
  if (!session.activeTurnId || ['idle', 'needs_input', 'failed'].includes(session.state)) return null;
  const frames = capabilities.unicode === false ? ASCII_SPINNER : UNICODE_SPINNER;
  const frame = capabilities.reducedMotion ? 0 : (capabilities.animationFrame ?? 0);
  const marker = capabilities.reducedMotion ? (capabilities.unicode === false ? '*' : '•') : frames[frame % frames.length];
  return `  ${marker} ${liveActivityLabel(session)}`;
}

export function decorateLiveActivity(line, animationFrame) {
  const activity = line.match(/^  ([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏•|/\\*-]) (.+)$/u);
  return activity ? synthwaveActivityIndicator(activity[1], activity[2], animationFrame) : null;
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
    if (id) latest.set(id, record);
  }
  const running = [...latest.values()].filter((record) => record.status === 'running');
  if (running.length === 0) return 'Running tool…';
  const first = running[0];
  const detail = [first.tool, first.target ? `(${singleLine(first.target)})` : ''].filter(Boolean).join(' ');
  if (running.every((record) => record.tool === 'agent.run')) {
    if (running.length === 1) return `Sub-agent active · ${singleLine(first.target ?? 'delegated task')}…`;
    return `${running.length} sub-agents active · ${singleLine(first.target ?? 'delegated work')}…`;
  }
  if (running.length === 1) return `Running ${detail || 'tool'}…`;
  return `Running ${running.length} tools · ${detail || 'working'}…`;
}

function singleLine(value) {
  return String(value).replace(/\s+/gu, ' ').trim();
}
