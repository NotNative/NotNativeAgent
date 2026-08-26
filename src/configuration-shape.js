// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const SECURITY_KEY = /review|permission|ledger|revalid|auto.?approv|security|sandbox|secret|credential|token|auth|redact|sensitive|encrypt/iu;
const PROVIDER = ['id', 'display_name', 'endpoint', 'model', 'trust_zone', 'credential', 'credential_env', 'context_limit_bytes', 'output_limit_tokens', 'capabilities'];
const CAPABILITIES = ['streaming', 'tools', 'images', 'structured_output', 'usage', 'cancellation'];
const ROUTE = [
  'provider_id', 'model', 'context_limit_bytes', 'required_capabilities', 'temperature',
  'max_output_tokens', 'budget', 'fallbacks', 'deadline_ms', 'reasoning_effort', 'enable_thinking',
];
const MCP = [
  'id', 'transport', 'enabled', 'timeout_ms', 'connect_timeout_ms', 'list_timeout_ms',
  'call_timeout_ms', 'shutdown_timeout_ms', 'tool_effects', 'credential', 'credential_env', 'credential_target', 'header_env', 'header_credentials',
  'trusted', 'protocol_version', 'command', 'args', 'cwd', 'endpoint',
];

export function validateNestedManifestKeys(manifest) {
  if (!record(manifest)) {
    throw new ContractError('manifest_shape_invalid', 'configuration manifest must be an object');
  }
  const warnings = [];
  inspectObject(manifest.provider, 'provider', PROVIDER, warnings);
  inspectArray(manifest.providers, 'providers', PROVIDER, warnings, inspectProviderCapabilities);
  inspectProviderCapabilities(manifest.provider, 'provider', warnings);
  inspectRoutes(manifest.routes, warnings);
  inspectObject(manifest.attachments, 'attachments', ['enabled', 'max_bytes', 'retain'], warnings);
  inspectObject(manifest.memory, 'memory', ['enabled', 'required', 'timeout_ms', 'max_items', 'max_bytes'], warnings);
  inspectObject(manifest.dream, 'dream', ['enabled', 'idle_ms', 'inter_stage_ms', 'inference_idle_ms', 'hygiene_idle_ms', 'retention_days'], warnings);
  inspectObject(manifest.tui, 'tui', ['reduced_motion', 'color', 'key_bindings'], warnings);
  inspectObject(manifest.telemetry, 'telemetry', ['enabled', 'destination', 'retention'], warnings);
  inspectObject(manifest.reviewer_ledger, 'reviewer_ledger', ['retention_entries'], warnings);
  inspectObject(manifest.recovery, 'recovery', ['max_model_steps', 'local_retry_limit', 'ladder'], warnings);
  inspectArray(manifest.mcp_servers, 'mcp_servers', MCP, warnings, inspectMcpChildren);
  inspectArray(manifest.skills, 'skills', ['id', 'version', 'description', 'invocation', 'body', 'source', 'requires_tools'], warnings);
  inspectMission(manifest.mission, warnings);
  return warnings;
}

function inspectProviderCapabilities(value, path, warnings) {
  if (record(value)) {
    inspectObject(value.capabilities, `${path}.capabilities`, CAPABILITIES, warnings);
    inspectObject(value.credential, `${path}.credential`, ['source', 'name', 'secret_id', 'field'], warnings);
  }
}

function inspectRoutes(value, warnings) {
  if (!record(value)) return;
  inspectObject(value, 'routes', ['primary', 'reviewer', 'subagent', 'vision'], warnings);
  for (const role of ['primary', 'reviewer', 'subagent', 'vision']) {
    inspectObject(value[role], `routes.${role}`, ROUTE, warnings);
  }
}

function inspectMcpChildren(value, path, warnings) {
  if (!record(value)) return;
  inspectObject(value.credential, `${path}.credential`, ['source', 'name', 'secret_id', 'field'], warnings);
  if (record(value.header_credentials)) {
    for (const [header, binding] of Object.entries(value.header_credentials)) {
      inspectObject(binding, `${path}.header_credentials.${header}`, ['source', 'name', 'secret_id', 'field'], warnings);
    }
  }
  inspectDynamic(value.header_env, `${path}.header_env`, warnings);
  inspectDynamic(value.tool_effects, `${path}.tool_effects`, warnings);
}

function inspectMission(value, warnings) {
  inspectObject(value, 'mission', [
    'id', 'outcome', 'revocation_id', 'not_before', 'expires_at', 'resources', 'targets',
    'side_effects', 'credential_refs', 'bounds', 'termination',
  ], warnings);
  if (!record(value)) return;
  inspectObject(value.bounds, 'mission.bounds', ['max_turns', 'max_tool_calls', 'max_duration_ms'], warnings);
  inspectObject(value.termination, 'mission.termination', ['suspend_on', 'terminate_on'], warnings);
}

function inspectArray(value, path, allowed, warnings, children) {
  if (value === undefined) return;
  if (!Array.isArray(value)) { warnings.push(`unknown manifest shape ignored: ${path}`); return; }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!record(item)) { warnings.push(`unknown manifest shape ignored: ${itemPath}`); return; }
    inspectObject(item, itemPath, allowed, warnings);
    children?.(item, itemPath, warnings);
  });
}

function inspectObject(value, path, allowed, warnings) {
  if (value === undefined) return;
  if (!record(value)) { warnings.push(`unknown manifest shape ignored: ${path}`); return; }
  const known = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) unknown(`${path}.${key}`, key, warnings);
  }
}

function inspectDynamic(value, path, warnings) {
  if (value === undefined || record(value)) return;
  warnings.push(`unknown manifest shape ignored: ${path}`);
}

function unknown(path, key, warnings) {
  if (SECURITY_KEY.test(key)) {
    const error = new ContractError('unknown_security_key', `unknown security-relevant manifest key ${path}`);
    error.configurationKey = path;
    throw error;
  }
  warnings.push(`unknown manifest key ignored: ${path}`);
}

function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
