// SPDX-License-Identifier: Apache-2.0
// ADR 0065/0066: a canonical terminal commit + cleared witness pair, bound to
// this installation and data identity, is a consumed admission receipt. Half
// pairs, altered pairs, and foreign identities must keep the bar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { hasActivationEvidence } from '../src/nnd-activation-initialization-db.js';
import { assertNoNndInstallTransaction, hash } from '../src/nnd-install-storage.js';

const windows = { skip: process.platform !== 'win32' };
const uuid = () => randomUUID();
async function fixture(t) {
  const root = await mkdtemp(join(homedir(), '.nnd-ev-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  await mkdir(join(data, 'runtime', 'nnd', 'install-slots'), { recursive: true });
  return { data, slots: join(data, 'runtime', 'nnd', 'install-slots') };
}
function pair(installationId, dataId) {
  const commit = { protocol: '1.0', state: 'terminal_committed_barred', operation_id: uuid(),
    stage_operation_id: uuid(), installation_id: installationId, data_id: dataId, generation: uuid(),
    plan_sha256: '1'.repeat(64), decision_sha256: '2'.repeat(64), completion_sha256: '3'.repeat(64),
    marker_sha256: '4'.repeat(64), registration_revision: '5'.repeat(64), discovery_sha256: '6'.repeat(64),
    child_process_identity: { version: 1, start_id: '1', pid: process.pid, platform: 'win32' } };
  return { commit, witness: { ...commit, state: 'barriers_cleared_admission_barred' } };
}
async function writePair(slots, commit, witness) {
  const commitBytes = Buffer.from(JSON.stringify(commit) + '\n');
  witness.terminal_sha256 = hash(commitBytes);
  await writeFile(join(slots, 'activation-retirement-commit.json'), commitBytes);
  await writeFile(join(slots, 'activation-retirement-cleared.json'),
    Buffer.from(JSON.stringify(witness) + '\n'));
  return commitBytes;
}
const identityFor = (installation_id, data_root) => ({ installation_id,
  data_id: 'data_' + 'a'.repeat(64), ...(data_root ? { data_root } : {}) });

test('canonical commit+witness pair bound to identity is a consumed admission receipt', windows, async t => {
  const { data, slots } = await fixture(t);
  const identity = identityFor('nna_' + 'b'.repeat(64), data);
  const { commit, witness } = pair(identity.installation_id, identity.data_id);
  await writePair(slots, commit, witness);
  assert.equal(await hasActivationEvidence(data, identity), false);
  await assertNoNndInstallTransaction(identity);
  // Either file alone keeps the bar (ADR 0065).
  await rm(join(slots, 'activation-retirement-cleared.json'));
  assert.equal(await hasActivationEvidence(data, identity), true);
  await assert.rejects(assertNoNndInstallTransaction(identity), { code: 'nnd_install_transaction_pending' });
});
test('witness without commit, altered witness, and foreign identity keep the bar', windows, async t => {
  const { data, slots } = await fixture(t);
  const identity = identityFor('nna_' + 'b'.repeat(64));
  // Witness present, commit missing.
  const first = pair(identity.installation_id, identity.data_id);
  await writePair(slots, first.commit, first.witness);
  await rm(join(slots, 'activation-retirement-commit.json'));
  assert.equal(await hasActivationEvidence(data, identity), true);
  // Altered witness breaks the canonical hash relation to the commit bytes.
  await rm(join(slots, 'activation-retirement-cleared.json'));
  const second = pair(identity.installation_id, identity.data_id);
  await writePair(slots, second.commit, second.witness);
  await writeFile(join(slots, 'activation-retirement-cleared.json'),
    Buffer.from(JSON.stringify({ ...second.witness, terminal_sha256: '9'.repeat(64) }) + '\n'));
  assert.equal(await hasActivationEvidence(data, identity), true);
  // A pair bound to a different installation keeps the bar.
  await writePair(slots, second.commit, second.witness);
  assert.equal(await hasActivationEvidence(data, identity), false);
  assert.equal(await hasActivationEvidence(data, identityFor('nna_' + 'c'.repeat(64))), true);
});
