// SPDX-License-Identifier: Apache-2.0
/** F9 step 1: bounded per-session primary-route override. The desktop client
 *  may name a configured provider and model for a session (multi-run); the
 *  engine factory validates the provider against the active configuration and
 *  nothing else (no factory options, endpoints, or manifests) crosses this
 *  boundary. */
import { ContractError } from './ids.js';

const boundedText = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;

export function modelRouteFromBody(body) {
  const providerId = body?.providerID;
  const model = body?.model;
  if (providerId === undefined && model === undefined) return null;
  if (!boundedText(providerId) || !boundedText(model) || /[\u0000-\u001f\u007f]/u.test(providerId)
    || /[\u0000-\u001f\u007f]/u.test(model)) {
    throw new ContractError('request_invalid', 'NND per-session model route requires a bounded provider id and model');
  }
  return { providerId, model };
}
