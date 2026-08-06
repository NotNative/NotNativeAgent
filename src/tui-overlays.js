// SPDX-License-Identifier: Apache-2.0

const PROVIDER_ROLE_LABELS = Object.freeze({
  primary: 'Primary', subagent: 'Sub-agents', reviewer: 'Permission reviewer', vision: 'Vision',
});
const PROVIDER_ROLE_PURPOSES = Object.freeze({
  primary: 'Choose the active inference profile for this conversation and eligible work.',
  subagent: 'Global profile used when NNA delegates work to sub-agents.',
  reviewer: 'Global profile used for permission and safety review.',
  vision: 'Global profile used for image analysis when the requesting agent cannot process images.',
});

export function auditOverlay(entries, governance = [], health = null) {
  if ((!Array.isArray(entries) || entries.length === 0) && (!Array.isArray(governance) || governance.length === 0)) {
    return overlay('audit', 'Governance audit', ['No governance decisions.']);
  }
  const lines = [];
  if (health) {
    lines.push(
      `Evidence ${health.evidence ?? 0} · decisions ${health.decisions ?? 0} · unsettled ${health.unsettled_decisions ?? 0}`,
      `Attention ${health.attention_evidence ?? 0} · uncertain effects ${health.uncertain_effects ?? 0}`,
      '',
    );
  }
  if (governance.length > 0) {
    lines.push('Governance decisions', '');
    for (const entry of governance.slice(-32)) {
      lines.push(`- ${entry.domain} · ${entry.outcome} · ${entry.reasonCode}`);
      lines.push(`  Subject: ${entry.subjectRef} · evidence ${entry.evidenceRefs?.length ?? 0} · authority ${entry.authorityRefs?.length ?? 0}`);
      if (entry.terminal) lines.push(`  Effect: ${entry.terminal.status} · certainty ${entry.terminal.effectCertainty}`);
    }
  }
  if (entries.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Reviewed tool calls', '');
    for (const [index, entry] of entries.slice(-32).entries()) {
      lines.push(`${index + 1}. ${entry.tool ?? 'unknown tool'} — ${entry.result ?? entry.decision ?? 'unknown'}`);
      lines.push(`   Decision: ${entry.decision ?? '--'} (${entry.reason ?? entry.reason_code ?? '--'})`);
      lines.push(`   Risk/scope: ${entry.risk ?? '--'} / ${entry.scope ?? '--'}`);
      lines.push(`   Effect: ${entry.effect ?? '--'} · certainty ${entry.effect_certainty ?? '--'}`);
      if (Number.isFinite(entry.elapsed_ms)) lines.push(`   Duration: ${Math.round(entry.elapsed_ms)} ms`);
      if (entry.repetition > 0) lines.push(`   Repetition: ${entry.repetition}`);
      lines.push('');
    }
  }
  return overlay('audit', 'Governance audit', lines);
}

export function healthOverlay(value) {
  return overlay('health', 'Runtime health', flatten(value));
}

