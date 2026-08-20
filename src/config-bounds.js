// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 86_400_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 1_800_000;
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 600_000;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const MAX_STREAM_TIMEOUT_MS = 86_400_000;
const LEGACY_FIRST_TOKEN_TIMEOUT_MS = 30_000;
const LEGACY_IDLE_TIMEOUT_MS = 45_000;
const LEGACY_SEMANTIC_REVIEW_TIMEOUT_MS = 15_000;

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
  if (migrated.first_token_timeout_ms === LEGACY_FIRST_TOKEN_TIMEOUT_MS) migrated.first_token_timeout_ms = undefined;
  if (migrated.idle_timeout_ms === LEGACY_IDLE_TIMEOUT_MS) migrated.idle_timeout_ms = undefined;
  // These values were persisted as mandatory defaults before trusted local
  // inference adopted opt-in stream deadlines. Treat the exact former pair as
  // inherited policy so existing installations receive the safer behavior.
  if (migrated.first_token_timeout_ms === DEFAULT_FIRST_TOKEN_TIMEOUT_MS
    && migrated.idle_timeout_ms === DEFAULT_IDLE_TIMEOUT_MS) {
    migrated.first_token_timeout_ms = undefined;
    migrated.idle_timeout_ms = undefined;
  }
  return migrated;
}

export function providerTimeouts(manifest) {
  const input = migrateLegacyProviderTimeoutDefaults(manifest);
  const primaryDeadline = input.routes?.primary?.deadline_ms;
  const configured = primaryDeadline === undefined ? input.provider_timeout_ms : primaryDeadline;
  const firstTokenConfigured = input.first_token_timeout_ms;
  const idleConfigured = input.idle_timeout_ms;
  return {
    providerMs: configured === 0 ? null : boundedInteger(configured, DEFAULT_PROVIDER_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    providerOverrideMs: providerOverride(configured),
    firstTokenMs: firstTokenConfigured === 0 ? null
      : boundedInteger(firstTokenConfigured, DEFAULT_FIRST_TOKEN_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_STREAM_TIMEOUT_MS),
    firstTokenOverrideMs: streamOverride(firstTokenConfigured),
    idleMs: idleConfigured === 0 ? null
      : boundedInteger(idleConfigured, DEFAULT_IDLE_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_STREAM_TIMEOUT_MS),
    idleOverrideMs: streamOverride(idleConfigured),
  };
}

export function providerRouteDeadlineOverride(value) {
  if (value === undefined) return null;
  if (value === 0) return 0;
  return boundedInteger(value, null, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
}

export function semanticReviewTimeout(manifest, providerMs) {
  const configured = manifest.semantic_review_timeout_ms;
  // Fifteen seconds was an early default that is too short for local models and
  // was persisted into existing manifests. Migrate that exact legacy value.
  if (configured === undefined || configured === LEGACY_SEMANTIC_REVIEW_TIMEOUT_MS) return providerMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  return boundedInteger(configured, providerMs ?? DEFAULT_PROVIDER_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
}

function providerOverride(configured) {
  if (configured === undefined) return null;
  if (configured === 0) return 0;
  return boundedInteger(configured, null, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
}

function streamOverride(configured) {
  if (configured === undefined) return null;
  if (configured === 0) return 0;
  return boundedInteger(configured, null, MIN_TIMEOUT_MS, MAX_STREAM_TIMEOUT_MS);
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
