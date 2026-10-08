// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId, requireExternalId } from './ids.js';
import { readJsonBody, send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { sseOpen } from './opencode/protocol.js';
import { dispatchNndQuestionRequest } from './nnd-question-routes.js';
import { dispatchNndNotificationRequest } from './nnd-notification-routes.js';
const ROUTE = /^\/session(?:\/([^/]+))?(?:\/(message|children|activity|prompt_async|abort))?$/u;
const ACTIVITY_HISTORY_ROUTE = /^\/v1\/nnd\/sessions\/([^/]+)\/activity-history$/u;
const ACTIVITY_TOMBSTONES_ROUTE = '/v1/nnd/activity-tombstones';
const MESSAGE_LIMIT_MAX = 200;
const LIVE_BOUNDARY_PREFIX = 'nnd-live-boundary:';
export async function dispatchNndHarnessRequest(request, response, context) {
  context = await admittedWorkspaceContext(context);
  if (await readActivityTombstones(request, response, context) || await readActivityHistory(request, response, context)) return true;
  if (openEventStream(request, response, context)) return true;
  if (await dispatchNndQuestionRequest(request, response, context)) return true;
  if (await dispatchNndNotificationRequest(request, response, context)) return true;
  if (await dispatchBootstrapRequest(request, response, context)) return true;
  const match = ROUTE.exec(context.url.pathname); if (!match) return false;
  const host = context.nndEngineHost; if (!host) throw new ContractError('nnd_engine_unavailable', 'NND engine host is unavailable');
  let id = null;
  if (match[1]) {
    try { id = decodeURIComponent(match[1]); requireExternalId(id, 'session_id'); }
    catch { throw new ContractError('session_id_invalid', 'session id is invalid'); }
  }
  if (request.method === 'GET' && (!match[2] || match[2] === 'message' || match[2] === 'children' || match[2] === 'activity')) {
    return readSession(response, context, host, id, match[2]);
  }
  if (request.method === 'POST' && !id) {
    requireIntegrationPermission(context.principal, 'nnd.session.create');
    const body = await readJsonBody(request);
    const options = { ...createOptions(body),
      directory: body?.workspace_id ? body.directory : trustedWorkspace(context.nndWorkspaceRoot) };
    const made = await host.create(newId('ses'), context.principal, options);
    return send(response, 201, host.get(made.sessionId, context.principal));
  }
  if (request.method === 'POST' && id && match[2] === 'prompt_async') {
    requireIntegrationPermission(context.principal, 'nnd.session.submit');
    const body = await readJsonBody(request);
    assertConfiguredSelection(body, host.get(id, context.principal)?.metadata?.nnd?.configuredModel ?? host.nndModel);
    const content = textContent(body?.parts);
    await host.assertWorkspaceBound(id, context.principal);
    const accepted = host.submitAsync(id, { version: '1.0', type: 'submit', request_id: body?.messageID ?? newId('nnd_prompt'), content }, context.principal);
    if (accepted.reason === 'busy') {
      return send(response, 409, { error: { code: 'session_busy', message: 'NND session already has an active turn' } });
    }
    response.writeHead(204); response.end(); return true;
  }
  if (request.method === 'PATCH' && id && !match[2]) {
    return updateSession(request, response, context, host, id);
  }
  if (request.method === 'POST' && id && match[2] === 'abort') {
    requireIntegrationPermission(context.principal, 'nnd.session.abort');
    await host.abort(id, context.principal);
    return send(response, 200, true);
  }
  if (request.method === 'DELETE' && id && !match[2]) {
    requireIntegrationPermission(context.principal, 'nnd.session.delete');
    await host.close(id, context.principal);
    return send(response, 200, true);
  }
  return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
}

async function updateSession(request, response, context, host, id) {
  requireIntegrationPermission(context.principal, 'nnd.session.update');
  const body = await readJsonBody(request);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) {
    throw new ContractError('request_invalid', 'NND session update supports title or archived time');
  }
  if (Object.hasOwn(body, 'title')) return send(response, 200, await host.rename(id, context.principal, body.title));
  if (Object.hasOwn(body, 'time') && body.time && typeof body.time === 'object'
    && !Array.isArray(body.time) && Object.keys(body.time).length === 1 && Object.hasOwn(body.time, 'archived')) {
    return send(response, 200, await host.setArchived(id, context.principal, body.time.archived));
  }
  throw new ContractError('request_invalid', 'NND session update supports title or archived time');
}