export function providerOverlay(engine, options = {}) {
  const role = options.role ?? 'primary';
  const active = engine.config.routes[role];
  const labels = PROVIDER_ROLE_LABELS;
  const roleLabel = labels[role] ?? role;
  const assigned = role === 'primary' || active.assigned !== false;
  const manageProfiles = role === 'primary' && options.canManage;
  const purpose = PROVIDER_ROLE_PURPOSES[role];
  const scope = providerScope(role, options.isMain);
  const lines = [
    purpose,
    '',
    `Scope     ${scope}`,
    `Role      ${roleLabel}`,
    `Profile   ${assigned ? active.providerId : 'Not assigned'}`,
    `Model     ${assigned ? active.model : "Requesting conversation's Primary is used"}`,
  ];
  const items = [];
  if (role === 'primary' && options.inheritRoute) items.push({
    id: 'inherit', label: 'Copy Primary profile from Main',
    detail: 'One-time primary-route copy; global specialist roles remain shared.',
    section: 'Conversation route',
  });
  if (role !== 'primary') items.push({
    id: 'clear-role', label: 'No dedicated profile', badge: assigned ? '' : 'active',
    detail: 'Clear this global assignment; each requesting conversation then uses its own Agent profile.',
    section: `${roleLabel} assignment`,
  });
  for (const profile of Object.values(engine.config.providerProfiles)) {
    const isActive = assigned && profile.id === active.providerId;
    items.push({
      id: profile.id,
      label: profile.displayName,
      detail: `${profile.id} · ${profile.model} · ${profile.endpoint}${isActive ? ' · Active' : ''}`,
      section: role === 'primary' ? 'Provider profiles' : `Assign profile to ${roleLabel}`,
    });
  }
  if (manageProfiles) {
    items.push(
      providerAction('add', 'Add provider profile', 'Connect an inference endpoint and choose its default model'),
      providerAction('edit', 'Edit provider profile', 'Change its endpoint, default model, or credential reference'),
      providerAction('limits', 'Set model limits', 'Configure context and output-token limits'),
      providerAction('test', 'Test provider profile', 'Verify discovery and inference connectivity'),
      providerAction('delete', 'Delete unused profile', 'Remove a profile that is not assigned to a role'),
    );
  }
  return Object.freeze({
    ...menuOverlay('provider', 'Providers', lines, items, options.selectedId ?? (assigned ? active.providerId : 'clear-role')),
    tabs: Object.freeze(Object.entries(labels).map(([id, label]) => Object.freeze({ id, label, active: id === role }))),
    role,
    actionLabel: role !== 'primary' && options.canAssign === false
      ? 'Left/Right role · Global assignments are managed from Main'
      : manageProfiles ? 'Left/Right role · Up/Down choose · Enter make active/manage'
      : role === 'primary' ? 'Left/Right role · Up/Down choose · Enter make active'
        : 'Left/Right role · Up/Down choose · Enter assign/clear',
  });
}

function providerScope(role, isMain) {
  if (role !== 'primary') return 'Global workspace role (shared by every conversation)';
  return isMain ? 'Main workspace default (new conversations copy this once)' : 'This conversation only';
}

export function modelOverlay(engine, models = [], options = {}) {
  const active = engine.config.routes.primary;
  const profile = engine.config.providerProfiles[active.providerId];
  const endpoint = profile?.endpoint ?? active.providerId;
  const providerDefault = profile?.model ?? '--';
  const lines = [
    'Choose the model for this conversation.',
    '',
    `Provider  ${endpoint}`,
    `Current   ${active.model}`,
    `Default   ${providerDefault}`,
    '',
    models.length > 0 ? `Available models · discovered from ${endpoint}` : 'No model catalog was returned; use /model NAME.',
  ];
  if (options.discoveryError) lines.push(`Discovery unavailable: ${options.discoveryError}`);
  const items = [];
  if (options.inheritRoute) items.push({
    id: 'inherit', label: `Copy Main — ${options.inheritRoute.model}`,
    detail: `Copy ${engine.config.providerProfiles[options.inheritRoute.providerId]?.endpoint ?? options.inheritRoute.providerId} once`,
  });
  for (const model of models) {
    const badges = [];
    if (model === active.model) badges.push('current');
    if (model === providerDefault) badges.push('default');
    items.push({ id: model, label: model, badge: badges.join(' · ') });
  }
  return Object.freeze({
    ...menuOverlay('model', 'Model', lines, items, active.model),
    actionLabel: 'Up/Down choose · Enter use model',
  });
}

