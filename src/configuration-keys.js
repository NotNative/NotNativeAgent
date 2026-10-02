// SPDX-License-Identifier: Apache-2.0
import { ROLES } from './contracts.js';
import { DEFAULT_KEY_BINDINGS } from './experience/key-bindings.js';

export const MANIFEST_KEYS = Object.freeze([
  'format_version', 'routing_inheritance_version', 'output_headroom_version', 'persistence', 'provider', 'providers', 'routes', 'application_system_prompt', 'mission',
  'workspace_root', 'provider_timeout_ms', 'first_token_timeout_ms', 'idle_timeout_ms',
  'provider_connect_timeout_ms', 'semantic_review_timeout_ms', 'approval_timeout_ms',
  'provider_concurrency', 'provider_queue_limit', 'tool_concurrency',
  'persistence_flush_timeout_ms', 'shutdown_timeout_ms',
  'context_limit_bytes', 'context_compression_threshold', 'context_compression_level_2_threshold', 'context_compression_level_3_threshold',
  'context_compaction_threshold', 'attachments', 'memory', 'dream', 'mcp_servers', 'tui', 'telemetry',
  'allowed_capabilities', 'allowed_tools', 'disconnect_policy', 'skills', 'reviewer_ledger', 'recovery',
]);

export const CONFIGURATION_KEYS = Object.freeze({
  manifest: MANIFEST_KEYS,
  provider: Object.freeze(['id', 'display_name', 'endpoint', 'model', 'trust_zone', 'credential', 'credential_env', 'context_limit_bytes', 'output_limit_tokens', 'tool_call_mode', 'capabilities']),
  capabilities: Object.freeze(['streaming', 'tools', 'images', 'structured_output', 'usage', 'cancellation']),
  credential: Object.freeze(['source', 'name', 'secret_id', 'field']),
  roles: ROLES,
  route: Object.freeze(['provider_id', 'model', 'context_limit_bytes', 'required_capabilities', 'temperature', 'max_output_tokens', 'budget', 'fallbacks', 'deadline_ms', 'reasoning_effort', 'enable_thinking']),
  mcp: Object.freeze([
    'id', 'transport', 'enabled', 'timeout_ms', 'connect_timeout_ms', 'list_timeout_ms',
    'call_timeout_ms', 'shutdown_timeout_ms', 'tool_effects', 'credential', 'credential_env', 'credential_target', 'header_env', 'header_credentials',
    'trusted', 'protocol_version', 'command', 'args', 'cwd', 'endpoint',
  ]),
  attachments: Object.freeze(['enabled', 'max_bytes', 'retain']),
  memory: Object.freeze(['enabled', 'required', 'timeout_ms', 'max_items', 'max_bytes']),
  dream: Object.freeze(['enabled', 'idle_ms', 'inter_stage_ms', 'inference_idle_ms', 'hygiene_idle_ms', 'retention_days']),
  tui: Object.freeze(['reduced_motion', 'color', 'key_bindings']),
  keyBindings: Object.freeze(Object.keys(DEFAULT_KEY_BINDINGS)),
  telemetry: Object.freeze(['enabled', 'destination', 'retention']),
  reviewerLedger: Object.freeze(['retention_entries']),
  recovery: Object.freeze(['max_model_steps', 'local_retry_limit', 'ladder', 'turn_wall_clock_ms']),
  skill: Object.freeze(['id', 'version', 'description', 'invocation', 'body', 'source', 'requires_tools']),
  mission: Object.freeze(['id', 'outcome', 'revocation_id', 'not_before', 'expires_at', 'resources', 'targets', 'side_effects', 'credential_refs', 'bounds', 'termination']),
  missionBounds: Object.freeze(['max_turns', 'max_tool_calls', 'max_duration_ms']),
  missionTermination: Object.freeze(['suspend_on', 'terminate_on']),
});

// Compatibility: descriptors document shape ownership; scalar acceptance remains with existing validators.
// Invariant: [*] denotes a collection item, {role} a finite role, and {header}/{tool} dynamic map entries.
export const MANIFEST_SHAPE_DESCRIPTORS = Object.freeze([
  shape('$', 'manifest', 'object', 'validateManifestKeys'),
  shape('provider', 'provider', 'object', 'validateNestedManifestKeys', { alternative: 'providers[*]' }),
  shape('providers[*]', 'provider', 'collection', 'validateNestedManifestKeys', { identity: 'id', alternative: 'provider' }),
  shape('provider.capabilities', 'capabilities', 'object', 'validateNestedManifestKeys'),
  shape('providers[*].capabilities', 'capabilities', 'object', 'validateNestedManifestKeys'),
  shape('provider.credential', 'credential', 'object', 'validateNestedManifestKeys'),
  shape('providers[*].credential', 'credential', 'object', 'validateNestedManifestKeys'),
  shape('routes', 'roles', 'object', 'validateNestedManifestKeys'),
  shape('routes.{role}', 'route', 'finite-map', 'validateNestedManifestKeys', { names: ROLES }),
  shape('attachments', 'attachments', 'object', 'validateNestedManifestKeys'),
  shape('memory', 'memory', 'object', 'validateNestedManifestKeys'),
  shape('dream', 'dream', 'object', 'validateNestedManifestKeys'),
  shape('tui', 'tui', 'object', 'validateNestedManifestKeys'),
  shape('tui.key_bindings', 'keyBindings', 'object', 'validateKeyBindings'),
  shape('telemetry', 'telemetry', 'object', 'validateNestedManifestKeys'),
  shape('reviewer_ledger', 'reviewerLedger', 'object', 'validateNestedManifestKeys'),
  shape('recovery', 'recovery', 'object', 'validateNestedManifestKeys'),
  shape('mcp_servers[*]', 'mcp', 'collection', 'validateNestedManifestKeys', { identity: 'id' }),
  shape('mcp_servers[*].credential', 'credential', 'object', 'validateNestedManifestKeys'),
  shape('mcp_servers[*].header_credentials', null, 'dynamic-map', 'validateCredentialHeaders', { entry: 'mcp_servers[*].header_credentials.{header}' }),
  shape('mcp_servers[*].header_credentials.{header}', 'credential', 'object', 'validateNestedManifestKeys'),
  shape('mcp_servers[*].header_env', null, 'dynamic-map', 'validateHeaderEnvironment', { entry: 'environment-name' }),
  shape('mcp_servers[*].tool_effects', null, 'dynamic-map', 'validateMcpServer', { entry: 'effect' }),
  shape('skills[*]', 'skill', 'collection', 'validateNestedManifestKeys', { identity: 'id', additionalValidator: 'validateHostedSkills' }),
  shape('mission', 'mission', 'object', 'validateNestedManifestKeys'),
  shape('mission.bounds', 'missionBounds', 'object', 'validateNestedManifestKeys'),
  shape('mission.termination', 'missionTermination', 'object', 'validateNestedManifestKeys'),
]);

function shape(path, family, kind, validator, details = {}) {
  return Object.freeze({ path, family, kind, validator, keys: family ? CONFIGURATION_KEYS[family] : null, ...details });
}
