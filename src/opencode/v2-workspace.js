// SPDX-License-Identifier: Apache-2.0
import { createV2Events } from './v2-events.js';
import { observeV1Event } from './v2-projection.js';
import { apiError, invalid, objectInput, textInput, wireId, tokenUsage, modelReference, validateSelection, paginate } from './v2-contract.js';
import { pendingForms, getForm, settleForm } from './v2-forms.js';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { newId } from '../ids.js';
import { manifestFromConfig } from '../provider/route-configuration.js';
import { physicalWireAllowance } from '../reliability/context-budget.js';

export function createV2Workspace(operations, options) {
  const states = new Map(); const creating = new Set();
  const events = createV2Events(); const model = modelReference(options.config);
  const requireState = (id) => {
    const state = states.get(id);
    if (!state) throw apiError(404, 'SessionNotFoundError', 'Session was not found', { sessionID: id });
    return state;
  };
  const context = { states, creating, events, model, requireState, operations, options };
  const api = {
    events, model, states, requireState,
    attach(info, metadata, reference) { attachState(states, info, reference ?? model, events, options.wiredVersion, metadata); },
    observe(event) { observeEvent(states, event, events); },
    captureFailure(id, code) { const state = states.get(id); if (state) state.failureCode = code; },
    create(body, directory) { return createSession(context, body, directory); },
    list(query) { return listSessions(states, query); },
    messages(id, query) { return historyPage(requireState(id), id, query); },
    async prompt(id, body) { return admitWithModel(context, requireState(id), body); },
    // Compatibility: OpenCode 2 continues an interrupted turn with a synthetic
    // prompt. It is the same admission path, tagged so the transcript can tell
    // it from operator speech; the text is never treated as operator authority.
    async synthetic(id, body) { return admitWithModel(context, requireState(id), { ...body, synthetic: true }); },
    select(id, reference) { return selectModel(context, requireState(id), reference); },
    async interrupt(id) {
      const state = requireState(id);
      // Why: `running` is projected from the bus `session.status busy` frame,
      // which arrives after admission. An interrupt issued between admission and
      // that frame still stops real work, so admitted-but-not-yet-busy prompts
      // count as interrupted instead of reporting a no-op to the operator.
      const interrupted = state.running || state.pending.size > 0;
      cancelQueued(state, events);
      if (interrupted) await operations.cancel(id);
      return { interrupted };
    },
    async wait(id) { await Promise.all([...requireState(id).pending]); },
    async remove(id) {
      const state = requireState(id); state.closing = true; cancelQueued(state, events);
      try { await operations.remove(id); }
      finally {
        // Invariant: a removed session releases its slot whether or not the
        // engine reported the deletion, so the live limit and every listing
        // reflect only sessions that still exist.
        states.delete(id);
        events.emit(state, 'session.deleted', { sessionID: id });
      }
    },
    update(id, body) { updateSession(requireState(id), body, events); },
    forms(id) { return pendingForms(requireState(id)); },
    form(id, formID) { const form = getForm(requireState(id), formID); return { ...form.info, state: form.state }; },
    settleForm(id, formID, body, cancel) { return settleForm(requireState(id), formID, body, operations, cancel); },
    close() { events.close(); },
  };
  return api;
}

function observeEvent(states, event, events) {
  const state = states.get(event.properties?.sessionID);
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
  sequence: 0, running: false, messages: new Map(), inputs: new Map(), inbox: new Map(), forms: new Map(), pending: new Set(), cancelled: new Set() };
  states.set(info.id, state);
  events.emit(state, 'session.created', { sessionID: info.id, projectID: info.projectID, location: state.info.location,
    slug: info.slug, title: info.title, agent: 'build', model, version, ...(metadata == null ? {} : { metadata }) });
}

/** Bind the session's current provider selection before admitting text. The
 *  selection is refreshed only when nothing is already pending, so a queued
 *  prompt keeps the binding it was admitted under. */
async function admitWithModel(context, state, body) {
  const { options, operations } = context;
  if (options.providerSettings && !state.pending.size) await selectModel(context, state, state.info.model, true);
  return admitPrompt(state, body, operations, options);
}

