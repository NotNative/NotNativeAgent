// SPDX-License-Identifier: Apache-2.0
// Session operations for the OpenCode surface: one live SessionEngine per
// OpenChamber session, wired like the headless/plain-text surfaces (canonical
// ingress only), plus the façade's route-level error vocabulary.
import { SessionEngine } from '../engine.js';
import { CanonicalIngress } from '../ingress.js';
import { newId } from '../ids.js';
import { ContractError } from '../ids.js';
import { mkdirSync } from 'node:fs';
import { OpenCodeSessionRegistry, projectIdentifier } from './registry.js';
import slugifyTitle from './slug.js';

// Why: the opencode surface is an authenticated operator surface (OpenChamber
// renders permission cards); the engine's interactive broker wiring therefore
// applies, matching the NNA console surface contract.
const SURFACE_NAME = 'interactive_tui';

export function createOpenCodeSessionWorkspace(options = {}) {
  ensureStoreRoots(options);
  const registry = new OpenCodeSessionRegistry();
  const wiredVersion = options.wiredVersion;
  const workspace = { registry, wiredVersion };
  const operations = defineWorkspaceOperations(workspace, options);
  return { workspace, registry, operations };
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
  return {
    async list() {
      return workspace.registry.list().map((record) => workspace.registry.describe(record, workspace.wiredVersion));
    },
    async create(input = {}) {
      return attachSession(workspace, options, {
        title: boundedTitle(input.title ?? 'New session'),
        directory: boundedDirectory(input.directory),
      });
    },
    get(ocId) {
      const session = requireSession(workspace, ocId);
      return workspace.registry.describe(session, workspace.wiredVersion);
    },
    async messages(ocId) {
      const session = requireSession(workspace, ocId);
      return messageListFor(session);
    },
    async remove(ocId) {
      const session = requireSession(workspace, ocId);
      await session.engine.shutdown({ request_id: newId('oc_shutdown'), type: 'shutdown' });
      workspace.registry.remove(ocId);
      return { closed: true };
    },
  };
}

async function attachSession(workspace, options, { title, directory }) {
  const sessionId = newId('session');
  const engine = new SessionEngine({
    config: options.config,
    sessionId,
    surface: SURFACE_NAME,
    output: (record) => options.logger?.record(record, { sessionId }),
    storeRoot: options.storeRoot,
    reviewerRoot: options.reviewerRoot,
    providerFactory: options.providerFactory,
    semanticReviewer: options.semanticReviewer,
    scheduler: options.scheduler,
    secretBroker: options.secretBroker,
  });
  await engine.initialize({ deferMcp: true });
  const record = {
    ocId: newId('ses'),
    engine,
    ingress: new CanonicalIngress(engine, { interactive: true }),
    title,
    slug: slugifyTitle(title),
    directory: directory ?? options.directory ?? '',
    projectID: projectIdentifier(directory ?? options.directory ?? ''),
    path: '',
    createdAt: Date.now(),
  };
  const stored = workspace.registry.attach(record);
  options.logger?.record({ type: 'opencode_session_created', ocId: stored.ocId, sessionId, title }, { sessionId });
  return workspace.registry.describe(stored, workspace.wiredVersion);
}

async function messageListFor(session) {
  // Why: M0 serves the empty-transcript wire shape only; part synthesis for
  // prompts lands with the message routes in M1 and replaces this gate.
  const entries = session.engine.transcript;
  if (entries.some((item) => item.type === 'message')) {
    throw new ContractError('opencode_messages_unsupported', 'transcript synthesis arrives with the M1 message routes');
  }
  return [];
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
