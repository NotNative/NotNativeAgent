// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tool-registry.js';
import { operationalEnvironment, shellInvocation, shellRunDefinition } from '../src/tools/process.js';
import { toolProgressEvidence } from '../src/tools/loop.js';

test('process.run executes bounded shell-free argv inside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-process-'));
  await writeFile(join(root, 'print.js'), "process.stdout.write('process-ok')\n");
  const registry = new ToolRegistry(root);
  await registry.initialize();
  const definition = registry.definition('process.run');
  assert.match(definition.purpose, /Avoid embedding generated multi-statement programs/u);
  assert.match(definition.inputSchema.properties.stdin_ref.description, /node args \["-"\]/u);
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

test('AC-FAIL-07 Windows process timeout terminates descendants', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-process-tree-'));
  await writeFile(join(root, 'parent.js'), [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });",
    "writeFileSync('grandchild.pid', String(child.pid));",
    'setInterval(()=>{},1000);',
  ].join('\n'));
  const registry = new ToolRegistry(root); await registry.initialize();
  const definition = registry.definition('process.run');
  const normalized = await definition.validate({ executable: 'node', args: ['parent.js'], timeout_ms: 500 });
  let pid = null;
  try {
    await assert.rejects(definition.executor({ args: normalized.args }, new AbortController().signal), { code: 'tool_timeout' });
    pid = Number(await readFile(join(root, 'grandchild.pid'), 'utf8'));
    await waitForProcessExit(pid, 3_000);
  } finally {
    if (Number.isInteger(pid) && processExists(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
    await registry.close();
  }
});

test('unexpected nonzero process exits preserve diagnostics as completed unsuccessful evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-process-failure-'));
  await writeFile(join(root, 'fail.js'), "process.stdout.write('partial output');process.stderr.write('diagnostic');process.exitCode=7;\n");
  const registry = new ToolRegistry(root);
  await registry.initialize();
  const definition = registry.definition('process.run');
  const normalized = await definition.validate({ executable: 'node', args: ['fail.js'] });
  const result = await definition.executor({ args: normalized.args }, new AbortController().signal);
  const output = JSON.parse(result.content);
  assert.equal(result.status, 'completed_nonzero');
  assert.equal(result.reasonCode, 'process_exit_nonzero');
  assert.deepEqual(result.metadata, { exitCode: 7, signal: null, acceptedExitCodes: [0], shell: false });
  assert.equal(output.stdout, 'partial output');
  assert.equal(output.stderr, 'diagnostic');
  assert.equal(toolProgressEvidence([{ request: normalized, result }]), null);
});

test('process tools accept only explicit bounded exit-code protocols containing zero', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-process-exit-codes-'));
  await writeFile(join(root, 'predicate.js'), 'process.exitCode=1;\n');
  const registry = new ToolRegistry(root); await registry.initialize();
  const definition = registry.definition('process.run');
  await assert.rejects(definition.validate({ executable: 'node', accepted_exit_codes: [1] }), { code: 'process_exit_codes_invalid' });
  await assert.rejects(definition.validate({ executable: 'node', accepted_exit_codes: [0, 0] }), { code: 'process_exit_codes_invalid' });
  await assert.rejects(definition.validate({ executable: 'node', accepted_exit_codes: [0, 256] }), { code: 'tool_schema_invalid' });
  const normalized = await definition.validate({ executable: 'node', args: ['predicate.js'], accepted_exit_codes: [0, 1] });
  const result = await definition.executor({ args: normalized.args }, new AbortController().signal);
  assert.equal(result.status, undefined);
  assert.deepEqual(result.metadata.acceptedExitCodes, [0, 1]);
  assert.equal(JSON.parse(result.content).exit_code, 1);
});

