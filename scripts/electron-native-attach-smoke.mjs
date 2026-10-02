// SPDX-License-Identifier: Apache-2.0
/** Real Chromium shell attachment using disposable native and GUI payloads. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSupervisedFixture, removeSupervisedFixture } from './supervised-smoke-fixture.mjs';
import { writeNnaSelection } from './write-nna-selection.mjs';
import { withTimeout } from './smoke-http.mjs';

async function runCli(fixture, action) {
  const child = spawn(process.execPath, [fixture.cli, 'nnd', 'service', action, fixture.install],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NNA_HOME: fixture.data } });
  const exit = once(child, 'exit'); let text = '';
  child.stdout.on('data', (chunk) => { text += chunk; if (text.length > 65536) child.kill(); });
  child.stderr.on('data', () => {});
  try { assert.equal((await withTimeout(exit, 30_000, 'Native CLI timeout'))[0], 0); }
  catch (error) { child.kill(); await withTimeout(exit, 5000, 'Owned native CLI did not exit'); throw error; }
  return JSON.parse(text.trim());
}
async function prepareShell(fixture, root) {
  const from = join(root, 'packages/electron'), to = join(fixture.gui, 'packages/electron');
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name === 'package.json')) await cp(join(from, entry.name), join(to, entry.name));
  }
  await cp(join(from, 'assets'), join(to, 'assets'), { recursive: true });
  await writeFile(join(fixture.gui, 'packages/install-mode.txt'), 'script\n');
  await writeNnaSelection(fixture.gui, fixture.install);
  const harness = join(fixture.gui, 'electron-smoke.mjs');
  const shellData = join(fixture.root, 'shell-data'); await mkdir(shellData);
  await writeFile(harness, `import {app} from 'electron';
app.setPath('userData',${JSON.stringify(shellData)});
process.stdout.write('NND_STAGE_BOOT\\n');
let finished=false; const timer=setTimeout(()=>{process.stdout.write('NND_STAGE_TIMEOUT\\n');app.exit(1);},35000);
app.on('browser-window-created',(_event,win)=>{
  process.stdout.write('NND_STAGE_WINDOW\\n');
  queueMicrotask(()=>win.removeAllListeners('ready-to-show'));
  win.webContents.on('did-finish-load',async()=>{
    process.stdout.write('NND_STAGE_LOADED '+new URL(win.webContents.getURL()).protocol+'\\n');
    if(finished||!win.webContents.getURL().startsWith('http://127.0.0.1:'))return;
    finished=true;
    try {
      const result=await win.webContents.executeJavaScript('(async()=>({authenticated:(await(await fetch("/auth/session")).json()).authenticated,token:window.__NOTNATIVE_CLIENT_TOKEN__||"",headers:window.__NOTNATIVE_RUNTIME_HEADERS__||{}}))()');
      if(!result.authenticated||result.token||Object.keys(result.headers).length)throw new Error();
      process.stdout.write('NND_NATIVE_CHROMIUM_OK\\n'); clearTimeout(timer); app.quit();
    } catch {clearTimeout(timer);app.exit(1);}
  });
});
await import(${JSON.stringify(pathToFileURL(join(to, 'main.mjs')).href)});
`);
  return { harness, executable: join(from, 'node_modules/electron/dist/electron.exe') };
}

async function main(nna) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = await createSupervisedFixture(nna, root);
  let electron, electronExit, stopped = false, output = '', diagnostics = '';
  try {
    const service = await runCli(fixture, 'start');
    const shell = await prepareShell(fixture, root);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_PATH;
    electron = spawn(shell.executable, [shell.harness, '--hidden'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    electronExit = once(electron, 'exit');
    electron.stdout.on('data', (chunk) => { output += chunk; if (output.length > 65536) electron.kill(); });
    electron.stderr.on('data', (chunk) => { if (diagnostics.length < 65536) diagnostics += String(chunk).slice(0, 65536 - diagnostics.length); });
    assert.equal((await withTimeout(electronExit, 45_000, 'Real Electron shell timeout'))[0], 0);
    assert.ok(output.includes('NND_NATIVE_CHROMIUM_OK'));
    const after = await runCli(fixture, 'status'); assert.equal(after.instance_id, service.instance_id);
    const browser = await fetch(`${after.endpoint}/auth/session`, { signal: AbortSignal.timeout(5000) });
    assert.equal((await browser.json()).authenticated, false, 'Chromium admission must not unlock another browser');
    await runCli(fixture, 'stop');
    await waitStopped(fixture); stopped = true;
    process.stdout.write('Real Electron native attachment passed: Chromium cookie admission, no renderer bearer, isolated browser and service survives shell quit.\n');
  } catch (error) {
    const log = await readFile(join(fixture.root, 'shell-data/logs/main.log'), 'utf8').catch(() => 'No shell log');
    await writeFile(join(root, '.tmp-nnd-electron-native-shell.log'), `${output}\n${diagnostics}\n${log.slice(-65536)}`);
    throw error;
  } finally {
    if (electron && electron.exitCode === null) { electron.kill(); await withTimeout(electronExit, 5000, 'Owned Electron cleanup timeout'); }
    if (!stopped) {
      try { await runCli(fixture, 'stop'); await waitStopped(fixture); stopped = true; }
      catch { process.stderr.write(`Cleanup incomplete; preserved disposable fixture: ${fixture.root}\n`); }
    }
    if (stopped) await removeSupervisedFixture(fixture.root);
  }
}
async function waitStopped(fixture) {
  const module = (name) => import(pathToFileURL(join(fixture.install, 'installed/src', name)).href);
  const [{ readNndServiceIdentity }, { readNndServiceDiscovery }, { acquireNndServiceLock }] = await Promise.all([
    module('nnd-service-identity.js'), module('nnd-service-discovery.js'), module('nnd-service-lock.js'),
  ]);
  const identity = await readNndServiceIdentity(fixture.install);
  for (let count = 0; count < 50; count += 1) {
    if (await readNndServiceDiscovery(identity) === null) {
      try {
        const lease = await acquireNndServiceLock({ dataRoot: fixture.data });
        await lease.close(); return;
      } catch (error) { if (error.code !== 'nnd_service_already_running') throw error; }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Native service remained active after stop');
}
if (process.platform !== 'win32' || !process.argv[2]) throw new Error('usage: Windows node scripts/electron-native-attach-smoke.mjs ABSOLUTE_NNA_SOURCE');
await main(resolve(process.argv[2]));
