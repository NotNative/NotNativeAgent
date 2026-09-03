// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { WindowsAdministrator, administratorLauncher } from '../src/windows-admin.js';
import { windowsAdminSource } from '../src/windows-admin-worker.js';
import { shellRunDefinition } from '../src/tools/process.js';
import { MandatoryReviewer } from '../src/reviewer.js';
import { ReviewerLedger } from '../src/persistence/reviewer-ledger.js';
import { EventHub } from '../src/events.js';
import { ToolGovernor } from '../src/tools/governor.js';
import { liveActivityLine } from '../src/tui/live-activity.js';

const operation = { script: 'Write-Output ready', privilege: 'administrator', reason: 'Inspect the protected configuration',
  timeout_ms: 5000, accepted_exit_codes: [0] };
const paths = { async resolveDirectory() { return { path: tmpdir(), insideWorkspace: true }; } };

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'nna-windows-admin-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('administrator shell validation binds privilege and prevents unsupported surfaces', async () => {
  const adapter = { async execute() {} };
  const definition = shellRunDefinition(paths, null, 'win32', adapter);
  const prepared = await definition.validate(operation);
  assert.equal(prepared.args.privilege, 'administrator');
  assert.equal(prepared.args.shell, 'powershell');
  assert.equal(prepared.resolved.readOnly, false);
  assert.deepEqual((await definition.validate({ ...operation, accepted_exit_codes: [0, 3010] })).args.accepted_exit_codes, [0, 3010]);
  for (const [platform, configured] of [['linux', adapter], ['win32', null]]) {
    await assert.rejects(shellRunDefinition(paths, null, platform, configured).validate(operation), { code: 'native_elevation_unavailable' });
  }
  for (const change of [{ shell: 'cmd' }, { reason: '' }, { stdin_ref: 'draft' }, { script: 'x'.repeat(8193) }]) {
    await assert.rejects(definition.validate({ ...operation, ...change }), { code: 'native_elevation_unavailable' });
  }
  await assert.rejects(definition.validate({ script: 'echo ok', accepted_exit_codes: [0, 3010] }), { code: 'shell_exit_codes_invalid' });
});

async function reviewed(outcome, mission = null, reviewPosture = 'prompt') {
  let calls = 0;
  const reviewer = new MandatoryReviewer({ ledger: new ReviewerLedger({ durable: false, sessionId: 'admin-review' }),
    semanticReviewer: { async review(input) {
      calls += 1;
      assert.equal(input.classification.scope, 'host');
      return { outcome, confidence: 1, reason_code: 'intent_match' };
    } } });
  const request = { id: 'admin-1', providerCallId: 'admin-call', toolName: 'shell.run', args: operation,
    resolved: { path: tmpdir(), readOnly: true }, authorityId: 'authority', authorityVersion: 1,
    policyVersion: 1, definitionVersion: 2, caller: 'primary', expiresAt: Date.now() + 60000 };
  const definition = shellRunDefinition(paths, null, 'win32', {});
  const decision = await reviewer.review(request, { authority: { id: 'authority', mission,
    intent: [{ content: 'Inspect the protected configuration', sequence: 1 }] },
  definition, surface: 'interactive_tui', reviewPosture });
  return { decision, calls };
}

test('privileged reads require semantic approval without an extra NNA confirmation', async () => {
  const approved = await reviewed('approve');
  assert.equal(approved.calls, 1);
  assert.equal(approved.decision.outcome, 'approve');
  assert.equal((await reviewed('deny_with_guidance')).decision.outcome, 'deny_with_guidance');
  assert.equal((await reviewed('escalate_to_operator')).decision.reasonCode, 'elevation_review_uncertain');
  const denied = await reviewed('approve', { resources: ['workspace'], sideEffects: ['unknown'], targets: ['*'] });
  assert.equal(denied.calls, 0);
  assert.equal(denied.decision.reasonCode, 'mission_resource_denied');
  assert.equal((await reviewed('approve', null, 'unattended')).decision.reasonCode, 'unattended_escalation_denied');
});

