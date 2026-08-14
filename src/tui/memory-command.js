// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { valueOverlay } from './overlays.js';

export async function handleMemoryCommand(argument, workspace) {
  const [action = 'inspect', id, ...rest] = argument.split(/\s+/u).filter(Boolean);
  const engine = workspace.activeEngine();
  if (action === 'inspect') {
    const [health, memories] = await Promise.all([engine.memory.health(), engine.inspectMemory()]);
    workspace.projection.openOverlay(valueOverlay('memory', 'Memory', { health, memories }));
    return;
  }
  if (action === 'save') {
    const content = [id, ...rest].filter(Boolean).join(' ');
    if (!content) throw new ContractError('memory_command_invalid', 'use /memory save TEXT');
    const result = await engine.saveMemory(content);
    workspace.projection.openOverlay(valueOverlay('memory', 'Memory saved', result));
    return;
  }
  if (action === 'delete' && id && rest.length <= 1) {
    const expectedVersion = rest[0] ?? null;
    const result = await engine.deleteMemory(id, expectedVersion);
    workspace.projection.openOverlay(valueOverlay('memory', 'Memory deleted', result));
    return;
  }
  throw new ContractError('memory_command_invalid', 'use /memory [inspect], /memory save TEXT, or /memory delete ID [EXPECTED_VERSION]');
}
