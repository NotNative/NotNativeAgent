// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { ROLES } from './contracts.js';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validateKeyBindings } from './key-bindings.js';
import { validateNestedManifestKeys } from './configuration-shape.js';
import { boundedInteger, boundedNumber, providerTimeouts, semanticReviewTimeout, telemetryDestination } from './config-bounds.js';
import { resolveContextLimits } from './config-context.js';
import { validateAllowedTools, validateHostIdentity } from './execution-policy.js';
import { skillGrantDigest, validateHostedSkills } from './skill-registry.js';
import { migrateRoutingInheritance } from './manifest-migration.js';
import { validateDream } from './dream-config.js';
const TRUST_ZONES = new Set(['loopback', 'private_network', 'public_network']);
const ROUTE_CAPABILITIES = new Set(['streaming', 'tools', 'images', 'structured_output', 'usage', 'cancellation']);
const MISSION_EFFECTS = new Set(['read_only', 'reversible', 'irreversible', 'unknown']);
const MISSION_CONDITIONS = new Set([
  'review_denial', 'provider_failure', 'tool_failure', 'unknown_effect', 'cancellation',
  'budget_exhaustion', 'expiration', 'disconnect',
]);
const KNOWN_KEYS = new Set([
  'format_version', 'routing_inheritance_version', 'persistence', 'provider', 'providers', 'routes', 'application_system_prompt', 'mission',
  'workspace_root', 'provider_timeout_ms', 'first_token_timeout_ms', 'idle_timeout_ms',
  'provider_connect_timeout_ms', 'semantic_review_timeout_ms', 'approval_timeout_ms',
  'provider_concurrency', 'provider_queue_limit', 'tool_concurrency',
  'persistence_flush_timeout_ms', 'shutdown_timeout_ms',
  'context_limit_bytes', 'context_compression_threshold', 'context_compaction_threshold', 'attachments', 'memory', 'dream', 'mcp_servers', 'tui', 'telemetry',
  'allowed_capabilities', 'allowed_tools', 'disconnect_policy', 'skills',
  'reviewer_ledger', 'recovery',
]);
export function resolveManifest(manifest = {}, options = {}) {
  if (!isRecord(manifest)) throw new ContractError('invalid_manifest', 'manifest must be an object');
  assertManifestVersion(manifest.format_version);
  rejectReviewOverrides(manifest);
  const warnings = validateManifestKeys(manifest);
  warnings.push(...validateNestedManifestKeys(manifest));
  const profiles = validateProviders(manifest);
  const profile = Object.values(profiles)[0];
  const persistence = manifest.persistence ?? 'durable';
  if (!['durable', 'ephemeral'].includes(persistence)) {
    throw new ContractError('invalid_persistence', 'persistence must be durable or ephemeral');
  }
  const { providerMs, firstTokenMs, idleMs } = providerTimeouts(manifest);
  const connectMs = boundedInteger(manifest.provider_connect_timeout_ms, 10_000, 100, 600_000);
  const semanticReviewMs = semanticReviewTimeout(manifest, providerMs);
  const approvalMs = boundedInteger(manifest.approval_timeout_ms, 120_000, 1_000, 3_600_000);
  const providerConcurrency = boundedInteger(manifest.provider_concurrency, 1, 1, 16);
  const providerQueueLimit = boundedInteger(manifest.provider_queue_limit, 256, 1, 4096);
  const toolConcurrency = boundedInteger(manifest.tool_concurrency, 1, 1, 16);
  const persistenceFlushMs = boundedInteger(manifest.persistence_flush_timeout_ms, 10_000, 100, 120_000);
  const shutdownMs = boundedInteger(manifest.shutdown_timeout_ms, 15_000, 100, 120_000);
  const routes = buildRoutes(manifest.routes, profile, profiles, providerMs);
  const context = resolveContextLimits(manifest);
  const skills = validateManifestSkills(manifest.skills, options);
  const executionManifest = validateExecutionManifest(manifest, options, routes, profiles, skills);
  const attachments = validateAttachments(manifest.attachments);
  const memory = validateMemory(manifest.memory);
  const dream = validateDream(manifest.dream, executionManifest);
  const mcpServers = validateMcpServers(manifest.mcp_servers);
  const recovery = validateRecovery(manifest.recovery);
  return deepFreeze({
    version: 1,
    persistence,
    providerProfiles: profiles,
    routes,
    applicationPolicy: stringOrEmpty(manifest.application_system_prompt),
    skills: executionManifest && !executionManifest.allowedCapabilities.includes('skills') ? Object.freeze([]) : skills,
    mission: validateMission(manifest.mission, options.missionPrincipal),
    workspaceRoot: resolve(optionalString(manifest.workspace_root) ?? process.cwd()),
    attachments: capabilityConfig(attachments, executionManifest, 'attachments'),
    memory: capabilityConfig(memory, executionManifest, 'memory'),
    dream,
    mcpServers: executionManifest && !executionManifest.allowedCapabilities.includes('mcp')
      ? mcpServers.map((server) => ({ ...server, enabled: false })) : mcpServers,
    limits: {
      providerMs, connectMs, firstTokenMs, idleMs, semanticReviewMs, approvalMs,
      providerConcurrency, providerQueueLimit, toolConcurrency, persistenceFlushMs, shutdownMs,
      maxOutputBytes: 2_097_152, maxModelSteps: recovery.maxModelSteps,
      ...context, maxSteering: 32,
    },
    provenance: options.principal ?? 'authenticated-local-operator',
    executionManifest,
    reviewerLedger: validateReviewerLedger(manifest.reviewer_ledger),
    recovery,
    warnings,
    tui: validateTui(manifest.tui),
    telemetry: validateTelemetry(manifest.telemetry),
  });
}
function validateRecovery(value) {
  const input = isRecord(value) ? value : {};
  const maxModelSteps = boundedInteger(input.max_model_steps, 1024, 16, 100_000);
  const localLimit = boundedInteger(input.local_retry_limit, 3, 2, 5);
  const ladder = input.ladder ?? ['nudge', 'compact', 'compact', 'compact'];
  if (!Array.isArray(ladder) || ladder.length < localLimit - 1 || ladder.length > 4
    || ladder.some((item) => !['nudge', 'compact'].includes(item))) {
    throw new ContractError('recovery_config_invalid', 'recovery ladder must provide one to four supported bounded actions');
  }
  return { maxModelSteps, localLimit, ladder: ladder.slice(0, localLimit - 1) };
}
function validateReviewerLedger(value) {
  const input = isRecord(value) ? value : {};
  if (Object.keys(input).some((key) => key !== 'retention_entries')) {
    throw new ContractError('reviewer_ledger_config_invalid', 'reviewer_ledger contains an unknown setting');
  }
  return { retentionEntries: boundedInteger(input.retention_entries, 10_000, 1, 100_000) };
}
function validateManifestSkills(value, options) {
  if (value === undefined) return Object.freeze([]);
  if (options.principal !== 'authenticated-stdio-host') {
    throw new ContractError('hosted_skills_forbidden', 'only an authenticated headless host may supply inline skills');
  }
  return validateHostedSkills(value);
}
function validateExecutionManifest(manifest, options, routes, profiles, skills) {
  const supplied = manifest.allowed_capabilities !== undefined || manifest.allowed_tools !== undefined
    || manifest.disconnect_policy !== undefined || manifest.skills !== undefined;
  if (!options.executionManifestId && !supplied) return null;
  if (options.principal !== 'authenticated-stdio-host') {
    throw new ContractError('execution_manifest_forbidden', 'only an authenticated headless host may supply execution policy');
  }
  const allowed = manifest.allowed_capabilities ?? ['tools', 'steering', 'attachments', 'memory', 'mcp', 'skills'];
  const known = new Set(['tools', 'steering', 'attachments', 'memory', 'mcp', 'skills']);
  if (!Array.isArray(allowed) || allowed.length > known.size
    || allowed.some((item) => typeof item !== 'string' || !known.has(item)) || new Set(allowed).size !== allowed.length) {
    throw new ContractError('execution_capabilities_invalid', 'allowed_capabilities contains an invalid or duplicate capability');
  }
  const disconnectPolicy = manifest.disconnect_policy ?? 'cancel';
  if (disconnectPolicy !== 'cancel') {
    throw new ContractError('disconnect_policy_unsupported', 'only cancel-on-disconnect is supported');
  }
  const primary = routes.primary;
  const provider = profiles[primary.providerId];
  const allowedTools = validateAllowedTools(manifest.allowed_tools);
  return {
    id: options.executionManifestId, hostOrigin: options.hostOrigin ?? 'stdio-parent',
    principal: options.principal, hostIdentity: validateHostIdentity(options.hostIdentity),
    allowedCapabilities: [...allowed], allowedTools, disconnectPolicy,
    workspaceRoot: resolve(optionalString(manifest.workspace_root) ?? process.cwd()),
    persistence: manifest.persistence ?? 'durable', configurationVersion: 1,
    primaryRoute: {
      providerId: primary.providerId, model: primary.model, endpoint: provider.endpoint,
      trustZone: provider.trustZone, credentialRef: provider.credentialEnv ?? null,
    },
    applicationPolicy: {
      present: typeof manifest.application_system_prompt === 'string' && manifest.application_system_prompt.length > 0,
      sha256: createHash('sha256').update(stringOrEmpty(manifest.application_system_prompt)).digest('hex'),
    },
    skillGrant: skillGrantDigest(skills),
  };
}
function capabilityConfig(value, executionManifest, capabilityName) {
  if (!executionManifest || executionManifest.allowedCapabilities.includes(capabilityName)) return value;
  return { ...value, enabled: false, required: false };
}
export function migrateManifestDocument(manifest) {
  if (!isRecord(manifest)) throw new ContractError('invalid_manifest', 'manifest must be an object');
  assertManifestVersion(manifest.format_version);
  return migrateRoutingInheritance(manifest);
}
function assertManifestVersion(value) {
  if (value === undefined || value === 1) return;
  if (Number.isInteger(value) && value > 1) {
    throw new ContractError('manifest_version_future', `configuration format ${value} is newer than supported format 1`);
  }
  throw new ContractError('manifest_version_invalid', 'configuration format_version must be the integer 1');
}
function validateProviders(manifest) {
  const values = Array.isArray(manifest.providers) ? manifest.providers : [manifest.provider];
  if (values.length === 0 || values.length > 16) {
    throw new ContractError('invalid_providers', 'one to sixteen providers are required');
  }
  const result = {};
  for (const value of values) {
    const profile = validateProvider(value);
    if (result[profile.id]) throw new ContractError('duplicate_provider', `duplicate provider ${profile.id}`);
    result[profile.id] = profile;
  }
  return result;
}
function validateProvider(value) {
  if (!isRecord(value)) throw new ContractError('missing_provider', 'manifest provider is required');
  const endpoint = parseEndpoint(value.endpoint);
  const expectedZone = endpointZone(endpoint);
  if (!TRUST_ZONES.has(value.trust_zone) || value.trust_zone !== expectedZone) {
    throw new ContractError('invalid_trust_zone', `endpoint requires trust zone ${expectedZone}`);
  }
  if (typeof value.model !== 'string' || value.model.length === 0 || value.model.length > 256) {
    throw new ContractError('invalid_model', 'provider model is required and bounded');
  }
  return {
    id: typeof value.id === 'string' ? value.id : 'manifest-primary',
    displayName: optionalString(value.display_name) ?? (typeof value.id === 'string' ? value.id : 'Manifest primary'),
    endpoint: endpoint.href.replace(/\/$/u, ''),
    model: value.model,
    trustZone: value.trust_zone,
    credentialEnv: optionalString(value.credential_env),
    contextLimitBytes: optionalBoundedInteger(value.context_limit_bytes, 65_536, 16_777_216),
    outputLimitTokens: optionalBoundedInteger(value.output_limit_tokens, 1, 1_048_576),
    capabilities: Object.freeze({
      streaming: true,
      tools: capability(value.capabilities?.tools),
      images: capability(value.capabilities?.images),
      structuredOutput: capability(value.capabilities?.structured_output),
      usage: capability(value.capabilities?.usage),
      cancellation: capability(value.capabilities?.cancellation),
    }),
  };
}
function validateManifestKeys(manifest) {
  const warnings = [];
  for (const key of Object.keys(manifest)) {
    if (KNOWN_KEYS.has(key)) continue;
    if (/review|permission|ledger|revalid|auto.?approv|security|sandbox/iu.test(key)) {
      throw configurationError('unknown_security_key', `unknown security-relevant manifest key ${key}`, key);
    }
    warnings.push(`unknown manifest key ignored: ${key}`);
  }
  return warnings;
}
function validateTui(value) {
  const input = isRecord(value) ? value : {};
  const bindings = isRecord(input.key_bindings) ? { ...input.key_bindings } : {};
  for (const [action, key] of Object.entries(bindings)) {
    if (!/^[a-z_]{1,32}$/u.test(action) || typeof key !== 'string' || key.length > 32) {
      throw new ContractError('invalid_key_binding', 'TUI key binding is invalid');
    }
  }
  validateKeyBindings(bindings);
  return { reducedMotion: input.reduced_motion === true, color: input.color !== false, keyBindings: bindings };
}
function validateTelemetry(value) {
  const input = isRecord(value) ? value : {};
  const enabled = input.enabled === true;
  if (enabled && typeof input.destination !== 'string') {
    throw new ContractError('telemetry_destination_required', 'enabled telemetry requires an explicit destination');
  }
  const destination = enabled ? telemetryDestination(input.destination) : null;
  return { enabled, destination, retention: enabled ? optionalString(input.retention) : null };
}

