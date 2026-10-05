// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

const stageOperation = 'b2b728f5-6aca-49b6-8675-c4f9e06c262c';
const generation = 'gen_1234567890';
const endpoint = 'http://127.0.0.1:3000';
const listItem = value => createHash('sha256').update(value.toLowerCase()).digest('hex');
const byteHash = value => createHash('sha256').update(value).digest('hex');

const fakeCli = `const { mkdirSync, readFileSync, realpathSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { dirname, join } = require('node:path');
const root = process.argv[5], action = process.argv[4], family = process.argv[3];
const digest = value => createHash('sha256').update(realpathSync(value).toLowerCase()).digest('hex');
const stage = 'b2b728f5-6aca-49b6-8675-c4f9e06c262c';
const generation = 'gen_1234567890';
const endpoint = 'http://127.0.0.1:3000';
const mode = process.env.NNACTIV_TEST_ACTIVATION_MODE;
const activeRoot = join(dirname(root ?? process.env.NNA_HOME), 'private-slot');
const activeVersion = '20261003-12';
const newline = String.fromCharCode(10);
const candidateEvidence = (identityRoot, stageOperationId) => {
  const registration = JSON.stringify({ root: activeRoot, version: activeVersion, protocol: '1.0' }, null, 2) + newline;
  return { protocol: '2.0', stage_operation_id: stageOperationId,
    installation_id: 'nna_' + digest(identityRoot), data_id: 'data_' + digest(join(dirname(identityRoot), 'data')),
    version: activeVersion, payload_sha256: process.env.NNACTIV_TEST_PAYLOAD_DIGEST ?? 'a'.repeat(64), stage_prepared_sha256: 'b'.repeat(64),
    stage_ready_sha256: 'c'.repeat(64), provenance_sha256: 'd'.repeat(64), slot_ino: '10', slot_dev: '20',
    registry_before_revision: 'absent', desired_registration_sha256: createHash('sha256').update(registration).digest('hex') };
};
const candidateDigest = evidence => createHash('sha256').update(JSON.stringify(evidence) + newline).digest('hex');
if (family === 'package' && action === 'status') {
  const valid = mode !== 'status-invalid';
  process.stdout.write(JSON.stringify({ registered: valid, valid, root: activeRoot, version: activeVersion }));
} else if (action === 'capabilities') {
  const installationId = 'nna_' + digest(root);
  const dataId = 'data_' + digest(join(dirname(root), 'data'));
  process.stdout.write(JSON.stringify({ protocol: '1.0', installation_id: installationId,
    data_id: dataId, native_version: '20261003-99',
    capabilities: ['service_supervision', 'setup_control_plane', 'atomic_ui_attach', 'installer_guard'],
    commands: ['start', 'status', 'stop', 'attach', 'install-guard'] }));
} else if (action === 'attach') {
  const attachGeneration = mode === 'attach-mismatch' ? 'ready_generation_changed' : generation;
  const attachEndpoint = mode === 'endpoint-ipv6' ? 'http://[::1]:3000' : endpoint;
  const installationId = 'nna_' + digest(root);
  const dataId = 'data_' + digest(join(dirname(root), 'data'));
  process.stdout.write(JSON.stringify({ protocol: '1.0', installation_id: installationId,
    data_id: dataId, generation: attachGeneration, endpoint: attachEndpoint, expires_at: new Date(Date.now() + 30000).toISOString(),
    ticket: 'a'.repeat(64) }));
} else if (action === 'activation-preflight') {
  const stageOperationId = process.argv[6], activationOperationId = process.argv[7];
  const candidate = candidateEvidence(root, stageOperationId);
  process.stdout.write(JSON.stringify({ state: 'slot_ready', operation_id: activationOperationId,
    stage_operation_id: stageOperationId, installation_id: 'nna_' + digest(root),
    data_id: 'data_' + digest(join(dirname(root), 'data')), version: '20261003-12',
    payload_sha256: process.env.NNACTIV_TEST_PAYLOAD_DIGEST, candidate_sha256: candidateDigest(candidate) }));
} else if (action === 'activate-slot') {
  const marker = join(dirname(root), 'activation-marker');
  writeFileSync(marker, JSON.stringify({
    pid: process.pid, stage: process.argv[6], operation: process.argv[7] }));
  mkdirSync(join(root, 'private-activation'), { recursive: true });
  const operation = process.argv[7];
  const evidence = candidateEvidence(root, process.argv[6]);
  const candidateDirectory = join(dirname(root), 'data', 'runtime', 'nnd', 'install-slots', 'activations');
  mkdirSync(candidateDirectory, { recursive: true });
  writeFileSync(join(candidateDirectory, operation + '.candidate.json'), JSON.stringify(evidence) + newline);
  mkdirSync(join(dirname(root), 'data', 'config'), { recursive: true });
  const registration = JSON.stringify({ root: activeRoot, version: activeVersion, protocol: '1.0' }, null, 2) + newline;
  writeFileSync(join(dirname(root), 'data', 'config', 'nnd-package.json'), registration);
  const slotsRoot = join(dirname(root), 'data', 'runtime', 'nnd', 'install-slots');
  mkdirSync(slotsRoot, { recursive: true });
  const sha64 = value => createHash('sha256').update(value).digest('hex');
  const commit = { protocol: '1.0', state: 'terminal_committed_barred', operation_id: operation,
    stage_operation_id: process.argv[6], installation_id: 'nna_' + digest(root),
    data_id: 'data_' + digest(join(dirname(root), 'data')), generation, plan_sha256: '1'.repeat(64),
    decision_sha256: '2'.repeat(64), completion_sha256: '3'.repeat(64), marker_sha256: '4'.repeat(64),
    registration_revision: sha64(Buffer.from(registration)), discovery_sha256: '5'.repeat(64),
    child_process_identity: { start_id: '1', pid: process.pid, version: 1, platform: 'win32' } };
  const commitBytes = JSON.stringify(commit) + newline;
  writeFileSync(join(slotsRoot, 'activation-retirement-commit.json'), commitBytes);
  writeFileSync(join(slotsRoot, 'activation-retirement-cleared.json'), JSON.stringify({
    ...commit, state: 'barriers_cleared_admission_barred', terminal_sha256: sha64(Buffer.from(commitBytes)) }) + newline);
  const readinessEndpoint = mode === 'endpoint-ipv6' ? 'http://[::1]:3000' : endpoint;
  const frame = { state: 'public_controller_attached', operation_id: operation,
    stage_operation_id: process.argv[6], generation, endpoint: readinessEndpoint,
    candidate_sha256: candidateDigest(evidence) };
  if (mode === 'ready-wrong-stage') frame.stage_operation_id = stage + 'x';
  if (mode === 'ready-wrong-generation') frame.generation = 'other generation';
  if (mode === 'ready-wrong-candidate') frame.candidate_sha256 = 'f'.repeat(64);
  try {
    if (mode === 'ready-invalid-json') process.stdout.write('{bad');
  else process.stdout.write(JSON.stringify(frame) + '\\n');
  } catch (error) {
    writeFileSync(marker + '.err', String(error.stack) + '\\n');
    throw error;
  }
  if (mode === 'exit') process.exit(7);
  if (!mode || mode === 'attach-mismatch' || mode === 'status-invalid' || mode === 'frame-success'
    || mode === 'endpoint-ipv6') {
    setInterval(() => {}, 60000);
  }
} else process.exit(6);`;

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'nnd-prebuilt-activation-'));
  t.after(() => process.env.NND_TEST_KEEP_ACTIVATION_FIXTURE ? Promise.resolve() : rm(base, { recursive: true, force: true }));
  const native = join(base, 'NNA'), data = join(base, 'data');
  await mkdir(join(native, 'installed', 'src'), { recursive: true }); await mkdir(data);
  const cli = join(native, 'installed', 'src', 'cli.js'); await writeFile(cli, fakeCli);
  await writeFile(join(native, 'installed', 'package.json'), JSON.stringify({
    name: 'not-native-agent', nna_version: '20261003-99' }));
  await writeFile(join(native, 'installed', 'VERSION'), '20261003-99\n');
  await writeFile(join(native, 'install.json'), JSON.stringify({
    product: 'NotNativeAgent', version: '20261003-99', node: process.execPath,
    install_root: native, data_root: data, node_major: Number(process.versions.node.split('.')[0]) }));
  const canonicalNative = await realpath(native), canonicalData = await realpath(data);
  const activeRoot = join(base, 'private-slot');
  const registration = JSON.stringify({ root: activeRoot, version: '20261003-12', protocol: '1.0' }, null, 2) + String.fromCharCode(10);
  const candidate = { protocol: '2.0', stage_operation_id: stageOperation,
    installation_id: 'nna_' + listItem(canonicalNative), data_id: 'data_' + listItem(canonicalData),
    version: '20261003-12', payload_sha256: process.env.NNACTIV_TEST_PAYLOAD_DIGEST ?? 'a'.repeat(64), stage_prepared_sha256: 'b'.repeat(64),
    stage_ready_sha256: 'c'.repeat(64), provenance_sha256: 'd'.repeat(64), slot_ino: '10', slot_dev: '20',
    registry_before_revision: 'absent', desired_registration_sha256: byteHash(registration) };
  return { base, native, data, cli, marker: join(base, 'activation-marker'),
    candidateSha256: byteHash(JSON.stringify(candidate) + String.fromCharCode(10)) };
}

