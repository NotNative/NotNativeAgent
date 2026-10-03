// SPDX-License-Identifier: Apache-2.0
/** Real Chromium shell attachment using disposable native and GUI payloads. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSupervisedFixture, removeSupervisedFixture } from './supervised-smoke-fixture.mjs';
import { writeNnaSelection } from './write-nna-selection.mjs';
import { readSelectedNativeRuntime } from '../packages/electron/native-service-client.mjs';
import { withTimeout } from './smoke-http.mjs';
import { verifyPrebuiltPayload } from './prebuilt-payload-validation.mjs';
import { nativeConfigurationWriteExpression } from './electron-native-configuration-browser.mjs';

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
async function prepareShell(fixture, root, nativeConfiguration = false, service = null, nativeWrite = false, tuiWrite = false, routeWrite = false, nativeReplayGap = false) {
  const from = join(root, 'packages/electron'), to = join(fixture.gui, 'packages/electron');
  if (!fixture.prebuilt) await copySourceShell(fixture, from, to);
  else {
    // Mirror installer-owned selection after the signed payload was admitted.
    const selected = readSelectedNativeRuntime(fixture.install);
    await writeNnaSelection(fixture.gui, fixture.install, selected.installation_id, selected.data_id);
  }
  const harness = join(fixture.prebuilt ? fixture.root : fixture.gui, 'electron-smoke.mjs');
  const shellData = join(fixture.root, 'shell-data'); await mkdir(shellData);
  await writeFile(harness, shellHarness(shellData, to, nativeConfiguration, service, nativeWrite, tuiWrite, routeWrite, fixture.root,
    nativeReplayGap, pathToFileURL(join(root, 'scripts/electron-native-replay-gap-browser.mjs')).href));
  return { harness, executable: join(fixture.prebuilt ? to : from, 'node_modules/electron/dist/electron.exe') };
}
async function copySourceShell(fixture, from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name === 'package.json')) await cp(join(from, entry.name), join(to, entry.name));
  }
  await cp(join(from, 'assets'), join(to, 'assets'), { recursive: true });
  await writeFile(join(fixture.gui, 'packages/install-mode.txt'), 'script\n');
  const selected = readSelectedNativeRuntime(fixture.install);
  await writeNnaSelection(fixture.gui, fixture.install, selected.installation_id, selected.data_id);
}
function shellHarness(shellData, to, nativeConfiguration, service, nativeWrite, tuiWrite, routeWrite, workspace, nativeReplayGap, replayModuleUrl) {
  const writeExpression = nativeWrite ? nativeConfigurationWriteExpression(workspace, service.installation_id, service.data_id, tuiWrite, routeWrite) : 'null';
  return `import {app} from 'electron';
app.setPath('userData',${JSON.stringify(shellData)});
process.stdout.write('NND_STAGE_BOOT\\n');
let finished=false; const timer=setTimeout(()=>{process.stdout.write('NND_STAGE_TIMEOUT\\n');app.exit(1);},${nativeWrite || nativeReplayGap ? 120000 : 35000});
app.on('browser-window-created',(_event,win)=>{
  process.stdout.write('NND_STAGE_WINDOW\\n');
  queueMicrotask(()=>win.removeAllListeners('ready-to-show'));
  if(${JSON.stringify(nativeReplayGap)})win.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
    let target=false;try{target=['/api/global/event/ws','/api/event'].includes(new URL(details.url).pathname);}catch{}
    callback({cancel:target});
  });
  win.webContents.on('did-finish-load',async()=>{
    process.stdout.write('NND_STAGE_LOADED '+new URL(win.webContents.getURL()).protocol+'\\n');
    if(finished||!win.webContents.getURL().startsWith('http://127.0.0.1:'))return;
    finished=true;
    try {
      const result=await win.webContents.executeJavaScript('(async()=>({authenticated:(await(await fetch("/auth/session")).json()).authenticated,token:window.__NOTNATIVE_CLIENT_TOKEN__||"",headers:window.__NOTNATIVE_RUNTIME_HEADERS__||{}}))()');
      if(!result.authenticated||result.token||Object.keys(result.headers).length)throw new Error();
      if(${JSON.stringify(nativeConfiguration)}){
        const configuration=await win.webContents.executeJavaScript('(async()=>{const response=await fetch("/api/v1/nnd/configuration");return {status:response.status,view:await response.json()}})()');
        if(configuration.status!==200||configuration.view?.schema_version!=="1.0"
          ||configuration.view?.source_state!=="missing"||configuration.view?.application!=="not_applied"
          ||configuration.view?.installation_id!==${JSON.stringify(service?.installation_id)}
          ||configuration.view?.data_id!==${JSON.stringify(service?.data_id)}
          ||!Array.isArray(configuration.view?.fields))throw new Error('Native configuration projection unavailable');
        process.stdout.write('NND_NATIVE_CONFIGURATION_OK\\n');
      }
      if(${JSON.stringify(nativeWrite)}){
        const mutation=await win.webContents.executeJavaScript(${JSON.stringify(writeExpression)});
        if(!/^[a-f0-9]{64}$/.test(mutation?.source_revision)||!/^[a-f0-9-]{36}$/.test(mutation?.operation_id)
          || ${JSON.stringify(tuiWrite)} && (!/^[a-f0-9]{64}$/.test(mutation?.tui?.source_revision)
            || !/^[a-f0-9-]{36}$/.test(mutation?.tui?.operation_id))
          || ${JSON.stringify(routeWrite)} && (!/^[a-f0-9]{64}$/.test(mutation?.route?.source_revision)
            || !/^[a-f0-9-]{36}$/.test(mutation?.route?.operation_id)))
          throw new Error('Native configuration UI mutation evidence missing');
        process.stdout.write('NND_NATIVE_CONFIGURATION_WRITE_OK\\n');
        if(${JSON.stringify(tuiWrite)})process.stdout.write('NND_NATIVE_TUI_WRITE_OK\\n');
        if(${JSON.stringify(routeWrite)})process.stdout.write('NND_NATIVE_ROUTE_WRITE_OK\\n');
      }
      if(${JSON.stringify(nativeReplayGap)}){
        const {runNativeReplayGapBrowser}=await import(${JSON.stringify(replayModuleUrl)});
        const replay=await runNativeReplayGapBrowser(win);
        if(!replay.priorCursorPresent||!replay.nativeGap||!replay.sidebarRecovered
          ||!replay.activityGapVisible||!replay.cursorReset)throw new Error('Native replay gap evidence missing');
        process.stdout.write('NND_NATIVE_REPLAY_GAP_OK\\n');
      }
      process.stdout.write('NND_NATIVE_CHROMIUM_OK\\n'); clearTimeout(timer); app.quit();
    } catch(error) {process.stderr.write('Chromium scenario failed: '+String(error).slice(0,1000)+'\\n');clearTimeout(timer);app.exit(1);}
  });
});
await import(${JSON.stringify(pathToFileURL(join(to, 'main.mjs')).href)});
`;
}

async function main(nna, payloadRoot = null, nativeSlot = false, nativeConfiguration = false, nativeWrite = false, tuiWrite = false, routeWrite = false, nativeReplayGap = false) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = await createSupervisedFixture(nna, root, { payloadRoot, nativeSlot });
  let electron, electronExit, stopped = false, output = '', diagnostics = '';
  try {
    if (nativeReplayGap) await writeReplayGapManifest(fixture, nna);
    const service = await runCli(fixture, 'start');
    const shell = await prepareShell(fixture, root, nativeConfiguration, service, nativeWrite, tuiWrite, routeWrite, nativeReplayGap);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_PATH;
    const args = [shell.harness, '--hidden', ...(fixture.prebuilt ? ['--nna-install-root', fixture.install] : [])];
    electron = spawn(shell.executable, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    electronExit = once(electron, 'exit');
    electron.stdout.on('data', (chunk) => { output += chunk; if (output.length > 65536) electron.kill(); });
    electron.stderr.on('data', (chunk) => { if (diagnostics.length < 65536) diagnostics += String(chunk).slice(0, 65536 - diagnostics.length); });
    assert.equal((await withTimeout(electronExit, nativeWrite || nativeReplayGap ? 135_000 : 45_000, 'Real Electron shell timeout'))[0], 0);
    assertSmokeMarkers(output, { nativeReplayGap, nativeConfiguration, nativeWrite, tuiWrite, routeWrite });
    if (nativeWrite) {
      const manifest = JSON.parse(await readFile(join(fixture.data, 'config/manifest.json'), 'utf8'));
      assert.equal(manifest.memory?.enabled, false, 'Native selected source must contain the UI-saved value');
      assert.equal(manifest.workspace_root, fixture.root, 'Repair must write only the disposable selected workspace');
      assert.equal(manifest.provider?.id, 'local', 'Repair must publish the user-supplied native provider');
      if (tuiWrite) assert.equal(manifest.tui?.key_bindings?.submit, 'ctrl+x', 'Native terminal binding must be saved');
      if (routeWrite) assert.equal(manifest.routes?.reviewer?.temperature, 0.35, 'Native reviewer tuning must be saved');
    }
    const after = await runCli(fixture, 'status'); assert.equal(after.instance_id, service.instance_id);
    const browser = await fetch(`${after.endpoint}/auth/session`, { signal: AbortSignal.timeout(5000) });
    assert.equal((await browser.json()).authenticated, false, 'Chromium admission must not unlock another browser');
    if (nativeWrite) {
      const denied = await fetch(`${after.endpoint}/api/v1/nnd/configuration`, { signal: AbortSignal.timeout(5000) });
      assert.equal(denied.status, 401, 'Unauthenticated browser must not read native configuration');
      const deniedSave = await fetch(`${after.endpoint}/api/v1/nnd/configuration/save`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
      assert.equal(deniedSave.status, 401, 'Unauthenticated browser must not reach native mutation validation');
    }
    await runCli(fixture, 'stop');
    await waitStopped(fixture); stopped = true;
    if (fixture.prebuilt) {
      await unlink(join(fixture.gui, 'nna-service-selection.json'));
      const copied = await verifyPrebuiltPayload(fixture.gui), original = await verifyPrebuiltPayload(payloadRoot);
      assert.equal(copied.sha256, original.sha256, 'Runtime probe must not modify the immutable payload');
    }
    process.stdout.write('Real Electron native attachment passed: Chromium cookie admission, no renderer bearer, isolated browser and service survives shell quit.\n');
  } catch (error) {
    const log = await readFile(join(fixture.root, 'shell-data/logs/main.log'), 'utf8').catch(() => 'No shell log');
    await writeFile(join(root, '.tmp-nnd-electron-native-shell.log'), `${output}\n${diagnostics}\n${log.slice(-65536)}`);
    throw error;
  } finally {
    let shellStopped = !electron || electron.exitCode !== null || !electron.pid;
    if (!shellStopped) {
      try { electron.kill(); await withTimeout(electronExit, 5000, 'Owned Electron cleanup timeout'); shellStopped = true; }
      catch { process.stderr.write(`Electron cleanup incomplete; preserved disposable fixture: ${fixture.root}\n`); }
    }
    if (!stopped) {
      try { await runCli(fixture, 'stop'); await waitStopped(fixture); stopped = true; }
      catch { process.stderr.write(`Cleanup incomplete; preserved disposable fixture: ${fixture.root}\n`); }
    }
    if (stopped && shellStopped) await removeSupervisedFixture(fixture.root);
  }
}
function assertSmokeMarkers(output, { nativeReplayGap, nativeConfiguration, nativeWrite, tuiWrite, routeWrite }) {
  assert.ok(output.includes('NND_NATIVE_CHROMIUM_OK'));
  if (nativeReplayGap) assert.ok(output.includes('NND_NATIVE_REPLAY_GAP_OK'));
  if (nativeConfiguration) assert.ok(output.includes('NND_NATIVE_CONFIGURATION_OK'));
  if (nativeWrite) assert.ok(output.includes('NND_NATIVE_CONFIGURATION_WRITE_OK'));
  if (tuiWrite) assert.ok(output.includes('NND_NATIVE_TUI_WRITE_OK'));
  if (routeWrite) assert.ok(output.includes('NND_NATIVE_ROUTE_WRITE_OK'));
}
async function writeReplayGapManifest(fixture, nna) {
  // This source-only scenario creates idle sessions; no provider request is sent.
  // Give its private NNA data root a valid route so native engine admission works.
  await cp(join(nna, 'docs'), join(fixture.install, 'installed/docs'), { recursive: true });
  await writeFile(join(fixture.data, 'config/manifest.json'), JSON.stringify({
    format_version: 1, persistence: 'ephemeral', workspace_root: fixture.root,
    providers: [{ id: 'smoke', display_name: 'Disposable smoke', endpoint: 'http://127.0.0.1:9/v1',
      model: 'test', trust_zone: 'loopback' }],
    routes: { primary: { provider_id: 'smoke', model: 'test' } },
  }));
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
export function parseElectronSmokeArguments(args) {
  if (args.length === 2 && isAbsolute(args[0] ?? '') && args[1] === '--native-replay-gap') {
    return { nna: resolve(args[0]), payloadRoot: null, nativeReplayGap: true };
  }
  if (args.length === 4 && isAbsolute(args[0] ?? '') && args[1] === '--native-configuration'
    && args[2] === '--native-configuration-write' && args[3] === '--native-tui-write') {
    return { nna: resolve(args[0]), payloadRoot: null, nativeConfiguration: true, nativeWrite: true, tuiWrite: true };
  }
  if (args.length === 4 && isAbsolute(args[0] ?? '') && args[1] === '--native-configuration'
    && args[2] === '--native-configuration-write' && args[3] === '--native-routes-write') {
    return { nna: resolve(args[0]), payloadRoot: null, nativeConfiguration: true, nativeWrite: true, routeWrite: true };
  }
  if (![1, 3, 4, 5, 6, 7].includes(args.length) || !isAbsolute(args[0] ?? '')
    || args.length >= 3 && (args[1] !== '--payload' || !isAbsolute(args[2]))
    || args.length >= 4 && args[3] !== '--native-slot'
    || args.length >= 5 && args[4] !== '--native-configuration'
    || args.length >= 6 && args[5] !== '--native-configuration-write'
    || args.length === 7 && !['--native-tui-write', '--native-routes-write'].includes(args[6])) {
    throw new Error('usage: electron-native-attach-smoke.mjs ABSOLUTE_NNA_SOURCE [--native-replay-gap | --payload ABSOLUTE_EXPORTED_ROOT [--native-slot [--native-configuration [--native-configuration-write [--native-tui-write|--native-routes-write]]]]]');
  }
  return { nna: resolve(args[0]), payloadRoot: args.length >= 3 ? resolve(args[2]) : null,
    ...(args.length >= 4 ? { nativeSlot: true } : {}), ...(args.length >= 5 ? { nativeConfiguration: true } : {}),
    ...(args.length >= 6 ? { nativeWrite: true } : {}),
    ...(args.length === 7 && args[6] === '--native-tui-write' ? { tuiWrite: true } : {}),
    ...(args.length === 7 && args[6] === '--native-routes-write' ? { routeWrite: true } : {}) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'win32') throw new Error('Native Electron smoke requires Windows');
  const { nna, payloadRoot, nativeSlot, nativeConfiguration, nativeWrite, tuiWrite, routeWrite, nativeReplayGap } = parseElectronSmokeArguments(process.argv.slice(2));
  await main(nna, payloadRoot, nativeSlot, nativeConfiguration, nativeWrite, tuiWrite, routeWrite, nativeReplayGap);
}
