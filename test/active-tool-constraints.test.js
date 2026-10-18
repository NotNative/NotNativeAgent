// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildContext } from '../src/context.js';
import { clearAuthorityConstraints, mergeToolConstraints } from '../src/tools/active-constraints.js';

function item(tool, status, detail = {}) {
  return {
    call: { name: tool, args: detail.args ?? { path: 'target.txt' } },
    ...(detail.request ? { request: detail.request } : {}),
    result: {
      tool_name: tool, status, reason_code: detail.reason ?? status,
      content: detail.content ?? status, metadata: detail.metadata,
    },
  };
}

test('active constraints retain structured repairs and clear them after verified success', () => {
  const invalid = item('fs_search_text', 'invalid_request', {
    reason: 'tool_schema_invalid', content: 'argument "path" must be a directory; received a file',
  });
  const constraints = mergeToolConstraints([], [invalid]);
  assert.equal(constraints[0].kind, 'schema_repair');
  assert.equal(constraints[0].request_fingerprint, undefined);
  assert.match(constraints[0].instruction, /same invalid request shape/u);
  assert.match(constraints[0].instruction, /do not repeat/u);
  assert.deepEqual(mergeToolConstraints(constraints, [item('fs_search_text', 'succeeded')]), []);
});

test('truncated argument lesson persists while the immediate repair mode stays one-step', () => {
  const first = item('fs_edit_text', 'invalid_request', {
    reason: 'tool_arguments_truncated', args: {}, content: 'tool arguments were cut off by the provider output limit',
  });
  const constraints = mergeToolConstraints([], [first]);
  assert.equal(constraints[0].kind, 'action_repair');
  assert.equal(constraints[0].occurrences, 1);
  assert.match(constraints[0].instruction, /immediate repair step[^]*optional thinking disabled[^]*smallest unique anchor[^]*Later steps may reason normally/iu);
  assert.equal(mergeToolConstraints(constraints, [item('fs_edit_text', 'succeeded')]).length, 1);

  const repeated = mergeToolConstraints(constraints, [item('fs_edit_text', 'invalid_request', {
    reason: 'tool_arguments_truncated', args: { path: 'different.js' }, content: 'truncated again',
  })]);
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].id, constraints[0].id);
  assert.equal(repeated[0].occurrences, 2);
});

test('governance constraints survive unrelated success and clear on new authority', () => {
  const denied = mergeToolConstraints([], [item('fs_write_text', 'deny_with_guidance', {
    reason: 'authenticated_intent_mismatch', content: 'The requested write is outside authenticated intent.',
  })]);
  assert.equal(denied[0].status, 'denied');
  assert.equal(denied[0].review_outcome, 'deny_with_guidance');
  assert.equal(mergeToolConstraints(denied, [item('fs_read_text', 'succeeded')]).length, 1);
  assert.deepEqual(clearAuthorityConstraints(denied), []);
});

