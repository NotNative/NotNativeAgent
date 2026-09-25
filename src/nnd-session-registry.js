// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { CanonicalIngress } from './ingress.js';

export class NndSessionRegistry {
  #sessions = new Map();
  constructor(limit = 256) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ContractError('nnd_session_capacity_invalid', 'NND session registry capacity must be a positive integer');
    }
    this.limit = limit;
  }
  register(sessionId, parentId, principal, engine) {
    if (!principal || typeof principal !== 'object' || typeof principal.subjectId !== 'string') return null;
    if (!engine || typeof engine !== 'object') throw new ContractError('nnd_engine_invalid', 'NND child engine is required');
    if (this.#sessions.size >= this.limit) throw new ContractError('nnd_session_capacity', 'NND session registry is full');
    const record = {
      sessionId, parentId, subjectId: principal.subjectId, workspaceIds: new Set(principal.workspaceIds ?? []),
      ingress: new CanonicalIngress(engine), revision: 1,
    };
    this.#sessions.set(sessionId, record);
    return () => this.#sessions.delete(sessionId);
  }
  unregisterParent(parentId) {
    let removed = 0;
    for (const [sessionId, record] of this.#sessions) {
      if (record.parentId === parentId) {
        this.#sessions.delete(sessionId);
        removed += 1;
      }
    }
    return removed;
  }
  resolve = async (sessionId, principal) => {
    const record = this.#sessions.get(sessionId);
    if (!record || !samePrincipal(record, principal)) return null;
    const steerGranted = Boolean(record.ingress.engine?.active && !record.ingress.engine.active.finalized);
    return {
      sessionId, revision: record.revision, availability: steerGranted ? 'granted' : 'unavailable',
      steerSubagent: steerGranted,
      steer: steerGranted ? async (command, actor) => record.ingress.submit({
        version: '1.0', type: 'steer', request_id: command?.request_id, content: command?.content,
      }, actor) : undefined,
    };
  };
}
function samePrincipal(record, principal) {
  return principal?.subjectId === record.subjectId && (principal.workspaceIds ?? []).some((id) => record.workspaceIds.has(id));
}
