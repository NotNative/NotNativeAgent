// SPDX-License-Identifier: Apache-2.0

export function declaredSubscription(overrides = {}) {
  return {
    priority: 0,
    timeoutMs: 100,
    cancellation: overrides.blocking ? 'propagate' : 'detach',
    failurePolicy: overrides.blocking ? 'deny' : 'continue',
    inputContract: 'test.event-input/1.0',
    outputContract: 'test.event-output/1.0',
    origin: 'test:fixture',
    trust: 'test',
    resourceBounds: Object.freeze({ maxOutputBytes: 65_536, maxConcurrent: 1 }),
    ...overrides,
  };
}