test('process.run consumes exact draft stdin without filesystem staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-process-stdin-ref-'));
  const registry = new ToolRegistry(root);
  await registry.initialize();
  const store = registry.definition('ref.store');
  const stored = await store.executor(
    await store.validate({ kind: 'draft', value: "process.stdout.write('stdin-ref-ok')\n" }),
    new AbortController().signal,
  );
  const stdinRef = JSON.parse(stored.content).reference;
  const processTool = registry.definition('process.run');
  const normalized = await processTool.validate({ executable: 'node', args: ['-'], stdin_ref: stdinRef });
  assert.equal(Object.hasOwn(normalized.args, 'stdin'), false);
  assert.equal(normalized.args.stdin_ref, stdinRef);
  const result = await processTool.executor({ args: normalized.args }, new AbortController().signal);
  assert.equal(JSON.parse(result.content).stdout, 'stdin-ref-ok');
  await assert.rejects(processTool.validate({ executable: 'node', args: ['-'], stdin_ref: 'nna_ref_draft_missing' }), {
    code: 'reference_missing',
  });
});

test('AC-AUTH-04 process.run seals shells and destructive commands for semantic review instead of hard-blocking them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-process-policy-'));
  const registry = new ToolRegistry(root);
  await registry.initialize();
  const definition = registry.definition('process.run');
  assert.equal((await definition.validate({ executable: 'rm', args: ['-rf', '.'] })).resolved.reviewComplexity, 'destructive_command');
  assert.equal((await definition.validate({ executable: 'powershell', args: ['-Command', 'dir'] })).resolved.reviewComplexity, 'shell_command');
  assert.equal((await definition.validate({ executable: 'node', args: ['-e', 'process.exit()'] })).resolved.reviewComplexity, 'inline_code');
  assert.deepEqual((await definition.validate({ executable: 'node', args: ['-e', 'process.exit()'] })).resolved.reliabilitySignals, ['inline_interpreter_code']);
  assert.deepEqual((await definition.validate({ executable: 'node', args: ['-'] })).resolved.reliabilitySignals, []);
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

test('AC-SEC-05 process execution receives an operational environment without inherited secrets', async () => {
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

test('operational child environment retains host discovery without forwarding arbitrary credentials', () => {
  const environment = operationalEnvironment({
    PATH: '/bin', HOME: '/home/operator', ProgramData: 'C:\\ProgramData', APPDATA: 'C:\\Users\\operator\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\operator\\AppData\\Local', PSModulePath: 'C:\\Modules',
    SSH_AUTH_SOCK: '/run/user/1000/agent', NNA_PROVIDER_KEY: 'provider-secret',
    AWS_SECRET_ACCESS_KEY: 'cloud-secret', GIT_ASKPASS: 'credential-helper', RANDOM_PARENT_VALUE: 'private',
  });
  assert.deepEqual(environment, {
    PATH: '/bin', ProgramData: 'C:\\ProgramData', PSModulePath: 'C:\\Modules', HOME: '/home/operator',
    APPDATA: 'C:\\Users\\operator\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\operator\\AppData\\Local',
    SSH_AUTH_SOCK: '/run/user/1000/agent',
  });
});

test('Windows OpenSSH initializes under the operational child environment', async (context) => {
  if (process.platform !== 'win32') return context.skip('Windows-only regression');
  const executable = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
  try { await access(executable); } catch { return context.skip('Windows OpenSSH is not installed'); }
  const root = await mkdtemp(join(tmpdir(), 'nna-openssh-environment-'));
  const registry = new ToolRegistry(root);
  await registry.initialize();
  const definition = registry.definition('process.run');
  const normalized = await definition.validate({ executable, args: ['-V'], timeout_ms: 5_000 });
  const result = JSON.parse((await definition.executor({ args: normalized.args }, new AbortController().signal)).content);
  assert.equal(result.exit_code, 0);
  assert.match(result.stderr, /OpenSSH_for_Windows/u);
});

test('shell.run owns platform interpreter argv and executes a readable reviewed script', async () => {
  assert.match(shellRunDefinition(null, null, 'win32').purpose, /Windows \(win32\).*Windows PowerShell 5\.1/u);
  assert.match(shellRunDefinition(null, null, 'linux').purpose, /Linux \(linux\).*POSIX sh/u);
  assert.match(shellRunDefinition(null, null, 'darwin').purpose, /macOS \(darwin\).*POSIX sh/u);
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
  assert.match(definition.purpose, new RegExp(`This host is .* \\(${process.platform}\\)`, 'u'));
  assert.match(definition.inputSchema.properties.shell.description, /Prefer auto/u);
  assert.match(definition.inputSchema.properties.script.description, /does not translate syntax/u);
  const script = process.platform === 'win32' ? "[Console]::Write('shell-ok')" : "printf 'shell-ok'";
  const normalized = await definition.validate({ script, timeout_ms: 5_000 });
  assert.equal(normalized.resolved.shell, process.platform === 'win32' ? 'powershell' : 'sh');
  assert.equal(normalized.resolved.reviewComplexity, 'simple_shell');
  const result = await definition.executor({ args: normalized.args }, new AbortController().signal);
  assert.equal(JSON.parse(result.content).stdout, 'shell-ok');
  assert.equal(result.metadata.shell, normalized.resolved.shell);
});

test('shell.run reports completed nonzero when earlier compound-script effects occurred', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-shell-partial-effect-'));
  const registry = new ToolRegistry(root); await registry.initialize();
  const definition = registry.definition('shell.run');
  const script = process.platform === 'win32'
    ? "[IO.File]::WriteAllText('partial.txt','done'); exit 9"
    : "printf done > partial.txt; exit 9";
  const normalized = await definition.validate({ script, timeout_ms: 5_000 });
  const result = await definition.executor({ args: normalized.args }, new AbortController().signal);
  assert.equal(result.status, 'completed_nonzero');
  assert.equal(result.reasonCode, 'process_exit_nonzero');
  assert.equal(result.metadata.exitCode, 9);
  assert.equal(await readFile(join(root, 'partial.txt'), 'utf8'), 'done');
  assert.equal(toolProgressEvidence([{ request: normalized, result }]), null);
});

test('Unix predicate commands can explicitly accept documented negative results', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-shell-predicates-'));
  await writeFile(join(root, 'first.txt'), 'first\n');
  await writeFile(join(root, 'second.txt'), 'second\n');
  const registry = new ToolRegistry(root); await registry.initialize();
  const definition = registry.definition('shell.run');
  for (const script of ["diff -q first.txt second.txt", "grep -q absent first.txt"]) {
    const normalized = await definition.validate({ script, accepted_exit_codes: [0, 1] });
    const result = await definition.executor({ args: normalized.args }, new AbortController().signal);
    assert.equal(result.status, undefined);
    assert.equal(JSON.parse(result.content).exit_code, 1);
  }
});

