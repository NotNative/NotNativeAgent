// SPDX-License-Identifier: Apache-2.0

const MAX_PROGRESS_UPDATES = 12;
const MAX_PROGRESS_TEXT = 640;

export function createSubagentProgressRelay(engine, identity) {
  let narrative = '';
  let updates = 0;
  let suppressionReported = false;
  return Object.freeze({
    accept: async (record) => {
      if (record?.type === 'stream_delta' && record.delta_type === 'text') {
        narrative = bounded(`${narrative}${record.text ?? ''}`);
        return;
      }
      if (record?.type !== 'tool_status' || record.status !== 'running') return;
      if (updates >= MAX_PROGRESS_UPDATES) {
        if (!suppressionReported) await emitProgress(engine, identity, 'working', 'Additional child activity continues; detailed events remain in telemetry.');
        suppressionReported = true;
        return;
      }
      const tool = `${record.tool ?? 'tool'}${record.target ? ` (${record.target})` : ''}`;
      const context = clean(narrative);
      narrative = '';
      updates += 1;
      await emitProgress(engine, identity, 'working', context ? `${context} -> ${tool}` : tool);
    },
    started: (task) => emitProgress(engine, identity, 'started', bounded(task)),
    returned: (result) => emitProgress(engine, identity, 'returned', bounded(result?.text || narrative || result?.outcome || 'No summary returned.')),
    failed: (error) => emitProgress(engine, identity, 'failed', bounded(error?.message ?? error?.code ?? 'Sub-agent failed.')),
  });
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
