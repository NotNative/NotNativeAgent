// SPDX-License-Identifier: Apache-2.0
// Session operations for the OpenCode surface: one live SessionEngine per
// OpenChamber session, wired like the headless/plain-text surfaces (canonical
// ingress only), the per-session wire voice (cadence + prompt queue), and the
// façade's route-level error vocabulary.
import { SessionEngine } from '../engine.js';
import { CanonicalIngress } from '../ingress.js';
import { newId, ContractError } from '../ids.js';
import { mkdirSync } from 'node:fs';
import { OpenCodeSessionRegistry, projectIdentifier } from './registry.js';
import slugifyTitle from './slug.js';
import { createWireEventBus } from './wire-events.js';
import { createWireSession } from './wire-session.js';

// Why: the opencode surface is an authenticated operator surface (OpenChamber
// renders permission cards); the engine's interactive broker wiring therefore
// applies, matching the NNA console surface contract.
const SURFACE_NAME = 'interactive_tui';

export function createOpenCodeSessionWorkspace(options = {}) {
  ensureStoreRoots(options);
  const registry = new OpenCodeSessionRegistry();
  const bus = createWireEventBus();
  const wiredVersion = options.wiredVersion;
  const workspace = { registry, bus, wiredVersion };
  const operations = defineWorkspaceOperations(workspace, options);
  return { workspace, registry, bus, operations };
}

function ensureStoreRoots(options) {
  try {
    if (options.storeRoot) mkdirSync(options.storeRoot, { recursive: true });
    if (options.reviewerRoot) mkdirSync(options.reviewerRoot, { recursive: true });
  } catch (error) {
    throw new ContractError('opencode_storage_unavailable', `session storage is unavailable (${error.code ?? error.message ?? error})`);
  }
}

function defineWorkspaceOperations(workspace, options) {
  const { registry, bus, wiredVersion } = workspace;
  return {
    bus,
    async list() {
      return registry.list().map((record) => registry.describe(record, wiredVersion));
    },
    async create(input = {}) {
      return attachSession(workspace, options, {
        title: boundedTitle(input.title ?? 'New session'),
        directory: boundedDirectory(input.directory),
      });
    },
    get(ocId) {
      const session = requireSession(workspace, ocId);
      return registry.describe(session, wiredVersion);
    },
    async messages(ocId) {
      const session = requireSession(workspace, ocId);
      return session.wireSession.messages();
    },
    prompt(ocId, parts) {
      const session = requireSession(workspace, ocId);
      return session.wireSession.prompt(parts);
    },
    promptAsync(ocId, parts) {
      const session = requireSession(workspace, ocId);
      return session.wireSession.prompt(parts);
    },
    async sync(ocId) {
      const session = requireSession(workspace, ocId);
      return session.wireSession.pendingCount();
    },
    async remove(ocId) {
      const session = requireSession(workspace, ocId);
      await session.engine.shutdown({ request_id: newId('oc_shutdown'), type: 'shutdown' });
      registry.remove(ocId);
      bus.publishSession({
        directory: session.directory ?? '',
        project: session.projectID ?? '',
        sessionID: ocId,
        type: 'session.deleted',
        properties: { sessionID: ocId },
      });
      return { closed: true };
    },
  };
}

async function attachSession(workspace, options, { title, directory }) {
  const { registry, bus, wiredVersion } = workspace;
  const sessionId = newId('session');
  let wireSession = null;
  const engine = new SessionEngine({
    config: options.config,
    sessionId,
    surface: SURFACE_NAME,
    output: async (record) => {
      wireSession?.observe(record);
      options.logger?.record(record, { sessionId });
    },
    storeRoot: options.storeRoot,
    reviewerRoot: options.reviewerRoot,
    providerFactory: options.providerFactory,
    semanticReviewer: options.semanticReviewer,
    scheduler: options.scheduler,
    secretBroker: options.secretBroker,
  });
  await engine.initialize({ deferMcp: true });
  const ocId = newId('ses');
  const record = {
    ocId,
    engine,
    ingress: new CanonicalIngress(engine, { interactive: true }),
    title,
    slug: slugifyTitle(title),
    directory: directory ?? options.directory ?? '',
    projectID: projectIdentifier(directory ?? options.directory ?? ''),
    path: '',
    createdAt: Date.now(),
  };
  wireSession = createWireSession({
    record, bus, version: wiredVersion,
    info: () => {
      const stored = registry.get(ocId);
      const touched = registry.touch(ocId) ?? stored;
      return registry.describe(touched ?? stored, wiredVersion);
    },
  });
  const modelRef = configModelRef(options.config);
  if (modelRef) wireSession.setModelRef(modelRef);
  const stored = registry.attach({ ...record, wireSession });
  options.logger?.record({ type: 'opencode_session_created', ocId: stored.ocId, sessionId, title }, { sessionId });
  options.logger?.record({ type: 'opencode_session_started', ocId: stored.ocId, sessionId, title, directory: stored.directory }, { sessionId });
  return registry.describe(stored, wiredVersion);
}

function configModelRef(config) {
  const primary = boundedRef(config?.routes?.primary);
  if (primary) return primary;
  const provider = config?.provider;
  if (!provider || typeof provider !== 'object') return null;
  return boundedRef(provider);
}

function boundedRef(source) {
  if (!source || typeof source !== 'object') return null;
  const providerID = typeof source.providerId === 'string' && source.providerId ? source.providerId
    : typeof source.id === 'string' && source.id ? source.id : null;
  const modelID = typeof source.model === 'string' && source.model ? source.model : null;
  if (!providerID && !modelID) return null;
  return { providerID: providerID ?? 'nna', modelID: modelID ?? 'nna' };
}

function requireSession(workspace, ocId) {
  const session = workspace.registry.get(ocId);
  if (!session) throw new ContractError('opencode_session_missing', 'session was not found on the opencode surface');
  return session;
}

function boundedTitle(value) {
  if (typeof value !== 'string') return 'New session';
  return value.trim().slice(0, 256) || 'New session';
}

function boundedDirectory(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.slice(0, 1024);
}
