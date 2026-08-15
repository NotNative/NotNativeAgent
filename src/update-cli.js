// SPDX-License-Identifier: Apache-2.0
import { checkForUpdate, installAvailableUpdate } from './update-service.js';
import { VERSION } from './product.js';

export async function runUpdateCommand(args, paths, io = {}) {
  const output = io.output ?? process.stdout;
  const check = io.checkForUpdate ?? checkForUpdate;
  const install = io.installAvailableUpdate ?? installAvailableUpdate;
  if (!Array.isArray(args) || args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    output.write('Usage: nna update [--check]\n');
    return 2;
  }
  if (args[0] === '--check') {
    const result = await check({ statePath: paths.updateState, currentVersion: VERSION, force: true });
    requireUpdateResult(result, 'check');
    output.write(`${formatCheck(result)}\n`);
    return result.status === 'unavailable' ? 1 : 0;
  }
  const result = await install({ paths, currentVersion: VERSION });
  requireUpdateResult(result, 'install');
  output.write(result.installed
    ? `Updated NotNativeAgent ${result.current_version} -> ${result.latest_version}. Restart any open NNA Consoles.\n`
    : `${formatCheck(result)}\n`);
  return 0;
}

function formatCheck(result) {
  if (result.status === 'unavailable') return `Update check unavailable (${result.error_code}).`;
  if (result.available) return `Update available: ${result.current_version} -> ${result.latest_version}. Run: nna update`;
  return `NotNativeAgent ${result.current_version} is current.`;
}

function requireUpdateResult(result, operation) {
  const operationValid = operation === 'check'
    ? typeof result?.status === 'string' : typeof result?.installed === 'boolean';
  if (!result || typeof result !== 'object' || !operationValid || typeof result.current_version !== 'string') {
    throw Object.assign(new Error('update service returned an invalid result'), { code: 'update_result_invalid' });
  }
  return result;
}
