// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const stageOperationId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const identity = { data_root: 'C:/private', installation_id: 'nna_selected', data_id: 'data_selected' };

async function harness(overrides = {}) {
  const source = await readFile(new URL('../src/nnd-activation-cli.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import .*?;\r?\n/gmu, '').replaceAll('export async function ', 'async function ');
  const trace = [];
  const lease = { close: async () => { trace.push('close'); } };
  const dependencies = {
    join: (...parts) => parts.join('/'),
    ContractError: class ContractError extends Error { constructor(code, message) { super(message); this.code = code; } },
    acquireNndServiceLock: async () => { trace.push('lease'); return lease; },
    withManifestLock: async (_path, _options, operation) => { trace.push('registry'); return operation({}); },
    readNndActivationCandidate: async () => { trace.push('candidate'); return { evidence: {
      version: '20261003-1', payload_sha256: 'a'.repeat(64), }, evidence_sha256: 'b'.repeat(64) }; },
    recoverNndActivationPreparation: async () => { trace.push('recover'); return { state: 'prepared' }; },
    operationValid: value => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value ?? ''),
    assertNoNndInstallMarker: async () => { trace.push('marker'); },
    assertNoNndInstallTransaction: async () => { trace.push('transaction'); },
    assertNoNndMigration: async () => { trace.push('migration'); },
    scanNndLegacyOwners: async () => { trace.push('census'); },
    ...overrides,
  };
  const api = Function(...Object.keys(dependencies), `${executable}\nreturn { preflightNndActivation, recoverNndActivationPreparationCommand };`)
    (...Object.values(dependencies));
  return { ...api, trace };
}

test('preflight requires two distinct exact UUIDs before acquiring a native owner', async () => {
  const f = await harness();
  for (const options of [{ stageOperationId, operationId: stageOperationId },
    { stageOperationId: 'bad', operationId }, { stageOperationId, operationId: 'bad' }]) {
    await assert.rejects(f.preflightNndActivation(identity, options), { code: 'nnd_activation_candidate_invalid' });
  }
  assert.deepEqual(f.trace, []);
});

test('preflight verifies selected slot under genuine owners and returns only candidate state', async () => {
  const f = await harness();
  const result = await f.preflightNndActivation(identity, { stageOperationId, operationId });
  assert.deepEqual(f.trace, ['lease', 'marker', 'transaction', 'migration', 'census', 'registry', 'candidate', 'close']);
  assert.deepEqual(result, { state: 'slot_ready', operation_id: operationId, stage_operation_id: stageOperationId,
    installation_id: identity.installation_id, data_id: identity.data_id, version: '20261003-1',
    payload_sha256: 'a'.repeat(64), candidate_sha256: 'b'.repeat(64) });
});

test('unknown candidate outcome closes owned lease and never reports readiness', async () => {
  const f = await harness({ readNndActivationCandidate: async () => { throw new Error('changed slot'); } });
  await assert.rejects(f.preflightNndActivation(identity, { stageOperationId, operationId }), /changed slot/u);
  assert.deepEqual(f.trace, ['lease', 'marker', 'transaction', 'migration', 'census', 'registry', 'close']);
});

test('unfinished native install or activation evidence bars slot readiness', async () => {
  const trace = [];
  const f = await harness({ assertNoNndInstallTransaction: async () => {
    trace.push('transaction');
    throw new Error('pending initialization');
  } });
  await assert.rejects(f.preflightNndActivation(identity, { stageOperationId, operationId }),
    /pending initialization/u);
  assert.deepEqual(trace, ['transaction']);
  assert.deepEqual(f.trace, ['lease', 'marker', 'close']);
});

test('preparation recovery requires an exact UUID and never calls public activation', async () => {
  const f = await harness();
  await assert.rejects(f.recoverNndActivationPreparationCommand(identity, { operationId: 'bad' }),
    { code: 'nnd_activation_candidate_invalid' });
  assert.deepEqual(await f.recoverNndActivationPreparationCommand(identity, { operationId }), { state: 'prepared' });
  assert.deepEqual(f.trace, ['recover']);
});
