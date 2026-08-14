// SPDX-License-Identifier: Apache-2.0
import { sanitizeTerminal } from './terminal-adapter.js';
import { displayWidth, truncateTerminal } from './terminal-markdown.js';

export function sessionStatusLine(session, width, rightStatus = '', now = Date.now()) {
  const state = stateStatus(session, now);
  const context = contextUsage(session);
  const view = session.viewportEnd === null ? 'following' : `${Math.max(0, session.viewportLineCount - session.viewportEnd)} unseen`;
  const attachments = session.pendingAttachments.length > 0
    ? ` | ${session.pendingAttachments.length} attachment${session.pendingAttachments.length === 1 ? '' : 's'}` : '';
  const work = workProgress(session.work);
  const left = truncateTerminal(sanitizeTerminal(statusForWidth(
    session, width, state, context, view, attachments, work,
  )), width);
  const right = sanitizeTerminal(rightStatus).trim();
  if (!right || width < displayWidth(right) + 24) return left;
  const available = width - displayWidth(right) - 2;
  const compactLeft = truncateTerminal(left, available);
  return `${compactLeft}${' '.repeat(Math.max(2, width - displayWidth(compactLeft) - displayWidth(right)))}${right}`;
}

function statusForWidth(session, width, state, context, view, attachments, work) {
  const model = session.metadata.model;
  if (width < 96) return `${state} | ${model} | ${context} | ${view}`;
  if (width < 140) {
    const workspace = compactWorkspace(session.metadata.workspace);
    return `${session.reviewPosture} | ${state}${workspace ? ` | ${workspace}` : ''} | ${model}${attachments}${work} | ${context} | ${totalTokens(session.usage)} | ${view}`;
  }
  const route = `${session.metadata.endpoint ?? session.metadata.provider}/${model}`;
  const workspace = session.metadata.workspace ? ` | ${session.metadata.workspace}` : '';
  return `${session.reviewPosture} | ${state}${workspace} | ${route}${attachments}${work} | ${context} | ${totalTokens(session.usage)} | ${view}`;
}

function compactWorkspace(value) {
  const parts = String(value ?? '').split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? '';
}

function stateStatus(session, now) {
  const state = session.state === 'needs_input' ? 'IDLE' : session.state.toUpperCase();
  if (!session.activeTurnId || !Number.isFinite(session.turnStartedAt) || ['idle', 'needs_input', 'failed'].includes(session.state)) {
    return state;
  }
  return `${state} ${formatTurnElapsed(Math.max(0, now - session.turnStartedAt))}`;
}

export function formatTurnElapsed(elapsedMs) {
  const seconds = Math.floor(elapsedMs / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
}

function workProgress(work) {
  if (!work?.goal && !work?.tasks?.length) return '';
  const total = work.tasks?.length ?? 0;
  const complete = work.tasks?.filter((task) => task.status === 'completed').length ?? 0;
  return ` | plan ${complete}/${total}${work.goal?.status === 'completed' ? ' done' : ''}`;
}

function totalTokens(usage) {
  const total = usage?.total_tokens ?? usage?.totalTokens;
  return Number.isFinite(total) ? `${total} tokens` : 'tokens --';
}

function contextUsage(session) {
  if (Number.isFinite(session.contextLimitTokens) && session.contextLimitTokens > 0) {
    const ratio = Math.min(1, session.contextTokens / session.contextLimitTokens);
    const marker = session.contextMeasurement === 'estimated' ? '~' : '';
    if (ratio > 0 && ratio < 0.01) return `context ${marker}<1%`;
    return `context ${marker}${Math.round(ratio * 100)}%`;
  }
  if (!Number.isFinite(session.contextLimitBytes) || session.contextLimitBytes <= 0) return 'context --';
  const ratio = Math.min(1, session.contextBytes / session.contextLimitBytes);
  if (ratio > 0 && ratio < 0.01) return 'context <1%';
  return `context ${Math.round(ratio * 100)}%`;
}
