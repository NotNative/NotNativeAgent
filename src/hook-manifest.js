// SPDX-License-Identifier: Apache-2.0
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';

const SUBSCRIPTIONS = new Set([
  'session.start:post', 'session.end:pre', 'turn:pre', 'turn:post',
  'tool.call:pre', 'tool.call:post', 'compaction:pre', 'compaction:post',
  'maintenance:idle',
]);
const MAX_BUNDLES = 32;
const MAX_SUBSCRIPTIONS = 64;
const MAX_MANIFEST_BYTES = 131_072;

export async function discoverHookBundles(root) {
  const bundles = [];
  const diagnostics = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { bundles, diagnostics };
    throw error;
  }
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name)).slice(0, MAX_BUNDLES);
  for (const entry of directories) {
    try {
      bundles.push(await loadBundle(root, entry.name));
    } catch (error) {
      diagnostics.push(Object.freeze({ bundle: entry.name, status: 'skipped', code: error.code ?? 'invalid_hook_bundle' }));
    }
  }
  return { bundles: Object.freeze(bundles), diagnostics: Object.freeze(diagnostics) };
}

async function loadBundle(root, directoryName) {
  const directory = resolve(root, directoryName);
  const path = join(directory, 'manifest.json');
  const text = await readBounded(path);
  let value;
  try { value = JSON.parse(text); } catch { throw new ContractError('invalid_hook_manifest', 'hook manifest must be JSON'); }
  return validateBundle(value, directory, directoryName);
}

async function readBounded(path) {
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new ContractError('hook_manifest_too_large', 'hook manifest exceeds the size limit');
  }
  return text;
}

function validateBundle(value, directory, directoryName) {
  if (!record(value) || !safeName(value.name) || typeof value.version !== 'string') {
    throw new ContractError('invalid_hook_manifest', 'hook manifest identity is invalid');
  }
  if (!Array.isArray(value.subscriptions) || value.subscriptions.length > MAX_SUBSCRIPTIONS) {
    throw new ContractError('invalid_hook_manifest', 'hook subscriptions are invalid or excessive');
  }
  const subscriptions = value.subscriptions.map((item, index) => validateSubscription(item, index));
  return Object.freeze({
    name: value.name, version: value.version.slice(0, 64), directory,
    directoryName, subscriptions: Object.freeze(subscriptions),
  });
}

function validateSubscription(value, index) {
  if (!record(value) || !SUBSCRIPTIONS.has(`${value.event}:${value.phase}`)) {
    throw new ContractError('invalid_hook_subscription', `hook subscription ${index} has an unsupported event or phase`);
  }
  if (typeof value.command !== 'string' || value.command.length === 0 || value.command.length > 1024) {
    throw new ContractError('invalid_hook_command', `hook subscription ${index} requires a bounded command`);
  }
  return Object.freeze({
    event: value.event, phase: value.phase, command: value.command,
    blocking: value.blocking !== false,
    priority: boundedInteger(value.priority, 100, -100_000, 100_000),
    timeoutMs: boundedInteger(value.timeout_ms, 10_000, 100, 300_000),
    maxConcurrent: boundedInteger(value.max_concurrent, 1, 1, 16),
  });
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ContractError('invalid_hook_limit', `hook limit must be from ${minimum} to ${maximum}`);
  }
  return value;
}

function safeName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value);
}

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
