// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, open, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareUpdateFixture, startUpdateFeed, verifyGithubAcquisition } from './update-smoke-fixture.mjs';
const execute = promisify(execFile);

async function logged(command, args, file, env) {
  const log = await open(file, 'w');
  const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', log.fd, log.fd] });
  let timer;
  try {
    const code = await new Promise((resolve, reject) => {
      timer = setTimeout(() => { child.kill(); reject(new Error(`Acceptance child timed out; inspect ${file}`)); }, 600000);
      child.once('error', reject); child.once('exit', resolve);
    });
    assert.equal(code, 0, `Acceptance child failed; inspect ${file}`);
  } finally { clearTimeout(timer); await log.close(); }
}

async function main() {
  assert.equal(process.platform, 'win32', 'Installed desktop update acceptance requires Windows');
  const [installArg, evidenceArg] = process.argv.slice(2); assert.ok(installArg && evidenceArg && process.argv.length === 4);
  const repo = resolve(import.meta.dirname, '..'), install = resolve(installArg), evidence = resolve(evidenceArg);
  await mkdir(evidence, { recursive: true });
  assert.deepEqual(await readdir(evidence), [], 'Use a fresh evidence directory; stale candidate files are not valid acceptance inputs');
  const marker = JSON.parse(await readFile(join(install, 'install.json'), 'utf8'));
  assert.equal(marker.product, 'NotNativeAgent'); assert.equal(resolve(marker.install_root), install);
  const env = { ...process.env, NNA_HOME: marker.data_root }; delete env.NODE_OPTIONS; delete env.NODE_PATH; delete env.ELECTRON_RUN_AS_NODE;
  const cli = async (...args) => (await execute(marker.node, ['--disable-warning=ExperimentalWarning', join(install, 'installed/src/cli.js'), ...args], { env, windowsHide: true, timeout: 60000 })).stdout.trim();
  const desktop = async () => JSON.parse(await cli('desktop', 'status'));
  const gateway = async () => { const state = JSON.parse(await cli('gateway', 'status')); return { enabled: state.enabled, running: state.runtime.running }; };
  const opencode = async () => { const state = JSON.parse(await cli('opencode', 'status')); assert.equal(typeof state.service.autostart_enabled, 'boolean'); return { enabled: state.service.autostart_enabled, running: state.runtime.running }; };
  const baseline = await desktop(), gatewayBefore = await gateway(), opencodeBefore = await opencode();
  assert.ok(baseline.root && baseline.version, 'A real registered desktop is required');
  assert.deepEqual(gatewayBefore, { enabled: false, running: false }, 'Do not run this acceptance while the Telegram gateway is enabled/running');
  const preferences = await preservedFiles(marker.data_root);
  console.log('Verifying actual GitHub commit/version/archive acquisition');
  const github = await verifyGithubAcquisition(evidence);
  console.log(`GitHub advertises ${github.version}; preparing candidate feed for the normal installation`);
  const fixture = await prepareUpdateFixture(repo, evidence), feed = await startUpdateFeed(fixture, evidence);
  const results = [];
  try {
    for (const running of [true, false]) {
      const name = running ? 'running' : 'stopped';
      console.log(`Installing version ${fixture.baselineVersion} acceptance baseline in the registered location (${name} case)`);
      await logged('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(fixture.baseline, 'install.ps1'),
        '-SourceRoot', fixture.baseline, '-InstallRoot', install, '-DataRoot', marker.data_root,
        '-SkipProviderSetup', '-SkipWebSearchSetup', '-SkipPlaywrightSetup', '-SkipGatewaySetup', '-SkipRipgrepSetup'], join(evidence, `${name}-baseline.log`), env);
      if (running) await cli('desktop', 'start');
      else { await cli('desktop', 'stop'); await execute(marker.node, [join(repo, 'desktop/scripts/installer-wait-stopped.mjs'), install, marker.data_root], { windowsHide: true, timeout: 45000 }); }
      const before = await desktop(); assert.equal(before.running, running); assert.equal(before.version, fixture.baselineVersion);
      console.log(`Running installed nna update: ${fixture.baselineVersion} -> ${fixture.version}; service ${name}`);
      const log = join(evidence, `${name}-update.log`);
      await logged(marker.node, ['--import', pathToFileURL(feed.preload).href, join(install, 'installed/src/cli.js'), 'update'], log, env);
      const after = await desktop(), registration = JSON.parse(await cli('desktop', 'package', 'status'));
      assert.equal(await cli('--version'), fixture.version); assert.equal(after.version, fixture.version);
      assert.equal(registration.version, fixture.version); assert.equal(registration.valid, true);
      assert.equal(after.root, baseline.root); assert.equal(after.running, running);
      assert.equal(after.enabled, baseline.enabled); assert.equal(after.login.installed, baseline.login.installed);
      if (running) { assert.notEqual(after.service.instance_id, before.service.instance_id); assert.equal(after.service.package_version, fixture.version); }
      const descriptor = JSON.parse(await readFile(join(install, 'install.json')));
      assert.equal(descriptor.version, fixture.version); assert.equal(descriptor.incarnation_id, marker.incarnation_id);
      assert.deepEqual(await gateway(), gatewayBefore); assert.deepEqual(await opencode(), opencodeBefore);
      assert.deepEqual(await preservedFiles(marker.data_root), preferences);
      const output = await readFile(log, 'utf8');
      if (running) { const stopped = output.indexOf('stopping service before replacing NNA runtime files');
        assert.ok(stopped >= 0 && output.indexOf('Runtime files installed') > stopped); }
      else assert.ok(!output.includes('Starting previously running desktop service'));
      results.push({ service_running: running, nna_version: descriptor.version, desktop_version: after.version, state_preserved: true });
      console.log(`Verified ${name}: both components ${fixture.version}; service and preferences preserved`);
    }
    assert.deepEqual(feed.requested, ['/commit', '/version', '/archive', '/commit', '/version', '/archive']);
    await writeFile(join(evidence, 'result.json'), JSON.stringify({ github, candidate_version: fixture.version, acquisition: 'loopback fixture; real installed CLI/tar/main installer', results }, null, 2));
  } finally {
    await feed.close();
    const after = await desktop();
    if (after.enabled !== baseline.enabled) await cli('desktop', baseline.enabled ? 'enable' : 'disable');
    if (after.running !== baseline.running) await cli('desktop', baseline.running ? 'start' : 'stop');
    await cli('update', '--check');
  }
  console.log('NNA_INSTALLED_UPDATE_OK');
}

async function preservedFiles(dataRoot) {
  const files = ['config/desktop-launch.json', 'config/provider-credentials.json', 'config/mcp-credentials.json',
    'config/trusted-workspaces.json', 'config/desktop-service.json'];
  return Object.fromEntries(await Promise.all(files.map(async file => {
    try { return [file, createHash('sha256').update(await readFile(join(dataRoot, file))).digest('hex')]; }
    catch (error) { if (error.code === 'ENOENT') return [file, null]; throw error; }
  })));
}

await main();
