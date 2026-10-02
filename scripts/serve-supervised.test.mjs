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
      if (!options.nativeAuth || !options.nativeHarness || process.env.NNA_INTEGRATION_TOKEN
        || process.env.NOTNATIVE_NNA_MODE !== 'attach') throw new Error('invalid private startup');
      const server = createServer((_req,res) => res.end('fixture'));
      const closed = new Promise(resolve => server.once('close', resolve));
      await new Promise((resolve,reject) => { server.once('error',reject); server.listen(Number(process.env.NOTNATIVE_PORT),'127.0.0.1',resolve); });
      return {port: Number(process.env.NOTNATIVE_PORT),closed,dispose(){server.close();server.closeAllConnections();},
        nativeAuth:{issueTicket(){return {ticket:'test-ui-only-ticket',expiresAt:new Date(Date.now()+60000).toISOString()};}}};
    }`);
  await writeInstalledServiceManifest(root);
  return root;
}
function launch(root) {
  const runner = new URL('./serve-supervised.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {runSupervisedService} from ${JSON.stringify(runner)}; await runSupervisedService({root:${JSON.stringify(root)}});`],
    { windowsHide: true, stdio: ['pipe','pipe','pipe'], env: { ...process.env, NNA_INTEGRATION_TOKEN: 'inherited-must-clear' } });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exited = once(child, 'exit');
  return { child, exited, send: (frame) => child.stdin.write(JSON.stringify(frame) + '\n'),
    next: async () => JSON.parse((await lines.next()).value) };
}
async function bootstrap(root) {
  const { createServer } = await import('node:net');
  const listener = createServer(); listener.listen(0,'127.0.0.1'); await once(listener,'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const hash = createHash('sha256').update(root.toLowerCase()).digest('hex');
  return { type:'bootstrap',protocol:'1.0',installation_id:`nna_${hash}`,data_id:`data_${hash}`,generation:'fixture',
    nna_install_root:root,nna_data_root:root,nnd_data_root:root,ui_origin:`http://127.0.0.1:${port}`,
    engine:{endpoint:'http://127.0.0.1:4555',token:'a'.repeat(32)} };
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
