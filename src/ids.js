// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_ID_PREFIX = /^[A-Za-z][A-Za-z0-9_:-]{0,63}$/u;

export function newId(prefix) {
  if (typeof prefix !== 'string' || !SAFE_ID_PREFIX.test(prefix)) {
    throw new ContractError('invalid_id_prefix', 'generated identifier prefix is invalid');
  }
  return `${prefix}_${randomUUID()}`;
}

export function requireExternalId(value, field = 'request_id') {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new ContractError('invalid_id', `${field} is not a valid bounded identifier`);
  }
  return value;
}

export class ContractError extends Error {
  constructor(code, message, retryable = false, options = undefined) {
    if (retryable && typeof retryable === 'object') {
      options = retryable;
      retryable = false;
    }
    super(message, options);
    this.name = 'ContractError';
    this.code = code;
    this.retryable = retryable;
    // Why optional: most contract refusals have no opinion about transport and
    // stay 400. A surface that knows a refusal is about capacity rather than a
    // malformed request sets this so the route answers 429 and the caller
    // retries instead of discarding what it admitted.
    if (Number.isInteger(options?.httpStatus)) this.httpStatus = options.httpStatus;
  }
}
