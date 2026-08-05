// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ContractError } from './ids.js';

const PREFIX = 'NNA_MCP_MANAGED_';
const MAX_FILE_BYTES = 1_048_576;
const MAX_CREDENTIALS = 256;
const MAX_TOKEN_LENGTH = 16_384;

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
  const document = await readStore(paths.mcpCredentials);
  const reference = managedMcpCredentialReference(serverId);
  const credentials = { ...document.credentials, [reference]: token };
  if (Object.keys(credentials).length > MAX_CREDENTIALS) throw new ContractError('mcp_credentials_full', 'MCP credential store reached its entry limit');
  await persistStore(paths.mcpCredentials, credentials);
  environment[reference] = token;
  return reference;
}

export async function deleteManagedMcpCredential(paths, reference, environment = process.env) {
  if (!isManagedMcpCredentialReference(reference)) return false;
  const document = await readStore(paths.mcpCredentials);
  if (!Object.hasOwn(document.credentials, reference)) return false;
  const credentials = { ...document.credentials };
  delete credentials[reference];
  await persistStore(paths.mcpCredentials, credentials);
  delete environment[reference];
  return true;
}

export async function loadManagedMcpCredentials(paths, environment = process.env) {
  const document = await readStore(paths.mcpCredentials);
  let count = 0;
  for (const [reference, token] of Object.entries(document.credentials)) {
    if (!isManagedMcpCredentialReference(reference)) throw invalidStore();
    validateToken(token, 'mcp_credentials_invalid');
    if (environment[reference] === undefined) environment[reference] = token;
    count += 1;
  }
  return count;
}

async function readStore(path) {
  let bytes;
  try { bytes = await readFile(path); } catch (error) {
    if (error.code === 'ENOENT') return { format_version: 1, credentials: {} };
    throw error;
  }
  if (bytes.length > MAX_FILE_BYTES) throw invalidStore();
  let document;
  try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalidStore(); }
  if (document?.format_version !== 1 || !document.credentials || typeof document.credentials !== 'object' || Array.isArray(document.credentials)) throw invalidStore();
  if (Object.keys(document.credentials).length > MAX_CREDENTIALS) throw invalidStore();
  return document;
}

async function persistStore(path, credentials) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ format_version: 1, credentials }, null, 2)}\n`, { mode: 0o600 });
}

function validateToken(token, code = 'mcp_token_invalid') {
  if (typeof token !== 'string' || token.length < 1 || token.length > MAX_TOKEN_LENGTH || /[\r\n\u0000]/u.test(token)) {
    throw new ContractError(code, 'MCP token must contain 1-16384 characters without line breaks');
  }
}

function invalidStore() {
  return new ContractError('mcp_credentials_invalid', 'MCP credential store has an unsupported or invalid shape');
}
