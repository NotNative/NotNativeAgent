// SPDX-License-Identifier: Apache-2.0
import { assistantMessage, terminalRecord } from './records.js';
import { emitEngineText } from './output.js';
import { hookPayload } from './hooks.js';
import { settleEngineChildren } from './lifecycle-settlement.js';
import { FinalizationFaults } from '../finalization-faults.js';

export async function finalizeEngineTurn(engine, outcome, text, failureDetail, options, operations) {
  const active = engine.active;
  if (!active || active.finalized) operations.rejectDuplicate();
  active.finalized = true;
  clearTimeout(active.missionTimer);
  const faults = new FinalizationFaults(failureDetail, outcome, active.turnId);
  if (engine.state.state !== 'finalizing_turn') {
    await faults.capture('state', () => engine.state.transition(
      'finalizing_turn', { trigger: `terminal_${outcome}`, turnId: active.turnId },
    ));
  }
  await faults.capture('lifecycle', () => settleEngineChildren(
    engine, active, faults.outcome, operations.publish,
  ));
  if (text.length > 0 && text !== active.committedStepText) await faults.capture('persistence',
    () => operations.persist('message', assistantMessage(active.turnId, text, { ...faults.primary, stepId: active.stepId })));
  if (text.length > 0 && options.emitText === true) {
    await faults.capture('output', () => emitEngineText(engine, text, active, 'recovery_explanation'));
  }
  await faults.capture('lifecycle', () => engine.lifecycles.finish(active.turnId, faults.outcome));
  await faults.capture('event', () => operations.publish(
    'turn.terminal', 'turn', 'terminal', active, faults.outcome, hookPayload(engine, active, { model_response: text }),
  ));
  await faults.capture('state', () => engine.state.transition(
    'idle', { trigger: 'finalization_committed', turnId: active.turnId },
  ));
  engine.active = null;
  const work = engine.work?.snapshot();
  if (work && (work.goal || work.tasks.length > 0)) {
    await faults.capture('persistence', () => operations.persist('work_state', work));
  }
  // Each snapshot follows a fault boundary, so later consumers see failures discovered there.
  const terminalBeforePersistence = terminalRecord(engine, active, faults.outcome, text, faults.primary, faults.secondary);
  await faults.capture('persistence', () => operations.persist('turn_outcome', terminalBeforePersistence));
  faults.latchCommit();
  const terminalBeforeOutput = terminalRecord(engine, active, faults.outcome, text, faults.primary, faults.secondary);
  await faults.capture('output', () => engine.output(terminalBeforeOutput));
  return terminalRecord(engine, active, faults.outcome, text, faults.primary, faults.secondary);
}
