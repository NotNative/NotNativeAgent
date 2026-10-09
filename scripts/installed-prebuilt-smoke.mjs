// SPDX-License-Identifier: Apache-2.0
/** Disposable Windows proof for an immutable NND payload on a selected installed NNA. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPrebuiltPayload } from './export-prebuilt-payload.mjs';
import { acceptanceEvidence, checkedFixturePath, cli, prepare, privateDirectory,
  run, selectedPackage, shell, waitStopped } from './installed-source-acceptance.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Native slots need short Win32 paths even when their data root is private.
const base = join(homedir(), 'p');
const powershell = join(process.env.SystemRoot ?? '', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const operationPattern = /\boperation\s*:\s*([a-f0-9-]{36})\b/u;

async function install(fixture, args, label) {
  return run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(source, 'install.ps1'), '-InstallDir', fixture.nnd, '-NnaInstallRoot', fixture.nna,
    '-ShortcutRoot', fixture.shortcuts, ...args], { cwd: fixture.root, env: fixture.env,
    timeout: 3000000, outputFiles: { stdout: join(fixture.root, `${label}-stdout.log`),
      stderr: join(fixture.root, `${label}-stderr.log`) } });
}

async function main(nnaSource) {
  assert.equal(process.platform, 'win32', 'Windows acceptance only');
  assert.ok(isAbsolute(nnaSource), 'Provide an absolute NNA source root');
  await mkdir(base, { recursive: true });
  assert.equal(await realpath(base), resolve(base));
  const root = join(base, `nnd-accept-${randomUUID().replaceAll('-', '').slice(0, 10)}`);
  await privateDirectory(root, base);
  const fixture = await prepare(nnaSource, root);
  let accepted = false;
  let stopped = false;
  try {
    const payload = await exportPrebuiltPayload(join(root, 'payload'));
    assert.equal(payload.version, (await readFile(join(source, 'VERSION'), 'utf8')).trim());
    assert.equal(payload.sha256, createHash('sha256').update(await readFile(join(payload.root, 'NND_PAYLOAD.json'))).digest('hex'));
    const stage = await install(fixture, ['-StagePrebuiltPayload', '-PrebuiltPayloadRoot', payload.root,
      '-PrebuiltManifestSha256', payload.sha256], 'stage');
    const stageOperation = operationPattern.exec(stage)?.[1];
    assert.match(stageOperation ?? '', /^[a-f0-9-]{36}$/u, 'Native stage operation missing');
    assert.deepEqual(await selectedPackage(fixture), { registered: false });
    await assert.rejects(lstat(fixture.nnd), { code: 'ENOENT' });
    await install(fixture, ['-ActivatePrebuiltSlot', '-PrebuiltPayloadRoot', payload.root,
      '-PrebuiltManifestSha256', payload.sha256, '-PrebuiltStageOperation', stageOperation], 'activate');
    const binding = JSON.parse(await readFile(join(fixture.nnd, 'nnd-anchor.json'), 'utf8'));
    const active = await selectedPackage(fixture);
    assert.equal(active.registered, true);
    assert.equal(active.valid, true);
    assert.equal(active.version, payload.version);
    assert.equal((await realpath(active.root)).toLowerCase(), (await realpath(binding.nnd_package_root)).toLowerCase());
    assert.equal(binding.stage_operation_id, stageOperation);
    assert.equal(binding.payload_sha256, payload.sha256);
    const status = await cli(fixture, 'status');
    assert.equal(status.package_version, payload.version);
    assert.equal(status.service_state, 'setup_required');
    const slotFixture = { ...fixture, nnd: active.root };
    const ticket = (await cli(fixture, 'ui-ticket')).ticket;
    await shell(slotFixture, 'browser', status.endpoint, ticket);
    await shell(slotFixture, 'desktop', status.endpoint, null, [
      '--nna-install-root', fixture.nna, '--nnd-selection-file', join(fixture.nnd, 'nna-service-selection.json'),
    ]);
    assert.equal((await cli(fixture, 'status')).instance_id, status.instance_id);
    await cli(fixture, 'stop'); await waitStopped(fixture); stopped = true;
    await install(fixture, ['-Uninstall'], 'uninstall');
    assert.deepEqual(await selectedPackage(fixture), { registered: false });
    await assert.rejects(lstat(fixture.nnd), { code: 'ENOENT' });
    accepted = true;
    process.stdout.write(`Prebuilt ${payload.version} staged, activated, attached from Chromium and Electron, and removed on disposable NNA.\n`);
  } finally {
    if (!stopped) {
      try { await cli(fixture, 'stop'); await waitStopped(fixture); stopped = true; }
      catch { process.stderr.write(`Prebuilt native service state uncertain at ${root}\n`); }
    }
    if (accepted && stopped && !acceptanceEvidence().uncertain) {
      const path = await checkedFixturePath(root, base);
      await rm(path, { recursive: true, force: true, maxRetries: 5 });
    } else process.stderr.write(`Prebuilt acceptance evidence preserved at ${root}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('usage: installed-prebuilt-smoke.mjs ABSOLUTE_NNA_SOURCE');
  await main(resolve(process.argv[2]));
}
