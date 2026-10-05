// SPDX-License-Identifier: Apache-2.0
/**
 * ADR 0069 rotation. A consumed retirement receipt pair stays durable, but it
 * must vacate the fixed evidence paths before the next activation can commit
 * its own terminal pair. Rotation runs only under both genuine owners, only
 * while the pair re-validates byte-for-byte (canonical, mirrored, hash-bound,
 * identity-bound) and still names the live registration revision, and only
 * into the pair's own private archive directory under its operation UUID.
 * The pair is moved, never deleted. A half pair, a non-consumed pair, a
 * foreign identity, a revision drift, or an archive collision keeps the
 * admission bar exactly as before; a half-moved archive is restored so no
 * crash state can strand evidence between the two locations.
 */
import { lstat, opendir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { assertHeldNndServiceLease, withNndServiceLease } from './nnd-service-lock.js';
import { assertManifestLease, runManifestLeaseWork } from './persistence/manifest-lock.js';
import { readLockedManifestSnapshot } from './persistence/manifest-transaction.js';
import { consumedRetirementPair } from './nnd-activation-initialization-db.js';
import { noLinks } from './nnd-payload-contract-files.js';
import { runPrivateWindowsProgram, PRIVATE_ACL_PROGRAM } from './nnd-service-private-windows.js';
import { readInstallBytes, hash } from './nnd-install-storage.js';

const invalid = () => new ContractError('nnd_activation_receipt_rotation_invalid',
  'NND consumed retirement receipt could not be archived; the admission bar is preserved.');
const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
const MEMBER = { commit: 'activation-retirement-commit.json', cleared: 'activation-retirement-cleared.json' };
const ACL = PRIVATE_ACL_PROGRAM + String.raw`
try {
 $r=[Console]::In.ReadToEnd()|ConvertFrom-Json
 foreach($p in $r.directories) { Create-PrivateDirectory $p; Assert-Directory $p $true }
 [Console]::Out.WriteLine('{"ok":true}')
} catch { [Console]::Out.WriteLine('{"error_code":"nnd_private_storage_unavailable"}'); exit 1 }
`;
function paths(identity) {
  const root = join(identity.data_root, 'runtime', 'nnd', 'install-slots');
  return Object.freeze({ root, parent: join(root, 'consumed'),
    commit: join(root, MEMBER.commit), cleared: join(root, MEMBER.cleared) });
}
function assertOwner(identity, serviceLease, registryLease) {
  if (!identity || typeof identity.data_root !== 'string' || typeof identity.data_id !== 'string') throw invalid();
  assertHeldNndServiceLease(serviceLease, identity.data_id);
  const target = assertManifestLease(registryLease);
  if (!samePath(target.path, join(identity.data_root, 'config', 'nnd-package.json'))) throw invalid();
}
async function isFile(path) {
  try { return (await lstat(path)).isFile(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw invalid(); }
}
async function directoryNames(path) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw invalid(); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
  const names = [];
  for await (const entry of await opendir(path)) {
    if (names.length >= 32) throw invalid();
    names.push({ name: entry.name, file: entry.isFile() });
  }
  return names;
}
/** Restore exactly one archived member while its mate still sits at the fixed path. */
async function repairArchives(place, signal) {
  const archives = await directoryNames(place.parent);
  if (!archives) return;
  for (const entry of archives) {
    if (entry.file || entry.name.startsWith('.')) throw invalid();
    const archive = join(place.parent, entry.name);
    await noLinks(archive);
    const members = await directoryNames(archive);
    if (!members) throw invalid();
    if (members.some(member => !member.file)) throw invalid();
    const files = members.map(member => member.name);
    if (files.length > 2 || files.some(name => ![MEMBER.commit, MEMBER.cleared].includes(name))) throw invalid();
    if (files.length !== 1) continue;
    const storedIsCommit = files[0] === MEMBER.commit;
    if (await isFile(storedIsCommit ? place.commit : place.cleared)) throw invalid();
    if (!(await isFile(storedIsCommit ? place.cleared : place.commit))) throw invalid();
    signal.throwIfAborted();
    await rename(join(archive, files[0]), storedIsCommit ? place.commit : place.cleared);
    signal.throwIfAborted();
  }
}
async function liveRegistrationMatches(registryLease, pair) {
  // A guarded uninstall preserves the consumed pair but removes the
  // registration. With no live registration the identity-bound pair grants
  // admission to nothing, so it may vacate; a disagreeing live registration
  // still keeps the admission bar exactly as before.
  const manifest = await readLockedManifestSnapshot(registryLease);
  if (!manifest) return;
  if (!manifest.rawBytes || manifest.revision !== pair.registration_revision
    || hash(manifest.rawBytes) !== pair.registration_revision) throw invalid();
}
async function moveWholePair(place, pair, signal) {
  const archive = join(place.parent, pair.operation_id);
  const existing = await directoryNames(archive);
  if (existing && existing.length) throw invalid();
  const before = { commit: await readInstallBytes(place.commit, 4096),
    cleared: await readInstallBytes(place.cleared, 4096) };
  await runPrivateWindowsProgram(ACL, { directories: [place.parent, archive], files: [] }, signal);
  signal.throwIfAborted();
  await rename(place.commit, join(archive, MEMBER.commit));
  signal.throwIfAborted();
  await rename(place.cleared, join(archive, MEMBER.cleared));
  signal.throwIfAborted();
  const stored = await consumedRetirementPair(archive, { installation_id: null, data_id: null });
  const archived = { commit: await readInstallBytes(join(archive, MEMBER.commit), 4096),
    cleared: await readInstallBytes(join(archive, MEMBER.cleared), 4096) };
  if (stored?.commit_sha256 !== pair.commit_sha256 || hash(archived.commit) !== hash(before.commit)
    || hash(archived.cleared) !== hash(before.cleared)
    || await isFile(place.commit) || await isFile(place.cleared)) throw invalid();
}
async function rotateOwned(identity, registryLease, signal) {
  signal.throwIfAborted();
  const place = paths(identity);
  await repairArchives(place, signal);
  const [commit, cleared] = [await isFile(place.commit), await isFile(place.cleared)];
  if (commit !== cleared) throw invalid();
  if (!commit) return Object.freeze({ rotated: false, state: 'absent' });
  const pair = await consumedRetirementPair(place.root, identity);
  if (!pair) throw invalid();
  await liveRegistrationMatches(registryLease, pair);
  await moveWholePair(place, pair, signal);
  return Object.freeze({ rotated: true, state: 'consumed_receipt_archived',
    operation_id: pair.operation_id, commit_sha256: pair.commit_sha256,
    registration_revision: pair.registration_revision });
}
/** Archive the consumed receipt pair, or prove there is nothing to archive. */
export async function archiveConsumedRetirementReceiptUnderOwnership(identity, serviceLease, registryLease) {
  assertOwner(identity, serviceLease, registryLease);
  return withNndServiceLease(serviceLease, identity.data_id,
    signal => runManifestLeaseWork(registryLease, () => rotateOwned(identity, registryLease, signal)),
    { timeoutMs: 300000 });
}