function buildRoutes(value, profile, profiles, providerMs) {
  const input = isRecord(value) ? value : {};
  const result = {};
  for (const role of ROLES) {
    const route = isRecord(input[role]) ? input[role] : {};
    const assigned = role === 'primary' || route.provider_id != null || route.model != null;
    const inherited = role === 'primary' ? null : result.primary;
    const providerId = assigned ? (route.provider_id ?? profile.id) : inherited.providerId;
    const model = assigned ? (route.model ?? profiles[providerId]?.model ?? profile.model) : inherited.model;
    const fallbacks = validateFallbacks(route.fallbacks);
    result[role] = Object.freeze({
      role, assigned, providerId, model,
      contextLimitBytes: optionalBoundedInteger(route.context_limit_bytes, 65_536, 16_777_216)
        ?? profiles[providerId]?.contextLimitBytes ?? null,
      requiredCapabilities: validateRouteCapabilities(route.required_capabilities),
      temperature: boundedNumber(route.temperature, role === 'reviewer' ? 0 : 0.2, 0, 2),
      maxOutputTokens: boundedInteger(route.max_output_tokens, 16_384, 1, 1_048_576),
      budget: boundedInteger(route.budget, 1, 1, 64),
      fallbacks,
      deadlineMs: boundedInteger(route.deadline_ms, providerMs, 100, 3_600_000),
    });
    if (!profiles[result[role].providerId]) {
      throw new ContractError('route_profile_missing', `route ${role} references an unavailable provider`);
    }
  }
  validateRouteGraph(result);
  return result;
}

