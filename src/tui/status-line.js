// SPDX-License-Identifier: Apache-2.0
import { sanitizeTerminal } from './terminal-adapter.js';
import { displayWidth, truncateTerminal } from './terminal-markdown.js';
import { statusTokenText } from '../experience/token-accounting.js';

const MIN_RIGHT_STATUS_LEFT_WIDTH = 24;
const MIN_STATUS_GAP = 2;

export function sessionStatusLine(session, width, rightStatus = '', now = Date.now()) {
  const state = stateStatus(session, now);
  const context = contextUsage(session);
  const hasViewport = Number.isFinite(session.viewportEnd) && Number.isFinite(session.viewportLineCount);
  const view = hasViewport ? `${Math.max(0, session.viewportLineCount - session.viewportEnd)} unseen` : 'following';
  const attachmentCount = session.pendingAttachments?.length ?? 0;
  const attachments = attachmentCount > 0
    ? ` | ${attachmentCount} attachment${attachmentCount === 1 ? '' : 's'}` : '';
  const work = workProgress(session.work);
  const left = truncateTerminal(sanitizeTerminal(statusForWidth(
    session, width, state, context, view, attachments, work,
  )), width);
  const right = sanitizeTerminal(rightStatus).trim();
  if (!right || width < displayWidth(right) + MIN_RIGHT_STATUS_LEFT_WIDTH) return left;
  const available = width - displayWidth(right) - MIN_STATUS_GAP;
  const compactLeft = truncateTerminal(left, available);
  return `${compactLeft}${' '.repeat(Math.max(MIN_STATUS_GAP, width - displayWidth(compactLeft) - displayWidth(right)))}${right}`;
}

function statusForWidth(session, width, state, context, view, attachments, work) {
  const metadata = session.metadata ?? {};
  const model = metadata.model ?? 'model --';
  if (width < 96) return `${state} | ${model} | ${context} | ${view}`;
  if (width < 140) {
    const workspace = compactWorkspace(metadata.workspace);
    return `${session.reviewPosture ?? 'auto-review'} | ${state}${workspace ? ` | ${workspace}` : ''} | ${model}${attachments}${work} | ${context} | ${statusTokenText(session.usage, session.tokenAccounting)} | ${view}`;
  }
  const route = `${metadata.endpoint ?? metadata.provider ?? 'provider --'}/${model}`;
  const workspace = metadata.workspace ? ` | ${metadata.workspace}` : '';
  return `${session.reviewPosture ?? 'auto-review'} | ${state}${workspace} | ${route}${attachments}${work} | ${context} | ${statusTokenText(session.usage, session.tokenAccounting)} | ${view}`;
}

function compactWorkspace(value) {
  const parts = String(value ?? '').split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? '';
}

function stateStatus(session, now) {
  const semanticState = typeof session.state === 'string' ? session.state : 'unknown';
  const state = semanticState === 'needs_input' ? 'IDLE' : semanticState.toUpperCase();
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
  const complete = work.tasks?.reduce((count, task) => count + (task.status === 'completed' ? 1 : 0), 0) ?? 0;
  return ` | plan ${complete}/${total}${work.goal?.status === 'completed' ? ' done' : ''}`;
}

function contextUsage(session) {
  if (Number.isFinite(session.contextLimitTokens) && session.contextLimitTokens > 0) {
    const tokens = Number.isFinite(session.rawContextTokens) ? session.rawContextTokens : session.contextTokens;
    if (!Number.isFinite(tokens)) return 'context --';
    const ratio = tokens / session.contextLimitTokens;
    const marker = session.contextMeasurement === 'estimated' ? '~' : '';
    const compacting = session.contextCompaction ? ' | compacting' : '';
    return `context ${marker}${formatPercent(ratio)}${compacting}`;
  }
  if (!Number.isFinite(session.contextLimitBytes) || session.contextLimitBytes <= 0) return 'context --';
  if (!Number.isFinite(session.contextBytes)) return 'context --';
  const ratio = Math.min(1, session.contextBytes / session.contextLimitBytes);
  if (ratio > 0 && ratio < 0.01) return 'context <1%';
  return `context ${Math.round(ratio * 100)}%`;
}

function formatPercent(ratio) {
  if (!Number.isFinite(ratio)) return '--';
  if (ratio > 0 && ratio < 0.01) return '<1%';
  return `${Math.max(0, Math.round(ratio * 100))}%`;
}
