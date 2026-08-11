// SPDX-License-Identifier: Apache-2.0
import { copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveManifest } from './config.js';
import { ContractError } from './ids.js';

export const SPECIALIST_ROUTE_ROLES = Object.freeze(['subagent', 'reviewer', 'vision']);

export function manifestFromConfig(config) {
  return compact({
    format_version: 1,
    routing_inheritance_version: 1,
    persistence: config.persistence,
    providers: Object.values(config.providerProfiles).map(providerManifest),
    routes: Object.fromEntries(Object.entries(config.routes).map(([role, route]) => [role, compact({
      provider_id: role === 'primary' || route.assigned !== false ? route.providerId : undefined,
      model: role === 'primary' || route.assigned !== false ? route.model : undefined,
      fallbacks: [...route.fallbacks],
      context_limit_bytes: route.contextLimitBytes ?? undefined,
      required_capabilities: [...route.requiredCapabilities], temperature: route.temperature,
      max_output_tokens: route.maxOutputTokens, budget: route.budget, deadline_ms: route.deadlineMs,
    })])),
    application_system_prompt: config.applicationPolicy || undefined,
    skills: config.executionManifest ? config.skills?.map((item) => ({
      id: item.id, version: item.version, description: item.description, invocation: item.invocation,
      body: item.body, source: item.source, requires_tools: [...item.requiresTools],
    })) : undefined,
    mission: config.mission ?? undefined,
    allowed_capabilities: config.executionManifest?.allowedCapabilities,
    allowed_tools: config.executionManifest?.allowedTools ?? undefined,
    disconnect_policy: config.executionManifest?.disconnectPolicy,
    workspace_root: config.workspaceRoot,
    provider_timeout_ms: config.limits.providerMs,
    provider_connect_timeout_ms: config.limits.connectMs,
    first_token_timeout_ms: config.limits.firstTokenMs,
    idle_timeout_ms: config.limits.idleMs,
    semantic_review_timeout_ms: config.limits.semanticReviewMs,
    approval_timeout_ms: config.limits.approvalMs,
    provider_concurrency: config.limits.providerConcurrency,
    provider_queue_limit: config.limits.providerQueueLimit,
    tool_concurrency: config.limits.toolConcurrency,
    persistence_flush_timeout_ms: config.limits.persistenceFlushMs,
    shutdown_timeout_ms: config.limits.shutdownMs,
    context_limit_bytes: config.limits.maxContextBytes,
    context_compression_threshold: config.limits.contextCompressionThreshold,
    context_compaction_threshold: config.limits.contextCompactionThreshold,
    attachments: {
      enabled: config.attachments.enabled, max_bytes: config.attachments.maxBytes, retain: config.attachments.retain,
    },
    memory: {
      enabled: config.memory.enabled, required: config.memory.required, timeout_ms: config.memory.timeoutMs,
      max_items: config.memory.maxItems, max_bytes: config.memory.maxBytes,
    },
    dream: dreamManifest(config.dream),
    mcp_servers: config.mcpServers.map(mcpManifest),
    tui: {
      reduced_motion: config.tui.reducedMotion, color: config.tui.color, key_bindings: config.tui.keyBindings,
    },
    telemetry: config.telemetry,
    reviewer_ledger: { retention_entries: config.reviewerLedger.retentionEntries },
    recovery: {
      max_model_steps: config.recovery.maxModelSteps,
      local_retry_limit: config.recovery.localLimit, ladder: config.recovery.ladder,
    },
  });
}

function dreamManifest(dream) {
  return {
    enabled: dream.enabled, idle_ms: dream.idleMs, inter_stage_ms: dream.interStageMs,
    inference_idle_ms: dream.inferenceIdleMs, hygiene_idle_ms: dream.hygieneIdleMs,
    retention_days: dream.retentionDays,
  };
}

