// SPDX-License-Identifier: Apache-2.0
/** Stable shortcut target: resolve the selected native registration on every launch. */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachNativeService } from '../packages/electron/native-service-client.mjs';
import { resolveActiveNndPackage } from './resolve-active-nnd-package.mjs';
import { readSelectedNativeRuntime } from '../packages/electron/native-service-client.mjs';
import { readLaunchPreferences } from './launch-preferences.mjs';
import { runTrayAction } from './tray-action.mjs';

export async function launchSelectedDesktop(anchor, start = spawn, probe = attachNativeService, options = {}) {
  const selectionFile = join(anchor, 'nna-service-selection.json');
  const plan = await resolveActiveNndPackage(selectionFile, anchor);
  // Lifecycle contract: the Start-menu icon opens the client. If the service
  // is down, attachNativeService starts it first (NNA's supervisor then also
  // brings up the service-owned tray); if it is up, the client just opens.
  const attach = await probe({ installRoot: plan.nnaInstallRoot,
    installation_id: plan.installationId, data_id: plan.dataId, incarnation_id: plan.incarnationId });
  if (!options.forceDesktop) {
    const runtime = (options.runtime ?? readSelectedNativeRuntime)(plan.nnaInstallRoot);
    const prefs = readLaunchPreferences(join(runtime.dataRoot, 'config', 'desktop-launch.json'));
    if (prefs.target === 'browser') {
      await (options.browser ?? runTrayAction)(anchor, 'browser', { resolve: async () => plan, attach: async () => attach });
      return { root: plan.root, version: plan.version, generation: attach.generation, target: 'browser' };
    }
  }
  const args = [join(plan.root, 'packages', 'electron', 'main.mjs'),
    '--nna-install-root', plan.nnaInstallRoot, '--nnd-selection-file', selectionFile,
    '--nnd-controller-generation', attach.generation];
  const child = start(plan.executable, args, {
    cwd: plan.root, detached: true, stdio: 'ignore', windowsHide: false,
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/^(NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$|NNA_|NND_|NOTNATIVE_)/iu.test(name))),
  });
  await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('spawn', accept);
  });
  child.unref();
  return { root: plan.root, version: plan.version, generation: attach.generation };
}

const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
if (process.argv[1] && pathKey(resolve(process.argv[1])) === pathKey(fileURLToPath(import.meta.url))) {
  if (process.argv.length !== 2 && !(process.argv.length === 3 && process.argv[2] === '--desktop')) throw new Error('usage: launch-selected-desktop.mjs [--desktop]');
  const anchor = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  await launchSelectedDesktop(anchor, spawn, attachNativeService, { forceDesktop: process.argv[2] === '--desktop' }).catch(error => {
    console.error(`NND desktop launch failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  });
}
