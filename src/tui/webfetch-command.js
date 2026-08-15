// SPDX-License-Identifier: Apache-2.0
import { webFetchOverlay } from './overlays.js';
import { ContractError } from '../ids.js';

export async function handleWebFetchCommand(argument, workspace) {
  const normalizedArgument = typeof argument === 'string' ? argument.trim() : '';
  const args = normalizedArgument ? normalizedArgument.split(/\s+/u) : ['status'];
  if (typeof workspace?.webFetchCommand !== 'function') {
    throw new ContractError('web_fetch_configuration_unavailable', 'WebFetch configuration is unavailable');
  }
  const result = await workspace.webFetchCommand(args);
  if (!result?.config || !Array.isArray(result.config.trusted_origins)) {
    throw new ContractError('web_fetch_configuration_invalid', 'WebFetch configuration returned an invalid result');
  }
  workspace.projection.openOverlay(webFetchOverlay(result.config, {
    message: args[0] === 'status' ? null : `Trusted WebFetch origins updated (${result.config.trusted_origins.length}).`,
  }));
}
