// SPDX-License-Identifier: Apache-2.0
import { readJsonBody, send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { desktopBrowserCallbackFromRegistration } from './desktop-browser-tool.js';

const REGISTRATION_ROUTE = '/internal/desktop/browser-callback';

/** In-memory holder for the desktop browser callback the environment path used to
 * fix at child spawn. Engines read `current()` when they are created, so a
 * callback registered after startup applies to every subsequent session and
 * tool install; existing sessions keep the callback they observed. */
export function createDesktopBrowserCallbackRegistry(initial = null) {
  let current = initial;
  return Object.freeze({
    current: () => current,
    set(value) {
      const callback = desktopBrowserCallbackFromRegistration(value);
      current = callback;
      return callback;
    },
    clear() { current = null; },
  });
}

/** Local-only registration surface for the attached desktop desktop. Trust model:
 * the loopback listener already authenticates every request with the bearer
 * token issued in the readiness frame; on top of that the caller's principal
 * must hold `desktop.browser.manage`, mirroring other private desktop routes. */
export async function dispatchDesktopBrowserRegistrationRequest(request, response, context) {
  const registry = context.desktopBrowserCallbackRegistry;
  if (context.url.pathname !== REGISTRATION_ROUTE || !registry) return false;
  if (request.method === 'GET') {
    requireIntegrationPermission(context.principal, 'desktop.browser.manage');
    const callback = registry.current();
    // The registered token is never echoed back; only the URL is observable.
    return send(response, 200, { registered: Boolean(callback), ...(callback ? { url: callback.url } : {}) });
  }
  if (request.method === 'POST') {
    requireIntegrationPermission(context.principal, 'desktop.browser.manage');
    const callback = registry.set(await readJsonBody(request));
    return send(response, 200, { registered: true, url: callback.url });
  }
  if (request.method === 'DELETE') {
    requireIntegrationPermission(context.principal, 'desktop.browser.manage');
    registry.clear();
    return send(response, 200, { registered: false });
  }
  return send(response, 405, { error: { code: 'method_not_allowed', message: 'method is not supported for this endpoint' } });
}
