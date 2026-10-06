// SPDX-License-Identifier: Apache-2.0
/** Native hooks settings surface over /v1/nnd/configuration/hooks.
 * Why: the census classifies nine hooks rows (name, version, and the seven
 * subscriptions[*] fields) observed through the multi-instance hook store — one
 * manifest.json per bundle directory under the configured hooks root. This surface
 * is the READ half: it reuses discoverHookBundles VERBATIM (identity guards,
 * realpath leaving, bundle caps, bounded manifests, manifest and subscription
 * validation, and the frozen diagnostics) and projects exactly what discovery
 * produced: bundle name, version, directory name, subscriptions with their
 * command, blocking, priority, timeout_ms, and max_concurrent, plus the honest
 * skipped/limit diagnostics. Runtime EXECUTION stays out of this settings family
 * (hook-runner is a different surface); mutations stay out too — authoring a
 * manifest belongs to the hook-store mutation story, and nothing here writes.
 * Invariant: discovery's own honesty channel is preserved — a malformed bundle is
 * a skipped diagnostic, never an empty or partial list; an absent hooks directory
 * is an honest 'absent' source state with count 0. Field grammar mirrors the
 * domain VERBATIM, including its tolerance (an empty or control-bearing version
 * string is what the manifest carried and projects as-is, bounded only by the
 * domain's own 64-slice). A drifted projection fails closed with its own
 * server-side code, like the secrets family.
 * Application: 'next_hook_use' — bundles are already on disk and apply when the
 * runner next dispatches their subscribed events; this read applies or
 * activates nothing.
 */
import { lstat } from 'node:fs/promises';
import { discoverHookBundles } from './hook-manifest.js';
import { ContractError } from './ids.js';
import { send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';

const BASE = '/v1/nnd/configuration/hooks';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PATH_OR_NAME = /^[\x20-\x7e]{1,255}$/u;
const LINE = /^[\x20-\x7e]{1,64}$/u;
const CODE = /^[a-z0-9_]{1,64}$/u;
// Loose ceiling, not derived: 32 bundles x 64 subscriptions with commands up to
// 1,024 bytes each lands around 2.3 MB at the true worst; the bound mirrors the
// secrets family's ceiling-plus-allowance discipline and is otherwise untrippable
// by honest manifests. Beyond it the projection is drift and fails closed.
const RESPONSE_BOUND = 4_194_304 + 65_536;
const requestInvalid = () => new ContractError('nnd_hooks_request_invalid', 'Native hooks request is invalid.');
const projection = () => new ContractError('nnd_hooks_projection_invalid', 'Hooks settings refused a drifted projection.');

const READ_PERMISSION = 'nnd.configuration.read';
const field = (path, classification) => Object.freeze({ path, classification,
  application: 'next_hook_use', scope: 'user', required_permission: READ_PERMISSION,
  editability: { available: false, scope: 'user', reason: 'hook_store_mutation_separate' } });
const CATALOG = Object.freeze({ schema_version: '1.0', source: 'hooks', scope: 'user',
  fields: Object.freeze([
    field('name', 'operator_setting'), field('version', 'package_identity'),
    field('subscriptions[*].event', 'operator_setting'),
    field('subscriptions[*].phase', 'operator_setting'),
    field('subscriptions[*].command', 'operator_setting'),
    field('subscriptions[*].blocking', 'operator_setting'),
    field('subscriptions[*].priority', 'operator_setting'),
    field('subscriptions[*].timeout_ms', 'operator_setting'),
    field('subscriptions[*].max_concurrent', 'operator_setting'),
  ]) });

export async function dispatchNndHooksRequest(request, response, context) {
  const path = context.url.pathname;
  if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
  const action = path === BASE ? 'list' : path === `${BASE}/catalog` ? 'catalog' : null;
  if (!action) return send(response, 404, { error: 'not_found' });
  requireIntegrationPermission(context.principal, READ_PERMISSION);
  if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
  if (context.url.search) throw requestInvalid();
  const service = context.nndHooksSettingsService;
  if (!service || typeof service.list !== 'function') {
    throw new ContractError('nnd_configuration_unavailable', 'Native hooks settings are unavailable.');
  }
  if (action === 'catalog') return send(response, 200, CATALOG);
  const projected = projectHooksList(await service.list());
  if (projected === null || Buffer.byteLength(JSON.stringify(projected)) > RESPONSE_BOUND) throw projection();
  return send(response, 200, projected);
}

export function createNndHooksSettingsService({ hooksPath, installationId, dataId }) {
  if (!ID.test(installationId ?? '') || !ID.test(dataId ?? '')
    || typeof hooksPath !== 'string' || !hooksPath) throw requestInvalid();
  return Object.freeze({
    async list() {
      const [sourceState, discovery] = await Promise.all([
        absentState(hooksPath), discoverHookBundles(hooksPath)]);
      return { installationId, dataId, sourceState,
        count: discovery.bundles.length, hooks: discovery.bundles,
        diagnostics: discovery.diagnostics };
    },
  });
}

// The discovered bundle carries its absolute 'directory' too; it stays raw in
// the envelope check but NEVER projects — the census carries only the bundle
// name, version, directory name, and subscriptions.
const BUNDLE_KEYS = 'directory,directoryName,name,subscriptions,version';

export function projectHooksList(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'count,dataId,diagnostics,hooks,installationId,sourceState'
    || !ID.test(value.installationId ?? '') || !ID.test(value.dataId ?? '')
    || !['present', 'absent'].includes(value.sourceState) || !Array.isArray(value.hooks)
    || !Array.isArray(value.diagnostics)
    || (value.sourceState === 'absent' && value.hooks.length !== 0)
    || (value.sourceState === 'absent' && value.diagnostics.length !== 0)
    || value.hooks.length !== value.count) {
    throw projection();
  }
  const diagnostics = value.diagnostics.map((entry) => projectDiagnostic(entry));
  const bundles = value.hooks.map((bundle) => {
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
      || Object.keys(bundle).sort().join(',') !== BUNDLE_KEYS
      || typeof bundle.directoryName !== 'string' || !PATH_OR_NAME.test(bundle.directoryName)
      || typeof bundle.name !== 'string' || !SAFE_NAME.test(bundle.name)
      || typeof bundle.version !== 'string' || bundle.version.length > 64
      || !Array.isArray(bundle.subscriptions) || bundle.subscriptions.length > 64) {
      throw projection();
    }
    const subscriptions = bundle.subscriptions.map((item) => projectSubscription(item));
    return { name: bundle.name, version: bundle.version, directory_name: bundle.directoryName,
      subscriptions };
  });
  return { schema_version: '1.0', installation_id: value.installationId, data_id: value.dataId,
    scope: 'user', source_state: value.sourceState, count: bundles.length, hooks: bundles,
    diagnostics, application: 'next_hook_use' };
}