export function configOverlay(engine, options = {}) {
  const config = engine.config ?? engine;
  const primary = config.routes.primary;
  const endpoint = config.providerProfiles[primary.providerId]?.endpoint ?? primary.providerId;
  const lines = [
    'Choose a configuration area. Each entry opens its dedicated manager.',
    `Workspace: ${config.workspaceRoot}`,
    `Primary route: ${endpoint} / ${primary.model}`,
  ];
  if (options.status) lines.push('', options.status);
  const items = [
    { id: 'provider', label: 'Provider profiles and role routing', detail: `${Object.keys(config.providerProfiles).length} configured profiles` },
    { id: 'model', label: 'Active model', detail: 'Choose a conversation-local model from the active provider' },
    { id: 'mcp', label: 'MCP servers', detail: `${config.mcpServers.length} configured servers` },
    { id: 'websearch', label: 'WebSearch', detail: 'Configure, test, or locally deploy SearXNG' },
    { id: 'webfetch', label: 'WebFetch destinations', detail: 'Trust exact private-network origins for bounded fetching' },
    { id: 'gateway', label: 'Telegram gateway', detail: 'Configure authorized remote access and runtime status' },
    { id: 'workspace-trust', label: 'Workspace trust', detail: 'Control project configuration and hook discovery on restart' },
    { id: 'hooks', label: 'Hook bundles', detail: 'Inspect discovered event subscriptions and registration health' },
    { id: 'extensions', label: 'Extensions', detail: 'Inspect installed capabilities, lifecycle state, and diagnostics' },
  ];
  return Object.freeze({
    ...menuOverlay('config', 'Configuration', lines, items, options.selectedId ?? 'provider'),
    actionLabel: 'Up/Down choose · Enter open',
  });
}

export function gatewayOverlay(status, options = {}) {
  const runtime = status.runtime ?? { running: false };
  const lines = [
    'Telegram is a trusted remote operator surface. Unknown user IDs receive no response.',
    '',
    `State       ${status.enabled ? 'enabled' : 'disabled'}`,
    `Runtime     ${runtime.running ? `running (PID ${runtime.pid})` : 'stopped'}`,
    `Bot token   ${status.configured ? `configured via ${status.token_source}` : 'not configured'}`,
    `Operators   ${status.authorized_user_ids.length ? status.authorized_user_ids.join(', ') : 'none'}`,
    `Workspace   ${status.workspace_root ?? 'inherits the launch workspace'}`,
  ];
  if (options.message) lines.push('', options.message);
  const items = [
    { id: 'test', label: 'Test Telegram connection', detail: 'Validate the configured bot token with Telegram' },
    runtime.running
      ? { id: 'stop', label: 'Stop gateway', detail: 'Stop remote message polling without changing configuration' }
      : { id: 'start', label: 'Start gateway', detail: 'Start remote message polling in the background' },
    status.enabled
      ? { id: 'disable', label: 'Disable gateway', detail: 'Prevent the gateway from starting' }
      : { id: 'enable', label: 'Enable gateway', detail: 'Allow the configured gateway to start' },
    actionItem('authorize', 'Authorize Telegram user', '/gateway authorize NUMERIC_USER_ID'),
    actionItem('revoke', 'Revoke Telegram user', '/gateway revoke NUMERIC_USER_ID'),
    actionItem('token-env', 'Set token environment variable', '/gateway token-env ENV_NAME'),
    actionItem('workspace', 'Set gateway workspace', '/gateway workspace ABSOLUTE_PATH'),
  ];
  return menuOverlay('gateway', 'Telegram gateway', lines, items, options.selectedId ?? items[0].id);
}

export function workspaceTrustOverlay(workspaceRoot) {
  return menuOverlay('workspace-trust', 'Workspace trust', [
    `Workspace: ${workspaceRoot}`,
    'Trust controls whether project configuration and hooks are loaded after restart.',
  ], [
    { id: 'trust', label: 'Trust this workspace', detail: 'Load its project configuration and hooks after restart' },
    { id: 'untrust', label: 'Remove workspace trust', detail: 'Ignore its project configuration and hooks after restart' },
  ], 'trust');
}

