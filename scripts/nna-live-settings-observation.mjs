// SPDX-License-Identifier: Apache-2.0
/**
 * Live-NNA settings observation (deferred-verification 2026-10-11 items):
 * provider-profile PATCH round trip (binding choice, secret reference,
 * explicit `credential: null` clearing BOTH channels, limit resend on model
 * change) and the secret roster picker against the real secret broker
 * (`GET /v1/secrets` shapes). Everything rides the NND app harness proxy
 * (`/api/*` → NNA), exactly the wire path the settings UI uses. Fixture
 * lands in the shared profile scratch root and self-cleans.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { once } from 'node:events';
import { join, sep } from 'node:path';
import { reserveScratch, SCRATCH_ROOT } from './test-scratch.mjs';

const STEP_TIMEOUT_MS = 10_000;
const PROFILE = 'local';

async function startProvider() {
  let completions = 0;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/v1/models' && request.method === 'GET') {
        request.resume();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'test', context_length: 32768, max_output_tokens: 2048 }] }));
        return;
      }
      request.resume();
      response.writeHead(404);
      response.end();
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  server.on('request', () => { /* counted below */ });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('provider listener has no port');
  return { server, port: address.port, completions: () => completions };
}

async function writeManifest(root, providerPort) {
  const config = join(root, 'config');
  const providerEndpoint = `http://127.0.0.1:${providerPort}/v1`;
  await mkdir(config, { recursive: true });
  await writeFile(join(config, 'manifest.json'), JSON.stringify({
    format_version: 1, persistence: 'durable', workspace_root: root,
    providers: [
      { id: 'primary', display_name: 'Primary', endpoint: providerEndpoint, model: 'test', trust_zone: 'loopback' },
      { id: PROFILE, display_name: 'Live observation', endpoint: providerEndpoint, model: 'test', trust_zone: 'loopback' },
    ],
    routes: { primary: { provider_id: 'primary', model: 'test' } },
  }));
}

