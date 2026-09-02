// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRegisteredFailureCode } from '../src/error-code-registry.js';
import { failureEnvelope } from '../src/failure-envelope.js';
import { ContractError } from '../src/ids.js';

const SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url));

function classified(code, operation = 'turn') {
  return failureEnvelope(new ContractError(code, 'bounded failure'), { operation });
}

test('failure taxonomy gives qualified provider codes provider ownership', () => {
  assert.deepEqual(
    ['provider_event_invalid', 'provider_usage_invalid'].map((code) => {
      const failure = classified(code);
      return [failure.category, failure.boundary];
    }),
    [['provider', 'provider'], ['provider', 'provider']],
  );
});

test('streamed tool identity drift belongs to the provider boundary', () => {
  const failure = classified('tool_identity_drift');
  assert.equal(failure.category, 'provider');
  assert.equal(failure.boundary, 'provider');
});

test('failure taxonomy separates lifecycle category from component boundary', () => {
  const provider = classified('provider_timeout');
  assert.equal(provider.category, 'timeout');
  assert.equal(provider.boundary, 'provider');
  const tool = classified('tool_cancelled');
  assert.equal(tool.category, 'cancelled');
  assert.equal(tool.boundary, 'tool');
});

test('bounded dynamic error selections resolve through exact registrations', () => {
  assert.deepEqual(
    ['provider_transient', 'mcp_credentials_invalid', 'secret_vault_corrupt', 'browser_action_failed']
      .map((code) => [classified(code).category, classified(code).boundary]),
    [['provider', 'provider'], ['mcp', 'mcp'], ['authorization', 'permission'], ['tool', 'tool']],
  );
});

test('failure taxonomy classifies named domains without substring collisions', () => {
  assert.equal(classified('tool_schema_invalid').category, 'tool');
  assert.equal(classified('reviewer_output_malformed').category, 'authorization');
  assert.equal(classified('journal_corrupt').category, 'persistence');
  assert.equal(classified('invalid_manifest').category, 'contract');
  assert.equal(classified('unrelated_providerish_invalidity').category, 'internal');
});

test('unregistered domain-like codes fail closed instead of inheriting ownership from their prefix', () => {
  const failure = classified('file_future_classification');
  assert.equal(failure.category, 'internal');
  assert.equal(failure.boundary, 'turn');
});

test('every literal ContractError code has explicit registry ownership', async () => {
  const pending = [SOURCE_ROOT]; const files = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
    }
  }
  const missing = new Set();
  const literalCode = /new\s+ContractError\s*\(\s*(['"])(?<code>[a-z][a-z0-9_]+)\1/gu;
  for (const path of files.sort()) {
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(literalCode)) {
      if (!isRegisteredFailureCode(match.groups.code)) missing.add(match.groups.code);
    }
  }
  assert.deepEqual([...missing].sort(), []);
});
