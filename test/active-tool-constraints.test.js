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
  assert.match(constraints[0].request_fingerprint, /^[0-9a-f]{64}$/u);
  assert.match(constraints[0].instruction, /do not repeat/u);
  assert.deepEqual(mergeToolConstraints(constraints, [item('fs.search_text', 'succeeded')]), []);
});

test('governance constraints survive unrelated success and clear on new authority', () => {
  const denied = mergeToolConstraints([], [item('fs.write_text', 'deny_with_guidance', {
    reason: 'authenticated_intent_mismatch', content: 'The requested write is outside authenticated intent.',
  })]);
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

test('missing directory ancestors become exact durable prerequisites cleared only by their repair', () => {
  const missing = item('fs.write_text', 'invalid_request', {
    reason: 'tool_parent_missing', args: { path: 'src/shaders/ocean.js', content: 'shader' },
    content: 'parent directory is missing; create exactly this directory first with fs.create_directory: "src"\nfs.create_directory creates only one directory level and never creates missing ancestors recursively.',
  });
  const constraints = mergeToolConstraints([], [missing]);
  assert.equal(constraints[0].kind, 'prerequisite_repair');
  assert.equal(constraints[0].required_tool, 'fs.create_directory');
  assert.equal(constraints[0].required_path, 'src');
  assert.match(constraints[0].instruction, /next filesystem mutation[^]*"src"[^]*Do not retry descendant[^]*read-only inspection/iu);

  assert.equal(mergeToolConstraints(constraints, [item('fs.list_directory', 'succeeded', { args: { path: '.' } })]).length, 1);
  assert.deepEqual(mergeToolConstraints(constraints, [item('fs.create_directory', 'succeeded', { args: { path: 'src' } })]), []);

  const siblingFailure = item('fs.create_directory', 'invalid_request', {
    reason: 'tool_parent_missing', args: { path: 'src/shaders' }, content: missing.result.content,
  });
  assert.equal(mergeToolConstraints([], [missing, siblingFailure]).length, 1);
  assert.deepEqual(mergeToolConstraints([], [missing, item('fs.create_directory', 'succeeded', { args: { path: 'src' } })]), []);
});