const RAW_SUBSCRIPTION_KEYS = 'blocking,command,event,maxConcurrent,phase,priority,timeoutMs';

function projectSubscription(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== RAW_SUBSCRIPTION_KEYS) throw projection();
  const { event, phase, command, blocking, priority, timeoutMs, maxConcurrent } = value;
  if (typeof event !== 'string' || !LINE.test(event) || typeof phase !== 'string'
    || !LINE.test(phase) || !eventPhase(event, phase)) throw projection();
  // Commands mirror the runner's own grammar verbatim: parseCommand bans shell
  // metacharacters and carriage return or newline, authors may quote anything
  // else, and the length cap is the domain's 1..1024.
  if (typeof command !== 'string' || command.length < 1 || command.length > 1024
    || command.includes('\r') || command.includes('\n')) throw projection();
  if (blocking !== true && blocking !== false) throw projection();
  if (!boundedInteger(priority, -100_000, 100_000) || !boundedInteger(timeoutMs, 100, 300_000)
    || !boundedInteger(maxConcurrent, 1, 16)) throw projection();
  return Object.freeze({ event, phase, command, blocking, priority,
    timeout_ms: timeoutMs, max_concurrent: maxConcurrent });
}

/** The domain's own subscription vocabulary, pinned here so a projected pair can
 * never wander outside what the runner actually dispatches. */
const EVENT_PHASES = new Set(['session.start:post', 'session.end:pre', 'turn:pre', 'turn:post',
  'tool.call:pre', 'tool.call:post', 'compaction:pre', 'compaction:post',
  'context.checkpoint:post', 'maintenance:idle']);

function eventPhase(event, phase) { return EVENT_PHASES.has(`${event}:${phase}`); }

function boundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

const DIAGNOSTIC_LIMIT_KEYS = 'bundle,code,omitted,status';
const DIAGNOSTIC_SKIP_KEYS = 'bundle,code,status';

function projectDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw projection();
  const keys = Object.keys(value).sort().join(',');
  if (value.status === 'limit_reached') {
    if (keys !== DIAGNOSTIC_LIMIT_KEYS || value.bundle !== null
      || value.code !== 'hook_bundle_limit_reached' || Number.isInteger(value.omitted) === false
      || value.omitted < 1) throw projection();
    return { bundle: null, status: 'limit_reached', code: value.code, omitted: value.omitted };
  }
  if (value.status !== 'skipped' || keys !== DIAGNOSTIC_SKIP_KEYS) throw projection();
  if (value.bundle === null ? false : typeof value.bundle !== 'string'
    || !PATH_OR_NAME.test(value.bundle)) throw projection();
  if (typeof value.code !== 'string' || !CODE.test(value.code)) throw projection();
  return { bundle: value.bundle, status: 'skipped', code: value.code };
}

/** The hooks store is absent when the hooks directory does not exist yet;
 * anything else either exists (diagnostics carry their own honesty) or is a
 * filesystem error the discovery read will report itself. */
async function absentState(hooksPath) {
  try { await lstat(hooksPath); return 'present'; }
  catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
}
