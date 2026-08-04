// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

export function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ContractError('invalid_limit', `limit must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function boundedNumber(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ContractError('invalid_limit', `value must be a number from ${minimum} to ${maximum}`);
  }
  return value;
}

export function migrateLegacyProviderTimeoutDefaults(manifest) {
  if (manifest.provider_timeout_ms !== 120_000 || manifest.first_token_timeout_ms !== 30_000
    || manifest.idle_timeout_ms !== 45_000) return manifest;
  return { ...manifest, provider_timeout_ms: undefined, first_token_timeout_ms: undefined, idle_timeout_ms: undefined };
}

export function providerTimeouts(manifest) {
  const input = migrateLegacyProviderTimeoutDefaults(manifest);
  return {
    providerMs: boundedInteger(input.provider_timeout_ms, 1_800_000, 100, 3_600_000),
    firstTokenMs: boundedInteger(input.first_token_timeout_ms, 600_000, 100, 600_000),
    idleMs: boundedInteger(input.idle_timeout_ms, 300_000, 100, 600_000),
  };
}

export function telemetryDestination(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || value.length > 2048) throw new Error('invalid');
    return url.href;
  } catch {
    throw new ContractError('telemetry_destination_invalid', 'telemetry destination must be a credential-free HTTP(S) URL');
  }
}
