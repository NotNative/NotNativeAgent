// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { resolveManifest } from './config.js';
import { ContractError } from './ids.js';

export function parseCli(argv) {
  const mode = argv[0] ?? 'tui';
  const options = { mode, manifestPath: null, sessionId: null, prompt: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--manifest') options.manifestPath = requiredValue(argv[++index], '--manifest');
    else if (value === '--session') options.sessionId = requiredValue(argv[++index], '--session');
    else if (value === '--no-color') options.color = false;
    else if (value === '--reduced-motion') options.reducedMotion = true;
    else if (value === '--json' && mode === 'skills') options.prompt.push(value);
    else if (value.startsWith('-')) throw new ContractError('invalid_option', `unknown option ${value}`);
    else options.prompt.push(value);
  }
  return Object.freeze(options);
}

export async function loadManifest(path) {
  if (!path) throw new ContractError('manifest_required', '--manifest PATH is required');
  const bytes = await readFile(path);
  if (bytes.length > 1_048_576) throw new ContractError('manifest_too_large', 'manifest file exceeds bound');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
    throw new ContractError('manifest_invalid', 'manifest file is not valid UTF-8 JSON');
  }
  return resolveManifest(value);
}

export async function readPrompt(input, arguments_) {
  if (arguments_.length > 0) return arguments_.join(' ');
  let result = '';
  for await (const chunk of input) {
    result += chunk.toString('utf8');
    if (Buffer.byteLength(result) > 131_072) throw new ContractError('content_too_large', 'prompt exceeds bound');
  }
  if (!result.trim()) throw new ContractError('invalid_content', 'prompt is required');
  return result;
}

function requiredValue(value, flag) {
  if (!value) throw new ContractError('option_value_missing', `${flag} requires a value`);
  return value;
}
