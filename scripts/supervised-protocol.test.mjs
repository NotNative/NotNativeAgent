// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateBootstrap, validateControl, readPrivateFrames } from './supervised-protocol.mjs';

test('bootstrap binds selected canonical identities and rejects credentials in URL', async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'nnd-protocol-')));
  try {
    const hash = createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex');
    const frame = { type: 'bootstrap', protocol: '1.0', installation_id: `nna_${hash}`, data_id: `data_${hash}`,
      generation: 'test', nna_install_root: path, nna_data_root: path, nnd_data_root: path,
      ui_origin: 'http://127.0.0.1:80', health_key: Buffer.alloc(32, 0x58).toString('base64url'),
      engine: { endpoint: 'http://127.0.0.1:4501', token: 'a'.repeat(32), capability: 'cap_1abcdef.sig_abcdef12345' } };
    assert.equal((await validateBootstrap(frame)).ui_origin, frame.ui_origin);
    await assert.rejects(validateBootstrap({ ...frame, data_id: `data_${'b'.repeat(64)}` }));
    await assert.rejects(validateBootstrap({ ...frame, engine: { ...frame.engine, endpoint: 'http://user@127.0.0.1' } }));
    await assert.rejects(validateBootstrap({ ...frame, engine: { endpoint: 'http://127.0.0.1:4501', token: 'a'.repeat(32) } }));
    await assert.rejects(validateBootstrap({ ...frame, extra: true }));
    await assert.rejects(validateBootstrap({ ...frame, health_key: 'a'.repeat(43) }));
  } finally { await rm(path, { recursive: true, force: true }); }
});
test('control is generation-bound and cannot carry authority', () => {
  const frame = { type: 'issue_ui_ticket', protocol: '1.0', generation: 'g', request_id: 'r' };
  assert.equal(validateControl(frame, 'g'), frame);
  assert.throws(() => validateControl(frame, 'other'));
  assert.throws(() => validateControl({ ...frame, token: 'injected' }, 'g'));
  assert.throws(() => validateControl({ ...frame, type: 'bootstrap' }, 'g'));
});
test('private parser bounds unterminated lines and queued messages', async () => {
  for (const payload of ['x'.repeat(65537), '{}\n'.repeat(17), Buffer.from([0xff, 10])]) {
    const input = new PassThrough(); let ended = 0;
    const frames = readPrivateFrames(input, () => ended++);
    input.write(payload);
    await assert.rejects(frames.next()); assert.equal(ended, 1);
    frames.dispose(); input.destroy();
  }
});
test('EOF aborts owner and incomplete frames fail closed', async () => {
  const input = new PassThrough(); let ended = 0;
  const frames = readPrivateFrames(input, () => ended++);
  input.end('{');
  await assert.rejects(frames.next()); assert.equal(ended, 1); frames.dispose();
});
