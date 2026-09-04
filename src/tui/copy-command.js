// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { recordClipboard } from './telemetry.js';

const MAX_COPY_INDEX = 100;
const TRANSCRIPT_RESPONSE_WINDOW = 100;

export async function handleCopyCommand(argument, workspace) {
  const normalizedArgument = typeof argument === 'string' ? argument.trim() : '';
  const index = normalizedArgument ? Number(normalizedArgument) : 1;
  if (!Number.isSafeInteger(index) || index < 1 || index > MAX_COPY_INDEX) {
    throw new ContractError('copy_index_invalid', 'use /copy or /copy N where N is from 1 to 100');
  }
  const transcript = workspace.activeEngine?.()?.transcript;
  if (!Array.isArray(transcript)) {
    throw new ContractError('copy_transcript_unavailable', 'the active conversation transcript is unavailable');
  }
  const responses = transcript
    .filter((item) => item.type === 'message' && item.role === 'assistant' && typeof item.content === 'string')
    .slice(-TRANSCRIPT_RESPONSE_WINDOW).reverse();
  const response = responses[index - 1];
  if (!response) throw new ContractError('copy_response_missing', `assistant response ${index} is unavailable`);
  if (typeof workspace.options.clipboard !== 'function') {
    throw new ContractError('clipboard_unavailable', 'terminal clipboard integration is unavailable');
  }
  let result;
  recordClipboard(workspace, 'started', { type: 'copy', source: 'command' });
  try { result = await workspace.options.clipboard(response.content); }
  catch (error) {
    recordClipboard(workspace, 'failed', { type: 'copy', source: 'command', code: error?.code ?? 'clipboard_operation_failed' });
    throw error;
  }
  const bytes = result?.bytes ?? Buffer.byteLength(response.content, 'utf8');
  recordClipboard(workspace, 'succeeded', { type: 'copy', source: 'command', bytes });
  workspace.projection.showNotice('clipboard', `Copied assistant response ${index} (${bytes} bytes).`);
  workspace.onChange();
  return result;
}