function validateAttachments(value) {
  const input = isRecord(value) ? value : {};
  return {
    enabled: input.enabled !== false,
    maxBytes: boundedInteger(input.max_bytes, 10_485_760, 1_024, 104_857_600),
    retain: input.retain === true,
  };
}

function validateMemory(value) {
  const input = isRecord(value) ? value : {};
  return {
    enabled: input.enabled !== false,
    required: input.required === true,
    timeoutMs: boundedInteger(input.timeout_ms, 750, 50, 30_000),
    maxItems: boundedInteger(input.max_items, 8, 1, 64),
    maxBytes: boundedInteger(input.max_bytes, 16_384, 1_024, 262_144),
  };
}

function validateMcpServers(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) {
    throw new ContractError('invalid_mcp_config', 'mcp_servers must be an array of at most sixteen entries');
  }
  const ids = new Set();
  return value.map((entry) => {
    if (!isRecord(entry) || !/^[A-Za-z0-9_-]{1,64}$/u.test(entry.id ?? '') || ids.has(entry.id)) {
      throw new ContractError('invalid_mcp_config', 'MCP server ids must be unique safe identifiers');
    }
    ids.add(entry.id);
    return validateMcpServer(entry);
  });
}

function validateMcpServer(entry) {
  if (!['stdio', 'streamable_http'].includes(entry.transport)) {
    throw new ContractError('invalid_mcp_transport', 'MCP transport must be stdio or streamable_http');
  }
  const common = {
    id: entry.id, transport: entry.transport, enabled: entry.enabled === true,
    timeoutMs: boundedInteger(entry.timeout_ms, 20_000, 100, 120_000),
    connectTimeoutMs: boundedInteger(entry.connect_timeout_ms, entry.timeout_ms ?? 20_000, 100, 120_000),
    listTimeoutMs: boundedInteger(entry.list_timeout_ms, entry.timeout_ms ?? 20_000, 100, 120_000),
    callTimeoutMs: boundedInteger(entry.call_timeout_ms, entry.timeout_ms ?? 20_000, 100, 120_000),
    shutdownTimeoutMs: boundedInteger(entry.shutdown_timeout_ms, 2_000, 100, 30_000),
    effects: isRecord(entry.tool_effects) ? { ...entry.tool_effects } : {},
    credentialEnv: optionalString(entry.credential_env),
    headerEnv: validateHeaderEnvironment(entry.header_env),
    trusted: entry.trusted === true,
    protocolVersion: entry.protocol_version ?? '2026-07-28',
  };
  if (entry.transport === 'stdio') {
    if (typeof entry.command !== 'string' || entry.command.length === 0) {
      throw new ContractError('invalid_mcp_command', 'stdio MCP requires an explicit command');
    }
    return { ...common, command: entry.command, args: stringArray(entry.args), cwd: optionalString(entry.cwd) };
  }
  const endpoint = parseEndpoint(entry.endpoint);
  return { ...common, endpoint: endpoint.href };
}

