// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StructuredLog } from '../src/structured-log.js';

test('AC-PRIV-03 structured diagnostics persist metadata without free-form content, secrets, or an exporter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-structured-log-'));
  const path = join(root, 'runtime.ndjson');
  const first = await new StructuredLog({ path, limit: 32 }).initialize();
  first.record({ type: 'error', code: 'provider_failed', text: 'api_key=do-not-store-this' }, { sessionId: 'session-1' });
  first.record({ type: 'turn_result', outcome: 'completed', turn_id: 'turn-1' }, { sessionId: 'session-1' });
  await first.flush();
  assert.doesNotMatch(await readFile(path, 'utf8'), /do-not-store-this|api_key/u);
  const second = await new StructuredLog({ path, limit: 32 }).initialize();
  assert.deepEqual(second.snapshot().records.map((item) => item.code), ['provider_failed', 'turn_result']);
  assert.ok(second.snapshot().records.every((item) => item.product_version));
  assert.equal(Object.hasOwn(second, 'exporter'), false);
});

test('structured diagnostics rotate at a bounded size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-log-rotation-'));
  const path = join(root, 'runtime.ndjson');
  const logger = await new StructuredLog({ path, limit: 64, maxBytes: 512 }).initialize();
  for (let index = 0; index < 12; index += 1) logger.record({ type: 'error', code: `error_${index}` });
  await logger.flush();
  assert.ok((await stat(path)).size <= 512);
  assert.ok((await stat(`${path}.1`)).size <= 512);
});

test('AC-OBS-02 cross-boundary diagnostics retain correlation and stable codes without content', () => {
  const logger = new StructuredLog();
  const record = logger.record({
    type: 'tool_terminal', code: 'tool_timeout', outcome: 'failed',
    turn_id: 'turn-1', step_id: 'step-2', attempt_id: 'attempt-3',
    logical_request_id: 'logical-4', provider_call_id: 'provider-5',
    tool_request_id: 'tool-6', text: 'Bearer seeded-secret',
  }, { sessionId: 'session-0' });
  assert.deepEqual({
    session: record.session_id, turn: record.turn_id, step: record.step_id,
    attempt: record.attempt_id, logical: record.logical_request_id,
    provider: record.provider_call_id, tool: record.tool_request_id,
    code: record.code, outcome: record.outcome,
  }, {
    session: 'session-0', turn: 'turn-1', step: 'step-2', attempt: 'attempt-3',
    logical: 'logical-4', provider: 'provider-5', tool: 'tool-6',
    code: 'tool_timeout', outcome: 'failed',
  });
  assert.doesNotMatch(JSON.stringify(record), /seeded-secret|Bearer|text/u);
});
