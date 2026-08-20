// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { atomicWrite, DiagnosticBundle } from '../src/diagnostic-bundle.js';
import { handleSupportCommand } from '../src/tui/support-command.js';

test('published diagnostic bundles survive temporary-file cleanup failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-diagnostic-publish-'));
  const path = join(root, 'support.zip');
  let cleanupAttempts = 0;
  await atomicWrite(path, Buffer.from('bundle'), {
    open,
    unlink: async () => {
      cleanupAttempts += 1;
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    },
  });
  assert.equal(cleanupAttempts, 1);
  assert.deepEqual(await readFile(path), Buffer.from('bundle'));
});

test('support command reports its exact local destination before and after publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-support-command-'));
  const engine = {
    sessionId: 'session-support', config: {}, telemetry: {
      async flush() {}, async supportSnapshot() { return { format: 1, rows: [], open_spans: [] }; },
    },
    async health() { return { status: 'ready' }; },
    reviewerAudit() { return []; }, governanceAudit() { return []; },
  };
  const notices = []; let opened;
  const workspace = {
    options: { supportRoot: root }, activeEngine: () => engine,
    sessions: new Map([['session-support', { id: 'session-support', engine }]]),
    projection: {
      activeId: 'session-support', sessions: new Map([['session-support', {}]]),
      showNotice: (kind, text) => notices.push({ kind, text }),
      openOverlay: (overlay) => { opened = overlay; },
    },
    dream: null,
  };

  await handleSupportCommand('/support', '', workspace);

  assert.equal(notices.length, 2);
  assert.match(notices[0].text, /^Creating a local redacted ZIP at /u);
  assert.match(notices[1].text, /^Support bundle saved to /u);
  const path = notices[1].text.slice('Support bundle saved to '.length);
  assert.equal(path.startsWith(root), true);
  assert.equal(path.endsWith('.zip'), true);
  assert.match(opened.lines.join('\n'), new RegExp(escapeRegex(path), 'u'));
  assert.equal((await readFile(path)).readUInt32LE(0), 0x04034b50);
});

test('diagnostic bundle default path stays within its configured support directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-support-path-'));
  const bundle = new DiagnosticBundle({ engine: { sessionId: 'session-path' }, supportRoot: root });
  assert.equal(bundle.defaultPath().startsWith(root), true);
  assert.match(bundle.defaultPath(), /NotNativeAgent-support-.*\.zip$/u);
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
