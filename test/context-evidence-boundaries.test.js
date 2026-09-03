// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentObservationRouter } from '../src/attachments.js';
import { createToolContextReceipt } from '../src/tools/context-receipt.js';
import { projectDuplicateToolResults } from '../src/reliability/duplicate-results.js';
import { buildContext } from '../src/context.js';
import { sessionHistoryDefinitions } from '../src/session-history-tools.js';
import { projectActiveTurn } from '../src/reliability/context-pressure.js';

function project(record) {
  return JSON.parse(buildContext({ workspaceRoot: process.cwd(), limits: { maxContextBytes: 1_048_576 } }, [
    { type: 'tool_request', providerCallId: record.providerCallId, toolName: record.toolName, args: {} }, record,
  ], '').find((item) => item.role === 'tool').content);
}

test('receipt projection has one byte-accounting block and a literal excerpt', () => {
  const record = { type: 'tool_result', toolName: 'fs.read', providerCallId: 'call', requestId: 'request',
    toolLifecycleStatus: 'succeeded', content: 'source line\n'.repeat(2000) };
  const receipt = createToolContextReceipt(record);
  const envelope = project(receipt);
  const body = JSON.parse(envelope.content);
  assert.equal(body.summary, undefined);
  assert.equal(body.projection, undefined);
  assert.match(body.excerpt, /middle omitted/);
  assert.equal(envelope.metadata.originalBytes, undefined);
  assert.equal(envelope.metadata.projectedBytes, undefined);
  assert.equal(envelope.metadata.projectionReason, undefined);
  assert.equal(envelope.projection_metadata.original_bytes, Buffer.byteLength(record.content));
  assert.equal(envelope.projection_metadata.projected_bytes, Buffer.byteLength(receipt.content));
  assert.equal(envelope.projection_metadata.omitted_bytes,
    Buffer.byteLength(record.content) - envelope.projection_metadata.retained_source_bytes);
  assert.equal(createToolContextReceipt(receipt).content, receipt.content);
});

test('receipt omission ranges describe exact UTF-8 content and expose a usable history request', () => {
  const source = 'begin💜'.repeat(1000) + 'end界'.repeat(1000);
  const record = { type: 'tool_result', toolName: 'fs.read', requestId: 'request', providerCallId: 'call',
    toolLifecycleStatus: 'succeeded', content: source };
  const receipt = createToolContextReceipt(record);
  const metadata = project(receipt).projection_metadata;
  const [range] = metadata.omitted_ranges;
  const bytes = Buffer.from(source);
  assert.equal(metadata.range_basis, 'tool_content_utf8');
  assert.equal(metadata.evidence_complete, false);
  assert.equal(range.end_byte_exclusive - range.start_byte, metadata.omitted_bytes);
  assert.equal(JSON.parse(receipt.content).excerpt, bytes.subarray(0, range.start_byte).toString('utf8')
    + '\n...[middle omitted]...\n' + bytes.subarray(range.end_byte_exclusive).toString('utf8'));
  assert.deepEqual(metadata.recovery.args, { ledger_ref: 'request' });
  assert.equal(metadata.recovery.tool, 'session.read_history');
  assert.deepEqual(project(createToolContextReceipt(receipt)).projection_metadata.omitted_ranges, metadata.omitted_ranges);
  assert.equal(project(receipt).metadata.omittedRanges, undefined);
});

test('already-bounded and redacted evidence never invents original byte ranges', () => {
  for (const extra of [{ truncated: true }, { metadata: { contentRedacted: true } }, { metadata: { originalBytes: 99999 } }]) {
    const receipt = createToolContextReceipt({ type: 'tool_result', toolName: 'fs.read', providerCallId: 'call',
      toolLifecycleStatus: 'succeeded', content: 'retained '.repeat(1000), ...extra });
    const metadata = project(receipt).projection_metadata;
    assert.equal(metadata.omitted_ranges, undefined);
    assert.match(metadata.recovery.instruction, /cannot be restored from history/u);
  }
});

test('active receipt pressure preserves failed tool evidence without truncating repair instructions', () => {
  const failure = { type: 'tool_result', turnId: 'turn', stepId: 'old', toolName: 'fs.read',
    providerCallId: 'failed', toolLifecycleStatus: 'failed', content: 'repair evidence '.repeat(1000) };
  const records = [failure, ...[1, 2, 3].map((step) => ({ type: 'message', role: 'assistant',
    turnId: 'turn', stepId: `recent-${step}`, content: 'continue' }))];
  assert.strictEqual(projectActiveTurn(records, { turnId: 'turn', tier: 'receipts' }).records[0], failure);
});

test('duplicate receipts expose the removed source byte count', () => {
  const content = 'identical evidence '.repeat(1000);
  const records = ['old', 'new'].map((id) => ({ type: 'tool_result', toolName: 'fs.read',
    requestId: id, providerCallId: id, toolLifecycleStatus: 'succeeded', content }));
  const duplicate = projectDuplicateToolResults(records).records[0];
  const envelope = project(duplicate);
  assert.equal(envelope.content_projection, 'receipt');
  assert.equal(envelope.projection_metadata.original_bytes, Buffer.byteLength(content));
  assert.equal(envelope.projection_metadata.omitted_bytes, Buffer.byteLength(content));
});

test('receipt references recover exact tool results without confusing request records', async () => {
  const records = [
    { type: 'tool_request', requestId: 'tool-1', providerCallId: 'call-1', args: {} },
    { type: 'tool_result', requestId: 'tool-1', providerCallId: 'call-1', content: 'exact evidence' },
  ];
  const read = sessionHistoryDefinitions({ transcript: () => records }).find((tool) => tool.name === 'session.read_history');
  for (const ledger_ref of ['tool-1', 'call-1']) {
    const request = await read.validate({ ledger_ref });
    const output = JSON.parse((await read.executor(request, new AbortController().signal)).content);
    assert.equal(output.records[0].record_index, 1);
    assert.equal(output.records[0].record.content, 'exact evidence');
  }
  for (const args of [{}, { record_index: 0, ledger_ref: 'tool-1' }, { record_index: -1 }, { ledger_ref: '' }]) {
    await assert.rejects(read.validate(args), { code: 'tool_schema_invalid' });
  }
  await assert.rejects(read.executor({ args: { ledger_ref: 'missing' } }, new AbortController().signal),
    { code: 'session_history_record_missing' });
});

test('vision streaming bounds bytes before collection and cancels oversized output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-observation-bound-'));
  const managedPath = join(root, 'image.png');
  await writeFile(managedPath, Buffer.from('89504e470d0a1a0a', 'hex'));
  const route = { profile: { id: 'fixture' }, model: 'fixture', deadlineMs: 1000, maxOutputTokens: 1024 };
  for (const [text, terminal, code] of [
    ['💜'.repeat(40_000), 'stop', 'attachment_observation_too_large'],
    ['partial', 'length', 'attachment_observation_truncated'],
  ]) {
    let signal; let closed = false;
    const provider = { async *stream(request, receivedSignal) {
      signal = receivedSignal;
      assert.equal(request.maxOutputTokens, 1024);
      try { yield { type: 'text', text }; yield { type: 'terminal', finishReason: terminal }; }
      finally { closed = true; }
    } };
    const observer = new AttachmentObservationRouter({ config: { version: 1 }, resolve: () => route, provider: () => provider });
    await assert.rejects(observer.observe({ managedPath, mimeType: 'image/png' }, 'inspect', new AbortController().signal), { code });
    assert.equal(signal.aborted, true);
    assert.equal(closed, true);
  }
});
