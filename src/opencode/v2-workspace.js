// SPDX-License-Identifier: Apache-2.0
import { createV2Events } from './v2-events.js';
import { observeV1Event } from './v2-projection.js';
import { apiError, invalid, objectInput, textInput, wireId, tokenUsage, modelReference, validateSelection, paginate } from './v2-contract.js';
import { pendingForms, getForm, settleForm } from './v2-forms.js';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

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
    attach(info, metadata) { attachState(states, info, model, events, options.wiredVersion, metadata); },
    observe(event) {
      const state = states.get(event.properties?.sessionID);
      if (!state) return;
      if (event.type === 'session.deleted') {
        events.emit(state, 'session.deleted', { sessionID: state.info.id }); states.delete(state.info.id); return;
      }
      observeV1Event(state, event, events);
    },
    create(body, directory) { return createSession(context, body, directory); },
    list(query) { return listSessions(states, query); },
    messages(id, query) {
      const values = [...requireState(id).messages.values()].filter((message) => !query.type || message.type === query.type);
      return paginate(values, query, `messages:${id}:${query.type ?? ''}`);
    },
    prompt(id, body) { return admitPrompt(requireState(id), body, operations, options); },
    async interrupt(id) {
      const state = requireState(id); const interrupted = state.running;
      cancelQueued(state, events);
      if (interrupted || state.pending.size) await operations.cancel(id);
      return { interrupted };
    },
    async wait(id) { await Promise.all([...requireState(id).pending]); },
    async remove(id) {
      const state = requireState(id); state.closing = true; cancelQueued(state, events);
      await operations.remove(id);
    },
    update(id, body) { updateSession(requireState(id), body, events); },
    forms(id) { return pendingForms(requireState(id)); },
    form(id, formID) { const form = getForm(requireState(id), formID); return { ...form.info, state: form.state }; },
    settleForm(id, formID, body, cancel) { return settleForm(requireState(id), formID, body, operations, cancel); },
    close() { events.close(); },
  };
  return api;
}

async function createSession(context, body, directory) {
  const { states, creating, model, requireState, operations, options } = context;
  objectInput(body, ['id', 'title', 'agent', 'model', 'location', 'metadata']);
  validateSelection(body, model);
  if (body.title != null) textInput(body.title, 'title', 256);
  if (body.location != null) objectInput(body.location, ['directory']);
  const location = await validateLocation(body.location?.directory ?? directory, options.config);
  const id = wireId(body.id, 'ses');
  if (states.has(id) || creating.has(id)) throw apiError(409, 'ConflictError', 'Session already exists');
  if (states.size + creating.size >= 128) throw apiError(503, 'ServiceUnavailableError', 'Session limit reached');
  validateMetadata(body.metadata);
  creating.add(id);
  try {
    const info = await operations.create({ ocId: id, title: body.title, directory: location, runtimeDirectory: location, metadata: body.metadata });
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

function admitPrompt(state, body, operations, options) {
  if (state.closing) throw apiError(409, 'ConflictError', 'Session is closing');
  objectInput(body, ['id', 'text', 'files', 'agents', 'skills', 'metadata', 'delivery', 'resume']);
  textInput(body.text, 'text');
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
    const admitted = operations.admit(state.info.id, [{ type: 'text', text: body.text }], { messageID: id });
    const receipt = state.inbox.get(id);
    const settled = admitted.response.catch((error) => {
      options.logger?.record({ type: 'opencode_prompt_failed', code: error?.code ?? 'internal_failure', sessionID: state.info.id });
    }).finally(() => state.pending.delete(settled));
    state.pending.add(settled);
    return receipt;
  } catch (error) { state.inputs.delete(id); throw error; }
}

function validateMetadata(value) {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 16_384) throw invalid('metadata must be an object of at most 16384 bytes');
}

function updateSession(state, body, events) {
  objectInput(body, ['title', 'metadata']);
  validateMetadata(body.metadata);
  if (body.title != null) {
    textInput(body.title, 'title', 256);
    if (!body.title.trim()) throw invalid('Automatic title generation is not supported');
    state.info.title = body.title;
    events.emit(state, 'session.renamed', { sessionID: state.info.id, title: body.title });
  }
  if (body.metadata != null) {
    state.info.metadata = body.metadata;
    events.emit(state, 'session.metadata.updated', { sessionID: state.info.id, metadata: body.metadata });
  }
  state.info.time.updated = Date.now();
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
  const values = [...states.values()].map((state) => state.info).filter((info) =>
    (!query.directory || info.location.directory === query.directory) && (!query.project || info.projectID === query.project)
    && (!query.search || info.title?.toLowerCase().includes(query.search.toLowerCase()))
    && (!query.parentID || query.parentID === 'null') && !query.subpath);
  values.sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id));
  return paginate(values, query, `sessions:${JSON.stringify([query.directory, query.project, query.search, query.parentID, query.subpath])}`);
}
