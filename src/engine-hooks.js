// SPDX-License-Identifier: Apache-2.0
import { hookContexts } from './hook-runtime.js';

export async function dispatchSessionHook(engine, name, phase) {
  const event = engine.eventFactory.create(name, 'session', phase, {}, hookPayload(engine));
  const dispatch = await engine.events.dispatch(event);
  if (engine.store) await engine.store.append('lifecycle_event', event);
  return dispatch;
}

export async function dispatchTurnPreHook(engine, active, prompt) {
  const event = engine.eventFactory.create(
    'turn.pre', 'turn', 'pre', active,
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
    loaded_skills: engine.skills?.loadedIds() ?? Object.freeze([]),
    identity_scope: hookIdentityScope(engine), ...extra,
  });
}

export function hookIdentityScope(engine) {
  const hosted = engine.config?.executionManifest?.hostIdentity;
  const list = (value) => Object.freeze(Array.isArray(value) ? [...value] : []);
  return Object.freeze({
    schema: 'notnative.identity-scope/1.0',
    subject_id: hosted?.subjectId ?? 'local-operator',
    platform_role: hosted?.platformRole ?? 'local-operator',
    scope: hosted?.scope ?? 'workspace',
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
  const governed = engine.grounding?.admitHook
    ? await engine.grounding.admitHook(additions, {
      turnId: active.turnId, authorityRef: active.authority?.id,
      scope: `session:${engine.sessionId}`,
    }) : { admitted: additions };
  active.enrichment.hooks.push(...governed.admitted);
}
