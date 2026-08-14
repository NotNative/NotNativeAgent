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

export function optionalZeroUnsetInteger(value, minimum, maximum) {
  if (value === undefined || value === null || value === 0) return null;
  return boundedInteger(value, null, minimum, maximum);
}

export function optionalZeroUnsetNumber(value, minimum, maximum) {
  if (value === undefined || value === null || value === 0) return null;
  return boundedNumber(value, null, minimum, maximum);
}

export function migrateLegacyProviderTimeoutDefaults(manifest) {
  const migrated = { ...manifest };
  if (migrated.first_token_timeout_ms === 30_000) migrated.first_token_timeout_ms = undefined;
  if (migrated.idle_timeout_ms === 45_000) migrated.idle_timeout_ms = undefined;
  return migrated;
}

export function providerTimeouts(manifest) {
  const input = migrateLegacyProviderTimeoutDefaults(manifest);
  const primaryDeadline = input.routes?.primary?.deadline_ms;
  const configured = primaryDeadline === undefined ? input.provider_timeout_ms : primaryDeadline;
  return {
    providerMs: configured === 0 ? null : boundedInteger(configured, 1_800_000, 100, 3_600_000),
    providerOverrideMs: configured === undefined ? null
      : configured === 0 ? 0 : boundedInteger(configured, null, 100, 3_600_000),
    firstTokenMs: boundedInteger(input.first_token_timeout_ms, 600_000, 100, 600_000),
    idleMs: boundedInteger(input.idle_timeout_ms, 300_000, 100, 600_000),
  };
}

export function providerRouteDeadlineOverride(value) {
  if (value === undefined) return null;
  if (value === 0) return 0;
  return boundedInteger(value, null, 100, 3_600_000);
}

export function semanticReviewTimeout(manifest, providerMs) {
  const configured = manifest.semantic_review_timeout_ms;
  // Fifteen seconds was an early default that is too short for local models and
  // was persisted into existing manifests. Migrate that exact legacy value.
  if (configured === undefined || configured === 15_000) return providerMs ?? 1_800_000;
  return boundedInteger(configured, providerMs ?? 1_800_000, 100, 3_600_000);
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
