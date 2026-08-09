// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export function invokeProjectVerification(argument, workspace) {
  const session = workspace.projection.active();
  if (session.activeTurnId) throw new ContractError('turn_active', 'wait for or cancel the active turn before verifying the project');
  const parts = argument.trim() ? argument.trim().split(/\s+/u) : [];
  const scope = ['focused', 'affected', 'full'].includes(parts[0]) ? parts.shift() : 'full';
  const request = parts.length > 0
    ? `Run project.verify once with scope ${scope} and paths ${JSON.stringify(parts)}. Report its exact checks, pass/fail result, and receipt id. Do not substitute ad-hoc shell commands.`
    : `Run project.verify once with scope ${scope}. Report its exact checks, pass/fail result, and receipt id. Do not substitute ad-hoc shell commands.`;
  workspace.submitActive(request);
}