test('UAC launcher is hidden, waits, and carries code inline instead of a mutable helper', () => {
  const script = administratorLauncher('C:\\Program Files\\nodejs\\node.exe', {
    directory: 'C:\\temporary\\admin', digest: 'abc', powershell: 'powershell.exe', taskkill: 'taskkill.exe',
  });
  assert.match(script, /-Verb RunAs -WindowStyle Hidden/u);
  assert.match(script, /-Wait -PassThru/u);
  assert.match(script, /request_drift/u);
  assert.match(script, /exit 1223/u);
  assert.ok(Buffer.from(script, 'utf16le').toString('base64').length < 30000);
});

test('UAC wait is not timed out by the command execution deadline', async (t) => {
  const directory = await temporary(t);
  const broker = new WindowsAdministrator({ systemRoot: 'C:\\Windows', spawn: () => {
    const child = new EventEmitter(); child.kill = () => assert.fail('authentication wait was killed');
    setTimeout(() => child.emit('close', 1223), 200);
    return child;
  } });
  const code = await broker.launch({ directory, powershell: 'unused' }, new AbortController().signal,
    { args: { ...operation, timeout_ms: 100 } });
  assert.equal(code, 1223);
  const definition = { scope: 'workspace', timeoutMs: 10, maxOutputBytes: 10000,
    async executor() { await delay(50); return { content: 'ready', effectCertainty: 'completed' }; } };
  const governor = new ToolGovernor({ events: new EventHub(), reviewer: {}, registry: { definition: () => definition } });
  const result = await governor.executePrepared({ id: 'admin', toolName: 'shell.run', args: operation }, { id: 'approved' }, new AbortController().signal);
  assert.equal(result.status, 'succeeded');
});

test('cancelled or missing UAC results never claim successful execution', async (t) => {
  const directory = await temporary(t), broker = new WindowsAdministrator();
  const envelope = { directory, digest: 'request' };
  assert.equal((await broker.result(envelope, 1223, operation)).status, 'denied');
  assert.equal((await broker.result(envelope, 1, operation)).status, 'unknown_effect');
  await writeFile(join(directory, 'started'), 'started');
  assert.equal((await broker.result(envelope, 1223, operation)).effectCertainty, 'unknown');
  for (const change of [{ requestDigest: 'other' }, { exitCode: 3010 }, { effectCertainty: 'unknown' }, { outputTruncated: true }]) {
    await writeFile(join(directory, 'result.json'), JSON.stringify({ requestDigest: 'request',
      status: 'succeeded', effectCertainty: 'completed', exitCode: 0, ...change }));
    assert.equal((await broker.result(envelope, 0, operation)).status, 'unknown_effect');
  }
  await writeFile(join(directory, 'result.json'), JSON.stringify({ requestDigest: 'request',
    status: 'succeeded', effectCertainty: 'completed', exitCode: 3010, rebootRequired: true }));
  const success = await broker.result(envelope, 0, { ...operation, accepted_exit_codes: [0, 3010] });
  assert.equal(success.status, 'succeeded');
  assert.equal(success.metadata.reboot_required, true);
  assert.equal(success.metadata.verification_required, true);
});

test('prelaunch cancellation skips UAC and broker cleans up its exact operation directory', async (t) => {
  const root = await temporary(t), phases = [];
  const broker = new WindowsAdministrator({ root, systemRoot: 'C:\\Windows', output: async (value) => phases.push(value.phase) });
  broker.launch = async () => 1223;
  const request = { args: operation };
  assert.equal((await broker.execute(request, AbortSignal.abort())).status, 'denied');
  assert.deepEqual(phases, []);
  assert.equal((await broker.execute(request, new AbortController().signal)).status, 'denied');
  assert.deepEqual(phases, ['awaiting_authorization']);
  assert.deepEqual(await readdir(root), []);
});

