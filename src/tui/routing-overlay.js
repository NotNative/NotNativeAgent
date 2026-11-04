// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { createFormOverlay, formField, handleFormEditing } from './form-engine.js';
import { createMenuOverlay } from './surface-engine.js';

const ROLES = Object.freeze([
  { id: 'primary', label: 'Primary', use: 'answers every normal message', required: true },
  { id: 'reviewer', label: 'Reviewer', use: 'checks tool requests before they run', required: false },
  { id: 'subagent', label: 'Sub-agent', use: 'runs delegated work in the background', required: false },
  { id: 'vision', label: 'Vision', use: 'reads attached images and video', required: false },
]);
const PRIMARY = 'primary';
const INHERIT = 'inherit';
const MANUAL = 'manual';
const RETRY = 'retry';
const EDITOR_BYTES = 256;
const MODEL_BYTES = 256;

// Why: /routing first names the four jobs and which model serves each. Which model is a second
// question, so Enter opens that job's model list instead of listing every model up front.
export function routingOverlay(engine, options = {}) {
  const config = engine?.config;
  const lines = [
    'Choose the job whose model you want to set.', '',
    ...(options.status ? [`Last change   ${options.status}`, ''] : []),
    `Scope         ${scopeText(options)}`,
  ];
  const items = ROLES.map((role) => ({
    id: `role:${role.id}`,
    label: `${role.label} · ${role.use}`,
    detail: resolvedChoice(config, role.id),
    section: role.id === PRIMARY ? 'Main model' : 'Specialist models',
    role: role.id,
  }));
  return Object.freeze({
    ...createMenuOverlay('routing', 'Routing · which model does each job', lines, items,
      { ...returnFields(options), activeId: options.selectedId ?? 'role:primary', isMain: options.isMain, canManage: options.canManage }),
    actionLabel: options.canManage === false
      ? 'Up/Down choose · Enter view models · Esc close'
      : 'Up/Down choose · Enter choose model · Esc close',
  });
}

// Why: the model list always names the job it is for, so a reader knows what the choice changes. Rows
// come from a fresh sweep, so a model that is no longer served appears as unavailable rather than absent.
export function routingModelOverlay(engine, roleId, options = {}) {
  const role = roleOf(roleId);
  const rows = (options.rows ?? []).filter((row) => typeof row?.model === 'string' && row.model.length > 0);
  const current = resolvedSelection(engine?.config, roleId);
  const lines = [
    `Choose the model for ${role.label.toLowerCase()}, which ${role.use}.`, '',
    ...(options.status ? [options.status, ''] : []),
    `Scope         ${scopeText(options)}`,
    role.required
      ? 'This model answers normal messages. Other jobs follow it until they get their own.'
      : 'Until you choose a model here, this job uses the Primary model.',
    '',
    ...(options.discoveryError ? [`Last check failed · ${options.discoveryError}`, ''] : []),
    'Reachability is checked again every time this list opens.',
  ];
  const items = rows.length === 0 && !options.discoveryError
    ? emptyStateItems(role, current)
    : [...clearItem(role, current), ...rowItems(roleId, rows, current, engine?.config), ...manualItem(role)];
  return Object.freeze({
    ...createMenuOverlay('routing-model', `${role.label} model`, lines, items,
      { ...returnFields(options), activeId: options.selectedId ?? items[0]?.id, role: role.id, sweep: rows, canManage: options.canManage }),
    actionLabel: options.canManage === false
      ? 'Read only · manage from Main · Esc back'
      : 'Up/Down choose · Enter use model · Esc back',
  });
}

