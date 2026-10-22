// SPDX-License-Identifier: Apache-2.0

const MAX_ENTRIES = 256;

export class CapabilityCache {
  #entries = new Map();

  get(resolution, operation, configVersion) {
    const key = keyFor(resolution, operation, configVersion);
    const entry = this.#entries.get(key);
    if (!entry) return 'unknown';
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.supported;
  }

  record(resolution, operation, configVersion, supported) {
    const key = keyFor(resolution, operation, configVersion);
    this.#entries.delete(key);
    this.#entries.set(key, Object.freeze({ supported }));
    if (this.#entries.size > MAX_ENTRIES) this.#entries.delete(this.#entries.keys().next().value);
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
