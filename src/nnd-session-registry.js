// SPDX-License-Identifier: Apache-2.0
import { ContractError, requireExternalId } from './ids.js';
import { CanonicalIngress } from './ingress.js';
import { configuredModelProjection } from './nnd-session-description.js';

const TRANSCRIPT_LIMIT = 200;
const TRANSCRIPT_CHARS = 262_144;

export class NndSessionRegistry {
  #sessions = new Map();
  constructor(limit = 256, observer = null) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ContractError('nnd_session_capacity_invalid', 'NND session registry capacity must be a positive integer');
    }
    this.limit = limit;
    this.observer = observer;
  }
  register(sessionId, parentId, principal, engine, options = {}) {
    if (!principal || typeof principal !== 'object' || typeof principal.subjectId !== 'string') return null;
    requireExternalId(sessionId, 'session_id');
    requireExternalId(parentId, 'session_id');
    if (!Array.isArray(principal.workspaceIds) || principal.workspaceIds.length === 0
      || principal.workspaceIds.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new ContractError('nnd_principal_invalid', 'NND child session requires an authenticated principal');
    }
    if (!engine || typeof engine !== 'object') throw new ContractError('nnd_engine_invalid', 'NND child engine is required');
    if (this.#sessions.has(sessionId)) throw new ContractError('nnd_session_exists', 'NND child session already exists');
    // Why: completed views are bounded cache entries; evict one before refusing
    // a new live child so transcript inspection cannot block delegated work.
    if (this.#sessions.size >= this.limit) {
      const completed = [...this.#sessions].find(([, item]) => item.engine === null);
      if (completed) {
        this.#sessions.delete(completed[0]);
        this.#notify('deleted', completed[1]);
      }
    }
    if (this.#sessions.size >= this.limit) throw new ContractError('nnd_session_capacity', 'NND session registry is full');
    const createdAt = Date.now();
    const record = {
      sessionId, parentId, subjectId: principal.subjectId, workspaceIds: new Set(principal.workspaceIds ?? []),
      engine, ingress: new CanonicalIngress(engine), revision: 1,
      directory: engine.config?.workspaceRoot ?? '', createdAt, updatedAt: createdAt,
      title: `Subagent${typeof options.type === 'string' ? ` · ${options.type}` : ''}`,
      configuredModel: configuredModelProjection(engine),
      transcript: [],
    };
    this.#sessions.set(sessionId, record);
    this.#notify('registered', record);
    return (outcome = null) => {
      if (this.#sessions.get(sessionId) !== record) return;
      record.transcript = boundedTranscript(engine.transcript);
      record.engine = null;
      record.ingress = null;
      record.updatedAt = Date.now();
      record.revision += 1;
      this.#notify('completed', record, { outcome });
    };
  }
  observeStarted(sessionId) {
    const record = this.#sessions.get(sessionId);
    if (record?.engine) this.#notify('started', record);
  }
  observeOutput(sessionId, output) {
    const record = this.#sessions.get(sessionId);
    if (record?.engine && output?.session_id === sessionId) this.#notify('output', record, output);
  }
  unregisterParent(parentId) {
    let removed = 0;
    for (const [sessionId, record] of this.#sessions) {
      if (record.parentId === parentId) {
        this.#sessions.delete(sessionId);
        this.#notify('deleted', record);
        removed += 1;
      }
    }
    return removed;
  }
  resolve = async (sessionId, principal) => {
    const record = this.#sessions.get(sessionId);
    if (!record || !samePrincipal(record, principal)) return null;
    const steerGranted = Boolean(record.engine?.active && !record.engine.active.finalized);
    return {
      sessionId, revision: record.revision, availability: steerGranted ? 'granted' : 'unavailable',
      steerSubagent: steerGranted,
      steer: steerGranted ? async (command, actor) => {
        if (this.#sessions.get(sessionId) !== record || !samePrincipal(record, actor)
          || !record.engine?.active || record.engine.active.finalized || !record.ingress) {
          throw new ContractError('steering_unavailable', 'NND child steering grant is no longer active');
        }
        return record.ingress.submit({ version: '1.0', type: 'steer',
          request_id: command?.request_id, content: command?.content }, actor);
      } : undefined,
    };
  };

  list(principal) {
    return [...this.#sessions.values()].filter((record) => samePrincipal(record, principal)).map(describeChild);
  }

  get(sessionId, principal) {
    const record = this.#sessions.get(sessionId);
    return record && samePrincipal(record, principal) ? describeChild(record) : null;
  }

  messages(sessionId, principal) {
    const record = this.#sessions.get(sessionId);
    if (!record || !samePrincipal(record, principal)) return null;
    return record.engine ? boundedTranscript(record.engine.transcript) : record.transcript;
  }

  statuses(principal) {
    const statuses = {};
    for (const record of this.#sessions.values()) {
      if (samePrincipal(record, principal) && record.engine?.active && !record.engine.active.finalized) {
        statuses[record.sessionId] = { type: 'busy' };
      }
    }
    return statuses;
  }

  #notify(type, record, payload = null) {
    if (typeof this.observer !== 'function') return;
    try { this.observer(type, describeChild(record), payload); }
    catch { /* NND display observation cannot fail delegated engine work. */ }
  }
}
function samePrincipal(record, principal) {
  return principal?.subjectId === record.subjectId && Array.isArray(principal.workspaceIds)
    && [...record.workspaceIds].every((id) => principal.workspaceIds.includes(id));
}

function describeChild(record) {
  return { id: record.sessionId, slug: record.sessionId, parentID: record.parentId,
    projectID: record.workspaceIds.values().next().value, directory: record.directory,
    title: record.title, version: '1.0',
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(record.configuredModel ? { metadata: { nnd: { configuredModel: record.configuredModel } } } : {}),
    time: { created: record.createdAt, updated: record.updatedAt },
  };
}

function boundedTranscript(transcript) {
  if (!Array.isArray(transcript)) return [];
  const entries = [];
  let remaining = TRANSCRIPT_CHARS;
  for (let index = transcript.length - 1; index >= 0 && entries.length < TRANSCRIPT_LIMIT && remaining >= 64; index -= 1) {
    const item = transcript[index];
    if (item?.type !== 'message' || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string') continue;
    const marker = '[Earlier text omitted from this bounded view]\n';
    const content = item.content.length > remaining
      ? `${marker}${item.content.slice(-(remaining - marker.length))}` : item.content;
    entries.push({ item: { type: 'message', role: item.role, content }, index });
    remaining -= content.length;
  }
  return entries.reverse();
}
