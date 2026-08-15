// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readUpdateState } from '../update-service.js';
import { VERSION } from '../product.js';

const UPDATE_CHECK_TIMEOUT_MS = 30_000;
const VERSION_PATTERN = /^(?:v)?(\d{8})-(\d+)$/u;

export async function launchTuiUpdateCheck(projection, options, onChange) {
  if (options.updateCheck === false || !installedRuntime()) return false;
  await projectCachedStatus(projection, options.updateState, onChange);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../update-check-worker.js', import.meta.url))], {
    detached: false, windowsHide: true, stdio: 'ignore', env: process.env,
  });
  let settled = false;
  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    reportFailure(options, Object.assign(new Error('update check timed out'), { code: 'update_check_timeout' }));
    child.kill();
  }, UPDATE_CHECK_TIMEOUT_MS);
  timeout.unref?.();
  child.once('error', (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    reportFailure(options, error);
  });
  child.once('exit', (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (code !== 0) {
      reportFailure(options, Object.assign(new Error('update check worker failed'), { code: 'update_check_worker_failed' }));
      return;
    }
    projectCachedStatus(projection, options.updateState, onChange).catch((error) => reportFailure(options, error));
  });
  child.unref();
  return true;
}

async function projectCachedStatus(projection, statePath, onChange) {
  if (!statePath || !projection || typeof projection !== 'object') return;
  const state = await readUpdateState(statePath);
  const available = Boolean(state?.latest_version && newer(state.latest_version, VERSION));
  const changed = projection.updateAvailable !== available;
  projection.updateAvailable = available;
  if (changed && typeof onChange === 'function') queueMicrotask(onChange);
}

function installedRuntime() {
  return fileURLToPath(import.meta.url).replaceAll('\\', '/').includes('/installed/src/');
}

function newer(candidate, current) {
  const parse = (value) => {
    const match = VERSION_PATTERN.exec(value);
    if (!match || !validCalendarDate(match[1])) return null;
    return match.slice(1).map(Number);
  };
  const left = parse(candidate); const right = parse(current);
  return Boolean(left && right && (left[0] > right[0] || (left[0] === right[0] && left[1] > right[1])));
}

function validCalendarDate(value) {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function reportFailure(options, error) {
  try {
    options.logger?.record({
      type: 'update_check_failed', outcome: 'failed', code: error?.code ?? 'update_check_failed',
    });
  } catch { /* Optional update discovery cannot affect Console readiness. */ }
}
