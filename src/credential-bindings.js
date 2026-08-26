// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const SECRET_ID = /^sec_[A-Za-z0-9-]{1,128}$/u;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

export function normalizeCredentialBinding(value, legacyEnvironment) {
  if (value === null || value === undefined) {
    return legacyEnvironment ? environmentCredential(legacyEnvironment) : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidBinding();
  if (value.source === 'environment') return environmentCredential(value.name);
  if (value.source === 'secret') return secretCredential(value.secretId ?? value.secret_id, value.field);
  throw invalidBinding();
}

export function environmentCredential(name) {
  if (!ENVIRONMENT_NAME.test(name ?? '')) throw invalidBinding('credential environment name is invalid');
  return Object.freeze({ source: 'environment', name });
}

export function secretCredential(secretId, field) {
  if (!SECRET_ID.test(secretId ?? '') || !FIELD_NAME.test(field ?? '')) {
    throw invalidBinding('secret credential reference is invalid');
  }
  return Object.freeze({ source: 'secret', secretId, field });
}

export function credentialManifest(binding) {
  if (!binding) return undefined;
  return binding.source === 'environment'
    ? { source: 'environment', name: binding.name }
    : { source: 'secret', secret_id: binding.secretId, field: binding.field };
}

export function credentialReference(binding) {
  if (!binding) return null;
  return binding.source === 'environment' ? binding.name : `secret:${binding.secretId}#${binding.field}`;
}

export function credentialTarget(value) {
  return value ? environmentCredential(value).name : undefined;
}

export function validateCredentialHeaders(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 16) {
    throw new ContractError('invalid_mcp_headers', 'MCP header_credentials must be an object with at most sixteen entries');
  }
  const result = {};
  for (const [header, binding] of Object.entries(value)) {
    if (!/^[A-Za-z0-9-]{1,64}$/u.test(header)
      || ['authorization', 'content-type', 'accept', 'mcp-protocol-version'].includes(header.toLowerCase())) {
      throw new ContractError('invalid_mcp_headers', `MCP header ${header} is reserved or invalid`);
    }
    result[header] = normalizeCredentialBinding(binding);
  }
  return result;
}

export class CredentialResolver {
  constructor(options = {}) {
    this.secretBroker = options.secretBroker;
    this.environment = options.environment ?? process.env;
  }

  async withCredential(binding, context, consumer) {
    if (typeof consumer !== 'function') throw new ContractError('credential_consumer_invalid', 'trusted credential consumer is required');
    const normalized = normalizeCredentialBinding(binding);
    if (!normalized) return consumer(null);
    if (normalized.source === 'environment') {
      const value = this.environment[normalized.name];
      if (typeof value !== 'string' || value.length === 0) {
        throw new ContractError('missing_credential', `configured environment credential ${normalized.name} is unavailable`);
      }
      return consumer(value);
    }
    if (!this.secretBroker) throw new ContractError('missing_credential', 'configured Secret Broker credential is unavailable');
    return this.secretBroker.withSecret(normalized.secretId, {
      consumer: context.consumer,
      destination: context.destination,
      purpose: context.purpose,
      reviewerDecisionId: context.authorityRef ?? 'operator-configuration',
      sessionId: context.sessionId,
    }, async (fields) => {
      if (!(normalized.field in fields)) throw new ContractError('secret_field_not_found', 'configured secret field is unavailable');
      return consumer(fields[normalized.field]);
    });
  }
}

function invalidBinding(message = 'credential binding must select a Secret Broker field or environment variable') {
  return new ContractError('credential_binding_invalid', message);
}