export function webSearchOverlay(status, options = {}) {
  const lines = [
    `State: ${status.config.enabled ? 'enabled' : 'disabled'}`,
    `Provider: ${status.config.provider}`,
    `Endpoint: ${status.config.endpoint ?? '--'}`,
    `Ownership: ${status.config.managed ? 'managed by NNA' : 'user supplied'}`,
  ];
  if (status.test) lines.push(`Health: ${status.test.ok ? `ready (${status.test.results} test results)` : `unavailable (${status.test.error})`}`);
  if (options.message) lines.push('', options.message);
  lines.push('', 'Set a remote or existing endpoint with /websearch URL.');
  const items = [];
  if (status.config.enabled) items.push({ id: 'test', label: 'Test endpoint', detail: 'Run a bounded JSON search health check' });
  items.push({ id: 'deploy', label: 'Deploy local SearXNG', detail: 'Preflight Docker, bind loopback only, then validate' });
  if (status.config.managed) {
    items.push({ id: 'start', label: 'Start managed SearXNG', detail: 'Start the preserved local deployment' });
    items.push({ id: 'stop', label: 'Stop managed SearXNG', detail: 'Stop without deleting its container or data' });
  }
  if (status.config.enabled) items.push({ id: 'disable', label: 'Disable WebSearch', detail: 'Preserve endpoint and managed deployment data' });
  return menuOverlay('websearch', 'WebSearch · SearXNG', lines, items, options.selectedId ?? items[0]?.id);
}

export function webFetchOverlay(config, options = {}) {
  const lines = [
    'Public HTTP(S) text is available by default. Private and loopback destinations require exact origin trust.',
    'Redirects and resolved addresses are revalidated on every request.',
  ];
  if (options.message) lines.push('', options.message);
  if (config.trusted_origins.length === 0) lines.push('', 'No private origins are trusted.');
  const items = config.trusted_origins.map((origin) => ({ id: origin, label: origin, badge: 'trusted' }));
  items.push(
    actionItem('trust', 'Trust exact origin', '/webfetch trust http://host:port'),
    actionItem('revoke', 'Revoke trusted origin', '/webfetch revoke http://host:port'),
  );
  return menuOverlay('webfetch', 'WebFetch destinations', lines, items, options.selectedId ?? items[0]?.id);
}

export function mcpOverlay(servers, options = {}) {
  const lines = [
    'MCP servers extend NNA with externally supplied tools, resources, and prompts.',
    'Choose a server to inspect, test, edit, enable, disable, or remove it.',
    'Connection changes apply to new conversations and after restart.',
  ];
  if (options.message) lines.push('', options.message);
  if (servers.length === 0) lines.push('', 'No MCP servers configured.');
  const items = servers.map((server) => ({
    id: server.id,
    label: server.id,
    badge: server.enabled ? 'enabled' : 'disabled',
    detail: `${server.transport === 'streamable_http' ? 'HTTP' : 'stdio'} · ${server.endpoint ?? server.command} · ${server.runtime}`,
  }));
  if (options.canManage) items.push(
    { id: 'action:add', label: 'Add MCP server', detail: 'Connect an HTTP endpoint or a local stdio process' },
  );
  return Object.freeze({
    ...menuOverlay('mcp', 'MCP servers', lines, items, options.selectedId ?? items[0]?.id),
    actionLabel: 'Up/Down choose · Enter manage · Esc back',
  });
}

export function skillsOverlay(skills, options = {}) {
  const lines = [
    'Skills are bounded workflow guidance. They never grant tools, permissions, secrets, or broader scope.',
    skills.length > 0 ? `${skills.length} registered skill${skills.length === 1 ? '' : 's'}.` : 'No skills are registered.',
  ];
  if (options.message) lines.push('', options.message);
  const items = skills.map((skill) => ({
    id: skill.id, label: skill.id, badge: skill.invocation,
    detail: `${skill.description} · v${skill.version} · ${skill.source}`,
  }));
  return Object.freeze({
    ...menuOverlay('skills', 'Skills', lines, items, options.selectedId ?? items[0]?.id),
    actionLabel: 'Up/Down choose · Enter prepare invocation',
  });
}

export function overlayCommandDraft(kind, id) {
  if (!id.startsWith('action:')) return null;
  const action = id.slice(7);
  const drafts = {
    gateway: { authorize: '/gateway authorize ', revoke: '/gateway revoke ', 'token-env': '/gateway token-env ', workspace: '/gateway workspace ' },
    webfetch: { trust: '/webfetch trust ', revoke: '/webfetch revoke ' },
    tab: { rename: '/rename ' },
  };
  return drafts[kind]?.[action] ?? null;
}