test('machine-readable tool constraints remain in context beside a compacted transcript', () => {
  const constraints = mergeToolConstraints([], [item('shell_run', 'failed', {
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
  const constraints = mergeToolConstraints([], [item('shell_run', 'failed', {
    reason: 'shell_interpreter_unavailable',
    args: { shell: 'sh', script: 'printf ok' },
    content: 'The requested shell interpreter sh is unavailable on this Windows (win32) host. Use shell auto with PowerShell syntax. Do not repeat shell sh.',
  })]);
  assert.match(constraints[0].detail, /interpreter sh is unavailable.*Use shell auto with PowerShell syntax/u);
  assert.match(constraints[0].instruction, /Do not repeat the unavailable shell/u);
  assert.match(constraints[0].instruction, /positively discovered/u);
});

test('failed inline interpreter constraints recommend draft stdin instead of repeated escaping', () => {
  const constraints = mergeToolConstraints([], [item('process_run', 'failed', {
    reason: 'process_exit_nonzero', metadata: { exitCode: 1, signal: null },
    args: { executable: 'node', args: ['-e', 'const child = "nested"; process.exit(1)'] },
  })]);
  assert.match(constraints[0].instruction, /Avoid embedding generated multi-statement programs/u);
  assert.match(constraints[0].instruction, /ref_store.*stdin_ref/u);
});

test('process repair guidance follows sealed arguments when raw call arguments differ', () => {
  const failed = item('process_run', 'failed', {
    reason: 'process_exit_nonzero', metadata: { exitCode: 1, signal: null },
    args: { executable: 'node', args: ['-e', 'process.exit(1)'] },
    request: { toolName: 'process_run', args: { executable: 'node', args: ['-'] } },
  });
  const [constraint] = mergeToolConstraints([], [failed]);
  assert.doesNotMatch(constraint.instruction, /Avoid embedding generated multi-statement programs/u);
});

test('missing directory ancestors become durable prerequisites cleared by structured existence proof', () => {
  const missing = item('fs_write_text', 'invalid_request', {
    reason: 'tool_parent_missing', args: { path: 'src/shaders/ocean.js', content: 'shader' },
    content: 'parent directory is missing; create exactly this directory first with fs_directory: "src"\nCall fs_directory with action create; it creates the complete path and missing ancestors recursively.',
  });
  const constraints = mergeToolConstraints([], [missing]);
  assert.equal(constraints[0].kind, 'prerequisite_repair');
  assert.equal(constraints[0].required_tool, 'fs_directory');
  assert.equal(constraints[0].required_path, 'src');
  assert.match(constraints[0].instruction, /Repair the missing ancestor[^]*"src"[^]*do not retry descendant[^]*verify the exact path/iu);

  assert.equal(mergeToolConstraints(constraints, [item('fs_list', 'succeeded', { args: { path: '.' } })]).length, 1);
  assert.deepEqual(mergeToolConstraints(constraints, [item('fs_directory', 'succeeded', { args: { action: 'create', path: 'src' } })]), []);
  assert.deepEqual(mergeToolConstraints(constraints, [item('fs_list', 'succeeded', {
    args: { path: 'src' }, request: { resolved: { kind: 'directory', path: resolve('src') } },
    metadata: { target_exists: true },
  })]), []);
  assert.deepEqual(mergeToolConstraints(constraints, [item('fs_write_text', 'succeeded', {
    args: { path: 'src/main.js', content: 'created' },
  })]), []);
  assert.equal(mergeToolConstraints(constraints, [item('fs_write_text', 'succeeded', {
    args: { path: 'other/main.js', content: 'created' },
  })]).length, 1);

  const siblingFailure = item('fs_directory', 'invalid_request', {
    reason: 'tool_parent_missing', args: { action: 'create', path: 'src/shaders' }, content: missing.result.content,
  });
  assert.equal(mergeToolConstraints([], [missing, siblingFailure]).length, 1);
  assert.deepEqual(mergeToolConstraints([], [missing, item('fs_directory', 'succeeded', { args: { action: 'create', path: 'src' } })]), []);
});

test('directory removal cannot satisfy a missing-parent prerequisite', () => {
  const missing = item('fs_write_text', 'invalid_request', {
    reason: 'tool_parent_missing', args: { path: 'src/main.js' },
    content: 'parent directory is missing; create exactly this directory first with fs_directory: "src"\nCreate the directory.',
  });
  const constraints = mergeToolConstraints([], [missing]);
  const removed = item('fs_directory', 'succeeded', { args: { action: 'remove', path: 'src' } });
  assert.equal(mergeToolConstraints(constraints, [removed]).length, 1);
  const listed = item('fs_directory', 'succeeded', {
    args: { action: 'list', path: 'src' }, request: { resolved: { kind: 'directory', path: resolve('src') } },
    metadata: { target_exists: true },
  });
  assert.deepEqual(mergeToolConstraints(constraints, [listed]), []);
});

test('a successful list result proves a directory only when the target exists and is a directory', () => {
  const missing = item('fs_write_text', 'invalid_request', {
    reason: 'tool_parent_missing', args: { path: 'src/main.js' },
    content: 'parent directory is missing; create exactly this directory first with fs_directory: "src"\nCreate the directory.',
  });
  const constraints = mergeToolConstraints([], [missing]);
  const absent = item('fs_list', 'succeeded', {
    args: { path: 'src' }, request: { resolved: { kind: 'missing', path: resolve('src') } },
    metadata: { target_exists: false, observation_outcome: 'target_not_found' },
  });
  const file = item('fs_list', 'succeeded', {
    args: { path: 'src' }, request: { resolved: { kind: 'file', path: resolve('src') } },
    metadata: { target_exists: true },
  });
  assert.equal(mergeToolConstraints(constraints, [absent]).length, 1);
  assert.equal(mergeToolConstraints(constraints, [file]).length, 1);
  assert.equal(mergeToolConstraints(constraints, [item('fs_directory', 'succeeded', {
    args: { action: 'list', path: 'src' }, request: { resolved: { kind: 'missing', path: resolve('src') } },
    metadata: { target_exists: false },
  })]).length, 1);
  assert.equal(mergeToolConstraints(constraints, [item('fs_list_directory', 'succeeded', {
    args: { path: 'src' }, request: { resolved: { path: resolve('src'), exists: false } },
  })]).length, 1);
  assert.deepEqual(mergeToolConstraints(constraints, [item('fs_list_directory', 'succeeded', {
    args: { path: 'src' }, request: { resolved: { path: resolve('src'), exists: true } },
  })]), []);
});

test('relative prerequisite proof uses the session workspace, not the process directory', () => {
  const missing = item('fs_write_text', 'invalid_request', {
    reason: 'tool_parent_missing', args: { path: 'src/main.js' },
    content: 'parent directory is missing; create exactly this directory first with fs_directory: "src"\nCreate the directory.',
  });
  const workspaceRoot = resolve(process.cwd(), '..', 'OtherWorkspace');
  const constraints = mergeToolConstraints([], [missing], { workspaceRoot });
  const workspaceProof = item('fs_list', 'succeeded', {
    args: { path: join(workspaceRoot, 'src') },
    request: { resolved: { kind: 'directory', path: join(workspaceRoot, 'src') } },
    metadata: { target_exists: true },
  });
  const unrelatedProof = item('fs_list', 'succeeded', {
    args: { path: join(process.cwd(), 'src') },
    request: { resolved: { kind: 'directory', path: join(process.cwd(), 'src') } },
    metadata: { target_exists: true },
  });
  assert.deepEqual(mergeToolConstraints(constraints, [workspaceProof], { workspaceRoot }), []);
  assert.equal(mergeToolConstraints(constraints, [unrelatedProof], { workspaceRoot }).length, 1);
});

test('constraint identity uses sealed request arguments when raw call arguments disagree', () => {
  const request = { toolName: 'fs_read', args: { path: 'src/a.js' } };
  const failed = item('fs_read', 'invalid_request', { reason: 'tool_schema_invalid', content: 'bad path' });
  failed.request = request;
  failed.call.args = { path: 'other.js' };
  const first = mergeToolConstraints([], [failed]);
  failed.call.args = { path: 'third.js' };
  const repeated = mergeToolConstraints(first, [failed]);
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].id, first[0].id);
  assert.equal(repeated[0].occurrences, 2);
});
