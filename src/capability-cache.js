// SPDX-License-Identifier: Apache-2.0

export class CapabilityCache {
  #entries = new Map();

  get(resolution, operation, configVersion) {
    return this.#entries.get(keyFor(resolution, operation, configVersion))?.supported ?? 'unknown';
  }

  record(resolution, operation, configVersion, supported) {
    this.#entries.set(keyFor(resolution, operation, configVersion), Object.freeze({
      supported, recordedAt: Date.now(), profileId: resolution.profile.id,
      endpoint: resolution.profile.endpoint, model: resolution.model, operation, configVersion,
    }));
  }

  invalidate() {
    this.#entries.clear();
  }
}

function keyFor(resolution, operation, configVersion) {
  return JSON.stringify([
    resolution.profile.id, resolution.profile.endpoint, resolution.model, operation, configVersion,
  ]);
}