function validateHeaderEnvironment(value) {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > 16) {
    throw new ContractError('invalid_mcp_headers', 'MCP header_env must be an object with at most sixteen entries');
  }
  const result = {};
  for (const [header, environmentName] of Object.entries(value)) {
    if (!/^[A-Za-z0-9-]{1,64}$/u.test(header) || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(environmentName)) {
      throw new ContractError('invalid_mcp_headers', 'MCP header_env entries must map safe header names to environment variables');
    }
    if (['authorization', 'content-type', 'accept', 'mcp-protocol-version'].includes(header.toLowerCase())) {
      throw new ContractError('invalid_mcp_headers', `MCP header ${header} is reserved`);
    }
    result[header] = environmentName;
  }
  return result;
}

function stringArray(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64 || value.some((item) => typeof item !== 'string')) {
    throw new ContractError('invalid_mcp_args', 'MCP args must be a bounded string array');
  }
  return [...value];
}

function capability(value) {
  return value === true ? true : value === false ? false : 'unknown';
}

function validateRouteGraph(routes) {
  const visit = (role, path = []) => {
    if (path.includes(role)) throw new ContractError('route_cycle', `route cycle includes ${[...path, role].join(' -> ')}`);
    for (const fallback of routes[role].fallbacks) visit(fallback, [...path, role]);
  };
  for (const role of Object.keys(routes)) visit(role);
}

