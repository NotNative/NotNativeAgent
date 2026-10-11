// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { assertFreshSourceInstall, verifyFreshSourceService, verifyUpgradedStoppedService, installerNativeEnvironment } from './installer-fresh-service.mjs';

const sha = value => createHash('sha256').update(value.toLowerCase()).digest('hex');
test('installer native environment drops ambient authority and keeps selected data root', () => {
  const env = installerNativeEnvironment({ dataRoot: 'C:\\selected-data' }, {
    NNA_HOME: 'C:\\foreign-data', NNA_NND_BROWSER_TOKEN: 'ambient-secret',
    NNA_NND_AGENT_TOOL_URL: 'http://127.0.0.1:1', NNA_HARNESS_URL: 'http://127.0.0.1:2',
    NND_OLD_TOKEN: 'ambient-secret', NOTNATIVE_OVERRIDE: 'unsafe', NODE_OPTIONS: '--require=x',
    PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows',
  });
  assert.deepEqual(env, { NNA_HOME: 'C:\\selected-data', PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows' });
});
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'nnd-fresh-service-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'NNA'), data = join(base, 'data'), target = join(base, 'NND');
  const payload = join(root, 'installed'), cli = join(payload, 'src', 'cli.js');
  await mkdir(join(payload, 'src'), { recursive: true }); await mkdir(data);
  await writeFile(join(payload, 'package.json'), JSON.stringify({ name: 'not-native-agent',
    type: 'module', nna_version: '20261003-1' }));
  await writeFile(join(payload, 'VERSION'), '20261003-1\n');
  await writeFile(join(root, 'install.json'), JSON.stringify({ product: 'NotNativeAgent', version: '20261003-1',
    install_root: root, data_root: data, node: process.execPath, node_major: Number(process.versions.node.split('.')[0]) }));
  const installationId = `nna_${sha(root)}`, dataId = `data_${sha(data)}`;
  const generation = randomUUID(), ticket = 'A'.repeat(43), version = '20261003-28';
  let used = false, replayAllowed = false, oversizedBootstrap = false, changeRegistration = false;
  const server = createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.url === '/auth/native-bootstrap' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      if (request.headers.origin !== origin || JSON.parse(body).ticket !== ticket || used && !replayAllowed) {
        response.writeHead(401).end('{}'); return;
      }
      used = true;
      if (changeRegistration) await writeFile(join(data, 'fixture.json'), JSON.stringify({
        root: join(base, 'foreign-NND'), version, status, ticket }));
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'nnd_session=fixture; HttpOnly; SameSite=Strict' });
      response.end(oversizedBootstrap ? JSON.stringify({ authenticated: true, filler: 'x'.repeat(8192) })
        : '{"authenticated":true}'); return;
    }
    if (request.url === '/auth/session') {
      response.writeHead(request.headers.cookie === 'nnd_session=fixture' ? 200 : 401,
        { 'content-type': 'application/json' });
      response.end(JSON.stringify({ authenticated: request.headers.cookie === 'nnd_session=fixture' })); return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(done => server.close(done)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const status = { protocol: '1.0', installation_id: installationId, data_id: dataId,
    service_state: 'setup_required', instance_id: generation, endpoint, package_version: version, package_state: 'ready' };
  await writeFile(join(data, 'fixture.json'), JSON.stringify({ root: target, version, status, ticket }));
  await writeFile(cli, `import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const row=JSON.parse(readFileSync(join(process.env.NNA_HOME,'fixture.json'),'utf8'));
const [,,namespace,kind,action]=process.argv;
let value;
if(namespace==='nnd'&&kind==='package'&&action==='status')value=existsSync(join(process.env.NNA_HOME,'registered'))
  ? {registered:true,valid:true,root:row.root,version:row.version}:{registered:false};
else if(namespace==='nnd'&&kind==='service'&&action==='start'&&existsSync(join(process.env.NNA_HOME,'fail-start-once'))){
  unlinkSync(join(process.env.NNA_HOME,'fail-start-once'));
  process.stderr.write('(node) startup warning\\n'+'nna: nnd_service_crashed\\n');process.exit(2);
}
else if(namespace==='nnd'&&kind==='service'&&action==='start'&&existsSync(join(process.env.NNA_HOME,'owner-stale'))){
  process.stderr.write('nna: nnd_owner_unverified\\n');process.exit(2);
}
else if(namespace==='nnd'&&kind==='service'&&action==='run'&&existsSync(join(process.env.NNA_HOME,'owner-stale'))){
  unlinkSync(join(process.env.NNA_HOME,'owner-stale'));
  process.stdout.write(JSON.stringify(row.status)+'\\n');
}
else if(namespace==='nnd'&&kind==='service'&&['start','status'].includes(action)){
  if(action==='status'&&existsSync(join(process.env.NNA_HOME,'service-stopped'))){
    process.stderr.write('nna: nnd_service_not_running\\n');process.exit(2);
  }
  value=row.status;
}
else if(namespace==='nnd'&&kind==='service'&&action==='attach')value={protocol:'1.0',installation_id:row.status.installation_id,
  data_id:row.status.data_id,generation:row.status.instance_id,endpoint:row.status.endpoint,ticket:row.ticket,
  expires_at:new Date(Date.now()+30000).toISOString()};
else process.exit(2);
process.stdout.write(JSON.stringify(value)+'\\n');`);
  return { root, data, target, installationId, dataId, generation,
    register: () => writeFile(join(data, 'registered'), 'yes'),
    setReplayAllowed: value => { replayAllowed = value; },
    setOversizedBootstrap: value => { oversizedBootstrap = value; },
    setChangeRegistration: value => { changeRegistration = value; },
    failStartOnce: () => writeFile(join(data, 'fail-start-once'), 'yes') };
}

test('fresh source bridge rejects existing target and registration before mutation',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    assert.equal((await assertFreshSourceInstall(f.root, f.target, f.installationId, f.dataId)).state,
      'fresh_source_available');
    await mkdir(f.target);
    await assert.rejects(assertFreshSourceInstall(f.root, f.target, f.installationId, f.dataId),
      /fresh_target_exists/u);
    await rm(f.target, { recursive: true }); await f.register();
    await assert.rejects(assertFreshSourceInstall(f.root, f.target, f.installationId, f.dataId),
      /fresh_registration_exists/u);
    await assert.rejects(assertFreshSourceInstall(f.root, f.target, `nna_${'0'.repeat(64)}`, f.dataId),
      /native_selection_changed/u);
  });

