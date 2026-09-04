// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const METADATA = new WeakMap();

export function attachProviderRequestMetadata(request, metadata) {
  if (!request || typeof request !== 'object' || !metadata || typeof metadata !== 'object'
    || Array.isArray(metadata) || !Array.isArray(metadata.injectedMessageIndexes ?? [])
    || !Array.isArray(metadata.accountingSections ?? [])) {
    throw new ContractError('provider_request_metadata_invalid', 'provider request metadata requires object and array containers');
  }
  METADATA.set(request, Object.freeze({
    injectedMessageIndexes: Object.freeze([...(metadata.injectedMessageIndexes ?? [])]),
    accountingSections: Object.freeze((metadata.accountingSections ?? []).map((item) => Object.freeze({ ...item }))),
  }));
  return request;
}

export function providerRequestMetadata(request) {
  return METADATA.get(request) ?? null;
}
