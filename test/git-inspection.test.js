// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { gitInspectionDefinition } from '../src/tools/git-inspection.js';

test('git.inspect validates a host path and runs bounded shell-free status', async () => {
  let invocation;
  const definition = gitInspectionDefinition({
    resolveDirectory: async (path) => ({ path: `D:\\repos\\${path}`, insideWorkspace: false }),
  }, { spawnProcess: (executable, args, options) => {
    invocation = { executable, args, options };
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => undefined;
    queueMicrotask(() => { child.stdout.write('## main\n M src/a.js\n'); child.stdout.end(); child.emit('close', 0); });
    return child;
  } });
  const request = await definition.validate({ path: 'sample', operation: 'status' });
  const result = await definition.executor(request, new AbortController().signal);
  assert.equal(invocation.executable, 'git');
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.args.slice(-4), ['status', '--short', '--branch', '--untracked-files=normal']);
  assert.match(result.content, /M src\/a\.js/u);
  assert.equal(result.metadata.operation, 'status');
});

test('git.inspect constructs only enumerated history and staged-diff operations', async () => {
  const definition = gitInspectionDefinition({ resolveDirectory: async () => ({ path: 'repo', insideWorkspace: true }) });
  const history = await definition.validate({ operation: 'log', max_entries: 7 });
  const staged = await definition.validate({ operation: 'diff_staged' });
  assert.equal(history.args.max_entries, 7);
  assert.equal(staged.args.operation, 'diff_staged');
  await assert.rejects(() => definition.validate({ operation: 'push' }), { code: 'git_inspection_invalid' });
});
