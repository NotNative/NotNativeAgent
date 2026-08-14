// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

export async function handleCopyCommand(argument, workspace) {
  const index = argument ? Number(argument) : 1;
  if (!Number.isSafeInteger(index) || index < 1 || index > 100) {
    throw new ContractError('copy_index_invalid', 'use /copy or /copy N where N is from 1 to 100');
  }
  const responses = workspace.activeEngine().transcript
    .filter((item) => item.type === 'message' && item.role === 'assistant' && typeof item.content === 'string')
    .slice(-100).reverse();
  const response = responses[index - 1];
  if (!response) throw new ContractError('copy_response_missing', `assistant response ${index} is unavailable`);
  if (typeof workspace.options.clipboard !== 'function') {
    throw new ContractError('clipboard_unavailable', 'terminal clipboard integration is unavailable');
  }
  const result = await workspace.options.clipboard(response.content);
  workspace.projection.showNotice('clipboard', `Copied assistant response ${index} (${result.bytes} bytes).`);
  workspace.onChange();
  return result;
}
