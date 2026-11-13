// SPDX-License-Identifier: Apache-2.0
import { createV2Events } from './v2-events.js';
import { observeV1Event } from './v2-projection.js';
import { apiError, invalid, objectInput, textInput, wireId, tokenUsage, modelReference, validateSelection, paginate } from './v2-contract.js';
import { seedProjectionState } from './v2-seed.js';
import { validatePromptAdmission } from './v2-admission.js';
import { pendingForms, getForm, settleForm } from './v2-forms.js';
import { commandApi, createCommandSurface } from './v2-commands.js';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { newId } from '../ids.js';
import { manifestFromConfig } from '../provider/route-configuration.js';
import { physicalWireAllowance } from '../reliability/context-budget.js';
import { archiveMutationRefusal, archiveList, isArchived, archiveMessages } from './legacy-archive.js';
import { updateSessionIndex } from './session-index.js';
import { boundedSelection } from './model-reference.js';

/** The typed refusal for a live-state lookup that missed: archived ids answer
 *  the read-only conflict; everything else is an ordinary missing session. */
function requireArchivedOrMissing(archive, id) {
  if (isArchived(archive, id)) {
    throw apiError(409, 'ArchiveReadOnlyError', archiveMutationRefusal('mutate').message);
  }
  throw apiError(404, 'SessionNotFoundError', 'Session was not found', { sessionID: id });
}

/** This module's archive read: the shared helper answers null for an unknown id,
 *  which every route here treats as a missing session rather than an empty page. */
function archivedHistory(archive, id) {
  const page = archiveMessages(archive, id);
  if (!page) throw apiError(404, 'SessionNotFoundError', 'Session was not found', { sessionID: id });
  return page;
}

export function createV2Workspace(operations, options) {
  const states = new Map(); const creating = new Set();
  const events = createV2Events(); const model = modelReference(options.config);
  // Why the archive refusal inside requireState: an archived id is unknown to the live map,
  // so every mutating route refuses with the same typed conflict, not a 404. Why demand
  // re-attach in ensureLive: an evicted conversation is listed but has no live state; an
  // arriving envelope re-attaches it through the boot-restore path first.
  const requireState = (id) => states.get(id) ?? requireArchivedOrMissing(options.archive, id);
  const ensureLive = async (id) => { if (options.reattachEvicted) await options.reattachEvicted(id); return requireState(id); };
  const context = { states, creating, events, model, requireState, operations, options };
  const api = {
    events, model, states, requireState, ensureLive,
    attach(info, metadata, reference) { attachState(states, info, reference ?? model, events, options.wiredVersion, metadata); },
    inherit(id, inherited) { inheritState(requireState(id), inherited); },
    // Compatibility: a restored session's replayed turns enter the same projection
    // live turns use, so a reload renders them like any other turn.
    seed(id, turns) { return seedState(requireState(id), turns, events, options.wiredVersion); },
    observe(event) { observeEvent(states, event, events); },
    captureFailure(id, code) { const state = states.get(id); if (state) state.failureCode = code; },
    create(body, directory) { return createSession(context, body, directory); },
    // Why merged at the page level: archived conversations list alongside live ones but are marked archived.
    list(query) {
      const page = listSessions(states, query);
      return { ...page, data: [...page.data, ...archiveList(options.archive)] };
    },
    read(id) { return requireState(id) && sessionView(requireState(id)); },
    // Why the archive check comes first: an archived conversation is unknown to the live map; history serves read-only.
    messages(id, query) {
      if (!states.has(id) && isArchived(options.archive, id)) return archiveMessages(options.archive, id);
      return historyPage(requireState(id), id, query);
    },
    async prompt(id, body) { return admitWithModel(context, requireState(id), body); },
    // Compatibility: OpenCode 2 continues an interrupted turn with a synthetic
    // prompt. It is the same admission path, tagged so the transcript can tell
    // it from operator speech; the text is never treated as operator authority.
    async synthetic(id, body) { return admitWithModel(context, requireState(id), { ...body, synthetic: true }); },
    ...commandApi(context, requireState, admitWithModel, createCommandSurface(options)),
    ...revertApi(requireState, operations),
    ...forkApi(requireState, operations),
    ...compactApi(requireState, operations),
    select(id, reference) { return selectModel(context, requireState(id), reference); },
    async interrupt(id) { return interruptSession(requireState(id), operations, events); },
    async wait(id) { await Promise.all([...requireState(id).pending]); },
    async remove(id) { return removeWorkspaceSession(operations, states, events, id, () => requireState(id)); },
    async update(id, body) { await updateSession(requireState(id), body, events, options); },
    forms(id) { return pendingForms(requireState(id)); },
    form(id, formID) { const form = getForm(requireState(id), formID); return { ...form.info, state: form.state }; },
    settleForm(id, formID, body, cancel) { return settleForm(requireState(id), formID, body, operations, cancel); },
    close() { events.close(); },
  };
  return api;
}