async function waitForExecution(harness) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetch(new URL('/global/health', harness.endpoint), {
      headers: { authorization: `Bearer ${harness.token}`, 'x-nna-principal': harness.principal() },
      signal: AbortSignal.timeout(Math.min(STEP_TIMEOUT_MS, deadline - Date.now())),
    });
    const body = await response.json();
    if (response.status === 200 && body.healthy === true) return;
    assert.equal(response.status, 503, `engine readiness: ${JSON.stringify(body)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('NNA execution did not become ready within the observation deadline');
}

async function main(nnaSource) {
  const cli = join(nnaSource, 'src', 'cli.js');
  await access(cli);
  const root = reserveScratch('nnd-live-settings-observation-');
  let harness;
  let spawned;
  let provider;
  let operationFailed = false;
  let app = null;
  const calls = [];
  const call = async (path, init = {}, expected = 200) => {
    const response = await app.fetch(new Request(`http://nnd.local${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    }));
    const text = await response.text();
    calls.push({ path, method: init.method ?? 'GET', status: response.status });
    assert.equal(response.status, expected, `${init.method ?? 'GET'} ${path} → ${response.status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : null;
  };
  try {
    provider = await startProvider();
    await writeManifest(root, provider.port);
    process.env.NOTNATIVE_DATA_DIR = join(root, 'nnd-data');
    process.env.NOTNATIVE_UI_PASSWORD = '';
    const [{ startLocalNnaHarness }, { createNnaHarnessAdapter }, { registerHarnessAdapter }, { createApp }] = await Promise.all([
      import('../packages/web/src/server/harness/nna-local.ts'),
      import('../packages/web/src/server/harness/nna.ts'),
      import('../packages/web/src/server/harness/adapter.ts'),
      import('../packages/web/src/server/app.ts'),
    ]);
    harness = await startLocalNnaHarness({
      command: process.execPath, commandArguments: [cli], dataRoot: root,
      spawnChild: (command, args, options) => { spawned = spawn(command, args, options); return spawned; },
    }).catch((error) => { throw new Error(`initial NNA start: ${error.message}`); });
    await waitForExecution(harness);
    assert.ok(await harness.ensurePrimaryWorkspaceId(), 'NNA did not establish an authoritative primary workspace identity');
    registerHarnessAdapter(createNnaHarnessAdapter({
      endpoint: harness.endpoint, token: harness.token, principal: harness.principal(),
    }));
    const appInstance = createApp();
    app = appInstance;

    // ── Secret roster picker against the live broker ────────────────────────
    const empty = await call('/api/v1/secrets');
    assert.deepEqual(empty, { secrets: [] }, 'broker roster starts empty for this principal');
    const created = await call('/api/v1/secrets', {
      method: 'POST', body: JSON.stringify({
        label: 'live-settings-observation', kind: 'api_key',
        fields: { api_key: 'sk-live-observation-not-a-real-key' },
        scope: { kind: 'workspace', id: harness.workspaceId() },
      }),
    }, 201);
    const secretId = created.secret.id;
    assert.match(secretId, /^sec_[0-9a-f-]{36}$/u, 'broker mints sec_<uuid> ids');
    assert.equal(created.secret.label, 'live-settings-observation');
    assert.deepEqual(created.secret.fields, ['api_key'], 'broker reveals field NAMES only');
    assert.equal(JSON.stringify(created).includes('sk-live-observation'), false,
      'create receipt must never echo secret VALUES');
    const roster = await call('/api/v1/secrets');
    assert.equal(roster.secrets.length, 1);
    const publicSecret = roster.secrets[0];
    for (const key of ['id', 'realm', 'label', 'kind', 'scope', 'metadata', 'fields', 'enabled', 'createdAt', 'updatedAt', 'rotatedAt', 'lastUsedAt', 'useCount']) {
      assert.ok(key in publicSecret, `roster shape carries ${key}`);
    }
    assert.equal(publicSecret.enabled, true);
    assert.equal(publicSecret.rotatedAt, null);
    assert.equal(JSON.stringify(roster).includes('sk-live-observation'), false,
      'roster must never carry secret VALUES (picker shows names only)');

    // ── Provider-profile PATCH round trip ───────────────────────────────────
    const inventory = await call('/api/v1/provider-profiles');
    assert.ok(inventory.profiles.some((item) => item.profile_id === PROFILE),
      'the observation profile ships from the fixture manifest');
    const get = async (expected = 200) =>
      (await call(`/api/v1/provider-profiles/${PROFILE}`, {}, expected)).profile;

    // 1. Binding choice: environment
    let profile = await get();
    assert.equal(profile.credential ?? null, null);
    await call(`/api/v1/provider-profiles/${PROFILE}`, {
      method: 'PATCH', body: JSON.stringify({ credential_env: 'NND_OBSERVATION_ENV' }),
    });
    profile = await get();
    assert.equal(profile.credential_env, 'NND_OBSERVATION_ENV', 'environment binding round-trips');

    // 2. Secret reference binding (replaces the environment channel)
    await call(`/api/v1/provider-profiles/${PROFILE}`, {
      method: 'PATCH', body: JSON.stringify({
        credential: { source: 'secret', secret_id: secretId, field: 'api_key' },
      }),
    });
    profile = await get();
    assert.deepEqual(profile.credential, { source: 'secret', secret_id: secretId, field: 'api_key' },
      'secret reference round-trips by NAME, never by value');
    assert.equal(JSON.stringify(profile).includes('sk-live-observation'), false,
      'profile payload must never echo secret VALUES');
    assert.equal(profile.credential_env ?? null, null, 'secret binding replaces the environment channel');

    // 3. Explicit clear: `credential: null` clears BOTH channels
    await call(`/api/v1/provider-profiles/${PROFILE}`, {
      method: 'PATCH', body: JSON.stringify({ credential_env: 'NND_OBSERVATION_RESIDUAL' }),
    });
    profile = await get();
    assert.equal(profile.credential_env, 'NND_OBSERVATION_RESIDUAL');
    await call(`/api/v1/provider-profiles/${PROFILE}`, {
      method: 'PATCH', body: JSON.stringify({ credential: null }),
    });
    profile = await get();
    assert.equal(profile.credential ?? null, null, 'secret channel cleared');
    assert.equal(profile.credential_env ?? null, null, 'environment channel cleared by the same explicit null');

    // 4. Limit resend on model change
    await call(`/api/v1/provider-profiles/${PROFILE}`, {
      method: 'PATCH', body: JSON.stringify({
        model: 'test', context_limit_bytes: 131_072, output_limit_tokens: 4_096, tool_call_mode: 'batch',
      }),
    });
    profile = await get();
    assert.equal(profile.context_limit_bytes, 131_072);
    assert.equal(profile.output_limit_tokens, 4_096);
    assert.equal(profile.tool_call_mode, 'batch');
    await call(`/api/v1/provider-profiles/${PROFILE}`, {
      method: 'PATCH', body: JSON.stringify({
        model: 'test', context_limit_bytes: 262_144, output_limit_tokens: 8_192,
      }),
    });
    profile = await get();
    assert.equal(profile.context_limit_bytes, 262_144, 'resend limits ride the model-change PATCH');
    assert.equal(profile.output_limit_tokens, 8_192, 'resend limits ride the model-change PATCH');

    // 5. Partial update: a model-only PATCH preserves limits (the editor's
    //    resend contract exists because NNA ignores null limits — clearing
    //    limits is not a broker-supported operation; observed 2026-10-11).
    await call(`/api/v1/provider-profiles/${PROFILE}`, {
      method: 'PATCH', body: JSON.stringify({ model: 'test' }),
    });
    profile = await get();
    assert.equal(profile.context_limit_bytes, 262_144, 'model-only PATCH preserves limits');
    assert.equal(profile.output_limit_tokens, 8_192, 'model-only PATCH preserves limits');
    await call(`/api/v1/provider-profiles/${PROFILE}`, {
      method: 'PATCH', body: JSON.stringify({ tool_call_mode: 'single' }),
    });
    profile = await get();
    assert.equal(profile.tool_call_mode, 'single');
    await call(`/api/v1/provider-profiles/${PROFILE}`, {
      method: 'PATCH', body: JSON.stringify({ context_limit_bytes: null }),
    });
    profile = await get();
    assert.equal(profile.context_limit_bytes, 262_144,
      'NNA ignores null limits by design; limits persist until a new bounded value is sent');
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    harness?.dispose();
    if (spawned && !spawned.exitCode) { try { spawned.kill(); } catch { /* best effort */ } }
    if (provider) {
      const closed = new Promise((resolve) => provider.server.close(resolve));
      provider.server.closeAllConnections();
      await closed;
    }
    if (!root.startsWith(SCRATCH_ROOT + sep)) throw new Error('refusing to remove unexpected observation directory');
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      if (!operationFailed) throw error;
      process.stderr.write(`observation cleanup also failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    }
  }
  process.stdout.write(`Live-NNA settings observation passed (${calls.length} proxied calls): secret broker roster shapes, provider-profile PATCH round trip (environment binding, secret reference, explicit null clearing BOTH channels, limit resend on model change).\n`);
}

main(process.argv[2]).catch((error) => {
  process.stderr.write(`live settings observation failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
