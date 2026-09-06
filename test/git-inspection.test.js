// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { gitInspectionDefinition } from '../src/tools/git-inspection.js';

test('git_inspect validates a host path and runs bounded shell-free status', async () => {
  const invocations = [];
  const definition = gitInspectionDefinition({
    resolveDirectory: async (path) => ({ path: `D:\\repos\\${path}`, insideWorkspace: false }),
  }, { spawnProcess: (executable, args, options) => {
    invocations.push({ executable, args, options });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => undefined;
    queueMicrotask(() => {
      child.stdout.write(args.includes('rev-parse') ? '.git\n' : '## main\n M src/a.js\n');
      child.stdout.end(); child.stderr.end(); child.emit('close', 0);
    });
    return child;
  } });
  const request = await definition.validate({ path: 'sample', operation: 'status' });
  const result = await definition.executor(request, new AbortController().signal);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].executable, 'git');
  assert.equal(invocations[0].options.shell, false);
  assert.deepEqual(invocations[0].args.slice(-2), ['rev-parse', '--git-dir']);
  assert.deepEqual(invocations[1].args.slice(-4), ['status', '--short', '--branch', '--untracked-files=normal']);
  assert.match(result.content, /M src\/a\.js/u);
  assert.equal(result.metadata.operation, 'status');
  assert.equal(result.metadata.is_repository, true);
});

test('git_inspect reports a non-repository as a successful negative observation', async () => {
  let invocations = 0;
  const definition = gitInspectionDefinition({
    resolveDirectory: async (path) => ({ path, insideWorkspace: true }),
  }, { spawnProcess: () => {
    invocations += 1;
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => undefined;
    queueMicrotask(() => {
      child.stderr.write('fatal: not a git repository (or any of the parent directories): .git\n');
      child.stdout.end(); child.stderr.end(); child.emit('close', 128);
    });
    return child;
  } });
  const request = await definition.validate({ path: 'ordinary-directory', operation: 'status' });
  const result = await definition.executor(request, new AbortController().signal);
  assert.equal(invocations, 1);
  assert.equal(result.content, 'The target directory is not a Git repository.');
  assert.deepEqual({
    target_exists: result.metadata.target_exists,
    is_repository: result.metadata.is_repository,
    observation_outcome: result.metadata.observation_outcome,
    exit_code: result.metadata.exit_code,
  }, {
    target_exists: true, is_repository: false,
    observation_outcome: 'target_not_git_repository', exit_code: 128,
  });
});

test('git_inspect preserves unexpected repository probe failures', async () => {
  const definition = gitInspectionDefinition({
    resolveDirectory: async (path) => ({ path, insideWorkspace: true }),
  }, { spawnProcess: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => undefined;
    queueMicrotask(() => {
      child.stderr.write('fatal: detected dubious ownership in repository\n');
      child.stdout.end(); child.stderr.end(); child.emit('close', 128);
    });
    return child;
  } });
  const request = await definition.validate({ path: 'unsafe-repository', operation: 'status' });
  await assert.rejects(definition.executor(request, new AbortController().signal), {
    code: 'git_repository_unavailable', message: 'The target Git repository could not be inspected',
  });
});

test('git_inspect constructs only enumerated history and staged-diff operations', async () => {
  const definition = gitInspectionDefinition({ resolveDirectory: async () => ({ path: 'repo', insideWorkspace: true }) });
  const history = await definition.validate({ operation: 'log', max_entries: 7 });
  const staged = await definition.validate({ operation: 'diff_staged' });
  assert.equal(history.args.max_entries, 7);
  assert.equal(staged.args.operation, 'diff_staged');
  await assert.rejects(() => definition.validate({ operation: 'push' }), { code: 'git_inspection_invalid' });
});
