// SPDX-License-Identifier: Apache-2.0
/**
 * What a tool row shows, and what it must never show.
 *
 * Why this is its own test file: the summary is the one place transcript content is
 * derived from a tool's execution, so the security boundary is worth asserting
 * directly rather than inferring from a transcript that renders.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toolSummary, toolDisplayOutput, toolPartState } from '../src/opencode/tool-summary.js';

test('a row names what was touched and how it went', () => {
  assert.deepEqual(toolSummary({ target: 'src/a.js', status: 'succeeded', elapsedMs: 42 }),
    { target: 'src/a.js', outcome: '42ms' });
  assert.deepEqual(toolSummary({ target: 'npm test', status: 'completed_nonzero', exitCode: 1 }),
    { target: 'npm test', outcome: 'exit 1' });
  assert.deepEqual(toolSummary({ target: 'src/b.js', status: 'failed', failureReason: 'file not found' }),
    { target: 'src/b.js', outcome: 'file not found' });
});

test('a running row names its target but claims no outcome', () => {
  // Why: an outcome is a fact about a finished call. Printing one while a call is
  // still running would state something the run has not said yet.
  assert.deepEqual(toolSummary({ target: 'src/a.js', status: 'running' }), { target: 'src/a.js', outcome: null });
  assert.deepEqual(toolSummary({ target: 'src/a.js', status: 'review_pending' }), { target: 'src/a.js', outcome: null });
});

test('a row with nothing to say says nothing', () => {
  // Why: an absent summary must stay absent. A placeholder such as "No output
  // produced" reads as a failure of the tool rather than of the report.
  assert.deepEqual(toolSummary({ status: 'succeeded' }), { target: null, outcome: null });
  assert.deepEqual(toolSummary({}), { target: null, outcome: null });
  assert.deepEqual(toolSummary(null), { target: null, outcome: null });
  assert.deepEqual(toolSummary({ target: '   ', status: 'succeeded' }), { target: null, outcome: null });
});

test('a target is bounded rather than growing with the path', () => {
  const long = toolSummary({ target: 'x'.repeat(400), status: 'succeeded' });
  assert.ok(long.target.length <= 160);
  assert.ok(long.target.endsWith('…'));
});

test('the summary carries no argument or result field by construction', () => {
  // Security: a tool's arguments can hold a secret and its result can hold retrieved
  // page content. A transcript is replayed to the model on the next turn, so echoing
  // either there would let retrieval gain authority it was never granted. The shape
  // is closed: only these two keys can ever be produced, whatever the record holds.
  const summary = toolSummary({
    target: 'src/a.js', status: 'succeeded', elapsedMs: 5,
    arguments: { password: 'secret-value' }, content: 'retrieved page text', output: 'raw output',
  });
  assert.deepEqual(Object.keys(summary).sort(), ['outcome', 'target']);
  assert.equal(JSON.stringify(summary).includes('secret-value'), false);
  assert.equal(JSON.stringify(summary).includes('retrieved page text'), false);
});

test('display output exists to be shown, capped and redacted', () => {
  const output = toolDisplayOutput('line one\n\n  line two  ');
  assert.equal(output, 'line one line two');
  const long = toolDisplayOutput('y'.repeat(5_000));
  assert.ok(long.length <= 4_096);
  assert.equal(long.endsWith('\u2026'), true);
  assert.equal(toolDisplayOutput(''), null);
  assert.equal(toolDisplayOutput('   '), null);
  assert.equal(toolDisplayOutput(42), null);
});
test('a completed part carries a label and an expandable body', () => {
  const state = toolPartState({
    tool: 'fs_read', target: 'src/a.js', status: 'succeeded', elapsed_ms: 12,
    display_content: 'the file body a reader may expand to see',
  }, 'completed');
  assert.equal(state.status, 'completed');
  assert.deepEqual(state.input, { target: 'src/a.js' });
  assert.equal(state.metadata.outcome, '12ms');
  assert.equal(state.metadata.output, 'the file body a reader may expand to see');
  assert.deepEqual(state.content, [{ type: 'text', text: '12ms' }]);
  // Security: the closed wire shape. No arguments, no raw result fields.
  assert.deepEqual(Object.keys(state).sort(), ['content', 'input', 'metadata', 'status']);
});

test('a running part claims neither outcome nor body', () => {
  const state = toolPartState({ tool: 'fs_read', target: 'src/a.js', status: 'running' }, 'running');
  assert.deepEqual(state.metadata, {});
  assert.equal('content' in state, false);
});

test('a failed part carries the typed error, not raw text', () => {
  const state = toolPartState({
    tool: 'shell_run', target: 'npm test', status: 'failed', failure_reason: 'file not found',
    display_content: 'stack trace text',
  }, 'error');
  assert.equal(state.status, 'error');
  assert.equal(state.error.type, 'nna_tool_failed');
  assert.equal(state.metadata.output, 'stack trace text');
});