export function withPrimaryRoute(config, providerId, model) {
  if (!config.providerProfiles[providerId]) throw new ContractError('provider_missing', `provider ${providerId} is not configured`);
  const manifest = manifestFromConfig(config);
  const profile = config.providerProfiles[providerId];
  manifest.routes.primary = {
    ...manifest.routes.primary, provider_id: providerId, model,
    context_limit_bytes: profile.model === model ? (profile.contextLimitBytes ?? undefined) : undefined,
  };
  return { manifest, config: resolveManifest(manifest) };
}

export function withRoleRoute(config, role, providerId, model) {
  if (!Object.hasOwn(config.routes, role)) throw new ContractError('route_role_invalid', `unknown route role ${role}`);
  if (!config.providerProfiles[providerId]) throw new ContractError('provider_missing', `provider ${providerId} is not configured`);
  const manifest = manifestFromConfig(config);
  const profile = config.providerProfiles[providerId];
  manifest.routes[role] = {
    ...manifest.routes[role], provider_id: providerId, model,
    context_limit_bytes: profile.model === model ? (profile.contextLimitBytes ?? undefined) : undefined,
  };
  return { manifest, config: resolveManifest(manifest) };
}

export function withoutRoleRoute(config, role) {
  if (role === 'primary') throw new ContractError('primary_route_required', 'the primary role must have a provider profile');
  if (!Object.hasOwn(config.routes, role)) throw new ContractError('route_role_invalid', `unknown route role ${role}`);
  const manifest = manifestFromConfig(config);
  delete manifest.routes[role].provider_id;
  delete manifest.routes[role].model;
  delete manifest.routes[role].context_limit_bytes;
  return { manifest, config: resolveManifest(manifest) };
}

export function withGlobalSpecialistRoutes(config, globalConfig) {
  const manifest = manifestFromConfig(config);
  const globalManifest = manifestFromConfig(globalConfig);
  const knownProviders = new Set(manifest.providers.map((provider) => provider.id));
  for (const provider of globalManifest.providers) {
    if (!knownProviders.has(provider.id)) manifest.providers.push(provider);
  }
  for (const role of SPECIALIST_ROUTE_ROLES) {
    manifest.routes[role] = { ...globalManifest.routes[role] };
  }
  return { manifest, config: resolveManifest(manifest) };
}

export function withProvider(config, input) {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(input.id ?? '')) {
    throw new ContractError('provider_id_invalid', 'provider id must use letters, numbers, underscores, or hyphens');
  }
  if (config.providerProfiles[input.id]) throw new ContractError('provider_duplicate', `provider ${input.id} already exists`);
  const manifest = manifestFromConfig(config);
  manifest.providers.push(compact({
    id: input.id, display_name: input.displayName ?? input.id, endpoint: input.endpoint, model: input.model,
    trust_zone: endpointTrustZone(input.endpoint), credential_env: input.credentialEnv,
  }));
  return { manifest, config: resolveManifest(manifest) };
}

export function withUpdatedProvider(config, id, input) {
  const current = config.providerProfiles[id];
  if (!current) throw new ContractError('provider_missing', `provider ${id} is not configured`);
  const manifest = manifestFromConfig(config);
  const index = manifest.providers.findIndex((provider) => provider.id === id);
  const endpoint = input.endpoint ?? current.endpoint;
  const model = input.model ?? current.model;
  const preserveLimits = model === current.model;
  manifest.providers[index] = compact({
    ...manifest.providers[index],
    display_name: input.displayName ?? current.displayName,
    endpoint,
    model,
    trust_zone: endpointTrustZone(endpoint),
    credential_env: input.credentialEnv === null ? undefined : (input.credentialEnv ?? current.credentialEnv),
    context_limit_bytes: input.contextLimitBytes ?? (preserveLimits ? current.contextLimitBytes : undefined),
    output_limit_tokens: input.outputLimitTokens ?? (preserveLimits ? current.outputLimitTokens : undefined),
  });
  for (const route of Object.values(manifest.routes)) {
    if (route.provider_id === id && route.model === current.model) route.model = model;
  }
  return { manifest, config: resolveManifest(manifest) };
}

