// SPDX-License-Identifier: Apache-2.0
import { contextPercentText } from './context.js';
import { createMenuOverlay } from './surface-engine.js';
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
  if ((!Array.isArray(entries) || entries.length === 0)
      && (!Array.isArray(governance) || governance.length === 0) && !health) {
    return overlay('audit', 'Governance audit', ['No governance decisions.']);
  }
  const lines = [];
  if (health) {
    lines.push(
      `Evidence ${health.evidence ?? 0} | decisions ${health.decisions ?? 0} | unsettled ${health.unsettled_decisions ?? 0}`,
      `Pending proposals ${health.pending_evidence ?? 0} | attention ${health.attention_evidence ?? 0} | uncertain effects ${health.uncertain_effects ?? 0}`,
      '',
    );
  }
  if (governance.length > 0) {
    lines.push('Governance decisions', '');
    for (const entry of governance.slice(-32)) {
      lines.push(`- ${entry.domain} | ${entry.outcome} | ${entry.reasonCode}`);
      lines.push(`  Subject: ${entry.subjectRef} | evidence ${entry.evidenceRefs?.length ?? 0} | authority ${entry.authorityRefs?.length ?? 0}`);
      if (entry.terminal) lines.push(`  Effect: ${entry.terminal.status} | certainty ${entry.terminal.effectCertainty}`);
    }
  }
  if (entries.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Reviewed tool calls', '');
    for (const [index, entry] of entries.slice(-32).entries()) {
      lines.push(`${index + 1}. ${entry.tool ?? 'unknown tool'} - ${entry.result ?? entry.decision ?? 'unknown'}`);
      lines.push(`   Decision: ${entry.decision ?? '--'} (${entry.reason ?? entry.reason_code ?? '--'})`);
      lines.push(`   Risk/scope: ${entry.risk ?? '--'} / ${entry.scope ?? '--'}`);
      lines.push(`   Effect: ${entry.effect ?? '--'} | certainty ${entry.effect_certainty ?? '--'}`);
      if (Number.isFinite(entry.elapsed_ms)) lines.push(`   Duration: ${Math.round(entry.elapsed_ms)} ms`);
      if (entry.repetition > 0) lines.push(`   Repetition: ${entry.repetition}`);
      lines.push('');
    }
  }
  return overlay('audit', 'Governance audit', lines);
}
export function providerOverlay(engine, options = {}) {
  const role = options.role ?? 'primary';
  const active = engine.config.routes?.[role] ?? {};
  const labels = PROVIDER_ROLE_LABELS;
  const roleLabel = labels[role] ?? role;
  const assigned = role === 'primary' || active.assigned !== false;
  const manageProfiles = role === 'primary' && options.canManage;
  const purpose = PROVIDER_ROLE_PURPOSES[role], scope = providerScope(role, options.isMain);
  const authorityWarning = role === 'primary' && options.isMain === false;
  const lines = [
    ...(authorityWarning ? ['! Profile management unavailable here — this Console does not own Main workspace authority.',
      'Existing profiles remain selectable. Use the [* Main *] authority Console to add, edit, test, or delete profiles.', ''] : []),
    purpose,
    '',
    `Scope     ${scope}`,
    `Role      ${roleLabel}`,
    `Profile   ${assigned ? active.providerId : 'Not assigned'}`,
    `Model     ${assigned ? active.model : "Requesting conversation's Primary is used"}`,
  ];
  const items = [providerRouteSettingsAction(engine.config, role, active, roleLabel)];
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
    lineKinds: authorityWarning ? Object.freeze(['warning', 'body', '', ...lines.slice(3).map(() => 'body')]) : undefined,
    tabs: Object.freeze(Object.entries(labels).map(([id, label]) => Object.freeze({ id, label, active: id === role }))),
    role,
    actionLabel: providerActionLabel(role, options.canAssign, manageProfiles),
  });
}
function providerActionLabel(role, canAssign, manageProfiles) {
  if (role !== 'primary' && canAssign === false) return 'Left/Right role · Global assignments are managed from Main';
  if (manageProfiles) return 'Left/Right role · Up/Down choose · Enter make active/manage';
  return role === 'primary' ? 'Left/Right role · Up/Down choose · Enter make active'
    : 'Left/Right role · Up/Down choose · Enter assign/clear';
}
function providerRouteSettingsAction(config, role, route, roleLabel) {
  return {
    id: 'route-settings', label: 'Settings', badge: role === 'primary'
      ? (config.limits.providerOverrideMs === null ? 'defaults' : 'configured')
      : (route.deadlineOverrideMs === null ? 'Primary timeout' : 'custom timeout'),
    detail: role === 'primary' ? 'Inspect and configure the Primary route settings.'
      : 'Inspect and configure this route; timeout overrides can return to Primary.', section: `${roleLabel} route`,
  };
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
  const limits = config.limits ?? {};
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
    { id: 'mcp', label: 'MCP servers', detail: `${config.mcpServers?.length ?? 0} configured servers` },
    { id: 'secrets', label: 'Secrets', detail: 'Manage write-only credentials in the local NNA broker' },
    { id: 'websearch', label: 'WebSearch', detail: 'Configure, test, or locally deploy SearXNG' },
    { id: 'webfetch', label: 'WebFetch destinations', detail: 'Trust exact private-network origins for bounded fetching' },
    { id: 'gateway', label: 'Telegram gateway', detail: 'Configure authorized remote access and runtime status' },
    { id: 'context', label: 'Context management', detail: `${contextPercentText(limits.contextCompressionThreshold ?? 0.40)} / ${contextPercentText(limits.contextCompressionLevel2Threshold ?? 0.55)} / ${contextPercentText(limits.contextCompressionLevel3Threshold ?? 0.70)} compression · ${contextPercentText(limits.contextCompactionThreshold ?? 0.75)} full compaction` },
    { id: 'workspace-trust', label: 'Workspace trust', detail: 'Control project configuration and hook discovery on restart' },
    { id: 'hooks', label: 'Hook bundles', detail: 'Inspect discovered event subscriptions and registration health' },
    { id: 'extensions', label: 'Extensions', detail: 'Inspect installed capabilities, lifecycle state, and diagnostics' },
  ];
  return Object.freeze({
    ...menuOverlay('config', 'Configuration', lines, items, options.selectedId ?? 'provider'),
    actionLabel: 'Up/Down choose · Enter open',
  });
}
export function secretsOverlay(secrets, options = {}) {
  secrets = Array.isArray(secrets) ? secrets : [];
  const lines = [
    'Managed values are write-only. NNA shows labels and field names, never stored values.',
    'Local secrets belong only to this NNA installation and are invisible to NNO realms.',
    'Disabling or deleting a secret here does not revoke it at the issuing service.',
  ];
  if (options.message) lines.push('', options.message);
  const items = secrets.map((secret) => ({
    id: secret.id, label: secret.label, badge: secret.enabled ? 'enabled' : 'disabled',
    detail: `${secretKindDisplayName(secret.kind)} · ${(secret.fields ?? []).join(', ')}${secret.rotatedAt ? ` · replaced ${secret.rotatedAt.slice(0, 10)}` : ''}`,
    section: 'Local secrets',
  }));
  items.push({ id: 'action:add', label: '+ Add secret', detail: 'Store a new encrypted, write-only credential', section: 'Manage secrets' });
  return Object.freeze({
    ...menuOverlay('secrets', 'Secrets', lines, items, options.selectedId ?? items[0]?.id),
    parent: options.parent,
    configSection: options.configSection,
    actionLabel: 'Up/Down choose · Enter inspect/manage · Esc back',
  });
}
export function gatewayOverlay(status, options = {}) {
  status = status ?? {};
  const runtime = status.runtime ?? { running: false };
  const lines = [
    'Telegram is a trusted remote operator surface. Unknown user IDs receive no response.',
    '',
    `State       ${status.enabled ? 'enabled' : 'disabled'}`,
    `Runtime     ${runtime.running ? `running (PID ${runtime.pid})` : 'stopped'}`,
    `Bot token   ${status.configured ? `configured via ${status.token_source}` : 'not configured'}`,
    `Operators   ${status.authorized_user_ids?.length ? status.authorized_user_ids.join(', ') : 'none'}`,
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
  status = status ?? {}; const config = status.config ?? {};
  const lines = [
    `State: ${config.enabled ? 'enabled' : 'disabled'}`,
    `Provider: ${config.provider ?? '--'}`,
    `Endpoint: ${config.endpoint ?? '--'}`,
    `Ownership: ${config.managed ? 'managed by NNA' : 'user supplied'}`,
  ];
  if (status.test) lines.push(`Health: ${status.test.ok ? `ready (${status.test.results} test results)` : `unavailable (${status.test.error})`}`);
  if (options.message) lines.push('', options.message);
  lines.push('', 'Choose an action below. Configure accepts an existing local or remote SearXNG endpoint.');
  const items = [
    { id: 'action:configure', label: 'Configure endpoint', detail: 'Set or replace the URL of an existing SearXNG service' },
  ];
  if (config.enabled) items.push({ id: 'test', label: 'Test endpoint', detail: 'Run a bounded JSON search health check' });
  items.push({ id: 'deploy', label: config.managed ? 'Redeploy local SearXNG' : 'Deploy local SearXNG', detail: 'Preflight Docker, recreate the local service, then validate' });
  if (config.managed) {
    items.push({ id: 'start', label: 'Start managed SearXNG', detail: 'Start the preserved local deployment' });
    items.push({ id: 'stop', label: 'Stop managed SearXNG', detail: 'Stop without deleting its container or data' });
  }
  if (config.enabled || config.endpoint) items.push({
    id: 'disable', label: 'Disable and clear WebSearch', detail: 'Remove the active WebSearch configuration; preserve any local deployment',
  });
  items.push({ id: 'remove', label: 'Remove local deployment', detail: 'Stop and delete NNA-managed SearXNG containers and local deployment data' });
  return menuOverlay('websearch', 'WebSearch · SearXNG', lines, items, options.selectedId ?? items[0]?.id);
}

export function webFetchOverlay(config, options = {}) {
  const trustedOrigins = config?.trusted_origins ?? [];
  const lines = [
    'Public HTTP(S) text is available by default. Private and loopback destinations require exact origin trust.',
    'Redirects and resolved addresses are revalidated on every request.',
  ];
  if (options.message) lines.push('', options.message);
  if (trustedOrigins.length === 0) lines.push('', 'No private origins are trusted.');
  const items = trustedOrigins.map((origin) => ({ id: origin, label: origin, badge: 'trusted' }));
  items.push(
    actionItem('trust', 'Trust exact origin', '/webfetch trust http://host:port'),
    actionItem('revoke', 'Revoke trusted origin', '/webfetch revoke http://host:port'),
  );
  return menuOverlay('webfetch', 'WebFetch destinations', lines, items, options.selectedId ?? items[0]?.id);
}

export function mcpOverlay(servers, options = {}) {
  servers = Array.isArray(servers) ? servers.filter((server) => server && typeof server === 'object') : [];
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
    detail: `${server.transport === 'streamable_http' ? 'HTTP' : 'stdio'} · ${server.endpoint ?? server.command ?? '--'} · ${server.runtime ?? '--'}`,
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
  skills = Array.isArray(skills) ? skills.filter((skill) => skill && typeof skill === 'object') : [];
  const lines = [
    'Skills are bounded workflow guidance. They never grant tools, permissions, secrets, or broader scope.',
    skills.length > 0 ? `${skills.length} registered skill${skills.length === 1 ? '' : 's'}.` : 'No skills are registered.',
  ];
  if (options.message) lines.push('', options.message);
  const items = skills.map((skill) => ({
    id: skill.id ?? 'unknown', label: skill.id ?? 'unknown', badge: skill.invocation ?? '',
    detail: `${skill.description ?? '--'} · v${skill.version ?? '--'} · ${skill.source ?? '--'}`,
  }));
  return Object.freeze({
    ...menuOverlay('skills', 'Skills', lines, items, options.selectedId ?? items[0]?.id),
    actionLabel: 'Up/Down choose · Enter prepare invocation',
  });
}

export function dreamOverlay(status, candidates = [], options = {}) {
  status = status ?? {}; candidates = Array.isArray(candidates) ? candidates : [];
  const pending = status.pending;
  const lines = [
    'Idle maintenance learns only from governed evidence. Foreground activity always cancels maintenance.',
    '',
    `State       ${status.enabled ? status.state : 'disabled'}`,
    `Next stage  ${pending ? dreamStage(pending.stage) : 'Evidence harvest'}`,
    `Pending     ${pending ? `${pending.id} · ${pending.result_code ?? 'ready'}` : 'None'}`,
    `Candidates  ${candidates.length}`,
  ];
  if (options.message) lines.push('', options.message);
  const items = [
    { id: 'action:run', label: 'Run next maintenance stage', detail: 'Run one bounded stage now; foreground activity still cancels it' },
    status.state === 'paused'
      ? { id: 'action:resume', label: 'Resume idle maintenance', detail: 'Allow eligible idle stages to continue' }
      : { id: 'action:pause', label: 'Pause idle maintenance', detail: 'Stop scheduling new idle stages' },
    ...candidates.map((candidate) => ({
      id: `candidate:${candidate.id}`, label: candidate.kind, badge: candidate.state,
      detail: `${candidate.id ?? 'unknown'} · confidence ${Number.isFinite(candidate.confidence) ? candidate.confidence.toFixed(2) : '--'} · observed ${candidate.recurrence_count ?? 0}x`,
      section: 'Learning candidates',
    })),
  ];
  return Object.freeze({
    ...menuOverlay('dream', 'Idle maintenance', lines, items, options.selectedId ?? items[0]?.id),
    actionLabel: 'Up/Down choose · Enter inspect/run · Esc back',
  });
}

function dreamStage(stage) {
  return ({ 1: 'Operational diagnosis', 2: 'Project-memory eligibility', 3: 'NNM reconciliation', 4: 'NNM hygiene' })[stage]
    ?? `Stage ${stage}`;
}

export function overlayCommandDraft(kind, id) {
  if (!id.startsWith('action:')) return null;
  const action = id.slice(7);
  const drafts = {
    gateway: { authorize: '/gateway authorize ', revoke: '/gateway revoke ', 'token-env': '/gateway token-env ', workspace: '/gateway workspace ' },
    webfetch: { trust: '/webfetch trust ', revoke: '/webfetch revoke ' },
    websearch: { configure: '/websearch configure ' },
    tab: { rename: '/rename ' },
    plan: { 'set-goal': '/goal ', 'complete-goal': '/goal complete ', 'add-task': '/task add ' },
    context: {
      level1: '/context level1 ', level2: '/context level2 ', level3: '/context level3 ',
      compaction: '/context compaction ',
    },
  };
  return drafts[kind]?.[action] ?? null;
}

export function planOverlay(work, options = {}) {
  const tasks = Array.isArray(work?.tasks) ? work.tasks : [];
  const goal = work.goal;
  const complete = tasks.filter((task) => task.status === 'completed').length;
  const lines = [
    goal ? goal.objective : 'No goal has been defined for this conversation.',
    goal ? `Status: ${goal.status ?? 'unknown'} | Progress: ${complete}/${tasks.length} tasks complete | Revision: ${work.revision ?? 0}`
      : 'Planning is optional. Add a goal only when structured progress helps the work.',
  ];
  const items = [];
  items.push({ id: 'action:set-goal', label: goal ? 'Update goal' : 'Set goal', detail: 'Describe the durable outcome for this conversation', section: 'Goal' });
  if (goal?.status === 'active') items.push({ id: 'action:complete-goal', label: 'Complete goal', detail: 'Requires concrete completion evidence', section: 'Goal' });
  if (goal?.status === 'completed') items.push({ id: 'action:goal-reopen', label: 'Reopen goal', detail: 'Return this goal to active work', section: 'Goal' });
  items.push({ id: 'action:add-task', label: 'Add task', detail: 'Append one ordered pending task', section: 'Tasks' });
  for (const task of tasks) items.push({
    id: `task:${task.id}`, label: `${taskMarker(task.status)} ${task.id}  ${task.title}`,
    badge: task.status.replace('_', ' '), detail: task.evidence ?? task.blockedReason ?? 'Open task details', section: 'Tasks',
  });
  return Object.freeze({
    ...menuOverlay('plan', 'Plan', lines, items, options.selectedId ?? selectedTaskId(tasks)),
    actionLabel: 'Up/Down choose · Enter manage',
  });
}

function selectedTaskId(tasks) { const active = tasks.find((task) => task.status === 'in_progress'); return active ? `task:${active.id}` : 'action:add-task'; }

export function taskOverlay(work, id) {
  const task = work.tasks.find((item) => item.id === id);
  if (!task) return overlay('work-task', 'Task unavailable', [`Task ${id} no longer exists.`]);
  const lines = [task.title, `Status: ${task.status}`, task.evidence ? `Evidence: ${task.evidence}` : task.blockedReason ? `Blocked: ${task.blockedReason}` : ''];
  const items = [];
  if (task.status !== 'in_progress') items.push({ id: `action:start:${id}`, label: 'Start task', detail: 'Make this the one in-progress task' });
  if (task.status !== 'pending') items.push({ id: `action:pending:${id}`, label: 'Return to pending', detail: 'Keep the task without active or terminal status' });
  if (task.status !== 'completed') items.push({ id: `action:complete:${id}`, label: 'Complete task', detail: 'Requires concrete evidence' });
  if (task.status !== 'blocked') items.push({ id: `action:block:${id}`, label: 'Block task', detail: 'Requires a specific blocking reason' });
  return Object.freeze({ ...menuOverlay('work-task', `Task ${id}`, lines.filter(Boolean), items, items[0]?.id), parent: 'plan', taskId: id });
}

function taskMarker(status) {
  return ({ pending: '[ ]', in_progress: '[>]', completed: '[x]', blocked: '[!]' })[status] ?? '[?]';
}

export function attachmentsOverlay(session) {
  const attachments = session?.pendingAttachments ?? [];
  const lines = attachments.length === 0
    ? ['No images are queued for the next message.']
    : attachments.flatMap((item, index) => [
      `${index + 1}. ${item?.path ?? '--'}`, `   ${item?.mime_type ?? '--'} · ${formatBytes(item?.size)}`,
    ]);
  lines.push('', 'Use /attach PATH to add an image or /detach INDEX|all to remove one.');
  lines.push('Queued images are copied into managed storage only when the message is submitted.');
  return overlay('attachments', 'Attachments for next message', lines);
}

export function valueOverlay(kind, title, value) {
  return overlay(kind, title, typeof value === 'string' ? value.split('\n') : flatten(value));
}

export function resumeOverlay(sessions, attachedIds = []) {
  sessions = Array.isArray(sessions) ? sessions.filter((item) => item && typeof item === 'object') : [];
  const attached = new Set(attachedIds);
  const eligible = sessions.filter((item) => item.resumable && !attached.has(item.session_id));
  const hosted = sessions.filter((item) => !item.resumable).length;
  const lines = [
    'Choose a saved standalone conversation to attach as a new tab.',
    'The transcript is restored with this Console\'s current provider and workspace configuration.',
  ];
  if (hosted > 0) lines.push(`${hosted} authenticated host or mission session(s) are hidden; resume those from their original host.`);
  if (eligible.length === 0) lines.push('No unattached standalone conversations are available.');
  const items = eligible.map((item) => ({
    id: item.session_id,
    label: item.session_id,
    detail: `${item.updated_at} · ${item.latest_outcome ?? 'no completed turns'}`,
  }));
  return menuOverlay('resume', 'Resume conversation', lines, items, items[0]?.id);
}

export function tabMenuOverlay(session) {
  session = session ?? {};
  const items = [{ id: 'action:rename', label: 'Rename conversation', detail: 'Enter a new tab name' }];
  if (session.role !== 'primary') {
    const detail = session.activeTurnId ? 'Requires confirmation while work is active' : 'Close this tab';
    items.push({ id: 'action:close', label: 'Close conversation', detail });
  }
  return menuOverlay('tab', session.name ?? 'Conversation', ['Conversation actions'], items, 'action:rename');
}

function overlay(kind, title, lines) {
  return Object.freeze({ kind, title, lines: Object.freeze(lines.slice(0, 256).map(String)) });
}

function menuOverlay(kind, title, lines, items, activeId) {
  return createMenuOverlay(kind, title, lines, items, { activeId });
}

function actionItem(id, label, detail) { return { id: `action:${id}`, label: `+ ${label}`, detail }; }

function providerAction(id, label, detail) { return { ...actionItem(id, label, detail), section: 'Manage profiles' }; }

function secretKindDisplayName(kind) {
  return ({ api_key: 'API key', token: 'Access token', text: 'Other secret', username_password: 'Username and password' })[kind]
    ?? String(kind ?? 'Unknown').replaceAll('_', ' ');
}

function flatten(value, prefix = '', depth = 0, seen = new WeakSet()) {
  if (depth > 5) return [`${prefix}: [bounded]`];
  if (value === null || typeof value !== 'object') return [`${prefix || 'value'}: ${String(value)}`];
  if (seen.has(value)) return [`${prefix || 'value'}: [circular]`]; seen.add(value);
  const lines = [];
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (item !== null && typeof item === 'object') lines.push(...flatten(item, label, depth + 1, seen));
    else lines.push(`${label}: ${String(item)}`);
  }
  return lines.length > 0 ? lines : ['No data.'];
}
function formatBytes(value) {
  if (!Number.isFinite(value)) return '--'; if (value < 1024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}
