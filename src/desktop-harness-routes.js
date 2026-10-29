// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { ContractError, newId, requireExternalId } from './ids.js';
import { userDataPaths, VERSION } from './product.js';
import { readJsonBody, send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { sseOpen } from './opencode/protocol.js';
import { dispatchDesktopQuestionRequest } from './desktop-question-routes.js';
import { dispatchDesktopNotificationRequest } from './desktop-notification-routes.js';
import { dispatchDesktopAssistRequest } from './desktop-assist-routes.js';
import { admittedWorkspaceContext } from './desktop-workspace-request-context.js';
import { conversationCreation } from './desktop-conversation-start.js';
import { modelRouteFromBody } from './desktop-session-model-route.js';
const ROUTE = /^\/session(?:\/([^/]+))?(?:\/(message|children|activity|prompt_async|abort|fork|revert|unrevert))?$/u;
const COMMAND_ROUTE = '/command';
const ACTIVITY_HISTORY_ROUTE = /^\/v1\/desktop\/sessions\/([^/]+)\/activity-history$/u;
const ACTIVITY_TOMBSTONES_ROUTE = '/v1/desktop/activity-tombstones';
const MESSAGE_LIMIT_MAX = 200;
const LIVE_BOUNDARY_PREFIX = 'desktop-live-boundary:';
export async function dispatchDesktopHarnessRequest(request, response, context) {
  context = await admittedWorkspaceContext(context);
  if (await readActivityTombstones(request, response, context) || await readActivityHistory(request, response, context)) return true;
  if (openEventStream(request, response, context)) return true;
  if (await dispatchDesktopQuestionRequest(request, response, context)) return true;
  if (await dispatchDesktopNotificationRequest(request, response, context)) return true;
  if (await dispatchDesktopAssistRequest(request, response, context)) return true;
  if (await dispatchBootstrapRequest(request, response, context) || await readCommandCatalog(request, response, context)) return true;
  const match = ROUTE.exec(context.url.pathname); if (!match) return false;
  const host = context.desktopEngineHost; if (!host) throw new ContractError('desktop_engine_unavailable', 'desktop engine host is unavailable');
  const id = sessionIdOf(match);
  if (request.method === 'GET' && (!match[2] || match[2] === 'message' || match[2] === 'children' || match[2] === 'activity')) {
    return readSession(response, context, host, id, match[2]);
  }
  if (request.method === 'POST' && !id) {
    requireIntegrationPermission(context.principal, 'desktop.session.create');
    const body = await readJsonBody(request);
    const options = { ...createOptions(body),
      directory: body?.workspace_id ? body.directory : trustedWorkspace(context.desktopWorkspaceRoot) };
    const creation = conversationCreation(context.principal, options, body.operation_id);
    const made = await host.create(creation.sessionId, context.principal, creation.options);
    return send(response, 201, host.get(made.sessionId, context.principal));
  }
  if (request.method === 'POST' && id && match[2] === 'prompt_async') {
    requireIntegrationPermission(context.principal, 'desktop.session.submit');
    const body = await readJsonBody(request);
    assertConfiguredSelection(body, host.get(id, context.principal)?.metadata?.desktop?.configuredModel ?? host.desktopModel);
    const { content, refs } = promptParts(body?.parts);
    const requestId = body?.messageID ?? newId('desktop_prompt');
    await host.assertWorkspaceBound(id, context.principal);
    // Why: a lost acknowledgement can be retried after a completed turn has released its upload bytes.
    if (host.hasPersistedSubmission?.(id, context.principal, requestId)) { response.writeHead(204); response.end(); return true; }
    const attachments = refs.length > 0 ? host.uploadedAttachments?.(id, context.principal, requestId, refs) : [];
    if (refs.length > 0 && !attachments) throw new ContractError('desktop_attachment_upload_unavailable', 'Native attachment uploads are unavailable');
    const accepted = host.submitAsync(id, { version: '1.0', type: 'submit', request_id: requestId, content, attachments }, context.principal);
    if (accepted.reason === 'busy') return send(response, 409, { error: { code: 'session_busy', message: 'desktop session already has an active turn' } });
    response.writeHead(204); response.end(); return true;
  }
  if (request.method === 'PATCH' && id && !match[2]) {
    return updateSession(request, response, context, host, id);
  }
  if (request.method === 'POST' && id && match[2] === 'fork') {
    requireIntegrationPermission(context.principal, 'desktop.session.create');
    return send(response, 201, await host.fork(id, context.principal, await readJsonBody(request)));
  }
  if (request.method === 'POST' && id && (match[2] === 'revert' || match[2] === 'unrevert')) {
    requireIntegrationPermission(context.principal, 'desktop.session.submit');
    const revert = match[2] === 'revert';
    const made = revert ? await host.revert(id, context.principal, await readJsonBody(request))
      : await host.unrevert(id, context.principal);
    return send(response, 200, made);
  }
  if (request.method === 'POST' && id && match[2] === 'abort') {
    requireIntegrationPermission(context.principal, 'desktop.session.abort'); await host.abort(id, context.principal); return send(response, 200, true);
  }
  if (request.method === 'DELETE' && id && !match[2]) {
    requireIntegrationPermission(context.principal, 'desktop.session.delete'); await host.close(id, context.principal); return send(response, 200, true);
  }
  return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
}

/** Serves GET /path: the real home/state/config/workspace identity. Why: the
 * HarnessPath contract advertises real paths (uniformity #17); empty strings
 * would read as an existing root and lie to desktop consumers. Security: only
 * directory paths are disclosed to the authenticated local harness principal
 * (desktop.read); credential and secret files inside those trees are never
 * included. */
async function sendDiscoveryPaths(response, context, workspace) {
    const binding = await context.desktopEngineHost?.primaryWorkspaceBinding?.();
    if (binding && binding.configured_root !== workspace) {
      throw new ContractError('desktop_workspace_binding_invalid', 'Native primary workspace changed during discovery');
    }
    // Why: the HarnessPath contract advertises real paths; empty strings read
    // as an existing root directory and lie to desktop consumers. NNA's data
    // inventory supplies the home/state/config concepts, so all five fields are
    // filled. Security: only directory paths are disclosed to the authenticated
    // local harness principal (desktop.read); credential and secret files inside
    // those trees are never included in the payload.
    const paths = context.dataPaths ?? userDataPaths();
    return send(response, 200, { home: paths.root, state: join(paths.root, 'runtime'), config: paths.config, worktree: workspace, directory: workspace,
      ...(binding ? { workspace_id: binding.id } : {}) });
}

function sessionIdOf(match) {
  if (!match[1]) return null;
  try { const id = decodeURIComponent(match[1]); requireExternalId(id, 'session_id'); return id; }
  catch { throw new ContractError('session_id_invalid', 'session id is invalid'); }
}

async function updateSession(request, response, context, host, id) {
  requireIntegrationPermission(context.principal, 'desktop.session.update');
  const body = await readJsonBody(request);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) {
    throw new ContractError('request_invalid', 'desktop session update supports title or archived time');
  }
  if (Object.hasOwn(body, 'title')) return send(response, 200, await host.rename(id, context.principal, body.title));
  if (Object.hasOwn(body, 'time') && body.time && typeof body.time === 'object'
    && !Array.isArray(body.time) && Object.keys(body.time).length === 1 && Object.hasOwn(body.time, 'archived')) {
    return send(response, 200, await host.setArchived(id, context.principal, body.time.archived));
  }
  throw new ContractError('request_invalid', 'desktop session update supports title or archived time');
}

