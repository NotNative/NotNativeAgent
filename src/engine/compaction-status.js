// SPDX-License-Identifier: Apache-2.0

export async function emitCompactionStatus(engine, active, status, detail) {
  try {
    await engine.output({
      version: '1.0', type: 'context_compaction_status', session_id: engine.sessionId,
      turn_id: active.turnId, status, ...detail,
    });
  } catch (error) {
    // Invariant: observational failures cannot replace the compaction outcome.
    try {
      engine.telemetry?.record('context.compaction_status_output', 'failed', {
        status, reason_code: error?.code ?? 'output_failed',
      }, { turnId: active.turnId, stepId: active.stepId });
    } catch {
      // The telemetry sink is observational too.
    }
  }
}
