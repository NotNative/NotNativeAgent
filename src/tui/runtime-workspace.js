// SPDX-License-Identifier: Apache-2.0
import { ExperienceEngine } from '../experience-engine.js';
import { StructuredLog } from '../structured-log.js';
import { osc52Clipboard } from './terminal-clipboard.js';
import { nativeClipboard } from '../experience/native-clipboard.js';
import { launchTuiUpdateCheck } from './update-check.js';
import { ContractError } from '../ids.js';

export async function createTuiWorkspace(options, output, onChange) {
  if (!options || typeof options !== 'object') {
    throw new ContractError('tui_options_invalid', 'Console workspace options are required');
  }
  const logger = options.logger ?? new StructuredLog({ path: options.logPath });
  await logger.initialize?.();
  const systemClipboard = options.systemClipboard ?? nativeClipboard();
  await Promise.resolve(systemClipboard.initialize?.()).catch((error) => recordOptionalFailure(logger, 'clipboard_initialize_failed', error));
  const osc52 = osc52Clipboard(output);
  const clipboard = options.clipboard ?? (async (value) => {
    try { return await systemClipboard.write(value); } catch { return await osc52(value); }
  });
  const workspace = new ExperienceEngine({
    ...options, logger, onChange, clipboard, clipboardRead: options.clipboardRead ?? (() => systemClipboard.read()),
    clipboardImageRead: options.clipboardImageRead ?? ((path, maxBytes) => systemClipboard.readImage(path, maxBytes)),
    clipboardContentRead: options.clipboardContentRead ?? (systemClipboard.readContent
      ? ((path, maxBytes) => systemClipboard.readContent(path, maxBytes)) : undefined),
    clipboardClose: options.clipboardClose ?? (() => systemClipboard.close?.()),
  });
  // Update discovery is optional and never affects Console readiness.
  launchTuiUpdateCheck(workspace.projection, options, onChange)
    .catch((error) => recordOptionalFailure(logger, 'update_check_failed', error));
  return { logger, workspace };
}

function recordOptionalFailure(logger, fallbackCode, error) {
  try {
    logger.record?.({ type: fallbackCode, outcome: 'failed', code: error?.code ?? fallbackCode });
  } catch { /* Optional integrations cannot prevent Console startup. */ }
}
