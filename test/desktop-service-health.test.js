// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedHealthBody } from '../src/desktop-service-health.js';

function invalidBody() {
  return { body: new Response('not json').body };
}

test('health body failures name the probed surface', async () => {
  await assert.rejects(boundedHealthBody(invalidBody(), 'NNA runtime'), {
    code: 'desktop_health_unavailable',
    message: /Unpublished NNA runtime health body is invalid/u,
  });
  await assert.rejects(boundedHealthBody(invalidBody()), {
    code: 'desktop_health_unavailable',
    message: /Unpublished desktop GUI health body is invalid/u,
  });
});
