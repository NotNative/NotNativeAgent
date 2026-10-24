// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from './ids.js';
import { credentialReference } from './credential-bindings.js';

const AUTHORITY_STATEMENT_KINDS = new Set(['statement', 'instruction', 'clarification', 'restriction']);

export class AuthorityRecord {
  #id = newId('auth');
  #version = 0;
  #restrictionVersion = 0;
  #intent = [];
  #complete = true;
  #missionTurns = new Map();
  #missionToolCalls = new Map();
  #missionStartedAt = new Map();

  addAuthenticatedIntent(content, origin, options = {}) {
    const kind = options.kind ?? 'statement';
    if (!AUTHORITY_STATEMENT_KINDS.has(kind)) {
      throw new ContractError('authority_statement_kind_invalid', 'authenticated authority statement kind is invalid');
    }
    const turnId = options.turnId === undefined ? undefined : this.#assertTurnId(options.turnId);
    const owned = ownedOrigin(origin, true);
    this.#version += 1;
    if (kind === 'restriction') this.#restrictionVersion += 1;
    const item = Object.freeze({
      content, origin: owned, sequence: this.#version, kind,
      ...(turnId === undefined ? {} : { turnId }),
    });
    this.#intent.push(item);
    return Object.freeze({ ...item, lineageId: this.#id, restrictionVersion: this.#restrictionVersion });
  }

  #assertTurnId(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
      throw new ContractError('authority_turn_id_invalid', 'authenticated authority turn identity is invalid');
    }
    return value;
  }

  rollbackAuthenticatedIntent(sequence) {
    const item = this.#intent.at(-1);
    if (!item || item.sequence !== sequence) throw new ContractError('authority_rollback_invalid', 'authority rollback is not the latest intent');
    this.#intent.pop();
    this.#version -= 1;
    if (item.kind === 'restriction') this.#restrictionVersion -= 1;
  }

  restore(records, missionUsage = [], options = {}) {
    if (!Array.isArray(records) || records.length > 1_000_000) throw new ContractError('authority_journal_invalid', 'authority recovery exceeds bounds');
    if (!Array.isArray(missionUsage) || missionUsage.length > 1_000_000) {
      throw new ContractError('authority_journal_invalid', 'mission budget recovery exceeds bounds');
    }
    if (options.requireMissionUsage && options.missionUsageComplete === false) {
      throw new ContractError('mission_budget_history_incomplete', 'mission budget history is outside the bounded recovery window');
    }
    let lineage = null;
    let restrictionVersion = 0;
    const intent = [];
    for (const record of records) {
      if (!record || typeof record.content !== 'string' || !validRestoredOrigin(record.origin)
        || typeof record.lineageId !== 'string' || (lineage && record.lineageId !== lineage)) {
        throw new ContractError('authority_journal_invalid', 'authority recovery record is invalid');
      }
      lineage ??= record.lineageId;
      const kind = record.kind ?? 'statement';
      if (!AUTHORITY_STATEMENT_KINDS.has(kind)) {
        throw new ContractError('authority_statement_kind_invalid', 'authenticated authority statement kind is invalid');
      }
      const turnId = record.turnId === undefined ? undefined : this.#assertTurnId(record.turnId);
      if (kind === 'restriction') restrictionVersion += 1;
      intent.push(Object.freeze({ content: record.content, origin: ownedOrigin(record.origin),
        sequence: intent.length + 1, kind, ...(turnId === undefined ? {} : { turnId }) }));
    }
    const missionTurns = new Map();
    const missionToolCalls = new Map();
    const missionStartedAt = new Map();
    for (const record of missionUsage) {
      const toolCalls = record?.toolCalls ?? 0;
      const startedAt = record?.startedAt
        ?? Date.parse(record?.authorizedAt ?? record?.reservedAt ?? '');
      if (!record || typeof record.missionId !== 'string' || !Number.isSafeInteger(record.turns) || record.turns < 1
        || !Number.isSafeInteger(toolCalls) || toolCalls < 0 || !Number.isFinite(startedAt)) {
        throw new ContractError('authority_journal_invalid', 'mission budget recovery record is invalid');
      }
      missionTurns.set(record.missionId, Math.max(missionTurns.get(record.missionId) ?? 0, record.turns));
      missionToolCalls.set(record.missionId, Math.max(missionToolCalls.get(record.missionId) ?? 0, toolCalls));
      missionStartedAt.set(record.missionId, Math.min(missionStartedAt.get(record.missionId) ?? startedAt, startedAt));
    }
    if (lineage) this.#id = lineage;
    this.#complete = options.conversationComplete ?? true;
    this.#version = intent.length;
    this.#restrictionVersion = restrictionVersion;
    this.#intent = intent;
    this.#missionTurns = missionTurns;
    this.#missionToolCalls = missionToolCalls;
    this.#missionStartedAt = missionStartedAt;
  }

