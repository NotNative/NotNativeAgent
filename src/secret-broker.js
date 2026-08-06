// SPDX-License-Identifier: Apache-2.0
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContractError } from './ids.js';
import { LOCAL_SECRET_REALM, normalizeSecretKind, normalizeSecretLabel, publicSecret, validateSecretFields } from './secret-contracts.js';
import { registerSecretValue, releaseSecretValue } from './redaction.js';
import { SecretVault } from './secret-vault.js';

export class SecretBroker {
  constructor(options) {
    this.vault = options.vault ?? new SecretVault({ path: options.vaultPath, keyPath: options.keyPath });
    this.auditPath = options.auditPath;
    this.realm = options.realm ?? LOCAL_SECRET_REALM;
    this.audit = options.audit ?? (() => undefined);
  }

  async list() {
    const vault = await this.vault.read();
    return vault.records.filter((record) => record.realm === this.realm).map(publicSecret)
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  async get(id) {
    return (await this.list()).find((record) => record.id === id) ?? null;
  }

  async create(input) {
    const label = normalizeSecretLabel(input.label);
    const kind = normalizeSecretKind(input.kind);
    const fields = validateSecretFields(kind, input.fields);
    const id = `sec_${randomUUID()}`;
    const encryptedFields = await this.vault.encryptFields(this.realm, id, fields);
    const now = new Date().toISOString();
    let created;
    await this.vault.update((vault) => {
      if (vault.records.some((record) => record.realm === this.realm && fold(record.label) === fold(label))) {
        throw new ContractError('secret_label_duplicate', 'a secret with that label already exists');
      }
      created = {
        id, realm: this.realm, label, kind, encryptedFields, enabled: true,
        createdAt: now, updatedAt: now, rotatedAt: null, lastUsedAt: null, useCount: 0,
      };
      vault.records.push(created);
      return vault;
    });
    await this.#record('secret.created', created, 'succeeded');
    return publicSecret(created);
  }

  async rotate(id, fields) {
    let updated;
    await this.vault.update(async (vault) => {
      const record = requireRecord(vault, this.realm, id);
      const validated = validateSecretFields(record.kind, fields);
      const now = new Date().toISOString();
      record.encryptedFields = await this.vault.encryptFields(record.realm, record.id, validated);
      record.updatedAt = now; record.rotatedAt = now; updated = record;
      return vault;
    });
    await this.#record('secret.rotated', updated, 'succeeded');
    return publicSecret(updated);
  }

  async setEnabled(id, enabled) {
    let updated;
    await this.vault.update((vault) => {
      const record = requireRecord(vault, this.realm, id);
      record.enabled = Boolean(enabled); record.updatedAt = new Date().toISOString(); updated = record;
      return vault;
    });
    await this.#record(enabled ? 'secret.enabled' : 'secret.revoked', updated, 'succeeded');
    return publicSecret(updated);
  }

  async remove(id) {
    let removed;
    await this.vault.update((vault) => {
      const record = requireRecord(vault, this.realm, id); removed = record;
      vault.records = vault.records.filter((candidate) => candidate !== record);
      return vault;
    });
    await this.#record('secret.deleted', removed, 'succeeded');
    return true;
  }

  async withSecret(id, request, consumer) {
    if (typeof consumer !== 'function') throw new ContractError('secret_consumer_invalid', 'trusted secret consumer is required');
    let record;
    const vault = await this.vault.read();
    record = requireRecord(vault, this.realm, id);
    if (!record.enabled) throw new ContractError('secret_revoked', 'secret is disabled or revoked');
    requireUseRequest(request);
    const fields = await this.vault.decryptFields(record);
    for (const value of Object.values(fields)) registerSecretValue(value, record.id);
    try {
      const result = await consumer(Object.freeze({ ...fields }));
      await this.#markUsed(record.id);
      await this.#record('secret.used', record, 'succeeded', request);
      return result;
    } catch (error) {
      await this.#record('secret.used', record, 'failed', request, error.code ?? 'consumer_failed');
      throw error;
    } finally {
      for (const value of Object.values(fields)) releaseSecretValue(value);
    }
  }

  async #markUsed(id) {
    await this.vault.update((vault) => {
      const record = requireRecord(vault, this.realm, id);
      record.lastUsedAt = new Date().toISOString(); record.useCount += 1;
      return vault;
    });
  }

  async #record(event, record, outcome, request = {}, reason = null) {
    const entry = Object.freeze({
      format: 1, id: `secret_event_${randomUUID()}`, at: new Date().toISOString(), event, outcome,
      realm: record.realm, secretId: record.id, consumer: request.consumer ?? null,
      destination: request.destination ?? null, purpose: request.purpose ?? null,
      sessionId: request.sessionId ?? null, reviewerDecisionId: request.reviewerDecisionId ?? null, reason,
    });
    if (this.auditPath) {
      await mkdir(dirname(this.auditPath), { recursive: true, mode: 0o700 });
      await appendFile(this.auditPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    await this.audit(entry);
  }
}

function requireRecord(vault, realm, id) {
  const record = vault.records.find((candidate) => candidate.realm === realm && candidate.id === id);
  if (!record) throw new ContractError('secret_not_found', 'secret was not found in the current realm');
  return record;
}

function requireUseRequest(request) {
  for (const key of ['consumer', 'destination', 'purpose', 'reviewerDecisionId']) {
    if (typeof request?.[key] !== 'string' || !request[key].trim()) {
      throw new ContractError('secret_use_request_invalid', `secret use requires ${key}`);
    }
  }
}

function fold(value) { return value.trim().toLocaleLowerCase('en-US'); }
