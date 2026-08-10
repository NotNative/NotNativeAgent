// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { elevationInvocation } from '../src/elevation-broker.js';
import { InteractivePermissionBroker } from '../src/permission-broker.js';
import { MandatoryReviewer } from '../src/reviewer.js';
import { ReviewerLedger } from '../src/reviewer-ledger.js';
import { ToolRegistry } from '../src/tool-registry.js';

test('system.elevate is an interactive root capability with exact resolved argv', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-elevation-tool-'));
  const broker = { execute: async () => ({ content: 'done' }) };
  const registry = new ToolRegistry(root, { elevationBroker: broker });
  await registry.initialize();
  const definition = registry.definition('system.elevate');
  assert.ok(definition);
  assert.equal(definition.operatorConfirmation, 'one_shot');
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
  assert.match(script, /elevation-helper\.js/u);
  await assert.rejects(elevationInvocation('aix', broker, directory, 'sealed-envelope'), { code: 'elevation_platform_unsupported' });
});

test('reviewed elevation still requires a fresh local one-shot decision', async () => {
  const request = Object.freeze({
    id: 'elevate-1', providerCallId: 'provider-elevate-1', toolName: 'system.elevate',
    args: { executable: '/usr/bin/mount', args: ['/dev/nvme1n1p2', '/mnt/windows'], cwd: '/tmp' },
    resolved: { path: '/usr/bin/mount', reviewComplexity: 'privileged_execution', reviewPurpose: 'host_elevation' },
    authorityId: 'authority-1', authorityVersion: 1, policyVersion: 1, definitionVersion: 1,
    caller: 'primary', expiresAt: Date.now() + 60_000,
  });
  const definition = {
    name: 'system.elevate', purpose: 'Elevate one exact command.', sideEffect: 'unknown', scope: 'host',
    operatorConfirmation: 'one_shot',
  };
  const reviewer = new MandatoryReviewer({
    ledger: new ReviewerLedger({ durable: false, sessionId: 'elevation-review' }),
    semanticReviewer: { async review() { return { outcome: 'approve', confidence: 1, reason_code: 'intent_match' }; } },
  });
  const decision = await reviewer.review(request, {
    authority: { id: 'authority-1', intent: [{ content: 'Mount /dev/nvme1n1p2 at /mnt/windows', sequence: 1 }], mission: null },
    definition, surface: 'interactive_tui', justification: '',
  });
  assert.equal(decision.outcome, 'escalate_to_operator');
  assert.equal(decision.reasonCode, 'elevation_operator_confirmation_required');

  let prompt;
  const permission = new InteractivePermissionBroker({ output: async (event) => { prompt = event; }, timeoutMs: 2_000 });
  const controller = new AbortController();
  const pending = permission.request(request, decision, { definition }, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(prompt.choices, ['allow_once', 'deny', 'cancel']);
  assert.throws(() => permission.decide({
    permission_token: prompt.permission_token, tool_request_id: request.id, choice: 'allow_workspace',
  }, 'operator'), { code: 'permission_choice_invalid' });
  permission.decide({ permission_token: prompt.permission_token, tool_request_id: request.id, choice: 'allow_once' }, 'operator');
  assert.equal((await pending).outcome, 'approve');
});

test('sealed helper consumes one immutable request and returns bounded exact-process evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nna-elevation-helper-'));
  const requestPath = join(directory, 'request.json');
  const resultPath = join(directory, 'result.json');
  const now = Date.now();
  const record = {
    version: '1.0', request_id: 'helper-1', issued_at: now, expires_at: now + 60_000,
    executable: process.execPath, args: ['--version'], cwd: directory, timeout_ms: 5_000,
    expected_effect: 'Print the exact installed Node.js version without mutation',
  };
  const bytes = `${JSON.stringify(record)}\n`;
  await writeFile(requestPath, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const envelope = Buffer.from(JSON.stringify({
    requestPath, resultPath, digest: createHash('sha256').update(bytes).digest('hex'),
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

function runHelper(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}