export function withContextSettings(config, maxContextBytes,
  compactionThreshold = config.limits.contextCompactionThreshold,
  compressionThreshold = config.limits.contextCompressionThreshold) {
  const manifest = manifestFromConfig(config);
  manifest.context_limit_bytes = maxContextBytes;
  manifest.context_compression_threshold = compressionThreshold;
  manifest.context_compaction_threshold = compactionThreshold;
  return { manifest, config: resolveManifest(manifest) };
}

export function withRecoverySettings(config, maxModelSteps, localLimit, ladder) {
  const manifest = manifestFromConfig(config);
  manifest.recovery = {
    max_model_steps: maxModelSteps, local_retry_limit: localLimit, ladder,
  };
  return { manifest, config: resolveManifest(manifest) };
}

export function withoutProvider(config, id) {
  if (!config.providerProfiles[id]) throw new ContractError('provider_missing', `provider ${id} is not configured`);
  if (Object.keys(config.providerProfiles).length === 1) {
    throw new ContractError('provider_last_profile', 'the final provider profile cannot be deleted');
  }
  const roles = Object.entries(config.routes)
    .filter(([role, route]) => route.providerId === id && (role === 'primary' || route.assigned !== false))
    .map(([role]) => role);
  if (roles.length > 0) {
    throw new ContractError('provider_in_use', `provider ${id} is assigned to: ${roles.join(', ')}`);
  }
  const manifest = manifestFromConfig(config);
  manifest.providers = manifest.providers.filter((provider) => provider.id !== id);
  return { manifest, config: resolveManifest(manifest) };
}

export function withBooleanSetting(config, setting, value) {
  if (typeof value !== 'boolean') throw new ContractError('setting_value_invalid', 'setting value must be boolean');
  const manifest = manifestFromConfig(config);
  if (setting === 'memory.enabled') {
    manifest.memory.enabled = value;
    if (!value) manifest.memory.required = false;
  } else if (setting === 'memory.required') {
    manifest.memory.required = value;
    if (value) manifest.memory.enabled = true;
  } else if (setting === 'attachments.enabled') manifest.attachments.enabled = value;
  else if (setting === 'attachments.retain') manifest.attachments.retain = value;
  else throw new ContractError('setting_unknown', `setting ${setting} is not editable`);
  return { manifest, config: resolveManifest(manifest) };
}

export function withRuntimeLimits(config, values) {
  const manifest = manifestFromConfig(config);
  const fields = {
    connectMs: 'provider_connect_timeout_ms', semanticReviewMs: 'semantic_review_timeout_ms',
    approvalMs: 'approval_timeout_ms', providerConcurrency: 'provider_concurrency',
    providerQueueLimit: 'provider_queue_limit', toolConcurrency: 'tool_concurrency',
  };
  for (const [key, field] of Object.entries(fields)) {
    if (values[key] !== undefined) manifest[field] = values[key];
  }
  return { manifest, config: resolveManifest(manifest) };
}

export function withKeyBindings(config, bindings) {
  const manifest = manifestFromConfig(config);
  manifest.tui.key_bindings = { ...bindings };
  return { manifest, config: resolveManifest(manifest) };
}

export function booleanSettingValue(config, setting) {
  if (setting === 'memory.enabled') return config.memory.enabled;
  if (setting === 'memory.required') return config.memory.required;
  if (setting === 'attachments.enabled') return config.attachments.enabled;
  if (setting === 'attachments.retain') return config.attachments.retain;
  throw new ContractError('setting_unknown', `setting ${setting} is not editable`);
}

export function withMcpServer(config, input) {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(input.id ?? '')) {
    throw new ContractError('invalid_mcp_config', 'MCP server id must use letters, numbers, underscores, or hyphens');
  }
  if (config.mcpServers.some((server) => server.id === input.id)) {
    throw new ContractError('mcp_duplicate', `MCP server ${input.id} already exists`);
  }
  const manifest = manifestFromConfig(config);
  manifest.mcp_servers.push(compact({
    id: input.id, transport: input.transport, enabled: input.enabled !== false,
    endpoint: input.endpoint, command: input.command, args: input.args,
    cwd: input.cwd, credential_env: input.credentialEnv, header_env: input.headerEnv,
    trusted: input.trusted === true,
    connect_timeout_ms: input.connectTimeoutMs, list_timeout_ms: input.listTimeoutMs,
    call_timeout_ms: input.callTimeoutMs, shutdown_timeout_ms: input.shutdownTimeoutMs,
  }));
  return { manifest, config: resolveManifest(manifest) };
}

