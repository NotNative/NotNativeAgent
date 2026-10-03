// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { authenticateIntegrationRequest } from './integration-principal.js';
import { send, sendFailure } from './secret-broker-server.js';
import { ContractError } from './ids.js';
import { assertNndAttach, assertSelectedNndStatus, issueNndAttach } from './nnd-service-attach.js';

export async function startNndController({ getRecord, status, stop, ticket }) {
  let dark = null;
  const server = createServer((request, response) => {
    void dispatch(request, response).catch((error) => sendFailure(response, error));
  });
  async function dispatch(request, response) {
    if (request.url === '/__nna/dark-attach') {
      if (request.method !== 'GET' || getRecord() !== null || !dark || dark.used
        || Date.now() > dark.deadline || request.headers['x-nnd-generation'] !== dark.record.instance_id
        || !sameToken(request.headers.authorization, dark.token)) return send(response, 401, { error: 'unauthenticated' });
      dark.used = true;
      const current = assertSelectedNndStatus(status(), dark.record);
      if (current.endpoint !== dark.endpoint || !['ready', 'setup_required'].includes(current.service_state)) {
        throw new ContractError('nnd_health_unavailable', 'Dark NND attach probe changed');
      }
      return send(response, 200, { protocol: '1.0', installation_id: dark.record.installation_id,
        data_id: dark.record.data_id, generation: dark.record.instance_id, endpoint: dark.endpoint,
        service_state: current.service_state });
    }
    const record = getRecord();
    if (!record || !authenticateIntegrationRequest(request, record.control_token)) return send(response, 401, { error: 'unauthenticated' });
    if (request.headers['x-nnd-generation'] !== record.instance_id) return send(response, 409, { error: 'generation_mismatch' });
    if (request.method === 'GET' && request.url === '/status') return send(response, 200, status());
    if (request.method === 'POST' && request.url === '/attach') {
      return send(response, 200, await issueNndAttach(record, status, ticket));
    }
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
    isListening: () => server.listening && server.address() !== null,
    async probeDark(record, { signal, timeoutMs = 5000 } = {}) {
      if (dark || getRecord() !== null || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
        throw new ContractError('nnd_health_unavailable', 'Dark NND attach probe is unavailable');
      }
      const before = assertSelectedNndStatus(status(), record);
      if (!['ready', 'setup_required'].includes(before.service_state) || !before.endpoint) {
        throw new ContractError('nnd_health_unavailable', 'Dark NND UI is unavailable');
      }
      dark = { token: randomBytes(32).toString('base64url'), record, endpoint: before.endpoint,
        deadline: Date.now() + timeoutMs, used: false };
      try { return await requestDarkProbe(this.endpoint, dark, signal, timeoutMs); }
      finally { dark = null; }
    },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
    }) };
}

function sameToken(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7)); const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function requestDarkProbe(endpoint, dark, signal, timeoutMs) {
  const url = `${endpoint}/__nna/dark-attach`;
  const response = await fetch(url, { redirect: 'error', signal: signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  headers: { authorization: `Bearer ${dark.token}`, 'x-nnd-generation': dark.record.instance_id } });
  if (response.status !== 200 || response.redirected || response.url !== url) throw new ContractError('nnd_health_unavailable', 'Dark NND attach probe failed');
  const reader = response.body?.getReader();
  if (!reader) throw new ContractError('nnd_health_unavailable', 'Dark NND attach probe has no body');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.byteLength;
      if (size > 1024) { await reader.cancel(); throw new ContractError('nnd_health_unavailable', 'Dark NND attach probe is oversized'); }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ContractError('nnd_health_unavailable', 'Dark NND attach probe is malformed'); }
  const expected = { protocol: '1.0', installation_id: dark.record.installation_id,
    data_id: dark.record.data_id, generation: dark.record.instance_id, endpoint: dark.endpoint,
    service_state: value.service_state };
  if (Object.keys(value).sort().join(',') !== Object.keys(expected).sort().join(',')
    || !['ready', 'setup_required'].includes(value.service_state)
    || Object.entries(expected).some(([key, field]) => value[key] !== field)) {
    throw new ContractError('nnd_health_unavailable', 'Dark NND attach probe identity changed');
  }
  return Object.freeze(value);
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
    if (action === 'status') assertSelectedNndStatus(value, record);
    if (action === 'attach') assertNndAttach(value, record);
    return value;
  } catch (cause) { throw new ContractError('nnd_health_unavailable', 'Native NND controller is unavailable', { cause }); }
}