test('fresh service verifier redeems once, isolates another browser, and retains generation',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t); await mkdir(f.target); await f.register();
    const verified = await verifyFreshSourceService(f.root, f.target, f.installationId, f.dataId);
    assert.equal(verified.state, 'fresh_service_verified');
    assert.equal(verified.service_state, 'setup_required');
    assert.equal(verified.generation, f.generation);
  });

test('fresh verifier retries one confirmed cold-start crash after a native warning',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t); await mkdir(f.target); await f.register(); await f.failStartOnce();
    const verified = await verifyFreshSourceService(f.root, f.target, f.installationId, f.dataId);
    assert.equal(verified.state, 'fresh_service_verified');
  });

test('fresh service verifier rejects replayable tickets without reporting success',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t); await mkdir(f.target); await f.register(); f.setReplayAllowed(true);
    await assert.rejects(verifyFreshSourceService(f.root, f.target, f.installationId, f.dataId),
      /fresh_ui_ticket_replay_allowed/u);
  });

test('fresh service verifier bounds an oversized local bootstrap response',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t); await mkdir(f.target); await f.register(); f.setOversizedBootstrap(true);
    await assert.rejects(verifyFreshSourceService(f.root, f.target, f.installationId, f.dataId),
      /fresh_ui_response_invalid/u);
  });

test('fresh service verifier refuses a same-version package change after guard release',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t); await mkdir(f.target); await f.register(); f.setChangeRegistration(true);
    await assert.rejects(verifyFreshSourceService(f.root, f.target, f.installationId, f.dataId),
      /fresh_registration_changed/u);
  });

test('installer source follows the dumb-copy shape: plan, copy, build, register, shortcuts', async () => {
  const source = await readFile(resolve('install.ps1'), 'utf8');
  const initial = source.indexOf('function Resolve-NndInstallPlan');
  const resolved = source.indexOf('$installPlan = Resolve-NndInstallPlan $nna $targetPath');
  const copy = source.indexOf('Write-Heading "Copying source"');
  const register = source.indexOf("Write-Heading 'Registering NND package with NNA'");
  const shortcuts = source.indexOf('Write-Heading "Creating shortcuts"');
  const success = source.indexOf('Write-Heading "NotNativeDesktop installed"');
  assert.ok(initial > 0 && initial < resolved && resolved < copy && copy < register
    && register < shortcuts && shortcuts < success);
  // The install path owns no native guard and never starts the service; the
  // desktop shortcut and `nna nnd start` own the lifecycle.
  assert.ok(!source.includes('$installationGuard = Start-NndInstallationGuard $nna'));
  assert.ok(!source.includes('Invoke-NndInstallVerification'));
  assert.ok(!source.includes('Invoke-NndFreshVerification'));
  assert.ok(source.indexOf('Request-NndServiceStopForUninstall $SelectedNna (Join-Path $Source') > 0);
  assert.ok(source.indexOf("Invoke-NndRegistration 'deactivate' $status.root $SelectedNna") > 0);
  // The shortcut launcher starts the service through the NNA desktop surface.
  const launcher = await readFile(resolve('scripts/launch-selected-desktop.ps1'), 'utf8');
  assert.ok(launcher.includes('desktop start'));
  assert.ok(!launcher.includes('nnd start'));
  // Shortcuts carry NNA branding.
  assert.ok(source.includes('"NotNativeAgent.lnk"'));
  assert.ok(!source.includes('"NotNativeDesktop.lnk"'));
  assert.ok(source.includes('notnative-agent.ico'));
  // Upgrades remove the pre-rename shortcut.
  assert.ok(source.includes("Remove-Item -LiteralPath $staleShortcut -Force"));
});

test('a stale controller discovery record is recovered through foreground takeover',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t); await mkdir(f.target); await f.register();
    await writeFile(join(f.data, 'owner-stale'), 'yes');
    const result = await verifyFreshSourceService(f.root, f.target, f.installationId, f.dataId);
    assert.equal(result.state, 'fresh_service_verified');
    assert.equal(existsSync(join(f.data, 'owner-stale')), false); // takeover consumed the stale record
  });

test('upgraded registration without a running service verifies stopped and rejects a running one',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    await mkdir(f.target, { recursive: true });
    await f.register();
    await writeFile(join(f.data, 'service-stopped'), 'yes');
    const result = await verifyUpgradedStoppedService(f.root, f.target, f.installationId, f.dataId);
    assert.equal(result.state, 'upgrade_registered_stopped');
    assert.equal(result.service_state, 'stopped');
    assert.equal(result.installation_id, f.installationId);
    await rm(join(f.data, 'service-stopped'));
    await assert.rejects(verifyUpgradedStoppedService(f.root, f.target, f.installationId, f.dataId),
      /upgrade_service_started_unexpectedly/u);
  });