export function contextOverlay(session) {
  const tokenAware = session.contextLimitTokens > 0;
  const percent = tokenAware
    ? Math.min(100, Math.round((session.contextTokens / session.contextLimitTokens) * 100))
    : session.contextLimitBytes > 0
      ? Math.min(100, Math.round((session.contextBytes / session.contextLimitBytes) * 100)) : null;
  return overlay('context', 'Context usage', [
    tokenAware
      ? `Prompt estimate: ${formatCount(session.contextTokens)} / ${formatCount(session.contextLimitTokens)} usable input tokens`
      : `Conservative context: ${formatBytes(session.contextBytes)} / ${formatBytes(session.contextLimitBytes)}`,
    `Utilization: ${percent === null ? '--' : `${percent}%`}`,
    `Auto-compact boundary: ${formatCount(session.contextThresholdTokens)} estimated tokens`,
    `Output reserved: ${formatCount(session.contextOutputReserveTokens)} tokens`,
    `Loaded parallel capacity: ${formatCount(session.contextParallelCapacity)}`,
    `Runtime source: ${session.contextSource ?? 'configured byte fallback'}`,
    `Hard byte ceiling: ${formatBytes(session.contextLimitBytes)}`,
    '',
    tokenAware
      ? 'NNA compacts before provider I/O at the model-aware boundary shown above.'
      : 'The provider did not report a token window; NNA is using its conservative byte ceiling.',
  ]);
}

function formatCount(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '--';
}

export function attachmentsOverlay(session) {
  const lines = session.pendingAttachments.length === 0
    ? ['No images are queued for the next message.']
    : session.pendingAttachments.flatMap((item, index) => [
      `${index + 1}. ${item.path}`, `   ${item.mime_type} · ${formatBytes(item.size)}`,
    ]);
  lines.push('', 'Use /attach PATH to add an image or /detach INDEX|all to remove one.');
  lines.push('Queued images are copied into managed storage only when the message is submitted.');
  return overlay('attachments', 'Attachments for next message', lines);
}

export function valueOverlay(kind, title, value) {
  return overlay(kind, title, typeof value === 'string' ? value.split('\n') : flatten(value));
}

export function tabMenuOverlay(session) {
  const items = [{ id: 'action:rename', label: 'Rename conversation', detail: 'Enter a new tab name' }];
  if (session.role !== 'primary') {
    const detail = session.activeTurnId ? 'Requires confirmation while work is active' : 'Close this tab';
    items.push({ id: 'action:close', label: 'Close conversation', detail });
  }
  return menuOverlay('tab', session.name, ['Conversation actions'], items, 'action:rename');
}

function overlay(kind, title, lines) {
  return Object.freeze({ kind, title, lines: Object.freeze(lines.slice(0, 256).map(String)) });
}

function menuOverlay(kind, title, lines, items, activeId) {
  const selected = Math.max(0, items.findIndex((item) => item.id === activeId));
  return Object.freeze({
    ...overlay(kind, title, lines), selected,
    items: Object.freeze(items.slice(0, 256).map((item) => Object.freeze({ ...item }))),
  });
}

function actionItem(id, label, detail) {
  return { id: `action:${id}`, label: `+ ${label}`, detail };
}

function providerAction(id, label, detail) {
  return { ...actionItem(id, label, detail), section: 'Manage profiles' };
}

function flatten(value, prefix = '', depth = 0) {
  if (depth > 5) return [`${prefix}: [bounded]`];
  if (value === null || typeof value !== 'object') return [`${prefix || 'value'}: ${String(value)}`];
  const lines = [];
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (item !== null && typeof item === 'object') lines.push(...flatten(item, label, depth + 1));
    else lines.push(`${label}: ${String(item)}`);
  }
  return lines.length > 0 ? lines : ['No data.'];
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '--';
  if (value < 1024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}
