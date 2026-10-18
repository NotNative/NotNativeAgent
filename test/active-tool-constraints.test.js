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

test('path failures give reason-specific repair guidance instead of schema repair', () => {
  const cases = [
    ['tool_path_ambiguous', 'drive-relative root paths are not permitted', /absolute path/u],
    ['tool_parent_invalid', 'an existing path ancestor is not a directory', /existing ancestor/u],
    ['tool_path_reparse_unresolved', 'path contains an unresolved reparse point', /unresolved link/u],
    ['tool_target_invalid', 'target is not a directory', /wrong filesystem type/u],
  ];
  for (const [reason, content, guidance] of cases) {
    const [constraint] = mergeToolConstraints([], [item('fs_directory', 'invalid_request', {
      reason, args: { action: 'create', path: 'bad' }, content,
    })]);
    assert.equal(constraint.kind, 'path_repair');
    assert.match(constraint.instruction, guidance);
    assert.doesNotMatch(constraint.instruction, /Rebuild the call from the currently presented schema/u);
  }
});

test('process constraints carry structured exit, signal, and timeout evidence', () => {
  const cases = [
    ['completed_nonzero', { exitCode: 7, signal: null }, 'exit_code', 7, null],
    ['failed', { exitCode: null, signal: 'SIGKILL' }, 'signal', null, 'SIGKILL'],
    ['timed_out', { exitCode: null, signal: null }, 'timeout', null, null],
  ];
  for (const [status, metadata, kind, exitCode, signal] of cases) {
    const [constraint] = mergeToolConstraints([], [item('process_run', status, {
      reason: status === 'completed_nonzero' ? 'process_exit_nonzero' : 'process_signal_exit', metadata,
    })]);
    assert.deepEqual(constraint.termination, { kind, exit_code: exitCode, signal });
  }
});

test('path constraints retain distinct targets and clear only after a same-target success', () => {
  const workspaceRoot = resolve('alternate-workspace');
  const failed = (path) => item('fs_directory', 'invalid_request', {
    reason: 'tool_target_invalid', args: { action: 'create', path }, content: 'target is not a directory',
  });
  const initial = mergeToolConstraints([], [failed('a'), failed('b')], { workspaceRoot });
  assert.deepEqual(initial.map((constraint) => constraint.target_path), ['a', 'b']);
  const unrelated = mergeToolConstraints(initial, [item('fs_directory', 'succeeded', {
    args: { action: 'create', path: 'c' },
  })], { workspaceRoot });
  assert.equal(unrelated.length, 2);
  const repaired = mergeToolConstraints(unrelated, [item('fs_directory', 'succeeded', {
    args: { action: 'create', path: join(workspaceRoot, 'a') },
  })], { workspaceRoot });
  assert.deepEqual(repaired.map((constraint) => constraint.target_path), ['b']);
});

test('a successful missing-target observation does not clear a path constraint', () => {
  const failed = mergeToolConstraints([], [item('fs_list', 'invalid_request', {
    reason: 'tool_path_reparse_unresolved', args: { path: 'broken-link' },
  })]);
  const missing = item('fs_list', 'succeeded', { args: { path: 'broken-link' },
    metadata: { target_exists: false } });
  assert.equal(mergeToolConstraints(failed, [missing]).length, 1);
  const exists = item('fs_list', 'succeeded', { args: { path: 'broken-link' },
    metadata: { target_exists: true } });
  assert.deepEqual(mergeToolConstraints(failed, [exists]), []);
});

test('directory action and target existence must both satisfy the failed path operation', () => {
  const failedCreate = mergeToolConstraints([], [item('fs_directory', 'invalid_request', {
    reason: 'tool_target_invalid', args: { action: 'create', path: 'target' },
  })]);
  const removed = item('fs_directory', 'succeeded', { args: { action: 'remove', path: 'target' } });
  assert.equal(mergeToolConstraints(failedCreate, [removed]).length, 1);
  const listed = item('fs_directory', 'succeeded', { args: { action: 'list', path: 'target' },
    metadata: { target_exists: true } });
  assert.equal(mergeToolConstraints(failedCreate, [listed]).length, 1);
  const created = item('fs_directory', 'succeeded', { args: { action: 'create', path: 'target' } });
  assert.deepEqual(mergeToolConstraints(failedCreate, [created]), []);

  const failedList = mergeToolConstraints([], [item('fs_directory', 'invalid_request', {
    reason: 'tool_path_reparse_unresolved', args: { action: 'list', path: 'target' },
  })]);
  const missingList = item('fs_directory', 'succeeded', { args: { action: 'list', path: 'target' },
    metadata: { target_exists: false } });
  assert.equal(mergeToolConstraints(failedList, [missingList]).length, 1);
  assert.deepEqual(mergeToolConstraints(failedList, [listed]), []);
});

