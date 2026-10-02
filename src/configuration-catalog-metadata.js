// SPDX-License-Identifier: Apache-2.0
import { REASONING_EFFORTS } from './provider/reasoning.js';
import { DEFAULT_KEY_BINDINGS } from './experience/key-bindings.js';

const absent = { kind: 'absent' };
const literal = (value) => ({ kind: 'literal', value });
const computed = (resolver) => ({ kind: 'computed', resolver });
const inherited = (source) => ({ kind: 'inherited', source });
const authority = { kind: 'authority_derived', owner: 'authenticated-stdio-host' };
const live = { class: 'engine_boundary', evidence: ['runtime-config.js:applyConfiguration', 'runtime-config.js:publishEngineConfiguration'], requires: 'accepted compatible native configuration command' };
const session = { class: 'new_session', evidence: ['runtime-config.js:assertRuntimeConfigurationCompatible'] };
const construction = { class: 'construction_only', evidence: ['experience/dream.js:initializeWorkspaceDream', 'dream-coordinator.js:constructor'] };
const unverified = { class: 'unverified', evidence: [] };

export const CONFIGURATION_METADATA = {
  manifest: family('resolveManifest', unverified, {
    format_version: field('integer', literal(1), { classification: 'internal_invariant', acceptance: 'absent_or_integer_1' }),
    routing_inheritance_version: field('unknown', computed('migrateRoutingInheritance'), { classification: 'internal_invariant', acceptance: 'migration_marker' }),
    output_headroom_version: field('unknown', computed('migrateRoutingInheritance'), { classification: 'internal_invariant', acceptance: 'migration_marker' }),
    persistence: field('enum', literal('durable'), { enum: ['durable', 'ephemeral'], application: session }),
    provider: container('object', { classification: 'compatibility_alias', logicalPath: 'providers[*]' }),
    providers: container('array', { constraints: { minimumItems: 1, maximumItems: 16, identity: 'id' } }),
    routes: container('object'),
    application_system_prompt: field('string', literal(''), { acceptance: 'string_else_empty', sensitivity: 'private', application: live }),
    mission: container('object', { classification: 'authority_grant', default: absent, application: session }),
    workspace_root: field('string', computed('process_cwd_and_node_path_resolve'), { acceptance: 'nonempty_string_else_cwd', application: session, sensitivity: 'private' }),
    provider_timeout_ms: numeric('providerTimeouts', { application: live, effectiveDefault: computed('primary_deadline_or_provider_timeout'), dependencies: ['routes.primary.deadline_ms'] }),
    first_token_timeout_ms: numeric('providerTimeouts', { application: live }),
    idle_timeout_ms: numeric('providerTimeouts', { application: live }),
    provider_connect_timeout_ms: numeric('resolveManifest', { application: live }),
    semantic_review_timeout_ms: numeric('semanticReviewTimeout', { application: live, effectiveDefault: computed('provider_timeout_or_default_provider_timeout') }),
    approval_timeout_ms: numeric('resolveManifest', { application: live }),
    provider_concurrency: numeric('resolveManifest', { application: live }),
    provider_queue_limit: numeric('resolveManifest', { application: live }),
    tool_concurrency: numeric('resolveManifest'),
    persistence_flush_timeout_ms: numeric('resolveManifest'),
    shutdown_timeout_ms: numeric('resolveManifest'),
    context_limit_bytes: numeric('resolveContextLimits'),
    context_compression_threshold: numeric('resolveContextLimits', { coupledConstraint: 'strict_increasing_context_thresholds' }),
    context_compression_level_2_threshold: numeric('resolveContextLimits', { coupledConstraint: 'strict_increasing_context_thresholds' }),
    context_compression_level_3_threshold: numeric('resolveContextLimits', { coupledConstraint: 'strict_increasing_context_thresholds' }),
    context_compaction_threshold: numeric('resolveContextLimits', { coupledConstraint: 'strict_increasing_context_thresholds' }),
    attachments: container('object'), memory: container('object'), dream: container('object', { application: construction }),
    mcp_servers: container('array', { application: session, default: literal([]), constraints: { maximumItems: 16, identity: 'id' } }),
    tui: container('object'), telemetry: container('object'),
    allowed_capabilities: field('array', authority, { classification: 'authority_grant', application: session, enumItems: ['tools', 'steering', 'attachments', 'memory', 'mcp', 'skills'], constraints: { maximumItems: 6, unique: true } }),
    allowed_tools: field('array', authority, { classification: 'authority_grant', application: session, acceptance: 'bounded_unique_host_tool_claims_excluding_agent_run', constraints: { maximumItems: 512 } }),
    disconnect_policy: field('enum', authority, { classification: 'authority_grant', application: session, enum: ['cancel'] }),
    skills: container('array', { classification: 'authority_grant', application: session, default: authority, constraints: { maximumItems: 128, identity: 'id' } }),
    reviewer_ledger: container('object'), recovery: container('object'),
  }),
  provider: family('validateProvider', live, {
    id: field('string', literal('manifest-primary'), { acceptance: 'string_else_default', identity: true, intent: 'profile_identity' }),
    display_name: field('string', computed('provider_id_or_Manifest_primary'), { acceptance: 'nonempty_string_else_default' }),
    endpoint: field('string', absent, { acceptance: 'credential_free_http_or_https_url', sensitivity: 'private' }),
    model: field('string', absent, { constraints: { minimumLength: 1, maximumLength: 256 } }),
    trust_zone: field('enum', absent, { enum: ['loopback', 'private_network', 'public_network'], acceptance: 'explicit_zone_must_match_endpoint', requiredValue: computed('endpointZone') }),
    credential: container('object', { default: inherited('credential_env'), intent: 'credential_binding', sensitivity: 'credential_reference' }),
    credential_env: field('string', absent, { classification: 'compatibility_alias', intent: 'credential_binding', sensitivity: 'credential_reference', acceptance: 'nonempty_environment_name_or_unset', logicalSuffix: 'credential' }),
    context_limit_bytes: numeric('validateProvider'), output_limit_tokens: numeric('validateProvider'),
    tool_call_mode: field('enum', literal('single'), { enum: ['single', 'batch'] }),
    capabilities: container('object'),
  }),
  capabilities: family('validateProvider', live, {
    streaming: field('boolean', literal(true), { classification: 'generated_state', acceptance: 'input_ignored_always_true' }),
    tools: capability(), images: capability(), structured_output: capability(), usage: capability(), cancellation: capability(),
  }),
  credential: family('normalizeCredentialBinding', live, {
    source: field('enum', absent, { enum: ['environment', 'secret'], sensitivity: 'credential_reference', intent: 'credential_binding' }),
    name: { ...reference('environment_name', '^[A-Za-z_][A-Za-z0-9_]{0,127}$'), activeWhen: 'source_environment' },
    secret_id: { ...reference('secret_identifier', '^sec_[A-Za-z0-9-]{1,128}$'), activeWhen: 'source_secret' },
    field: { ...reference('secret_field_name', '^[A-Za-z][A-Za-z0-9_.-]{0,63}$'), activeWhen: 'source_secret' },
  }),
  roles: family('buildRoutes', live, {
    primary: container('object'), reviewer: container('object'), subagent: container('object'), vision: container('object'),
  }),
  route: family('buildRoutes', live, {
    provider_id: field('unknown', computed('assigned_profile_or_primary_route'), { acceptance: 'nullish_inherit_else_existing_profile_property_key' }),
    model: field('unknown', computed('assigned_profile_or_primary_route'), { acceptance: 'nullish_inherit_else_preserved' }),
    context_limit_bytes: numeric('buildRoutes', { effectiveDefault: inherited('selected_provider.context_limit_bytes') }),
    required_capabilities: field('array', literal([]), { enumItems: ['streaming', 'tools', 'images', 'structured_output', 'usage', 'cancellation'], constraints: { maximumItems: 6, unique: true } }),
    temperature: numeric('buildRoutes'), max_output_tokens: numeric('buildRoutes'), budget: numeric('buildRoutes'),
    fallbacks: field('array', literal([]), { acceptance: 'known_unique_roles_without_cycles', constraints: { maximumItems: 4, unique: true } }),
    deadline_ms: numeric('buildRoutes', { effectiveDefault: inherited('provider_timeout_ms'), dependencies: ['provider_timeout_ms'], roleSemantics: { primary: 'overrides_global_provider_timeout', specialist: 'absent_inherits_global_zero_disables' } }),
    reasoning_effort: field('enum', literal(null), { enum: REASONING_EFFORTS, acceptance: 'enum_or_null_or_absent' }),
    enable_thinking: field('boolean', literal(null), { acceptance: 'boolean_or_null_or_absent' }),
  }),
  mcp: family('validateMcpServer', session, {
    id: field('string', absent, { identity: true, constraints: { pattern: '^[A-Za-z0-9_-]{1,64}$', unique: true } }),
    transport: field('enum', absent, { enum: ['stdio', 'streamable_http'] }),
    enabled: boolean(false, 'exact_true'),
    timeout_ms: numeric('validateMcpServer'), connect_timeout_ms: numeric('validateMcpServer'), list_timeout_ms: numeric('validateMcpServer'),
    call_timeout_ms: numeric('validateMcpServer'), shutdown_timeout_ms: numeric('validateMcpServer'),
    tool_effects: container('map', { default: literal({}), acceptance: 'object_copy_else_empty_unvalidated_entries' }),
    credential: container('object', { default: inherited('credential_env'), intent: 'credential_binding', sensitivity: 'credential_reference' }),
    credential_env: field('string', absent, { classification: 'compatibility_alias', intent: 'credential_binding', sensitivity: 'credential_reference', acceptance: 'nonempty_environment_name_or_unset', logicalSuffix: 'credential' }),
    credential_target: reference('environment_name', '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
    header_env: container('map', { default: literal({}), sensitivity: 'credential_reference', constraints: { maximumItems: 16 }, intent: 'credential_binding' }),
    header_credentials: container('map', { default: literal({}), sensitivity: 'credential_reference', constraints: { maximumItems: 16 }, intent: 'credential_binding' }),
    trusted: boolean(false, 'exact_true'),
    protocol_version: field('unknown', literal('2026-07-28'), { acceptance: 'nullish_default_else_preserved' }),
    command: field('string', absent, { acceptance: 'nonempty_string_required_for_stdio', activeWhen: 'transport_stdio', sensitivity: 'private' }),
    args: field('array', literal([]), { acceptance: 'string_items_for_stdio', activeWhen: 'transport_stdio', constraints: { maximumItems: 64 }, sensitivity: 'private' }),
    cwd: field('string', literal(null), { acceptance: 'nonempty_string_else_unset_for_stdio', activeWhen: 'transport_stdio', sensitivity: 'private' }),
    endpoint: field('string', absent, { acceptance: 'credential_free_http_or_https_url_required_for_http', activeWhen: 'transport_streamable_http', sensitivity: 'private' }),
  }),
  attachments: family('validateAttachments', live, { enabled: boolean(true, 'except_exact_false'), max_bytes: numeric('validateAttachments'), retain: boolean(false, 'exact_true') }),
  memory: family('validateMemory', live, { enabled: boolean(true, 'except_exact_false'), required: boolean(false, 'exact_true'), timeout_ms: numeric('validateMemory'), max_items: numeric('validateMemory'), max_bytes: numeric('validateMemory') }),
  dream: family('validateDream', construction, {
    enabled: field('boolean', computed('disabled_for_hosted_execution_else_except_exact_false'), { acceptance: 'except_exact_false_subject_to_host_authority' }),
    idle_ms: numeric('validateDream'), inter_stage_ms: numeric('validateDream'), inference_idle_ms: numeric('validateDream'), hygiene_idle_ms: numeric('validateDream'), retention_days: numeric('validateDream'),
  }),
  tui: family('validateTui', { class: 'surface_invocation', evidence: ['experience/key-bindings.js:validateKeyBindings', 'tui/terminal-adapter.js:setBindings'], verification: 'no_generic_live_application_claim' }, {
    reduced_motion: boolean(false, 'exact_true'), color: boolean(true, 'except_exact_false'), key_bindings: container('object', { default: inherited('DEFAULT_KEY_BINDINGS') }),
  }),
  keyBindings: family('validateKeyBindings', { class: 'surface_invocation', evidence: ['experience/key-bindings.js:validateKeyBindings', 'tui/terminal-adapter.js:setBindings'], verification: 'no_generic_live_application_claim' }, Object.fromEntries(Object.entries(DEFAULT_KEY_BINDINGS).map(([name, value]) => [name,
    field('string', literal(value), { acceptance: 'supported_case_normalized_unique_terminal_binding', constraints: { maximumLength: 32 } }),
  ]))),
  telemetry: family('validateTelemetry', unverified, {
    enabled: boolean(false, 'exact_true'),
    destination: field('string', literal(null), { acceptance: 'required_credential_free_http_or_https_when_enabled_else_ignored', constraints: { maximumLength: 2048 }, sensitivity: 'private' }),
    retention: field('string', literal(null), { acceptance: 'optional_nonempty_string_when_enabled_else_ignored' }),
  }),
  reviewerLedger: family('validateReviewerLedger', unverified, { retention_entries: numeric('validateReviewerLedger') }),
  recovery: family('validateRecovery', unverified, {
    max_model_steps: numeric('validateRecovery'), local_retry_limit: numeric('validateRecovery'), turn_wall_clock_ms: numeric('validateRecovery'),
    ladder: field('array', literal(['nudge', 'compact', 'compact', 'compact']), { enumItems: ['nudge', 'compact'], constraints: { maximumItems: 4 }, acceptance: 'length_at_least_local_retry_limit_minus_one_then_slice' }),
  }),
  skill: family('validateHostedSkills', session, {
    id: grant('string', { pattern: '^[a-z][a-z0-9_.-]*(?:/[a-z][a-z0-9_.-]*)*$', maximumLength: 128 }),
    version: grant('string', { minimumLength: 1, maximumLength: 64 }), description: grant('string', { minimumLength: 1, maximumLength: 1024 }),
    invocation: field('enum', authority, { classification: 'authority_grant', enum: ['user', 'agent', 'both'] }),
    body: grant('string', { minimumLength: 1, maximumBytes: 65536, combinedMaximumBytes: 196608 }, { sensitivity: 'private' }),
    source: field('string', computed('explicit_bounded_source_or_host'), { classification: 'authority_grant', acceptance: 'nonempty_string_at_most_512_else_host' }),
    requires_tools: grant('array', { maximumItems: 64, unique: true, itemPattern: '^[a-z][a-z0-9_.-]{0,127}$' }),
  }),
  mission: family('validateMission', session, {
    id: grant('string', { pattern: '^[A-Za-z0-9_-]{1,128}$' }), outcome: grant('string', { minimumLength: 1, maximumBytes: 131072 }, { sensitivity: 'private' }),
    revocation_id: grant('string', { pattern: '^[A-Za-z0-9_-]{1,128}$' }),
    not_before: grant('string', { format: 'utc_iso_timestamp_ordered_before_expires_at' }), expires_at: grant('string', { format: 'utc_iso_timestamp_ordered_after_not_before' }),
    resources: grant('array', { minimumItems: 1, maximumItems: 32, unique: true, itemPattern: '^[A-Za-z0-9_.:-]{1,128}$' }),
    targets: grant('array', { minimumItems: 1, maximumItems: 128, unique: true, itemPattern: '^.{1,4096}$' }, { sensitivity: 'private' }),
    side_effects: field('array', authority, { classification: 'authority_grant', enumItems: ['read_only', 'reversible', 'irreversible', 'unknown'], constraints: { minimumItems: 1, maximumItems: 4, unique: true } }),
    credential_refs: grant('array', { maximumItems: 64, unique: true, itemPattern: '^[A-Za-z_][A-Za-z0-9_]{0,127}$' }, { sensitivity: 'credential_reference' }),
    bounds: container('object', { classification: 'authority_grant' }), termination: container('object', { classification: 'authority_grant' }),
  }),
  missionBounds: family('validateMission', session, { max_turns: numeric('validateMission', { classification: 'authority_grant' }), max_tool_calls: numeric('validateMission', { classification: 'authority_grant' }), max_duration_ms: numeric('validateMission', { classification: 'authority_grant' }) }),
  missionTermination: family('validateMission', session, {
    suspend_on: grant('array', { maximumItems: 8, unique: true }, { acceptance: 'known_mission_conditions' }),
    terminate_on: grant('array', { minimumItems: 1, maximumItems: 8, unique: true }, { acceptance: 'known_mission_conditions_including_budget_exhaustion_expiration_disconnect' }),
  }),
};

export const CONFIGURATION_DYNAMIC_METADATA = {
  'mcp_servers[*].header_env': field('string', absent, { validator: 'validateHeaderEnvironment', sensitivity: 'credential_reference', intent: 'credential_binding', application: session, acceptance: 'safe_nonreserved_header_to_environment_name' }),
  'mcp_servers[*].tool_effects': field('unknown', absent, { validator: 'validateMcpServer', application: session, acceptance: 'unvalidated_entry_preserved', intent: 'unverified' }),
};

// Invariant: a new structural path needs an explicit catalog disposition, even when it reuses a known key family.
export const CONFIGURATION_SHAPE_METADATA = {
  '$': 'manifest', provider: 'provider', 'providers[*]': 'provider',
  'provider.capabilities': 'capabilities', 'providers[*].capabilities': 'capabilities',
  'provider.credential': 'credential', 'providers[*].credential': 'credential',
  routes: 'roles', 'routes.{role}': 'route', attachments: 'attachments', memory: 'memory', dream: 'dream',
  tui: 'tui', 'tui.key_bindings': 'keyBindings', telemetry: 'telemetry', reviewer_ledger: 'reviewerLedger', recovery: 'recovery',
  'mcp_servers[*]': 'mcp', 'mcp_servers[*].credential': 'credential',
  'mcp_servers[*].header_credentials': null, 'mcp_servers[*].header_credentials.{header}': 'credential',
  'mcp_servers[*].header_env': null, 'mcp_servers[*].tool_effects': null,
  'skills[*]': 'skill', mission: 'mission', 'mission.bounds': 'missionBounds', 'mission.termination': 'missionTermination',
};

function family(validator, application, fields) { return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { validator, application, ...value }])); }
function field(type, fallback = absent, details = {}) { return { type, default: fallback, classification: 'operator_setting', sensitivity: 'public', ...details }; }
function numeric(validator, details = {}) { return field('numeric_rule', absent, { validator, ...details }); }
function container(type, details = {}) { return field(type, absent, { classification: 'container', intent: 'typed_collection', ...details }); }
function boolean(value, acceptance) { return field('boolean', literal(value), { acceptance }); }
function capability() { return field('boolean_or_unknown', literal('unknown'), { acceptance: 'exact_boolean_else_unknown' }); }
function reference(acceptance, pattern) { return field('string', absent, { intent: 'credential_binding', sensitivity: 'credential_reference', acceptance, constraints: { pattern } }); }
function grant(type, constraints, details = {}) { return field(type, authority, { classification: 'authority_grant', constraints, ...details }); }

freezeMetadata(CONFIGURATION_METADATA);
freezeMetadata(CONFIGURATION_DYNAMIC_METADATA);
freezeMetadata(CONFIGURATION_SHAPE_METADATA);

function freezeMetadata(value) {
  const pending = [value], seen = new Set();
  while (pending.length) {
    if (seen.size > 4096) throw new TypeError('configuration metadata exceeds structural bound');
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const child of Object.values(current)) if (child && typeof child === 'object' && !Object.isFrozen(child)) pending.push(child);
    Object.freeze(current);
  }
}
