// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';

/** Verify browser bytes reach the real native provider without becoming prompt-body bytes. */
export async function probeAttachment(call, json, sessionId, waitForTurn, providerRequests) {
  const marker = 'NND_SOURCE_UPLOAD_MARKER';
  const image = Buffer.concat([Buffer.from('89504e470d0a1a0a00000000', 'hex'), Buffer.from('NND_IMAGE_MARKER')]);
  const uploaded = await json(call, `/api/v1/nnd/sessions/${sessionId}/attachments`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      upload_id: 'smoke_upload', filename: 'smoke.txt', mime_type: 'text/plain',
      data_url: `data:text/plain;base64,${Buffer.from(marker).toString('base64')}`,
    }),
  }, 201);
  assert.equal(uploaded.upload_id, 'smoke_upload');
  const uploadedImage = await json(call, `/api/v1/nnd/sessions/${sessionId}/attachments`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      upload_id: 'smoke_image', filename: 'marker.png', mime_type: 'image/png',
      data_url: `data:image/png;base64,${image.toString('base64')}`,
    }),
  }, 201);
  assert.equal(uploadedImage.upload_id, 'smoke_image');
  const fileOnlyBody = JSON.stringify({ messageID: 'smoke_file_only', parts: [{ type: 'text', text: '' },
    { type: 'file', upload_id: 'smoke_upload' }, { type: 'file', upload_id: 'smoke_image' }] });
  const fileOnly = await call(`/api/session/${sessionId}/prompt_async`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: fileOnlyBody,
  });
  assert.equal(fileOnly.status, 204);
  await waitForTurn('smoke_file_only');
  const messages = await json(call, `/api/session/${sessionId}/message`, 200);
  const user = messages.find(message => message.info?.id === 'smoke_file_only');
  assert.deepEqual(user?.parts.filter(part => part.type === 'file').map(part => [part.filename, part.mime, part.url]),
    [['smoke.txt', 'text/plain', ''], ['marker.png', 'image/png', '']],
    'native transcript must retain file names without exposing upload bytes or paths');
  const requestCount = providerRequests().length;
  const retry = await call(`/api/session/${sessionId}/prompt_async`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: fileOnlyBody,
  });
  assert.equal(retry.status, 204, 'a lost acknowledgement may be retried after upload release');
  assert.equal(providerRequests().length, requestCount, 'the retry must not invoke the provider again');
  assert.ok(providerRequests().some((request) => request.messages?.some((message) =>
    typeof message.content === 'string' && message.content.includes(marker)
      && message.content.includes('Untrusted attachment observation'))),
  'native upload was not delivered to the primary provider as untrusted context');
  assert.ok(providerRequests().some((request) => JSON.stringify(request.messages).includes(image.toString('base64'))),
    'native image upload was not delivered to the observation provider');
}

export async function probeRestoredAttachmentNames(call, json, sessionId) {
  const messages = await json(call, `/api/session/${sessionId}/message`, 200);
  const prompt = messages.find(message => message.info?.id === 'smoke_file_only');
  assert.deepEqual(prompt?.parts.filter(part => part.type === 'file').map(part => part.filename),
    ['smoke.txt', 'marker.png'], 'restarted NNA lost file-only transcript names');
}
