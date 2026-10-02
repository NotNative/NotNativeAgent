// SPDX-License-Identifier: Apache-2.0
import { lstat, opendir, rmdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { acquireNndServiceLock, assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { withManifestLock, readLockedManifestSnapshot } from './persistence/manifest-transaction.js';
import { runPrivateWindowsProgram, PRIVATE_ACL_PROGRAM } from './nnd-service-private-windows.js';
import { assertNoNndInstallMarker } from './nnd-install-marker.js';
import { assertNoNndMigration } from './nnd-migration-storage.js';
import { scanNndLegacyOwners } from './nnd-legacy-census.js';
import { openInstallStore, readInstallBytes as read, writeInstallNew as write, json, hash, operationValid } from './nnd-install-storage.js';
import { withActivationInitialization } from './nnd-activation-initialization-db.js';
import { readNndActivationCandidate, readNndPreparedActivationCandidate } from './nnd-activation-candidate.js';
import { readNndActivationJournal, nndPreparedPhaseBytes } from './nnd-activation-journal.js';
import { exactRecord } from './nnd-service-contract.js';

const invalid = () => new ContractError('nnd_activation_preparation_invalid',
  'NND activation preparation is incomplete or inconsistent; existing evidence was preserved.');
const KEYS = ['protocol', 'operation_id', 'stage_operation_id', 'installation_id', 'data_id', 'candidate', 'before', 'journal', 'marker'];
const ACL = PRIVATE_ACL_PROGRAM + String.raw`
try {
 $r=[Console]::In.ReadToEnd()|ConvertFrom-Json
 foreach($p in $r.directories) { Create-PrivateDirectory $p; Assert-Directory $p $true }
 foreach($p in $r.files) {
  if(-not [IO.File]::Exists($p)) { continue }
  Assert-Ancestors ([IO.Path]::GetDirectoryName($p))
  $file=[IO.FileInfo]::new($p)
  if($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'link' }
  $acl=$file.GetAccessControl();Assert-Acl $acl $false
  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $operatorSid) { throw 'owner' }
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
   if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $trusted -notcontains $rule.IdentityReference.Value) { throw 'acl' }
  }
 }
 [Console]::Out.WriteLine('{"ok":true}')
} catch { [Console]::Out.WriteLine('{"error_code":"nnd_private_storage_unavailable"}'); exit 1 }
`;
const b64 = bytes => bytes?.toString('base64') ?? null;
function unb64(value, limit) {
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4) throw invalid();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > limit || bytes.toString('base64') !== value) throw invalid();
  return bytes;
}
function paths(store, id) {
  const root = join(store.root, 'activations'), directory = join(root, id);
  const candidate = join(root, `${id}.candidate.json`), before = join(root, `${id}.registration.before`);
  const journal = join(directory, 'activation-00.json');
  if (directory.length > 247 || [candidate, before, journal].some(path => path.length > 259)) throw invalid();
  return { root, directory, candidate, before, journal, marker: store.pending,
    initializer: join(store.root, 'activation-preparation.sqlite') };
}
async function privatePaths(location, createDirectory, signal) {
  const directories = createDirectory ? [location.root, location.directory] : [location.root];
  await runPrivateWindowsProgram(ACL, { directories, files: [location.candidate, location.before,
    location.journal, location.marker, location.initializer] }, signal);
  if (!createDirectory) {
    try { await lstat(location.directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw invalid(); }
    await runPrivateWindowsProgram(ACL, { directories: [location.directory], files: [] }, signal);
  }
}
async function auditRoot(location) {
  let count = 0;
  for await (const entry of await opendir(location.root)) {
    if (++count > 48) throw invalid();
    if (entry.isDirectory() && operationValid(entry.name)) continue;
    if (entry.isFile() && /^(?:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.(?:candidate\.json|registration\.before)$/u.test(entry.name)) continue;
    throw invalid();
  }
}
function planFor(identity, stageId, id, candidate, snapshot) {
  const before = snapshot.rawBytes;
  if (before !== null && (!Buffer.isBuffer(before) || before.length > 16384)) throw invalid();
  if (candidate.evidence.registry_before_revision !== snapshot.revision
    || (before === null ? snapshot.revision !== 'absent' : hash(before) !== snapshot.revision)) throw invalid();
  const candidateBytes = json(candidate.evidence);
  if (candidateBytes.length > 4096 || candidate.evidence_sha256 !== hash(candidateBytes)) throw invalid();
  const bound = { ...identity, operation_id: id };
  const journal = nndPreparedPhaseBytes(bound, hash(candidateBytes));
  const marker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: id,
    installation_id: identity.installation_id, data_id: identity.data_id, prepared_sha256: hash(journal) });
  return { protocol: '3.0', operation_id: id, stage_operation_id: stageId,
    installation_id: identity.installation_id, data_id: identity.data_id,
    candidate: b64(candidateBytes), before: b64(before), journal: b64(journal), marker: b64(marker) };
}
function parsePlan(text, identity) {
  let plan;
  try { plan = JSON.parse(text); } catch { throw invalid(); }
  if (!exactRecord(plan, KEYS) || plan.protocol !== '3.0' || !operationValid(plan.operation_id)
    || !operationValid(plan.stage_operation_id) || plan.installation_id !== identity.installation_id
    || plan.data_id !== identity.data_id || !(plan.before === null || typeof plan.before === 'string')) throw invalid();
  const candidate = unb64(plan.candidate, 4096), before = plan.before === null ? null : unb64(plan.before, 16384);
  const journal = unb64(plan.journal, 2048), marker = unb64(plan.marker, 1024);
  let evidence;
  try { evidence = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(candidate)); }
  catch { throw invalid(); }
  if (!evidence || evidence.stage_operation_id !== plan.stage_operation_id
    || evidence.installation_id !== identity.installation_id || evidence.data_id !== identity.data_id
    || evidence.registry_before_revision !== (before === null ? 'absent' : hash(before))) throw invalid();
  const expectedJournal = nndPreparedPhaseBytes({ ...identity, operation_id: plan.operation_id }, hash(candidate));
  const expectedMarker = json({ protocol: '3.0', purpose: 'nnd_activation', operation_id: plan.operation_id,
    installation_id: identity.installation_id, data_id: identity.data_id, prepared_sha256: hash(expectedJournal) });
  if (!journal.equals(expectedJournal) || !marker.equals(expectedMarker)) throw invalid();
  return { plan, candidate, before, journal, marker, evidence };
}
async function observedFiles(location, intent) {
  const expected = [[location.candidate, intent.candidate], [location.before, intent.before],
    [location.journal, intent.journal], [location.marker, intent.marker]];
  const observed = [];
  for (const [path, bytes] of expected) {
    const actual = await read(path, bytes?.length ?? 1, true);
    if (bytes === null ? actual !== null : actual !== null && !bytes.subarray(0, actual.length).equals(actual)) throw invalid();
    observed.push({ path, expected: bytes, actual });
  }
  let directoryEntries = [];
  try { for await (const entry of await opendir(location.directory)) directoryEntries.push(entry.name); }
  catch (error) { if (error.code !== 'ENOENT') throw invalid(); }
  if (directoryEntries.some(name => name !== 'activation-00.json') || directoryEntries.length > 1) throw invalid();
  return observed;
}
async function currentBefore(registryLease, before) {
  const snapshot = await readLockedManifestSnapshot(registryLease);
  if (before === null ? snapshot.rawBytes !== null : !snapshot.rawBytes?.equals(before)) throw invalid();
}
async function verifyComplete(identity, lease, registryLease, location, intent) {
  const journal = await readNndActivationJournal({ ...identity, operation_id: intent.plan.operation_id }, location.directory);
  if (journal.length !== 1 || journal[0].phase !== 'prepared'
    || journal[0].receipt_sha256 !== hash(intent.journal) || journal[0].evidence_sha256 !== hash(intent.candidate)) throw invalid();
  const candidate = await readNndPreparedActivationCandidate(identity, lease, registryLease,
    intent.plan.stage_operation_id, intent.marker);
  if (!json(candidate.evidence).equals(intent.candidate)) throw invalid();
}
async function recoverRow(identity, store, lease, registryLease, row, signal) {
  const intent = parsePlan(row, identity), location = paths(store, intent.plan.operation_id);
  await privatePaths(location, false, signal); await auditRoot(location);
  await currentBefore(registryLease, intent.before);
  const files = await observedFiles(location, intent);
  const complete = files.every(file => file.expected === null || file.actual?.equals(file.expected));
  if (complete) {
    await verifyComplete(identity, lease, registryLease, location, intent);
    return { state: 'prepared', operation_id: intent.plan.operation_id, stage_operation_id: intent.plan.stage_operation_id };
  }
  // Invariant: a live trial cannot have started while this initialization row remains pending.
  // Only known prefix writes are removed; foreign or changed evidence has already failed above.
  for (const file of [...files].reverse()) if (file.actual !== null) await unlink(file.path);
  try { await rmdir(location.directory); } catch (error) { if (error.code !== 'ENOENT') throw invalid(); }
  return { state: 'unpublished', operation_id: intent.plan.operation_id };
}
async function checkpoint(options, phase, signal) {
  signal.throwIfAborted(); await options.checkpoint?.(phase); signal.throwIfAborted();
}
async function prepareOwned(identity, store, lease, registryLease, stageId, id, options, signal) {
  const location = paths(store, id);
  await privatePaths(location, false, signal); await auditRoot(location);
  return withActivationInitialization(store.root, async database => {
    const pending = database.read();
    if (pending !== null) {
      const intent = parsePlan(pending, identity);
      if (intent.plan.operation_id !== id || intent.plan.stage_operation_id !== stageId) throw invalid();
      const result = await recoverRow(identity, store, lease, registryLease, pending, signal);
      database.clear(pending); return result;
    }
    if (await read(store.pending, 1024, true) !== null) throw invalid();
    for (const path of [location.candidate, location.before, location.journal]) {
      if (await read(path, 16384, true) !== null) throw invalid();
    }
    const existing = await readNndActivationJournal({ ...identity, operation_id: id }, location.directory);
    if (existing.length || await lstat(location.directory).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) throw invalid();
    const candidate = await readNndActivationCandidate(identity, lease, registryLease, stageId);
    const snapshot = await readLockedManifestSnapshot(registryLease);
    const plan = planFor(identity, stageId, id, candidate, snapshot);
    const row = JSON.stringify(plan);
    await checkpoint(options, 'before_intent', signal);
    database.write(row); await checkpoint(options, 'intent_committed', signal);
    const intent = parsePlan(row, identity);
    await privatePaths(location, true, signal); await checkpoint(options, 'directory_created', signal);
    if (intent.before !== null) { await write(location.before, intent.before); await checkpoint(options, 'before_written', signal); }
    await write(location.candidate, intent.candidate); await checkpoint(options, 'candidate_written', signal);
    await write(location.journal, intent.journal); await checkpoint(options, 'journal_written', signal);
    await write(location.marker, intent.marker); await checkpoint(options, 'barrier_written', signal);
    await privatePaths(location, false, signal); await verifyComplete(identity, lease, registryLease, location, intent);
    database.clear(row); await checkpoint(options, 'intent_cleared', signal);
    return { state: 'prepared', operation_id: id, stage_operation_id: stageId,
      version: candidate.package.version, payload_sha256: candidate.evidence.payload_sha256 };
  });
}
async function owned(identity, operation) {
  const lease = await acquireNndServiceLock({ dataRoot: identity.data_root });
  try {
    return await withNndServiceLease(lease, identity.data_id, async signal => {
      await assertNoNndInstallMarker(identity); await assertNoNndMigration(identity);
      await scanNndLegacyOwners(identity, signal);
      const store = await openInstallStore(identity, signal);
      return withManifestLock(join(identity.data_root, 'config', 'nnd-package.json'), { signal, timeoutMs: 30000 },
        registryLease => operation(store, lease, registryLease, signal));
    }, { timeoutMs: 300000 });
  } finally { await lease.close(); }
}
// Invariant: the later activation owner must retain both genuine locks across preparation,
// unpublished trial, registration and discovery. This entry does not release either lock.
export async function prepareNndActivationUnderOwnership(identity, serviceLease, registryLease,
  { stageOperationId, operationId, checkpoint: onCheckpoint } = {}) {
  if (!operationValid(stageOperationId) || !operationValid(operationId)) throw invalid();
  assertHeldNndServiceLease(serviceLease, identity?.data_id);
  const target = assertManifestLease(registryLease);
  const expected = join(identity.data_root, 'config', 'nnd-package.json');
  if ((process.platform === 'win32' ? resolve(target.path).toLowerCase() !== resolve(expected).toLowerCase()
    : resolve(target.path) !== resolve(expected))) throw invalid();
  return withNndServiceLease(serviceLease, identity.data_id, signal => runManifestLeaseWork(registryLease, async () => {
    await assertNoNndInstallMarker(identity); await assertNoNndMigration(identity);
    await scanNndLegacyOwners(identity, signal);
    const store = await openInstallStore(identity, signal);
    return prepareOwned(identity, store, serviceLease, registryLease, stageOperationId, operationId,
      { checkpoint: onCheckpoint }, signal);
  }), { timeoutMs: 300000 });
}
export async function prepareNndActivation(identity, { stageOperationId, operationId, checkpoint: onCheckpoint } = {}) {
  if (!operationValid(stageOperationId) || !operationValid(operationId)) throw invalid();
  return owned(identity, (store, lease, registryLease, signal) =>
    prepareOwned(identity, store, lease, registryLease, stageOperationId, operationId, { checkpoint: onCheckpoint }, signal));
}
export async function recoverNndActivationPreparation(identity, { operationId } = {}) {
  if (!operationValid(operationId)) throw invalid();
  return owned(identity, async (store, lease, registryLease, signal) => {
    const location = paths(store, operationId);
    await privatePaths(location, false, signal); await auditRoot(location);
    return withActivationInitialization(store.root, async database => {
      const row = database.read();
      if (row !== null) {
        const intent = parsePlan(row, identity);
        if (intent.plan.operation_id !== operationId) throw invalid();
        const result = await recoverRow(identity, store, lease, registryLease, row, signal);
        database.clear(row); return result;
      }
      const marker = await read(store.pending, 1024, true);
      const candidateBytes = await read(location.candidate, 4096, true);
      const before = await read(location.before, 16384, true);
      const journal = await readNndActivationJournal({ ...identity, operation_id: operationId }, location.directory);
      const directoryExists = await lstat(location.directory).then(() => true,
        error => error.code === 'ENOENT' ? false : Promise.reject(error));
      if (!marker && !candidateBytes && !before && !directoryExists) return { state: 'absent', operation_id: operationId };
      if (!marker || !candidateBytes || journal.length !== 1 || journal[0].phase !== 'prepared') throw invalid();
      let evidence;
      try { evidence = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(candidateBytes)); } catch { throw invalid(); }
      const plan = { protocol: '3.0', operation_id: operationId, stage_operation_id: evidence.stage_operation_id,
        installation_id: identity.installation_id, data_id: identity.data_id, candidate: b64(candidateBytes),
        before: b64(before), journal: b64(nndPreparedPhaseBytes({ ...identity, operation_id: operationId }, hash(candidateBytes))), marker: b64(marker) };
      const intent = parsePlan(JSON.stringify(plan), identity);
      await currentBefore(registryLease, before);
      const files = await observedFiles(location, intent);
      if (files.some(file => file.expected !== null && !file.actual?.equals(file.expected))) throw invalid();
      await verifyComplete(identity, lease, registryLease, location, intent);
      return { state: 'prepared', operation_id: operationId, stage_operation_id: intent.plan.stage_operation_id };
    });
  });
}
