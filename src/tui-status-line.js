// SPDX-License-Identifier: Apache-2.0
import { sanitizeTerminal } from './terminal-adapter.js';
import { displayWidth, truncateTerminal } from './terminal-markdown.js';

export function sessionStatusLine(session, width, rightStatus = '', now = Date.now()) {
  const state = stateStatus(session, now);
  const route = responsiveRoute(session, width, state);
  const usage = totalTokens(session.usage);
  const context = contextUsage(session);
  const view = session.viewportEnd === null ? 'following' : `${Math.max(0, session.viewportLineCount - session.viewportEnd)} unseen`;
  const attachments = session.pendingAttachments.length > 0
    ? ` | ${session.pendingAttachments.length} attachment${session.pendingAttachments.length === 1 ? '' : 's'}` : '';
  const work = workProgress(session.work);
  const workspace = session.metadata.workspace ? ` | ${session.metadata.workspace}` : '';
  const left = truncateTerminal(sanitizeTerminal(
    `${session.reviewPosture} | ${state}${workspace} | ${route}${attachments}${work} | ${context} | ${usage} | ${view}`,
  ), width);
  const right = sanitizeTerminal(rightStatus).trim();
  if (!right || width < displayWidth(right) + 24) return left;
  const available = width - displayWidth(right) - 2;
  const compactLeft = truncateTerminal(left, available);
  return `${compactLeft}${' '.repeat(Math.max(2, width - displayWidth(compactLeft) - displayWidth(right)))}${right}`;
}

function responsiveRoute(session, width, state) {
  const model = session.metadata.model;
  const route = `${session.metadata.endpoint ?? session.metadata.provider}/${model}`;
  const workspace = session.metadata.workspace ? ` | ${session.metadata.workspace}` : '';
  const fixedPrefix = `${session.reviewPosture} | ${state}${workspace} | `;
  const minimumSuffix = ' | context --';
  return displayWidth(`${fixedPrefix}${route}${minimumSuffix}`) <= width ? route : model;
}

function stateStatus(session, now) {
  const state = session.state === 'needs_input' ? 'IDLE' : session.state.toUpperCase();
  if (!session.activeTurnId || !Number.isFinite(session.turnStartedAt) || ['idle', 'needs_input', 'failed'].includes(session.state)) {
    return state;
  }
  return `${state} ${formatElapsed(Math.max(0, now - session.turnStartedAt))}`;
}

function formatElapsed(elapsedMs) {
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