async function worker(t, args, preparation = async () => {}) {
  const directory = await temporary(t);
  const bytes = JSON.stringify({ ...operation, cwd: directory, ...args });
  const envelope = { directory, digest: createHash('sha256').update(bytes).digest('hex'),
    powershell: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    taskkill: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe') };
  await writeFile(join(directory, 'request.json'), bytes);
  await preparation(directory);
  // Intentionally not elevated: exercise the exact worker protocol with harmless commands.
  const child = spawn(process.execPath, ['--input-type=commonjs', '-e', windowsAdminSource(envelope)], { windowsHide: true });
  let errorOutput = ''; child.stderr.on('data', (chunk) => { errorOutput += chunk; }); child.stdout.resume();
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(exit, 0, errorOutput);
  return { directory, result: JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')) };
}

test('worker checks immutable request and late cancellation before execution', async (t) => {
  const drift = await worker(t, {}, (directory) => writeFile(join(directory, 'request.json'), '{}'));
  assert.equal(drift.result.effectCertainty, 'none');
  assert.equal((await readdir(drift.directory)).includes('started'), false);
  const cancelled = await worker(t, {}, (directory) => writeFile(join(directory, 'cancel'), 'cancel'));
  assert.equal(cancelled.result.status, 'denied');
  assert.equal((await readdir(cancelled.directory)).includes('started'), false);
});

test('worker captures output, failure, timeout and documented Windows exit code without elevation', { skip: process.platform !== 'win32' }, async (t) => {
  const success = await worker(t, { script: 'Write-Output ready; [Console]::Error.WriteLine("diagnostic")' });
  assert.equal(success.result.status, 'succeeded');
  assert.match(success.result.stdout, /ready/u);
  assert.match(success.result.stderr, /diagnostic/u);
  const failure = await worker(t, { script: 'throw "failure"' });
  assert.equal(failure.result.status, 'failed');
  assert.equal(failure.result.effectCertainty, 'unknown');
  const restart = await worker(t, { script: 'exit 3010', accepted_exit_codes: [0, 3010] });
  assert.equal(restart.result.status, 'succeeded');
  assert.equal(restart.result.rebootRequired, true);
  const timeout = await worker(t, { script: 'Start-Sleep -Seconds 30', timeout_ms: 100 });
  assert.ok(['timed_out', 'unknown_effect'].includes(timeout.result.status));
  assert.equal(timeout.result.effectCertainty, 'unknown');
});

test('complete Windows launcher preserves inline worker quoting without requesting UAC', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await temporary(t);
  const broker = new WindowsAdministrator({ root, spawn: (executable, args, options) => {
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(script, /-Verb RunAs/u);
    const unprivileged = script.replace('-Verb RunAs ', '');
    return spawn(executable, [...args.slice(0, -1), Buffer.from(unprivileged, 'utf16le').toString('base64')], options);
  } });
  const result = await broker.execute({ args: { ...operation, cwd: root, script: 'Write-Output "quoted \'value\' \\ path"' } }, new AbortController().signal);
  assert.equal(result.status, 'succeeded', result.content);
  assert.match(JSON.parse(result.content).stdout, /quoted 'value' \\ path/u);
  assert.deepEqual(await readdir(root), []);
});

test('Console retains live activity while waiting for Windows authorization', () => {
  const record = { type: 'tool_status', turn_id: 'turn', tool_request_id: 'tool', tool: 'shell.run', status: 'running', execution_phase: 'awaiting_authorization' };
  const session = { state: 'running_tool', activeTurnId: 'turn', records: [record] };
  assert.match(liveActivityLine(session, {}), /Waiting for Windows authorization/u);
  session.records.push({ ...record, execution_phase: 'executing_administrator' });
  assert.match(liveActivityLine(session, {}), /Running shell.run/u);
});
