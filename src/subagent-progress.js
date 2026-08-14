// SPDX-License-Identifier: Apache-2.0

const MAX_PROGRESS_TEXT = 120;

export function createSubagentProgressRelay(engine, identity) {
  let taskSummary = 'delegated work';
  return Object.freeze({
    accept: async () => undefined,
    started: (task) => {
      taskSummary = summarizeTask(task, identity.agentType);
      return emitProgress(engine, identity, 'started', taskSummary);
    },
    returned: () => emitProgress(engine, identity, 'returned', taskSummary),
    failed: (error) => emitProgress(engine, identity, 'failed', bounded(`${taskSummary} · ${error?.message ?? error?.code ?? 'failed'}`)),
  });
}

function summarizeTask(value, agentType) {
  const text = clean(value);
  const files = [...new Set(text.match(/[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*\.[A-Za-z0-9]{1,8}/gu) ?? [])]
    .map((item) => item.replaceAll('\\', '/'));
  const verb = { reviewer: 'reviewing', coder: 'updating', tester: 'testing', planner: 'planning' }[agentType] ?? 'working on';
  if (files.length > 0) return bounded(`${verb} ${files[0]}${files.length > 1 ? ` and ${files.length - 1} more file${files.length === 2 ? '' : 's'}` : ''}`);
  return bounded(text || 'delegated work');
}

async function emitProgress(engine, identity, phase, text) {
  try {
    await engine.output?.({
      version: '1.0', type: 'subagent_progress', session_id: engine.sessionId,
      turn_id: identity.turnId, step_id: identity.stepId, agent_id: identity.agentId,
      agent_type: identity.agentType, phase, text: clean(text),
    });
  } catch {
    // Presentation must never become part of the sub-agent execution path.
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
