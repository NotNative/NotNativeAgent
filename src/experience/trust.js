// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ContractError } from '../ids.js';

export async function workspaceIsTrusted(path, root) {
  const canonical = await canonicalRoot(root);
  const records = await loadTrust(path);
  for (const item of records) {
    if (await canonicalRoot(item.root) === canonical) return true;
  }
  return false;
}

export async function trustWorkspace(path, root) {
  const canonical = await canonicalRoot(root);
  const records = await loadTrust(path);
  let equivalent = false;
  for (const item of records) {
    if (await canonicalRoot(item.root) === canonical) {
      equivalent = true;
      item.root = canonical;
    }
  }
  if (!equivalent) {
    records.push({ root: canonical, trustedAt: new Date().toISOString() });
  }
  records.sort((left, right) => left.root.localeCompare(right.root));
  await atomicWrite(path, { version: 1, workspaces: records });
  return Object.freeze({ root: canonical, trusted: true });
}

export async function untrustWorkspace(path, root) {
  const canonical = await canonicalRoot(root);
  const records = [];
  for (const item of await loadTrust(path)) {
    if (await canonicalRoot(item.root) !== canonical) records.push(item);
  }
  await atomicWrite(path, { version: 1, workspaces: records });
  return Object.freeze({ root: canonical, trusted: false });
}

async function canonicalRoot(root) {
  const absolute = resolve(root);
  try { return await realpath(absolute); }
  catch (error) { if (error.code === 'ENOENT') return absolute; throw error; }
}

async function loadTrust(path) {
  try {
    const bytes = await readFile(path);
    if (bytes.length > 262_144) throw new ContractError('workspace_trust_invalid', 'workspace trust file exceeds bound');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (value?.version !== 1 || !Array.isArray(value.workspaces) || value.workspaces.length > 1024) throw new Error('shape');
    return value.workspaces.filter((item) => item && typeof item.root === 'string' && typeof item.trustedAt === 'string');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    if (error instanceof ContractError) throw error;
    throw new ContractError('workspace_trust_invalid', 'workspace trust file is not valid UTF-8 JSON');
  }
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
