// SPDX-License-Identifier: Apache-2.0
/** Renewable-capability renewal endpoint for attach clients (execution guide
 *  02 L3). The bearer integration token remains the transport credential;
 *  the renewable scoped capability is the live authority grant that expires,
 *  revokes, and rotates with the issuing supervisor. Renewal requires the
 *  still-valid (or within-grace) capability and never accepts caller-supplied
 *  authority: the fresh token is derived from the verified previous one. */
import { readJsonBody, send, sendFailure } from './secret-broker-server.js';
import { ContractError } from './ids.js';

const RENEW_ROUTE = /^\/v1\/desktop\/capability\/renew$/u;

export function isCapabilityRenewalRequest(request, url) {
  return request.method === 'POST' && RENEW_ROUTE.test(url.pathname);
}

export async function dispatchDesktopCapabilityRequest(request, response, context) {
  if (!context.capabilityAuthority || !RENEW_ROUTE.test(context.url.pathname)) return false;
  if (request.method !== 'POST') {
    return send(response, 405, failure('method_not_allowed', 'capability renewal is POST only'));
  }
  let body;
  try { body = await readJsonBody(request); }
  catch { return send(response, 400, failure('capability_request_invalid', 'capability renewal body is invalid')); }
  if (!body || typeof body !== 'object' || Object.keys(body).some((key) => key !== 'capability')
    || typeof body.capability !== 'string' || body.capability.length > 16 * 1024) {
    return send(response, 400, failure('capability_request_invalid', 'capability renewal requires the current capability'));
  }
  try {
    const renewed = context.capabilityAuthority.renew(body.capability);
    return send(response, 200, { capability: renewed, key_id: context.capabilityAuthority.keyId });
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    return sendFailure(response, error);
  }
}

function failure(code, message) { return { error: { code, message } }; }