/** A client delete: close the session, then release its slot regardless of
 *  what the engine reported, so the live limit and every listing reflect only
 *  sessions that still exist. */
async function removeWorkspaceSession(operations, states, events, id, require) {
  const state = require(); state.closing = true; cancelQueued(state, events);
  try { await operations.remove(id); }
  finally {
    states.delete(id);
    events.emit(state, 'session.deleted', { sessionID: id });
  }
}

/** An operator interrupt: cancel queued work, then stop live work if any.
 *  Why the pending check: `running` is projected from the bus `session.status
 *  busy` frame, which arrives after admission, so an interrupt issued between
 *  admission and that frame still stops real work instead of reporting a no-op. */
async function interruptSession(state, operations, events) {
  const interrupted = state.running || state.pending.size > 0;
  cancelQueued(state, events);
  if (interrupted) await operations.cancel(state.info.id);
  return { interrupted };
}

function observeEvent(states, event, events) {  const state = states.get(event.properties?.sessionID);
  if (!state) return;
  if (event.type === 'session.deleted') {
    events.emit(state, 'session.deleted', { sessionID: state.info.id }); states.delete(state.info.id); return;
  }
  observeV1Event(state, event, events);
}

async function createSession(context, body, directory) {
  const { states, creating, model, requireState, operations, options } = context;
  objectInput(body, ['id', 'title', 'agent', 'model', 'location', 'metadata']);
  if (options.providerSettings) validateSelection({ agent: body.agent }, model);
  else validateSelection(body, model);
  if (body.title != null) textInput(body.title, 'title', 256);
  if (body.location != null) objectInput(body.location, ['directory']);
  const location = await validateLocation(body.location?.directory ?? directory, options.config);
  const id = wireId(body.id, 'ses');
  if (states.has(id) || creating.has(id)) throw apiError(409, 'ConflictError', 'Session already exists');
  if (states.size + creating.size >= 128) throw apiError(503, 'ServiceUnavailableError', 'Session limit reached');
  validateMetadata(body.metadata);
  creating.add(id);
  try {
    const selected = options.providerSettings ? await options.providerSettings.runtimeConfig(options.config, body.model, location) : null;
    const info = await operations.create({ ocId: id, title: body.title, directory: location, runtimeDirectory: location, metadata: body.metadata,
      runtimeConfig: selected?.config, runtimeRef: selected?.reference });
    return requireState(info.id).info;
  } finally { creating.delete(id); }
}

function attachState(states, info, model, events, version, metadata) {
  const state = { info: { id: info.id, projectID: info.projectID, title: info.title,
    agent: 'build', model, location: { directory: info.directory }, cost: 0, tokens: tokenUsage(), time: { ...info.time },
    ...(metadata == null ? {} : { metadata }) },
  // Why the flag from the stamp: the list filter reads `state.archived`, and a
  // boot-restored session carries its archive decision in `time.archived`.
  archived: info.time?.archived != null,
  sequence: 0, running: false, messages: new Map(), inputs: new Map(), inbox: new Map(), forms: new Map(), pending: new Set(), cancelled: new Set() };
  states.set(info.id, state);
  events.emit(state, 'session.created', { sessionID: info.id, projectID: info.projectID, location: state.info.location,
    slug: info.slug, title: info.title, agent: 'build', model, version, ...(metadata == null ? {} : { metadata }) });
}

