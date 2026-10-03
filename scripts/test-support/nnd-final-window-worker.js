// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ContractError } from '../../src/ids.js';
import { acquireNndServiceLock, assertHeldNndServiceLease, withNndServiceLease } from '../../src/nnd-service-lock.js';
import { withManifestLock } from '../../src/persistence/manifest-transaction.js';
import { assertManifestLease, runManifestLeaseWork } from '../../src/persistence/manifest-lock.js';
import { appendNndActivationPhase } from '../../src/nnd-activation-journal.js';
import { hash, json, writeInstallNew } from '../../src/nnd-install-storage.js';

const root = await realpath(process.argv[2]);
const sha = value => createHash('sha256').update(value).digest('hex');
const identity = { data_root: root, installation_id: `nna_${sha('final-window-test-install')}`,
  data_id: `data_${sha(root.toLowerCase())}` };
const operationId = process.argv[3], stageOperationId = process.argv[4];
const directory = join(root, 'runtime', 'nnd', 'install-slots', 'activations', operationId);
await mkdir(directory, { recursive: true });
await mkdir(join(root, 'config'), { recursive: true });
const lease = await acquireNndServiceLock({ dataRoot: root });
await withManifestLock(join(root, 'config', 'nnd-package.json'), {}, async registryLease => {
  const proof = { installation_id: identity.installation_id, data_id: identity.data_id,
    generation: randomUUID(), version: '20261003-23', native_state: 'ready', gui_http_status: 200 };
  const dependencies = { join, resolve, ContractError, assertHeldNndServiceLease, withNndServiceLease,
    assertManifestLease, runManifestLeaseWork,
    prepareNndActivationUnderOwnership: async () => {
      const prepared = await appendNndActivationPhase({ ...identity, operation_id: operationId }, directory,
        lease, registryLease, 'prepared', sha('candidate'));
      await writeInstallNew(join(root, 'runtime', 'nnd', 'installation-pending.json'),
        json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: operationId,
          installation_id: identity.installation_id, data_id: identity.data_id,
          prepared_sha256: prepared.receipt_sha256 }));
      return { state: 'prepared', version: proof.version, payload_sha256: sha('payload') };
    },
    issueNndTrialCapability: async () => Object.freeze({}), appendNndActivationPhase,
    startNndOwnedTrial: async () => ({ status: () => ({ installation_id: identity.installation_id,
      data_id: identity.data_id, package_version: proof.version, instance_id: proof.generation }),
    trialChildPid: () => 1234, verify: async () => proof, registrationSelected: () => false,
    stop: async () => {} }),
    hash, json, readInstallBytes: async () => null,
    operationValid: value => value === operationId || value === stageOperationId };
  const source = await readFile(new URL('../../src/nnd-activation-trial.js', import.meta.url), 'utf8');
  const executable = source.replace(/^import\s[\s\S]*?;\r?\n/gm, '')
    .replaceAll('export async function', 'async function').replaceAll('export function', 'function');
  const run = Function(...Object.keys(dependencies), `${executable}\nreturn runNndUnpublishedTrialUnderOwnership;`)
    (...Object.values(dependencies));
  await run(identity, {}, lease, registryLease, { operationId, stageOperationId,
    afterFinalVerification: ({ withFinalOwnership }) => withFinalOwnership(async () => {
      process.send?.('final-held');
      await new Promise(() => {});
    }) });
});
