// SPDX-License-Identifier: Apache-2.0
import { tmpdir } from 'node:os';
import { readJsonBody, contextRequestBodyLimit, sendJson, sendNoContent } from './protocol.js';
import { apiError, invalid, objectInput, validateSelection } from './v2-contract.js';
import { catalogResponse, requestDirectory } from './v2-catalog.js';
import { providerCatalog, providerMutation } from './provider-api.js';

export async function handleV2Request(ctx) {
  try { await dispatch(ctx); }
  catch (error) {
    if (error instanceof URIError) return sendJson(ctx.res, 400, { _tag: 'InvalidRequestError', message: 'Invalid URL encoding' });
    if (error.body && error.httpStatus) return sendJson(ctx.res, error.httpStatus, error.body);
    if (error.code?.startsWith('opencode_prompt_')) return sendJson(ctx.res, 400, { _tag: 'InvalidRequestError', message: error.message });
    ctx.options.logger?.record({ type: 'opencode_route_failure', code: error.code ?? 'internal_failure', url: ctx.target.pathname });
    if (!ctx.res.headersSent) sendJson(ctx.res, 500, { _tag: 'UnknownError', message: 'NNA could not complete the request' });
    else ctx.res.end();
  }
}

async function dispatch(ctx) {
  const { req, res, target, options } = ctx;
  const api = options.v2; const path = target.pathname; const method = req.method;
  if (!api) throw apiError(503, 'ServiceUnavailableError', 'V2 workspace is unavailable');
  if (await providerMutation(ctx, body)) return;
  if (method === 'GET' && path === '/api/info') {
    return sendJson(res, 200, { version: options.wiredVersion, pid: process.pid, urls: [], paths: { tmp: tmpdir() } });
  }
  if (method === 'GET' && path === '/api/event') {
    if (!api.events.subscribe(res)) throw apiError(503, 'ServiceUnavailableError', 'Event subscriber limit reached');
    return;
  }
  if (method === 'GET' && path === '/api/session') return sendJson(res, 200, api.list(target.query));
  if (method === 'GET' && path === '/api/session/active') {
    return sendJson(res, 200, { data: Object.fromEntries([...api.states.values()].filter((state) => state.running).map((state) => [state.info.id, { type: 'running' }])) });
  }
  if (method === 'POST' && path === '/api/session') {
    return sendJson(res, 200, { data: await api.create(await body(ctx), requestDirectory(target, req, options.directory)) });
  }
  const segments = path.split('/').slice(2).map(decodeURIComponent);
  if (segments[0] === 'session' && segments.length >= 2) return sessionRoute(ctx, segments.slice(1));
  if (method === 'POST' && segments[0] === 'experimental' && segments[1] === 'session' && segments[3] === 'wait' && segments.length === 4) {
    await api.wait(segments[2]); return sendNoContent(res);
  }
  if (method === 'GET') {
    if (options.providerSettings && ['/api/agent', '/api/model', '/api/model/default', '/api/provider', '/api/integration', '/api/config'].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      const catalog = await providerCatalog(options.providerSettings, path, requestDirectory(target, req, options.directory));
      if (catalog !== undefined) return sendJson(res, 200, catalog);
    }
    const result = catalogResponse(path, requestDirectory(target, req, options.directory), api, options.config);
    if (result !== undefined) return sendJson(res, 200, result);
  }
  throw apiError(404, 'InvalidRequestError', 'This operation is not supported by the NNA OpenCode surface');
}

async function sessionRoute(ctx, segments) {
  const { req, res, options, target } = ctx; const api = options.v2;
  const [id, action, itemID, subaction] = segments; const method = req.method;
  const state = api.requireState(id);
  if (segments.length === 1) {
    if (method === 'GET') return sendJson(res, 200, { data: state.info });
    if (method === 'DELETE') { await api.remove(id); return sendNoContent(res); }
    if (method === 'PATCH') { api.update(id, await body(ctx)); return sendNoContent(res); }
  }
  if (segments.length === 2 && method === 'GET') {
    if (action === 'message') return sendJson(res, 200, api.messages(id, target.query));
    if (action === 'inbox') return sendJson(res, 200, { data: [...state.inbox.values()] });
    if (action === 'form') return sendJson(res, 200, { data: api.forms(id) });
    if (action === 'permission') return sendJson(res, 200, { data: [] });
  }
  if (segments.length === 2 && method === 'POST') return sessionPost(ctx, state, action);
  if (action === 'form' && segments.length <= 4) {
    if (segments.length === 3 && method === 'GET') return sendJson(res, 200, { data: api.form(id, itemID) });
    if (segments.length === 3 && method === 'DELETE') { await api.settleForm(id, itemID, {}, true); return sendNoContent(res); }
    if (segments.length === 4 && subaction === 'reply' && method === 'POST') {
      await api.settleForm(id, itemID, await body(ctx), false); return sendNoContent(res);
    }
  }
  if (action === 'message' && segments.length === 3 && method === 'GET') {
    const message = state.messages.get(itemID);
    if (!message) throw apiError(404, 'MessageNotFoundError', 'Message was not found', { messageID: itemID });
    return sendJson(res, 200, { data: message });
  }
  throw apiError(404, 'InvalidRequestError', 'This session operation is not supported');
}

async function sessionPost(ctx, state, action) {
  const { res, options, target } = ctx; const api = options.v2; const id = state.info.id;
  if (action === 'prompt') return sendJson(res, 200, { data: await api.prompt(id, await body(ctx)) });
  if (action === 'interrupt') {
    if (target.query.resume !== undefined && target.query.resume !== 'false') throw invalid('Resume after interruption is not supported');
    return sendJson(res, 200, await api.interrupt(id));
  }
  if (action === 'agent' || action === 'model') {
    const input = objectInput(await body(ctx), [action]);
    if (input[action] == null) throw invalid(`${action} is required`);
    if (action === 'model' && options.providerSettings) await api.select(id, input.model);
    else validateSelection(input, state.info.model); return sendNoContent(res);
  }
  if (action === 'view') {
    const input = objectInput(await body(ctx), ['idle']);
    if (typeof input.idle !== 'number' || !Number.isFinite(input.idle)) throw invalid('idle must be a finite timestamp');
    if (input.idle === state.info.time.idle) {
      state.info.time.viewed = Date.now(); api.events.emit(state, 'session.viewed', { sessionID: id });
    }
    return sendNoContent(res);
  }
  throw apiError(404, 'InvalidRequestError', 'This session operation is not supported');
}

async function body(ctx) {
  if (ctx.req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw invalid('Use application/json');
  const result = await readJsonBody(ctx.req, await contextRequestBodyLimit(ctx));
  if (result.error) throw invalid(result.error === 'body_too_large' ? 'Request body exceeds the size limit' : 'Malformed JSON');
  return result.value;
}
