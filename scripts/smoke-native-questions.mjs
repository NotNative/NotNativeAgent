// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { json, withTimeout } from './smoke-http.mjs';

export function nativeQuestionProviderReply(body) {
  const messages = body.messages ?? [];
  if (!messages.some((item) => item.role === 'user' && String(item.content).includes('NND_NATIVE_QUESTION'))) return null;
  const settled = messages.find((item) => item.role === 'tool' && item.tool_call_id === 'native_question');
  if (settled) return { role: 'assistant', content: JSON.parse(settled.content).tool_lifecycle_status === 'succeeded' ? 'NND_NATIVE_ANSWERED' : 'NND_NATIVE_DECLINED' };
  const searched = messages.some((item) => item.role === 'tool' && item.tool_call_id === 'native_question_search');
  return { role: 'assistant', tool_calls: [{ index: 0, id: searched ? 'native_question' : 'native_question_search', type: 'function',
    function: { name: searched ? 'question' : 'tool_search', arguments: JSON.stringify(searched
      ? { questions: [{ question: 'Choose the smoke channel', options: [{ label: 'stable' }, { label: 'beta' }], custom: false }] }
      : { query: 'question' }) } }] };
}

export async function probeNativeQuestions(app) {
  const call = (path, init = {}) => app.fetch(new Request(`http://nnd.local${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(5000) }));
  const abort = new AbortController();
  const stream = await call('/api/global/event', { signal: abort.signal }); assert.equal(stream.status, 200);
  const reader = stream.body.getReader(); const next = questionReader(reader);
  try {
  for (const action of ['reply', 'reject', 'abort']) {
    const session = await json(call, '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, 201);
    try {
      const response = await call(`/api/session/${session.id}/prompt_async`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parts: [{ type: 'text', text: `NND_NATIVE_QUESTION ${action}: Ask which channel to use.` }] }) });
      assert.equal(response.status, 204);
      const question = await poll(async () => (await json(call, '/api/question', 200)).find((item) => item.sessionID === session.id));
      const asked = await next(session.id, 'question.asked'); assert.equal(asked.id, question.id);
      assert.equal(asked.questions[0].question, 'Choose the smoke channel');
      const pending = await json(call, '/api/v1/nnd/pending', 200);
      assert.equal(pending.sessions[session.id].capabilities.forms, 'observe-only');
      assert.equal(pending.sessions[session.id].capabilities.permissions, 'unsupported');
      assert.equal(pending.sessions[session.id].forms[0].id, question.id);
      if (action === 'abort') assert.equal(await json(call, `/api/session/${session.id}/abort`, { method: 'POST' }, 200), true);
      else {
        assert.equal(await json(call, `/api/question/${question.id}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(action === 'reply' ? { answers: [['stable']] } : {}) }, 200), true);
      }
      await poll(async () => !(await json(call, '/api/session/status', 200))[session.id]);
      assert.equal((await next(session.id, action === 'reply' ? 'question.replied' : 'question.rejected')).requestID, question.id);
      assert.equal((await json(call, '/api/question', 200)).some((item) => item.id === question.id), false);
      assert.deepEqual((await json(call, '/api/v1/nnd/pending', 200)).sessions[session.id].forms, []);
      if (action !== 'abort') {
        const messages = await json(call, `/api/session/${session.id}/message`, 200);
        assert.ok(messages.some((message) => message.parts.some((part) => part.type === 'text'
          && part.text.includes(action === 'reply' ? 'NND_NATIVE_ANSWERED' : 'NND_NATIVE_DECLINED'))));
      }
    } finally { await json(call, `/api/session/${session.id}`, { method: 'DELETE' }, 200); }
  }
  } finally { abort.abort(); await reader.cancel().catch(() => {}); }
}
function questionReader(reader) {
  let buffer = ''; const decoder = new TextDecoder();
  return async (session, type) => {
    for (let frames = 0; frames < 1000;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary < 0) {
        const chunk = await withTimeout(reader.read(), 5000, 'native question SSE deadline');
        if (chunk.done) throw new Error('native question stream ended');
        buffer += decoder.decode(chunk.value, { stream: true }); if (buffer.length > 1_048_576) throw new Error('native question stream exceeded its bound');
        continue;
      }
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); frames++;
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      const event = data ? JSON.parse(data.slice(6)).payload : null;
      if (event?.type === type && event.properties?.sessionID === session) return event.properties;
    }
    throw new Error('native question event was not observed');
  };
}
async function poll(observe) {
  return withTimeout((async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { const result = await observe(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 20)); }
    throw new Error('native question smoke timed out');
  })(), 6000, 'native question smoke deadline');
}
