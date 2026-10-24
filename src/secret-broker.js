// SPDX-License-Identifier: Apache-2.0
import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContractError } from './ids.js';
import {
  LOCAL_SECRET_REALM, normalizeSecretKind, normalizeSecretLabel, normalizeSecretMetadata, normalizeSecretScope, publicSecret, validateSecretFields,
} from './secret-contracts.js';
import { registerSecretValue, releaseSecretValue } from './redaction.js';
import { SecretVault } from './secret-vault.js';

export class SecretBroker {
  constructor(options) {
    this.vault = options.vault ?? new SecretVault({ path: options.vaultPath, keyPath: options.keyPath });
    this.auditPath = options.auditPath;
    this.realm = options.realm ?? LOCAL_SECRET_REALM;
    this.audit = options.audit ?? (() => undefined);
    this.lastAuditFailure = null;
    this.auditGap = false;
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
    const scope = normalizeSecretScope(input.scope, this.realm);
    const metadata = normalizeSecretMetadata(input.metadata);
    const id = `sec_${randomUUID()}`;
    const encryptedFields = await this.vault.encryptFields(this.realm, id, fields);
    const now = new Date().toISOString();
    let created;
    await this.vault.update((vault) => {
      assertUniqueLabel(vault, this.realm, label);
      created = {
        id, realm: this.realm, label, kind, scope, metadata, encryptedFields, enabled: true,
        createdAt: now, updatedAt: now, rotatedAt: null, lastUsedAt: null, useCount: 0,
      };
      vault.records.push(created);
      return vault;
    });
    await this.#record('secret.created', created, 'succeeded');
    return publicSecret(created);
  }

