// SPDX-License-Identifier: Apache-2.0
// The wire version resolver: the reported target tracks npm's @opencode/cli
// latest so OpenChamber's update toast never announces an unactionable update,
// and fails closed to the pinned constant whenever the registry cannot give a
// usable answer. These tests pin the acceptance gate and every fallback path.
import assert from 'node:assert/strict';
import test from 'node:test';
import { WIRED_OPENCODE_VERSION, MINIMUM_OPENCODE_VERSION, resolveWiredOpenCodeVersion } from '../src/opencode/version.js';

const jsonOk = (payload) => async () => ({ ok: true, status: 200, json: async () => payload });

test('a 2.x registry answer at or above the floor is the reported version', async () => {
  assert.equal(await resolveWiredOpenCodeVersion(jsonOk({ version: '2.9.3' })), '2.9.3');
  assert.equal(await resolveWiredOpenCodeVersion(jsonOk({ version: `v${MINIMUM_OPENCODE_VERSION}` })),
    MINIMUM_OPENCODE_VERSION, 'a v-prefixed answer is accepted');
});

test('a malformed, future-major, or below-floor answer falls back to the pinned value', async () => {
  assert.equal(await resolveWiredOpenCodeVersion(jsonOk({ version: '' })), WIRED_OPENCODE_VERSION);
  assert.equal(await resolveWiredOpenCodeVersion(jsonOk({})), WIRED_OPENCODE_VERSION);
  assert.equal(await resolveWiredOpenCodeVersion(jsonOk({ version: '3.0.0' })), WIRED_OPENCODE_VERSION,
    'a future major is rejected by the client gate');
  assert.equal(await resolveWiredOpenCodeVersion(jsonOk({ version: '2.2.3' })), WIRED_OPENCODE_VERSION,
    'a value below the client floor makes the surface unreachable');
  assert.equal(await resolveWiredOpenCodeVersion(jsonOk({ version: '2.2.7-beta.1' })), WIRED_OPENCODE_VERSION,
    'a prerelease tag is not a clean 2.x semver');
});

test('a registry failure falls back without throwing', async () => {
  assert.equal(await resolveWiredOpenCodeVersion(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    WIRED_OPENCODE_VERSION);
  assert.equal(await resolveWiredOpenCodeVersion(async () => { throw new Error('offline'); }),
    WIRED_OPENCODE_VERSION);
  const pinned = await resolveWiredOpenCodeVersion(jsonOk({ version: WIRED_OPENCODE_VERSION }));
  assert.equal(pinned, WIRED_OPENCODE_VERSION);
});
