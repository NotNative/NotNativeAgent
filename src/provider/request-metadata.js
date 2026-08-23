// SPDX-License-Identifier: Apache-2.0

const METADATA = new WeakMap();

export function attachProviderRequestMetadata(request, metadata) {
  METADATA.set(request, Object.freeze({
    injectedMessageIndexes: Object.freeze([...(metadata.injectedMessageIndexes ?? [])]),
  }));
  return request;
}

export function providerRequestMetadata(request) {
  return METADATA.get(request) ?? null;
}
