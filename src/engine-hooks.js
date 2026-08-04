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
  addHookContexts(active, dispatch);
  return dispatch.decision !== 'deny';
}

export function hookPayload(engine, active = null, extra = {}) {
  return Object.freeze({
    cwd: engine.config.workspaceRoot, prompt: active?.prompt ?? '',
    model_name: active?.modelName ?? '', transcript_path: engine.store?.path ?? '',
    loaded_skills: engine.skills?.loadedIds() ?? Object.freeze([]), ...extra,
  });
}

export function addHookContexts(active, dispatch) {
  const additions = hookContexts(dispatch);
  if (additions.length > 0) active.enrichment.hooks.push(...additions);
}
