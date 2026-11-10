// SPDX-License-Identifier: Apache-2.0
// Session operations for the OpenCode surface: one live SessionEngine per
// OpenChamber session, wired like the headless/plain-text surfaces (canonical
// ingress only), the per-session wire voice (cadence + prompt queue), and the
// façade's route-level error vocabulary.
import { SessionEngine } from '../engine.js';
import { CanonicalIngress } from '../ingress.js';
import { newId, ContractError, requireExternalId } from '../ids.js';
import { mkdirSync } from 'node:fs';
import { OpenCodeSessionRegistry, projectIdentifier } from './registry.js';
import slugifyTitle from './slug.js';
import { createWireEventBus } from './wire-events.js';
import { createWireSession } from './wire-session.js';
import { questionOperations, attachQuestionVoice } from './question-voice.js';
import { createV2Workspace } from './v2-workspace.js';
import { apiError, invalid, objectInput, wireId } from './v2-contract.js';
import { runDesktopSessionRevert, runDesktopSessionUnrevert } from '../desktop-session-revert.js';
import { runDesktopSessionFork } from '../desktop-session-fork.js';
import { compactEngineConversation } from '../engine/context-controls.js';
import { appendSessionIndex } from './session-index.js';
import { closeSession, removeSession, restoreSession } from './session-lifecycle.js';

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
  // Why exposed: the workspace owns the surface's shared admission scheduler;
  // status surfaces and tests read it to verify conversations share capacity.
  workspace.scheduler = options.scheduler;
  const operations = defineWorkspaceOperations(workspace, options);
  const v2 = createV2Workspace(operations, { ...options, registry });
  workspace.v2 = v2;
  const publishSession = bus.publishSession;
  bus.publishSession = (event) => { v2.observe(event); return publishSession(event); };
  return { workspace, registry, bus, operations, v2, scheduler: workspace.scheduler };
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
    ...turnOperations(workspace, options),
    // Why: question tokens identify owning sessions; answers travel the same
    // authenticated ingress as prompt traffic and settle the parked tool call.
    ...questionOperations(workspace),
    /** Surface-stop close: shuts the engine down and releases its lock without
     *  deleting anything. See `session-lifecycle.js` for why this is distinct
     *  from `remove`. */
    async close(ocId) { return closeSession(workspace, ocId); },
    async remove(ocId) { return removeSession(workspace, options, ocId); },
    /** Re-open a durable journal under its recorded wire identity; boot-time
     *  restore is the only caller. See `session-lifecycle.js`. */
    async restore(input = {}) {
      return restoreSession(workspace, options, input,
        (candidate) => attachSession(workspace, options, candidate));
    },
  };
}

/** The engine options one wired session runs with.
 *
 *  Why a builder: these are the surface's engine policy — auto-review with no
 *  permission-card transport, canonical ingress only, and workspace scope fixed
 *  at creation. Keeping them in one place makes that policy readable. */
