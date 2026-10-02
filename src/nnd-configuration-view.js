// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { CONFIGURATION_CATALOG } from './configuration-catalog.js';
import { manifestFromConfig } from './provider/route-configuration.js';
import { ContractError } from './ids.js';
import { validateKeyBindings } from './experience/key-bindings.js';

const MAX_ROWS = 4096;
const LAYERS = new Set(CONFIGURATION_CATALOG.source_layers);
const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key);
const absent = () => ({ present: false });
const digest = value => createHash('sha256').update(value).digest('hex');
function invalid() { return new ContractError('nnd_configuration_view_invalid', 'Configuration view exceeds its safe projection contract.'); }

export function projectNndConfigurationView(snapshot) {
  const raw = snapshot.persistedSource?.manifest ?? {};
  const effective = snapshot.config ? effectiveManifest(snapshot.config) : {};
  const rows = [];
  for (const field of CONFIGURATION_CATALOG.fields) {
    for (const binding of bindings(field.path, raw, effective)) {
      if (rows.length >= MAX_ROWS) throw invalid();
      const explicit = valueAt(raw, binding.rawPath);
      const resolved = valueAt(effective, binding.effectivePath);
      const source = snapshot.provenance?.[binding.provenancePath];
      rows.push({ path: binding.path, catalog_path: field.path,
        ...(binding.entity ? { entity: binding.entity } : {}),
        explicit: projectValue(explicit, field, binding.entity),
        effective: { ...projectValue(resolved, field, binding.entity),
          ...(resolved.present ? LAYERS.has(source) ? { source } : { source_unavailable: true } : {}) },
        application: 'not_applied' });
    }
  }
  const revisions = (snapshot.sourceSnapshots ?? []).map(source => ({
    source: LAYERS.has(source.name) ? source.name : 'unknown',
    ...(revision(source.revision) ? { revision: source.revision } : {}),
  }));
  if (revisions.length > 8) throw invalid();
  return { schema_version: '1.0', installation_id: boundedIdentity(snapshot.installationId ?? snapshot.instanceId),
    data_id: boundedIdentity(snapshot.dataId), scope: 'user',
    source_state: ['present', 'missing', 'invalid'].includes(snapshot.sourceState) ? snapshot.sourceState : 'invalid',
    source_revision: revision(snapshot.sourceRevision) ? snapshot.sourceRevision : null,
    resolution_revision: revision(snapshot.resolutionRevision) ? snapshot.resolutionRevision : null,
    source_revisions: revisions, application: 'not_applied', fields: rows };
}

function effectiveManifest(config) {
  // Persistence serialization deliberately omits defaults and inherited route assignments.
  // The read surface must display the actual native resolution without changing that serializer.
  const manifest = manifestFromConfig(config);
  manifest.application_system_prompt = config.applicationPolicy;
  manifest.provider_timeout_ms = config.limits.providerMs;
  manifest.first_token_timeout_ms = config.limits.firstTokenMs;
  manifest.idle_timeout_ms = config.limits.idleMs;
  manifest.recovery.turn_wall_clock_ms = config.recovery.turnWallClockMs;
  manifest.tui.key_bindings = validateKeyBindings(config.tui.keyBindings);
  manifest.providers.forEach(provider => {
    const profile = config.providerProfiles[provider.id];
    provider.tool_call_mode = profile.toolCallMode;
    provider.context_limit_bytes = profile.contextLimitBytes;
    provider.output_limit_tokens = profile.outputLimitTokens;
    provider.capabilities = { ...profile.capabilities, structured_output: profile.capabilities.structuredOutput };
  });
  for (const [role, route] of Object.entries(config.routes)) {
    Object.assign(manifest.routes[role], { provider_id: route.providerId, model: route.model,
      context_limit_bytes: route.contextLimitBytes, temperature: route.temperature, deadline_ms: route.deadlineMs });
  }
  return manifest;
}

function boundedIdentity(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw invalid();
  return value;
}
function revision(value) { return typeof value === 'string' && /^(?:absent|[a-f0-9]{64})$/u.test(value); }
function valueAt(root, parts) {
  if (!parts) return absent();
  let value = root;
  for (const part of parts) { if (!own(value, part)) return absent(); value = value[part]; }
  return { present: true, value };
}
function projectValue(observed, field, entity) {
  if (!observed.present) return absent();
  if (entity && field.path.endsWith('.id')) return { present: true, value: entity.id };
  if (field.sensitivity === 'credential_reference' || field.path === 'mcp_servers[*].args') {
    return { present: true, redacted: true };
  }
  const value = observed.value;
  // Containers never copy unknown children, even when their catalog sensitivity is public.
  if (value !== null && typeof value === 'object') {
    if (field.classification === 'container' || !Array.isArray(value)
      || value.length > 128 || value.some(item => !scalar(item))) return { present: true, value_unavailable: true };
    return { present: true, value: [...value] };
  }
  return scalar(value) ? { present: true, value } : { present: true, value_unavailable: true };
}
function scalar(value) {
  return value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
    || typeof value === 'string' && value.length <= 4096;
}

function bindings(path, raw, effective) {
  if (path.includes('{')) return [];
  const match = /^(providers|mcp_servers)\[\*\]\.(.+)$/u.exec(path);
  if (!match) {
    if (path.includes('[*]')) return [];
    const parts = path.split('.');
    const resolved = path.startsWith('provider.') ? ['providers', '0', ...parts.slice(1)] : parts;
    return [{ path, rawPath: parts, effectivePath: resolved, provenancePath: path }];
  }
  const [, collection, tail] = match;
  const explicit = Array.isArray(raw[collection]) ? raw[collection] : [];
  const resolved = Array.isArray(effective[collection]) ? effective[collection] : [];
  if (explicit.length > 128 || resolved.length > 128) throw invalid();
  const items = new Map();
  function add(list, key) {
    list.forEach((item, index) => {
      if (typeof item?.id !== 'string' || item.id.length > 256) return;
      const entry = items.get(item.id) ?? { id: item.id };
      if (entry[key] !== undefined) throw invalid();
      entry[key] = index; items.set(item.id, entry);
    });
  }
  add(explicit, 'rawIndex'); add(resolved, 'effectiveIndex');
  return [...items.values()].map(item => {
    const id = /^[A-Za-z0-9_-]{1,64}$/u.test(item.id) ? item.id : `id_${digest(item.id)}`;
    const suffix = tail.split('.');
    return { path: `${collection}[${id}].${tail}`, entity: { kind: collection, id },
      rawPath: item.rawIndex === undefined ? null : [collection, String(item.rawIndex), ...suffix],
      effectivePath: item.effectiveIndex === undefined ? null : [collection, String(item.effectiveIndex), ...suffix],
      provenancePath: `${collection}.${item.effectiveIndex}.${tail}` };
  });
}
