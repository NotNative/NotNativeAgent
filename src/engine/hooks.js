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
  return Object.freeze({
    cwd: engine.config.workspaceRoot, prompt: active?.prompt ?? '',
    model_name: active?.modelName ?? '', transcript_path: engine.store?.path ?? '',
    loaded_skills: typeof engine.skills?.loadedIds === 'function'
      ? engine.skills.loadedIds() : Object.freeze([]),
    identity_scope: hookIdentityScope(engine), ...extra,
  });
}

export function hookIdentityScope(engine) {
  const hosted = engine.config?.executionManifest?.hostIdentity;
  const list = (value) => Object.freeze(Array.isArray(value) ? [...value] : []);
  return Object.freeze({
    schema: IDENTITY_SCOPE_SCHEMA,
    subject_id: hosted?.subjectId ?? LOCAL_OPERATOR_ROLE,
    platform_role: hosted?.platformRole ?? LOCAL_OPERATOR_ROLE,
    scope: hosted?.scope ?? WORKSPACE_SCOPE,
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
  const governed = engine.grounding?.admitHook
    ? await engine.grounding.admitHook(novel, {
      turnId: active.turnId, authorityRef: active.authority?.id,
      scope: `session:${engine.sessionId}`,
    }) : { admitted: additions };
  active.enrichment.hooks.push(...governed.admitted);
}

function hookContextKey(item) { return `${item?.source ?? ''}\u0000${item?.content ?? ''}`; }

function assertHookTurn(active) {
  if (!active || typeof active !== 'object' || !active.authority?.id || !active.controller?.signal) {
    throw new ContractError('hook_turn_invalid', 'hook dispatch requires an active authorized turn');
  }
}
