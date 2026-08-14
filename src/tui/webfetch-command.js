// SPDX-License-Identifier: Apache-2.0
import { webFetchOverlay } from './overlays.js';

export async function handleWebFetchCommand(argument, workspace) {
  const args = argument.trim() ? argument.trim().split(/\s+/u) : ['status'];
  const result = await workspace.webFetchCommand(args);
  workspace.projection.openOverlay(webFetchOverlay(result.config, {
    message: args[0] === 'status' ? null : `Trusted WebFetch origins updated (${result.config.trusted_origins.length}).`,
  }));
}