/** Enter replayed turns into a restored session's projection; the body lives
 *  in `v2-seed.js`, which owns the seeded-row shapes. */
function seedState(state, turns) {
  return seedProjectionState(state, turns);
}

/** Bind the session's current provider selection before admitting text. The
 *  selection is refreshed only when nothing is already pending, so a queued
 *  prompt keeps the binding it was admitted under. */
async function admitWithModel(context, state, body) {
  const { options, operations } = context;
  // Why the serialized rebind: two prompts arriving in the same tick made the
  // loser fail with "Wait for the session to become idle before changing its
  // model", a selection it never asked for. The admissions take turns, which
  // costs an await and keeps the queue-never-reject contract.
  if (options.providerSettings && !state.pending.size) {
    const previous = state.rebinding ?? Promise.resolve();
    const rebind = previous.catch(() => undefined).then(
      () => (options.providerSettings && !state.pending.size ? selectModel(context, state, state.info.model, true) : undefined));
    state.rebinding = rebind;
    try { await rebind; } finally { if (state.rebinding === rebind) state.rebinding = null; }
  }
  return admitPrompt(state, body, operations, options);
}

/** Validate a prompt admission the way the wire requires; the admission rules
 *  and their client-contract rationale live in `v2-admission.js`. */
function admitPrompt(state, body, operations, options) {
  const { synthetic = false, held, id } = validatePromptAdmission(state, body, options);
  if (state.inputs.has(id) || state.messages.has(id)) throw apiError(409, 'ConflictError', 'Message already exists');
  state.inputs.set(id, body);
  try {
    const admitted = operations.admit(state.info.id, [{ type: 'text', text: body.text }],
      { messageID: id, synthetic, held, ...(typeof body.description === 'string' ? { description: body.description } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}) });
    const receipt = admitted.held
      ? heldReceipt(state, id, body, synthetic)
      : state.inbox.get(id);
    const settled = admitted.response.catch((error) => {
      options.logger?.record({ type: 'opencode_prompt_failed', code: error?.code ?? 'internal_failure', sessionID: state.info.id });
    }).finally(() => state.pending.delete(settled));
    state.pending.add(settled);
    return { ...receipt, ...(synthetic ? { type: 'synthetic' } : {}) };
  } catch (error) { state.inputs.delete(id); throw error; }
}

/** Why built here instead of read back from the inbox projection: a held
 *  admission is deliberately absent from `state.inbox`. The client reconciles
 *  its composer queue from `session.inbox.list`, and an item that is never
 *  steered and never cancelled would sit in the composer forever. The receipt
 *  keeps the shape an admitted item has; `description` rides only the
 *  synthetic payload, which is the one the client declares. */
function heldReceipt(state, id, body, synthetic) {
  return { id, sessionID: state.info.id, time: { created: Date.now() }, type: synthetic ? 'synthetic' : 'user',
    payload: { text: body.text,
      ...(synthetic && typeof body.description === 'string' ? { description: body.description } : {}),
      ...(body.metadata ? { metadata: body.metadata } : {}) }, delivery: body.delivery ?? 'queue' };
}

/** Seed a child session's history from the turns it inherited.
 *
 *  Why: a fork replays the parent prefix into the engine silently, so no events
 *  describe those turns. Without this the child's message list was empty even
 *  though its engine held the transcript â€” a fork looked like a blank session.
 *  `parentID` travels the same way, so the client can nest the child. */
function inheritState(state, inherited) {
  if (inherited.parentID) state.info.parentID = inherited.parentID;
  for (const item of inherited.messages ?? []) state.messages.set(item.id, item);
}

/** The fork surface: the child session record, or a missing-boundary refusal.
 *
 *  Compatibility: the client sends `before`, a message id it admitted, and reads
 *  a session record back. An absent boundary carries the whole settled timeline
 *  into the child. */
function forkApi(requireState, operations) {
  return {
    fork(id, body) {
      requireState(id);
      objectInput(body, ['before', 'messageID']);
      const before = body.before ?? body.messageID;
      if (before !== undefined && (typeof before !== 'string' || !before)) throw invalid('before must be a message id');
      return operations.fork(id, before === undefined ? {} : { before });
    },
  };
}

