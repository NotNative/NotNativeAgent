// SPDX-License-Identifier: Apache-2.0
import { resolveManifest } from './config.js';
import { ContractError } from './ids.js';
import { manifestFromConfig } from './provider/route-configuration.js';

export function resolveConfiguration(sources, options = {}) {
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > 8) {
    throw new ContractError('configuration_sources_invalid', 'configuration requires one to eight ordered sources');
  }
  let merged = {};
  const winners = {};
  for (const source of sources) {
    if (!source || typeof source.name !== 'string' || !isRecord(source.manifest)) {
      throw new ContractError('configuration_source_invalid', 'configuration source is invalid');
    }
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
  audit?.({
    type: 'configuration_security_rejected', outcome: 'failed', code: error.code,
    reason_code: error.code, configuration_key: key, configuration_source: source,
  });
}

function merge(base, incoming, prefix, source, winners) {
  const result = isRecord(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(incoming)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value)) result[key] = merge(isRecord(result[key]) ? result[key] : {}, value, path, source, winners);
    else {
      result[key] = structuredClone(value);
      winners[path] = source;
    }
  }
  return result;
}

function effectiveProvenance(manifest, winners) {
  const result = { ...winners };
  for (const path of leafPaths(manifest)) result[path] ??= winningSource(path, winners) ?? 'compiled_default';
  return Object.freeze(result);
}

function leafPaths(value) {
  const paths = [];
  const pending = [{ value, path: '', depth: 0 }];
  while (pending.length > 0 && paths.length < 4096) {
    const item = pending.pop();
    if (item.depth > 16) throw new ContractError('configuration_depth', 'effective configuration exceeds provenance depth');
    if (isRecord(item.value)) {
      for (const [key, child] of Object.entries(item.value)) pending.push({ value: child, path: joinPath(item.path, key), depth: item.depth + 1 });
    } else if (Array.isArray(item.value)) {
      item.value.forEach((child, index) => pending.push({ value: child, path: joinPath(item.path, index), depth: item.depth + 1 }));
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
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
