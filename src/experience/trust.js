// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ContractError } from '../ids.js';
import { SessionLock } from '../persistence/session-lock.js';

const MAX_TRUST_FILE_BYTES = 262_144;
const MAX_TRUSTED_WORKSPACES = 1024;
const LOCK_ATTEMPTS = 200;
const LOCK_RETRY_MS = 10;
const PATH_TAILS = new Map();

export async function workspaceIsTrusted(path, root) {
  let canonical;
  try { canonical = await canonicalRoot(root, true); }
  catch (error) {
    if (error.code === 'workspace_trust_target_missing') return false;
    throw error;
  }
  const records = await loadTrust(path);
  for (const item of records) {
    if (resolve(item.root) === canonical) return true;
  }
  return false;
}

export async function trustWorkspace(path, root) {
  const canonical = await canonicalRoot(root, true);
  return mutateTrust(path, async () => {
    const records = await loadTrust(path);
    let equivalent = false;
    for (const item of records) {
      if (resolve(item.root) === canonical) {
        equivalent = true;
        item.root = canonical;
      }
    }
    if (!equivalent) records.push({ root: canonical, trustedAt: new Date().toISOString() });
    records.sort((left, right) => left.root.localeCompare(right.root));
    await atomicWrite(path, { version: 1, workspaces: records });
    return Object.freeze({ root: canonical, trusted: true });
  });
}

export async function untrustWorkspace(path, root) {
  const canonical = await canonicalRoot(root);
  return mutateTrust(path, async () => {
    const records = (await loadTrust(path)).filter((item) => resolve(item.root) !== canonical);
    await atomicWrite(path, { version: 1, workspaces: records });
    return Object.freeze({ root: canonical, trusted: false });
  });
}

async function canonicalRoot(root, required = false) {
  const absolute = resolve(root);
  try { return await realpath(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!required) return absolute;
    throw new ContractError('workspace_trust_target_missing', 'workspace trust requires an existing path');
  }
}

async function loadTrust(path) {
  try {
    const bytes = await readFile(path);
    if (bytes.length > MAX_TRUST_FILE_BYTES) {
      throw new ContractError('workspace_trust_invalid', 'workspace trust file exceeds bound');
    }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (value?.version !== 1 || !Array.isArray(value.workspaces)
      || value.workspaces.length > MAX_TRUSTED_WORKSPACES
      || value.workspaces.some((item) => !item || typeof item.root !== 'string'
        || typeof item.trustedAt !== 'string')) throw new Error('shape');
    return value.workspaces;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    if (error instanceof ContractError) throw error;
    throw new ContractError('workspace_trust_invalid', 'workspace trust file has invalid JSON, encoding, or schema');
  }
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function mutateTrust(path, operation) {
  const prior = PATH_TAILS.get(path) ?? Promise.resolve();
  let releaseTurn;
  const turn = new Promise((resolveTurn) => { releaseTurn = resolveTurn; });
  PATH_TAILS.set(path, turn);
  await prior;
  const lock = new SessionLock(dirname(path), 'workspace-trust');
  try {
    await acquireTrustLock(lock);
    return await operation();
  } finally {
    try { await lock.release(); }
    finally {
      releaseTurn();
      if (PATH_TAILS.get(path) === turn) PATH_TAILS.delete(path);
    }
  }
}

async function acquireTrustLock(lock) {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try { await lock.acquire(); return; }
    catch (error) {
      if (error?.code !== 'session_locked') throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
    }
  }
  throw new ContractError('workspace_trust_busy', 'workspace trust store remained busy');
}
