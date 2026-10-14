// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { writeInstalledServiceManifest } from './installed-service-package.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nnd-supervised-')));
  t.after(async () => { assert.ok(root.includes('nnd-supervised-')); await rm(root, { recursive: true, force: true }); });
  for (const path of ['scripts', 'packages/electron/dist-server', 'packages/web/dist']) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '20261002.0.2', nnd_version: '20261002-2' }));
  await writeFile(join(root, 'VERSION'), '20261002-2');
  await writeFile(join(root, 'scripts/serve-installed.mjs'), '// fixture');
  await writeFile(join(root, 'packages/web/dist/index.html'), '<!doctype html>');
  await writeFile(join(root, 'packages/electron/dist-server/server.mjs'), `
    import { createServer } from 'node:http';
    export async function startServer(options) {
      if (!options.nativeAuth || !options.nativeHarness || !options.nativeHealthProof
        || options.nativeHealthProof.key !== '${Buffer.alloc(32, 0x58).toString('base64url')}' || process.env.NNA_INTEGRATION_TOKEN
        || process.env.NOTNATIVE_NNA_MODE !== 'attach') throw new Error('invalid private startup');
      const server = createServer((_req,res) => res.end('fixture'));
      const closed = new Promise(resolve => server.once('close', resolve));
      await new Promise((resolve,reject) => { server.once('error',reject); server.listen(Number(process.env.NOTNATIVE_PORT),'127.0.0.1',resolve); });
      return {port: Number(process.env.NOTNATIVE_PORT),closed,dispose(){server.close();server.closeAllConnections();},
        nativeAuth:{issueTicket(){return {ticket:'test-ui-only-ticket',expiresAt:new Date(Date.now()+60000).toISOString()};}},
        browserCallback: process.env.NND_TEST_BROWSER_CALLBACK
          ? { url: 'http://127.0.0.1:' + Number(process.env.NOTNATIVE_PORT) + '/api/browser-control/request',
            token: Buffer.alloc(32, 0x62).toString('base64url') }
          : undefined};
    }`);
  await writeInstalledServiceManifest(root);
  return root;
}
function launch(root, extraEnv = {}) {
  const runner = new URL('./serve-supervised.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {runSupervisedService} from ${JSON.stringify(runner)}; await runSupervisedService({root:${JSON.stringify(root)}});`],
    { windowsHide: true, stdio: ['pipe','pipe','pipe'], env: { ...process.env, NNA_INTEGRATION_TOKEN: 'inherited-must-clear', ...extraEnv } });
  child.stderr.pipe(process.stderr);
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exited = once(child, 'exit');
  return { child, exited, send: (frame) => child.stdin.write(JSON.stringify(frame) + '\n'),
    next: async () => JSON.parse((await lines.next()).value) };
}
async function bootstrap(root, engineEndpoint = 'http://127.0.0.1:4555') {
  const { createServer } = await import('node:net');
  const listener = createServer(); listener.listen(0,'127.0.0.1'); await once(listener,'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const hash = createHash('sha256').update(root.toLowerCase()).digest('hex');
  return { type:'bootstrap',protocol:'1.0',installation_id:`nna_${hash}`,data_id:`data_${hash}`,generation:'fixture',
    nna_install_root:root,nna_data_root:root,nnd_data_root:root,ui_origin:`http://127.0.0.1:${port}`,
    health_key:Buffer.alloc(32,0x58).toString('base64url'),
    engine:{endpoint:engineEndpoint,token:'a'.repeat(32),capability:'cap_1abcdef.sig_abcdef12345'} };
}
const windows = { skip: process.platform !== 'win32', timeout: 15000 };
test('private installed process redeems commands and acknowledges only closed listener', windows, async (t) => {
  const root = await fixture(t); const run = launch(root); t.after(() => run.child.kill());
  const boot = await bootstrap(root); run.send(boot);
  assert.equal((await run.next()).type,'ready');
  run.send({type:'issue_ui_ticket',protocol:'1.0',generation:boot.generation,request_id:'ticket'});
  const ticket = await run.next(); assert.equal(ticket.type,'ui_ticket'); assert.equal(ticket.ticket,'test-ui-only-ticket');
  run.send({type:'stop',protocol:'1.0',generation:boot.generation,request_id:'stop'});
  assert.equal((await run.next()).type,'stopped'); assert.equal((await run.exited)[0],0);
  await assert.rejects(fetch(boot.ui_origin));
});
test('duplicate bootstrap fails closed and EOF tears down the listener', windows, async (t) => {
  const root = await fixture(t);
  for (const duplicate of [true,false]) {
    const run = launch(root); t.after(() => run.child.kill()); const boot = await bootstrap(root);
    run.send(boot); assert.equal((await run.next()).type,'ready');
    if (duplicate) { run.send(boot); assert.equal((await run.next()).type,'failed'); } else run.child.stdin.end();
    await run.exited; await assert.rejects(fetch(boot.ui_origin));
  }
});

test('the supervised child spawns the service-owned tray host after readiness', windows, async (t) => {
  const root = await fixture(t);
  const marker = join(root, 'tray-launched');
  const runner = new URL('./serve-supervised.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import {runSupervisedService} from ${JSON.stringify(runner)};
     await runSupervisedService({root:${JSON.stringify(root)}, launchTray: async () => {
       const {writeFile} = await import('node:fs/promises');
       await writeFile(${JSON.stringify(marker)}, 'tray');
     }});`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const boot = await bootstrap(root);
  child.stdin.write(JSON.stringify(boot) + '\n');
  assert.equal(JSON.parse((await lines.next()).value).type, 'ready');
  // The launch is fire-and-forget: the command loop answers while it runs.
  child.stdin.write(JSON.stringify({ type: 'issue_ui_ticket', protocol: '1.0', generation: boot.generation, request_id: 't1' }) + '\n');
  assert.equal(JSON.parse((await lines.next()).value).type, 'ui_ticket');
  const { access, constants } = await import('node:fs/promises');
  const deadline = Date.now() + 5000;
  for (;;) {
    try { await access(marker, constants.F_OK); break; }
    catch { if (Date.now() >= deadline) throw new Error('tray launch never ran'); await new Promise(r => setTimeout(r, 100)); }
  }
});

test('the default Windows tray launch executes its PowerShell host', windows, async (t) => {
  const root = await fixture(t);
  const marker = join(root, 'tray-spawned');
  await writeFile(join(root, 'scripts/nnd-tray-host.ps1'),
    "param([string]$DataRoot,[string]$InstallRoot,[string]$NodePath)\n" +
    "[IO.File]::WriteAllText((Join-Path $InstallRoot 'tray-spawned'), 'ok')\n");
  const run = launch(root);
  t.after(() => run.child.kill());
  const boot = await bootstrap(root);
  run.send(boot);
  assert.equal((await run.next()).type, 'ready');
  const { access } = await import('node:fs/promises');
  const deadline = Date.now() + 5000;
  for (;;) {
    try { await access(marker); break; }
    catch {
      if (Date.now() >= deadline) throw new Error('PowerShell tray host did not execute');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  run.send({ type: 'stop', protocol: '1.0', generation: boot.generation, request_id: 'stop' });
  assert.equal((await run.next()).type, 'stopped');
});

test('the supervised child accepts and acknowledges supervisor-pushed capabilities', windows, async (t) => {
  const root = await fixture(t);
  const run = launch(root); t.after(() => run.child.kill());
  const boot = await bootstrap(root); run.send(boot);
  assert.equal((await run.next()).type, 'ready');
  run.send({ type: 'apply_capability', protocol: '1.0', generation: boot.generation,
    request_id: 'cap1', capability: 'cap_1.signature_1' });
  assert.equal((await run.next()).type, 'applied');
  // The service keeps serving tickets after a capability push.
  run.send({ type: 'issue_ui_ticket', protocol: '1.0', generation: boot.generation, request_id: 'ticket' });
  assert.equal((await run.next()).type, 'ui_ticket');
  // A pushed capability beyond the bounded shape fails the protocol closed.
  run.send({ type: 'apply_capability', protocol: '1.0', generation: boot.generation,
    request_id: 'cap2', capability: 'not-a-capability' });
  assert.equal((await run.next()).type, 'failed');
});

test('the supervised child registers the browser callback with the integration host', windows, async (t) => {
  const root = await fixture(t);
  const { createServer } = await import('node:http');
  const registrations = [];
  const host = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      registrations.push({ method: request.method, path: request.url,
        authorization: request.headers.authorization,
        capability: request.headers['x-nna-service-capability'],
        body: JSON.parse(body || 'null') });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ registered: true }));
    });
  });
  host.listen(0, '127.0.0.1'); await once(host, 'listening');
  const hostPort = host.address().port;
  t.after(() => new Promise((resolve) => host.close(resolve)));
  const run = launch(root, { NND_TEST_BROWSER_CALLBACK: '1' });
  t.after(() => run.child.kill());
  const boot = await bootstrap(root, 'http://127.0.0.1:' + hostPort);
  run.send(boot);
  assert.equal((await run.next()).type, 'ready');
  assert.equal(registrations.length, 1, 'the child did not register exactly once');
  const registration = registrations[0];
  assert.equal(registration.method, 'POST');
  assert.equal(registration.path, '/internal/nnd/browser-callback');
  assert.equal(registration.authorization, 'Bearer ' + 'a'.repeat(32));
  assert.equal(registration.capability, 'cap_1abcdef.sig_abcdef12345');
  assert.equal(registration.body.url, boot.ui_origin + '/api/browser-control/request');
  assert.equal(registration.body.token, Buffer.alloc(32, 0x62).toString('base64url'));
  run.send({ type: 'stop', protocol: '1.0', generation: boot.generation, request_id: 'stop' });
  assert.equal((await run.next()).type, 'stopped');
});
