// SPDX-License-Identifier: Apache-2.0
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ContractError } from './ids.js';
import {
  isSecretFieldName, normalizeSecretKind, normalizeSecretLabel, normalizeSecretMetadata, normalizeSecretScope,
} from './secret-contracts.js';
import { SessionLock } from './persistence/session-lock.js';
import { persistAtomicJson, persistAtomicJsonIfAbsent } from './persistence/atomic-json.js';

const EMPTY = Object.freeze({ format: 1, keyVersion: 1, records: [] });
const PATH_TAILS = new Map();
const MASTER_KEY_BYTES = 32;
const MASTER_KEY_CREATE_ATTEMPTS = 8;
const VAULT_LOCK_WAIT_MS = 30_000;
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
// Stable HKDF domain separator; changing it would make existing vault data unreadable.
const REALM_KEY_INFO_PREFIX = 'nna-secret-realm-v';
const ERROR = Object.freeze({
  corrupt: 'secret_vault_corrupt',
  integrity: 'secret_vault_integrity_failed',
  invalidKey: 'secret_key_invalid',
});

export class SecretVault {
  constructor(options) {
    this.path = resolve(options.path);
    this.keyPath = resolve(options.keyPath);
  }

  read() { return this.#serialized(() => this.#readUnlocked()); }

  update(mutator) {
    return this.#serialized(async () => {
      const current = await this.#readUnlocked();
      const next = await mutator(structuredClone(current));
      validateVault(next);
      await persistAtomicJson(this.path, next);
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
    validateVaultRecord(record);
    const output = {};
    const keys = new Map();
    for (const [name, field] of Object.entries(record.encryptedFields)) {
      let key = keys.get(field.keyVersion);
      if (!key) {
        key = await this.#realmKey(record.realm, field.keyVersion);
        keys.set(field.keyVersion, key);
      }
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(field.nonce, 'base64'));
        decipher.setAAD(aad(record.realm, record.id, name, field.keyVersion));
        decipher.setAuthTag(Buffer.from(field.tag, 'base64'));
        output[name] = Buffer.concat([
          decipher.update(Buffer.from(field.ciphertext, 'base64')), decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new ContractError(ERROR.integrity, 'secret value failed authenticated decryption');
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
      throw new ContractError(ERROR.corrupt, 'secret vault is unreadable or malformed');
    }
  }

  async #masterKey() {
    for (let attempt = 0; attempt < MASTER_KEY_CREATE_ATTEMPTS; attempt += 1) {
      try {
        return decodeMasterKey(JSON.parse(await readFile(this.keyPath, 'utf8')));
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw new ContractError(ERROR.invalidKey, 'secret vault key file is invalid', { cause: error });
        }
      }
      if ((await this.#readUnlocked()).records.length > 0) {
        throw new ContractError(ERROR.invalidKey, 'secret vault key file is missing for existing records');
      }
      const key = randomBytes(MASTER_KEY_BYTES);
      const value = { format: 1, protection: 'portable-file-v1', key: key.toString('base64') };
      try {
        await persistAtomicJsonIfAbsent(this.keyPath, value);
        return key;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    throw new ContractError(ERROR.invalidKey, 'secret vault key file could not be initialized');
  }

  async #realmKey(realm, version) {
    const info = Buffer.from(`${REALM_KEY_INFO_PREFIX}${version}`);
    return Buffer.from(hkdfSync('sha256', await this.#masterKey(), Buffer.from(realm), info, MASTER_KEY_BYTES));
  }

  async #serialized(operation) {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await realpath(directory);
    // Compatibility: older NNA processes use the directory-wide secret-vault lock.
    // Sharing it prevents mixed-version writers from losing each other's updates.
    const identity = process.platform === 'win32' ? root.toLowerCase() : root;
    const prior = PATH_TAILS.get(identity) ?? Promise.resolve();
    let releaseTurn;
    const turn = new Promise((resolve) => { releaseTurn = resolve; });
    PATH_TAILS.set(identity, turn);
    await prior;
    try {
      const lock = new SessionLock(root, 'secret-vault');
      await acquireVaultLock(lock);
      try { return await operation(); } finally { await lock.release(); }
    } finally {
      releaseTurn();
      if (PATH_TAILS.get(identity) === turn) PATH_TAILS.delete(identity);
    }
  }
}

async function acquireVaultLock(lock) {
  const deadline = performance.now() + VAULT_LOCK_WAIT_MS;
  let delay = 25;
  for (;;) {
    try { await lock.acquire(); return; }
    catch (error) {
      if (error?.code !== 'session_locked' || performance.now() >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(1, deadline - performance.now()))));
    delay = Math.min(delay * 2, 250);
  }
}

function decodeMasterKey(value) {
  const key = Buffer.from(value?.key ?? '', 'base64');
  if (value?.format !== 1 || value.protection !== 'portable-file-v1' || key.length !== MASTER_KEY_BYTES) {
    throw new Error('invalid master key');
  }
  return key;
}

function aad(realm, recordId, field, keyVersion) {
  return Buffer.from(JSON.stringify({ format: 1, realm, recordId, field, keyVersion }));
}

function validateVault(value) {
  if (!value || value.format !== 1 || value.keyVersion !== 1 || !Array.isArray(value.records) || value.records.length > 10_000) {
    throw new ContractError(ERROR.corrupt, 'secret vault schema is invalid');
  }
  const identities = new Set();
  for (const record of value.records) {
    validateVaultRecord(record);
    if (identities.has(record.id)) {
      throw new ContractError(ERROR.corrupt, 'secret vault contains duplicate record identity');
    }
    identities.add(record.id);
  }
}

function validateVaultRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || typeof record.id !== 'string' || !/^sec_[A-Za-z0-9-]{1,128}$/u.test(record.id)
    || typeof record.realm !== 'string' || !record.realm || record.realm.length > 256
    || !record.encryptedFields || typeof record.encryptedFields !== 'object'
    || Array.isArray(record.encryptedFields) || typeof record.enabled !== 'boolean'
    || !Number.isSafeInteger(record.useCount) || record.useCount < 0
    || !isStoredStamp(record.createdAt) || !isStoredStamp(record.updatedAt)
    || (record.rotatedAt !== null && !isStoredStamp(record.rotatedAt))
    || (record.lastUsedAt !== null && !isStoredStamp(record.lastUsedAt))) {
    throw new ContractError(ERROR.corrupt, 'secret vault record is invalid');
  }
  const fields = Object.entries(record.encryptedFields);
  if (fields.length < 1 || fields.length > 16 || fields.some(([name, field]) =>
    !isSecretFieldName(name) || !field || typeof field !== 'object' || Array.isArray(field)
    || field.keyVersion !== 1 || typeof field.nonce !== 'string' || typeof field.tag !== 'string'
    || typeof field.ciphertext !== 'string')) {
    throw new ContractError(ERROR.corrupt, 'secret vault encrypted fields are invalid');
  }
  try {
    if (normalizeSecretLabel(record.label) !== record.label) throw new Error('noncanonical label');
    normalizeSecretKind(record.kind);
    normalizeSecretMetadata(record.metadata);
    normalizeSecretScope(record.scope, record.realm);
  } catch {
    throw new ContractError(ERROR.corrupt, 'secret vault record metadata or scope is invalid');
  }
}

function isStoredStamp(value) {
  if (typeof value !== 'string' || !ISO_STAMP.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
