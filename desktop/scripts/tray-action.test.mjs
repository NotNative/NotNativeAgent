// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runTrayAction } from './tray-action.mjs';
const plan = { nnaInstallRoot: 'C:/NNA', installationId: 'install', dataId: 'data', incarnationId: 'incarnation' };
const base = () => ({ resolve: async () => plan, delay: async () => undefined });
test('browser action uses the verified local endpoint and a one-use fragment without returning its code', async () => {
  let opened;
  const result = await runTrayAction('C:/Desktop', 'browser', { ...base(),
    attach: async () => ({ origin: 'http://127.0.0.1:12345', ticket: 'one-use-code' }), open: async url => { opened = url; } });
  assert.equal(opened, 'http://127.0.0.1:12345/#nna-access=one-use-code');
  assert.deepEqual(result, { opened: true });
});
test('restart waits for the old controller to disappear before starting a new generation', async () => {
  const events = []; let polls = 0;
  const result = await runTrayAction('C:/Desktop', 'restart', { ...base(),
    probe: async () => ({ generation: 'before' }), stop: async () => { events.push('stop'); },
    status: async () => { events.push('status'); if (++polls === 2) throw new Error('nnd_service_not_running'); return { instance_id: 'before' }; },
    attach: async () => { events.push('start'); return { generation: 'after' }; } });
  assert.deepEqual(events, ['stop', 'status', 'status', 'start']); assert.deepEqual(result, { restarted: true, generation: 'after' });
});
test('an unverified or replaced controller refuses restart without starting another service', async () => {
  for (const failure of ['nnd_owner_unverified', 'nnd_restart_generation_changed']) {
    let starts = 0;
    await assert.rejects(runTrayAction('C:/Desktop', 'restart', { ...base(), probe: async () => ({ generation: 'before' }), stop: async () => undefined,
      status: async () => { if (failure === 'nnd_owner_unverified') throw new Error(failure); return { instance_id: 'other' }; },
      attach: async () => { starts += 1; } }), { message: failure });
    assert.equal(starts, 0);
  }
});
test('a stuck controller reaches the bounded stop failure', async () => {
  let polls = 0;
  await assert.rejects(runTrayAction('C:/Desktop', 'restart', { ...base(), probe: async () => ({ generation: 'before' }), stop: async () => undefined,
    status: async () => { polls += 1; return { instance_id: 'before' }; } }), { message: 'nnd_stop_timeout' });
  assert.equal(polls, 150);
});
test('standalone desktop branding stays identical to the canonical NNA asset', async () => {
  assert.deepEqual(await readFile(new URL('../packages/electron/brand/nna.png', import.meta.url)), await readFile(new URL('../../resources/icons/notnative-agent-32.png', import.meta.url)));
});
