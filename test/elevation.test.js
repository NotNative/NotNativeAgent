// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ElevationBroker, elevationInvocation, elevationNotice } from '../src/elevation-broker.js';
import { runExact } from '../src/elevation-helper.js';
import { assertNonInteractiveElevation } from '../src/elevation-tool.js';
import { MandatoryReviewer } from '../src/reviewer.js';
import { ReviewerLedger } from '../src/persistence/reviewer-ledger.js';
import { ToolRegistry } from '../src/tool-registry.js';

test('system.elevate is an interactive root capability with exact resolved argv', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-elevation-tool-'));
  const broker = { execute: async () => ({ content: 'done' }) };
  const registry = new ToolRegistry(root, { elevationBroker: broker });
  await registry.initialize();
  const definition = registry.definition('system.elevate');
  assert.ok(definition);
  assert.equal(definition.operatorConfirmation, undefined);
  assert.equal(definition.timeoutMs, null);
  assert.equal(definition.cancellation, true);
  const normalized = await definition.validate({
    executable: process.execPath, args: ['--version'], reason: 'Verify the privileged runtime',
    expected_effect: 'Read and print the installed Node.js version', timeout_ms: 5_000,
  });
  assert.equal(normalized.args.executable, process.execPath);
  assert.equal(normalized.args.cwd, await realpath(root));
  assert.deepEqual(normalized.resolved.argv, ['--version']);
  await assert.rejects(definition.validate({
    executable: process.execPath, args: ['--token=literal'], reason: 'Run it', expected_effect: 'Print output',
  }), { code: 'elevation_secret_argument_forbidden' });

  const hosted = new ToolRegistry(root, {
    hosted: true, boundedToWorkspace: true, elevationBroker: broker, allowedTools: ['system.elevate'],
  });
  await hosted.initialize();
  assert.equal(hosted.definition('system.elevate'), undefined);
});

test('ordinary process tools reject native elevation launchers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-elevation-bypass-'));
  const registry = new ToolRegistry(root, { elevationBroker: { async execute() { return {}; } } });
  await registry.initialize();
  await assert.rejects(registry.definition('process.run').validate({
    executable: 'sudo', args: ['-n', 'docker', 'inspect', 'container'],
  }), { code: 'native_elevation_requires_system_tool' });
  await assert.rejects(registry.definition('shell.run').validate({
    script: 'echo ready; sudo -n docker inspect container', shell: 'sh',
  }), { code: 'native_elevation_requires_system_tool' });
  await assert.rejects(registry.definition('shell.run').validate({
    script: 'Start-Process powershell.exe -Verb RunAs -ArgumentList whoami', shell: 'powershell',
  }), { code: 'native_elevation_requires_system_tool' });
});

test('system.elevate rejects shell launchers that would open an interactive prompt', () => {
  assert.throws(() => assertNonInteractiveElevation('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', []), {
    code: 'elevation_interactive_shell_forbidden',
  });
  assert.throws(() => assertNonInteractiveElevation('/bin/sh', ['-l']), {
    code: 'elevation_interactive_shell_forbidden',
  });
  assert.doesNotThrow(() => assertNonInteractiveElevation('powershell.exe', ['-NoProfile', '-Command', 'Write-Output ok']));
  assert.doesNotThrow(() => assertNonInteractiveElevation('/bin/sh', ['-c', 'id']));
  assert.doesNotThrow(() => assertNonInteractiveElevation('/usr/bin/id', []));
});

test('Windows, Linux, and macOS elevation adapters use native UAC or sudo without a shell', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nna-elevation-platform-'));
  const broker = { nodePath: '/runtime/node', helperPath: '/runtime/elevation helper.js' };
  for (const platform of ['linux', 'darwin']) {
    const invocation = await elevationInvocation(platform, broker, directory, 'sealed-envelope');
    assert.equal(invocation.executable, '/usr/bin/sudo');
    assert.deepEqual(invocation.args, ['--', broker.nodePath, broker.helperPath, '--envelope', 'sealed-envelope']);
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.stdio, 'inherit');
  }
  const windowsBroker = {
    nodePath: 'C:\\Program Files\\nodejs\\node.exe', helperPath: 'C:\\Program Files\\NNA\\elevation-helper.js',
  };
  const windows = await elevationInvocation('win32', windowsBroker, directory, 'sealed-envelope');
  assert.match(windows.executable, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/iu);
  assert.equal(windows.options.shell, false);
  const script = await readFile(windows.args.at(-1), 'utf8');
  assert.match(script, /Start-Process/u);
  assert.match(script, /-Verb RunAs/u);
  assert.match(script, /-WindowStyle Hidden/u);
  assert.match(script, /elevation-helper\.js/u);
  await assert.rejects(elevationInvocation('aix', broker, directory, 'sealed-envelope'), { code: 'elevation_platform_unsupported' });
});

test('elevation notice shows the exact argv, working directory, and expected effect', () => {
  const notice = elevationNotice({ args: {
    executable: 'C:\\Windows\\powershell.exe', args: ['-Command', 'Write-Output ok'],
    cwd: 'C:\\work', expected_effect: 'Print ok',
  } });
  assert.match(notice, /"-Command" "Write-Output ok"/u);
  assert.match(notice, /Working directory: C:\\work/u);
  assert.match(notice, /Expected effect: Print ok/u);
});