export function manualModelOverlay(roleId, parent, existingEditor = null, error = null) {
  const role = roleOf(roleId);
  const form = {
    stepIndex: 0, error, draft: { model: '' },
    steps: [formField('model', 'Model name', `Type the exact name the connection expects for the ${role.label.toLowerCase()}.`, { limit: EDITOR_BYTES })],
  };
  const base = createFormOverlay(form, {
    kind: 'routing-model-manual', title: `${role.label} · model name`,
    actionLabel: 'Type the model name · Enter use it · Esc back',
  }, existingEditor);
  return Object.freeze({ ...base, role: role.id, parentModel: parent });
}

// Enter on a job opens its model list; Enter on a model saves it and closes. Escape steps back one menu,
// so leaving routing takes as many Escape presses as the depth that was opened.
export async function handleRoutingAction(action, workspace) {
  const overlay = workspace.projection.overlay;
  if (!overlay?.kind?.startsWith('routing')) return false;
  if (overlay.kind === 'routing-model-manual') return handleManualAction(action, workspace, overlay);
  if (action.action === 'back') return backOut(workspace, overlay);
  if (['cancel', 'help'].includes(action.action)) { workspace.projection.closeOverlay(); return true; }
  if (['history_up', 'history_down'].includes(action.action)) {
    workspace.projection.moveOverlaySelection(action.action === 'history_up' ? -1 : 1); return true;
  }
  if (action.action !== 'submit') return true;
  await submitChoice(overlay, workspace);
  return true;
}

async function handleManualAction(action, workspace, overlay) {
  if (action.action === 'back') { workspace.projection.openOverlay(overlay.parentModel); return true; }
  if (['cancel', 'help'].includes(action.action)) { workspace.projection.closeOverlay(); return true; }
  if (action.action !== 'submit') { handleFormEditing(action, overlay.editor); return true; }
  const model = overlay.editor?.text?.trim() ?? '';
  if (model.length === 0 || model.length > MODEL_BYTES) {
    workspace.projection.openOverlay(manualModelOverlay(overlay.role, overlay.parentModel, overlay.editor,
      'Enter the model name the connection expects, in 256 characters or fewer.'));
    return true;
  }
  const engine = engineFor(workspace, overlay.role);
  await saveModel(overlay, { providerId: engine.config.routes.primary.providerId, model }, workspace, engine);
  return true;
}

function backOut(workspace, overlay) {
  if (overlay.kind === 'routing-model' || overlay.parent === 'config') {
    workspace.projection.openOverlay(routingOverlay(engineFor(workspace, null), {
      ...returnFields(overlay), configSection: overlay.configSection,
      selectedId: overlay.role ? `role:${overlay.role}` : undefined,
    }));
    return true;
  }
  return false;
}

async function submitChoice(overlay, workspace) {
  const selected = overlay.items?.[overlay.selected];
  if (!selected) return;
  if (overlay.kind === 'routing') {
    await openModelList(selected.role, workspace, engineFor(workspace, selected.role), {
      ...returnFields(overlay), canManage: overlay.canManage,
    });
    return;
  }
  if (selected.id === MANUAL) { workspace.projection.openOverlay(manualModelOverlay(overlay.role, overlay, null, null)); return; }
  if (selected.id === RETRY || selected.id === undefined) return;
  if (selected.id === INHERIT) { await clearRole(overlay, workspace); return; }
  await saveModel(overlay, selected.value ?? null, workspace, engineFor(workspace, overlay.role));
}

async function saveModel(overlay, selection, workspace, engine) {
  if (overlay.canManage === false) { workspace.projection.showNotice('provider', 'Change routing from the Main conversation.'); return; }
  if (typeof selection?.providerId !== 'string' || typeof selection.model !== 'string') {
    workspace.projection.showNotice('provider', 'That row names no connection; reopen this list.');
    return;
  }
  try {
    if (overlay.role === PRIMARY) await workspace.selectRoute(selection.providerId, selection.model);
    else await workspace.selectProviderForRole(overlay.role, selection.providerId);
    workspace.projection.closeOverlay();
    workspace.projection.showNotice('route', savedNotice(overlay.role, selection.model, overlay, engine));
  } catch (error) {
    workspace.projection.showNotice('provider', `Cannot save · ${error.message}`);
  }
}

