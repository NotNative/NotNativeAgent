// SPDX-License-Identifier: Apache-2.0
// The capacity evidence extractor: pins what telemetry rows earn a route an
// operating point and what does not, because the dream candidate built on
// these derivations must cite only evidence that actually shows sustained
// queued traffic at a working concurrency.
import assert from 'node:assert/strict';
import test from 'node:test';
import { routeCapacityEvidence } from '../src/dream-capacity.js';

function row(overrides = {}) {
  return { event_name: 'provider.request', status: 'succeeded',
    route: 'local-endpoint', admitted_concurrency: 2, queue_wait_ms: 10, ...overrides };
}

test('sustained queued-and-succeeded traffic earns a route an operating point', () => {
  const rows = Array.from({ length: 8 }, (_, index) => row({ queue_wait_ms: 80 + index }));
  const points = routeCapacityEvidence(rows);
  assert.equal(points.length, 1);
  assert.equal(points[0].route, 'local-endpoint');
  assert.equal(points[0].concurrency, 2);
  assert.equal(points[0].samples, 8);
  assert.equal(points[0].medianQueueWaitMs, 84);
  assert.ok(points[0].p95QueueWaitMs >= points[0].medianQueueWaitMs);
});

test('immediate admission without queueing earns no point', () => {
  const rows = Array.from({ length: 8 }, () => row({ queue_wait_ms: 0 }));
  assert.deepEqual(routeCapacityEvidence(rows), []);
});

test('too few samples at a concurrency level earn no point', () => {
  const rows = Array.from({ length: 4 }, () => row({ queue_wait_ms: 100 }));
  assert.deepEqual(routeCapacityEvidence(rows), []);
});

test('failed attempts and non-provider rows are never evidence', () => {
  const rows = [
    ...Array.from({ length: 6 }, () => row({ queue_wait_ms: 100 })),
    ...Array.from({ length: 6 }, () => row({ status: 'failed', queue_wait_ms: 100 })),
    ...Array.from({ length: 6 }, () => row({ event_name: 'tool.execution', queue_wait_ms: 100 })),
    ...Array.from({ length: 6 }, () => row({ admitted_concurrency: null, queue_wait_ms: 100 })),
  ];
  const points = routeCapacityEvidence(rows);
  assert.equal(points.length, 1, 'only the succeeded, concurrency-stamped rows count');
  assert.equal(points[0].samples, 6);
});

test('distinct routes and concurrency levels earn separate points', () => {
  const rows = [
    ...Array.from({ length: 5 }, () => row({ route: 'a', admitted_concurrency: 1, queue_wait_ms: 60 })),
    ...Array.from({ length: 5 }, () => row({ route: 'a', admitted_concurrency: 2, queue_wait_ms: 90 })),
    ...Array.from({ length: 5 }, () => row({ route: 'b', admitted_concurrency: 1, queue_wait_ms: 70 })),
  ];
  const points = routeCapacityEvidence(rows);
  assert.equal(points.length, 3);
  const keys = points.map((point) => `${point.route}@${point.concurrency}`).sort();
  assert.deepEqual(keys, ['a@1', 'a@2', 'b@1']);
});

test('the row field the runner records is the profile the rows carry', () => {
  // Why: the runner stamps provider_profile, not route; the extractor must
  // accept the recorded field name.
  const rows = Array.from({ length: 5 }, () => row({ route: undefined, provider_profile: 'worker', queue_wait_ms: 100 }));
  const points = routeCapacityEvidence(rows);
  assert.equal(points.length, 1);
  assert.equal(points[0].route, 'worker');
});