function activate(f, mode = '') {
  return spawnSync(process.execPath, [resolve('scripts/installer-prebuilt-activation.mjs'),
    f.native, stageOperation], {
    encoding: 'utf8', timeout: 150000, env: { ...process.env, NND_PREFLIGHT_CANDIDATE_SHA256: f.candidateSha256,
      NNACTIV_TEST_ACTIVATION_MODE: mode },
  });
}

test('retained prebuilt activation leaves the NNA owner live and proves public attach',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    const result = activate(f);
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.state, 'public_controller_attached');
    assert.equal(value.stage_operation_id, stageOperation);
    assert.equal(value.version, '20261003-12');
    const marker = JSON.parse(await readFile(join(f.base, 'activation-marker'), 'utf8'));
    assert.equal(marker.stage, stageOperation);
    assert.equal(value.operation_id, marker.operation);
    await new Promise(accept => setTimeout(accept, 50));
    process.kill(value.pid, 'SIGTERM');
    await new Promise(accept => setTimeout(accept, 50));
    assert.throws(() => process.kill(value.pid, 0));
    const ipv6Fixture = await fixture(t);
    const ipv6Result = activate(ipv6Fixture, 'endpoint-ipv6');
    assert.equal(ipv6Result.status, 0, ipv6Result.stderr);
    const ipv6Value = JSON.parse(ipv6Result.stdout);
    assert.equal(ipv6Value.endpoint, 'http://[::1]:3000');
    const ipv6Marker = JSON.parse(await readFile(ipv6Fixture.marker, 'utf8'));
    process.kill(ipv6Marker.pid, 'SIGTERM');
    await new Promise(accept => setTimeout(accept, 50));
    assert.throws(() => process.kill(ipv6Marker.pid, 0));
  });

