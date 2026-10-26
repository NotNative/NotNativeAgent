// SPDX-License-Identifier: Apache-2.0

// Why: an operator direction recorded as accepted must always leave a durable
// disposition. Both drop paths — terminal commit and crash-window restore — route
// through here so the journal can never show a steering_accepted without a successor.

export async function dropUnconsumedSteering(engine, active, persist) {
  const dropped = (engine.steering ?? []).filter((item) => item.turnId === active.turnId);
  for (const record of dropped) {
    await persist('steering_abandoned', { id: record.id, turnId: record.turnId });
  }
  if (dropped.length > 0) {
    engine.steering = engine.steering.filter((item) => item.turnId !== active.turnId);
  }
}

export async function abandonOrphanedSteering(engine, orphans) {
  for (const orphan of orphans) {
    await engine.store?.append('steering_abandoned', { id: orphan.id, turnId: orphan.turnId });
    engine.recoveryNotices.push(Object.freeze({
      turnId: orphan.turnId, steeringId: orphan.id, reason: orphan.reason,
      outcome: 'failed', replayed: false, detected_at: new Date().toISOString(),
    }));
  }
}