  clearConversation() {
    this.#id = newId('auth'); this.#version = 0; this.#restrictionVersion = 0; this.#intent = []; this.#complete = true;
  }

  snapshot(config) {
    const mission = config.mission ? { ...structuredClone(config.mission), usage: this.missionUsage(config.mission.id) } : null;
    const now = Date.now();
    const notBefore = mission ? Date.parse(mission.schedule?.notBefore ?? '') : null;
    const expiresAt = mission ? Date.parse(mission.expiresAt ?? '') : null;
    if (mission && (!Number.isFinite(notBefore) || !Number.isFinite(expiresAt))) {
      throw new ContractError('mission_time_invalid', 'mission authority requires valid activation and expiration timestamps');
    }
    if (mission && notBefore > now) {
      throw new ContractError('mission_not_started', 'mission authority is not active yet');
    }
    if (mission && expiresAt <= now) {
      throw new ContractError('mission_expired', 'mission authority has expired and must be renewed by the authenticated host');
    }
    if (mission && mission.usage.startedAt !== null
      && now - mission.usage.startedAt >= mission.bounds.maxDurationMs) {
      throw new ContractError('mission_duration_limit', 'mission duration budget is exhausted');
    }
    return Object.freeze({
      id: this.#id,
      version: this.#version,
      restrictionVersion: this.#restrictionVersion,
      complete: this.#complete,
      scope: mission ? 'mission' : 'conversation',
      intent: Object.freeze(this.#intent.map((item) => ({ ...item }))),
      mission: mission ? Object.freeze(mission) : null,
      principal: config.provenance,
      reviewRequired: true,
    });
  }

  authorizeTurn(config) {
    const mission = config.mission;
    if (mission) {
      this.snapshot(config);
      const primaryProviderId = config.routes?.primary?.providerId;
      const profile = primaryProviderId ? config.providerProfiles?.[primaryProviderId] : null;
      const credential = credentialReference(profile?.credential);
      if (credential && !mission.credentialRefs.includes(credential)) {
        throw new ContractError('mission_credential_denied', 'primary provider credential is outside the mission envelope');
      }
      const turns = (this.#missionTurns.get(mission.id) ?? 0) + 1;
      if (turns > mission.bounds.maxTurns) throw new ContractError('mission_turn_limit', 'mission turn budget is exhausted');
      this.#missionTurns.set(mission.id, turns);
      if (!this.#missionStartedAt.has(mission.id)) this.#missionStartedAt.set(mission.id, Date.now());
      try { return this.snapshot(config); }
      catch (error) { this.rollbackMissionTurn(mission.id); throw error; }
    }
    return this.snapshot(config);
  }

  missionTurns(id) { return this.#missionTurns.get(id) ?? 0; }

  missionUsage(id) {
    return Object.freeze({
      turns: this.#missionTurns.get(id) ?? 0, toolCalls: this.#missionToolCalls.get(id) ?? 0,
      startedAt: this.#missionStartedAt.get(id) ?? null,
    });
  }

  reserveMissionToolCalls(mission, count) {
    if (!Number.isSafeInteger(count) || count < 0) throw new ContractError('mission_tool_limit', 'mission tool-call reservation is invalid');
    const next = (this.#missionToolCalls.get(mission.id) ?? 0) + count;
    if (next > mission.bounds.maxToolCalls) throw new ContractError('mission_tool_limit', 'mission tool-call budget is exhausted');
    this.#missionToolCalls.set(mission.id, next);
  }

  rollbackMissionToolCalls(id, count) {
    const prior = this.#missionToolCalls.get(id) ?? 0;
    if (count > prior) throw new ContractError('mission_rollback_invalid', 'mission tool rollback exceeds use');
    this.#missionToolCalls.set(id, prior - count);
  }

  rollbackMissionTurn(id) {
    const turns = this.#missionTurns.get(id) ?? 0;
    if (turns <= 0) throw new ContractError('mission_rollback_invalid', 'mission turn rollback has no matching use');
    if (turns === 1) {
      this.#missionTurns.delete(id);
      this.#missionStartedAt.delete(id);
    } else this.#missionTurns.set(id, turns - 1);
  }
}

function validRestoredOrigin(value) {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  // Security: NNO principals carry the complete envelope; NND session hosts can
  // supply a smaller authenticated principal. Recovery accepts only owned fields.
  const keys = ['subjectId', 'platformRole', 'permissions', 'workspaceIds', 'groupIds', 'traceId', 'issuedAt', 'requestId'];
  const bounded = (text) => typeof text === 'string' && text.trim().length > 0 && text.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(text);
  const list = (items) => Array.isArray(items) && items.length <= 512 && items.every(bounded);
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === Object.keys(value).length && ownKeys.every((key) => keys.includes(key))
    && Object.hasOwn(value, 'subjectId') && Object.hasOwn(value, 'workspaceIds')
    && bounded(value.subjectId) && list(value.workspaceIds)
    && (value.platformRole === undefined || bounded(value.platformRole))
    && (value.traceId === undefined || bounded(value.traceId))
    && (value.requestId === undefined || bounded(value.requestId))
    && (value.permissions === undefined || list(value.permissions))
    && (value.groupIds === undefined || list(value.groupIds))
    && (value.issuedAt === undefined || bounded(value.issuedAt) && Number.isFinite(Date.parse(value.issuedAt)));
}

function ownedOrigin(origin, allowDate = false) {
  if (typeof origin === 'string') return origin;
  if (origin && typeof origin === 'object' && Reflect.ownKeys(origin).length !== Object.keys(origin).length) {
    throw new ContractError('authority_origin_invalid', 'authenticated authority origin is invalid');
  }
  const issuedAt = allowDate && origin?.issuedAt instanceof Date && Number.isFinite(origin.issuedAt.getTime())
    ? origin.issuedAt.toISOString() : origin?.issuedAt;
  const candidate = origin && typeof origin === 'object' && !Array.isArray(origin)
    ? { ...origin, ...(Object.hasOwn(origin, 'issuedAt') ? { issuedAt } : {}) } : origin;
  if (!validRestoredOrigin(candidate)) {
    throw new ContractError('authority_origin_invalid', 'authenticated authority origin is invalid');
  }
  const owned = { subjectId: candidate.subjectId,
    workspaceIds: Object.freeze([...candidate.workspaceIds]) };
  for (const key of ['platformRole', 'traceId', 'requestId', 'issuedAt']) {
    if (candidate[key] !== undefined) owned[key] = candidate[key];
  }
  for (const key of ['permissions', 'groupIds']) {
    if (candidate[key] !== undefined) owned[key] = Object.freeze([...candidate[key]]);
  }
  return Object.freeze(owned);
}

export function assertMissionBudget(active, additionalToolCalls = 0) {
  const mission = active.authority?.mission;
  if (!mission) return;
  if (Date.now() - (mission.usage?.startedAt ?? active.startedAt) >= mission.bounds.maxDurationMs) {
    throw new ContractError('mission_duration_limit', 'mission duration budget is exhausted');
  }
  if ((mission.usage?.toolCalls ?? active.toolCalls) + additionalToolCalls > mission.bounds.maxToolCalls) {
    throw new ContractError('mission_tool_limit', 'mission tool-call budget is exhausted');
  }
}

export function missionConditionFailure(active, condition, cause = null) {
  const mission = active.authority?.mission;
  if (!mission) return null;
  const terminal = mission.termination.terminateOn.includes(condition);
  const suspended = mission.termination.suspendOn.includes(condition);
  if (!terminal && !suspended) return null;
  const error = new ContractError(
    terminal ? 'mission_terminated' : 'mission_suspended',
    `mission ${terminal ? 'terminated' : 'suspended'} by declared condition ${condition}`,
  );
  error.missionId = mission.id;
  error.missionCondition = condition;
  error.missionPolicy = terminal ? 'terminate_turn' : 'suspend_mission';
  error.causeCode = cause?.code ?? null;
  return error;
}

export function armMissionDeadline(active) {
  const mission = active.authority?.mission;
  if (!mission) return;
  const durationAt = mission.usage.startedAt + mission.bounds.maxDurationMs;
  const expirationAt = Date.parse(mission.expiresAt);
  const expiresFirst = expirationAt <= durationAt;
  const deadline = expiresFirst ? expirationAt : durationAt;
  const code = expiresFirst ? 'mission_expired' : 'mission_duration_limit';
  const message = expiresFirst ? 'mission authority expired during active work' : 'mission duration budget expired during active work';
  const expire = () => {
    active.missionFailure = new ContractError(code, message);
    active.controller.abort();
  };
  const remaining = deadline - Date.now();
  if (remaining <= 0) { expire(); throw active.missionFailure; }
  active.missionTimer = setTimeout(expire, remaining);
}

export function missionFailureForError(active, error) {
  const cause = active?.missionFailure ?? error;
  if (cause?.code === 'mission_expired') return missionConditionFailure(active, 'expiration', cause) ?? cause;
  if (/^mission_(?:duration|turn|tool)_limit$/u.test(cause?.code ?? '')) {
    return missionConditionFailure(active, 'budget_exhaustion', cause) ?? cause;
  }
  if (/^(?:provider|route)_/u.test(cause?.code ?? '')) return missionConditionFailure(active, 'provider_failure', cause) ?? cause;
  return cause;
}

export async function persistAuthenticatedIntent(authority, content, origin, persist, options = {}) {
  const intent = authority.addAuthenticatedIntent(content, origin, options);
  try { await persist(intent); }
  catch (error) { authority.rollbackAuthenticatedIntent(intent.sequence); throw error; }
  return intent;
}

export async function authorizeAndPersistTurn(authority, config, persist) {
  const snapshot = authority.authorizeTurn(config);
  if (!config.mission) return snapshot;
  const usage = authority.missionUsage(config.mission.id);
  const record = Object.freeze({
    missionId: config.mission.id, revocationId: config.mission.revocationId,
    ...usage, authorizedAt: new Date().toISOString(),
  });
  try { await persist(record); }
  catch (error) { authority.rollbackMissionTurn(config.mission.id); throw error; }
  return snapshot;
}

export async function reserveAndPersistMissionTools(authority, config, count, persist) {
  if (!config.mission || count === 0) return authority.snapshot(config);
  authority.reserveMissionToolCalls(config.mission, count);
  const record = Object.freeze({
    missionId: config.mission.id, revocationId: config.mission.revocationId,
    ...authority.missionUsage(config.mission.id), reservedAt: new Date().toISOString(),
  });
  try { await persist(record); }
  catch (error) { authority.rollbackMissionToolCalls(config.mission.id, count); throw error; }
  return authority.snapshot(config);
}
