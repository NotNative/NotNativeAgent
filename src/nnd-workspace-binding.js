// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { ContractError } from './ids.js';

const KEYS = ['root', 'configured_root', 'id', 'device', 'inode'];
const mismatch = () => new ContractError('nnd_workspace_binding_invalid', 'NND session workspace binding does not match the native primary workspace.');
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

export async function primaryNndWorkspaceBinding(configuredRoot) {
  if (typeof configuredRoot !== 'string' || !isAbsolute(configuredRoot) || configuredRoot.length > 4096
    || /[\u0000-\u001f\u007f]/u.test(configuredRoot) || configuredRoot.startsWith('\\\\')
    || !same(resolve(configuredRoot), configuredRoot)) throw mismatch();
  try {
    for (let cursor = configuredRoot; ; cursor = dirname(cursor)) {
      const info = await lstat(cursor, { bigint: true });
      if (info.isSymbolicLink()) throw mismatch();
      if (cursor === parse(cursor).root) break;
    }
    const root = await realpath(configuredRoot);
    const info = await lstat(root, { bigint: true });
    if (!same(root, configuredRoot) || !info.isDirectory() || info.isSymbolicLink() || info.ino === 0n) throw mismatch();
    const id = `ws_${createHash('sha256').update(configuredRoot).digest('hex').slice(0, 24)}`;
    return Object.freeze({ root, configured_root: configuredRoot, id, device: String(info.dev), inode: String(info.ino) });
  } catch { throw mismatch(); }
}

export function assertPrimaryNndWorkspaceBinding(binding, principal, directory, expected, restoring) {
  assertSameNndWorkspaceBinding(binding, expected);
  if (!Array.isArray(principal?.workspaceIds) || !principal.workspaceIds.includes(expected.id)) throw mismatch();
  if (restoring ? directory !== expected.configured_root
    : directory !== undefined && directory !== expected.configured_root) throw mismatch();
  return expected;
}

function assertSameNndWorkspaceBinding(binding, expected) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || Object.keys(binding).length !== KEYS.length || KEYS.some(key => !Object.hasOwn(binding, key))
    || !expected || KEYS.some(key => binding[key] !== expected[key])) throw mismatch();
}

// Security: a captured native identity, not the mutable working-directory string,
// controls both tool sealing and the final handoff to an executor.
export function nndToolWorkspaceIdentityCheck(engine, binding, resolver) {
  if (!binding) return null;
  if (typeof resolver !== 'function') throw mismatch();
  const captured = Object.freeze({ ...binding });
  return async () => {
    assertBoundEngineWorkspace(engine, captured);
    let current;
    try { current = await resolver(captured.id); } catch { throw mismatch(); }
    assertSameNndWorkspaceBinding(captured, current);
    assertBoundEngineWorkspace(engine, captured);
  };
}

export function assertLegacyNndWorkspaceBinding(principal, directory, expected) {
  if (!Array.isArray(principal?.workspaceIds) || principal.workspaceIds.length !== 1
    || principal.workspaceIds[0] !== expected.id || directory !== expected.configured_root) throw mismatch();
  return expected;
}

export async function preflightNndWorkspaceCatalog(records, resolver, validRecord) {
  if (!resolver) return;
  for (const record of records) {
    if (!validRecord(record)) throw new ContractError('nnd_catalog_invalid', 'NND session catalog is invalid');
    const principal = { workspaceIds: record.workspaceIds };
    const expected = await resolver(record.workspaceBinding?.id);
    if (record.workspaceBinding === undefined) assertLegacyNndWorkspaceBinding(principal, record.directory, expected);
    else assertPrimaryNndWorkspaceBinding(record.workspaceBinding, principal, record.directory, expected, true);
  }
}

export async function resolveContextBinding(resolver, principal, options, restoring) {
  if (!resolver) return null;
  const selectedId = restoring ? options.workspaceBinding?.id : options.workspace_id;
  const binding = await resolver(selectedId);
  if (restoring && options.workspaceBinding === undefined) {
    assertLegacyNndWorkspaceBinding(principal, options.directory, binding);
  } else {
    assertPrimaryNndWorkspaceBinding(options.workspaceBinding ?? binding, principal, options.directory, binding, restoring);
  }
  return binding;
}

export function assertBoundEngineWorkspace(engine, binding) {
  if (binding && engine.config?.workspaceRoot !== binding.configured_root) throw mismatch();
}

export async function recheckContextBinding(resolver, binding, principal, options, restoring) {
  if (!binding) return;
  assertPrimaryNndWorkspaceBinding(binding, principal, options.directory, await resolver(binding.id), restoring);
}

export async function assertLiveNndWorkspaceBinding(context, resolver, principal, currentContext) {
  if (!context.workspaceBinding) return;
  await recheckContextBinding(resolver, context.workspaceBinding, principal,
    { directory: context.directory }, true);
  if (currentContext() !== context) {
    throw new ContractError('nnd_session_unavailable', 'NND session context is unavailable');
  }
  assertBoundEngineWorkspace(context.engine, context.workspaceBinding);
}

export async function initializeBoundEngine(engine, resolver, binding, principal, options, restoring) {
  assertBoundEngineWorkspace(engine, binding);
  await engine.initialize();
  // Security: durable journal replay can change the engine root during initialize().
  assertBoundEngineWorkspace(engine, binding);
  await recheckContextBinding(resolver, binding, principal, options, restoring);
}
