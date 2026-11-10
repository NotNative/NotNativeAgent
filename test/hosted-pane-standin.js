// SPDX-License-Identifier: Apache-2.0
/**
 * A stand-in for the host route this repository's client speaks.
 *
 * Why a stand-in rather than the real thing: the route lives in the OpenChamber
 * tree, and NNA's suites must not depend on that tree being present or built.
 * The contract is what matters here — the same guards, the same action list, the
 * same reply shape — so a drift on either side fails a test in this repository.
 */
import { timingSafeEqual } from 'node:crypto';

export const PANE_ROUTE = '/api/openchamber/nna/browser';
export const PANE_ACTIONS = Object.freeze(['browser.open', 'browser.snapshot', 'browser.inspect',
  'browser.click', 'browser.type', 'browser.select', 'browser.scroll', 'browser.back',
  'browser.forward', 'browser.capture', 'browser.resize', 'browser.close']);

const asText = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

function same(provided, expected) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Handles one request the way the host route does, given a `router` that stands
 * in for OpenChamber's browser control router.
 */
export async function answerPaneRequest({ request, router, token, body }) {
  const peer = typeof request.socket?.remoteAddress === 'string' ? request.socket.remoteAddress : '';
  if (!(peer === '::1' || peer.startsWith('127.') || peer.startsWith('::ffff:127.'))) {
    return { status: 403, body: { ok: false, error: 'this browser route accepts loopback requests only' } };
  }
  const header = asText(request.headers?.authorization);
  const provided = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !provided || !same(provided, token)) {
    return { status: 401, body: { ok: false, error: 'Unauthorized' } };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { ok: false, error: 'a JSON body is required' } };
  }
  const action = asText(body.action);
  if (!action || !PANE_ACTIONS.includes(action)) {
    return { status: 400, body: { ok: false, error: `action must be one of ${PANE_ACTIONS.join(', ')}` } };
  }
  if (!body.parameters || typeof body.parameters !== 'object' || Array.isArray(body.parameters)) {
    return { status: 400, body: { ok: false, error: 'parameters must be a JSON object' } };
  }
  try {
    const data = await router.request(action, body.parameters, {
      signal: new AbortController().signal,
      timeoutMs: action === 'browser.open' ? 45_000 : 20_000,
      context: { directory: asText(body.context?.directory), sessionId: asText(body.context?.sessionId) },
    });
    return { status: 200, body: { ok: true, data: data ?? null } };
  } catch (error) {
    const status = Number(error?.status) >= 400 && Number(error?.status) < 600 ? Number(error.status) : 500;
    return { status, body: { ok: false, error: String(error?.message ?? 'the browser action failed').slice(0, 500) } };
  }
}
