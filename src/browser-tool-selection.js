// SPDX-License-Identifier: Apache-2.0
/**
 * Which browser tool a conversation gets, and why.
 *
 * Why this decision lives apart from the registry: the registry is about
 * installing definitions, while this is about which page a conversation can
 * actually reach. A conversation shows one page, so exactly one browser tool is
 * installed:
 *
 * - A hosting surface (OpenChamber) displays the page through its own router, so
 *   the conversation drives that pane. Preferred when present, because it is the
 *   page the operator is looking at.
 * - The desktop integration carries a callback URL to its own browser.
 * - With neither — the TUI, or a desktop host — NNA runs its own managed
 *   Playwright browser, which is the only way to see a page there.
 *
 * Why exclusive rather than additive: offering Playwright beside the hosted pane
 * gave the model two browser tools, and it reached for the headless one it knows
 * instead of the window on screen. A browser the operator cannot see is the wrong
 * answer when they asked about the page in front of them.
 *
 * Invariant: exactly one browser tool, and only when a real page can be driven.
 * Installing one with no transport would hand the model a tool whose every call
 * fails.
 */
import { join, dirname } from 'node:path';
import { desktopBrowserDefinition } from './desktop-browser-tool.js';
import { hostedBrowserDefinition } from './hosted-browser-tool.js';
import { webBrowseDefinition } from './web-browse-tool.js';

/**
 * Installs the one browser tool this conversation can use.
 *
 * @param {{install: (definition: object) => void, browserRoot: string, sessionId: string|null,
 *   surface: 'desktop'|'playwright', hosted: boolean, desktopCallback: object|null,
 *   hostedTransport: object|null, hostedContext?: () => object,
 *   playwright?: object|null, captureRoot?: string}} options
 *   `playwright` carries what the managed browser needs; it is used only when this
 *   conversation has no hosted pane and no desktop callback.
 */
export function installBrowserTool({ install, browserRoot, sessionId, surface, hosted,
  desktopCallback, hostedTransport, hostedContext, playwright }) {
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
  // With no surface of its own, NNA's managed browser is the only way to a page.
  if (playwright) { install(webBrowseDefinition(playwright)); return 'playwright'; }
  return null;
}
