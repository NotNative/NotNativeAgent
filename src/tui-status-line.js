// SPDX-License-Identifier: Apache-2.0
import { sanitizeTerminal } from './terminal-adapter.js';
import { displayWidth, truncateTerminal } from './terminal-markdown.js';

export function sessionStatusLine(session, width) {
  const route = responsiveRoute(session, width);
  const usage = totalTokens(session.usage);
  const context = contextUsage(session);
  const view = session.viewportEnd === null ? 'following' : `${Math.max(0, session.viewportLineCount - session.viewportEnd)} unseen`;
  const attachments = session.pendingAttachments.length > 0
    ? ` | ${session.pendingAttachments.length} attachment${session.pendingAttachments.length === 1 ? '' : 's'}` : '';
  const state = session.state === 'needs_input' ? 'IDLE' : session.state.toUpperCase();
  const work = workProgress(session.work);
  const workspace = session.metadata.workspace ? ` | ${session.metadata.workspace}` : '';
  return truncateTerminal(sanitizeTerminal(
    `${session.reviewPosture} | ${state}${workspace} | ${route}${attachments}${work} | ${context} | ${usage} | ${view}`,
  ), width);
}

function responsiveRoute(session, width) {
  const model = session.metadata.model;
  const route = `${session.metadata.endpoint ?? session.metadata.provider}/${model}`;
  const workspace = session.metadata.workspace ? ` | ${session.metadata.workspace}` : '';
  const fixedPrefix = `${session.reviewPosture} | ${session.state === 'needs_input' ? 'IDLE' : session.state.toUpperCase()}${workspace} | `;
  const minimumSuffix = ' | context --';
  return displayWidth(`${fixedPrefix}${route}${minimumSuffix}`) <= width ? route : model;
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
