// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { drainNndLegacyTakeover } from '../src/nnd-legacy-takeover.js';
import { probeNndLegacyOwners } from '../src/nnd-legacy-census.js';

async function fakeLegacyOwner(root) {
  await writeFile(join(root, 'cli.js'), 'setInterval(()=>{},1000);');
  const child = spawn(process.execPath, [join(root, 'cli.js'), 'nnd', 'serve'],
    { windowsHide: true, stdio: 'ignore' });
  const exit = once(child, 'exit');
  return { child, exit };
}

test('takeover drain names the live legacy owner, refuses after the window, and never terminates it',
  { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "nnd-drain-"));
  const { child, exit } = await fakeLegacyOwner(root);
  try {
    const identity = { node: process.execPath };
    const refusal = await drainNndLegacyTakeover(identity, new AbortController().signal, { windowMs: 0, intervalMs: 250 })
      .then(() => null, (error) => error);
    assert.equal(refusal?.code, 'nnd_legacy_takeover_required');
    assert.match(refusal.message, new RegExp(String(child.pid)));
    assert.match(refusal.message, /No process was terminated/u);
    assert.equal(child.exitCode, null);
    const probe = await probeNndLegacyOwners(identity);
    assert.ok(probe.legacy_pids.includes(child.pid));
  } finally {
    child.kill(); await exit;
    await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
});

test('takeover drain waits for voluntary release and returns the exact census receipt frame',
  { skip: process.platform !== 'win32', timeout: 180000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "nnd-drain-"));
  const { child, exit } = await fakeLegacyOwner(root);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      const census = await drainNndLegacyTakeover({ node: process.execPath }, controller.signal,
        { windowMs: 120000, intervalMs: 1000 });
      assert.deepEqual(Object.keys(census).sort(), ['checked_at', 'legacy', 'scanned', 'unknown', 'version']);
      assert.equal(census.legacy, 0); assert.equal(census.unknown, 0);
      assert.equal(typeof census.checked_at, 'string');
    } finally { clearTimeout(timer); }
    await exit;
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exit; }
    await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
});

test('takeover drain aborts with its lease signal instead of outliving the caller',
  { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "nnd-drain-"));
  const { child, exit } = await fakeLegacyOwner(root);
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('lease-lost')), 1500);
    await assert.rejects(drainNndLegacyTakeover({ node: process.execPath }, controller.signal,
      { windowMs: 120000, intervalMs: 500 }), /lease-lost/u);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill(); await exit;
    await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
});