/** The revert surface: stage a boundary, clear it, or keep it.
 *
 *  Compatibility: staging names a user message, which is translated to the
 *  engine's own request id by the operations layer. The engine's revert is
 *  journal-backed, so reverted turns are hidden rather than destroyed. */
function revertApi(requireState, operations) {
  return {
    revert(id, body) { return runRevert(requireState(id), 'stage', () => stageRevert(operations, id, body)); },
    unrevert(id) { return runRevert(requireState(id), 'clear', () => operations.unrevert(id)); },
    commitRevert(id) {
      const state = requireState(id);
      return runRevert(state, 'commit', () => operations.commitRevert(id, state.revertBoundary));
    },
  };
}

/** Run one revert step and keep the session's boundary in step with it.
 *
 *  A stage records the boundary so a later commit can name it without the client
 *  repeating it; a clear ends it; a commit keeps it â€” the taken-back turns stay
 *  hidden after the commit, and the client's history builder reads this exact
 *  field on every reload to keep them hidden on its side too. */
async function runRevert(state, step, run) {
  const result = await run();
  // A commit's operation publishes and returns nothing; the boundary it keeps is
  // the one the stage already recorded.
  state.revertBoundary = step === 'clear' ? null : step === 'commit' ? state.revertBoundary : result.messageID;
  return result;
}

/** The compaction surface: compact a conversation on request.
 *
 *  Compatibility: the client answers with the admission it recorded, so the
 *  record it gets back must be a `SessionInbox.Compaction`; the operations
 *  layer builds it and announces the lifecycle events. The completed
 *  compaction is also kept in history, the way a model switch is, so a client
 *  that reloads still sees why the transcript shrank. */
function compactApi(requireState, operations) {
  return {
    async compact(id, body) {
      const state = requireState(id);
      objectInput(body, ['id', 'delivery']);
      if (state.running || state.pending.size) throw apiError(409, 'ConflictError', 'Wait for the session to become idle before compacting it');
      const result = await operations.compact(id, body);
      recordCompaction(state, result?.record, result?.summary);
      return result?.record;
    },
  };
}

/** Validate a staged revert before the engine sees it.
 *
 *  `files` asks the engine to apply the boundary's file changes. NNA keeps no
 *  file snapshots, so it cannot honour that, and a success there would report a
 *  file state that was never captured. `files: false` asks for nothing.
 *
 *  Why the boundary check here: an id this session never admitted is a missing
 *  message, which the caller answers as such rather than as a surface failure. */
function stageRevert(operations, id, body) {
  objectInput(body, ['messageID', 'files']);
  if (!body.messageID || typeof body.messageID !== 'string') throw invalid('messageID is required');
  if (body.files !== undefined && body.files !== null && body.files !== false) {
    throw invalid('Reverting file changes is not supported by this surface');
  }
  return operations.revert(id, body);
}

/** One page of session history: messages in arrival order, then the settings
 *  records that happened between them.
 *
 *  Why not sort by `time.created`: a turn's user record takes its closed
 *  timestamp when the turn settles, so time order would place the assistant
 *  answer before the prompt that caused it. */
function historyPage(state, id, query) {
  const values = [...state.messages.values(), ...(state.records ?? [])]
    .filter((message) => !query.type || message.type === query.type);
  return paginate(values, query, `messages:${id}:${query.type ?? ''}`);
}

/** The session record as the wire sees it: the stored info plus the staged
 *  revert boundary while one exists.
 *
 *  Compatibility: the client's history builder reads `session.revert.messageID`
 *  from `GET /api/session/:id` and cuts every read past that boundary's
 *  timestamp, live, on reconnect, and on a fresh load. Without the field a
 *  committed revert survives only in the reducer's memory: the server hid the
 *  tail, the GUI un-hid it on the next sync, and a reload showed turns the
 *  operator took back. A missing field and an absent boundary are the same
 *  answer, so nothing is added when nothing is staged. */
function sessionView(state) {
  return state.revertBoundary
    ? { ...state.info, revert: { messageID: state.revertBoundary } }
    : state.info;
}

