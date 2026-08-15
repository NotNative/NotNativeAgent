// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { resumeOverlay, valueOverlay } from './overlays.js';
import { openSessionStats } from './session-stats.js';
import { openFilesView } from './files-view.js';
import { listDurableSessions } from '../tools/self-diagnostics.js';
import { SUBAGENT_TYPES } from '../subagent-runtime.js';

const CAPACITY_PENDING = 'Worker-model capacity is discovered on first use; execution remains sequential until known.';
const CAPACITY_DISCOVERED = 'Capacity reported by the loaded worker-model runtime.';

export async function openRuntimeInspection(kind, workspace) {
  if (kind === 'stats') return openSessionStats(workspace);
  if (kind === 'files') return openFilesView(workspace);
  const engine = requireActiveEngine(workspace);
  if (kind === 'sessions') {
    const sessions = await listDurableSessions(sessionCatalogContext(engine), 32);
    workspace.projection.openOverlay(valueOverlay('sessions', 'Durable sessions', {
      content_redacted: true, sessions,
    }));
    return;
  }
  if (kind === 'agents') {
    workspace.projection.openOverlay(valueOverlay('agents', 'Sub-agents', subagentStatus(engine)));
    return;
  }
  if (kind === 'project') {
    requireMethod(engine.projectIntake, 'inspect', 'project intake');
    const intake = await engine.projectIntake.inspect();
    workspace.projection.openOverlay(valueOverlay('project', 'Project intake', intake));
    return;
  }
  if (kind === 'hooks') {
    requireMethod(engine.hooks, 'health', 'hook health');
    workspace.projection.openOverlay(valueOverlay('hooks', 'Hook bundles', engine.hooks.health()));
    return;
  }
  if (kind === 'extensions') {
    requireMethod(engine.extensions, 'list', 'extension inventory');
    requireMethod(engine.extensions, 'diagnostics', 'extension diagnostics');
    workspace.projection.openOverlay(valueOverlay('extensions', 'Extensions', {
      items: engine.extensions.list(), diagnostics: engine.extensions.diagnostics(),
    }));
    return;
  }
  throw new ContractError('runtime_inspection_invalid', 'unknown runtime inspection area');
}

export async function handleResumeCommand(sessionId, workspace) {
  if (sessionId) return workspace.resume(sessionId);
  const engine = requireActiveEngine(workspace);
  const sessions = await listDurableSessions(sessionCatalogContext(engine), 64);
  workspace.projection.openOverlay(resumeOverlay(sessions, [...workspace.sessions.keys()]));
}

export function subagentStatus(engine) {
  requireMethod(engine?.router, 'resolve', 'sub-agent routing');
  requireMethod(engine?.scheduler, 'snapshot', 'sub-agent scheduling');
  requireMethod(engine?.tools, 'definition', 'sub-agent tool registry');
  if (!engine?.config?.limits) throw unavailable('sub-agent configuration');
  const route = engine.router.resolve('subagent');
  if (!route?.profile?.id) throw unavailable('sub-agent route');
  const scheduler = engine.scheduler.snapshot().find((item) => item.resource === route.profile.id);
  const standalone = engine.config.executionManifest === null;
  return Object.freeze({
    available: standalone && Boolean(engine.tools.definition('agent.run')),
    reason: standalone ? null : 'hosted sessions cannot inherit root sub-agent authority',
    endpoint: route.profile.endpoint,
    model: route.model,
    types: SUBAGENT_TYPES,
    nesting: 'disabled',
    scheduler: Object.freeze({
      running: scheduler?.running ?? 0,
      queued: scheduler?.queued.length ?? 0,
      active_limit: scheduler?.limit ?? engine.config.limits.providerConcurrency,
      discovered_capacity: scheduler?.discoveredLimit ?? null,
      capacity_note: scheduler?.discoveredLimit === null || scheduler?.discoveredLimit === undefined
        ? CAPACITY_PENDING : CAPACITY_DISCOVERED,
    }),
  });
}

function requireActiveEngine(workspace) {
  const engine = workspace?.activeEngine?.();
  if (!engine) throw unavailable('active runtime');
  return engine;
}

function sessionCatalogContext(engine) {
  const sessionsRoot = engine.store?.root ?? engine.dataPaths?.sessions;
  if (!sessionsRoot) throw unavailable('durable session catalog');
  return { sessionsRoot, sessionId: engine.sessionId ?? null };
}

function requireMethod(owner, method, capability) {
  if (typeof owner?.[method] !== 'function') throw unavailable(capability);
}

function unavailable(capability) {
  return new ContractError('runtime_inspection_unavailable', `${capability} is unavailable`);
}
