// SPDX-License-Identifier: Apache-2.0
/** Native managed-browser observation and validation route over
 * /v1/nnd/configuration/browser. Why: the browser_action census family cites
 * src/web-browse-cli.js runWebBrowseCommand, whose status/verify verbs wrap
 * src/playwright-runtime.js playwrightStatus verbatim — the same authority
 * the product's webbrowse tool loads. This surface reuses that authority
 * unchanged: GET status reads the managed Playwright installation
 * (presence, version, browser path, and the honest refusal reason); POST
 * actions/verify runs the same status WITH the launch probe (headless
 * chromium launch, a real page navigation, and a clean close) so the
 * operator learns the runtime actually works, not merely that files exist.
 * Invariants: the receipt projection is fail-closed — the raw authority
 * shape (with the reason key only on refusals) is normalized into one
 * grammar where available:true means version + browser_path strings and a
 * null reason, and available:false means null version/browser_path with a
 * non-empty reason from {not_installed, version_mismatch, validation_failed};
 * nothing else projects (500 nnd_browser_projection_invalid). The authority
 * never throws for availability outcomes (they freeze a refusal object), so
 * the route's hard failures are projector drift (500) and transport grammar
 * (400). Verify changes nothing on disk — the probe launches, validates,
 * and closes a browser — so both verbs carry the read right; the probe
 * inherits the listener console and is bounded by the runtime's own
 * timeouts (10s navigation, close-guarded).
 */
import { randomUUID } from 'node:crypto';
import { ContractError } from './ids.js';
import { readJsonBody, send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';
import { playwrightStatus } from './playwright-runtime.js';

const BASE = '/v1/nnd/configuration/browser';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const REQUEST_BYTES = 65_536;
const RESPONSE_BOUND = 65_536;
const REASONS = ['not_installed', 'version_mismatch', 'validation_failed'];
const invalid = () => new ContractError('nnd_browser_action_invalid', 'Native browser action is invalid.');
const projection = () => new ContractError('nnd_browser_projection_invalid', 'Native browser observation refused a drifted projection.');

// Read-only family: the managed runtime is installer-owned; the surface
// observes and validates, never installs or removes.
const CATALOG = Object.freeze({ schema_version: '1.0', source: 'browser', scope: 'user',
  fields: Object.freeze([
    Object.freeze({ path: 'available', classification: 'generated_state', application: 'not_applied',
      editability: { available: false, scope: 'user', reason: 'installer_state' } }),
    Object.freeze({ path: 'version', classification: 'generated_state', application: 'not_applied',
      editability: { available: false, scope: 'user', reason: 'installer_state' } }),
    Object.freeze({ path: 'verify', classification: 'operator_setting', application: 'not_applied',
      operations: ['verify'], required_permission: 'nnd.configuration.read',
      editability: { available: true, scope: 'user', required_permission: 'nnd.configuration.read' } }),
  ]) });

export async function dispatchNndBrowserRequest(request, response, context) {
  const path = context.url.pathname;
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
  // Permission first, exactly like the sibling family routes.
  requireIntegrationPermission(context.principal, 'nnd.configuration.read');
  if (path === `${BASE}/catalog`) {
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    if (context.url.search) throw invalid();
    return send(response, 200, CATALOG);
  }
  if (path !== BASE && path !== `${BASE}/actions/verify`) return send(response, 404, { error: 'not_found' });
  const verify = path !== BASE;
  if (verify ? request.method !== 'POST' : request.method !== 'GET') {
    return send(response, 405, { error: 'method_not_allowed' });
  }
  if (context.url.search) throw invalid();
  if (verify) await readJsonBody(request, REQUEST_BYTES);
  const service = context.nndBrowserActionsService;
  if (!service || typeof service.status !== 'function' || typeof service.verify !== 'function') {
    throw new ContractError('nnd_configuration_unavailable', 'Native browser observation is unavailable.');
  }
  const receipt = projectReceipt(await (verify ? service.verify() : service.status()));
  if (Buffer.byteLength(JSON.stringify(receipt)) > RESPONSE_BOUND) throw invalid();
  return send(response, 200, receipt);
}

/** Fail-closed normalizer over the authority's two outcome shapes: the
 * success freeze (no reason key) and the refusal freeze (version and
 * browserPath null, reason present). Anything else is projector drift. */
export function projectReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'action,application,data_id,installation_id,'
      + 'operation_id,schema_version,scope,status'
    || typeof value.installation_id !== 'string' || !ID.test(value.installation_id)
    || typeof value.data_id !== 'string' || !ID.test(value.data_id) || value.scope !== 'user'
    || (value.action !== 'status' && value.action !== 'verify')
    || value.application !== 'not_applied'
    || typeof value.operation_id !== 'string' || !ID.test(value.operation_id)) throw projection();
  const raw = value.status;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || typeof raw.root !== 'string' || raw.root.length === 0
    || raw.browser !== 'chromium') throw projection();
  if (raw.available === true) {
    if (Object.keys(raw).sort().join(',') !== 'available,browser,browserPath,root,version'
      || typeof raw.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(raw.version)
      || typeof raw.browserPath !== 'string' || raw.browserPath.length === 0
      || raw.browserPath.length > 4096) throw projection();
    return receiptOf(value, { available: true, version: raw.version, browser: 'chromium',
      browser_path: raw.browserPath, root: raw.root, reason: null });
  }
  if (raw.available !== false
    || Object.keys(raw).sort().join(',') !== 'available,browser,browserPath,reason,root,version'
    || raw.version !== null || raw.browserPath !== null
    || !REASONS.includes(raw.reason)) throw projection();
  return receiptOf(value, { available: false, version: null, browser: 'chromium',
    browser_path: null, root: raw.root, reason: raw.reason });
}

function receiptOf(value, status) {
  return { schema_version: '1.0', installation_id: value.installation_id, data_id: value.data_id,
    scope: 'user', action: value.action, application: 'not_applied',
    operation_id: value.operation_id, status };
}

export function createNndBrowserActionsService({ root, installationId, dataId, statusRunner = playwrightStatus }) {
  if (typeof root !== 'string' || root.length === 0 || !ID.test(installationId ?? '')
    || !ID.test(dataId ?? '') || typeof statusRunner !== 'function') throw invalid();
  const envelope = (action, status) => ({ schema_version: '1.0', installation_id: installationId,
    data_id: dataId, scope: 'user', action, application: 'not_applied',
    operation_id: randomUUID(), status });
  return Object.freeze({
    async status() { return envelope('status', await statusRunner(root)); },
    async verify() { return envelope('verify', await statusRunner(root, { verifyLaunch: true })); },
  });
}
