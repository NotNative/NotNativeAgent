// SPDX-License-Identifier: Apache-2.0
/** Published-GUI health proof for the supervised NND trial (execution guide
 *  02 L2): a live child PID does not prove that it still owns its former UI
 *  port, so the supervisor challenges the GUI with a nonce bound to the
 *  installation, data, generation, and port identity. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { ContractError } from './ids.js';

export async function verifyTrialGuiProof(state, requestSignal, fetchImpl) {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(state.uiHealthKey ?? '')) {
    throw new ContractError('nnd_health_unavailable', 'Unpublished NND GUI proof key is invalid');
  }
  const nonce = randomBytes(32).toString('base64url');
  const proofUrl = `${state.ui}/__nna/health-proof`;
  let proofResponse;
  try {
    proofResponse = await fetchImpl(proofUrl, { method: 'POST', redirect: 'manual', signal: requestSignal,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) });
  } catch { throw new ContractError('nnd_health_unavailable', 'Unpublished NND GUI proof did not respond'); }
  if (proofResponse.status !== 200 || proofResponse.redirected || proofResponse.url !== proofUrl) {
    throw new ContractError('nnd_health_unavailable', 'Unpublished NND GUI proof response is invalid');
  }
  const proof = await boundedHealthBody(proofResponse);
  if (!proof || Object.keys(proof).sort().join(',') !== 'mac,protocol' || proof.protocol !== '1.0'
    || typeof proof.mac !== 'string' || !/^[a-f0-9]{64}$/u.test(proof.mac)) {
    throw new ContractError('nnd_health_unavailable', 'Unpublished NND GUI proof body is invalid');
  }
  const expected = createHmac('sha256', Buffer.from(state.uiHealthKey, 'base64url'))
    .update(JSON.stringify(['NND_SUPERVISED_HEALTH_V1', nonce, state.identity.installation_id,
      state.identity.data_id, state.record.instance_id, state.ui])).digest();
  if (!timingSafeEqual(Buffer.from(proof.mac, 'hex'), expected)) {
    throw new ContractError('nnd_health_unavailable', 'Unpublished NND GUI proof identity differs');
  }
}

export async function boundedHealthBody(response) {
  let body;
  try {
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4096) { await reader.cancel(); throw new Error('bound'); }
      chunks.push(value);
    }
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  }
  catch { throw new ContractError('nnd_health_unavailable', 'Unpublished NND GUI health body is invalid'); }
  return body;
}
