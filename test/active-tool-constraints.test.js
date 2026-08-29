// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContext } from '../src/context.js';
import { clearAuthorityConstraints, mergeToolConstraints } from '../src/tools/active-constraints.js';

function item(tool, status, detail = {}) {
  return {
    call: { name: tool, args: detail.args ?? { path: 'target.txt' } },
    result: {
      tool_name: tool, status, reason_code: detail.reason ?? status,
      content: detail.content ?? status, metadata: detail.metadata,
    },
  };
}

test('active constraints retain structured repairs and clear them after verified success', () => {
  const invalid = item('fs.search_text', 'invalid_request', {
    reason: 'tool_schema_invalid', content: 'argument "path" must be a directory; received a file',
  });
  const constraints = mergeToolConstraints([], [invalid]);
  assert.equal(constraints[0].kind, 'schema_repair');
  assert.equal(constraints[0].request_fingerprint, undefined);
  assert.match(constraints[0].instruction, /same invalid request shape/u);
  assert.match(constraints[0].instruction, /do not repeat/u);
  assert.deepEqual(mergeToolConstraints(constraints, [item('fs.search_text', 'succeeded')]), []);
});

test('truncated argument lesson persists while the immediate repair mode stays one-step', () => {
  const first = item('fs.edit_text', 'invalid_request', {
    reason: 'tool_arguments_truncated', args: {}, content: 'tool arguments were cut off by the provider output limit',
  });
  const constraints = mergeToolConstraints([], [first]);
  assert.equal(constraints[0].kind, 'action_repair');
  assert.equal(constraints[0].occurrences, 1);
  assert.match(constraints[0].instruction, /immediate repair step[^]*optional thinking disabled[^]*smallest unique anchor[^]*Later steps may reason normally/iu);
  assert.equal(mergeToolConstraints(constraints, [item('fs.edit_text', 'succeeded')]).length, 1);

  const repeated = mergeToolConstraints(constraints, [item('fs.edit_text', 'invalid_request', {
    reason: 'tool_arguments_truncated', args: { path: 'different.js' }, content: 'truncated again',
  })]);
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].id, constraints[0].id);
  assert.equal(repeated[0].occurrences, 2);
});

test('governance constraints survive unrelated success and clear on new authority', () => {
  const denied = mergeToolConstraints([], [item('fs.write_text', 'deny_with_guidance', {
    reason: 'authenticated_intent_mismatch', content: 'The requested write is outside authenticated intent.',
  })]);
  assert.equal(denied[0].status, 'denied');
  assert.equal(denied[0].review_outcome, 'deny_with_guidance');
  assert.equal(mergeToolConstraints(denied, [item('fs.read_text', 'succeeded')]).length, 1);
  assert.deepEqual(clearAuthorityConstraints(denied), []);
});

test('machine-readable tool constraints remain in context beside a compacted transcript', () => {
  const constraints = mergeToolConstraints([], [item('shell.run', 'failed', {
    reason: 'process_exit_nonzero', metadata: { exitCode: 1, signal: null },
  })]);
  const context = buildContext({
    workspaceRoot: process.cwd(), limits: { maxContextBytes: 1_048_576 }, executionManifest: null,
  }, [{ type: 'compaction', summary: 'Older active records were compacted.', retainedRecords: [] }], '', { toolConstraints: constraints });
  const message = context.find((entry) => entry.provenance === 'active_tool_constraints');
  assert.match(message.content, /"kind":"execution_failure"/u);
  assert.match(message.content, /process exited 1/u);
  assert.doesNotMatch(message.content, /request_fingerprint/u);
  assert.match(message.content, /context reduction/u);
});

test('unavailable shell constraints retain the interpreter-specific repair across continuations', () => {
  const constraints = mergeToolConstraints([], [item('shell.run', 'failed', {
    reason: 'shell_interpreter_unavailable',
    args: { shell: 'sh', script: 'printf ok' },
    content: 'The requested shell interpreter sh is unavailable on this Windows (win32) host. Use shell auto with PowerShell syntax. Do not repeat shell sh.',
  })]);
  assert.match(constraints[0].detail, /interpreter sh is unavailable.*Use shell auto with PowerShell syntax/u);
  assert.match(constraints[0].instruction, /Do not repeat the unavailable shell/u);
  assert.match(constraints[0].instruction, /positively discovered/u);
});

test('failed inline interpreter constraints recommend draft stdin instead of repeated escaping', () => {
  const constraints = mergeToolConstraints([], [item('process.run', 'failed', {
    reason: 'process_exit_nonzero', metadata: { exitCode: 1, signal: null },
    args: { executable: 'node', args: ['-e', 'const child = "nested"; process.exit(1)'] },
  })]);
  assert.match(constraints[0].instruction, /Avoid embedding generated multi-statement programs/u);
  assert.match(constraints[0].instruction, /ref\.store.*stdin_ref/u);
});

test('missing directory ancestors become durable prerequisites cleared by structured existence proof', () => {
  const missing = item('fs.write_text', 'invalid_request', {
    reason: 'tool_parent_missing', args: { path: 'src/shaders/ocean.js', content: 'shader' },
    content: 'parent directory is missing; create exactly this directory first with fs.directory: "src"\nCall fs.directory with action create; it creates the complete path and missing ancestors recursively.',
  });
  const constraints = mergeToolConstraints([], [missing]);
  assert.equal(constraints[0].kind, 'prerequisite_repair');
  assert.equal(constraints[0].required_tool, 'fs.directory');
  assert.equal(constraints[0].required_path, 'src');
  assert.match(constraints[0].instruction, /Repair the missing ancestor[^]*"src"[^]*do not retry descendant[^]*verify the exact path/iu);

  assert.equal(mergeToolConstraints(constraints, [item('fs.list', 'succeeded', { args: { path: '.' } })]).length, 1);
  assert.deepEqual(mergeToolConstraints(constraints, [item('fs.directory', 'succeeded', { args: { action: 'create', path: 'src' } })]), []);
  assert.deepEqual(mergeToolConstraints(constraints, [item('fs.list', 'succeeded', { args: { path: 'src' } })]), []);
  assert.deepEqual(mergeToolConstraints(constraints, [item('fs.write_text', 'succeeded', {
    args: { path: 'src/main.js', content: 'created' },
  })]), []);
  assert.equal(mergeToolConstraints(constraints, [item('fs.write_text', 'succeeded', {
    args: { path: 'other/main.js', content: 'created' },
  })]).length, 1);

  const siblingFailure = item('fs.directory', 'invalid_request', {
    reason: 'tool_parent_missing', args: { action: 'create', path: 'src/shaders' }, content: missing.result.content,
  });
  assert.equal(mergeToolConstraints([], [missing, siblingFailure]).length, 1);
  assert.deepEqual(mergeToolConstraints([], [missing, item('fs.directory', 'succeeded', { args: { action: 'create', path: 'src' } })]), []);
});
