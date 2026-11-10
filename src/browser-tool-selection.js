// SPDX-License-Identifier: Apache-2.0
/**
 * Which browser tool a conversation gets, and why.
 *
 * Why this decision lives apart from the registry: the registry is about
 * installing definitions, while this is about which page a conversation can
 * actually reach. Three surfaces are possible and they are not exclusive:
 *
 * - A hosting surface (OpenChamber) displays the page through its own router, so
 *   the conversation drives that pane. Preferred when present, because it is the
 *   page the operator is looking at.
 * - The desktop integration carries a callback URL to its own browser.
 * - Otherwise NNA runs its own managed Playwright browser.
 *
 * Invariant: `desktop_browser` is installed at most once per conversation, and
 * only when a real page can be driven. Installing it with no transport would
 * hand the model a tool whose every call fails.
 */
import { join, dirname } from 'node:path';
import { desktopBrowserDefinition } from './desktop-browser-tool.js';
import { hostedBrowserDefinition } from './hosted-browser-tool.js';

/**
 * Installs the browser tool this conversation can use.
 *
 * @param {{install: (definition: object) => void, browserRoot: string, sessionId: string|null,
 *   surface: 'desktop'|'playwright', hosted: boolean, desktopCallback: object|null,
 *   hostedTransport: object|null, hostedCaptureRoot: string|null,
 *   captureRoot?: string, context?: () => object}} options
 */
export function installBrowserTool({ install, browserRoot, sessionId, surface, hosted,
  desktopCallback, hostedTransport, hostedCaptureRoot, hostedContext }) {
  const captureRoot = join(dirname(browserRoot), 'desktop-captures', sessionId ?? 'standalone');
  // A hosted pane wins: it is the page the operator sees, and its router applies
  // the claim race and tab scoping that the pane already enforces.
  if (hostedTransport) {
    install(hostedBrowserDefinition(hostedTransport, {
      captureRoot: join(dirname(browserRoot), 'hosted-browser-captures', sessionId ?? 'standalone'),
      ...(hostedContext ? { context: hostedContext } : {}),
    }));
    return 'hosted';
  }
  // Security: a hosted conversation must not fall back to a local browser it was
  // not asked for; the surface chose not to offer one here.
  if (hosted) return null;
  if (surface === 'desktop' && desktopCallback) {
    install(desktopBrowserDefinition(desktopCallback, { captureRoot }));
    return 'desktop';
  }
  return null;
}