export function withMcpEnabled(config, id, enabled) {
  const manifest = manifestFromConfig(config);
  const server = manifest.mcp_servers.find((entry) => entry.id === id);
  if (!server) throw new ContractError('mcp_server_missing', `MCP server ${id} is not configured`);
  server.enabled = enabled === true;
  return { manifest, config: resolveManifest(manifest) };
}

export function withMcpServerUpdate(config, id, input) {
  const manifest = manifestFromConfig(config);
  const server = manifest.mcp_servers.find((entry) => entry.id === id);
  if (!server) throw new ContractError('mcp_server_missing', `MCP server ${id} is not configured`);
  if (server.transport !== input.transport) {
    throw new ContractError('invalid_mcp_transport', 'an existing MCP server transport cannot be changed in place');
  }
  if (server.transport === 'streamable_http') {
    server.endpoint = input.endpoint;
  } else {
    server.command = input.command;
    server.args = input.args ?? [];
    setOptional(server, 'cwd', input.cwd);
  }
  setOptional(server, 'credential_env', input.credentialEnv);
  return { manifest, config: resolveManifest(manifest) };
}

export function withoutMcpServer(config, id) {
  if (!config.mcpServers.some((server) => server.id === id)) {
    throw new ContractError('mcp_server_missing', `MCP server ${id} is not configured`);
  }
  const manifest = manifestFromConfig(config);
  manifest.mcp_servers = manifest.mcp_servers.filter((server) => server.id !== id);
  return { manifest, config: resolveManifest(manifest) };
}

function setOptional(target, key, value) {
  if (value === undefined || value === null || value === '') delete target[key];
  else target[key] = value;
}

export async function persistManifest(path, manifest) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await copyFile(path, `${path}.bak`).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await rename(temporary, path);
}

function providerManifest(profile) {
  const capabilities = compact({
    tools: typeof profile.capabilities.tools === 'boolean' ? profile.capabilities.tools : undefined,
    images: typeof profile.capabilities.images === 'boolean' ? profile.capabilities.images : undefined,
    structured_output: typeof profile.capabilities.structuredOutput === 'boolean' ? profile.capabilities.structuredOutput : undefined,
    usage: typeof profile.capabilities.usage === 'boolean' ? profile.capabilities.usage : undefined,
    cancellation: typeof profile.capabilities.cancellation === 'boolean' ? profile.capabilities.cancellation : undefined,
  });
  return compact({
    id: profile.id, display_name: profile.displayName, endpoint: profile.endpoint, model: profile.model,
    trust_zone: profile.trustZone, credential_env: profile.credentialEnv,
    context_limit_bytes: profile.contextLimitBytes ?? undefined,
    output_limit_tokens: profile.outputLimitTokens ?? undefined,
    capabilities: Object.keys(capabilities).length > 0 ? capabilities : undefined,
  });
}

function mcpManifest(value) {
  return compact({
    id: value.id, transport: value.transport, enabled: value.enabled, timeout_ms: value.timeoutMs,
    connect_timeout_ms: value.connectTimeoutMs, list_timeout_ms: value.listTimeoutMs,
    call_timeout_ms: value.callTimeoutMs, shutdown_timeout_ms: value.shutdownTimeoutMs,
    tool_effects: value.effects, credential_env: value.credentialEnv, protocol_version: value.protocolVersion,
    header_env: value.headerEnv, trusted: value.trusted,
    command: value.command, args: value.args, cwd: value.cwd, endpoint: value.endpoint,
  });
}

function endpointTrustZone(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { throw new ContractError('invalid_endpoint', 'provider endpoint must be a URL'); }
  const host = url.hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '::1'].includes(host)) return 'loopback';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(host)) return 'private_network';
  return 'public_network';
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
