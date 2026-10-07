// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { parseNativeInvocation, type InvocationReceipt, type InvocationFlag } from '../invocation.ts';

type Spec = [string, string[], InvocationFlag['argument'], string[] | '*', boolean, string | null, string];
const SPECS: Spec[] = [
  ['--manifest', ['--config'], 'value', '*', true, 'manifestPath',
    'selects the user manifest file for this invocation'],
  ['--config', ['--manifest'], 'value', '*', true, 'manifestPath',
    'alias of --manifest; selects the user manifest file for this invocation'],
  ['--session', [], 'value', '*', true, 'sessionId',
    'selects the conversation session to resume for this invocation'],
  ['-provider', ['--provider', '--provider-profile'], 'value', '*', true, 'providerProfile',
    'selects the provider profile for this invocation'],
  ['--provider', ['-provider', '--provider-profile'], 'value', '*', true, 'providerProfile',
    'selects the provider profile for this invocation'],
  ['--provider-profile', ['-provider', '--provider'], 'value', '*', true, 'providerProfile',
    'selects the provider profile for this invocation'],
  ['--provider-endpoint', [], 'value', '*', false, 'providerEndpoint',
    'overrides the provider endpoint for this invocation; refused in host/headless mode'],
  ['--model', [], 'value', '*', false, 'model',
    'overrides the model for this invocation; refused in host/headless mode'],
  ['--provider-credential-env', [], 'value', '*', false, 'providerCredentialEnv',
    'names the environment variable holding the provider credential; refused in host/headless mode'],
  ['--no-color', [], 'none', '*', true, 'color',
    'disables colored terminal output for this invocation'],
  ['--reduced-motion', [], 'none', '*', true, 'reducedMotion',
    'enables reduced terminal motion for this invocation'],
  ['--hostname', [], 'value', ['opencode'], false, 'serveHostname',
    'binds the opencode serve listener host for this invocation'],
  ['--port', [], 'value', ['opencode'], false, 'servePort',
    'binds the opencode serve listener TCP port (1-65535) for this invocation'],
  ['--check', [], 'none', ['update'], false, 'prompt',
    'requests the update check for the update subcommand'],
  ['--delete-user-data', [], 'none', ['uninstall'], false, 'prompt',
    'uninstall choice that explicitly deletes NND user data (destructive)'],
  ['--help', ['-h'], 'none', '*', true, null,
    'informational usage output; no configuration effect'],
  ['--json', [], 'none', ['skills'], false, 'prompt',
    'requests JSON output for the skills list subcommand'],
  ['--keep-user-data', [], 'none', ['uninstall'], false, 'prompt',
    'uninstall choice that retains user data'],
  ['--prompt', ['-p'], 'prompt-text', '*', true, 'prompt',
    'enters text mode with the prompt as conversation input'],
  ['--version', ['-v'], 'none', '*', true, null,
    'informational version output; no configuration effect'],
  ['-h', ['--help'], 'none', '*', true, null, 'short form of --help'],
  ['-p', ['--prompt'], 'prompt-text', '*', true, 'prompt', 'short form of --prompt'],
  ['-v', ['--version'], 'none', '*', true, null, 'short form of --version'],
];

const entry = (spec: Spec, overrides: Record<string, unknown> = {}): InvocationFlag => ({
  flag: spec[0], aliases: [...spec[1]], argument: spec[2], modes: spec[3] === '*' ? '*' : [...spec[3]],
  headless: spec[4], option: spec[5], effect: spec[6], ...overrides } as InvocationFlag);

const invocationView = (overrides: Array<[number, Record<string, unknown>]> = []) => ({
  schema_version: '1.0', installation_id: 'nna_1', data_id: 'data_1', scope: 'user',
  family: 'invocation', application: 'not_applied',
  modes: ['opencode', 'skills', 'text', 'tui', 'uninstall', 'update'],
  flags: SPECS.map((spec, at) => {
    const found = overrides.find(([index]) => index === at);
    return entry(spec, found ? found[1] : {});
  }),
}) as unknown;

const drift = (base: () => unknown,
  modifier: (value: Record<string, unknown>) => Record<string, unknown>) => () =>
  modifier({ ...(base() as Record<string, unknown>) });

describe('native invocation vocabulary receipt', () => {
  it('parses the full 23-row vocabulary', () => {
    const receipt = parseNativeInvocation(invocationView()) as InvocationReceipt;
    expect(receipt.family).toBe('invocation');
    expect(receipt.application).toBe('not_applied');
    expect(receipt.flags.length).toBe(23);
    expect(receipt.flags.map((item) => item.flag)).toContain('--config');
    expect(receipt.modes).toContain('opencode');
    const endpoint = receipt.flags.find((item) => item.flag === '--provider-endpoint');
    expect(endpoint?.headless).toBe(false);
    const help = receipt.flags.find((item) => item.flag === '--help');
    expect(help?.option).toBeNull();
    expect(help?.aliases).toEqual(['-h']);
  });
  it('refuses drift', () => {
    expect(() => parseNativeInvocation(null)).toThrow();
    expect(() => parseNativeInvocation(drift(invocationView,
      (v) => ({ ...v, family: 'gateway' }))())).toThrow();
    expect(() => parseNativeInvocation(drift(invocationView,
      (v) => ({ ...v, application: 'applied' }))())).toThrow();
    expect(() => parseNativeInvocation(drift(invocationView,
      (v) => ({ ...v, extra: true }))())).toThrow();
    expect(() => parseNativeInvocation(drift(invocationView,
      (v) => ({ ...v, modes: [] }))())).toThrow();
    expect(() => parseNativeInvocation(drift(invocationView,
      (v) => ({ ...v, flags: (v.flags as unknown[]).slice(1) }))())).toThrow();
    expect(() => parseNativeInvocation(invocationView([[0, { headless: 'yes' }]] as
      Array<[number, Record<string, unknown>]>))).toThrow();
    expect(() => parseNativeInvocation(invocationView([[0, { argument: 'object' }]] as
      Array<[number, Record<string, unknown>]>))).toThrow();
    expect(() => parseNativeInvocation(invocationView([[6, { headless: true }]] as
      Array<[number, Record<string, unknown>]>))).toThrow();
    expect(() => parseNativeInvocation(invocationView([[12, { modes: [] }]] as
      Array<[number, Record<string, unknown>]>))).toThrow();
    expect(() => parseNativeInvocation(invocationView([[0, { effect: '' }]] as
      Array<[number, Record<string, unknown>]>))).toThrow();
    expect(() => parseNativeInvocation(invocationView([[15, { option: 7 }]] as
      Array<[number, Record<string, unknown>]>))).toThrow();
    expect(() => parseNativeInvocation(invocationView([[0, { extra: 1 }]] as
      Array<[number, Record<string, unknown>]>))).toThrow();
  });
});
