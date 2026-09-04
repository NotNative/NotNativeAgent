// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticateIntegrationRequest } from '../src/integration-principal.js';

const TOKEN = 'ephemeral-integration-token-with-at-least-32-characters';

test('integration authentication fails closed for invalid configuration and malformed requests', () => {
  assert.equal(authenticateIntegrationRequest(undefined, TOKEN), false);
  assert.equal(authenticateIntegrationRequest({}, TOKEN), false);
  assert.equal(authenticateIntegrationRequest({ headers: {} }, TOKEN), false);
  assert.equal(authenticateIntegrationRequest({ headers: { authorization: 'Bearer ' } }, ''), false);
  assert.equal(authenticateIntegrationRequest({ headers: { authorization: `Bearer ${TOKEN}` } }, undefined), false);
  assert.equal(authenticateIntegrationRequest({ headers: { authorization: `Bearer ${TOKEN}` } }, 42), false);
  assert.equal(authenticateIntegrationRequest({ headers: { authorization: `Bearer ${TOKEN}` } }, 'too-short'), false);
});

test('integration authentication accepts only the configured bearer token', () => {
  assert.equal(authenticateIntegrationRequest({
    headers: { authorization: `Bearer ${TOKEN}` },
  }, TOKEN), true);
  assert.equal(authenticateIntegrationRequest({
    headers: { authorization: `Bearer ${TOKEN}-other` },
  }, TOKEN), false);
});
