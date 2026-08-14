// SPDX-License-Identifier: Apache-2.0
import { resolveManifest } from '../config.js';
import { newId } from '../ids.js';
import { loadTabPool } from './tab-pool.js';

export async function restoreWorkspace(workspace) {
  const poolResult = await readPool(workspace);
  const authoritative = await workspace.acquireConsoleAuthority();
  const mainId = await workspace.create('Main', newId('session'), {
    role: authoritative ? 'primary' : 'standard', main: true, persist: false,
  });
  if (poolResult.error) reportFailure(workspace, mainId, 'saved Console pool', poolResult.error);
  const pool = poolResult.value;
  for (const tab of pool?.tabs ?? []) {
    if (!tab.meaningful || workspace.sessions.size >= 8) continue;
    const name = tab.main && tab.name === 'Main' ? 'Previous Main' : tab.name;
    await restoreTab(workspace, mainId, tab, name);
  }
  workspace.projection.activate(mainId);
  workspace.onChange();
  return { mainId, complete: workspace.restoreFailures.length === 0 };
}

async function readPool(workspace) {
  if (workspace.config.persistence !== 'durable') return { value: null };
  try { return { value: await loadTabPool(workspace.options.tabPoolPath) }; }
  catch (error) { return { value: null, error }; }
}

async function restoreTab(workspace, mainId, tab, name) {
  try {
    await workspace.create(name, tab.session_id, {
      role: 'standard', meaningful: true, config: resolveManifest(tab.manifest),
      presentation: tab.presentation, persist: false,
    });
    return true;
  } catch (error) {
    if (error?.code === 'session_locked') return false;
    reportFailure(workspace, mainId, name, error);
    return false;
  }
}

function reportFailure(workspace, mainId, name, error) {
  const failure = Object.freeze({
    name,
    code: error?.code ?? 'session_restore_failed',
    message: error?.message ?? 'saved conversation could not be restored',
  });
  workspace.restoreFailures.push(failure);
  workspace.projection.apply(mainId, {
    type: 'local_status', kind: 'recovery',
    text: `Could not restore ${name} (${failure.code}): ${failure.message}. Saved data was left untouched; resolve the condition and restart NNA.`,
  });
}
