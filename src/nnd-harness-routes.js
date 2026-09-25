// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId, requireExternalId } from './ids.js';
import { readJsonBody, send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { sseOpen } from './opencode/protocol.js';
const ROUTE = /^\/session(?:\/([^/]+))?(?:\/(message|prompt_async|abort))?$/u;
export async function dispatchNndHarnessRequest(request, response, context) {
  if (openEventStream(request, response, context)) return true;
  if (await dispatchBootstrapRequest(request, response, context)) return true;
  const match = ROUTE.exec(context.url.pathname); if (!match) return false;
  const host = context.nndEngineHost; if (!host) throw new ContractError('nnd_engine_unavailable', 'NND engine host is unavailable');
  let id = null;
  if (match[1]) {
    try { id = decodeURIComponent(match[1]); requireExternalId(id, 'session_id'); }
    catch { throw new ContractError('session_id_invalid', 'session id is invalid'); }
  }
  if (request.method === 'GET' && (!match[2] || match[2] === 'message')) {
    requireIntegrationPermission(context.principal, 'nnd.read');
    return send(response, 200, match[2] === 'message' ? host.messages(id, context.principal) : id ? host.get(id, context.principal) : host.list(context.principal, {
      includeArchived: context.url.searchParams.get('archived') === 'true',
    }));
  }
  if (request.method === 'POST' && !id) {
    requireIntegrationPermission(context.principal, 'nnd.session.create');
    const body = await readJsonBody(request);
    const options = { ...createOptions(body), directory: trustedWorkspace(context.nndWorkspaceRoot) };
    const made = await host.create(newId('ses'), context.principal, options);
    return send(response, 201, host.get(made.sessionId, context.principal));
  }
  if (request.method === 'POST' && id && match[2] === 'prompt_async') {
    requireIntegrationPermission(context.principal, 'nnd.session.submit');
    const body = await readJsonBody(request);
    const content = textContent(body?.parts);
    const accepted = host.submitAsync(id, { version: '1.0', type: 'submit', request_id: body?.messageID ?? newId('nnd_prompt'), content }, context.principal);
    if (accepted.reason === 'busy') {
      return send(response, 409, { error: { code: 'session_busy', message: 'NND session already has an active turn' } });
    }
    response.writeHead(204); response.end(); return true;
  }
  if (request.method === 'PATCH' && id && !match[2]) {
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

function openEventStream(request, response, context) {
  if (request.method !== 'GET' || !['/global/event', '/event'].includes(context.url.pathname)) return false;
  requireIntegrationPermission(context.principal, 'nnd.read');
  const host = context.nndEngineHost;
  if (!host?.eventBus?.subscribe) throw new ContractError('nnd_engine_unavailable', 'NND engine host is unavailable');
  sseOpen(response);
  const unsubscribe = host.eventBus.subscribe(response, {
    subjectId: context.principal.subjectId,
    workspaceIds: context.principal.workspaceIds,
  });
  request.once('close', unsubscribe);
  response.once('close', unsubscribe);
  return true;
}

async function dispatchBootstrapRequest(request, response, context) {
  const path = context.url.pathname;
  if (!['/global/health', '/path', '/config', '/project', '/project/current', '/session/status'].includes(path)) return false;
  if (request.method !== 'GET') return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
  requireIntegrationPermission(context.principal, 'nnd.read');
  const workspace = trustedWorkspace(context.nndWorkspaceRoot);
  if (path === '/global/health') return send(response, 200, { healthy: true, version: '1.18.31' });
  if (path === '/path') return send(response, 200, { home: '', state: '', config: '', worktree: workspace, directory: workspace });
  if (path === '/config') return send(response, 200, {});
  if (path === '/project' || path === '/project/current') {
    const project = { id: 'nna_workspace', worktree: workspace, name: 'NNA workspace', time: { created: 0, updated: 0 } };
    return send(response, 200, path === '/project' ? [project] : project);
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
  const text = parts.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
  if (!text) throw new ContractError('invalid_content', 'NND prompt requires text content');
  return text;
}

function createOptions(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ContractError('request_invalid', 'NND session creation requires an object body');
  }
  // The authenticated host selects engine configuration and workspace roots.  In
  // particular, a desktop client must not be able to inject factory options such
  // as a data path or execution manifest through this compatibility endpoint.
  return typeof body.title === 'string' ? { title: body.title } : {};
}
