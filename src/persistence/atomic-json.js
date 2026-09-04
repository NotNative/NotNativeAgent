// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { copyFile, link, mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ContractError } from '../ids.js';

export async function persistAtomicJson(path, value, options = {}) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(path);
  try {
    await writeSynced(temporary, serialized(value));
    if (options.backup) await copyExisting(path, `${path}.bak`);
    await replaceFile(temporary, path);
    await (options.syncDirectory ?? syncDirectory)(directory);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

export async function persistAtomicJsonIfAbsent(path, value, options = {}) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = temporaryPath(path);
  try {
    await writeSynced(temporary, serialized(value));
    await link(temporary, path);
    await (options.syncDirectory ?? syncDirectory)(directory);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

export async function quarantineMalformedJson(path, label, code, options = {}) {
  let quarantine = `${path}.corrupt-${options.timestamp ?? Date.now()}`;
  try {
    try { await link(path, quarantine); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      quarantine = `${quarantine}-${randomUUID()}`;
      await link(path, quarantine);
    }
    await unlink(path);
  }
  catch (error) {
    if (error.code === 'ENOENT') throw new ContractError(code, `${label} is malformed and disappeared before it could be quarantined`, { cause: error });
    throw new ContractError(code, `${label} is malformed and could not be quarantined safely`, { cause: error });
  }
  await (options.syncDirectory ?? syncDirectory)(dirname(path));
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

async function replaceFile(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(source, destination); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 40) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
