// SPDX-License-Identifier: Apache-2.0
// OC-side session registry: holds live NNA engines keyed by OpenCode-shaped
// session ids and synthesizes the observed gold Session JSON shape.
import { createHash } from 'node:crypto';
import slugifyTitle from './slug.js';

export class OpenCodeSessionRegistry {
  #sessions = new Map();

  attach(record) {
    if (!record?.ocId || this.#sessions.has(record.ocId)) {
      throw new Error('session registry requires a unique ocId');
    }
    const stored = Object.freeze({ ...record, updatedAt: record.createdAt });
    this.#sessions.set(record.ocId, stored);
    return stored;
  }

  get(ocId) { return this.#sessions.get(ocId) ?? null; }
  list() {
    return [...this.#sessions.values()].slice().sort((left, right) => right.updatedAt - left.updatedAt);
  }
  remove(ocId) { return this.#sessions.delete(ocId); }
  count() { return this.#sessions.size; }

  /** Mark a session evicted: its engine is gone but its identity and history
   *  remain listed. Why a flag rather than removal: the client still lists and
   *  reads the conversation; only an arriving turn must re-attach first. */
  evict(ocId) {
    const record = this.#sessions.get(ocId);
    if (!record) return null;
    const dormant = Object.freeze({ ...record, engine: null, ingress: null, wireSession: null, evicted: true });
    this.#sessions.set(ocId, dormant);
    return dormant;
  }

  isEvicted(ocId) { return this.#sessions.get(ocId)?.evicted === true; }

  describe(record, wiredVersion) {
    return {
      id: record.ocId,
      slug: record.slug,
      projectID: projectIdentifier(record.directory),
      directory: record.directory,
      path: '',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      title: record.title,
      version: wiredVersion,
      // Compatibility: a forked session names the session it came from, which the
      // client uses to place it in the tree rather than the top-level list.
      ...(record.parentID ? { parentID: record.parentID } : {}),
      time: { created: record.createdAt, updated: record.updatedAt },
    };
  }

  touch(ocId) {
    // Why: gold Session objects carry time.updated; each wire-visible change
    // to a session moves its clock so OpenChamber ordering stays truthful.
    const record = this.#sessions.get(ocId);
    if (record) this.#sessions.set(ocId, Object.freeze({ ...record, updatedAt: Date.now() }));
    return record ?? null;
  }
}

export function projectIdentifier(directory) {
  return createHash('sha256').update(directory ?? '').digest('hex').slice(0, 40);
}

export { slugifyTitle };
