// SPDX-License-Identifier: Apache-2.0
import { tmpdir } from 'node:os';
import { readJsonBody, contextRequestBodyLimit, sendJson, sendNoContent } from './protocol.js';
import { apiError, invalid, objectInput, validateSelection } from './v2-contract.js';
import { catalogResponse, requestDirectory } from './v2-catalog.js';
import { providerCatalog, providerMutation } from './provider-api.js';
import { generateText } from './v2-generate.js';

export async function handleV2Request(ctx) {
  try { await dispatch(ctx); }
  catch (error) {
    if (error instanceof URIError) return sendJson(ctx.res, 400, { _tag: 'InvalidRequestError', message: 'Invalid URL encoding' });
    // Why typed refusals log too: an admission refused with a status reached the
    // client and left no trace on the server, so an operator's diagnostic
    // timeline showed a bare 400 with no reason and no record to trace. The
    // refusal is the operator's answer; it must be legible where the service
    // logs live.
    if (error.body && error.httpStatus) {
      if (error.httpStatus >= 400) {
        ctx.options.logger?.record({ type: 'opencode_route_failure',
          code: error.code ?? 'api_refused', status: error.httpStatus,
          url: ctx.target.pathname, message: error.message ?? null });
      }
      return sendJson(ctx.res, error.httpStatus, error.body);
    }
    // Why status-preserving: a full queue is a capacity refusal the caller can
    // retry, and the legacy prompt surface already answers it 429. Flattening
    // every `opencode_prompt_*` code to a 400 told the client its admitted
    // text was malformed, so it discarded a briefing it should have retried.
    if (error.code?.startsWith('opencode_prompt_')) {
      return sendJson(ctx.res, error.httpStatus ?? 400, { _tag: 'InvalidRequestError', message: error.message });
    }
    // Why: the engine's timeline guards raise plain contract codes with no HTTP
    // status, so a busy session reached the client as an opaque 500 "NNA could not
    // complete the request". A refused timeline mutation is a conflict the caller
    // can retry, which is what the model switch already answers.
    const busy = TIMELINE_BUSY_CODES.get(error.code);
    if (busy) return sendJson(ctx.res, 409, { _tag: 'ConflictError', message: busy });
    ctx.options.logger?.record({ type: 'opencode_route_failure', code: error.code ?? 'internal_failure', url: ctx.target.pathname });
    if (!ctx.res.headersSent) sendJson(ctx.res, 500, { _tag: 'UnknownError', message: 'NNA could not complete the request' });
    else ctx.res.end();
  }
}

/** Engine timeline refusals a caller can act on.
 *
 *  Why a 409 for all of them: the engine raises plain contract codes with no HTTP
 *  status, so each reached the client as an opaque 500 "NNA could not complete the
 *  request". A refused timeline mutation is a conflict, not an internal failure â€”
 *  the model switch already answers 409, and a client renders these as guidance.
 *
 *  Why `desktop_fork_invalid` is here: a session with no settled turn has no
 *  boundary to fork at. That is a request the caller can correct, and forking a
 *  brand-new session used to answer 500. */
