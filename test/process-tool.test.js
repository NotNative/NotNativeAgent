// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tool-registry.js';
import { shellInvocation } from '../src/process-tool.js';

test('process.run executes bounded shell-free argv inside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-process-'));
  await writeFile(join(root, 'print.js'), "process.stdout.write('process-ok')\n");
  const registry = new ToolRegistry(root);
  await registry.initialize();
  const definition = registry.definition('process.run');
  assert.deepEqual(definition.inputSchema.properties.args.items, { type: 'string' });
  await assert.rejects(definition.validate({ executable: 'node', args: ['x'.repeat(4097)] }), { code: 'process_args_invalid' });
  const normalized = await definition.validate({ executable: 'node', args: ['print.js'], timeout_ms: 5_000 });
  const canonicalRoot = await realpath(root);
  assert.equal(normalized.resolved.shell, false);
  assert.equal(normalized.resolved.reviewComplexity, 'simple_argv');
  assert.equal(normalized.resolved.reviewPurpose, null);
  assert.equal(normalized.args.cwd, canonicalRoot);
  const result = await definition.executor({ args: normalized.args }, new AbortController().signal);
  const output = JSON.parse(result.content);
  assert.equal(output.exit_code, 0);
  assert.equal(output.stdout, 'process-ok');
  assert.equal(result.metadata.shell, false);
});

test('AC-FAIL-07 process timeout returns promptly after requesting tree termination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-process-timeout-'));
  await writeFile(join(root, 'wait.js'), "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);", 'utf8');
  const registry = new ToolRegistry(root);
  await registry.initialize();
  const definition = registry.definition('process.run');
  const normalized = await definition.validate({ executable: 'node', args: ['wait.js'], timeout_ms: 100 });
  const started = performance.now();
  await assert.rejects(
    definition.executor({ args: normalized.args }, new AbortController().signal),
    { code: 'tool_timeout' },
  );
  assert.ok(performance.now() - started < 1_000);
});

test('AC-AUTH-04 process.run seals shells and destructive commands for semantic review instead of hard-blocking them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-process-policy-'));
  const registry = new ToolRegistry(root);
  await registry.initialize();
  const definition = registry.definition('process.run');
  assert.equal((await definition.validate({ executable: 'rm', args: ['-rf', '.'] })).resolved.reviewComplexity, 'destructive_command');
  assert.equal((await definition.validate({ executable: 'powershell', args: ['-Command', 'dir'] })).resolved.reviewComplexity, 'shell_command');
  assert.equal((await definition.validate({ executable: 'node', args: ['-e', 'process.exit()'] })).resolved.reviewComplexity, 'inline_code');
  assert.equal((await definition.validate({ executable: 'git', args: ['reset', '--hard'] })).resolved.reviewComplexity, 'destructive_command');
  await assert.rejects(definition.validate({ executable: 'npm', args: ['--token=secret-value'] }), { code: 'process_secret_argument_forbidden' });
  assert.equal((await definition.validate({ executable: 'node', args: ['file.js'], cwd: '..' })).resolved.insideWorkspace, false);
  const hosted = new ToolRegistry(root, { boundedToWorkspace: true });
  await hosted.initialize();
  await assert.rejects(hosted.definition('process.run').validate({ executable: 'node', args: ['file.js'], cwd: '..' }), { code: 'tool_scope_denied' });
  assert.equal((await definition.validate({ executable: 'npm', args: ['run', 'build'] })).resolved.reviewComplexity, 'opaque_package_script');
  assert.equal((await definition.validate({ executable: 'rg', args: ['TODO.*unsafe'] })).resolved.reviewComplexity, 'interpreted_pattern');
  assert.equal((await definition.validate({ executable: 'ping', args: ['-n', '3', '192.0.2.15'] })).resolved.reviewPurpose, 'network_diagnostic');
  assert.equal((await definition.validate({
    executable: 'powershell.exe', args: ['-Command', 'Test-Connection -ComputerName 192.0.2.15 -Count 3'],
  })).resolved.reviewPurpose, 'network_diagnostic');
  assert.equal((await definition.validate({
    executable: 'powershell.exe', args: ['-Command', 'Test-Connection fixture-host; Remove-Item target.txt'],
  })).resolved.reviewPurpose, null);
});

test('AC-SEC-05 process execution receives a minimal environment without inherited secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-process-environment-'));
  await writeFile(join(root, 'environment.js'), "process.stdout.write(JSON.stringify({secret:process.env.NNA_TEST_SECRET??null,path:Boolean(process.env.PATH||process.env.Path)}))\n");
  const previous = process.env.NNA_TEST_SECRET;
  process.env.NNA_TEST_SECRET = 'must-not-reach-child';
  try {
    const registry = new ToolRegistry(root);
    await registry.initialize();
    const definition = registry.definition('process.run');
    const normalized = await definition.validate({ executable: 'node', args: ['environment.js'] });
    const result = await definition.executor({ args: normalized.args }, new AbortController().signal);
    assert.deepEqual(JSON.parse(JSON.parse(result.content).stdout), { secret: null, path: true });
  } finally {
    if (previous === undefined) delete process.env.NNA_TEST_SECRET;
    else process.env.NNA_TEST_SECRET = previous;
  }
});

test('shell.run owns platform interpreter argv and executes a readable reviewed script', async () => {
  assert.deepEqual(shellInvocation('auto', 'Write-Output ok', 'win32'), {
    shell: 'powershell', executable: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'Write-Output ok'],
  });
  assert.deepEqual(shellInvocation('auto', 'printf ok', 'linux'), {
    shell: 'sh', executable: 'sh', args: ['-c', 'printf ok'],
  });
  const root = await mkdtemp(join(tmpdir(), 'nna-shell-'));
  const registry = new ToolRegistry(root);
  await registry.initialize();
  const definition = registry.definition('shell.run');
  const script = process.platform === 'win32' ? "[Console]::Write('shell-ok')" : "printf 'shell-ok'";
  const normalized = await definition.validate({ script, timeout_ms: 5_000 });
  assert.equal(normalized.resolved.shell, process.platform === 'win32' ? 'powershell' : 'sh');
  assert.equal(normalized.resolved.reviewComplexity, 'simple_shell');
  const result = await definition.executor({ args: normalized.args }, new AbortController().signal);
  assert.equal(JSON.parse(result.content).stdout, 'shell-ok');
  assert.equal(result.metadata.shell, normalized.resolved.shell);
});

test('shell.run classifies compound and destructive scripts for semantic review and stays out of hosted sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-shell-policy-'));
  const registry = new ToolRegistry(root);
  await registry.initialize();
  const definition = registry.definition('shell.run');
  assert.equal((await definition.validate({ script: 'git status; npm test' })).resolved.reviewComplexity, 'compound_shell');
  assert.equal((await definition.validate({ script: 'git reset --hard' })).resolved.reviewComplexity, 'destructive_shell');
  assert.equal((await definition.validate({ script: 'Resolve-DnsName fixture-host' })).resolved.reviewPurpose, 'network_diagnostic');
  await assert.rejects(definition.validate({ script: 'curl -H "Authorization: Bearer literal" example.test' }), { code: 'shell_secret_argument_forbidden' });
  const hosted = new ToolRegistry(root, { hosted: true, boundedToWorkspace: true, allowedTools: ['shell.run'] });
  await hosted.initialize();
  assert.equal(hosted.definition('shell.run'), undefined);
});