async function selectModel(context, state, reference, requireCredential = false) {
  if (state.running || state.pending.size || state.selecting || state.closing) throw apiError(409, 'ConflictError', 'Wait for the session to become idle before changing its model');
  state.selecting = true;
  try {
    if (state.closing) throw apiError(409, 'ConflictError', 'Session is closing');
    const selected = await context.options.providerSettings.runtimeConfig(context.options.config, reference, state.info.location.directory);
    refuseMissingCredential(selected, requireCredential);
    await context.operations.configure(state.info.id, manifestFromConfig(selected.config), selected.reference);
    const previous = state.info.model;
    // Why the variant travels on the reference: the level the operator chose has
    // to survive onto the session record, or the next prompt silently falls back
    // to the model's default while the UI still shows the chosen level. The
    // selection puts it there, so both create and switch carry it the same way.
    const next = selected.reference;
    state.info.model = next;
    if (previous.id !== next.id || previous.providerID !== next.providerID || previous.variant !== next.variant) {
      // Compatibility: a model switch is durable. Real OpenCode keeps the model
      // on the session across a restart, and a switch the operator made is the
      // model the conversation ran at from then on; recording it only in memory
      // made the next boot reopen the session on the surface default, which is
      // a model this conversation never used.
      if (context.options.storeRoot) {
        await updateSessionIndex(context.options.storeRoot, state.info.id, { model: boundedSelection(next) })
          .catch((error) => context.options.logger?.record({ type: 'opencode_session_index_failed',
            ocId: state.info.id, code: error.code ?? 'index_write_failed' }));
      }
      context.events.emit(state, 'session.model.selected', { sessionID: state.info.id, model: next, previous });
      // Compatibility: OpenCode 2 records a `model-switched` history entry the
      // way it records `idle`, and a client reading history expects to see the
      // switch rather than a silent gap between turns.
      recordModelSwitch(state, next, previous);
    }
  } finally { state.selecting = false; }
}

function refuseMissingCredential(selected, requireCredential) {
  if (!requireCredential
    || selected.config.connectionRecords[selected.reference.providerID].credential) return;
  // Why name the stale endpoints: a key connected at another endpoint looks
  // exactly like no key at all, and only the operator knows the endpoint
  // moved. Naming both makes the fix obvious instead of a dead end.
  const stale = selected.credentialEndpoints;
  throw invalid(stale?.length
    ? `This provider's credential is bound to ${stale.join(', ')} but the provider now points at ${selected.config.connectionRecords[selected.reference.providerID].endpoint}. Reconnect the API key for this endpoint in OpenChamber settings before sending a prompt`
    : 'Connect an API key for this OpenCode provider in OpenChamber settings before sending a prompt');
}

function recordModelSwitch(state, model, previous) {
  const record = { id: newId('msg'), sessionID: state.info.id, type: 'model-switched',
    model, ...(previous ? { previous } : {}), time: { created: Date.now() } };
  state.records ??= [];
  state.records.push(record);
}

/** Ledger a finished compaction in session history.
 *
 *  Why a second shape: the route answers with the `SessionInbox.Compaction` the
 *  client matched to its own admission, while history carries the
 *  `Session.Message.Compaction.Completed` a client rebuilds the transcript from
 *  after a reload. Without it the summary the operator just saw vanishes on
 *  refresh, leaving a shrunken transcript with no record of why. */
function recordCompaction(state, record, summary) {
  if (!record) return;
  state.records ??= [];
  state.records.push({
    id: record.id, sessionID: state.info.id, type: 'compaction', status: 'completed',
    reason: 'manual', summary: String(summary ?? ''), time: { created: record.time.created },
  });
}

function validateMetadata(value) {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 16_384) throw invalid('metadata must be an object of at most 16384 bytes');
}