function admitPrompt(state, body, operations, options) {
  if (state.closing) throw apiError(409, 'ConflictError', 'Session is closing');
  if (state.selecting) throw apiError(409, 'ConflictError', 'Model selection is in progress');
  // `synthetic` is set by the caller that already decided the admission is a
  // continuation, never by the request body, so it is not an accepted field.
  // Why the guard: destructuring a non-object would raise a TypeError before
  // validation, turning a rejected admission into a 500.
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Expected a JSON object');
  const { synthetic = false, ...input } = body;
  objectInput(input, ['id', 'text', 'files', 'agents', 'skills', 'metadata', 'delivery', 'resume', 'description']);
  textInput(body.text, 'text', physicalWireAllowance(options.registry?.get(state.info.id)?.engine?.ingressContextWindowTokens ?? 65_536));
  for (const field of ['files', 'agents', 'skills']) {
    if (body[field] !== undefined && (!Array.isArray(body[field]) || body[field].length)) throw invalid(`${field} are not supported by this surface`);
  }
  if (body.resume != null && body.resume !== true) throw invalid('Deferred execution is not supported by this surface');
  if (body.delivery != null && !['queue', 'steer'].includes(body.delivery)) throw invalid('Invalid delivery mode');
  if (body.delivery === 'steer' && (state.running || state.pending.size)) throw apiError(409, 'ConflictError', 'Use queue delivery while NNA is running');
  validateMetadata(body.metadata);
  const id = wireId(body.id, 'msg');
  if (state.inputs.has(id) || state.messages.has(id)) throw apiError(409, 'ConflictError', 'Message already exists');
  state.inputs.set(id, body);
  try {
    const admitted = operations.admit(state.info.id, [{ type: 'text', text: body.text }], { messageID: id, synthetic });
    const receipt = state.inbox.get(id);
    const settled = admitted.response.catch((error) => {
      options.logger?.record({ type: 'opencode_prompt_failed', code: error?.code ?? 'internal_failure', sessionID: state.info.id });
    }).finally(() => state.pending.delete(settled));
    state.pending.add(settled);
    return { ...receipt, ...(synthetic ? { type: 'synthetic' } : {}) };
  } catch (error) { state.inputs.delete(id); throw error; }
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

async function selectModel(context, state, reference, requireCredential = false) {
  if (state.running || state.pending.size || state.selecting || state.closing) throw apiError(409, 'ConflictError', 'Wait for the session to become idle before changing its model');
  state.selecting = true;
  try {
    const selected = await context.options.providerSettings.runtimeConfig(context.options.config, reference, state.info.location.directory);
    if (state.closing) throw apiError(409, 'ConflictError', 'Session is closing');
    if (requireCredential && !selected.config.connectionRecords[selected.reference.providerID].credential) {
      throw invalid('Connect an API key for this OpenCode provider in OpenChamber settings before sending a prompt');
    }
    await context.operations.configure(state.info.id, manifestFromConfig(selected.config), selected.reference);
    const previous = state.info.model;
    state.info.model = selected.reference;
    if (previous.id !== selected.reference.id || previous.providerID !== selected.reference.providerID) {
      context.events.emit(state, 'session.model.selected', { sessionID: state.info.id, model: selected.reference, previous });
      // Compatibility: OpenCode 2 records a `model-switched` history entry the
      // way it records `idle`, and a client reading history expects to see the
      // switch rather than a silent gap between turns.
      recordModelSwitch(state, selected.reference, previous);
    }
  } finally { state.selecting = false; }
}

function recordModelSwitch(state, model, previous) {
  const record = { id: newId('msg'), sessionID: state.info.id, type: 'model-switched',
    model, ...(previous ? { previous } : {}), time: { created: Date.now() } };
  state.records ??= [];
  state.records.push(record);
}

function validateMetadata(value) {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 16_384) throw invalid('metadata must be an object of at most 16384 bytes');
}

function updateSession(state, body, events) {
  objectInput(body, ['title', 'metadata', 'archived']);
  validateMetadata(body.metadata);
  const patch = {};
  if (body.title != null) {
    textInput(body.title, 'title', 256);
    if (!body.title.trim()) throw invalid('Automatic title generation is not supported');
    state.info.title = body.title;
    patch.title = body.title;
    events.emit(state, 'session.renamed', { sessionID: state.info.id, title: body.title });
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
    && (!query.parentID || query.parentID === 'null') && !query.subpath);
  values.sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id));
  return paginate(values, query, `sessions:${JSON.stringify([query.directory, query.project, query.search, query.parentID, query.subpath, query.archived])}`);
}
