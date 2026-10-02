// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ensureUserDataPaths, userDataPaths } from '../src/product.js';
import { startNndSupervisor } from '../src/nnd-service-supervisor.js';
import { readNndServiceDiscovery } from '../src/nnd-service-discovery.js';
import { requestNndController } from '../src/nnd-service-controller.js';
import { nativeNndPrincipal, startNndNativeService } from '../src/nnd-service-native.js';
import { admitFreshNndServiceData } from '../src/nnd-service-admission.js';
import { startIntegrationServer } from '../src/integration-server.js';
import { createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { acquireNndServiceLock } from '../src/nnd-service-lock.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = process.platform === 'win32' ? join(homedir(), `.nna-supervisor-${randomUUID()}`)
    : await mkdtemp(join(tmpdir(), 'nna-supervisor-'));
  if (process.platform === 'win32') {
    const result = spawnSync(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd();
      $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=[Security.AccessControl.DirectorySecurity]::new();
      $acl.SetSecurityDescriptorSddlForm('O:'+$sid+'D:P(A;OICI;FA;;;'+$sid+')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)');
      [void][IO.Directory]::CreateDirectory($p,$acl)`], { input: root, encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
  }
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = await ensureUserDataPaths(userDataPaths({ environment: { NNA_HOME: join(root, 'data') } }));
  const data_root = await realpath(paths.root);
  const identity = { installation_id: `nna_${hash(root.toLowerCase())}`, data_id: `data_${hash(data_root.toLowerCase())}`,
    install_root: root, data_root, node: process.execPath, node_major: Number(process.versions.node.split('.')[0]),
    platform: process.platform, architecture: process.arch };
  return { root, paths, identity };
}
async function packageFixture(root, paths) {
  const pkg = join(root, 'package');
  await mkdir(join(pkg, 'nna-integration/nnd-local'), { recursive: true });
  await mkdir(join(pkg, 'packages/electron/dist-server'), { recursive: true });
  await mkdir(join(pkg, 'packages/web/dist'), { recursive: true });
  const version = '20261002-1', bundle = 'export const built = true;';
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ nnd_version: version }));
  await writeFile(join(pkg, 'packages/electron/dist-server/server.mjs'), bundle);
  await writeFile(join(pkg, 'packages/web/dist/index.html'), '<html></html>');
  await writeFile(join(pkg, 'child.mjs'), `import {createInterface} from 'node:readline';
const r=createInterface({input:process.stdin}); let b;
r.on('line',line=>{const v=JSON.parse(line); if(!b){b=v; console.log(JSON.stringify({type:'ready',protocol:'1.0',installation_id:b.installation_id,data_id:b.data_id,generation:b.generation,endpoint:b.ui_origin,version:'${version}'}));}
else console.log(JSON.stringify({type:'ui_ticket',protocol:'1.0',generation:b.generation,request_id:v.request_id,ticket:'one-use-ticket',expires_at:new Date(Date.now()+30000).toISOString()}));});
r.on('close',()=>process.exit(0));`);
  await writeFile(join(pkg, 'nna-integration/nnd-local/integration.json'), JSON.stringify({ id: 'nnd-local',
    ownership: 'nnd', scope: 'local-gui', nna_integration_protocol: '1.0', version, service_activation: {
      schema_version: '1.0', required_capabilities: ['service_supervision', 'setup_control_plane'],
      data_schemas: { nnd_catalog: 1, nnd_state: 1 }, platform: 'win32', architecture: process.arch,
      runtime: { name: 'node', minimum_major: 24 }, entrypoint: 'child.mjs',
      bundle_identity: { path: 'packages/electron/dist-server/server.mjs', sha256: hash(bundle) },
      authenticated_callbacks: { token_exchange: 'protected_stdin', protocol: '1.0' },
    } }));
  await writeFile(join(paths.config, 'nnd-package.json'), JSON.stringify({ root: pkg, version, protocol: '1.0' }));
}

test('supervisor composes singleton, private child, controller, setup runtime and owned cleanup', { skip: process.platform !== 'win32', timeout: 60000 }, async (t) => {
  const { root, paths, identity } = await fixture(t); await packageFixture(root, paths);
  const owner = await startNndSupervisor(identity, paths);
  try {
    await assert.rejects(startNndSupervisor(identity, paths), { code: 'nnd_service_already_running' });
    const record = await readNndServiceDiscovery(identity);
    const status = await requestNndController(record, 'status');
    assert.equal(status.service_state, 'setup_required'); assert.equal(status.provider_state, 'unknown');
    assert.equal(JSON.stringify(status).includes(record.control_token), false);
    await assert.rejects(requestNndController({ ...record, instance_id: 'wrong' }, 'stop'), { code: 'nnd_health_unavailable' });
    const ticket = await requestNndController(record, 'ui-ticket'); assert.equal(ticket.ticket, 'one-use-ticket');
    await requestNndController(record, 'stop'); await owner.stopped;
    assert.equal(await readNndServiceDiscovery(identity), null);
    const again = await startNndSupervisor(identity, paths); await again.stop();
  } finally { await owner.stop(); }
});

test('native fixed authority ignores child headers and binds only configured workspace', async (t) => {
  const { paths, identity } = await fixture(t);
  const service = await startNndNativeService(paths, identity);
  try {
    const headers = { authorization: `Bearer ${service.token}`, 'x-nna-principal': Buffer.from(JSON.stringify({ permissions: ['*'] })).toString('base64url') };
    const response = await fetch(`${service.endpoint}/v1/nnd/setup/status`, { headers });
    assert.equal(response.status, 200);
    const secrets = await fetch(`${service.endpoint}/v1/secrets`, { headers });
    assert.equal(secrets.status, 200);
    assert.deepEqual(nativeNndPrincipal(null).workspaceIds, []);
    assert.notDeepEqual(nativeNndPrincipal('C:\\one').workspaceIds, nativeNndPrincipal('C:\\two').workspaceIds);
    assert.equal(nativeNndPrincipal('C:\\one').permissions.includes('secret.use'), false);
    assert.equal(nativeNndPrincipal('C:\\one').permissions.includes('*'), false);
  } finally { await service.close(); }
});

test('configured NNA with TUI history starts supervised NND without altering native files', { skip: process.platform !== 'win32', timeout: 30000 }, async (t) => {
  const { root, paths, identity } = await fixture(t); await packageFixture(root, paths);
  const manifestPath = join(paths.config, 'manifest.json');
  const manifest = JSON.stringify({ format_version: 1, persistence: 'ephemeral', workspace_root: root,
    provider: { id: 'primary', endpoint: 'http://127.0.0.1:1/v1', model: 'test', trust_zone: 'loopback' } });
  await writeFile(manifestPath, manifest);
  const tabs = join(paths.rootTui, 'pool.json'); await writeFile(tabs, 'existing-tui-state');
  const journal = join(paths.sessions, 'ordinary.journal.ndjson'); await writeFile(journal, 'existing-tui-history');
  const owner = await startNndSupervisor(identity, paths);
  try {
    assert.equal(owner.status().service_state, 'ready'); assert.equal(owner.status().provider_state, 'unknown');
    assert.equal(await readFile(manifestPath, 'utf8'), manifest);
    assert.equal(await readFile(tabs, 'utf8'), 'existing-tui-state');
    assert.equal(await readFile(journal, 'utf8'), 'existing-tui-history');
  } finally { await owner.stop(); }
});

test('existing data admission preserves catalog and requires explicit migration', { skip: process.platform !== 'win32' }, async (t) => {
  const { paths, identity } = await fixture(t);
  const catalog = join(paths.sessions, 'nnd-contexts.json'); await writeFile(catalog, 'legacy');
  const lease = await acquireNndServiceLock({ dataRoot: identity.data_root });
  try { await assert.rejects(admitFreshNndServiceData(paths, identity, lease), { code: 'nnd_owner_unverified' }); }
  finally { await lease.close(); }
  assert.equal(await readFile(catalog, 'utf8'), 'legacy');
});

test('native request drain retains a provider writer after its client socket closes', async () => {
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const mutation = new Promise((resolve) => { release = resolve; });
  const store = { inventory() {}, get() {}, remove() {}, withCredential() {}, update() {},
    async create() { entered(); await mutation; return { id: 'saved' }; } };
  const token = 'a'.repeat(43);
  const service = await startIntegrationServer({ activation: createNndLocalIntegrationActivation(), token,
    providerStore: store, resolvePrincipal: () => nativeNndPrincipal(null) });
  const request = fetch(`http://127.0.0.1:${service.address.port}/v1/provider-profiles`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
  }).catch(() => null);
  await started;
  service.stopAdmission(); const closed = service.close(); service.server.closeAllConnections(); await closed;
  let drained = false; const drain = service.drain().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  release(); await drain; await request; assert.equal(drained, true);
});
