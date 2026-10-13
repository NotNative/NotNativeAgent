// SPDX-License-Identifier: Apache-2.0
/** NND operator client for the native NND package actions (20261006-12
 * surface). The runtime reuses the CLI registry authority (runNndPackageCommand)
 * verbatim: status reads the installed-package registry, activate validates a
 * package root through the manifest transaction and registers it, deactivate
 * unregisters the matching root. The registry carries root/version/protocol
 * only; no GUI artifact content ever leaves the runtime. */
import { runtimeFetch } from '../runtime-fetch.ts';

const BASE = '/api/v1/nnd/configuration/nnd-package';
const RESPONSE_BYTES = 65536;
const PACKAGE_VERSION = /^\d{8}-\d{1,6}$/u;

export class NativePackageActionFailure extends Error {
  code: string;
  constructor(code: string) { super(code); this.name = 'NativePackageActionFailure'; this.code = code; }
}
const viewInvalid = () => new NativePackageActionFailure('nnd_package_projection_invalid');

export interface PackageStatus {
  registered: boolean;
  root: string | null; version: string | null; valid: boolean | null; reason: string | null;
}
export interface PackageActionReceipt {
  schemaVersion: '1.0'; installationId: string; dataId: string; scope: 'user';
  action: 'status' | 'activate' | 'deactivate';
  application: 'not_applied' | 'registered_root' | 'unregistered_root';
  operationId: string | null; package: PackageStatus;
}

const boundedText = (value: string, max = 1024) => value.length >= 1 && value.length <= max
  && !/[\x00-\x1f\x7f]/u.test(value);

/** The CLI's own verdict grammar; drift is refused rather than smoothed. */
function parsePackage(raw: unknown): PackageStatus {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw viewInvalid();
  const row = raw as Record<string, unknown>;
  const keys = Object.keys(row);
  if (row.registered === false) {
    if (keys.length !== 1) throw viewInvalid();
    return { registered: false, root: null, version: null, valid: null, reason: null };
  }
  if (row.registered !== true || keys.length !== 4 && keys.length !== 5) throw viewInvalid();
  const present = ['registered', 'valid', 'root', 'version'].every(key => key in row);
  if (!present || (keys.length === 5 && !('reason' in row))) throw viewInvalid();
  if ((row.valid !== true && row.valid !== false) || typeof row.root !== 'string'
    || !boundedText(row.root)
    || typeof row.version !== 'string' || !PACKAGE_VERSION.test(row.version)) throw viewInvalid();
  if (keys.length === 5 && (typeof row.reason !== 'string'
    || !/^[a-z][a-z0-9_]{0,63}$/u.test(row.reason as string))) throw viewInvalid();
  return { registered: true, root: row.root as string, version: row.version as string,
    valid: row.valid as boolean, reason: keys.length === 5 ? row.reason as string : null };
}

export function parsePackageReceipt(raw: unknown): PackageActionReceipt {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw viewInvalid();
  const row = raw as Record<string, unknown>;
  const actions = ['status', 'activate', 'deactivate'];
  const applications = ['not_applied', 'registered_root', 'unregistered_root'];
  const legal = ['schema_version', 'installation_id', 'data_id', 'scope', 'action',
    'application', 'operation_id', 'package'];
  const withOperation = row.action === 'activate' || row.action === 'deactivate';
  if (Object.keys(row).length !== 8) throw viewInvalid();
  if (legal.some(key => !(key in row)) || !(actions as string[]).includes(row.action as string)
    || !(applications as string[]).includes(row.application as string)) throw viewInvalid();
  if (row.schema_version !== '1.0' || row.scope !== 'user'
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(row.installation_id as string)
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(row.data_id as string)) throw viewInvalid();
  const expectedApplication = row.action === 'status' ? 'not_applied'
    : row.action === 'activate' ? 'registered_root' : 'unregistered_root';
  if (row.application !== expectedApplication) throw viewInvalid();
  if (withOperation) {
    if (typeof row.operation_id !== 'string' || !/^[0-9a-f-]{36}$/u.test(row.operation_id)) {
      throw viewInvalid();
    }
  } else if (row.operation_id !== null) throw viewInvalid();
  return { schemaVersion: '1.0', installationId: row.installation_id as string,
    dataId: row.data_id as string, scope: 'user', action: row.action as PackageActionReceipt['action'],
    application: row.application as PackageActionReceipt['application'],
    operationId: withOperation ? row.operation_id as string : null,
    package: parsePackage(row.package) };
}

async function call(path: string, status: number, method: 'GET' | 'POST',
  body: unknown, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await runtimeFetch(`${BASE}${path}`, { method,
      headers: { 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}) });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new NativePackageActionFailure('nnd_package_action_unavailable');
  }
  const raw = await response.arrayBuffer();
  if (raw.byteLength > RESPONSE_BYTES) throw viewInvalid();
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { throw viewInvalid(); }
  if (response.status === status) return parsed;
  const code = (parsed as { error?: { code?: string } } | null)?.error?.code;
  throw new NativePackageActionFailure(response.status === 404
    ? 'nnd_package_action_not_found'
    : typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(code)
      ? code : 'nnd_package_action_unavailable');
}

export function readPackageStatus(signal: AbortSignal): Promise<PackageActionReceipt> {
  return call('', 200, 'GET', undefined, signal).then(parsePackageReceipt);
}

export function activatePackageRoot(root: string, signal: AbortSignal): Promise<PackageActionReceipt> {
  return call('/actions/activate', 200, 'POST', { root }, signal).then(parsePackageReceipt);
}

/** The deactivate-roots lockstep with a mismatched root is a genuine 400. */
export function deactivatePackageRoot(root: string, signal: AbortSignal): Promise<PackageActionReceipt> {
  return call('/actions/deactivate', 200, 'POST', { root }, signal).then(parsePackageReceipt);
}

export function packageActionErrorText(code: string): string {
  const sentences: Record<string, string> = {
    nnd_package_root_invalid: 'The package root must be an absolute path to an installed NND package.',
    nnd_package_incomplete: 'That path is not a complete NND package: the manifest, server build, and web build are missing.',
    nnd_package_manifest_invalid: 'That NND package manifest is incompatible with this runtime protocol.',
    nnd_package_root_mismatch: 'The registered NND package root differs from the one given.',
    nnd_package_projection_invalid: 'The native package surface surfaced a drifted receipt.',
    nnd_configuration_unavailable: 'The native package actions are unavailable right now.',
    integration_permission_denied: 'The operator principal lacks nnd.package.manage.',
  };
  return sentences[code]
    ?? (code === 'nnd_package_action_not_found' ? 'The native package action surface is absent.'
      : code === 'nnd_package_action_unavailable'
        ? 'The native package action could not be completed.'
        : 'The package action could not be completed natively.');
}