test('native authentication cancellation records no elevated effect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-elevation-declined-'));
  const broker = new ElevationBroker({
    root,
    interactive: { async run() { return { cancelled: true, exitCode: 1, signal: null }; } },
  });
  const result = await broker.execute({
    id: 'declined-1', args: {
      executable: process.execPath, args: ['--version'], cwd: root, timeout_ms: 5_000,
      expected_effect: 'Print the installed Node.js version',
    },
  }, new AbortController().signal);
  assert.equal(result.status, 'failed');
  assert.equal(result.reasonCode, 'elevation_not_authorized');
  assert.equal(result.effectCertainty, 'none');
  assert.equal(result.metadata.elevated, false);
});

test('reviewer approval proceeds directly to native elevation', async () => {
  const request = Object.freeze({
    id: 'elevate-1', providerCallId: 'provider-elevate-1', toolName: 'system.elevate',
    args: { executable: '/usr/bin/mount', args: ['/dev/nvme1n1p2', '/mnt/windows'], cwd: '/tmp' },
    resolved: { path: '/usr/bin/mount', reviewComplexity: 'privileged_execution', reviewPurpose: 'host_elevation' },
    authorityId: 'authority-1', authorityVersion: 1, policyVersion: 1, definitionVersion: 1,
    caller: 'primary', expiresAt: Date.now() + 60_000,
  });
  const definition = {
    name: 'system.elevate', purpose: 'Elevate one exact command.', sideEffect: 'unknown', scope: 'host',
  };
  const reviewer = new MandatoryReviewer({
    ledger: new ReviewerLedger({ durable: false, sessionId: 'elevation-review' }),
    semanticReviewer: { async review() { return { outcome: 'approve', confidence: 1, reason_code: 'intent_match' }; } },
  });
  const decision = await reviewer.review(request, {
    authority: { id: 'authority-1', intent: [{ content: 'Mount /dev/nvme1n1p2 at /mnt/windows', sequence: 1 }], mission: null },
    definition, surface: 'interactive_tui', reviewPosture: 'prompt', justification: '',
  });
  assert.equal(decision.outcome, 'approve');
  assert.equal(decision.reasonCode, 'semantic_intent_match');
});

test('sealed helper consumes one immutable request and returns bounded exact-process evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nna-elevation-helper-'));
  const requestPath = join(directory, 'request.json');
  const resultPath = join(directory, 'result.json');
  const cancelPath = join(directory, 'cancel.requested');
  const now = Date.now();
  const record = {
    version: '1.1', request_id: 'helper-1', issued_at: now - 86_400_000,
    executable: process.execPath, args: ['--version'], cwd: directory, timeout_ms: 5_000,
    expected_effect: 'Print the exact installed Node.js version without mutation',
  };
  const bytes = `${JSON.stringify(record)}\n`;
  await writeFile(requestPath, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const envelope = Buffer.from(JSON.stringify({
    requestPath, resultPath, cancelPath, digest: createHash('sha256').update(bytes).digest('hex'),
  }), 'utf8').toString('base64url');
  const helperPath = fileURLToPath(new URL('../src/elevation-helper.js', import.meta.url));
  const status = await runHelper(process.execPath, [helperPath, '--envelope', envelope]);
  assert.equal(status, 0);
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(result.status, 'succeeded');
  assert.equal(result.exit_code, 0);
  assert.match(result.stdout, /^v\d+/u);
  await assert.rejects(readFile(requestPath), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(`${requestPath}.consumed`, 'utf8')).request_id, 'helper-1');
});

test('sealed helper observes cancellation and terminates the elevated process tree', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nna-elevation-cancel-'));
  const requestPath = join(directory, 'request.json');
  const resultPath = join(directory, 'result.json');
  const cancelPath = join(directory, 'cancel.requested');
  const now = Date.now();
  const record = {
    version: '1.1', request_id: 'helper-cancel', issued_at: now,
    executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: directory,
    timeout_ms: 5_000, expected_effect: 'Remain active until cancelled by the parent runtime',
  };
  const bytes = `${JSON.stringify(record)}\n`;
  await writeFile(requestPath, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const envelope = Buffer.from(JSON.stringify({
    requestPath, resultPath, cancelPath, digest: createHash('sha256').update(bytes).digest('hex'),
  }), 'utf8').toString('base64url');
  const helperPath = fileURLToPath(new URL('../src/elevation-helper.js', import.meta.url));
  const pending = runHelper(process.execPath, [helperPath, '--envelope', envelope]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await writeFile(cancelPath, 'cancel\n', { encoding: 'utf8', flag: 'wx' });
  assert.equal(await pending, 0);
  const result = JSON.parse(await readFile(resultPath, 'utf8'));
  assert.equal(result.status, 'failed');
  assert.equal(result.reason_code, 'elevated_process_cancelled');
});

test('elevation timeout settles even when process-tree termination fails', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.pid = 42;
  const request = { executable: process.execPath, args: [], cwd: process.cwd(), timeout_ms: 1 };
  await assert.rejects(runExact(request, 'unused', {
    spawnProcess: () => child,
    terminateTree: async () => { throw new Error('termination failed'); },
  }), /timeout/u);
});

function runHelper(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}