test('read-only path probes use their own existence contracts', () => {
  const failedMetadata = mergeToolConstraints([], [item('fs_metadata', 'invalid_request', {
    reason: 'tool_path_reparse_unresolved', args: { path: 'target' },
  })]);
  assert.equal(mergeToolConstraints(failedMetadata, [item('fs_metadata', 'succeeded', {
    args: { path: 'target' }, metadata: { target_exists: false },
  })]).length, 1);
  assert.deepEqual(mergeToolConstraints(failedMetadata, [item('fs_metadata', 'succeeded', {
    args: { path: 'target' }, metadata: { target_exists: true },
  })]), []);
  const failedDirectory = mergeToolConstraints([], [item('fs_list_directory', 'invalid_request', {
    reason: 'tool_directory_not_found', args: { path: 'target' },
  })]);
  assert.deepEqual(mergeToolConstraints(failedDirectory, [item('fs_list_directory', 'succeeded', {
    args: { path: 'target' },
  })]), []);
});

test('path failures without a usable target coalesce and clear on same-tool repair', () => {
  const empty = item('fs_read', 'invalid_request', {
    reason: 'tool_path_invalid', args: { path: '' }, content: 'path is invalid',
  });
  const omitted = item('fs_read', 'invalid_request', {
    reason: 'tool_path_invalid', args: {}, content: 'path is invalid',
  });
  const constraints = mergeToolConstraints([], [empty, omitted]);
  assert.equal(constraints.length, 1);
  assert.equal(constraints[0].target_path, undefined);
  assert.equal(mergeToolConstraints(constraints, [item('fs_list', 'succeeded')]).length, 1);
  assert.deepEqual(mergeToolConstraints(constraints, [item('fs_read', 'succeeded', {
    args: { path: 'valid.txt' },
  })]), []);
  const succeededFirst = mergeToolConstraints([], [item('fs_read', 'succeeded', {
    args: { path: 'valid.txt' },
  }), empty]);
  assert.equal(succeededFirst.length, 1);
  const repairedLater = mergeToolConstraints([], [empty, item('fs_read', 'succeeded', {
    args: { path: 'valid.txt' },
  })]);
  assert.deepEqual(repairedLater, []);

  const directory = mergeToolConstraints([], [item('fs_directory', 'invalid_request', {
    reason: 'tool_path_invalid', args: { action: 'create', path: '' },
  })]);
  assert.equal(mergeToolConstraints(directory, [item('fs_directory', 'succeeded', {
    args: { action: 'remove', path: 'other' },
  })]).length, 1);
  assert.deepEqual(mergeToolConstraints(directory, [item('fs_directory', 'succeeded', {
    args: { action: 'create', path: 'valid' },
  })]), []);
});

test('unusable nonempty path shapes clear after a corrected path succeeds', () => {
  const cases = [
    ['tool_path_ambiguous', 'C:', 'fs_read'],
    ['tool_path_invalid', 'trailing.', 'fs_read'],
    ['tool_path_reserved', 'CON', 'fs_read'],
    ['tool_parent_invalid', 'file/child', 'fs_directory'],
    ['tool_path_reparse_unresolved', 'broken-link/child', 'fs_directory'],
  ];
  for (const [reason, rejectedPath, tool] of cases) {
    const failed = mergeToolConstraints([], [item(tool, 'invalid_request', {
      reason, args: { path: rejectedPath, ...(tool === 'fs_directory' ? { action: 'create' } : {}) },
    })]);
    assert.equal(failed[0].target_path, undefined, reason);
    assert.deepEqual(mergeToolConstraints(failed, [item(tool, 'succeeded', {
      args: { path: 'corrected', ...(tool === 'fs_directory' ? { action: 'create' } : {}) },
    })]), [], reason);
  }
});

test('untrusted process signal text cannot enter model-facing constraints', () => {
  const [constraint] = mergeToolConstraints([], [item('process_run', 'failed', {
    reason: 'process_signal_exit', metadata: { signal: 'SIGKILL secret=operator-key', exitCode: null },
  })]);
  assert.equal(constraint.termination.kind, 'unknown');
  assert.equal(constraint.termination.signal, null);
  assert.doesNotMatch(JSON.stringify(constraint), /operator-key/u);
});

test('output overflow is identified before secondary process exit evidence', () => {
  const [constraint] = mergeToolConstraints([], [item('process_run', 'failed', {
    reason: 'process_output_too_large', metadata: { exitCode: 0, signal: 'SIGTERM' },
  })]);
  assert.deepEqual(constraint.termination, { kind: 'output_limit', exit_code: 0, signal: 'SIGTERM' });
  assert.match(constraint.detail, /output exceeded the capture limit/u);
  assert.match(constraint.instruction, /Narrow the query/u);
});