async function updateSession(state, body, events, options) {
  // Security: `permissions` is a real field on this route, and it is refused by
  // name rather than as an unknown one. Permission rules belong to NNA's
  // reviewer governance; accepting a ruleset here would let a caller widen what
  // the surface may do. The client omits the field unless a caller sets it, so
  // a title or archive update still works.
  if (body.permissions !== undefined) throw invalid('Session permissions are owned by NNA reviewer governance and cannot be set through this surface');
  objectInput(body, ['title', 'metadata', 'archived']);
  validateMetadata(body.metadata);
  const patch = {};
  if (body.title != null) {
    textInput(body.title, 'title', 256);
    if (!body.title.trim()) throw invalid('Automatic title generation is not supported');
    state.info.title = body.title;
    patch.title = body.title;
    events.emit(state, 'session.renamed', { sessionID: state.info.id, title: body.title });
    // Why the index write: the durable index is what a restart lists from; a
    // rename that stayed in memory reverted to "New session" on the next boot.
    await updateSessionIndex(options.storeRoot, state.info.id, { title: body.title });
  }
  if (body.metadata != null) {
    state.info.metadata = body.metadata;
    patch.metadata = body.metadata;
    events.emit(state, 'session.metadata.updated', { sessionID: state.info.id, metadata: body.metadata });
  }
  // Compatibility: OpenCode 2.1 added `archived` to this route; `null` restores.
  // The patch carries it under `time` the way a v2 client applies it, and an
  // archived session leaves the live list until it is restored.
  if (body.archived !== undefined) {
    if (body.archived !== null && body.archived !== true && body.archived !== false) throw invalid('archived must be true, false, or null');
    const archivedAt = body.archived === false || body.archived === null ? null : Date.now();
    if (archivedAt === null) delete state.info.time.archived; else state.info.time.archived = archivedAt;
    state.archived = archivedAt !== null;
    patch.time = { archived: archivedAt };
    // Why the index write: the archive decision is operator intent about the
    // conversation's place in the list, so it must survive a restart the same
    // way a rename does; a boot restore re-applies the recorded stamp.
    await updateSessionIndex(options.storeRoot, state.info.id,
      { archivedAt: archivedAt === null ? null : archivedAt });
    // Compatibility: the client translates `session.unarchived` to a restore on
    // a session the live list dropped, and has no case for a restore expressed
    // only as a patch. Archiving stays a patch because that is how a client
    // applies it.
    if (archivedAt === null) events.emit(state, 'session.unarchived', { sessionID: state.info.id });
  }
  state.info.time.updated = Date.now();
  // Compatibility: v2 clients apply a changed record from `session.patched` and
  // carry the changed fields only, so a rename reaches a listener that does not
  // dispatch the descriptive events beside it.
  if (Object.keys(patch).length > 0) events.emit(state, 'session.patched', { sessionID: state.info.id, patch });
}

async function validateLocation(value, config) {
  textInput(value, 'location.directory', 1024);
  if (!value) throw invalid('location.directory must not be empty');
  let directory;
  try {
    directory = await realpath(value);
    if (!(await stat(directory)).isDirectory()) throw new Error('not_directory');
  } catch { throw invalid('location.directory must name an existing directory'); }
  // Security: an authenticated execution manifest has an immutable workspace scope.
  if (config.executionManifest != null && resolve(directory) !== resolve(config.workspaceRoot)) throw invalid('The authenticated workspace scope cannot be changed');
  return directory;
}

function cancelQueued(state, events) {
  for (const id of state.inbox.keys()) {
    state.cancelled.add(id); state.messages.delete(id);
    events.emit(state, 'session.inbox.cancelled', { sessionID: state.info.id, inboxID: id });
  }
  state.inbox.clear();
}

function listSessions(states, query) {
  const values = [...states.values()].filter((state) => query.archived === 'true' ? state.archived === true : state.archived !== true)
    .map((state) => state.info).filter((info) =>
    (!query.directory || info.location.directory === query.directory) && (!query.project || info.projectID === query.project)
    && (!query.search || info.title?.toLowerCase().includes(query.search.toLowerCase()))
    // Compatibility: the client's lineage walk selects by `parentID`. The literal
    // `'null'` selects roots â€” a session with no parent â€” and a concrete id selects
    // that parent's children, so a fork tree is walkable either way.
    && (!query.parentID || (query.parentID === 'null' ? !info.parentID : info.parentID === query.parentID))
    && !query.subpath);
  values.sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id));
  return paginate(values, query, `sessions:${JSON.stringify([query.directory, query.project, query.search, query.parentID, query.subpath, query.archived])}`);
}
