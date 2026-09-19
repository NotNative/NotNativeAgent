import { startOpencodeServe } from '../src/opencode/serve.js';
import { resolveManifest } from '../src/config.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = resolveManifest({
  persistence: 'ephemeral',
  provider: { id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' },
});

function finishCall(outcome) {
  return [
    { type: 'tool_fragment', fragments: [{ index: 0, id: `finish-${outcome}`, function: { name: 'turn_finish', arguments: JSON.stringify({ outcome }) } }] },
    { type: 'terminal', finishReason: 'tool_calls' },
  ];
}
function hasFinishCall(request) {
  return request.messages?.some((message) => message.tool_calls?.some((call) => call.function?.name === 'turn_finish')) === true;
}
class ScriptedProvider {
  async *stream(request) {
    if (!hasFinishCall(request)) { yield* finishCall('completed'); return; }
    yield { type: 'text', text: 'bench' };
    yield { type: 'text', text: '-ok' };
    yield { type: 'usage', usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } };
    yield { type: 'terminal', finishReason: 'stop', usage: null };
  }
}

const root = await mkdtemp(join(tmpdir(), 'nna-prompt-debug-'));
const runtime = await startOpencodeServe({
  config, storeRoot: join(root, 's'), reviewerRoot: join(root, 'r'), directory: 'D:\\fx',
  stdout: { write: () => undefined },
  logger: { record: (event) => console.log('[log]', event.type, event.code ?? '', event.message ?? '') },
  providerFactory: () => new ScriptedProvider(),
});
const created = await (await fetch(`${runtime.url}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'dbg' }) })).json();
const response = await fetch(`${runtime.url}/session/${created.id}/message`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ parts: [{ type: 'text', text: 'say hi' }] }),
});
console.log('prompt status', response.status, await response.text());
await runtime.stop();