function validateFallbacks(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 4 || value.some((item) => !ROLES.includes(item))) {
    throw new ContractError('invalid_route_fallback', 'route fallbacks must name at most four known roles');
  }
  if (new Set(value).size !== value.length) throw new ContractError('invalid_route_fallback', 'route fallbacks must be unique');
  return Object.freeze([...value]);
}

function validateRouteCapabilities(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > ROUTE_CAPABILITIES.size
    || value.some((item) => !ROUTE_CAPABILITIES.has(item))) {
    throw new ContractError('invalid_route_capability', 'route capability requirements are invalid');
  }
  return Object.freeze([...new Set(value)]);
}

function validateMission(value, principal) {
  if (value === undefined) return null;
  if (principal !== 'authenticated-stdio-host') {
    throw new ContractError('mission_authority_forbidden', 'only an authenticated headless host may supply mission authority');
  }
  if (!isRecord(value) || typeof value.outcome !== 'string' || value.outcome.length === 0) {
    throw new ContractError('invalid_mission', 'mission requires an intended outcome');
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value.id ?? '') || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.revocation_id ?? '')) {
    throw new ContractError('invalid_mission', 'mission and revocation identities must be bounded safe identifiers');
  }
  const notBefore = Date.parse(value.not_before);
  const expiresAt = Date.parse(value.expires_at);
  if (!Number.isFinite(notBefore) || !Number.isFinite(expiresAt) || notBefore >= expiresAt) {
    throw new ContractError('invalid_mission', 'mission requires an ordered not_before and expires_at schedule');
  }
  const bounds = isRecord(value.bounds) ? value.bounds : {};
  const allowed = new Set(['max_turns', 'max_tool_calls', 'max_duration_ms']);
  if (Object.keys(bounds).some((key) => !allowed.has(key))) throw new ContractError('invalid_mission', 'mission resource bounds are invalid');
  const resources = missionStrings(value.resources, 'resources', 32, /^[A-Za-z0-9_.:-]{1,128}$/u);
  const targets = missionStrings(value.targets, 'targets', 128, /^.{1,4096}$/u);
  const sideEffects = missionStrings(value.side_effects, 'side_effects', MISSION_EFFECTS.size, null, MISSION_EFFECTS);
  const credentialRefs = missionStrings(value.credential_refs, 'credential_refs', 64, /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u, null, true);
  const termination = isRecord(value.termination) ? value.termination : null;
  if (!termination || Object.keys(termination).some((key) => !['suspend_on', 'terminate_on'].includes(key))) {
    throw new ContractError('invalid_mission', 'mission requires bounded suspension and termination conditions');
  }
  const suspendOn = missionStrings(termination.suspend_on, 'termination.suspend_on', MISSION_CONDITIONS.size, null, MISSION_CONDITIONS, true);
  const terminateOn = missionStrings(termination.terminate_on, 'termination.terminate_on', MISSION_CONDITIONS.size, null, MISSION_CONDITIONS);
  for (const required of ['budget_exhaustion', 'expiration', 'disconnect']) {
    if (!terminateOn.includes(required)) throw new ContractError('invalid_mission', `mission termination must include ${required}`);
  }
  return {
    id: value.id, outcome: value.outcome.slice(0, 131_072), revocationId: value.revocation_id,
    resources, targets, sideEffects, credentialRefs,
    schedule: { notBefore: new Date(notBefore).toISOString(), expiresAt: new Date(expiresAt).toISOString() },
    expiresAt: new Date(expiresAt).toISOString(),
    bounds: {
      maxTurns: boundedInteger(bounds.max_turns, 1, 1, 1_000_000),
      maxToolCalls: boundedInteger(bounds.max_tool_calls, 256, 0, 1_000_000),
      maxDurationMs: boundedInteger(bounds.max_duration_ms, 3_600_000, 1_000, 604_800_000),
    },
    termination: { suspendOn, terminateOn },
    provenance: principal,
  };
}

