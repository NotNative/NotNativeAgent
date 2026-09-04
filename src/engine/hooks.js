// SPDX-License-Identifier: Apache-2.0
import { hookContexts } from '../hook-runtime.js';
import { ContractError } from '../ids.js';

const LIFECYCLE_EVENT_RECORD = 'lifecycle_event';
const TURN_PRE_EVENT = 'turn.pre';
const TURN_ENTITY = 'turn';
const PRE_PHASE = 'pre';
const IDENTITY_SCOPE_SCHEMA = 'notnative.identity-scope/1.0';
const LOCAL_OPERATOR_ROLE = 'local-operator';
const WORKSPACE_SCOPE = 'workspace';
const HOST_IDENTITY_UNAVAILABLE = 'host-identity-unavailable';

export async function dispatchSessionHook(engine, name, phase) {
  const event = engine.eventFactory.create(name, 'session', phase, {}, hookPayload(engine));
  const dispatch = await engine.events.dispatch(event);
  if (engine.store) await engine.store.append(LIFECYCLE_EVENT_RECORD, event);
  return dispatch;
}

export async function dispatchTurnPreHook(engine, active, prompt) {
  assertHookTurn(active);
  const event = engine.eventFactory.create(
    TURN_PRE_EVENT, TURN_ENTITY, PRE_PHASE, active,
    hookPayload(engine, active, { authority_snapshot_id: active.authority.id, prompt }),
  );
  const dispatch = await engine.events.dispatch(event, active.controller.signal);
  await addHookContexts(engine, active, dispatch);
  return dispatch.decision !== 'deny';
}

export function hookPayload(engine, active = null, extra = {}) {
  const loaded = typeof engine.skills?.loadedIds === 'function' ? engine.skills.loadedIds() : [];
  return Object.freeze({
    ...extra,
    cwd: engine.config.workspaceRoot, prompt: active?.prompt ?? '',
    model_name: active?.modelName ?? '', transcript_path: engine.store?.path ?? '',
    loaded_skills: Object.freeze(Array.isArray(loaded) ? [...loaded] : []),
    identity_scope: hookIdentityScope(engine),
  });
}

export function hookIdentityScope(engine) {
  const manifest = engine.config?.executionManifest;
  const hosted = manifest?.hostIdentity;
  const list = (value) => {
    if (value === undefined && !hosted) return Object.freeze([]);
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new ContractError('execution_manifest_mismatch', 'hosted hook identity contains an invalid scope list');
    }
    return Object.freeze([...value]);
  };
  if (hosted && [hosted.subjectId, hosted.platformRole, hosted.scope]
    .some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new ContractError('execution_manifest_mismatch', 'hosted hook identity is incomplete');
  }
  return Object.freeze({
    schema: IDENTITY_SCOPE_SCHEMA,
    subject_id: hosted?.subjectId ?? (manifest == null ? LOCAL_OPERATOR_ROLE : HOST_IDENTITY_UNAVAILABLE),
    platform_role: hosted?.platformRole ?? (manifest == null ? LOCAL_OPERATOR_ROLE : HOST_IDENTITY_UNAVAILABLE),
    scope: hosted?.scope ?? (manifest == null ? WORKSPACE_SCOPE : HOST_IDENTITY_UNAVAILABLE),
    workspace_ids: list(hosted?.workspaceIds),
    group_ids: list(hosted?.groupIds),
    module_ids: list(hosted?.moduleIds),
    project_root: engine.config?.workspaceRoot ?? '',
    session_id: engine.sessionId ?? '',
  });
}

export async function addHookContexts(engine, active, dispatch) {
  const additions = hookContexts(dispatch);
  if (additions.length === 0) return;
  assertHookTurn(active);
  if (!Array.isArray(active.enrichment?.hooks)) {
    throw new ContractError('hook_context_unavailable', 'active turn hook context is unavailable');
  }
  const seen = new Set(active.enrichment.hooks.map(hookContextKey));
  const novel = additions.filter((item) => {
    const key = hookContextKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (novel.length === 0) return;
  if (typeof engine.grounding?.admitHook !== 'function') {
    throw new ContractError('hook_context_unavailable', 'hook context grounding is unavailable');
  }
  const governed = await engine.grounding.admitHook(novel, {
    turnId: active.turnId, authorityRef: active.authority?.id,
    scope: `session:${engine.sessionId}`,
  });
  if (!Array.isArray(governed?.admitted)) {
    throw new ContractError('hook_context_unavailable', 'hook context grounding returned an invalid result');
  }
  active.enrichment.hooks.push(...governed.admitted);
}

function hookContextKey(item) { return `${item?.source ?? ''}\u0000${item?.content ?? ''}`; }

function assertHookTurn(active) {
  if (!active || typeof active !== 'object' || !active.authority?.id || !active.controller?.signal) {
    throw new ContractError('hook_turn_invalid', 'hook dispatch requires an active authorized turn');
  }
}
