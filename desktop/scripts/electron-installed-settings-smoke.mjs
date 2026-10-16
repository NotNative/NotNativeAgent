// SPDX-License-Identifier: Apache-2.0
/** Acceptance against an explicit registered installation; restores its presentation preference after testing. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveActiveNndPackage } from './resolve-active-nnd-package.mjs';
import { attachNativeService, requestNativeServiceStatus } from '../packages/electron/native-service-client.mjs';
import { withTimeout } from './smoke-http.mjs';

async function browserScenario() {
  async function waitFor(read, label) {
    const end = Date.now() + 20000;
    while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(done => setTimeout(done, 50)); }
    throw new Error(`Installed settings did not become ready: ${label}`);
  }
  const read = async () => { const response = await fetch('/api/ui-preferences'); if (!response.ok) throw new Error('Preference read failed'); return response.json(); };
  const before = await read();
  await waitFor(() => document.querySelector('[data-workspace-root] > ul'), 'workspace conversations');
  for (const zone of document.querySelectorAll('[data-workspace-root]')) {
    const list = zone.querySelector(':scope > ul');
    if (list && list.getBoundingClientRect().left < zone.querySelector('header').getBoundingClientRect().left + 24) throw new Error('Workspace conversations are not indented');
  }
  (await waitFor(() => document.querySelector('[data-testid="settings-gear"]'), 'settings button')).click();
  const nav = await waitFor(() => document.querySelector('[aria-label="Settings pages"]'), 'native navigation');
  const button = name => { const target = [...nav.querySelectorAll('button')].find(item => item.textContent === name); if (!target) throw new Error(`Missing page ${name}`); target.click(); };
  button('Appearance');
  const size = await waitFor(() => document.querySelector('select[aria-label="Interface size"]'), 'interface size');
  const next = before.settings.fontSize === 110 ? 100 : 110;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(size, String(next)); size.dispatchEvent(new Event('change', { bubbles: true }));
  let after;
  try {
    after = await waitFor(async () => { const row = await read(); return row.revision === before.revision + 1 && row.settings.fontSize === next ? row : null; }, 'save acknowledgement');
    if (after.revision !== before.revision + 1 || after.settings.fontSize !== next || document.documentElement.style.fontSize !== `${next}%`) throw new Error('Installed appearance binding failed');
    button('Conversations');
    await waitFor(() => document.querySelector('select[aria-label="Send message with"]'), 'conversation controls');
    button('Keyboard');
    await waitFor(() => document.querySelector('[data-settings-item="shortcuts.row.new_chat"]'), 'keyboard controls');
    if (document.querySelectorAll('[data-settings-item^="shortcuts.row."]').length !== 5) throw new Error('Unsupported keyboard controls exposed');
  } finally {
    if (after) {
      const response = await fetch('/api/ui-preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected_revision: after.revision, settings: { fontSize: before.settings.fontSize } }) });
      if (!response.ok) throw new Error('Preference restore refused; another window may have changed settings.');
    }
  }
  return { size: next, restored: before.settings.fontSize, nativeShell: window.__NOTNATIVE_ELECTRON__?.runtime === 'electron' };
}

async function restoredScenario(expected) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const gear = document.querySelector('[data-testid="settings-gear"]');
    if (gear) {
      gear.click();
      const nav = document.querySelector('[aria-label="Settings pages"]');
      const appearance = [...(nav?.querySelectorAll('button') ?? [])].find(item => item.textContent === 'Appearance');
      if (appearance) {
        appearance.click();
        await new Promise(done => setTimeout(done, 50));
        const size = document.querySelector('select[aria-label="Interface size"]');
        if (size?.value === String(expected) && document.documentElement.style.fontSize === `${expected}%`) return true;
      }
    }
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error('Desktop reopen did not restore saved preferences');
}

function shellSource(plan, scratch) {
  return `import { app } from 'electron';
import { writeFile } from 'node:fs/promises';
app.setPath('userData', ${JSON.stringify(join(scratch, 'shell-data'))});
let running = false;
const timer = setTimeout(() => app.exit(1), 60000);
app.on('browser-window-created', (_event, win) => {
  queueMicrotask(() => win.removeAllListeners('ready-to-show'));
  win.webContents.on('did-finish-load', async () => {
    if (running || !win.webContents.getURL().startsWith('http://127.0.0.1:')) return;
    running = true;
    try {
      const result = await win.webContents.executeJavaScript(${JSON.stringify(`(${browserScenario.toString()})()`)});
      if (!result.nativeShell) throw new Error('Installed Electron host not detected');
      win.webContents.once('did-finish-load', async () => {
        await win.webContents.executeJavaScript('('+${JSON.stringify(restoredScenario.toString())}+')('+JSON.stringify(result.restored)+')');
        await writeFile(${JSON.stringify(join(scratch, 'desktop-settings.png'))}, (await win.webContents.capturePage()).toPNG());
        process.stdout.write('NNA_INSTALLED_SETTINGS_OK '+JSON.stringify(result)+'\\n'); clearTimeout(timer); app.quit();
      });
      win.webContents.reload();
    } catch (error) { process.stderr.write(String(error)+'\\n'); clearTimeout(timer); app.exit(1); }
  });
});
await import(${JSON.stringify(pathToFileURL(join(plan.root, 'packages/electron/main.mjs')).href)});`;
}

const [anchorArg, scratchArg] = process.argv.slice(2);
if (!anchorArg || !scratchArg || process.argv.length !== 4) throw new Error('usage: electron-installed-settings-smoke.mjs ABSOLUTE_REGISTERED_ROOT ABSOLUTE_EVIDENCE_DIR');
const anchor = resolve(anchorArg), scratch = resolve(scratchArg);
const plan = await resolveActiveNndPackage(join(anchor, 'nna-service-selection.json'), anchor);
const selection = { installRoot: plan.nnaInstallRoot, installation_id: plan.installationId, data_id: plan.dataId, incarnation_id: plan.incarnationId };
const attached = await attachNativeService(selection);
await mkdir(scratch, { recursive: true });
const harness = join(scratch, 'installed-settings-shell.mjs'); await writeFile(harness, shellSource(plan, scratch));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_PATH;
const child = spawn(plan.executable, [harness, '--nna-install-root', plan.nnaInstallRoot, '--nnd-selection-file', join(anchor, 'nna-service-selection.json'), '--nnd-controller-generation', attached.generation], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; child.stdout.on('data', chunk => { output = (output + chunk).slice(-65536); }); child.stderr.on('data', chunk => { output = (output + chunk).slice(-65536); });
try {
  const [code] = await withTimeout(once(child, 'exit'), 70000, 'Installed Electron settings acceptance timed out');
  assert.equal(code, 0, output); assert.match(output, /NNA_INSTALLED_SETTINGS_OK/u);
  assert.equal((await requestNativeServiceStatus(selection)).instance_id, attached.generation, 'Closing the desktop must leave its service running');
  process.stdout.write(output);
} finally { if (child.exitCode === null) child.kill(); }