const TIMELINE_BUSY_CODES = new Map([
  ['desktop_fork_busy', 'Wait for the session to become idle before forking it'],
  ['desktop_revert_busy', 'Wait for the session to become idle before changing its revert boundary'],
  ['desktop_fork_boundary_unknown', 'Fork requires a boundary message that exists in the session'],
  ['desktop_fork_boundary_unsettled', 'Fork requires a boundary turn that has completed'],
  ['desktop_fork_invalid', 'Fork requires a session that has completed at least one turn'],
  ['desktop_revert_none', 'This session has no revert point to clear'],
  // Why also here and not only at the route: the workspace idle check answers the
  // common case, but a prompt admitted between that check and the engine's own
  // guard still raises this engine code, which would otherwise be a 500.
  ['compaction_busy', 'Wait for the session to become idle before compacting it'],
]);

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
  if (method === 'POST' && segments[0] === 'experimental' && segments[1] === 'generate' && segments[2] === 'text' && segments.length === 3) {
    // Compatibility: OpenChamber runs its session titles and per-turn recaps
    // through this route. It answers `{ data: { text } }`, which is the shape the
    // client's `generate.text` helper unwraps (`.then((value) => value.data)`).
    return sendJson(res, 200, { data: await generateText({ options, body: await body(ctx),
      directory: requestDirectory(target, req, options.directory) }) });
  }
  if (method === 'POST' && segments[0] === 'experimental' && segments[1] === 'session' && segments[3] === 'wait' && segments.length === 4) {
    await api.wait(segments[2]); return sendNoContent(res);
  }
  // Compatibility: the SDK declares this experimental skill route with no GUI
  // caller. It stages the skill for the next turn the session runs, so a client
  // may prime a session without starting work; `resume: true` would start one,
  // which is what the command route is for, so it is refused.
  if (method === 'POST' && segments[0] === 'experimental' && segments[1] === 'session' && segments[3] === 'skill' && segments.length === 4) {
    await api.useSkill(segments[2], await body(ctx)); return sendNoContent(res);
  }
  if (method === 'GET') {
    if (options.providerSettings && ['/api/agent', '/api/model', '/api/model/default', '/api/provider', '/api/integration', '/api/config'].some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      const catalog = await providerCatalog(options.providerSettings, path, requestDirectory(target, req, options.directory));
      if (catalog !== undefined) return sendJson(res, 200, catalog);
    }
    const result = await catalogResponse(path, requestDirectory(target, req, options.directory), api, options.config);
    if (result !== undefined) return sendJson(res, 200, result);
  }
  // Compatibility: a route this surface does not serve answers a *bare* 404 with
  // no body, which is what a real OpenCode does for any path it does not route —
  // measured on 2.2.6 for an unknown `/api/*` path and for an unserved session
  // sub-path alike. The distinction is load-bearing: OpenChamber probes optional
  // routes (`GET /api/experimental/job`, added in 2.2.6) and reads `404` with no
  // `_tag` as "this server has no such route", falling back to its older reads,
  // while a tagged 404 reads as a failure. One of those probes gates the goal
  // runtime, which answers a failed probe by re-arming its timer and returning —
  // so a tagged refusal here left a goal waiting on an audit that never ran.
  // A tagged 404 stays where the route exists and the *record* does not (an
  // unknown session, message or form), which is the distinction the wire draws.
  ctx.res.writeHead(404, { 'content-length': '0' });
  ctx.res.end();
}

async function sessionRoute(ctx, segments) {
  const { req, res, options, target } = ctx; const api = options.v2;
  const [id, action, itemID, subaction] = segments; const method = req.method;
  // Why lazy: a route this surface does not serve must be told apart from a
  // served route naming a missing record, and a real OpenCode resolves the route
  // first — an unserved action on a missing session is a bare 404, while a served
  // action on one is a tagged `SessionNotFoundError` (measured on 2.2.6). Loading
  // the session eagerly made the second answer stand in for the first, which a
  // client reads as a failed probe rather than as "no such route".
  let loaded;
  const stateFor = async () => {
    if (loaded !== undefined) return loaded;
    // Why the deferred require: an archived conversation is unknown to the live
    // state map, but its read-only history still serves; only read routes may
    // defer the live-state requirement, and every mutation still requires it.
    // Why ensureLive: an evicted conversation re-attaches on demand before its
    // operation resolves, so a prompt after idle eviction pays one journal
    // replay instead of a 404.
    loaded = segments.length === 2 && method === 'GET' && action === 'message' && !api.states.has(id)
      ? null : await api.ensureLive(id);
    return loaded;
  };
  if (segments.length === 1) {
    if (method === 'GET') return sendJson(res, 200, { data: api.read(id) });
    if (method === 'DELETE') { await api.remove(id); return sendNoContent(res); }
    if (method === 'PATCH') { await api.update(id, await body(ctx)); return sendNoContent(res); }
  }
  if (segments.length === 2 && method === 'GET') return sessionRead(ctx, id, action, stateFor);
  if (segments.length === 2 && method === 'POST') {
    if (!SESSION_POST_ACTIONS.has(action)) return unserved(res);
    return sessionPost(ctx, await stateFor(), action);
  }
  if (action === 'form' && segments.length <= 4) {
    await stateFor();
    if (segments.length === 3 && method === 'GET') return sendJson(res, 200, { data: api.form(id, itemID) });
    if (segments.length === 3 && method === 'DELETE') { await api.settleForm(id, itemID, {}, true); return sendNoContent(res); }
    if (segments.length === 4 && subaction === 'reply' && method === 'POST') {
      await api.settleForm(id, itemID, await body(ctx), false); return sendNoContent(res);
    }
  }
  if (action === 'message' && segments.length === 3 && method === 'GET') {
    const message = (await stateFor()).messages.get(itemID);
    if (!message) throw apiError(404, 'MessageNotFoundError', 'Message was not found', { messageID: itemID });
    return sendJson(res, 200, { data: message });
  }
  // Compatibility: stage a revert at a user message, then clear it to restore.
  // The engine's revert is journal-backed; it hides turns rather than deleting
  // them, which is what makes a clear possible.
  if (action === 'revert' && segments.length === 3 && segments[2] === 'stage' && method === 'POST') {
    return sendJson(res, 200, { data: await api.revert(id, await body(ctx)) });
  }
  if (action === 'revert' && segments.length === 2 && method === 'DELETE') {
    await api.unrevert(id); return sendNoContent(res);
  }
  if (action === 'revert' && segments.length === 3 && segments[2] === 'commit' && method === 'POST') {
    await api.commitRevert(id); return sendNoContent(res);
  }
  return unserved(res);
}

