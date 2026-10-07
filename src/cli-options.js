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
    serveAction: null, serveHostname: null, servePort: null,
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
    else if (mode === 'opencode' && value === '--hostname') options.serveHostname = requiredValue(argv[++index], value);
    else if (mode === 'opencode' && value === '--port') {
      options.servePort = parseServePort(requiredValue(argv[++index], value));
    }
    else if (mode === 'opencode' && OPENCODE_ACTIONS.has(value)) {
      if (options.serveAction) throw new ContractError('invalid_option', 'opencode accepts exactly one action');
      options.serveAction = value;
    }
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
  'update', 'integration', 'nnd', 'opencode',
]);

// Why: `run` is the managed runtime entry point used by the wiring service's
// detached start and the login startup script; it is not a documented command.
const OPENCODE_ACTIONS = new Set(['status', 'start', 'stop', 'enable', 'disable', 'run']);

/** The operator invocation vocabulary the 20261006-15 census pinned as the
 * 23 `invocation:*` operator_action rows (validator parseCli). One row per
 * census flag; aliases enumerate the sibling census rows that share the
 * branch. `modes: '*'` means the flag branch runs in every mode; `headless`
 * records whether the flag survives host/headless (the
 * host_override_requires_manifest guard). `option` is the parsed option key
 * the branch lands on (null for pure mode selectors). The tests mechanically
 * prove each entry against parseCli behavior, so this table cannot drift
 * from the parser without failing the suite. Sensitivity note: the family is
 * the operator invocation channel; --provider-credential-env references a
 * credential environment NAME (never its value) and --delete-user-data is
 * the destructive uninstall choice. */
export const INVOCATION_VOCABULARY = Object.freeze({
  modes: Object.freeze([...MODES].sort()),
  flags: Object.freeze([
    Object.freeze({ flag: '--manifest', aliases: Object.freeze(['--config']), argument: 'value',
      modes: '*', headless: true, option: 'manifestPath',
      effect: 'selects the user manifest file for this invocation (regular file, at most 1,048,576 bytes)' }),
    Object.freeze({ flag: '--config', aliases: Object.freeze(['--manifest']), argument: 'value',
      modes: '*', headless: true, option: 'manifestPath',
      effect: 'alias of --manifest; selects the user manifest file for this invocation' }),
    Object.freeze({ flag: '--session', aliases: Object.freeze([]), argument: 'value',
      modes: '*', headless: true, option: 'sessionId',
      effect: 'selects the conversation session to resume for this invocation' }),
    Object.freeze({ flag: '-provider', aliases: Object.freeze(['--provider', '--provider-profile']),
      argument: 'value', modes: '*', headless: true, option: 'providerProfile',
      effect: 'selects the provider profile for this invocation' }),
    Object.freeze({ flag: '--provider', aliases: Object.freeze(['-provider', '--provider-profile']),
      argument: 'value', modes: '*', headless: true, option: 'providerProfile',
      effect: 'selects the provider profile for this invocation' }),
    Object.freeze({ flag: '--provider-profile', aliases: Object.freeze(['-provider', '--provider']),
      argument: 'value', modes: '*', headless: true, option: 'providerProfile',
      effect: 'selects the provider profile for this invocation' }),
    Object.freeze({ flag: '--provider-endpoint', aliases: Object.freeze([]), argument: 'value',
      modes: '*', headless: false, option: 'providerEndpoint',
      effect: 'overrides the provider endpoint for this invocation; refused in host/headless mode, which takes its overrides from the authenticated initialization manifest' }),
    Object.freeze({ flag: '--model', aliases: Object.freeze([]), argument: 'value',
      modes: '*', headless: false, option: 'model',
      effect: 'overrides the model for this invocation; refused in host/headless mode' }),
    Object.freeze({ flag: '--provider-credential-env', aliases: Object.freeze([]), argument: 'value',
      modes: '*', headless: false, option: 'providerCredentialEnv',
      effect: 'names the environment variable holding the provider credential for this invocation (an environment-variable name, never its value); refused in host/headless mode' }),
    Object.freeze({ flag: '--no-color', aliases: Object.freeze([]), argument: 'none',
      modes: '*', headless: true, option: 'color',
      effect: 'disables colored terminal output for this invocation' }),
    Object.freeze({ flag: '--reduced-motion', aliases: Object.freeze([]), argument: 'none',
      modes: '*', headless: true, option: 'reducedMotion',
      effect: 'enables reduced terminal motion for this invocation' }),
    Object.freeze({ flag: '--hostname', aliases: Object.freeze([]), argument: 'value',
      modes: Object.freeze(['opencode']), headless: false, option: 'serveHostname',
      effect: 'binds the opencode serve listener host for this invocation' }),
    Object.freeze({ flag: '--port', aliases: Object.freeze([]), argument: 'value',
      modes: Object.freeze(['opencode']), headless: false, option: 'servePort',
      effect: 'binds the opencode serve listener TCP port (1-65535) for this invocation' }),
    Object.freeze({ flag: '--check', aliases: Object.freeze([]), argument: 'none',
      modes: Object.freeze(['update']), headless: false, option: 'prompt',
      effect: 'requests the update check for the update subcommand' }),
    Object.freeze({ flag: '--delete-user-data', aliases: Object.freeze([]), argument: 'none',
      modes: Object.freeze(['uninstall']), headless: false, option: 'prompt',
      effect: 'uninstall choice that explicitly deletes NND user data (destructive)' }),
    Object.freeze({ flag: '--help', aliases: Object.freeze(['-h']), argument: 'none',
      modes: '*', headless: true, option: null,
      effect: 'informational usage output; no configuration effect (a mode selector)' }),
    Object.freeze({ flag: '--json', aliases: Object.freeze([]), argument: 'none',
      modes: Object.freeze(['skills']), headless: false, option: 'prompt',
      effect: 'requests JSON output for the skills list subcommand' }),
    Object.freeze({ flag: '--keep-user-data', aliases: Object.freeze([]), argument: 'none',
      modes: Object.freeze(['uninstall']), headless: false, option: 'prompt',
      effect: 'uninstall choice that retains user data' }),
    Object.freeze({ flag: '--prompt', aliases: Object.freeze(['-p']), argument: 'prompt-text',
      modes: '*', headless: true, option: 'prompt',
      effect: 'enters text mode with the prompt as conversation input (the text is content, not configuration)' }),
    Object.freeze({ flag: '--version', aliases: Object.freeze(['-v']), argument: 'none',
      modes: '*', headless: true, option: null,
      effect: 'informational version output; no configuration effect (a mode selector)' }),
    Object.freeze({ flag: '-h', aliases: Object.freeze(['--help']), argument: 'none',
      modes: '*', headless: true, option: null,
      effect: 'short form of --help' }),
    Object.freeze({ flag: '-p', aliases: Object.freeze(['--prompt']), argument: 'prompt-text',
      modes: '*', headless: true, option: 'prompt',
      effect: 'short form of --prompt; text mode with conversation input' }),
    Object.freeze({ flag: '-v', aliases: Object.freeze(['--version']), argument: 'none',
      modes: '*', headless: true, option: null,
      effect: 'short form of --version' }),
  ]),
});

function parseServePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ContractError('invalid_option', '--port requires a TCP port between 1 and 65535');
  }
  return port;
}

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
