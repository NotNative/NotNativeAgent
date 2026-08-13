// SPDX-License-Identifier: Apache-2.0

export function settleUnavailableEvidence(store, context) {
  const { runtimeKey, configVersion, run, packet, started, error } = context;
  if (!['learning_evidence_missing', 'learning_evidence_ineligible'].includes(error?.code)) return null;
  const code = 'maintenance_evidence_unavailable';
  store.finishPacket(packet.id, code);
  store.finish(run.id, 'skipped', {
    resultCode: code, durationMs: performance.now() - started,
  });
  store.commitWatermark({
    runtimeKey, sessionId: null, turnSequence: packet.evidence_end,
    stage: 0, configGeneration: configVersion,
  });
  return { code, packet_id: packet.id, reason_code: error.code };
}
