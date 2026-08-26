// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialResolver, normalizeCredentialBinding } from '../src/credential-bindings.js';
import { OpenAICompatibleProvider } from '../src/provider.js';
import { resolveManifest } from '../src/config.js';

test('credential bindings preserve legacy environment references and resolve Secret Broker fields transiently', async () => {
  assert.deepEqual(normalizeCredentialBinding(undefined, 'LEGACY_KEY'), { source: 'environment', name: 'LEGACY_KEY' });
  const uses = [];
  const secretBroker = { async withSecret(id, request, consumer) {
    uses.push({ id, request });
    return consumer({ api_key: 'broker-secret-value' });
  } };
  const resolver = new CredentialResolver({ secretBroker, environment: {} });
  const value = await resolver.withCredential({ source: 'secret', secretId: 'sec_test', field: 'api_key' }, {
    consumer: 'provider:test', destination: 'https://example.test/v1', purpose: 'Test', authorityRef: 'configuration:test',
  }, async (secret) => secret);
  assert.equal(value, 'broker-secret-value');
  assert.equal(uses[0].request.purpose, 'Test');
});

test('provider discovery injects a selected Secret Broker credential without environment indirection', async () => {
  let authorization;
  const resolver = new CredentialResolver({ secretBroker: { async withSecret(_id, _request, consumer) {
    return consumer({ api_key: 'provider-secret-value' });
  } } });
  const provider = new OpenAICompatibleProvider({
    id: 'remote', endpoint: 'https://example.test/v1', model: 'model', trustZone: 'public_network',
    credential: { source: 'secret', secretId: 'sec_provider', field: 'api_key' }, capabilities: {},
  }, {}, {
    credentialResolver: resolver,
    fetch: async (_url, init) => {
      authorization = init.headers.authorization;
      return new Response(JSON.stringify({ data: [{ id: 'model' }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    },
  });
  const capabilities = await provider.capabilities(new AbortController().signal);
  assert.equal(authorization, 'Bearer provider-secret-value');
  assert.deepEqual(capabilities.models, ['model']);
});

test('configuration accepts structured provider, MCP bearer, stdio-target, and custom-header bindings', () => {
  const config = resolveManifest({
    provider: {
      id: 'remote', endpoint: 'https://example.test/v1', model: 'model', trust_zone: 'public_network',
      credential: { source: 'secret', secret_id: 'sec_provider', field: 'api_key' },
    },
    mcp_servers: [{
      id: 'remote', transport: 'streamable_http', endpoint: 'https://mcp.example.test/service', enabled: true,
      credential: { source: 'secret', secret_id: 'sec_mcp', field: 'token' },
      header_credentials: { 'X-API-Key': { source: 'secret', secret_id: 'sec_header', field: 'value' } },
    }, {
      id: 'local', transport: 'stdio', command: 'server', enabled: true, credential_target: 'SERVER_TOKEN',
      credential: { source: 'secret', secret_id: 'sec_local', field: 'token' },
    }],
  });
  assert.deepEqual(config.providerProfiles.remote.credential, { source: 'secret', secretId: 'sec_provider', field: 'api_key' });
  assert.equal(config.mcpServers[0].headerCredentials['X-API-Key'].secretId, 'sec_header');
  assert.equal(config.mcpServers[1].credentialTarget, 'SERVER_TOKEN');
});