function engineOptions({ options, workspace, sessionId, ocId, sessionDirectory, projectID, runtimeDirectory, runtimeConfig, forkIngest = null, observe }) {
  return {
    config: runtimeConfig ?? (runtimeDirectory ? Object.freeze({ ...options.config, workspaceRoot: runtimeDirectory }) : options.config),
    sessionId,
    surface: SURFACE_NAME,
    // Why: a forked child starts from a validated parent prefix. The engine
    // replays it as its own history, so the child continues from that turn.
    ...(forkIngest ? { forkIngest } : {}),
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
    // Why pass-through: a caller that names its skill roots owns the command
    // palette this surface serves; otherwise the engine reads the operator's
    // user skills directory like every other surface.
    ...(options.skillRoots ? { skillRoots: options.skillRoots } : {}),
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

async function attachSession(workspace, options, { title, directory, ocId: requestedId, engineSessionId, createdAt, runtimeDirectory, metadata, runtimeConfig, runtimeRef, forkIngest, parentID, slugSeed }) {
  const { registry, bus, wiredVersion } = workspace;
  // Why the durable id can be caller-supplied: boot-time restore re-opens the
  // journal a previous process journaled, which is the engine's own resume
  // identity; every other caller keeps the fresh-id behaviour.
  const sessionId = engineSessionId ? requireExternalId(engineSessionId, 'session_id') : newId('session');
  const ocId = requestedId ?? newId('ses');
  const sessionDirectory = directory ?? options.directory ?? '';
  const projectID = projectIdentifier(sessionDirectory);
  const createdAtMs = Number.isFinite(createdAt) ? createdAt : Date.now();
  let wireSession = null;
  const engine = new SessionEngine(engineOptions({
    options, workspace, sessionId, ocId, sessionDirectory, projectID, runtimeDirectory, runtimeConfig, forkIngest,
    observe: (record) => wireSession?.observe(record),
  }));
  await engine.initialize({ deferMcp: true });
  const record = {
    ocId,
    engine,
    ingress: new CanonicalIngress(engine, { interactive: true }),
    title,
    slug: slugifyTitle(slugSeed ?? title),
    directory: sessionDirectory,
    projectID,
    path: '',
    createdAt: createdAtMs,
    ...(parentID ? { parentID } : {}),
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
  // Why the descriptive fields: the engine's timeline operations (revert, fork)
  // read the context they are handed — a fork titles its child and places it in
  // the parent's directory from here, so an absent title produced "undefined-fork"
  // and an absent directory lost the parent's location.
  const timeline = { engine, sessionId, closing: false, liveTurn: null,
    title, directory: sessionDirectory, modelRoute: undefined,
    ...(parentID ? { parentID } : {}) };
  const stored = registry.attach({ ...record, wireSession, timeline });
  await publishAttach(workspace, options, { stored, sessionId, ocId, createdAtMs, parentID, metadata, runtimeRef });
  return registry.describe(stored, wiredVersion);
}

/** Wire the attached session to the v2 stream, the durable index, and the log.
 *
 *  Why the index write: the wire identity is the only link between what the
 *  client sees (`ses_*`) and the journal the engine will re-open on the next
 *  boot (`session_*`). Without it a restart loses the GUI's history again. */
async function publishAttach(workspace, options, { stored, sessionId, ocId, createdAtMs, parentID, metadata, runtimeRef }) {
  const { registry, wiredVersion } = workspace;
  workspace.v2?.attach(registry.describe(stored, wiredVersion), metadata, runtimeRef);
  if (options.storeRoot) {
    const entry = { ocId, sessionId, title: stored.title, directory: stored.directory, createdAt: createdAtMs, ...(parentID ? { parentID } : {}) };
    await appendSessionIndex(options.storeRoot, entry)
      .catch((error) => options.logger?.record({ type: 'opencode_session_index_failed', ocId, code: error.code ?? 'index_write_failed' }));
  }
  options.logger?.record({ type: 'opencode_session_created', ocId: stored.ocId, sessionId, title: stored.title }, { sessionId });
  options.logger?.record({ type: 'opencode_session_started', ocId: stored.ocId, sessionId, title: stored.title, directory: stored.directory }, { sessionId });
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

/** Compact a wire session and announce the lifecycle the client renders from.
 *
 *  The client sends `{ id, delivery }`. `id` names the compaction admission it
 *  recorded locally and awaits; the response and the lifecycle events must all
 *  carry the same id, or its bubble never leaves `status: running`.
 *
 *  Compatibility: `session.compaction.started` / `ended` / `failed` are what
 *  the client's store renders a compaction from — `session.compacted` is only
 *  the client's own translation of `ended`, and the engine's operator
 *  compaction publishes nothing on any event stream. The summary travels as
 *  `ended`'s `text`, which is what the completed record keeps.
 *
 *  Security: a failure publishes fixed guidance, never the exception text,
 *  which can carry provider detail an operator did not put here. */
async function compactWireSession(session, body) {
  const ocId = session.ocId;
  objectInput(body, ['id', 'delivery']);
  if (body.delivery != null && !['queue', 'steer'].includes(body.delivery)) throw invalid('Invalid delivery mode');
  const id = wireId(body.id, 'msg');
  const delivery = body.delivery ?? 'steer';
  publishRevert(session, 'session.compaction.started', { sessionID: ocId, reason: 'manual', inputID: id });
  let result;
  try {
    result = await compactEngineConversation(session.engine);
  } catch (error) {
    // Security: only the code crosses the wire; provider text can contain secrets.
    const busy = error?.code === 'compaction_busy';
    publishRevert(session, 'session.compaction.failed', {
      sessionID: ocId, reason: 'manual', inputID: id,
      error: { type: busy ? 'compaction_busy' : 'nna_compaction_failed',
        message: busy
          ? 'The session became busy while compacting. Wait for the turn to finish and try again'
          : 'NNA could not compact this conversation' },
    });
    throw error;
  }
  const text = String(result.fact?.summary ?? '');
  publishRevert(session, 'session.compaction.ended', { sessionID: ocId, reason: 'manual', inputID: id, text });
  const record = { id, sessionID: ocId, time: { created: Date.now() }, type: 'compaction', payload: {}, delivery };
  // The summary goes back alongside the record so the workspace can ledger the
  // finished compaction; the wire answer is the record alone.
  return { record, summary: text };
}

/** Fork a wire session at an optional boundary and answer the child record.
 *
 *  Compatibility: the client sends `before`, a message id it admitted, and reads
 *  a session record back. The engine resolves a boundary by its own request id,
 *  so the same join revert uses applies here; omitting the boundary carries the
 *  whole settled timeline over. */
async function forkWireSession(workspace, options, session, body) {
  const requestId = body?.before == null ? undefined : session.wireSession.requestIdFor(body.before);
  if (body?.before != null && !requestId) {
    throw apiError(404, 'MessageNotFoundError', 'Message was not found', { messageID: body.before });
  }
  const child = await runDesktopSessionFork(session.timeline, {
    createContext: async (childId, forkOptions) => createForkedContext(workspace, options, session, childId, forkOptions),
    get: (childId) => {
      const record = workspace.registry.get(childId);
      if (!record) throw new ContractError('opencode_session_missing', 'forked session was not found');
      return { id: record.ocId };
    },
  }, requestId === undefined ? {} : { messageID: requestId });
  const record = workspace.registry.get(child?.id);
  return record ? workspace.registry.describe(record, workspace.wiredVersion) : { id: child?.id };
}

/** Create the child session a fork produces.
 *
 *  Why through attachSession: the child is an ordinary wire session that starts
 *  from a parent prefix, so it needs the same engine, registry, wire voice and
 *  v2 state as any other. `forkIngest` carries the validated prefix and
 *  `parentID` places it under the session it came from. */
async function createForkedContext(workspace, options, parent, childId, forkOptions) {
  const created = await attachSession(workspace, options, {
    title: forkOptions?.title ?? `${parent.title} (fork)`,
    directory: forkOptions?.directory ?? parent.directory,
    ocId: childId,
    metadata: undefined,
    runtimeConfig: undefined,
    runtimeRef: undefined,
    forkIngest: forkOptions?.forkIngest,
    parentID: parent.ocId,
    slugSeed: forkOptions?.title ?? parent.title,
  });
  // The ingest replays silently, so the child's wire history is seeded from the
  // transcript it inherited rather than left empty until its first own turn.
  const child = workspace.registry.get(created.id);
  workspace.v2?.inherit(created.id, {
    parentID: parent.ocId,
    messages: inheritedMessages(child?.engine?.transcript, created.id),
  });
  return created;
}

/** Project an inherited engine transcript into wire message records.
 *
 *  Why a summary rather than the full text: the child's own turns carry full
 *  content. An inherited turn is shown as its user prompt and its assistant
 *  reply, which is what a reader expects to see carried over.
 *  @param {Array<object>} transcript the child's replayed transcript
 *  @param {string} sessionID the child session id these records belong to */
function inheritedMessages(transcript, sessionID) {
  if (!Array.isArray(transcript)) return [];
  const records = [];
  for (const item of transcript) {
    if (item?.type !== 'message' || !['user', 'assistant'].includes(item.role)) continue;
    const text = typeof item.content === 'string' ? item.content
      : Array.isArray(item.content) ? item.content.filter((part) => part?.type === 'text').map((part) => part.text).join('') : '';
    records.push({ id: newId('msg'), sessionID, type: item.role, time: { created: item.createdAt ?? 0 },
      ...(item.role === 'user' ? { text } : { content: [{ type: 'text', text }], agent: 'build', model: { id: 'nna', providerID: 'nna' } }) });
  }
  return records;
}

function turnOperations(workspace, options) {
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
    queueCommand(ocId, name) { requireSession(workspace, ocId).engine.skills.queueUser(name); },
    unqueueCommand(ocId, name) { requireSession(workspace, ocId).engine.skills.unqueueUser(name); },
    // Both translate the client's message id to the engine's request id; see
    // stageWireRevert and forkWireSession for why the join exists.
    revert(ocId, body) { return stageWireRevert(requireSession(workspace, ocId), body); },
    async fork(ocId, body) { return forkWireSession(workspace, options, requireSession(workspace, ocId), body); },
    // Announces the lifecycle the client renders a compaction from; see compactWireSession.
    compact(ocId, body) { return compactWireSession(requireSession(workspace, ocId), body); },
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

function boundedTitle(value) {
  if (typeof value !== 'string') return 'New session';
  return value.trim().slice(0, 256) || 'New session';
}

function boundedDirectory(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.slice(0, 1024);
}