/** A read on one session: its history, pending inbox, pending forms, permissions.
 *
 *  Why `message` is answered before the session is loaded: history serves an
 *  archived or evicted conversation, which has no live state to require. The
 *  other three need the live state, and a session this surface does not have is a
 *  tagged `SessionNotFoundError` — the answer a client renders, as distinct from
 *  the bare 404 an unserved action gets. */
async function sessionRead(ctx, id, action, stateFor) {
  const { res, options, target } = ctx; const api = options.v2;
  if (action === 'message') return sendJson(res, 200, api.messages(id, target.query));
  if (!['inbox', 'form', 'permission'].includes(action)) return unserved(res);
  const state = await stateFor();
  if (state === null) throw apiError(404, 'SessionNotFoundError', 'Session was not found', { sessionID: id });
  if (action === 'inbox') return sendJson(res, 200, { data: [...state.inbox.values()] });
  if (action === 'form') return sendJson(res, 200, { data: api.forms(id) });
  return sendJson(res, 200, { data: [] });
}

/** A bodyless 404: the answer for a route this surface does not serve.
 *
 *  Why one helper: the shape is a contract a client reads, not a decoration. A
 *  real OpenCode answers every unrouted path and every unserved operation this
 *  way, and a tagged body in its place reads as a failure rather than as "this
 *  server has no such route". Keeping one function means the two bail-outs
 *  cannot drift. */
function unserved(res) {
  res.writeHead(404, { 'content-length': '0' });
  res.end();
}

/** The actions a POST on a session serves. Why declared here: `sessionRoute`
 *  resolves the route before it loads the session, so an unserved action on a
 *  missing session is the bare 404 a client reads as "no such route" rather than
 *  the tagged not-found it would read as a failure. */
const SESSION_POST_ACTIONS = new Set(['prompt', 'synthetic', 'command', 'fork', 'compact', 'interrupt', 'agent', 'model', 'view']);

async function sessionPost(ctx, state, action) {
  const { res, options, target } = ctx; const api = options.v2; const id = state.info.id;
  if (action === 'prompt') return sendJson(res, 200, { data: await api.prompt(id, await body(ctx)) });
  // Compatibility: a synthetic prompt continues an interrupted turn; the text
  // is continuation text, not operator speech, so it grants no authority.
  if (action === 'synthetic') return sendJson(res, 200, { data: await api.synthetic(id, await body(ctx)) });
  // Compatibility: gold declares this route's success as NoContent, and the SDK
  // sends `{ name, ...prompt fields }` expecting an empty 204. The command's
  // text is an operator task; the skill it names reaches the model through the
  // engine's own skill journaling, never through this payload.
  if (action === 'command') { await api.command(id, await body(ctx)); return sendNoContent(res); }
  // Compatibility: a fork answers the new session record. `before` is optional â€”
  // omitting it carries the whole settled timeline over.
  if (action === 'fork') return sendJson(res, 200, { data: await api.fork(id, await body(ctx)) });
  // Compatibility: the client sends `{ id, delivery }`, where `id` names the
  // admission it recorded locally and is not a message this surface stores. A
  // finished compaction is announced by `session.compaction.ended`, which the
  // client's own translation renders as `session.compacted`.
  if (action === 'compact') return sendJson(res, 200, { data: await api.compact(id, await body(ctx)) });
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
  return unserved(res);
}

async function body(ctx) {
  if (ctx.req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw invalid('Use application/json');
  const result = await readJsonBody(ctx.req, await contextRequestBodyLimit(ctx));
  if (result.error) throw invalid(result.error === 'body_too_large' ? 'Request body exceeds the size limit' : 'Malformed JSON');
  return result.value;
}
