// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveManifest, SessionEngine } from '../src/index.js';
import { VERSION } from '../src/product.js';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDER_ID = 'offline-smoke';
const FIXTURE_MODEL = 'fixture';
const REQUEST_TEXT = 'offline smoke request';
const RESPONSE_TEXT = 'offline smoke response';

await main().catch((error) => {
  process.stderr.write(`offline smoke test failed: ${error?.message ?? 'unknown error'}\n`);
  process.exitCode = 1;
});

async function main() {
const version = await execute(process.execPath, ['--no-warnings', join(root, 'src', 'cli.js'), '--version'], {
  cwd: root, windowsHide: true, timeout: 15_000,
});
assert.equal(version.stderr, '');
assert.equal(version.stdout.trim(), VERSION);

const config = resolveManifest({
  persistence: 'ephemeral',
  providers: [{
    id: PROVIDER_ID, endpoint: 'http://127.0.0.1:1/v1', model: FIXTURE_MODEL,
    trust_zone: 'loopback', capabilities: { tools: true, images: false, structured_output: true },
  }],
  routes: { primary: { provider_id: PROVIDER_ID, budget: 1 } },
});
let requests = 0;
const engine = new SessionEngine({
  config,
  providerFactory: () => ({
    async *stream(request) {
      requests += 1;
      assert.equal(request.model, FIXTURE_MODEL);
      assert.equal(request.messages.at(-1)?.content, REQUEST_TEXT);
      yield { type: 'text', text: RESPONSE_TEXT };
      yield { type: 'terminal', finishReason: 'stop', usage: { input_tokens: 3, output_tokens: 3, total_tokens: 6 } };
    },
  }),
});

let initialized = false;
try {
  await engine.initialize();
  initialized = true;
  const result = await engine.submit({ request_id: 'offline-smoke', content: REQUEST_TEXT }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(result.text, RESPONSE_TEXT);
  assert.equal(requests, 1);
} finally {
  if (initialized) await engine.shutdown({ request_id: 'offline-smoke-shutdown' });
}

process.stdout.write(`NotNativeAgent ${VERSION} offline smoke test passed.\n`);
}
