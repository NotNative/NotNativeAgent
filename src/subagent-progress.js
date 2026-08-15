// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const MAX_PROGRESS_TEXT = 120;
const MAX_PROGRESS_INPUT = 4_096;

export function createSubagentProgressRelay(engine, identity) {
  validateRelay(engine, identity);
  let taskSummary = 'delegated work';
  return Object.freeze({
    accept: async () => undefined,
    started: async (task) => {
      taskSummary = summarizeTask(task, identity.agentType);
      await emitProgress(engine, identity, 'started', taskSummary);
    },
    returned: async () => {
      try { await emitProgress(engine, identity, 'returned', taskSummary); }
      finally { taskSummary = 'delegated work'; }
    },
    failed: async (error) => {
      try { await emitProgress(engine, identity, 'failed', bounded(`${taskSummary} · ${error?.message ?? error?.code ?? 'failed'}`)); }
      finally { taskSummary = 'delegated work'; }
    },
  });
}

function summarizeTask(value, agentType) {
  const text = clean(value).slice(0, MAX_PROGRESS_INPUT);
  const files = [...new Set(text.match(/[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*\.[A-Za-z0-9]{1,8}/gu) ?? [])]
    .map((item) => item.replaceAll('\\', '/'));
  const verb = { reviewer: 'reviewing', coder: 'updating', tester: 'testing', planner: 'planning' }[agentType] ?? 'working on';
  if (files.length > 0) return bounded(`${verb} ${files[0]}${additionalFileSummary(files.length)}`);
  return bounded(text || 'delegated work');
}

async function emitProgress(engine, identity, phase, text) {
  try {
    await engine.output?.({
      version: '1.0', type: 'subagent_progress', session_id: engine.sessionId,
      turn_id: identity.turnId, step_id: identity.stepId, agent_id: identity.agentId,
      agent_type: identity.agentType, phase, text: clean(text),
    });
  } catch (error) {
    // Presentation must never become part of the sub-agent execution path.
    try {
      engine.telemetry?.record('subagent.progress', 'failed', { phase, code: error?.code ?? 'output_failed' }, {
        turnId: identity.turnId, stepId: identity.stepId, agentId: identity.agentId,
      });
    } catch { /* Telemetry is also observational and must remain isolated. */ }
  }
}

function additionalFileSummary(count) {
  if (count <= 1) return '';
  const additional = count - 1;
  return ` and ${additional} more ${additional === 1 ? 'file' : 'files'}`;
}

function validateRelay(engine, identity) {
  if (!engine || typeof engine !== 'object' || !identity || typeof identity !== 'object'
    || !['turnId', 'stepId', 'agentId', 'agentType'].every((key) => typeof identity[key] === 'string' && identity[key])) {
    throw new ContractError('subagent_progress_invalid', 'sub-agent progress requires a valid engine and identity');
  }
}

function bounded(value) {
  const text = clean(value);
  if (text.length <= MAX_PROGRESS_TEXT) return text;
  return `${text.slice(0, MAX_PROGRESS_TEXT - 3)}...`;
}

function clean(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}
