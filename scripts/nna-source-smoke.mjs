// SPDX-License-Identifier: Apache-2.0
/** Explicit cross-repository smoke: NND routes -> adapter -> source NNA child. */
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STEP_TIMEOUT_MS = 5_000;
const source = process.argv[2] ? resolve(process.argv[2]) : null;
if (!source) {
  process.stderr.write('usage: node scripts/nna-source-smoke.mjs <NNA source directory>\n');
  process.exitCode = 2;
} else {
  await main(source).catch((error) => {
    process.stderr.write(`NNA source smoke failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}

async function writeManifest(root) {
  const config = join(root, 'config');
  await mkdir(config, { recursive: true });
  await writeFile(join(config, 'manifest.json'), JSON.stringify({
    format_version: 1, persistence: 'ephemeral', workspace_root: root,
    providers: [{ id: 'primary', display_name: 'Primary', endpoint: 'http://127.0.0.1:1234/v1', model: 'test', trust_zone: 'loopback' }],
    routes: { primary: { provider_id: 'primary', model: 'test' } },
  }));
}

async function probe(app, workspace) {
  const call = (path, init = {}) => app.fetch(new Request(`http://nnd.local${path}`, {
    ...init, signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  }));
  assert.equal((await json(call, '/api/global/health', 200)).healthy, true);
  assert.deepEqual(await json(call, '/api/session?roots=true', 200), []);
  const blocked = await call('/api/session', { method: 'POST', headers: { origin: 'null', 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(blocked.status, 403);
  const created = await json(call, '/api/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Source bridge smoke' }),
  }, 201);
  assert.equal(created.directory, workspace);
  const id = created.id;
  assert.match(id, /^ses_[A-Za-z0-9_-]+$/u);
  assert.deepEqual((await json(call, '/api/session?roots=true', 200)).map((item) => item.id), [id]);
  assert.deepEqual(await json(call, '/api/session?roots=false', 200), []);
  assert.deepEqual(await json(call, `/api/session/${id}/children`, 200), []);
  assert.deepEqual(await json(call, `/api/session/${id}/message`, 200), []);
  const renamed = await json(call, `/api/session/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Renamed smoke' }),
  }, 200);
  assert.equal(renamed.title, 'Renamed smoke');
  assert.equal(await json(call, `/api/session/${id}`, { method: 'DELETE' }, 200), true);
  assert.deepEqual(await json(call, '/api/session?roots=true', 200), []);
}

async function json(call, path, initOrStatus, expectedStatus) {
  const init = typeof initOrStatus === 'number' ? undefined : initOrStatus;
  const status = typeof initOrStatus === 'number' ? initOrStatus : expectedStatus;
  const response = await call(path, init);
  const body = await response.json().catch(() => null);
  assert.equal(response.status, status, `${path}: ${JSON.stringify(body)}`);
  return body;
}

async function main(nnaSource) {
  const cli = join(nnaSource, 'src', 'cli.js');
  await access(cli);
  const root = await mkdtemp(join(tmpdir(), 'nnd-nna-source-smoke-'));
  let harness;
  let operationFailed = false;
  try {
    await writeManifest(root);
    // Import after the isolated data root is selected: server auth/settings
    // modules capture environment at import time.
    process.env.NOTNATIVE_DATA_DIR = join(root, 'nnd-data');
    process.env.NOTNATIVE_UI_PASSWORD = '';
    const [{ startLocalNnaHarness }, { createNnaHarnessAdapter }, { registerHarnessAdapter }, { createApp }] = await Promise.all([
      import('../packages/web/src/server/harness/nna-local.ts'),
      import('../packages/web/src/server/harness/nna.ts'),
      import('../packages/web/src/server/harness/adapter.ts'),
      import('../packages/web/src/server/app.ts'),
    ]);
    harness = await startLocalNnaHarness({
      command: process.execPath, commandArguments: [cli], dataRoot: root, workspaceId: 'local',
    });
    // A successful proxy request alone would not detect an accidentally
    // unauthenticated NNA endpoint. Verify the boundary before supplying the
    // launch credential to the adapter.
    const unauthenticated = await fetch(new URL('/global/health', harness.endpoint), {
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
    assert.equal(unauthenticated.status, 401, 'NNA must reject requests without integration credentials');
    registerHarnessAdapter(createNnaHarnessAdapter({
      endpoint: harness.endpoint, token: harness.token, principal: harness.principal,
    }));
    const app = createApp();
    await probe(app, root);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    harness?.dispose();
    const prefix = join(tmpdir(), 'nnd-nna-source-smoke-');
    if (!root.startsWith(prefix)) throw new Error('refusing to remove unexpected smoke directory');
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      if (!operationFailed) throw error;
      process.stderr.write(`NNA source smoke cleanup also failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    }
  }
  process.stdout.write('NND↔NNA source smoke passed: authenticated bootstrap, root list, empty child projections, session lifecycle, and origin gate.\n');
}
