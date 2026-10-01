// SPDX-License-Identifier: Apache-2.0
import { ContractError, requireExternalId } from './ids.js';
import { CanonicalIngress } from './ingress.js';
import { configuredModelProjection, latestTurnNeedsInput } from './nnd-session-description.js';
import { nndPhaseFromOutput, shouldClearNndToolPhase } from './nnd-turn-state.js';
import { NndActiveTools } from './nnd-active-tools.js';
import { pendingRequests } from './nnd-pending-requests.js';

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
    const agent = childAgentType(options.type);
    const record = {
      sessionId, parentId, subjectId: principal.subjectId, workspaceIds: new Set(principal.workspaceIds ?? []),
      engine, ingress: new CanonicalIngress(engine), revision: 1,
      directory: engine.config?.workspaceRoot ?? '', createdAt, updatedAt: createdAt,
      title: `Subagent${agent ? ` · ${agent}` : ''}`, agent,
      configuredModel: configuredModelProjection(engine),
      activeTools: new NndActiveTools(),
      transcript: [],
    };
    this.#sessions.set(sessionId, record);
    this.#notify('registered', record);
    return (outcome = null) => {
      if (this.#sessions.get(sessionId) !== record) return;
      record.transcript = boundedTranscript(engine.transcript);
      record.engine = null;
      record.ingress = null;
      record.turnState = 'idle';
      record.activeTools = null;
      record.attention = outcome === 'needs_input';
      // Invariant: a wall-clock correction cannot make a retained child invalid on recovery.
      record.updatedAt = Math.max(Date.now(), record.updatedAt + 1, record.createdAt);
      record.revision += 1;
      this.#notify('completed', record, { outcome });
    };
  }
  completedSnapshot(sessionId, parentCreatedAt) {
    const record = this.#sessions.get(sessionId);
    if (!record || record.engine || !Number.isSafeInteger(parentCreatedAt)) return null;
    return { version: 1, sessionId: record.sessionId, parentId: record.parentId, parentCreatedAt,
      subjectId: record.subjectId, workspaceIds: [...record.workspaceIds], directory: record.directory,
      title: record.title, ...(record.agent ? { agent: record.agent } : {}), configuredModel: record.configuredModel, createdAt: record.createdAt,
      updatedAt: record.updatedAt, transcript: record.transcript };
  }
  restoreCompleted(snapshot) {
    if (this.#sessions.has(snapshot.sessionId) || this.#sessions.size >= this.limit) {
      throw new ContractError('nnd_child_snapshot_capacity', 'NND child snapshot count exceeds its bound');
    }
    this.#sessions.set(snapshot.sessionId, {
      sessionId: snapshot.sessionId, parentId: snapshot.parentId, subjectId: snapshot.subjectId,
      workspaceIds: new Set(snapshot.workspaceIds), engine: null, ingress: null, revision: 1,
      directory: snapshot.directory, title: snapshot.title, agent: snapshot.agent ?? null, configuredModel: snapshot.configuredModel,
      createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt, transcript: snapshot.transcript,
      turnState: 'idle',
      attention: latestTurnNeedsInput(snapshot.activity),
    });
  }
  observeStarted(sessionId) {
    const record = this.#sessions.get(sessionId);
    if (record?.engine) this.#notify('started', record);
  }
  observeOutput(sessionId, output) {
    const record = this.#sessions.get(sessionId);
    if (record?.engine && output?.session_id === sessionId) {
      const phase = nndPhaseFromOutput(output);
      if (phase && phase !== record.turnState) {
        record.turnState = phase;
        record.updatedAt = Math.max(Date.now(), record.updatedAt + 1);
        this.#notify('phase', record);
      }
      if (record.activeTools?.observe(output)) {
        record.updatedAt = Math.max(Date.now(), record.updatedAt + 1);
        this.#notify('phase', record);
      }
      if (shouldClearNndToolPhase(output, record.turnState, record.activeTools?.projection())) {
        record.turnState = null;
        record.updatedAt = Math.max(Date.now(), record.updatedAt + 1);
        this.#notify('phase', record);
      }
      this.#notify('output', record, output);
    }
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

  belongsToParent(sessionId, parent) {
    const record = this.#sessions.get(sessionId);
    return Boolean(record && record.parentId === parent.sessionId && record.subjectId === parent.subjectId
      && record.workspaceIds.size === parent.workspaceIds.size
      && [...record.workspaceIds].every((id) => parent.workspaceIds.has(id)));
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

  pendingRequests(principal) {
    const sessions = Object.create(null);
    for (const record of this.#sessions.values()) {
      if (samePrincipal(record, principal)) sessions[record.sessionId] = pendingRequests(record.engine);
    }
    return sessions;
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
    title: record.title, ...(record.agent ? { agent: record.agent } : {}), version: '1.0',
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(record.configuredModel || record.turnState || record.attention || record.activeTools?.projection() ? { metadata: { nnd: {
      ...(record.configuredModel ? { configuredModel: record.configuredModel } : {}),
      ...(record.turnState ? { turnState: { phase: record.turnState } } : {}),
      ...(record.activeTools?.projection() ? { activeTools: record.activeTools.projection() } : {}),
      ...(record.attention ? { attention: { kind: 'needs_input' } } : {}),
    } } } : {}),
    time: { created: record.createdAt, updated: record.updatedAt },
  };
}

function childAgentType(value) {
  return typeof value === 'string' && value.trim() && value.trim().length <= 128
    && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : null;
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
