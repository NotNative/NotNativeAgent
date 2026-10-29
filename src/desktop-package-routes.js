// SPDX-License-Identifier: Apache-2.0
/** Native desktop package action routes over /v1/desktop/configuration/desktop-package.
 * Why: the three census operator_action rows (activate/deactivate/status)
 * describe the installed-package registry whose authority lives in
 * src/desktop-package.js — this surface reuses runDesktopPackageCommand VERBATIM, so
 * package-root validation (manifest + built server + web assets), the
 * manifest-transaction registration, and the root-mismatch deactivation
 * refusal stay exactly as shipped to `nna integration package`. status reads
 * the registry like the CLI's status verb; activate and deactivate are
 * operator actions on the registry itself with their own right,
 * desktop.package.manage, kept separate from the settings write right because
 * they bind which desktop package the native service serves. A check result
 * is the CLI's own verdict — nothing here re-validates in parallel.
 * Invariants: the registry never carries private data (only root, version,
 * protocol); receipts pin the CLI's variant grammar exactly ({registered:false}
 * · {registered:true,valid:boolean,root,version[,reason]}); activation with
 * service-host admission stays installer-domain and remains refused here
 * exactly like the plain CLI
 * (validateDesktopPackage without a serviceHost — the same call the CLI makes);
 * projection drift fails closed (desktop_package_projection_invalid, 500).
 */
import { randomUUID } from 'node:crypto';
import { ContractError } from './ids.js';
import { runDesktopPackageCommand } from './desktop-package.js';
import { send } from './secret-broker-server.js';
import { requireIntegrationPermission } from './integration-principal.js';

const BASE = '/v1/desktop/configuration/desktop-package';
const READ = 'desktop.configuration.read';
const MANAGE = 'desktop.package.manage';
const REQUEST_BYTES = 4096;
const RESPONSE_BYTES = 65_536;
const invalid = () => new ContractError('desktop_package_action_invalid', 'Native desktop package action is invalid.');
const projection = () => new ContractError('desktop_package_projection_invalid', 'desktop package action refused a drifted projection.');

export async function dispatchDesktopPackageRequest(request, response, context) {
  const path = context.url.pathname;
  if (path !== BASE && !path.startsWith(`${BASE}/actions/`)) return false;
  const service = context.desktopPackageActionsService;
  if (!service || typeof service.status !== 'function' || typeof service.activate !== 'function'
    || typeof service.deactivate !== 'function') {
    throw new ContractError('desktop_configuration_unavailable', 'Native desktop package actions are unavailable.');
  }
  if (path === BASE) {
    requireIntegrationPermission(context.principal, READ);
    if (request.method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
    if (context.url.search) throw invalid();
    return sendBounded(response, projectAction(await service.status(), 'status', 'not_applied', false));
  }
  const action = path === `${BASE}/actions/activate` ? 'activate'
    : path === `${BASE}/actions/deactivate` ? 'deactivate' : null;
  if (!action) return send(response, 404, { error: 'not_found' });
  requireIntegrationPermission(context.principal, MANAGE);
  if (request.method !== 'POST') return send(response, 405, { error: 'method_not_allowed' });
  if (context.url.search) throw invalid();
  const body = await readRootBody(request);
  const value = action === 'activate'
    ? await service.activate(body.root) : await service.deactivate(body.root);
  return sendBounded(response, projectAction(value, action,
    action === 'activate' ? 'registered_root' : 'unregistered_root', true));
}

export function createDesktopPackageActionsService({ rootPath, configPath, installationId, dataId }) {
  if (typeof configPath !== 'string' || !configPath) throw invalid();
  // The CLI passes the owning data root with the registry path; the surface
  // keeps that pair so install transactions are excluded exactly as before.
  const paths = Object.freeze({ ...(typeof rootPath === 'string' && rootPath ? { root: rootPath } : {}), config: configPath });
  return Object.freeze({
    async status() {
      return { installationId, dataId, value: await runDesktopPackageCommand(['status'], paths) };
    },
    async activate(root) {
      return { installationId, dataId, operationId: randomUUID(),
        value: await runDesktopPackageCommand(['activate', root], paths) };
    },
    async deactivate(root) {
      return { installationId, dataId, operationId: randomUUID(),
        value: await runDesktopPackageCommand(['deactivate', root], paths) };
    },
  });
}

export function projectAction(record, action, application, withOperationId = false) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(record.installationId ?? '')
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(record.dataId ?? '')) throw projection();
  const keys = new Set(Object.keys(record));
  const legal = withOperationId
    ? new Set(['dataId', 'installationId', 'operationId', 'value'])
    : new Set(['dataId', 'installationId', 'value']);
  if (keys.size !== legal.size || [...keys].some(key => !legal.has(key))) throw projection();
  if (withOperationId && !/^[0-9a-f-]{36}$/u.test(record.operationId ?? '')) throw projection();
  const value = record.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value.registered !== true && value.registered !== false)) throw projection();
  const variants = new Set(Object.keys(value));
  if (value.registered === false) {
    if (variants.size !== 1 || action === 'activate') throw projection();
    return { schema_version: '1.0', installation_id: record.installationId, data_id: record.dataId,
      scope: 'user', action, application,
      ...(withOperationId ? { operation_id: record.operationId } : {}), package: { registered: false } };
  }
  // Registry stories carry {registered,valid,root,version} plus reason only
  // when the CLI itself judged the registered ROOT invalid on a status read.
  if ((variants.size !== 4 && variants.size !== 5)
    || !['registered', 'valid', 'root', 'version'].every(key => variants.has(key))
    || (variants.has('reason') && (variants.size !== 5 || value.valid !== false))) throw projection();
  if ((value.valid !== true && value.valid !== false)
    || typeof value.root !== 'string' || value.root.length < 1 || value.root.length > 1024
    || /[\x00-\x1f\x7f]/u.test(value.root)
    || !/^\d{8}-\d{1,6}$/u.test(value.version)) throw projection();
  if (action === 'activate' && value.valid !== true) throw projection();
  if (variants.has('reason') && (typeof value.reason !== 'string'
    || !/^[a-z][a-z0-9_]{0,63}$/u.test(value.reason))) throw projection();
  return { schema_version: '1.0', installation_id: record.installationId, data_id: record.dataId,
    scope: 'user', action, application,
    ...(withOperationId ? { operation_id: record.operationId } : {}),
    package: { registered: true, root: value.root, version: value.version, valid: value.valid,
      ...(variants.has('reason') ? { reason: value.reason } : {}) } };
}

function sendBounded(response, value) {
  if (Buffer.byteLength(JSON.stringify(value)) > RESPONSE_BYTES) throw projection();
  return send(response, 200, value);
}

/** activate/deactivate carry exactly {root}; nothing else may ride the action. */
async function readRootBody(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > REQUEST_BYTES) throw new ContractError('request_too_large', 'desktop package action request exceeds its size bound');
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 1
    || typeof parsed.root !== 'string' || parsed.root.length < 1 || parsed.root.length > 1024
    || !parsed.root.trim()) throw invalid();
  return parsed;
}