test('bash pipefail exposes and can explicitly classify an expected upstream SIGPIPE', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-shell-pipefail-'));
  const registry = new ToolRegistry(root); await registry.initialize();
  const definition = registry.definition('shell.run');
  const normalized = await definition.validate({
    script: 'set -o pipefail; yes value | head -n 1', shell: 'bash', accepted_exit_codes: [0, 141],
  });
  const result = await definition.executor({ args: normalized.args }, new AbortController().signal);
  assert.equal(result.status, undefined);
  assert.equal(JSON.parse(result.content).exit_code, 141);
});

test('shell.run classifies compound and destructive scripts for semantic review and stays out of hosted sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-shell-policy-'));
  const registry = new ToolRegistry(root);
  await registry.initialize();
  const definition = registry.definition('shell.run');
  assert.equal((await definition.validate({ script: 'git status; npm test' })).resolved.reviewComplexity, 'compound_shell');
  const fragile = await definition.validate({
    script: 'echo start; for f in a b; do printf "%s" "$(wc -l < "$f")"; done',
  });
  assert.equal(fragile.resolved.reviewComplexity, 'fragile_shell');
  assert.deepEqual(fragile.resolved.reliabilitySignals, ['many_operations', 'loop_with_substitution']);
  assert.equal((await definition.validate({ script: 'git reset --hard' })).resolved.reviewComplexity, 'destructive_shell');
  assert.equal((await definition.validate({ script: 'Resolve-DnsName fixture-host' })).resolved.reviewPurpose, 'network_diagnostic');
  await assert.rejects(definition.validate({ script: 'curl -H "Authorization: Bearer literal" example.test' }), { code: 'shell_secret_argument_forbidden' });
  const hosted = new ToolRegistry(root, { hosted: true, boundedToWorkspace: true, allowedTools: ['shell.run'] });
  await hosted.initialize();
  assert.equal(hosted.definition('shell.run'), undefined);
});

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(processExists(pid), false, `descendant process ${pid} remained live`);
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
