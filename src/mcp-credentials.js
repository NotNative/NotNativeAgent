// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ContractError } from './ids.js';
import { SessionLock } from './persistence/session-lock.js';

const PREFIX = 'NNA_MCP_MANAGED_';
const MAX_FILE_BYTES = 1_048_576;
const MAX_CREDENTIALS = 256;
const MAX_TOKEN_LENGTH = 16_384;
const LOCK_ATTEMPTS = 200;
const LOCK_RETRY_MS = 10;
const PATH_TAILS = new Map();
const ERROR = Object.freeze({
  full: 'mcp_credentials_full', invalidStore: 'mcp_credentials_invalid', invalidToken: 'mcp_token_invalid',
});

export function managedMcpCredentialReference(serverId) {
  const stem = String(serverId).toUpperCase().replaceAll(/[^A-Z0-9]+/gu, '_').replaceAll(/^_+|_+$/gu, '').slice(0, 40) || 'SERVER';
  const digest = createHash('sha256').update(String(serverId)).digest('hex').slice(0, 12).toUpperCase();
  return `${PREFIX}${stem}_${digest}_TOKEN`;
}

export function isManagedMcpCredentialReference(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export async function saveManagedMcpCredential(paths, serverId, token, environment = process.env) {
  validateToken(token);
  const reference = managedMcpCredentialReference(serverId);
  return mutateStore(paths.mcpCredentials, async (document) => {
    const credentials = { ...document.credentials, [reference]: token };
    if (Object.keys(credentials).length > MAX_CREDENTIALS) {
      throw new ContractError(ERROR.full, 'MCP credential store reached its entry limit');
    }
    const previous = environmentSnapshot(environment, reference);
    try {
      environment[reference] = token;
      await persistStore(paths.mcpCredentials, credentials);
      return reference;
    } catch (error) {
      restoreEnvironment(environment, reference, previous);
      throw error;
    }
  });
}

export async function deleteManagedMcpCredential(paths, reference, environment = process.env) {
  if (!isManagedMcpCredentialReference(reference)) return false;
  return mutateStore(paths.mcpCredentials, async (document) => {
    if (!Object.hasOwn(document.credentials, reference)) return false;
    const credentials = { ...document.credentials };
    delete credentials[reference];
    const previous = environmentSnapshot(environment, reference);
    try {
      delete environment[reference];
      await persistStore(paths.mcpCredentials, credentials);
      return true;
    } catch (error) {
      restoreEnvironment(environment, reference, previous);
      throw error;
    }
  });
}

export async function loadManagedMcpCredentials(paths, environment = process.env) {
  const document = await readStore(paths.mcpCredentials);
  const entries = Object.entries(document.credentials);
  for (const [reference, token] of entries) {
    if (!isManagedMcpCredentialReference(reference)) throw invalidStore();
    validateToken(token, ERROR.invalidStore);
  }
  const applied = [];
  try {
    for (const [reference, token] of entries) {
      if (environment[reference] !== undefined) continue;
      environment[reference] = token;
      applied.push(reference);
    }
  } catch (error) {
    for (const reference of applied) delete environment[reference];
    throw error;
  }
  return entries.length;
}

async function readStore(path) {
  let bytes;
  try { bytes = await readFile(path); } catch (error) {
    if (error.code === 'ENOENT') return { format_version: 1, credentials: {} };
    throw error;
  }
  if (bytes.length > MAX_FILE_BYTES) throw invalidStore();
  let document;
  try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (error) { throw invalidStore(error); }
  if (document?.format_version !== 1 || !document.credentials || typeof document.credentials !== 'object' || Array.isArray(document.credentials)) throw invalidStore();
  if (Object.keys(document.credentials).length > MAX_CREDENTIALS) throw invalidStore();
  return document;
}

async function persistStore(path, credentials) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify({ format_version: 1, credentials }, null, 2)}\n`, {
      flag: 'wx', mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function validateToken(token, code = ERROR.invalidToken) {
  if (typeof token !== 'string' || token.length < 1 || token.length > MAX_TOKEN_LENGTH || /[\r\n\u0000]/u.test(token)) {
    throw new ContractError(code, 'MCP token must contain 1-16384 characters without line breaks');
  }
}

function invalidStore(cause) {
  return new ContractError(ERROR.invalidStore, 'MCP credential store has an unsupported or invalid shape',
    cause ? { cause } : undefined);
}

async function mutateStore(path, operation) {
  const prior = PATH_TAILS.get(path) ?? Promise.resolve();
  let releaseTurn;
  const turn = new Promise((resolveTurn) => { releaseTurn = resolveTurn; });
  PATH_TAILS.set(path, turn);
  await prior;
  const lock = new SessionLock(dirname(path), 'mcp-credentials');
  try {
    await acquireStoreLock(lock);
    return await operation(await readStore(path));
  } finally {
    try { await lock.release(); }
    finally {
      releaseTurn();
      if (PATH_TAILS.get(path) === turn) PATH_TAILS.delete(path);
    }
  }
}

async function acquireStoreLock(lock) {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try { await lock.acquire(); return; }
    catch (error) {
      if (error?.code !== 'session_locked') throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
    }
  }
  throw new ContractError('mcp_credentials_busy', 'MCP credential store remained busy');
}

function environmentSnapshot(environment, reference) {
  return Object.freeze({ present: Object.hasOwn(environment, reference), value: environment[reference] });
}

function restoreEnvironment(environment, reference, previous) {
  if (previous.present) environment[reference] = previous.value;
  else delete environment[reference];
}
