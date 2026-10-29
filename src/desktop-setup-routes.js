// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { send } from './secret-broker-server.js';

export async function dispatchDesktopSetupRequest(request, response, context) {
  const runtime = context.desktopRuntime;
  if (!runtime) return false;
  const path = context.url.pathname;
  if (path === '/v1/desktop/setup/status') {
    requireIntegrationPermission(context.principal, 'desktop.setup.read');
    if (request.method !== 'GET') return methodNotAllowed(response);
    return send(response, 200, runtime.snapshot());
  }
  if (path === '/v1/desktop/setup/activate') {
    requireIntegrationPermission(context.principal, 'desktop.setup.activate');
    if (request.method !== 'POST') return methodNotAllowed(response);
    const status = await runtime.activate();
    return send(response, status.service_state === 'ready' ? 200 : 503, status);
  }
  return false;
}

export function guardDesktopSetupRequest(context) {
  if (!context.desktopRuntime || context.desktopRuntime.snapshot().execution_state === 'ready') return;
  const path = context.url.pathname;
  // Security: a setup principal may configure credentials, never retrieve raw secret values or run a provider probe.
  if (/^\/v1\/secrets(?:\/[^/]+)?(?:\/(?:values|status|audit))?$/u.test(path)) return;
  if (/^\/v1\/provider-profiles(?:\/[^/]+)?$/u.test(path)
    || path === '/v1/provider-route' || path === '/v1/provider-route/subagent') return;
  throw new ContractError('desktop_setup_required', 'desktop execution is unavailable. Inspect native setup status and activate after configuration repair.');
}

function methodNotAllowed(response) {
  return send(response, 405, { error: { code: 'method_not_allowed', message: 'Method is not supported for this endpoint.' } });
}