/** Owner-scoped deletion receipts, never a complete history or a foreign-session lookup. */
async function readActivityTombstones(request, response, context) {
  if (context.url.pathname !== ACTIVITY_TOMBSTONES_ROUTE) return false;
  if (request.method !== 'GET') return send(response, 405,
    { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
  requireIntegrationPermission(context.principal, 'desktop.read');
  const host = context.desktopEngineHost;
  if (!host?.activityTombstonesPage) throw new ContractError('desktop_engine_unavailable', 'desktop engine host is unavailable');
  const params = context.url.searchParams;
  if ([...params.keys()].some((key) => !['after', 'limit'].includes(key))
    || params.getAll('after').length > 1 || params.getAll('limit').length > 1) {
    throw new ContractError('desktop_activity_tombstones_request_invalid', 'desktop Activity tombstone page request is invalid');
  }
  const after = params.get('after'); const limit = params.get('limit');
  if (after !== null && (!/^(?:0|[1-9]\d{0,15})$/u.test(after) || !Number.isSafeInteger(Number(after)))
    || limit !== null && (!/^[1-9]\d{0,2}$/u.test(limit) || Number(limit) > 100)) {
    throw new ContractError('desktop_activity_tombstones_request_invalid', 'desktop Activity tombstone page request is invalid');
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
  requireIntegrationPermission(context.principal, 'desktop.read');
  const host = context.desktopEngineHost;
  if (!host?.activityHistoryPage) throw new ContractError('desktop_engine_unavailable', 'desktop engine host is unavailable');
  let id;
  try { id = decodeURIComponent(match[1]); requireExternalId(id, 'session_id'); }
  catch { throw new ContractError('session_id_invalid', 'session id is invalid'); }
  const params = context.url.searchParams;
  if ([...params.keys()].some((key) => !['limit', 'cursor'].includes(key))
    || params.getAll('limit').length > 1 || params.getAll('cursor').length > 1) {
    throw new ContractError('desktop_activity_page_invalid', 'desktop activity history page request is invalid');
  }
  const limit = params.get('limit'); const cursor = params.get('cursor');
  if (limit !== null && !/^[1-9]\d{0,2}$/u.test(limit)) {
    throw new ContractError('desktop_activity_page_invalid', 'desktop activity history page request is invalid');
  }
  return send(response, 200, await host.activityHistoryPage(id, context.principal,
    { ...(limit === null ? {} : { limit: Number(limit) }), ...(cursor === null ? {} : { cursor }) }));
}

/** C.6 step 2/7 read seam: NNA serves a read-only GET /command catalog built
 *  from its real skills inventory. Why: desktop's scheduled and queue paths poll
 *  GET /command for readiness and slash resolution; serving the honest skill
 *  entries (source 'skill') turns a 404 into real data while keeping the
 *  ruled boundary — NNA holds no command-execution concept, so the catalog
 *  offers NO executable template entries and
 *  POST /session/:id/command stays unrouted (a slash hit there degrades to
 *  the plain prompt route desktop-side, same expansion treatment the queue got).
 *  Compatibility: entries use the {name, description, template, source}
 *  shape desktop's commandEntryOf resolves; an empty inventory yields an empty
 *  catalog, never fabricated entries. */
async function readCommandCatalog(request, response, context) {
  if (context.url.pathname !== COMMAND_ROUTE) return false;
  if (request.method !== 'GET') return send(response, 405,
    { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
  requireIntegrationPermission(context.principal, 'desktop.read');
  const inventory = await context.desktopEngineHost?.readDesktopSkillsInventory?.();
  // Compatibility: desktop_skills_catalog_unavailable is the registered code whose
  // failure mapping is already 503 (secret-broker-server status table).
  if (!inventory) throw new ContractError('desktop_skills_catalog_unavailable', 'NNA skill discovery is unavailable');
  const skills = Array.isArray(inventory.skills) ? inventory.skills : [];
  return send(response, 200, skills.filter((skill) => skill?.invocation === 'user' || skill?.invocation === 'both')
    .map((skill) => ({ name: skill.id, description: skill.description, source: 'skill' })));
}

function readSession(response, context, host, id, detail) {
  requireIntegrationPermission(context.principal, 'desktop.read');
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
    if (end < 0) throw new ContractError('desktop_message_cursor_invalid', 'message cursor is unavailable');
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
  requireIntegrationPermission(context.principal, 'desktop.read');
  const host = context.desktopEngineHost;
  if (!host?.eventBus?.subscribe) throw new ContractError('desktop_engine_unavailable', 'desktop engine host is unavailable');
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
  if (!['/global/health', '/path', '/config', '/project', '/project/current', '/session/status', '/v1/desktop/pending', '/v1/desktop/mcp', '/v1/desktop/skills', '/v1/desktop/agents'].includes(path)) return false;
  if (request.method !== 'GET') return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
  requireIntegrationPermission(context.principal, 'desktop.read');
  const workspace = trustedWorkspace(context.desktopWorkspaceRoot);
  if (path === '/v1/desktop/pending') {
    if (!context.desktopEngineHost?.pendingRequests) throw new ContractError('desktop_engine_unavailable', 'desktop engine host is unavailable');
    return send(response, 200, context.desktopEngineHost.pendingRequests(context.principal));
  }
  // Why: this field identifies the responding NNA build to the desktop client;
  // consumers (probe()/globalHealth) gate only on `healthy`, so nothing pins a
  // protocol value here. Compatibility: it previously carried the stale '1.18.31'
  // pin (no owning module, name only in this route + its test), which read as a
  // harness protocol version; the field is the NNA product version.
  if (path === '/global/health') return send(response, 200, { healthy: true, version: VERSION });
  if (path === '/path') return sendDiscoveryPaths(response, context, workspace);
  if (path === '/v1/desktop/mcp') {
    const inventory = context.desktopEngineHost?.desktopMcpInventory;
    if (!inventory) throw new ContractError('desktop_engine_unavailable', 'desktop MCP inventory is unavailable');
    return send(response, 200, inventory);
  }
  if (path === '/v1/desktop/agents') {
    const inventory = context.desktopEngineHost?.desktopAgentInventory;
    if (!inventory) throw new ContractError('desktop_engine_unavailable', 'desktop agent inventory is unavailable');
    return send(response, 200, inventory);
  }
  if (path === '/v1/desktop/skills') {
    const inventory = await context.desktopEngineHost?.readDesktopSkillsInventory?.();
    if (!inventory) throw new ContractError('desktop_engine_unavailable', 'desktop skills inventory is unavailable');
    return send(response, 200, inventory);
  }
  if (path === '/config') {
    const model = context.desktopEngineHost?.desktopModel;
    if (!model) throw new ContractError('desktop_engine_unavailable', 'desktop engine model configuration is unavailable');
    return send(response, 200, {
      model: `${model.providerID}/${model.modelID}`, default_agent: 'nna',
      desktop: { engine: 'nna', modelSelection: 'configured', primaryModel: model },
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
  const host = context.desktopEngineHost;
  if (!host) throw new ContractError('desktop_engine_unavailable', 'desktop engine host is unavailable');
  return send(response, 200, host.statuses(context.principal));
}

function trustedWorkspace(value) {
  // Why (uniformity #10): the browser's directory header/query is NEVER read on this side — it is desktop presentation scoping, not an authority. One authority exists: principal + the per-session bound workspace admitted at creation; every path decision here fails closed against that binding.
  return typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : '';
}

function promptParts(parts) {
  if (!Array.isArray(parts)) throw new ContractError('request_invalid', 'desktop prompt requires message parts');
  const texts = [], refs = [];
  for (const part of parts) {
    if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    else if (part?.type === 'file' && typeof part.upload_id === 'string'
      && Object.keys(part).length === 2) refs.push({ upload_id: part.upload_id });
    else throw new ContractError('desktop_prompt_part_unsupported', 'NNA cannot submit this message part; remove it before sending');
  }
  const content = texts.join('\n');
  if (!content && refs.length === 0) throw new ContractError('invalid_content', 'desktop prompt requires text or an uploaded file');
  return { content, refs };
}

function assertConfiguredSelection(body, model) {
  if (body?.model !== undefined && (!model || body.model?.providerID !== model.providerID || body.model?.modelID !== model.modelID)) {
    throw new ContractError('desktop_model_override_unsupported', 'NNA uses its configured primary model; per-prompt model override is unavailable');
  }
  if (body?.agent !== undefined && body.agent !== 'nna') {
    throw new ContractError('desktop_agent_override_unsupported', 'NNA owns agent routing; per-prompt agent override is unavailable');
  }
  // Why: desktop's prompt body carries variant (model effort) and delivery ('steer'|'queue'),
  // but NNA's request path reads only content/attachments (ingress -> Engine.submit) and
  // takes reasoning effort from the configured provider route, while steer/queue have no
  // root-session path here (child steering is a separate grant route, desktop-session-registry).
  // Silently dropping them would show the operator a machine state that never applies.
  // Compatibility: desktop must stop sending variant/delivery until NNA gains per-prompt controls.
  if (body?.variant !== undefined) {
    throw new ContractError('desktop_variant_override_unsupported', 'NNA uses its configured model effort; per-prompt variant is unavailable');
  }
  if (body?.delivery !== undefined) {
    throw new ContractError('desktop_delivery_override_unsupported', 'NNA submits each prompt directly to the session; per-prompt delivery (steer/queue) is unavailable');
  }
}

function createOptions(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ContractError('request_invalid', 'desktop session creation requires an object body');
  }
  // The authenticated host selects engine configuration and workspace roots.  In
  // particular, a desktop client must not be able to inject factory options such
  // as a data path or execution manifest through this compatibility endpoint.
  if (body.workspace_id !== undefined && (typeof body.workspace_id !== 'string'
    || !/^ws_[a-f0-9]{24}$/u.test(body.workspace_id))) {
    throw new ContractError('request_invalid', 'desktop workspace selection is invalid');
  }
  if (body.reviewMode !== undefined && !['default', 'auto-review', 'unattended'].includes(body.reviewMode)) {
    throw new ContractError('request_invalid', 'Conversation review mode is invalid');
  }
  if (body.start_fingerprint !== undefined && (typeof body.start_fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(body.start_fingerprint))) {
    throw new ContractError('request_invalid', 'Conversation start fingerprint is invalid');
  }
  const modelRoute = modelRouteFromBody(body);
  return { ...(typeof body.title === 'string' ? { title: body.title } : {}),
    ...(body.workspace_id ? { workspace_id: body.workspace_id } : {}),
    ...(modelRoute ? { modelRoute } : {}), ...(body.reviewMode ? { reviewMode: body.reviewMode } : {}), ...(body.start_fingerprint ? { startFingerprint: body.start_fingerprint } : {}) };
}
