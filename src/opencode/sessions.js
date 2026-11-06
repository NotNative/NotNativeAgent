// SPDX-License-Identifier: Apache-2.0
// Session operations for the OpenCode surface: one live SessionEngine per
// OpenChamber session, wired like the headless/plain-text surfaces (canonical
// ingress only), the per-session wire voice (cadence + prompt queue), and the
// façade's route-level error vocabulary.
import { SessionEngine } from '../engine.js';
import { CanonicalIngress } from '../ingress.js';
import { newId, ContractError } from '../ids.js';
import { QuestionBroker } from '../question-broker.js';
import { mkdirSync } from 'node:fs';
import { OpenCodeSessionRegistry, projectIdentifier } from './registry.js';
import slugifyTitle from './slug.js';
import { createWireEventBus } from './wire-events.js';
import { createWireSession } from './wire-session.js';
import { createV2Workspace } from './v2-workspace.js';
import { apiError } from './v2-contract.js';
import { runDesktopSessionRevert, runDesktopSessionUnrevert } from '../desktop-session-revert.js';

// Why: the opencode surface is an authenticated operator surface whose only
// operator voice over the wire is the question reply route. It stays
// interactive_tui so mid-turn questions remain available, but permission
// cards have no transport here: the session pins auto-review with a fail-closed
// reviewer, so escalations settle as deny_with_guidance instead of parking.
const SURFACE_NAME = 'interactive_tui';