test('prebuilt readiness and proof mismatches remain uncertain without false activation',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    for (const mode of ['ready-wrong-stage', 'ready-wrong-generation', 'ready-wrong-candidate', 'ready-invalid-json',
      'exit', 'attach-mismatch', 'status-invalid']) {
      const result = activate(f, mode);
      assert.notEqual(result.status, 0, mode);
      assert.doesNotMatch((result.stdout || '') + (result.stderr || ''), /public controller attached/u, mode);
      const marker = JSON.parse(await readFile(f.marker, 'utf8'));
      try { process.kill(marker.pid, 'SIGTERM'); } catch { }
      await new Promise(accept => setTimeout(accept, 20));
      try { process.kill(marker.pid, 0); } catch { }
    }
  });

test('installer activation mode delegates the selected slot without copying the target',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    const firstTarget = join(f.base, 'NND target');
    const secondTarget = join(f.base, 'NND target.1');
    await mkdir(firstTarget, { recursive: true });
    await writeFile(join(firstTarget, 'keep.txt'), 'unchanged');
    const payload = join(f.base, 'payload'); await mkdir(payload, { recursive: true });
    await writeFile(join(payload, 'packages', 'web', 'dist', 'index.html'), '<html>fixture</html>', { recursive: true }).catch(async error => {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(join(payload, 'packages', 'web', 'dist'), { recursive: true });
      await writeFile(join(payload, 'packages', 'web', 'dist', 'index.html'), '<html>fixture</html>');
    });
    const manifest = JSON.stringify({ schema_version: '1.0', version: '20261003-12',
      platform: 'win32', architecture: 'x64', files: [] });
    const shortcutRoot = join(f.base, 'disposable shortcuts');
    await mkdir(shortcutRoot);
    await writeFile(join(shortcutRoot, '.nnd-disposable-shortcuts'), 'nnd-disposable-shortcuts-v1');
    await writeFile(join(payload, 'NND_PAYLOAD.json'), manifest);
    const digest = createHash('sha256').update(manifest).digest('hex');
    const rejected = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', resolve('install.ps1'),
      '-ActivatePrebuiltSlot', '-PrebuiltStageOperation', stageOperation,
      '-PrebuiltPayloadRoot', payload, '-PrebuiltManifestSha256', digest,
      '-InstallNnaIfMissing', '-NnaSourceRoot', f.native, '-InstallDir', firstTarget], {
      encoding: 'utf8', windowsHide: true, timeout: 90000,
      env: { ...process.env, Path: '', NNACTIV_TEST_PAYLOAD_DIGEST: digest },
    });
    assert.notEqual(rejected.status, 0);
    assert.doesNotMatch([rejected.stdout, rejected.stderr].join('\n'), /public controller attached/u);
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', resolve('install.ps1'),
      '-ActivatePrebuiltSlot', '-PrebuiltStageOperation', stageOperation,
      '-PrebuiltPayloadRoot', payload, '-PrebuiltManifestSha256', digest,
      '-NnaInstallRoot', f.native, '-InstallDir', secondTarget, '-ShortcutRoot', shortcutRoot], {
      encoding: 'utf8', windowsHide: true, timeout: 20000,
      env: { ...process.env, Path: '', NNACTIV_TEST_PAYLOAD_DIGEST: digest },
    });
    assert.equal(result.status, 0, [result.stdout, result.stderr].join('\n'));
    assert.match(result.stdout, /public controller attached/u);
    assert(result.stdout.includes('  endpoint     : http://127.0.0.1:3000'));
    const selection = JSON.parse(await readFile(join(secondTarget, 'nna-service-selection.json'), 'utf8'));
    const binding = JSON.parse(await readFile(join(secondTarget, 'nnd-anchor.json'), 'utf8'));
    assert.equal(selection.installation_id, JSON.parse((await readFile(join(secondTarget, 'nna-service-selection.json'), 'utf8'))).installation_id);
    assert.equal(binding.version, '20261003-12');
    assert(existsSync(join(shortcutRoot, 'desktop', 'NotNativeDesktop.lnk')));
    assert(existsSync(join(shortcutRoot, 'StartMenu', 'NotNativeDesktop.lnk')));
    const marker = JSON.parse(await readFile(f.marker, 'utf8'));
    process.kill(marker.pid, 'SIGTERM');
    await new Promise(accept => setTimeout(accept, 50));
    assert.throws(() => process.kill(marker.pid, 0));
  });
