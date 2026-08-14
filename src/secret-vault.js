// SPDX-License-Identifier: Apache-2.0
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ContractError } from './ids.js';
import { SessionLock } from './persistence/session-lock.js';

const EMPTY = Object.freeze({ format: 1, keyVersion: 1, records: [] });
const PATH_TAILS = new Map();

export class SecretVault {
  constructor(options) {
    this.path = options.path;
    this.keyPath = options.keyPath;
  }

  read() { return this.#serialized(() => this.#readUnlocked()); }

  update(mutator) {
    return this.#serialized(async () => {
      const current = await this.#readUnlocked();
      const next = await mutator(structuredClone(current));
      validateVault(next);
      await atomicWrite(this.path, next);
      return next;
    });
  }

  async encryptFields(realm, recordId, fields, keyVersion = 1) {
    const key = await this.#realmKey(realm, keyVersion);
    return Object.fromEntries(Object.entries(fields).map(([name, value]) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad(realm, recordId, name, keyVersion));
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return [name, Object.freeze({
        nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'), keyVersion,
      })];
    }));
  }

  async decryptFields(record) {
    const output = {};
    for (const [name, field] of Object.entries(record.encryptedFields)) {
      const key = await this.#realmKey(record.realm, field.keyVersion);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(field.nonce, 'base64'));
        decipher.setAAD(aad(record.realm, record.id, name, field.keyVersion));
        decipher.setAuthTag(Buffer.from(field.tag, 'base64'));
        output[name] = Buffer.concat([
          decipher.update(Buffer.from(field.ciphertext, 'base64')), decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new ContractError('secret_vault_integrity_failed', 'secret value failed authenticated decryption');
      }
    }
    return output;
  }

  async #readUnlocked() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8'));
      validateVault(parsed);
      return parsed;
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(EMPTY);
      if (error instanceof ContractError) throw error;
      throw new ContractError('secret_vault_corrupt', 'secret vault is unreadable or malformed');
    }
  }

  async #masterKey() {
    try {
      const value = JSON.parse(await readFile(this.keyPath, 'utf8'));
      const key = Buffer.from(value.key, 'base64');
      if (value.format !== 1 || value.protection !== 'portable-file-v1' || key.length !== 32) throw new Error('invalid');
      return key;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new ContractError('secret_key_invalid', 'secret vault key file is invalid');
      await mkdir(dirname(this.keyPath), { recursive: true, mode: 0o700 });
      const value = { format: 1, protection: 'portable-file-v1', key: randomBytes(32).toString('base64') };
      try { await writeFile(this.keyPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
      catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; }
      return this.#masterKey();
    }
  }

  async #realmKey(realm, version) {
    return Buffer.from(hkdfSync('sha256', await this.#masterKey(), Buffer.from(realm), Buffer.from(`nna-secret-realm-v${version}`), 32));
  }

  #serialized(operation) {
    const prior = PATH_TAILS.get(this.path) ?? Promise.resolve();
    const run = prior.then(async () => {
      const lock = new SessionLock(dirname(this.path), 'secret-vault');
      await lock.acquire();
      try { return await operation(); } finally { await lock.release(); }
    });
    const settled = run.catch(() => undefined);
    PATH_TAILS.set(this.path, settled);
    void settled.finally(() => {
      if (PATH_TAILS.get(this.path) === settled) PATH_TAILS.delete(this.path);
    });
    return run;
  }
}

function aad(realm, recordId, field, keyVersion) {
  return Buffer.from(JSON.stringify({ format: 1, realm, recordId, field, keyVersion }));
}

function validateVault(value) {
  if (!value || value.format !== 1 || value.keyVersion !== 1 || !Array.isArray(value.records) || value.records.length > 10_000) {
    throw new ContractError('secret_vault_corrupt', 'secret vault schema is invalid');
  }
  for (const record of value.records) {
    if (!record?.id || !record.realm || !record.label || !record.encryptedFields || typeof record.encryptedFields !== 'object') {
      throw new ContractError('secret_vault_corrupt', 'secret vault record is invalid');
    }
  }
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}