async function admittedWorkspaceContext(context) {
  const path = context.url.pathname;
  const workspaceRoute = path === '/project' || path === '/project/current'
    || path === '/session' || path.startsWith('/session/') || path === '/session/status'
    || path === '/global/event' || path === '/event' || path === '/v1/nnd/pending'
    || path === ACTIVITY_TOMBSTONES_ROUTE || ACTIVITY_HISTORY_ROUTE.test(path);
  if (workspaceRoute && context.nndWorkspaceAdmissionService
    && context.principal.subjectId === 'nnd-local-operator'
    && context.principal.platformRole === 'operator'
    && context.principal.permissions.includes('nnd.workspace.manage')) {
    let inventory;
    try { inventory = await context.nndWorkspaceAdmissionService.inventory(context.principal); }
    catch (error) {
      // Why: an unavailable admitted root must not disable the attached root.
      if (error?.code === 'nnd_workspace_admission_identity_mismatch') return context;
      throw error;
    }
    return { ...context, workspaceInventory: inventory,
      principal: { ...context.principal, workspaceIds: [...new Set([
        ...context.principal.workspaceIds, ...inventory.admitted.map(row => row.id)])] } };
  }
  return context;
}

/** Owner-scoped deletion receipts, never a complete history or a foreign-session lookup. */
async function readActivityTombstones(request, response, context) {
  if (context.url.pathname !== ACTIVITY_TOMBSTONES_ROUTE) return false;
  if (request.method !== 'GET') return send(response, 405,
    { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
  requireIntegrationPermission(context.principal, 'nnd.read');
  const host = context.nndEngineHost;
  if (!host?.activityTombstonesPage) throw new ContractError('nnd_engine_unavailable', 'NND engine host is unavailable');
  const params = context.url.searchParams;
  if ([...params.keys()].some((key) => !['after', 'limit'].includes(key))
    || params.getAll('after').length > 1 || params.getAll('limit').length > 1) {
    throw new ContractError('nnd_activity_tombstones_request_invalid', 'NND Activity tombstone page request is invalid');
  }
  const after = params.get('after'); const limit = params.get('limit');
  if (after !== null && (!/^(?:0|[1-9]\d{0,15})$/u.test(after) || !Number.isSafeInteger(Number(after)))
    || limit !== null && (!/^[1-9]\d{0,2}$/u.test(limit) || Number(limit) > 100)) {
    throw new ContractError('nnd_activity_tombstones_request_invalid', 'NND Activity tombstone page request is invalid');
  }
  return send(response, 200, await host.activityTombstonesPage(context.principal,
    { ...(after === null ? {} : { after: Number(after) }), ...(limit === null ? {} : { limit: Number(limit) }) }));
}

/** Durable-only pages. SSE IDs do not index this snapshot; callers must treat
 * a changed snapshot as a gap and re-read from the newest page. */
async function readActivityHistory(request, response, context) {
  const match = ACTIVITY_HISTORY_ROUTE.exec(context.url.pathname);
  if (!match) return false;
  if (request.method !== 'GET') return send(response, 405,
    { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
  requireIntegrationPermission(context.principal, 'nnd.read');
  const host = context.nndEngineHost;
  if (!host?.activityHistoryPage) throw new ContractError('nnd_engine_unavailable', 'NND engine host is unavailable');
  let id;
  try { id = decodeURIComponent(match[1]); requireExternalId(id, 'session_id'); }
  catch { throw new ContractError('session_id_invalid', 'session id is invalid'); }
  const params = context.url.searchParams;
  if ([...params.keys()].some((key) => !['limit', 'cursor'].includes(key))
    || params.getAll('limit').length > 1 || params.getAll('cursor').length > 1) {
    throw new ContractError('nnd_activity_page_invalid', 'NND activity history page request is invalid');
  }
  const limit = params.get('limit'); const cursor = params.get('cursor');
  if (limit !== null && !/^[1-9]\d{0,2}$/u.test(limit)) {
    throw new ContractError('nnd_activity_page_invalid', 'NND activity history page request is invalid');
  }
  return send(response, 200, await host.activityHistoryPage(id, context.principal,
    { ...(limit === null ? {} : { limit: Number(limit) }), ...(cursor === null ? {} : { cursor }) }));
}

function readSession(response, context, host, id, detail) {
  requireIntegrationPermission(context.principal, 'nnd.read');
  if (detail === 'message') {
    const values = context.url.searchParams.getAll('limit');
    const beforeValues = context.url.searchParams.getAll('before');
    if (values.length > 1 || values.length === 1 && (!/^[0-9]{1,3}$/u.test(values[0])
      || Number(values[0]) < 1 || Number(values[0]) > MESSAGE_LIMIT_MAX)) {
      throw new ContractError('request_invalid', 'message limit must be an integer from 1 to 200');
    }
    if (beforeValues.length > 1 || beforeValues.length === 1 && !beforeValues[0]) {
      throw new ContractError('request_invalid', 'message cursor must be a single non-empty id');
    }
    if (beforeValues.length === 1 && values.length === 0) {
      throw new ContractError('request_invalid', 'message cursor requires a bounded limit');
    }
    const messages = host.messages(id, context.principal, { all: values.length === 1 });
    const cursor = beforeValues[0];
    const liveBoundary = cursor?.startsWith(LIVE_BOUNDARY_PREFIX);
    const boundaryId = liveBoundary ? Buffer.from(cursor.slice(LIVE_BOUNDARY_PREFIX.length), 'base64url').toString('utf8') : cursor;
    const boundary = beforeValues.length === 1 ? messages.findIndex((message) => message.info.id === boundaryId) : messages.length;
    const end = liveBoundary && boundary >= 0 ? boundary + 1 : boundary;
    if (end < 0) throw new ContractError('nnd_message_cursor_invalid', 'message cursor is unavailable');
    const start = values.length === 1 ? Math.max(0, end - Number(values[0])) : 0;
    const page = messages.slice(start, end);
    if (start > 0 && page.length > 0) {
      const firstId = page[0].info.id;
      const nextCursor = firstId === `${id}:live`
        ? `${LIVE_BOUNDARY_PREFIX}${Buffer.from(messages[start - 1].info.id).toString('base64url')}` : firstId;
      response.setHeader('x-next-cursor', nextCursor);
    }
    return send(response, 200, page);
  }
  if (detail === 'children') return send(response, 200, host.listChildren(id, context.principal));
  if (detail === 'activity') return send(response, 200, host.activity(id, context.principal));
  if (id) return send(response, 200, host.get(id, context.principal));
  const roots = context.url.searchParams.get('roots');
  return send(response, 200, host.list(context.principal, {
    includeArchived: context.url.searchParams.get('archived') === 'true',
    roots: roots === 'true' ? true : roots === 'false' ? false : undefined,
    limit: context.url.searchParams.has('limit') ? Number(context.url.searchParams.get('limit')) : undefined,
  }));
}

function openEventStream(request, response, context) {
  if (request.method !== 'GET' || !['/global/event', '/event'].includes(context.url.pathname)) return false;
  requireIntegrationPermission(context.principal, 'nnd.read');
  const host = context.nndEngineHost;
  if (!host?.eventBus?.subscribe) throw new ContractError('nnd_engine_unavailable', 'NND engine host is unavailable');
  sseOpen(response);
  const unsubscribe = host.eventBus.subscribe(response, {
    subjectId: context.principal.subjectId,
    workspaceIds: context.principal.workspaceIds,
    lastEventId: request.headers['last-event-id'],
  });
  request.once('close', unsubscribe);
  response.once('close', unsubscribe);
  return true;
}

async function dispatchBootstrapRequest(request, response, context) {
  const path = context.url.pathname;
  if (!['/global/health', '/path', '/config', '/project', '/project/current', '/session/status', '/v1/nnd/pending', '/v1/nnd/mcp', '/v1/nnd/skills', '/v1/nnd/agents'].includes(path)) return false;
  if (request.method !== 'GET') return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
  requireIntegrationPermission(context.principal, 'nnd.read');
  const workspace = trustedWorkspace(context.nndWorkspaceRoot);
  if (path === '/v1/nnd/pending') {
    if (!context.nndEngineHost?.pendingRequests) throw new ContractError('nnd_engine_unavailable', 'NND engine host is unavailable');
    return send(response, 200, context.nndEngineHost.pendingRequests(context.principal));
  }
  if (path === '/global/health') return send(response, 200, { healthy: true, version: '1.18.31' });
  if (path === '/path') {
    const binding = await context.nndEngineHost?.primaryWorkspaceBinding?.();
    if (binding && binding.configured_root !== workspace) {
      throw new ContractError('nnd_workspace_binding_invalid', 'Native primary workspace changed during discovery');
    }
    return send(response, 200, { home: '', state: '', config: '', worktree: workspace, directory: workspace,
      ...(binding ? { workspace_id: binding.id } : {}) });
  }
  if (path === '/v1/nnd/mcp') {
    const inventory = context.nndEngineHost?.nndMcpInventory;
    if (!inventory) throw new ContractError('nnd_engine_unavailable', 'NND MCP inventory is unavailable');
    return send(response, 200, inventory);
  }
  if (path === '/v1/nnd/agents') {
    const inventory = context.nndEngineHost?.nndAgentInventory;
    if (!inventory) throw new ContractError('nnd_engine_unavailable', 'NND agent inventory is unavailable');
    return send(response, 200, inventory);
  }
  if (path === '/v1/nnd/skills') {
    const inventory = await context.nndEngineHost?.readNndSkillsInventory?.();
    if (!inventory) throw new ContractError('nnd_engine_unavailable', 'NND skills inventory is unavailable');
    return send(response, 200, inventory);
  }
  if (path === '/config') {
    const model = context.nndEngineHost?.nndModel;
    if (!model) throw new ContractError('nnd_engine_unavailable', 'NND engine model configuration is unavailable');
    return send(response, 200, {
      model: `${model.providerID}/${model.modelID}`, default_agent: 'nna',
      nnd: { engine: 'nna', modelSelection: 'configured', primaryModel: model },
    });
  }
  if (path === '/project' || path === '/project/current') {
    const rows = context.workspaceInventory
      ? [context.workspaceInventory.attached, ...context.workspaceInventory.admitted]
      : [{ id: 'nna_workspace', root: workspace }];
    const projects = rows.map(row => ({ id: row.id, worktree: row.root,
      name: row.root.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'NNA workspace',
      time: { created: 0, updated: 0 } }));
    return send(response, 200, path === '/project' ? projects : projects[0]);
  }
  const host = context.nndEngineHost;
  if (!host) throw new ContractError('nnd_engine_unavailable', 'NND engine host is unavailable');
  return send(response, 200, host.statuses(context.principal));
}

function trustedWorkspace(value) {
  // The browser's directory header is never an authority to select a host path.
  return typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : '';
}

function textContent(parts) {
  if (!Array.isArray(parts)) throw new ContractError('request_invalid', 'NND prompt requires message parts');
  // Security: an acknowledged prompt must not silently drop a file, image,
  // or unknown part before the native provider sees it.
  if (parts.some((part) => part?.type !== 'text' || typeof part.text !== 'string')) {
    throw new ContractError('nnd_prompt_part_unsupported', 'NNA cannot submit this message part; remove it before sending');
  }
  const text = parts.map((part) => part.text).join('\n');
  if (!text) throw new ContractError('invalid_content', 'NND prompt requires text content');
  return text;
}

function assertConfiguredSelection(body, model) {
  if (body?.model !== undefined && (!model || body.model?.providerID !== model.providerID || body.model?.modelID !== model.modelID)) {
    throw new ContractError('nnd_model_override_unsupported', 'NNA uses its configured primary model; per-prompt model override is unavailable');
  }
  if (body?.agent !== undefined && body.agent !== 'nna') {
    throw new ContractError('nnd_agent_override_unsupported', 'NNA owns agent routing; per-prompt agent override is unavailable');
  }
}

function createOptions(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ContractError('request_invalid', 'NND session creation requires an object body');
  }
  // The authenticated host selects engine configuration and workspace roots.  In
  // particular, a desktop client must not be able to inject factory options such
  // as a data path or execution manifest through this compatibility endpoint.
  if (body.workspace_id !== undefined && (typeof body.workspace_id !== 'string'
    || !/^ws_[a-f0-9]{24}$/u.test(body.workspace_id))) {
    throw new ContractError('request_invalid', 'NND workspace selection is invalid');
  }
  return { ...(typeof body.title === 'string' ? { title: body.title } : {}),
    ...(body.workspace_id ? { workspace_id: body.workspace_id } : {}) };
}
