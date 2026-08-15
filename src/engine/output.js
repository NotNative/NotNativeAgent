// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

export async function acceptEngineText(engine, text, active) {
  assertOutputContext(engine, active);
  active.text += text;
  active.stepText += text;
  await emitEngineText(engine, text, active);
}

export async function emitEngineText(engine, text, active, deltaType = 'text') {
  assertOutputContext(engine, active);
  const sequence = active.deltaSequence;
  active.deltaSequence += 1;
  await engine.output({
    version: '1.0', type: 'stream_delta', session_id: engine.sessionId,
    turn_id: active.turnId, step_id: active.stepId, sequence,
    delta_type: deltaType, text,
  });
}

export async function emitEngineStatus(engine, semanticState, active) {
  assertEngine(engine);
  if (engine.surface !== 'interactive_tui') return;
  await engine.output({
    version: '1.0', type: 'state_status', session_id: engine.sessionId,
    turn_id: active?.turnId ?? null, semantic_state: semanticState,
  });
}

function assertOutputContext(engine, active) {
  assertEngine(engine);
  if (!active || typeof active !== 'object') {
    throw new ContractError('active_turn_required', 'engine output requires an active turn');
  }
}

function assertEngine(engine) {
  if (!engine || typeof engine.output !== 'function') {
    throw new ContractError('engine_output_required', 'engine output boundary is unavailable');
  }
}
