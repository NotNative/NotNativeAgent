// SPDX-License-Identifier: Apache-2.0

const MAX_ACTIVE_TOOLS = 64;

/** Ephemeral, bounded tool state for one live turn. Never projects arguments,
 * targets, provider IDs, or raw tool results into session metadata. */
export class NndActiveTools {
  #tools = new Map();
  #unavailable = false;

  observe(record) {
    if (record?.type !== 'tool_status' || this.#unavailable) return false;
    const id = record.tool_request_id ?? record.provider_call_id;
    if (typeof id !== 'string' || !id || id.length > 256) {
      // An uncorrelated lifecycle event makes even an empty snapshot
      // incomplete: callers may still show NNA's generic turn phase.
      return record.status === 'running' || this.#tools.size ? this.#invalidate() : false;
    }
    if (record.status !== 'running') return this.#tools.delete(id);
    const name = record.tool;
    if (typeof name !== 'string' || !name.trim() || name.length > 128
      || /[\u0000-\u001f\u007f]/u.test(name)) return false;
    if (!this.#tools.has(id) && this.#tools.size >= MAX_ACTIVE_TOOLS) return this.#invalidate();
    if (this.#tools.get(id) === name) return false;
    this.#tools.set(id, name);
    return true;
  }

  projection() {
    return this.#unavailable ? null : { count: this.#tools.size, names: [...this.#tools.values()] };
  }

  #invalidate() {
    this.#tools.clear();
    this.#unavailable = true;
    return true;
  }
}
