// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { atomicWrite, DiagnosticBundle } from '../src/diagnostic-bundle.js';
import { handleSupportCommand } from '../src/tui/support-command.js';
import { decorateContent, decorateFooter } from '../src/tui/decoration.js';

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
    sessionId: 'session-support', config: {
      routes: { primary: { max_output_tokens: 262144 } },
      providerProfiles: { local: { id: 'local', outputLimitTokens: 131072 } },
    }, telemetry: {
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

test('support command scopes the archive to the active conversation only', async () => {
  const activeEngine = { sessionId: 'session-active' };
  const otherEngine = { sessionId: 'session-other' };
  let received;
  class CapturingBundle {
    constructor(options) { received = options; }
    defaultPath() { return 'support.zip'; }
    async create(path) { return { path, bytes: 123 }; }
  }
  const workspace = {
    options: {}, activeEngine: () => activeEngine,
    sessions: new Map([
      ['session-active', { id: 'session-active', engine: activeEngine }],
      ['session-other', { id: 'session-other', engine: otherEngine }],
    ]),
    projection: {
      activeId: 'session-active', sessions: new Map([['session-active', {}], ['session-other', {}]]),
      showNotice() {}, openOverlay() {},
    },
  };

  await handleSupportCommand('/support', '', workspace, { DiagnosticBundle: CapturingBundle });

  assert.equal(received.engine, activeEngine);
  assert.equal(received.activeSessionId, 'session-active');
  assert.deepEqual(received.sessions.map((session) => session.id), ['session-active']);
});

test('oversized support input opens a persistent red failure view instead of disappearing', async () => {
  class OversizedBundle {
    defaultPath() { return 'support.zip'; }
    async create() { throw Object.assign(new Error('too large'), { code: 'zip_input_too_large' }); }
  }
  const notices = []; let opened;
  const engine = { sessionId: 'session-active' };
  const workspace = {
    options: {}, activeEngine: () => engine,
    sessions: new Map([['session-active', { id: 'session-active', engine }]]),
    projection: {
      activeId: 'session-active', sessions: new Map([['session-active', {}]]),
      showNotice: (kind, text) => notices.push({ kind, text }),
      openOverlay: (overlay) => { opened = overlay; },
    },
  };

  await handleSupportCommand('/support', '', workspace, { DiagnosticBundle: OversizedBundle });

  assert.equal(opened.kind, 'support-error');
  assert.match(opened.lines.join('\n'), /ZIP_INPUT_TOO_LARGE.*NOT CREATED/su);
  assert.ok(opened.lineKinds.every((kind) => kind === 'error'));
  assert.equal(notices.at(-1).kind, 'error');
  assert.match(notices.at(-1).text, /ZIP_INPUT_TOO_LARGE/u);
  assert.match(decorateContent('SUPPORT BUNDLE FAILED', 80, true, 0, 'support-error', 'overlay:error'), /\u001b\[1;38;5;203m/u);
  assert.match(decorateFooter('[ERROR] failed', 1, 3, true, 0, 'error'), /\u001b\[1;38;5;203m/u);
});

test('privacy verification failures remain visible and publish no partial support bundle', async () => {
  class RedactionFailureBundle {
    defaultPath() { return 'support.zip'; }
    async create() { throw Object.assign(new Error('blocked'), { code: 'bundle_redaction_failed' }); }
  }
  const notices = []; let opened;
  const engine = { sessionId: 'session-active' };
  const workspace = {
    options: {}, activeEngine: () => engine,
    projection: {
      activeId: 'session-active', sessions: new Map([['session-active', {}]]),
      showNotice: (kind, text) => notices.push({ kind, text }),
      openOverlay: (overlay) => { opened = overlay; },
    },
  };
  await handleSupportCommand('/support', '', workspace, { DiagnosticBundle: RedactionFailureBundle });
  assert.equal(opened.kind, 'support-error');
  assert.match(opened.lines.join('\n'), /BUNDLE_REDACTION_FAILED.*NOT CREATED/su);
  assert.equal(notices.at(-1).kind, 'error');
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
