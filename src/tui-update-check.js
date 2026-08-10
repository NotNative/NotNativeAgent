// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readUpdateState } from './update-service.js';
import { VERSION } from './product.js';

export async function launchTuiUpdateCheck(projection, options, onChange) {
  if (options.updateCheck === false || !installedRuntime()) return false;
  await projectCachedStatus(projection, options.updateState, onChange);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('./update-check-worker.js', import.meta.url))], {
    detached: false, windowsHide: true, stdio: 'ignore', env: process.env,
  });
  child.once('error', () => undefined);
  child.once('exit', () => { projectCachedStatus(projection, options.updateState, onChange).catch(() => undefined); });
  child.unref();
  return true;
}

async function projectCachedStatus(projection, statePath, onChange) {
  if (!statePath) return;
  const state = await readUpdateState(statePath);
  projection.updateAvailable = Boolean(state?.latest_version && newer(state.latest_version, VERSION));
  if (projection.updateAvailable) onChange();
}

function installedRuntime() {
  return fileURLToPath(import.meta.url).replaceAll('\\', '/').includes('/installed/src/');
}

function newer(candidate, current) {
  const parse = (value) => /^(?:v)?(\d{8})-(\d+)$/u.exec(value)?.slice(1).map(Number);
  const left = parse(candidate); const right = parse(current);
  return Boolean(left && right && (left[0] > right[0] || (left[0] === right[0] && left[1] > right[1])));
}
