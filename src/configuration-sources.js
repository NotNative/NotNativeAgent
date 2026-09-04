// SPDX-License-Identifier: Apache-2.0
import { resolveManifest } from './config.js';
import { ContractError } from './ids.js';
import { manifestFromConfig } from './provider/route-configuration.js';

// These bounds comfortably exceed the supported manifest while containing hostile programmatic input.
const MAX_PROVENANCE_PATHS = 4_096;
const MAX_PROVENANCE_DEPTH = 16;
const RESERVED_CONFIGURATION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function resolveConfiguration(sources, options = {}) {
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > 8) {
    throw new ContractError('configuration_sources_invalid', 'configuration requires one to eight ordered sources');
  }
  let merged = Object.create(null);
  const winners = Object.create(null);
  for (const source of sources) {
    if (!source || typeof source.name !== 'string' || !isRecord(source.manifest)) {
      throw new ContractError('configuration_source_invalid', 'configuration source is invalid');
    }
    leafPaths(source.manifest);
    merged = merge(merged, source.manifest, '', source.name, winners);
  }
  let resolved;
  try {
    resolved = resolveManifest(merged);
  } catch (error) {
    attributeSecurityRejection(error, winners, options.securityAudit);
    throw error;
  }
  const provenance = effectiveProvenance(manifestFromConfig(resolved), winners);
  const config = Object.freeze({ ...resolved, configurationProvenance: provenance });
  return Object.freeze({ config, provenance });
}

function attributeSecurityRejection(error, winners, audit) {
  if (!['review_floor_violation', 'unknown_security_key'].includes(error?.code)) return;
  const key = error.configurationKey ?? 'unknown';
  const source = winners[key] ?? 'unknown';
  error.configurationSource = source;
  try {
    audit?.({
      type: 'configuration_security_rejected', outcome: 'failed', code: error.code,
      reason_code: error.code, configuration_key: key, configuration_source: source,
    });
  } catch (auditError) {
    error.auditFailureCode = auditError?.code ?? 'configuration_audit_failed';
  }
}

function merge(base, incoming, prefix, source, winners, ancestors = new Set()) {
  if (ancestors.has(incoming)) throw new ContractError('configuration_cycle', 'configuration sources must not contain cycles');
  ancestors.add(incoming);
  const result = Object.assign(Object.create(null), isRecord(base) ? base : null);
  for (const [key, value] of Object.entries(incoming)) {
    if (RESERVED_CONFIGURATION_KEYS.has(key)) {
      throw new ContractError('configuration_source_invalid', 'configuration source contains a reserved key');
    }
    const path = prefix ? `${prefix}.${key}` : key;
    if (!isRecord(value) || !isRecord(result[key])) clearWinners(winners, path);
    if (isRecord(value)) {
      result[key] = merge(isRecord(result[key]) ? result[key] : Object.create(null), value, path, source, winners, ancestors);
    }
    else {
      result[key] = structuredClone(value);
      winners[path] = source;
    }
  }
  ancestors.delete(incoming);
  return result;
}

function clearWinners(winners, path) {
  for (const key of Object.keys(winners)) {
    if (key === path || key.startsWith(`${path}.`)) delete winners[key];
  }
}

function effectiveProvenance(manifest, winners) {
  const result = Object.create(null);
  for (const path of leafPaths(manifest)) {
    result[path] = winningSource(path, winners) ?? 'compiled_default';
    if (path.startsWith('providers.0.') && !Object.hasOwn(winners, 'providers')) {
      const alias = `provider.${path.slice('providers.0.'.length)}`;
      if (Object.hasOwn(winners, alias)) result[alias] = winners[alias];
    }
  }
  return Object.freeze({ ...result });
}

function leafPaths(value) {
  const paths = [];
  let nodes = 0;
  const pending = [{ value, path: '', depth: 0, ancestors: new Set() }];
  while (pending.length > 0 && paths.length < MAX_PROVENANCE_PATHS) {
    const item = pending.pop();
    nodes += 1;
    if (nodes > MAX_PROVENANCE_PATHS) throw new ContractError('configuration_size', 'configuration structure exceeds provenance bound');
    if (item.depth > MAX_PROVENANCE_DEPTH) throw new ContractError('configuration_depth', 'effective configuration exceeds provenance depth');
    if (item.value && typeof item.value === 'object' && item.ancestors.has(item.value)) {
      throw new ContractError('configuration_cycle', 'effective configuration must not contain cycles');
    }
    const ancestors = new Set(item.ancestors);
    if (item.value && typeof item.value === 'object') ancestors.add(item.value);
    if (isRecord(item.value)) {
      for (const [key, child] of Object.entries(item.value)) pending.push({ value: child, path: joinPath(item.path, key), depth: item.depth + 1, ancestors });
    } else if (Array.isArray(item.value)) {
      item.value.forEach((child, index) => pending.push({ value: child, path: joinPath(item.path, index), depth: item.depth + 1, ancestors }));
    } else paths.push(item.path);
  }
  if (pending.length > 0) throw new ContractError('configuration_size', 'effective configuration exceeds provenance bound');
  return paths;
}

function winningSource(path, winners) {
  const aliases = path.startsWith('providers.0.') && !Object.hasOwn(winners, 'providers')
    ? [`provider.${path.slice('providers.0.'.length)}`, path] : [path];
  for (const candidate of aliases) {
    const parts = candidate.split('.');
    while (parts.length > 0) {
      const source = winners[parts.join('.')];
      if (source) return source;
      parts.pop();
    }
  }
  return null;
}

function joinPath(base, key) { return base ? `${base}.${key}` : String(key); }

function isRecord(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
