// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { playwrightStatus } from './playwright-runtime.js';

export async function runWebBrowseCommand(args, paths) {
  const action = args[0] ?? 'status';
  if (!['status', 'verify'].includes(action) || args.length > 1) {
    throw new ContractError('web_browse_command_invalid', 'webbrowse supports status or verify');
  }
  return playwrightStatus(paths.managedPlaywright, { verifyLaunch: action === 'verify' });
}
