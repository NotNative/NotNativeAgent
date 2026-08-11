// SPDX-License-Identifier: Apache-2.0

export async function acceptEngineText(engine, text, active) {
  active.text += text;
  active.stepText += text;
  await emitEngineText(engine, text, active);
}

export async function emitEngineText(engine, text, active, deltaType = 'text') {
  await engine.output({
    version: '1.0', type: 'stream_delta', session_id: engine.sessionId,
    turn_id: active.turnId, step_id: active.stepId, sequence: active.deltaSequence++,
    delta_type: deltaType, text,
  });
}

export function emitEngineStatus(engine, semanticState, active) {
  if (engine.surface !== 'interactive_tui') return Promise.resolve();
  return engine.output({
    version: '1.0', type: 'state_status', session_id: engine.sessionId,
    turn_id: active?.turnId ?? null, semantic_state: semanticState,
  });
}
