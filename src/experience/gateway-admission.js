// SPDX-License-Identifier: Apache-2.0

// Invariant: a fenced gateway request cannot pass admission after its fence commits.
export async function withGatewayAdmission(session, operation) {
  const prior = session.gatewayAdmissionTail ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  session.gatewayAdmissionTail = prior.then(() => gate);
  await prior;
  try { return await operation(); }
  finally { release(); }
}

export async function gatewayFences(session) {
  if (!session.gatewayFences) {
    if (!session.engine.store) session.gatewayFences = new Set();
    else {
      session.gatewayFencesLoading ??= session.engine.store.readRecords().then(({ records }) => new Set(
        records.filter((record) => record.type === 'gateway_submission_fence')
          .flatMap((record) => Array.isArray(record.payload?.request_ids) ? record.payload.request_ids : []),
      )).finally(() => { session.gatewayFencesLoading = null; });
      session.gatewayFences = await session.gatewayFencesLoading;
    }
  }
  return session.gatewayFences;
}

export async function fenceGatewayRequests(session, requestIds) {
  const fences = await gatewayFences(session);
  const fresh = requestIds.filter((id) => !fences.has(id));
  if (fresh.length) {
    // Invariant: ephemeral sessions cannot survive owner restart; their fence lives with the owner.
    if (session.engine.store) await session.engine.store.append('gateway_submission_fence', { request_ids: fresh });
    for (const id of fresh) fences.add(id);
  }
}