export function createOpenCodeSessionWorkspace(options = {}) {
  ensureStoreRoots(options);
  const registry = new OpenCodeSessionRegistry();
  const bus = createWireEventBus();
  const wiredVersion = options.wiredVersion;
  const pendingQuestions = new Map();
  const workspace = { registry, bus, wiredVersion, pendingQuestions };
  const operations = defineWorkspaceOperations(workspace, options);
  const v2 = createV2Workspace(operations, { ...options, registry });
  workspace.v2 = v2;
  const publishSession = bus.publishSession;
  bus.publishSession = (event) => { v2.observe(event); return publishSession(event); };
  return { workspace, registry, bus, operations, v2 };
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
      const selected = options.providerSettings && !input.runtimeConfig
        ? await options.providerSettings.runtimeConfig(options.config, undefined, options.directory ?? options.config.workspaceRoot) : null;
      return attachSession(workspace, options, {
        title: boundedTitle(input.title ?? 'New session'),
        directory: boundedDirectory(input.directory),
        ocId: input.ocId,
        runtimeDirectory: input.runtimeDirectory,
        metadata: input.runtimeDirectory ? input.metadata : undefined,
        runtimeConfig: input.runtimeConfig ?? selected?.config,
        runtimeRef: input.runtimeRef ?? selected?.reference,
      });
    },
    get(ocId) {
      const session = requireSession(workspace, ocId);
      return registry.describe(session, wiredVersion);
    },
    ...turnOperations(workspace),
    // Why: question tokens identify owning sessions; answers travel the same
    // authenticated ingress as prompt traffic and settle the parked tool call.
    ...questionOperations(workspace),
    async remove(ocId) {
      const session = requireSession(workspace, ocId);
      session.wireSession.abort();
      await session.engine.shutdown({ request_id: newId('oc_shutdown'), type: 'shutdown' });
      registry.remove(ocId);
      for (const [token, owner] of [...workspace.pendingQuestions.entries()]) {
        if (owner === ocId) workspace.pendingQuestions.delete(token);
      }
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

/** The engine options one wired session runs with.
 *
 *  Why a builder: these are the surface's engine policy — auto-review with no
 *  permission-card transport, canonical ingress only, and workspace scope fixed
 *  at creation. Keeping them in one place makes that policy readable. */
function engineOptions({ options, workspace, sessionId, ocId, sessionDirectory, projectID, runtimeDirectory, runtimeConfig, observe }) {
  return {
    config: runtimeConfig ?? (runtimeDirectory ? Object.freeze({ ...options.config, workspaceRoot: runtimeDirectory }) : options.config),
    sessionId,
    surface: SURFACE_NAME,
    output: async (record) => {
      if (record.type === 'turn_result') workspace.v2?.captureFailure(ocId, record.failure?.code);
      observe(record);
      options.logger?.record(record, { sessionId });
    },
    questionBroker: attachQuestionVoice(workspace, { ocId, sessionId, directory: sessionDirectory, projectID },
      options, observe),
    permissionBroker: false,
    reviewPosture: 'auto-review',
    storeRoot: options.storeRoot,
    reviewerRoot: options.reviewerRoot,
    providerFactory: options.providerFactory,
    semanticReviewer: options.semanticReviewer,
    scheduler: options.scheduler,
    secretBroker: options.secretBroker,
  };
}

/** A publisher onto the v2 event stream for one session.
 *
 *  Why: timeline mutations happen outside a turn and must reach the stream the
 *  client renders from, which is separate from the v1 wire bus this session uses
 *  for turn cadence. The v2 state is looked up by its own id at publish time, so
 *  an event raised before the workspace attached the state is simply skipped. */
function v2Publisher(workspace, ocId) {
  return (_state, type, properties) => {
    const v2State = workspace.v2?.states?.get(ocId);
    if (v2State) workspace.v2.events.emit(v2State, type, properties, false);
  };
}

async function attachSession(workspace, options, { title, directory, ocId: requestedId, runtimeDirectory, metadata, runtimeConfig, runtimeRef }) {
  const { registry, bus, wiredVersion } = workspace;
  const sessionId = newId('session');
  const ocId = requestedId ?? newId('ses');
  const sessionDirectory = directory ?? options.directory ?? '';
  const projectID = projectIdentifier(sessionDirectory);
  let wireSession = null;
  const engine = new SessionEngine(engineOptions({
    options, workspace, sessionId, ocId, sessionDirectory, projectID, runtimeDirectory, runtimeConfig,
    observe: (record) => wireSession?.observe(record),
  }));
  await engine.initialize({ deferMcp: true });
  const record = {
    ocId,
    engine,
    ingress: new CanonicalIngress(engine, { interactive: true }),
    title,
    slug: slugifyTitle(title),
    directory: sessionDirectory,
    projectID,
    path: '',
    createdAt: Date.now(),
  };
  wireSession = createWireSession({
    record, bus, version: wiredVersion,
    publishV2: v2Publisher(workspace, ocId),
    info: () => {
      const stored = registry.get(ocId);
      const touched = registry.touch(ocId) ?? stored;
      return registry.describe(touched ?? stored, wiredVersion);
    },
  });
  const modelRef = configModelRef(runtimeConfig ?? options.config);
  if (modelRef) wireSession.setModelRef(modelRef);
  // Why: the engine's revert mutates a context it owns (it guards against a busy
  // or closing session and holds the journal). The registry record is frozen, so
  // this is the mutable side the timeline mutation operates on; `sessionId` is
  // the engine identity the journal resolves a boundary against.
  const timeline = { engine, sessionId, closing: false, liveTurn: null };
  const stored = registry.attach({ ...record, wireSession, timeline });
  workspace.v2?.attach(registry.describe(stored, wiredVersion), metadata, runtimeRef);
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

/** Stage a revert, translating the client's message id to the engine's request id.
 *
 *  The client names the message it admitted; the engine resolves a boundary by
 *  its own request id. An id this session never admitted is a missing message,
 *  not a surface failure, and the answer names the id the client sent.
 *
 *  Compatibility: the client renders a staged revert from `session.revert.staged`
 *  and its `data.revert`; the engine mutates its timeline silently, so the event
 *  is what makes the revert visible at all. */
async function stageWireRevert(session, body) {
  const messageID = body?.messageID;
  const requestId = session.wireSession.requestIdFor(messageID);
  if (!requestId) throw apiError(404, 'MessageNotFoundError', 'Message was not found', { messageID });
  const result = await runDesktopSessionRevert(session.timeline, { messageID: requestId });
  publishRevert(session, 'session.revert.staged', { sessionID: session.ocId, revert: { messageID } });
  // Compatibility: the response is a `Session.Revert`, whose only required field
  // is `messageID`. The client reads `value.data`, so this must be that shape and
  // not an internal summary.
  return { messageID, revertedTurns: result.reverted_turn_ids.length };
}

/** Announce a timeline mutation on the stream the client renders from.
 *
 *  Why v2 events and not the v1 wire bus: the client's revert state comes from
 *  its own event stream, which is `createV2Events`. Publishing on the wire bus
 *  would reach the legacy `/global/event` subscribers and nothing else. */
function publishRevert(session, type, properties) {
  session.wireSession.publishV2(type, properties);
}

function turnOperations(workspace) {
  return {
    async configure(ocId, manifest, model) {
      const session = requireSession(workspace, ocId);
      const result = await session.ingress.submit({ version: '1.0', type: 'configuration_update', request_id: newId('oc_config'), manifest }, 'opencode-wire');
      session.wireSession.setModelRef({ providerID: model.providerID, modelID: model.id });
      return result;
    },
    admit(ocId, parts, input) {
      return requireSession(workspace, ocId).wireSession.admit(parts, input);
    },
    /** Stage a revert at a message the client addressed.
     *
     *  Why the translation: the engine resolves a revert boundary by its own
     *  request id, while the client names the message it was admitted under. The
     *  wire session holds the join, so an unknown id is refused instead of
     *  staging a boundary the engine would not find. */
    revert(ocId, body) { return stageWireRevert(requireSession(workspace, ocId), body); },
    async unrevert(ocId) {
      const session = requireSession(workspace, ocId);
      await runDesktopSessionUnrevert(session.timeline);
      // Compatibility: the client clears its staged revert on this event.
      publishRevert(session, 'session.revert.cleared', { sessionID: session.ocId });
    },
    /** Keep a staged revert: the client drops its staged state and the turns it
     *  hid stay hidden. The engine's marker stays, so the timeline projection is
     *  unchanged; only the client's affordance to clear it goes away. */
    async commitRevert(ocId, messageID) {
      const session = requireSession(workspace, ocId);
      publishRevert(session, 'session.revert.committed', { sessionID: session.ocId, to: messageID });
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
    // Why: the operator's stop must release both the active turn (authenticated
    // cancel through the engine ingress) and never-run queued prompts (wire drain).
    cancel(ocId, body = {}) {
      const session = requireSession(workspace, ocId);
      const drained = session.wireSession.abort();
      return session.ingress.submit({
        version: '1.0', type: 'cancel', request_id: newId('oc_cancel'),
        ...(body.reason === undefined ? {} : { reason: body.reason }),
      }, 'opencode-wire').then((ack) => ({ ...ack, aborted_prompts: drained }));
    },
    async sync(ocId) {
      const session = requireSession(workspace, ocId);
      return session.wireSession.pendingCount();
    },
  };
}

function questionOperations(workspace) {
  return {
    questionReply(token, body = {}) {
      const session = requireQuestionSession(workspace, token);
      return session.ingress.submit({
        version: '1.0', type: 'question_response', request_id: newId('oc_qreply'),
        question_token: token, answers: body.answers ?? [],
      }, 'opencode-wire');
    },
    questionReject(token, body = {}) {
      const session = requireQuestionSession(workspace, token);
      return session.ingress.submit({
        version: '1.0', type: 'question_decline', request_id: newId('oc_qreject'),
        question_token: token, ...(body.reason === undefined ? {} : { reason: body.reason }),
      }, 'opencode-wire');
    },
  };
}

function requireQuestionSession(workspace, token) {
  const owner = workspace.pendingQuestions.get(token ?? '');
  const session = owner === undefined ? null : workspace.registry.get(owner);
  if (!session) throw new ContractError('question_unknown', 'interactive question is unavailable on this surface');
  return session;
}

function attachQuestionVoice(workspace, ids, options, observe) {
  const { bus, pendingQuestions } = workspace;
  return new QuestionBroker({
    output: async (record) => { observe(record); options.logger?.record(record, { sessionId: ids.sessionId }); },
    emit: {
      asked: (pending) => {
        pendingQuestions.set(pending.token, ids.ocId);
        publishQuestion(bus, ids, 'question.asked', {
          question_token: pending.token, narrative: pending.narrative, questions: pending.batch,
        });
      },
      settled: (pending, kind) => {
        pendingQuestions.delete(pending.token);
        publishQuestion(bus, ids, `question.${kind}`, { question_token: pending.token, kind });
      },
    },
  });
}

function publishQuestion(bus, ids, type, properties) {
  bus.publishSession({
    directory: ids.directory, project: ids.projectID, sessionID: ids.ocId, type,
    properties: Object.freeze({ sessionID: ids.ocId, ...properties }),
  });
}

function boundedTitle(value) {
  if (typeof value !== 'string') return 'New session';
  return value.trim().slice(0, 256) || 'New session';
}

function boundedDirectory(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.slice(0, 1024);
}