  async update(id, patch, authorize = null) {
    let updated;
    await this.#updateRecord('secret.updated', id, (vault, record) => {
      authorize?.(publicSecret(record));
      const label = patch.label === undefined ? record.label : normalizeSecretLabel(patch.label);
      assertUniqueLabel(vault, this.realm, label, record);
      record.label = label;
      if (patch.scope !== undefined) record.scope = normalizeSecretScope(patch.scope, this.realm);
      if (patch.metadata !== undefined) record.metadata = normalizeSecretMetadata(patch.metadata);
      record.updatedAt = new Date().toISOString(); updated = record;
      return vault;
    });
    await this.#record('secret.updated', updated, 'succeeded');
    return publicSecret(updated);
  }

  async rotate(id, fields, authorize = null) {
    let updated;
    await this.#updateRecord('secret.rotated', id, async (vault, record) => {
      authorize?.(publicSecret(record));
      const validated = validateSecretFields(record.kind, fields);
      const now = new Date().toISOString();
      record.encryptedFields = await this.vault.encryptFields(record.realm, record.id, validated);
      record.updatedAt = now; record.rotatedAt = now; updated = record;
      return vault;
    });
    await this.#record('secret.rotated', updated, 'succeeded');
    return publicSecret(updated);
  }

  async setEnabled(id, enabled, authorize = null) {
    let updated;
    const event = enabled ? 'secret.enabled' : 'secret.revoked';
    await this.#updateRecord(event, id, (vault, record) => {
      authorize?.(publicSecret(record));
      record.enabled = Boolean(enabled); record.updatedAt = new Date().toISOString(); updated = record;
      return vault;
    });
    await this.#record(event, updated, 'succeeded');
    return publicSecret(updated);
  }

  async remove(id, authorize = null) {
    let removed;
    await this.#updateRecord('secret.deleted', id, (vault, record) => {
      removed = record;
      authorize?.(publicSecret(record));
      vault.records = vault.records.filter((candidate) => candidate !== record);
      return vault;
    });
    await this.#record('secret.deleted', removed, 'succeeded');
    return true;
  }

  async withSecret(id, request, consumer) {
    let record = null;
    let consumerInvoked = false;
    const registered = [];
    try {
      record = requireRecord(await this.vault.read(), this.realm, id);
      if (typeof consumer !== 'function') throw new ContractError('secret_consumer_invalid', 'trusted secret consumer is required');
      if (!record.enabled) throw new ContractError('secret_revoked', 'secret is disabled or revoked');
      requireUseRequest(request);
      const fields = await this.vault.decryptFields(record);
      for (const value of Object.values(fields)) {
        if (registerSecretValue(value, record.id)) registered.push(value);
      }
      consumerInvoked = true;
      const result = await consumer(Object.freeze({ ...fields }));
      await this.#markUsed(record.id);
      await this.#record('secret.used', record, 'succeeded', request);
      return result;
    } catch (error) {
      // Invariant: after the consumer receives plaintext, its external effect may have happened.
      if (record) await this.#record('secret.used', record, consumerInvoked ? 'unknown' : 'failed',
        request, error.code ?? 'consumer_failed');
      throw error;
    } finally {
      for (const value of registered) releaseSecretValue(value);
    }
  }

  async auditEvents(limit = 500) {
    if (this.auditGap) throw new ContractError('secret_audit_unavailable', 'secret audit observation has a known gap');
    if (!this.auditPath) return [];
    const bounded = Math.max(1, Math.min(Number(limit) || 500, 2_000));
    try {
      const lines = (await readFile(this.auditPath, 'utf8')).trim().split(/\r?\n/u).filter(Boolean).slice(-bounded);
      return lines.map(parseAuditLine).filter((entry) => entry?.realm === this.realm);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new ContractError('secret_audit_unavailable', 'secret audit ledger could not be read');
    }
  }

  async #markUsed(id) {
    await this.vault.update((vault) => {
      const record = requireRecord(vault, this.realm, id);
      record.lastUsedAt = new Date().toISOString(); record.useCount += 1;
      return vault;
    });
  }

  async #updateRecord(event, id, mutate) {
    let target = null;
    let mutationReturned = false;
    try {
      return await this.vault.update(async (vault) => {
        const record = requireRecord(vault, this.realm, id);
        target = { id: record.id, realm: record.realm, scope: record.scope };
        const next = await mutate(vault, record);
        mutationReturned = true;
        return next;
      });
    } catch (error) {
      // Invariant: once the mutator returns, publication may have happened before a later error.
      // A failed outcome would falsely claim that a committed change did not take effect.
      if (target) await this.#record(event, target, mutationReturned ? 'unknown' : 'failed',
        {}, error.code ?? 'mutation_failed');
      throw error;
    }
  }

  async #record(event, record, outcome, request = {}, reason = null) {
    const entry = Object.freeze({
      format: 1, id: `secret_event_${randomUUID()}`, at: new Date().toISOString(), event, outcome,
      realm: record.realm, secretId: record.id, scope: record.scope, consumer: auditField(request, 'consumer'),
      destination: auditField(request, 'destination'), purpose: auditField(request, 'purpose'),
      sessionId: auditField(request, 'sessionId'), reviewerDecisionId: auditField(request, 'reviewerDecisionId'), reason,
    });
    let ledgerAppended = false;
    try {
      if (this.auditPath) {
        const auditRoot = dirname(this.auditPath);
        await mkdir(auditRoot, { recursive: true, mode: 0o700 });
        await chmod(auditRoot, 0o700);
        await appendFile(this.auditPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
        ledgerAppended = true;
        await chmod(this.auditPath, 0o600);
      }
      await this.audit(entry);
      if (!this.auditGap) this.lastAuditFailure = null;
    } catch (error) {
      // Invariant: an audit failure cannot change a durable mutation or replace its original error.
      this.lastAuditFailure = error?.code ?? 'secret_audit_write_failed';
      if (!ledgerAppended) this.auditGap = true;
    }
  }
}

function auditText(value) {
  return typeof value === 'string' ? value.slice(0, 512) : null;
}

function auditField(request, key) {
  // Security: a malformed request must not prevent its rejection from reaching the audit ledger.
  try { return auditText(request?.[key]); } catch { return null; }
}

function assertUniqueLabel(vault, realm, label, excluded = null) {
  if (vault.records.some((record) => record !== excluded && record.realm === realm && fold(record.label) === fold(label))) {
    throw new ContractError('secret_label_duplicate', 'a secret with that label already exists');
  }
}

function parseAuditLine(line) {
  try { return JSON.parse(line); } catch { return null; }
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

function fold(value) {
  if (typeof value !== 'string') throw new ContractError('secret_label_invalid', 'secret label must be a string');
  return value.trim().toLocaleLowerCase('en-US');
}
