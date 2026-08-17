// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProcessIdentity } from '../src/reliability/process-identity.js';

test('Linux process identity binds a PID to procfs start ticks', async () => {
  let current = '4242';
  const stat = () => `77 (node worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${current} 20`;
  const identity = new ProcessIdentity({ platform: 'linux', kill: () => undefined, readFile: async () => stat() });
  const captured = await identity.capture(77);
  assert.equal(captured.start_id, '4242');
  assert.equal(await identity.compare(captured), 'same');
  current = '9999';
  assert.equal(await identity.compare(captured), 'different');
});

test('process identity generates bounded native probes for Windows and macOS', async () => {
  const calls = [];
  const create = (platform, output) => new ProcessIdentity({
    platform, kill: () => undefined,
    runProbe: async (executable, args) => { calls.push({ executable, args }); return output; },
  });
  assert.equal((await create('win32', '638910000000000000\r\n').capture(12)).start_id, '638910000000000000');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-NoLogo', '-NoProfile', '-NonInteractive']);
  assert.match(calls[0].args.at(-1), /Get-Process -Id 12/u);
  assert.equal((await create('darwin', 'Mon Aug 17 09:00:00 2026\n').capture(13)).start_id, 'Mon Aug 17 09:00:00 2026');
  assert.deepEqual(calls[1], { executable: 'ps', args: ['-o', 'lstart=', '-p', '13'] });
});

test('process identity reports dead and unknown states without treating a recycled PID as its owner', async () => {
  const dead = new ProcessIdentity({ platform: 'linux', kill: () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); } });
  assert.equal(await dead.compare({ version: 1, pid: 2, platform: 'linux', start_id: '1' }), 'dead');
  const unknown = new ProcessIdentity({ platform: 'linux', kill: () => undefined, readFile: async () => { throw new Error('blocked'); } });
  assert.equal(await unknown.compare({ version: 1, pid: 2, platform: 'linux', start_id: '1' }), 'unknown');
});

test('Windows legacy PID evidence matches only a file published after that process started', () => {
  const identity = new ProcessIdentity({ platform: 'win32' });
  const epoch = 621_355_968_000_000_000n;
  const startedMs = 1_800_000_000_000;
  const captured = { version: 1, pid: 42, platform: 'win32', start_id: String(epoch + BigInt(startedMs) * 10_000n) };
  assert.equal(identity.legacyPidFileMatches(captured, startedMs + 250), true);
  assert.equal(identity.legacyPidFileMatches(captured, startedMs - 1), false);
  assert.equal(identity.legacyPidFileMatches(captured, startedMs + 60_001), false);
});
