// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { valueOverlay } from './tui-overlays.js';

export function openRuntimeInspection(kind, workspace) {
  const engine = workspace.activeEngine();
  if (kind === 'hooks') {
    workspace.projection.openOverlay(valueOverlay('hooks', 'Hook bundles', engine.hooks.health()));
    return;
  }
  if (kind === 'extensions') {
    workspace.projection.openOverlay(valueOverlay('extensions', 'Extensions', {
      items: engine.extensions.list(), diagnostics: engine.extensions.diagnostics(),
    }));
    return;
  }
  throw new ContractError('runtime_inspection_invalid', 'unknown runtime inspection area');
}
