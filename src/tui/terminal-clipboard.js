// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const MAX_CLIPBOARD_BYTES = 100_000;

export function osc52Clipboard(output) {
  return async (value) => {
    const text = String(value);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_CLIPBOARD_BYTES) {
      throw new ContractError('clipboard_content_too_large', `clipboard content exceeds ${MAX_CLIPBOARD_BYTES} bytes`);
    }
    if (!output?.isTTY) throw new ContractError('clipboard_unavailable', 'terminal clipboard requires an interactive terminal');
    output.write(`\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`);
    return { copied: true, bytes };
  };
}
