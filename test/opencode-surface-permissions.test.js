// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { startOpencodeServe } from '../src/opencode/serve.js';
import { createOpenCodeSessionWorkspace } from '../src/opencode/sessions.js';
import { QuestionBroker } from '../src/question-broker.js';

function fixtureConfig() {
  return resolveManifest({
    persistence: 'ephemeral',
    provider: { id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' },
  });
}

async function roots(prefix) {
  const base = await mkdtemp(join(tmpdir(), prefix));
  return { base, storeRoot: join(base, 's'), reviewerRoot: join(base, 'r') };
}

class WriteThenFinishProvider {
  #seen = [];
  get toolContents() { return this.#seen; }
  async *stream(request) {
    const messages = request.messages ?? [];
    const toolReply = messages.find((message) => message.role === 'tool');
    if (toolReply === undefined) {
      const args = { path: 'notes/deploy.txt', content: 'ship it' };
      yield { type: 'tool_fragment', fragments: [{ index: 0, id: 'write-call', function: { name: 'fs_write_text', arguments: JSON.stringify(args) } }] };
      yield { type: 'terminal', finishReason: 'tool_calls' };
      return;
    }
    if (!this.#seen.includes(toolReply.content)) this.#seen.push(toolReply.content);
    if (messages.some((message) => message.tool_calls?.some((call) => call.function?.name === 'turn_finish'))) {
      yield { type: 'text', text: 'skipped the write' };
      yield { type: 'terminal', finishReason: 'stop', usage: null };
      return;
    }
    const done = { outcome: 'completed' };
    yield { type: 'tool_fragment', fragments: [{ index: 0, id: 'finish-call', function: { name: 'turn_finish', arguments: JSON.stringify(done) } }] };
    yield { type: 'terminal', finishReason: 'tool_calls' };
  }
}

const escalatingReviewer = {
  async review() {
    return { outcome: 'escalate_to_operator', confidence: 0.9, reason_code: 'fixture_escalation', guidance: 'Fixture reviewer always escalates.' };
  },
};

test('wire sessions pin auto-review with no permission card transport', async () => {
  const dirs = await roots('nna-wperm-');
  const provider = new WriteThenFinishProvider();
  const { operations, registry } = createOpenCodeSessionWorkspace({
    config: fixtureConfig(), providerFactory: () => provider, wiredVersion: 'test',
    storeRoot: dirs.storeRoot, reviewerRoot: dirs.reviewerRoot,
  });
  const created = await operations.create({ title: 'permission-fail-closed' });
  const session = registry.get(created.id);
  assert.equal(session.engine.permissionBroker, null);
  assert.equal(session.engine.reviewPosture, 'auto-review');
  assert.ok(session.engine.questionBroker instanceof QuestionBroker);
  assert.throws(() => session.engine.decidePermission({ permission_token: 'permission_x' }, 'opencode-wire'), { code: 'interactive_decision_forbidden' });
  await assert.rejects(session.ingress.submit({
    version: '1.0', type: 'permission_decision', request_id: 'req_x',
    permission_token: 'permission_x', tool_request_id: 'tool_x', choice: 'allow_once',
  }, 'opencode-wire'), { code: 'interactive_decision_forbidden' });
  await operations.remove(created.id);
});

test('escalated writes fail closed as deny_with_guidance and never park', async () => {
  const dirs = await roots('nna-wperm-');
  const provider = new WriteThenFinishProvider();
  const runtime = await startOpencodeServe({
    config: fixtureConfig(), providerFactory: () => provider, semanticReviewer: escalatingReviewer,
    storeRoot: dirs.storeRoot, reviewerRoot: dirs.reviewerRoot, directory: dirs.base,
    stdout: { write: () => undefined }, handshakeSink: async () => undefined,
  });
  try {
    const url = runtime.url;
    const created = await (await fetch(`${url}/session`, {
      method: 'POST', headers: { connection: 'close', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'perm-bench' }),
    })).json();
    const response = await fetch(`${url}/session/${created.id}/message`, {
      method: 'POST', headers: { connection: 'close', 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'Write the deploy note' }] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).info.finish, 'stop');
    assert.ok(provider.toolContents[0].includes('interactive_escalation_unavailable'));
    assert.equal(existsSync(join(dirs.base, 'notes')), false);
  } finally {
    await runtime.stop();
  }
});
