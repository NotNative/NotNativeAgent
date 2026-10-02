// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { authenticateIntegrationRequest } from './integration-principal.js';
import { send, sendFailure } from './secret-broker-server.js';
import { ContractError } from './ids.js';

export async function startNndController({ getRecord, status, stop, ticket }) {
  const server = createServer((request, response) => {
    void dispatch(request, response).catch((error) => sendFailure(response, error));
  });
  async function dispatch(request, response) {
    const record = getRecord();
    if (!record || !authenticateIntegrationRequest(request, record.control_token)) return send(response, 401, { error: 'unauthenticated' });
    if (request.headers['x-nnd-generation'] !== record.instance_id) return send(response, 409, { error: 'generation_mismatch' });
    if (request.method === 'GET' && request.url === '/status') return send(response, 200, status());
    if (request.method === 'POST' && request.url === '/stop') {
      send(response, 202, { stopping: true, instance_id: record.instance_id }); stop(); return;
    }
    if (request.method === 'POST' && request.url === '/ui-ticket') return send(response, 200, await ticket());
    return send(response, 404, { error: 'not_found' });
  }
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxRequestsPerSocket = 100;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  return { endpoint: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
    }) };
}

export async function requestNndController(record, action) {
  let response;
  try {
    response = await fetch(`${record.endpoint}/${action}`, { method: action === 'status' ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${record.control_token}`, 'x-nnd-generation': record.instance_id },
      redirect: 'error', signal: AbortSignal.timeout(10000) });
    const reader = response.body.getReader(); let bytes = 0; const chunks = [];
    while (true) {
      const item = await reader.read(); if (item.done) break;
      bytes += item.value.length;
      if (bytes > 65536) { await reader.cancel(); throw new Error('bound'); }
      chunks.push(item.value);
    }
    if (!response.ok) throw new Error('controller rejected');
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (action === 'status' && value.instance_id !== record.instance_id) throw new Error('generation mismatch');
    return value;
  } catch (cause) { throw new ContractError('nnd_health_unavailable', 'Native NND controller is unavailable', { cause }); }
}
