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
    status: async () => { events.push('status'); if (++polls === 2) throw new Error('desktop_service_not_running'); return { instance_id: 'before' }; },
    attach: async () => { events.push('start'); return { generation: 'after' }; } });
  assert.deepEqual(events, ['stop', 'status', 'status', 'start']); assert.deepEqual(result, { restarted: true, generation: 'after' });
});
test('an unverified or replaced controller refuses restart without starting another service', async () => {
  for (const failure of ['desktop_owner_unverified', 'desktop_restart_generation_changed']) {
    let starts = 0;
    await assert.rejects(runTrayAction('C:/Desktop', 'restart', { ...base(), probe: async () => ({ generation: 'before' }), stop: async () => undefined,
      status: async () => { if (failure === 'desktop_owner_unverified') throw new Error(failure); return { instance_id: 'other' }; },
      attach: async () => { starts += 1; } }), { message: failure });
    assert.equal(starts, 0);
  }
});
test('a stuck controller reaches the bounded stop failure', async () => {
  let polls = 0;
  await assert.rejects(runTrayAction('C:/Desktop', 'restart', { ...base(), probe: async () => ({ generation: 'before' }), stop: async () => undefined,
    status: async () => { polls += 1; return { instance_id: 'before' }; } }), { message: 'desktop_stop_timeout' });
  assert.equal(polls, 150);
});
test('the tray quit names its generation when it asks the controller to stop', async () => {
  // The controller refuses any privileged call that omits this header with 409
  // generation_mismatch. The tray swallowed that refusal and did nothing, so
  // the quit item read as broken while `nna desktop stop` worked.
  const source = await readFile(new URL('./nnd-tray-host.ps1', import.meta.url), 'utf8');
  const stop = source.match(/function Stop-Service \{[\s\S]*?\n\}/u)?.[0] ?? '';
  assert.match(stop, /x-desktop-generation/u);
  assert.match(stop, /record\.instance_id/u);
});
test('a refused quit is reported instead of silently doing nothing', async () => {
  const source = await readFile(new URL('./nnd-tray-host.ps1', import.meta.url), 'utf8');
  const quit = source.match(/\$quitItem\.add_Click\(\{[\s\S]*?\}\)/u)?.[0] ?? '';
  assert.match(quit, /Exit-Tray/u);
  assert.match(quit, /MessageBox/u);
});
test('standalone desktop branding stays identical to the canonical NNA asset', async () => {
  assert.deepEqual(await readFile(new URL('../packages/electron/brand/nna.png', import.meta.url)), await readFile(new URL('../../resources/icons/notnative-agent-32.png', import.meta.url)));
});
