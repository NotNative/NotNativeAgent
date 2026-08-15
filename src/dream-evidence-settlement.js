// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const UNAVAILABLE_EVIDENCE_CODES = new Set(['learning_evidence_missing', 'learning_evidence_ineligible']);
const SETTLEMENT_CODE = 'maintenance_evidence_unavailable';
const SKIPPED_STATE = 'skipped';

export function settleUnavailableEvidence(store, context) {
  if (!context || typeof context !== 'object') return null;
  const { runtimeKey, configVersion, run, packet, started, error } = context;
  if (typeof error?.code !== 'string' || !UNAVAILABLE_EVIDENCE_CODES.has(error.code)) return null;
  if (!store || typeof store.finishPacket !== 'function' || typeof store.finish !== 'function'
    || typeof store.commitWatermark !== 'function' || !run?.id || !packet?.id
    || !Number.isFinite(started) || typeof runtimeKey !== 'string') {
    throw new ContractError('maintenance_evidence_context_invalid', 'maintenance evidence settlement context is invalid');
  }
  try {
    store.finishPacket(packet.id, SETTLEMENT_CODE);
    store.finish(run.id, SKIPPED_STATE, {
      resultCode: SETTLEMENT_CODE, durationMs: Math.max(0, performance.now() - started),
    });
    store.commitWatermark({
      runtimeKey, sessionId: null, turnSequence: packet.evidence_end,
      stage: 0, configGeneration: configVersion,
    });
  } catch (settlementError) {
    throw new ContractError('maintenance_evidence_settlement_failed', 'maintenance evidence could not be settled', { cause: settlementError });
  }
  return { code: SETTLEMENT_CODE, packet_id: packet.id, reason_code: error.code };
}
