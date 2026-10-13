// SPDX-License-Identifier: Apache-2.0
/** F5 step 2: the small-model ports resolve provider inventory and credential
 *  evidence through NNA's public provider-profile authority, never through a
 *  desktop-read credential store. */

import { describe, expect, it } from 'vitest';
import { credentialEvidence, credentialFor, providerList } from './provider-ports.ts';

const nativeProfiles = [
  { profile_id: 'openai_main', display_name: 'OpenAI', endpoint: 'https://api.openai.com/v1',
    model: 'gpt-nano', credential: null, credential_env: 'OPENAI_API_KEY',
    context_limit_bytes: 128_000, output_limit_tokens: 4_096, tool_call_mode: 'auto', active: true },
  { profile_id: 'anthropic_vault', display_name: 'Anthropic', endpoint: 'https://api.anthropic.com/v1',
    model: 'claude-haiku', credential: { source: 'secret', secret_id: 'sec_1' }, credential_env: null,
    context_limit_bytes: 96_000, output_limit_tokens: 2_048, tool_call_mode: 'auto', active: false },
];

type FetchLike = (input: URL, init?: RequestInit) => Promise<Response>;

function harnessReturning(body: unknown, ok = true): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(`${url.pathname}`);
    return ok ? Response.json(body) : new Response('no', { status: 502 });
  };
  return { fetch, calls };
}

// The ports module rides callHarness; the tests inject provider/config ports
// only where they must observe mapping, and assert the default transport by
// monkey-patching the adapter call seam through providerList's arguments.
describe('native provider inventory (F5 step 2)', () => {
  it('maps NNA public profiles into provider records with one model each', async () => {
    const mapped = await providerList({ providers: async () => nativeProfiles }, '/repo');
    expect(mapped).toEqual([
      { id: 'openai_main', name: 'OpenAI', models: {
        'gpt-nano': {
          id: 'gpt-nano', api: { url: 'https://api.openai.com/v1' },
          limit: { context: 128_000, output: 4_096 },
          credential_manifest: null, credential_env: 'OPENAI_API_KEY', active: true,
        },
      } },
      { id: 'anthropic_vault', name: 'Anthropic', models: {
        'claude-haiku': {
          id: 'claude-haiku', api: { url: 'https://api.anthropic.com/v1' },
          limit: { context: 96_000, output: 2_048 },
          credential_manifest: { source: 'secret', secret_id: 'sec_1' }, credential_env: null, active: false,
        },
      } },
    ]);
  });

  it('drops malformed profiles instead of failing the whole roster', async () => {
    const mapped = await providerList({ providers: async () => [
      ...nativeProfiles, { profile_id: 'broken' }, null, { profile_id: '', model: 'm' },
    ] }, '/repo');
    expect(mapped!.map((entry) => entry.id)).toEqual(['openai_main', 'anthropic_vault']);
  });

  it('evidence: env-backed profiles authenticate, secret-backed profiles stay present-only', async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'k';
    try {
      const mapped = (await providerList({ providers: async () => nativeProfiles }, '/repo'))!;
      const evidence = credentialEvidence('/repo', mapped, {});
      expect(evidence).toEqual({ openai_main: 'api', anthropic_vault: 'api' });
      const key = credentialFor('/repo', 'openai_main', mapped![0]!, {});
      expect(key).toEqual({ key: 'k', kind: 'api' });
      // A secret-backed manifest can never yield a raw value to the desktop.
      const vault = credentialFor('/repo', 'anthropic_vault', mapped![1]!, {});
      expect(vault).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('no default credential store exists: the native runtime never opens one', async () => {
    // A roster with no credential manifest, no env reference, and no options key
    // contributes no evidence regardless of the host environment. The legacy
    // OpenCode auth.json seam was deleted along with the authFile port field,
    // so no injected path can resuscitate a filesystem credential read.
    const bare = [{ profile_id: 'plain', display_name: 'Plain', endpoint: 'https://api.example.com/v1',
      model: 'plain-small', credential: null, credential_env: null, context_limit_bytes: 8_000,
      output_limit_tokens: 512, tool_call_mode: 'auto', active: false }];
    const mapped = (await providerList({ providers: async () => bare }, '/repo'))!;
    const evidence = credentialEvidence('/repo', mapped, {});
    expect(evidence).toEqual({});
    const key = credentialFor('/repo', 'plain', mapped![0]!, {});
    expect(key).toBeNull();
  });
});
