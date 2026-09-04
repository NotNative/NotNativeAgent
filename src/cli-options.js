// SPDX-License-Identifier: Apache-2.0
import { open, stat } from 'node:fs/promises';
import { resolveManifest } from './config.js';
import { ContractError } from './ids.js';

const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_PROMPT_BYTES = 131_072;

export function parseCli(argv) {
  let mode = 'tui';
  let modeSelected = false;
  const options = {
    mode, manifestPath: null, sessionId: null, prompt: [], providerProfile: null,
    providerEndpoint: null, model: null, providerCredentialEnv: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!modeSelected && MODES.has(value)) {
      mode = value === 'host' ? 'headless' : value === 'session' ? 'sessions' : value;
      modeSelected = true;
    }
    else if (value === '-p' || value === '--prompt') {
      mode = 'text'; modeSelected = true;
      if (argv[index + 1] && !argv[index + 1].startsWith('-')) options.prompt.push(argv[++index]);
    }
    else if (value === '--manifest' || value === '--config') options.manifestPath = requiredValue(argv[++index], value);
    else if (value === '--session') options.sessionId = requiredValue(argv[++index], '--session');
    else if (['-provider', '--provider', '--provider-profile'].includes(value)) {
      options.providerProfile = requiredValue(argv[++index], value);
    }
    else if (value === '--provider-endpoint') options.providerEndpoint = requiredValue(argv[++index], value);
    else if (value === '--model') options.model = requiredValue(argv[++index], value);
    else if (value === '--provider-credential-env') options.providerCredentialEnv = credentialName(argv[++index], value);
    else if (value === '--no-color') options.color = false;
    else if (value === '--reduced-motion') options.reducedMotion = true;
    else if (value === '--json' && mode === 'skills') options.prompt.push(value);
    else if (value === '--check' && mode === 'update') options.prompt.push(value);
    else if (mode === 'uninstall' && ['--delete-user-data', '--keep-user-data'].includes(value)) options.prompt.push(value);
    else if (value.startsWith('-')) throw new ContractError('invalid_option', `unknown option ${value}`);
    else options.prompt.push(value);
  }
  if (mode === 'headless' && [options.providerEndpoint, options.model, options.providerCredentialEnv].some(Boolean)) {
    throw new ContractError('host_override_requires_manifest', 'host endpoint, model, and credential overrides must be supplied by its authenticated initialization manifest');
  }
  return Object.freeze({ ...options, mode });
}

const MODES = new Set([
  'tui', 'text', 'headless', 'host', 'session', 'sessions', 'websearch', 'skills', 'gateway',
  'webfetch', 'webbrowse', 'provider', 'secrets', 'uninstall', 'help', 'version', '--help', '-h', '--version', '-v',
  'update', 'integration',
]);

export async function loadManifest(path) {
  if (!path) throw new ContractError('manifest_required', '--manifest PATH is required');
  const entry = await stat(path);
  if (!entry.isFile()) throw new ContractError('manifest_invalid', 'manifest path must identify a regular file');
  if (entry.size > MAX_MANIFEST_BYTES) throw new ContractError('manifest_too_large', 'manifest file exceeds bound');
  const bytes = await readBoundedFile(path, MAX_MANIFEST_BYTES);
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
    throw new ContractError('manifest_invalid', 'manifest file must contain valid UTF-8 encoded JSON');
  }
  return resolveManifest(value);
}

export async function readPrompt(input, arguments_) {
  if (arguments_.length > 0) {
    let totalBytes = Math.max(0, arguments_.length - 1);
    for (const argument of arguments_) {
      totalBytes += Buffer.byteLength(argument, 'utf8');
      if (totalBytes > MAX_PROMPT_BYTES) throw new ContractError('content_too_large', 'prompt exceeds bound');
    }
    return arguments_.join(' ');
  }
  let result = '';
  let totalBytes = 0;
  for await (const chunk of input) {
    totalBytes += Buffer.byteLength(chunk);
    if (totalBytes > MAX_PROMPT_BYTES) throw new ContractError('content_too_large', 'prompt exceeds bound');
    result += chunk.toString('utf8');
  }
  if (!result.trim()) throw new ContractError('invalid_content', 'prompt is required');
  return result;
}

async function readBoundedFile(path, limit) {
  const file = await open(path, 'r');
  const chunks = [];
  let total = 0;
  try {
    const entry = await file.stat();
    if (!entry.isFile()) throw new ContractError('manifest_invalid', 'manifest path must identify a regular file');
    if (entry.size > limit) throw new ContractError('manifest_too_large', 'manifest file exceeds bound');
    while (total <= limit) {
      const buffer = Buffer.allocUnsafe(Math.min(65_536, limit + 1 - total));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
  } finally { await file.close(); }
  if (total > limit) throw new ContractError('manifest_too_large', 'manifest file exceeds bound');
  return Buffer.concat(chunks, total);
}

function requiredValue(value, flag) {
  if (!value) throw new ContractError('option_value_missing', `${flag} requires a value`);
  return value;
}

function credentialName(value, flag) {
  const name = requiredValue(value, flag);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name)) {
    throw new ContractError('credential_reference_invalid', `${flag} requires an environment-variable name`);
  }
  return name;
}