async function clearRole(overlay, workspace) {
  if (overlay.canManage === false) { workspace.projection.showNotice('provider', 'Change routing from the Main conversation.'); return; }
  try {
    await workspace.clearProviderForRole(overlay.role);
    workspace.projection.closeOverlay();
    workspace.projection.showNotice('route', `${roleOf(overlay.role).label} now follows the Primary model.`);
  } catch (error) {
    workspace.projection.showNotice('provider', `Cannot clear · ${error.message}`);
  }
}

async function openModelList(roleId, workspace, engine, options) {
  let rows = [], discoveryError;
  try {
    rows = typeof workspace.modelSweep === 'function' ? await workspace.modelSweep() : [];
    if (rows.length === 0) rows = await configuredRows(workspace, engine);
  } catch (error) {
    discoveryError = error.code ?? error.message ?? 'provider unavailable';
  }
  workspace.projection.openOverlay(routingModelOverlay(engine, roleId, {
    ...options, rows: visionRows(roleId, rows, engine.config), discoveryError,
  }));
}

// Why: a connection that cannot list models still proves the model it was configured with, so the list
// keeps that row instead of claiming nothing is reachable.
async function configuredRows(workspace, engine) {
  let listed = [];
  try { listed = await workspace.availableModels(); } catch { listed = []; }
  const providerId = engine.config.routes.primary.providerId;
  const models = listed.length > 0 ? listed : Object.values(engine.config.connectionRecords).map((profile) => profile.model);
  return models.filter(Boolean).map((model) => ({
    connection_id: providerId, connection_name: null, endpoint: null, model, status: 'configured',
  }));
}

// Why: a model is only called image capable when the connection or model card says so. An unproven row
// stays listed without that badge, so a choice never looks verified when it is not.
function visionRows(roleId, rows, config) {
  if (roleId !== 'vision') return rows;
  return rows.map((row) => {
    const declared = config.connectionRecords[row.connection_id]?.capabilities?.images;
    if (declared === true) return { ...row, status: row.status === 'observed' ? 'vision' : row.status };
    if (declared === false) return { ...row, status: 'unavailable', reason_code: 'declares no image support' };
    return { ...row, status: row.status ?? null };
  });
}

function rowItems(roleId, rows, current, config) {
  return rows.map((row) => {
    const badges = [row.connection_name ?? row.connection_id];
    // Why: a specialist names a connection, so a model of the same name on another connection is not in use.
    if (row.model === current.model && (roleId === PRIMARY || row.connection_id === current.providerId)) badges.push('in use');
    if (row.status === 'unavailable') badges.push(`unavailable${row.reason_code ? ` · ${row.reason_code}` : ''}`);
    else if (row.status === 'vision') badges.push('image capable');
    else if (row.status === 'configured') badges.push('listed, not probed');
    if (Number.isSafeInteger(row.context_limit_tokens)) badges.push(`${row.context_limit_tokens.toLocaleString('en-US')} ctx`);
    return {
      id: `${row.connection_id}/${row.model}`, label: row.model, badge: badges.join(' · '),
      detail: `${row.connection_name ?? row.connection_id} · ${row.endpoint ?? (config.connectionRecords[row.connection_id]?.endpoint ?? 'endpoint unknown')}`,
      section: String(row.connection_name ?? config.connectionRecords[row.connection_id]?.displayName ?? row.connection_id),
      value: { providerId: row.connection_id, model: row.model },
    };
  });
}

function clearItem(role, current) {
  if (role.required || !current.assigned) return [];
  return [{
    id: INHERIT, label: 'Use the Primary model', badge: 'clear this choice',
    detail: 'This job follows whatever model Primary uses, now and later.', section: 'Follow Primary',
  }];
}

