// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export const LOCAL_SECRET_REALM = 'nna.local';
export const SECRET_KINDS = Object.freeze(['api_key', 'token', 'username_password', 'text']);
export const SECRET_SCOPE_KINDS = Object.freeze(['deployment', 'workspace', 'group', 'role', 'user']);

export function normalizeSecretLabel(value) {
  const label = String(value ?? '').trim();
  if (!label || label.length > 96 || /[\x00-\x1f\x7f]/u.test(label)) {
    throw new ContractError('secret_label_invalid', 'secret label must contain 1-96 visible characters');
  }
  return label;
}

export function normalizeSecretKind(value) {
  if (!SECRET_KINDS.includes(value)) throw new ContractError('secret_kind_invalid', 'secret kind is not supported');
  return value;
}

export function validateSecretFields(kind, fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new ContractError('secret_fields_invalid', 'secret fields must be an object');
  }
  const entries = Object.entries(fields);
  if (entries.length < 1 || entries.length > 16) throw new ContractError('secret_fields_invalid', 'a secret requires 1-16 fields');
  for (const [name, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(name)) throw new ContractError('secret_field_name_invalid', 'secret field name is invalid');
    if (typeof value !== 'string' || !value || value.length > 20_000 || /\u0000/u.test(value)) {
      throw new ContractError('secret_field_value_invalid', `secret field ${name} is empty or exceeds its bound`);
    }
  }
  if (kind === 'username_password' && (!fields.username || !fields.password)) {
    throw new ContractError('secret_fields_invalid', 'username/password secrets require username and password');
  }
  return Object.freeze(Object.fromEntries(entries));
}

export function normalizeSecretScope(value, realm) {
  if (realm === LOCAL_SECRET_REALM && value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError('secret_scope_invalid', 'managed secrets require an ownership scope');
  }
  const kind = String(value.kind ?? '').trim();
  const id = String(value.id ?? '').trim();
  if (!SECRET_SCOPE_KINDS.includes(kind) || !id || id.length > 128 || /[\x00-\x1f\x7f]/u.test(id)) {
    throw new ContractError('secret_scope_invalid', 'secret scope kind or identifier is invalid');
  }
  return Object.freeze({ kind, id });
}

export function normalizeSecretMetadata(value) {
  if (value == null) return Object.freeze({});
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError('secret_metadata_invalid', 'secret metadata must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length > 32) throw new ContractError('secret_metadata_invalid', 'secret metadata exceeds its field bound');
  const normalized = {};
  for (const [name, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(name)) {
      throw new ContractError('secret_metadata_invalid', 'secret metadata field name is invalid');
    }
    if (item === null || typeof item === 'boolean') normalized[name] = item;
    else if (typeof item === 'string' && item.length <= 2_000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(item)) normalized[name] = item;
    else if (Array.isArray(item) && item.length <= 64 && item.every((entry) => typeof entry === 'string' && entry.length <= 256)) {
      normalized[name] = [...new Set(item)];
    } else throw new ContractError('secret_metadata_invalid', `secret metadata field ${name} is invalid`);
  }
  return Object.freeze(normalized);
}

export function publicSecret(record) {
  return Object.freeze({
    id: record.id, realm: record.realm, label: record.label, kind: record.kind,
    scope: record.scope ? Object.freeze({ ...record.scope }) : null,
    metadata: Object.freeze({ ...(record.metadata ?? {}) }),
    fields: Object.freeze(Object.keys(record.encryptedFields).sort()), enabled: record.enabled,
    createdAt: record.createdAt, updatedAt: record.updatedAt, rotatedAt: record.rotatedAt,
    lastUsedAt: record.lastUsedAt, useCount: record.useCount,
  });
}
