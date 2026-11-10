// SPDX-License-Identifier: Apache-2.0
// The capacity evidence extractor: groups the instrumentation facts the
// provider runner records (queue wait, admitted concurrency, duration) into
// per-route operating points a dream diagnosis can learn from. Why derived
// here rather than in the runner: the runner records raw facts per attempt;
// deciding what they mean for a route is dream's learning judgment.
import { governanceFingerprint } from './governance/contracts.js';
import { capacityCandidate } from './dream-candidate-projection.js';

function capacityCandidateFromPoint(point, evidenceId) {
  return capacityCandidate({ ...point, evidenceId });
}
const MIN_SAMPLES_FOR_A_POINT = 5;
const WAITING_QUEUE_MS = 50;

/** Observe learned capacity candidates from provider telemetry.
 *  Why here and not in the coordinator: the coordinator orchestrates dream
 *  stages; deriving and registering operating points is one concern with its
 *  own evidence rules. Failures are advisory — telemetry read problems must
 *  not fail a diagnosis stage. */
export async function observeCapacityCandidates({ engine, registry, evidenceId, limit = 10_000 }) {
  if (!engine?.telemetry) return [];
  try {
    const rows = await engine.telemetry.query({ limit });
    const points = routeCapacityEvidence(rows);
    const observed = [];
    for (const point of points) {
      observed.push(await registry.observe(capacityCandidateFromPoint(point, evidenceId)));
    }
    return observed;
  } catch (error) {
    try { engine.telemetry?.record('dream.capacity_evidence', 'failed', { code: error?.code ?? 'capacity_evidence_failed' }); }
    catch { /* Observability cannot change diagnosis flow. */ }
    return [];
  }
}


/** Derive per-route operating points from provider.request telemetry rows.
 *  A route earns a point at a concurrency level when enough attempts ran there
 *  and their queue waits show the endpoint held its latency — sustained
 *  success at concurrency N is the evidence that N is sustainable. */
export function routeCapacityEvidence(rows) {
  const requests = rows.filter((row) => row.event_name === 'provider.request'
    && row.status === 'succeeded' && Number.isFinite(row.admitted_concurrency));
  const groups = new Map();
  for (const row of requests) {
    const key = `${row.route ?? row.provider_profile ?? 'unknown'}@${row.admitted_concurrency}`;
    const group = groups.get(key) ?? { route: row.route ?? row.provider_profile ?? 'unknown',
      concurrency: row.admitted_concurrency, waits: [] };
    if (Number.isFinite(row.queue_wait_ms)) group.waits.push(row.queue_wait_ms);
    groups.set(key, group);
  }
  const points = [];
  for (const group of groups.values()) {
    if (group.waits.length < MIN_SAMPLES_FOR_A_POINT) continue;
    const sorted = [...group.waits].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
    // Why sustained-with-queueing counts: waits at an admitted concurrency show
    // demand exceeded the limit and the endpoint still held its latency.
    if (median >= WAITING_QUEUE_MS || p95 >= WAITING_QUEUE_MS) {
      points.push({ route: group.route, concurrency: group.concurrency, samples: group.waits.length,
        medianQueueWaitMs: median, p95QueueWaitMs: p95 });
    }
  }
  return points;
}
