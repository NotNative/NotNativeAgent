// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const NAME = 'RELEASE_VERSIONS.json';

export async function sealVersionLedger({ root, version, recordMissing, candidateDigest, errors }) {
  if (errors.length > 0) return false;
  if (!validVersion(version)) {
    errors.push('release version is invalid');
    return false;
  }
  const path = join(root, NAME);
  let ledger;
  try {
    if (!(await lstat(path)).isFile()) {
      errors.push(`${NAME} is not a regular file`);
      return false;
    }
    ledger = JSON.parse(await readFile(path, 'utf8'));
  }
  catch (error) {
    if (error.code === 'ENOENT') ledger = { schema_version: 1, releases: [] };
    else {
      errors.push(`${NAME} could not be read as JSON: ${error.code ?? error.message}`);
      return false;
    }
  }
  if (!validLedger(ledger)) {
    errors.push('release version ledger is invalid');
    return false;
  }
  const digest = await candidateDigest();
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest)) {
    errors.push('release content digest is invalid');
    return false;
  }
  const existing = ledger.releases.find((item) => item.version === version);
  if (existing && existing.content_sha256 !== digest) {
    errors.push(`version ${version} is sealed with different content; bump VERSION before re-releasing`);
    return false;
  }
  if (existing) return true;
  if (!recordMissing) {
    errors.push(`version ${version} is not sealed; run pnpm run release:check -- --write-hashes`);
    return false;
  }
  ledger.releases.push({ version, content_sha256: digest });
  // Invariant: a failed or interrupted seal cannot truncate an existing history.
  const stagedPath = join(root, `.${NAME}.${randomUUID()}.tmp`);
  try {
    await writeFile(stagedPath, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(stagedPath, path);
  } catch (error) {
    errors.push(`${NAME} could not be written: ${error.code ?? error.message}`);
    try { await unlink(stagedPath); }
    catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        errors.push(`${NAME} staged file cleanup failed: ${cleanupError.code ?? cleanupError.message}`);
      }
    }
    return false;
  }
  return true;
}

function validLedger(value) {
  if (!value || value.schema_version !== 1 || !Array.isArray(value.releases)) return false;
  const versions = new Set();
  for (const entry of value.releases) {
    if (!entry || !validVersion(entry.version)
      || typeof entry.content_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(entry.content_sha256)
      || versions.has(entry.version)) return false;
    versions.add(entry.version);
  }
  return true;
}

export function validVersion(value) {
  if (typeof value !== 'string' || !/^\d{8}-[1-9]\d*$/u.test(value)) return false;
  // Invariant: release seals use the same safe-integer iteration range as
  // the canonical version bump.
  if (!Number.isSafeInteger(Number(value.slice(9)))) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1 || month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}
