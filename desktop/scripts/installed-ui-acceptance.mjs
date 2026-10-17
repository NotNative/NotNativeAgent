// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveActiveNndPackage } from './resolve-active-nnd-package.mjs';
import { attachNativeService, requestNativeServiceStatus } from '../packages/electron/native-service-client.mjs';
import { withTimeout } from './smoke-http.mjs';

function harnessSource(plan, scratch, scenario, marker, reconnectScenario, scenarioInput) {
  return `import { app } from 'electron';
import { writeFile } from 'node:fs/promises';
app.setPath('userData', ${JSON.stringify(join(scratch, 'shell-data'))});
let running = false, phase = 0, latestWindow = null;
const timer = setTimeout(async () => {
  process.stderr.write('Installed UI timed out in phase '+phase+'\\n');
  try { if (latestWindow && !latestWindow.isDestroyed()) await writeFile(${JSON.stringify(join(scratch, 'desktop-failure.png'))}, (await latestWindow.webContents.capturePage()).toPNG()); }
  catch (error) { process.stderr.write('Timeout screenshot unavailable: '+String(error)+'\\n'); }
  finally { app.exit(1); }
}, ${reconnectScenario ? 180000 : 120000});
app.on('browser-window-created', (_event, win) => {
  latestWindow = win;
  if (phase === 0 && ${Boolean(scenarioInput?.sessionId)}) {
    const load = win.webContents.loadURL.bind(win.webContents);
    win.webContents.loadURL = (value, options) => {
      const url = new URL(value);
      if (url.origin.startsWith('http://127.0.0.1:')) url.searchParams.set('session', ${JSON.stringify(scenarioInput?.sessionId ?? '')});
      return load(url.href, options);
    };
  }
  queueMicrotask(() => win.removeAllListeners('ready-to-show'));
  win.webContents.on('did-finish-load', async () => {
    if (running || !win.webContents.getURL().startsWith('http://127.0.0.1:')) return;
    running = true;
    try {
      const result = await win.webContents.executeJavaScript(phase === 0 ? ${JSON.stringify(`(${scenario.toString()})(${JSON.stringify(scenarioInput)})`)} : ${JSON.stringify(reconnectScenario ? `(${reconnectScenario.toString()})(${JSON.stringify(scenarioInput)})` : 'null')});
      if (!result.nativeShell) throw new Error('Installed Electron host not detected');
      if (${Boolean(reconnectScenario)} && phase === 0) {
        if (result.awaitReconnect !== true) throw new Error('Restart scenario did not request reconnect verification');
        phase = 1; running = false; return;
      }
      await writeFile(${JSON.stringify(join(scratch, 'desktop.png'))}, (await win.webContents.capturePage()).toPNG());
      process.stdout.write(${JSON.stringify(marker + ' ')}+JSON.stringify(result)+'\\n'); clearTimeout(timer); app.quit();
    } catch (error) {
      try { await writeFile(${JSON.stringify(join(scratch, 'desktop-failure.png'))}, (await win.webContents.capturePage()).toPNG()); }
      catch (captureError) { process.stderr.write('Failure screenshot unavailable: '+String(captureError)+'\\n'); }
      process.stderr.write(String(error)+'\\n'); clearTimeout(timer); app.exit(1);
    }
  });
});
await import(${JSON.stringify(pathToFileURL(join(plan.root, 'packages/electron/main.mjs')).href)});`;
}

/** Runs the selected installed payload against its registered service, with isolated shell window state. */
export async function runInstalledUiAcceptance(scenario, marker, reconnectScenario, scenarioInput) {
  const [anchorArg, scratchArg] = process.argv.slice(2);
  if (!anchorArg || !scratchArg || process.argv.length !== 4) throw new Error('Expected ABSOLUTE_REGISTERED_ROOT ABSOLUTE_EVIDENCE_DIR');
  const anchor = resolve(anchorArg), scratch = resolve(scratchArg);
  const plan = await resolveActiveNndPackage(join(anchor, 'nna-service-selection.json'), anchor);
  const selection = { installRoot: plan.nnaInstallRoot, installation_id: plan.installationId, data_id: plan.dataId, incarnation_id: plan.incarnationId };
  const attached = await attachNativeService(selection);
  await mkdir(scratch, { recursive: true });
  const harness = join(scratch, 'installed-ui-shell.mjs'); await writeFile(harness, harnessSource(plan, scratch, scenario, marker, reconnectScenario, scenarioInput));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  const child = spawn(plan.executable, [harness, '--nna-install-root', plan.nnaInstallRoot, '--nnd-selection-file', join(anchor, 'nna-service-selection.json'), '--nnd-controller-generation', attached.generation], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output = (output + chunk).slice(-65536); }); child.stderr.on('data', chunk => { output = (output + chunk).slice(-65536); });
  try {
    const [code] = await withTimeout(once(child, 'exit'), reconnectScenario ? 190000 : 130000, 'Installed UI acceptance timed out');
    assert.equal(code, 0, output); assert.ok(output.includes(marker), output);
    const generation = (await requestNativeServiceStatus(selection)).instance_id;
    if (reconnectScenario) assert.notEqual(generation, attached.generation, 'Restart must replace the service generation');
    else assert.equal(generation, attached.generation, 'Closing the desktop must leave its service running');
    process.stdout.write(output);
  } finally {
    if (child.exitCode === null) child.kill();
    // Invariant: detached browser/tray descendants must not retain this test's observation pipes.
    child.stdout.destroy(); child.stderr.destroy(); child.unref();
  }
}