function missionStrings(value, field, maximum, pattern = null, choices = null, allowEmpty = false) {
  if (!Array.isArray(value) || value.length > maximum || (!allowEmpty && value.length === 0)
    || value.some((item) => typeof item !== 'string' || (pattern && !pattern.test(item)) || (choices && !choices.has(item)))
    || new Set(value).size !== value.length) {
    throw new ContractError('invalid_mission', `mission ${field} must be a bounded unique list`);
  }
  return Object.freeze([...value]);
}

function rejectReviewOverrides(manifest) {
  const forbidden = ['skip_review', 'disable_review', 'permission_mode', 'review_history'];
  for (const key of forbidden) {
    if (Object.hasOwn(manifest, key)) throw configurationError('review_floor_violation', `${key} is forbidden`, key);
  }
}

function configurationError(code, message, key) {
  const error = new ContractError(code, message);
  error.configurationKey = key;
  return error;
}

function parseEndpoint(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('scheme');
    if (url.username || url.password) throw new Error('credentials');
    return url;
  } catch {
    throw new ContractError('invalid_endpoint', 'provider endpoint must be HTTP(S)');
  }
}

function endpointZone(url) {
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'loopback';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(host)) return 'private_network';
  return 'public_network';
}

function optionalString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalBoundedInteger(value, minimum, maximum) {
  if (value === undefined) return null;
  return boundedInteger(value, null, minimum, maximum);
}

function stringOrEmpty(value) {
  return typeof value === 'string' ? value : '';
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}
