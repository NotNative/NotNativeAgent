// SPDX-License-Identifier: Apache-2.0
import { dreamOverlay, valueOverlay } from './overlays.js';

export async function openDreamCommand(argument, workspace) {
  const action = argument.trim();
  if (action && !['status', 'pause', 'resume', 'run'].includes(action)) {
    workspace.projection.openOverlay(valueOverlay('dream-detail', 'Idle maintenance', await workspace.dreamCommand(action)));
    return;
  }
  await openManager(workspace, action);
}

export async function handleDreamSelection(id, workspace) {
  if (id.startsWith('candidate:')) {
    const candidate = await workspace.dreamCommand(`inspect ${id.slice('candidate:'.length)}`);
    workspace.projection.openOverlay(Object.freeze({
      ...valueOverlay('dream-detail', 'Learning candidate', candidate), parent: 'dream',
    }));
    return;
  }
  const action = id.startsWith('action:') ? id.slice('action:'.length) : 'status';
  const message = action === 'run' ? 'One bounded maintenance stage completed.' : `Maintenance ${action}d.`;
  await openManager(workspace, action, { selectedId: id, message });
}

export async function reopenDreamManager(workspace) {
  return openManager(workspace, 'status');
}

async function openManager(workspace, action, options = {}) {
  const status = await workspace.dreamCommand(action);
  const candidates = await workspace.dreamCommand('candidates');
  workspace.projection.openOverlay(dreamOverlay(status, candidates, options));
}