function manualItem(role) {
  if (!role.required) return [];
  return [{
    id: MANUAL, label: 'Enter a model name', badge: 'when the list misses it',
    detail: 'Type the model name for a connection that could not list its models.',
    section: 'Not listed',
  }];
}

function emptyStateItems(role, current) {
  return [...clearItem(role, current), {
    id: RETRY, label: 'No model was listed', badge: 'close, then reopen',
    detail: 'Check the connection under Connections, then open this list again.',
    section: 'Nothing to choose',
  }];
}

function resolvedChoice(config, roleId) {
  const selection = resolvedSelection(config, roleId);
  if (!selection.assigned) return `follows Primary · ${selection.model}`;
  return `${selection.model} · ${config.connectionRecords[selection.providerId]?.displayName ?? selection.providerId}`;
}

function resolvedSelection(config, roleId) {
  const route = config?.routes?.[roleId];
  if (!route) return { providerId: null, model: '--', assigned: false };
  return { providerId: route.providerId, model: route.model, assigned: roleId === PRIMARY || route.assigned !== false };
}

function savedNotice(roleId, model, overlay, engine) {
  const role = roleOf(roleId);
  if (roleId !== PRIMARY) return `${role.label} now uses ${model} from ${engine.config.routes[roleId]?.providerId ?? 'Primary'} in every conversation.`;
  return `${role.label} now uses ${model} for ${overlay.isMain
    ? 'the Main workspace default, which new conversations copy'
    : 'this conversation only'}.`;
}

function scopeText(options) {
  return options?.isMain || options?.scope === 'main'
    ? 'Main · new conversations copy this choice when they start'
    : 'This conversation · Main settings are unchanged';
}

function returnFields(options) {
  return {
    parent: options?.parent, configSection: options?.configSection,
    scope: options?.scope, status: options?.status ?? null, isMain: options?.isMain,
  };
}

function roleOf(roleId, hint = null) {
  const role = ROLES.find((item) => item.id === roleId);
  if (!role) {
    const accepted = ROLES.map((item) => item.id).join(', ');
    throw new ContractError('route_role_invalid', hint ? `use /routing, or /routing ${hint}; roles are ${accepted}` : `unknown routing role ${roleId}`);
  }
  return role;
}

// Why: Primary belongs to the active conversation while a specialist belongs to the workspace, so each
// role reads the configuration that the same choice writes to.
function engineFor(workspace, roleId) {
  const config = roleId !== null && roleId !== PRIMARY ? workspace.config ?? workspace.activeConfig() : workspace.activeConfig();
  return { config };
}

export async function handleRoutingCommand(argument, workspace, open) {
  const values = String(argument ?? '').split(/\s+/u).filter(Boolean);
  if (values.length === 0) {
    open(routingOverlay(engineFor(workspace, null), optionsFor(workspace)));
    return;
  }
  const role = roleOf(values[0], 'ROLE MODEL');
  if (values.length > 2) throw new ContractError('provider_request_invalid', 'use /routing ROLE MODEL, or /routing ROLE primary');
  if (values[1] === 'primary') { await workspace.clearProviderForRole(role.id); return; }
  if (!values[1]) { await openModelList(role.id, workspace, engineFor(workspace, role.id), optionsFor(workspace)); return; }
  if (values[1].length > MODEL_BYTES) throw new ContractError('provider_request_invalid', 'model names are limited to 256 characters');
  const providerId = engineFor(workspace, role.id).config.routes.primary.providerId;
  if (role.id === PRIMARY) await workspace.selectRoute(providerId, values[1]);
  else await workspace.selectProviderForRole(role.id, providerId);
  workspace.projection.showNotice('route', savedNotice(role.id, values[1], optionsFor(workspace), engineFor(workspace, role.id)));
}

function optionsFor(workspace) {
  const isMain = workspace.projection.active()?.role === 'primary';
  return { isMain, canManage: isMain, scope: isMain ? 'main' : 'conversation' };
}
