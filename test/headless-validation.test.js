// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { runHeadless } from '../src/headless.js';

const provider = { endpoint: 'http://127.0.0.1:9/v1', model: 'fixture', trust_zone: 'loopback' };

test('AC-HEAD-05 compatible minor fields are tolerated while incompatible major control fails before work', async () => {
  const accepted = await invoke(`${JSON.stringify({
    version: '1.27', type: 'initialize', request_id: 'minor-init', optional_future_hint: true,
    manifest: { persistence: 'ephemeral', provider },
  })}\n${JSON.stringify({ version: '1.27', type: 'shutdown', request_id: 'minor-stop', optional_note: 'ignored' })}\n`);
  assert.equal(accepted.records[0].type, 'initialized');
  assert.equal(accepted.records.at(-1).type, 'shutdown_complete');
  const rejected = await invoke(`${JSON.stringify({
    version: '2.0', type: 'initialize', request_id: 'major-init', manifest: { provider },
  })}\n`);
  assert.equal(rejected.records.at(-1).code, 'incompatible_version');
  assert.equal(rejected.providerCalls, 0);
});

test('AC-HEAD-06 malformed, deeply nested, oversized, and unknown controls are bounded before execution', async () => {
  const deep = { version: '1.0', type: 'initialize', request_id: 'deep-init', manifest: { provider } };
  let cursor = deep;
  for (let index = 0; index < 30; index += 1) { cursor.nested = {}; cursor = cursor.nested; }
  const cases = [
    { input: '{not-json}\n', code: 'malformed_json' },
    { input: `${JSON.stringify(deep)}\n`, code: 'structure_too_large' },
    { input: `${JSON.stringify({ version: '1.0', type: 'execute_embedded', request_id: 'unknown', command: 'danger' })}\n`, code: 'unknown_control' },
    { input: `${'x'.repeat(513)}`, code: 'line_too_large', maxLineBytes: 512 },
  ];
  for (const item of cases) {
    const result = await invoke(item.input, { maxLineBytes: item.maxLineBytes });
    assert.equal(result.records.at(-1).code, item.code);
    assert.equal(result.providerCalls, 0);
    assert.match(result.diagnostics, new RegExp(item.code, 'u'));
  }
});

async function invoke(inputText, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nna-headless-validation-'));
  let stdout = '';
  let diagnostics = '';
  let providerCalls = 0;
  const output = new Writable({ write(chunk, _encoding, next) { stdout += chunk; next(); } });
  const diagnosticOutput = new Writable({ write(chunk, _encoding, next) { diagnostics += chunk; next(); } });
  try {
    await runHeadless(Readable.from([inputText]), output, diagnosticOutput, {
      ...options, storeRoot: join(root, 'sessions'), reviewerRoot: join(root, 'reviewer'),
      hookRoot: join(root, 'hooks'), providerFactory: () => ({ async *stream() { providerCalls += 1; yield { type: 'terminal' }; } }),
    });
    const records = stdout.trim() ? stdout.trim().split('\n').map(JSON.parse) : [];
    return { records, diagnostics, providerCalls };
  } finally {
    process.exitCode = undefined;
    await rm(root, { recursive: true, force: true });
  }
}
