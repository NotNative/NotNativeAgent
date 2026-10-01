// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { runNndNotification } from '../src/nnd-notification.js';
import { ContractError } from '../src/ids.js';
import { sendFailure } from '../src/secret-broker-server.js';

const input = { kind: 'question', title: 'Agent question', body: 'Choose a target:\r\n\tStaging or production?',
  assistantText: 'The checks finished.\n\tChoose the next step.' };
function fixture(output = { title: 'Choose a target', body: 'Staging or production?' }) {
  const requests = [];
  const engine = { sessionId: 'session_a', scheduler: { acquire: async () => () => undefined }, router: {
    resolve: () => ({ profile: { id: 'primary' }, model: 'configured-model' }),
    provider: () => ({ async *stream(request) { requests.push(request);
      yield { type: 'text', text: JSON.stringify(output) }; yield { type: 'terminal' };
    } }),
  } };
  return { context: { engine, closing: false }, requests };
}

test('native notification input preserves paragraph whitespace while output stays single-line', async () => {
  const { context, requests } = fixture();
  assert.equal(JSON.parse((await runNndNotification(context, input)).text).body, 'Staging or production?');
  const content = requests[0].messages[1].content;
  assert.deepEqual(JSON.parse(content.slice(content.indexOf('{'))), input);
  const multiline = fixture({ title: 'Choose', body: 'Staging\nproduction' });
  await assert.rejects(runNndNotification(multiline.context, input), { code: 'nnd_notification_output_invalid' });
});

test('native notification input rejects non-whitespace controls before acquiring model work', async () => {
  const { context, requests } = fixture();
  for (const body of [{ ...input, body: 'Question\u0000text' }, { ...input, assistantText: 'Text\u001b[31m' }]) {
    await assert.rejects(runNndNotification(context, body), { code: 'nnd_notification_invalid' });
  }
  assert.deepEqual(requests, []);
});

test('operational provider failures become retryable native failures without exposing provider prose', async () => {
  const { context } = fixture();
  context.engine.router.provider = () => ({ async *stream() {
    throw new ContractError('provider_transport_error', 'upstream diagnostic with sensitive provider details');
  } });
  const response = { setHeader() {}, end(value) { this.body = value; } };
  try { await runNndNotification(context, input); assert.fail('provider failure must reject'); }
  catch (error) { sendFailure(response, error); }
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).error.code, 'nnd_notification_unavailable');
  assert.doesNotMatch(response.body, /sensitive provider/u);
  assert.equal(context.notificationInFlight, null);
  context.engine.router.provider = fixture().context.engine.router.provider;
  assert.equal(JSON.parse((await runNndNotification(context, input)).text).title, 'Choose a target');
});
