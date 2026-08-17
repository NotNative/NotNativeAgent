// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { copyFile, link, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ContractError } from '../ids.js';

export async function persistAtomicJson(path, value, options = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(path);
  try {
    await writeSynced(temporary, serialized(value));
    if (options.backup) await copyExisting(path, `${path}.bak`);
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

export async function persistAtomicJsonIfAbsent(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(path);
  try {
    await writeSynced(temporary, serialized(value));
    await link(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

export async function quarantineMalformedJson(path, label, code, options = {}) {
  const quarantine = `${path}.corrupt-${options.timestamp ?? Date.now()}`;
  try { await rename(path, quarantine); }
  catch (error) {
    if (error.code === 'ENOENT') throw new ContractError(code, `${label} is malformed and disappeared before it could be quarantined`, { cause: error });
    throw new ContractError(code, `${label} is malformed and could not be quarantined safely`, { cause: error });
  }
  throw new ContractError(code, `${label} is malformed; preserved at ${quarantine}`);
}

async function writeSynced(path, content) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
}

async function copyExisting(source, destination) {
  await copyFile(source, destination).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

function serialized(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function temporaryPath(path) { return `${path}.tmp-${process.pid}-${randomUUID()}`; }
