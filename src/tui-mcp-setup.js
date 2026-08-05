// SPDX-License-Identifier: Apache-2.0
import { isAbsolute } from 'node:path';
import { ContractError } from './ids.js';
import { parseCommand } from './hook-runner.js';
import { EditorBuffer } from './tui-model.js';
import { handleEditorAction } from './tui-editor-actions.js';
import { mcpOverlay } from './tui-overlays.js';
import { isManagedMcpCredentialReference } from './mcp-credentials.js';

const SETUP_KINDS = new Set([
  'mcp-server', 'mcp-transport', 'mcp-form', 'mcp-auth', 'mcp-delete-confirm',
]);

export function isMcpSetupOverlay(overlay) {
  return SETUP_KINDS.has(overlay?.kind);
}

export function beginMcpManagementSelection(selected, workspace, overlay) {
  if (overlay?.kind !== 'mcp' || !selected) return false;
  const returnParent = parentFrom(overlay);
  if (selected.id === 'action:add') {
    workspace.projection.openOverlay(transportOverlay(returnParent));
    return true;
  }
  const server = workspace.mcpStatus().find((entry) => entry.id === selected.id);
  if (!server) return false;
  workspace.projection.openOverlay(serverOverlay(server, returnParent, canManage(workspace)));
  return true;
}

export async function handleMcpSetupAction(action, workspace) {
  const overlay = workspace.projection.overlay;
  if (!isMcpSetupOverlay(overlay)) return false;
  if (overlay.kind === 'mcp-form') return handleFormAction(action, workspace, overlay);
  if (['history_up', 'history_down'].includes(action.action)) {
    workspace.projection.moveOverlaySelection(action.action === 'history_up' ? -1 : 1);
    return true;
  }
  if (action.action === 'back') {
    openBack(workspace, overlay);
    return true;
  }
  if (['cancel', 'help'].includes(action.action)) {
    workspace.projection.closeOverlay();
    return true;
  }
  if (action.action !== 'submit' || !overlay.items?.length) return true;
  const selected = overlay.items[overlay.selected];
  if (overlay.kind === 'mcp-transport') {
    openPrimaryForm(workspace, {
      operation: 'add', transport: selected.id, draft: {}, stepIndex: 0,
      returnParent: overlay.returnParent,
    });
  } else if (overlay.kind === 'mcp-server') {
    await handleServerAction(selected.id, workspace, overlay);
  } else if (overlay.kind === 'mcp-auth') {
    if (selected.id === 'managed') workspace.projection.openOverlay(tokenFormOverlay({ ...overlay.formState, authMode: 'managed' }));
    else if (selected.id === 'environment') {
      const current = overlay.formState.draft.credentialEnv;
      const credentialEnv = isManagedMcpCredentialReference(current) ? '' : current ?? '';
      workspace.projection.openOverlay(credentialFormOverlay({ ...overlay.formState, authMode: 'environment', draft: { ...overlay.formState.draft, credentialEnv } }));
    }
    else if (selected.id === 'keep') await saveServer({ ...overlay.formState, authMode: 'keep' }, workspace);
    else await saveServer({ ...overlay.formState, authMode: 'none', draft: { ...overlay.formState.draft, credentialEnv: '' } }, workspace);
  } else if (overlay.kind === 'mcp-delete-confirm') {
    if (selected.id === 'delete') {
      await workspace.deleteMcpServer(overlay.serverId);
      openManager(workspace, overlay.returnParent, undefined, `Removed ${overlay.serverId}. New conversations will no longer load it.`);
    } else openServer(workspace, overlay.serverId, overlay.returnParent);
  }
  return true;
}

async function handleServerAction(action, workspace, overlay) {
  const server = workspace.mcpStatus().find((entry) => entry.id === overlay.serverId);
  if (!server) {
    openManager(workspace, overlay.returnParent, undefined, 'That MCP server is no longer configured.');
    return;
  }
  if (action === 'test') {
    try {
      const result = await workspace.testMcpServer(server.id);
      const protocol = result.protocolVersion ? ` · protocol ${result.protocolVersion}` : '';
      workspace.projection.openOverlay(serverOverlay(server, overlay.returnParent, canManage(workspace), `Connection test passed${protocol}.`));
    } catch (error) {
      workspace.projection.openOverlay(serverOverlay(server, overlay.returnParent, canManage(workspace), `Connection test failed · ${error.code ?? error.message}`));
    }
    return;
  }
  if (action === 'enable' || action === 'disable') {
    await workspace.setMcpEnabled(server.id, action === 'enable');
    openServer(workspace, server.id, overlay.returnParent, `${server.id} ${action}d. Open a new conversation to apply the change.`);
    return;
  }
  if (action === 'edit') {
    const draft = server.transport === 'streamable_http'
      ? { endpoint: server.endpoint, credentialEnv: server.credentialEnv ?? '' }
      : { launch: commandLine(server), cwd: server.cwd ?? '', credentialEnv: server.credentialEnv ?? '' };
    openPrimaryForm(workspace, {
      operation: 'edit', transport: server.transport, serverId: server.id,
      draft, stepIndex: 0, returnParent: overlay.returnParent,
    });
    return;
  }
  if (action === 'delete') {
    workspace.projection.openOverlay(deleteConfirmationOverlay(server, overlay.returnParent));
  }
}

async function handleFormAction(action, workspace, overlay) {
  if (action.action === 'back') {
    if (overlay.form.stepIndex > 0) openFormStep(workspace, overlay.form, overlay.form.stepIndex - 1);
    else openFormBack(workspace, overlay.form);
    return true;
  }
  if (['cancel', 'help'].includes(action.action)) {
    workspace.projection.closeOverlay();
    return true;
  }
  if (action.action === 'home') overlay.editor.moveLine('start');
  else if (action.action === 'end') overlay.editor.moveLine('end');
  else if (action.action === 'submit') {
    try { await submitFormStep(workspace, overlay); }
    catch (error) { workspace.projection.openOverlay(formOverlay({ ...overlay.form, formError: error.message }, overlay.editor)); }
    return true;
  } else if (action.action !== 'newline' && handleEditorAction(singleLineAction(action), overlay.editor)) { /* editor mutated */ }
  else return true;
  workspace.projection.openOverlay(formOverlay(overlay.form, overlay.editor));
  return true;
}

async function submitFormStep(workspace, overlay) {
  const form = overlay.form;
  const step = form.steps[form.stepIndex];
  const value = overlay.editor.text.trim();
  validateField(step.key, value);
  const next = { ...form, draft: { ...form.draft, [step.key]: value }, formError: undefined };
  if (form.stepIndex < form.steps.length - 1) {
    openFormStep(workspace, next, form.stepIndex + 1);
    return;
  }
  if (form.mode === 'credential') await saveServer(next, workspace);
  else workspace.projection.openOverlay(authenticationOverlay(next));
}

async function saveServer(form, workspace) {
  const existing = workspace.mcpStatus().map((server) => server.id);
  const id = form.operation === 'add' ? availableMcpId(form.draft.name, existing) : form.serverId;
  const previousReference = form.operation === 'edit'
    ? workspace.mcpStatus().find((server) => server.id === id)?.credentialEnv : undefined;
  const credentialEnv = form.authMode === 'managed'
    ? await workspace.saveMcpCredential(id, form.draft.credentialToken) : form.draft.credentialEnv || undefined;
  const input = form.transport === 'streamable_http'
    ? { id, transport: form.transport, endpoint: form.draft.endpoint, credentialEnv }
    : stdioInput(id, { ...form.draft, credentialEnv });
  if (form.operation === 'add') await workspace.addMcpServer(input);
  else await workspace.editMcpServer(id, input);
  if (previousReference && previousReference !== credentialEnv) await workspace.removeMcpCredential(previousReference);
  openManager(workspace, form.returnParent, id, `${form.operation === 'add' ? 'Added' : 'Updated'} ${id}. Open a new conversation to connect with the saved configuration.`);
}

function stdioInput(id, draft) {
  const parsed = parseCommand(draft.launch);
  return {
    id, transport: 'stdio', command: parsed.command, args: [...parsed.args],
    cwd: draft.cwd || undefined, credentialEnv: draft.credentialEnv || undefined,
  };
}

function openPrimaryForm(workspace, state) {
  const steps = primarySteps(state);
  const stepIndex = Math.min(state.stepIndex ?? 0, steps.length - 1);
  workspace.projection.openOverlay(formOverlay({ ...state, stepIndex, steps }));
}

function primarySteps(state) {
  return state.transport === 'streamable_http'
    ? [
      ...(state.operation === 'add' ? [field('name', 'Server name', 'A memorable name used to identify this MCP connection.')] : []),
      field('endpoint', 'MCP endpoint', 'Complete Streamable HTTP URL exposed by the MCP server. Example: http://<hostname>:<port>/mcp'),
    ] : [
      ...(state.operation === 'add' ? [field('name', 'Server name', 'A memorable name used to identify this MCP connection.')] : []),
      field('launch', 'Launch command', 'Executable and arguments used to start the local MCP server. Quoted arguments are supported.'),
      field('cwd', 'Working directory (optional)', 'Absolute working directory for the server process, or leave blank.'),
    ];
}

function credentialFormOverlay(state) {
  return formOverlay({
    ...state, mode: 'credential', stepIndex: 0,
    steps: [field('credentialEnv', 'Environment variable', 'Name of an existing environment variable containing the token.')],
  });
}

function tokenFormOverlay(state) {
  return formOverlay({
    ...state, mode: 'credential', stepIndex: 0,
    steps: [field('credentialToken', 'Authentication token', 'Paste the token. NNA stores it in its restricted local credential file, not in the MCP configuration.', true)],
  });
}

function authenticationOverlay(formState) {
  const isHttp = formState.transport === 'streamable_http';
  const current = formState.draft.credentialEnv;
  const items = [];
  if (current) items.push({ id: 'keep', label: 'Keep current authentication', detail: isManagedMcpCredentialReference(current) ? 'Continue using the stored local token' : `Continue using environment variable ${current}` });
  items.push(
    { id: 'none', label: 'No authentication', detail: isHttp ? 'Connect without an Authorization header' : 'Launch without an additional credential variable' },
    { id: 'managed', label: isHttp ? 'Enter bearer token' : 'Enter authentication token', detail: 'Paste a token and store it in NNA\'s restricted local credential file' },
    { id: 'environment', label: 'Use environment variable', detail: 'Advanced: read the token from an existing named environment variable' },
  );
  return menu('mcp-auth', 'MCP authentication', [
    'Choose how this server receives authentication.',
    '', 'Tokens entered here are not written to the MCP server configuration.',
  ], items, { formState, returnParent: formState.returnParent, actionLabel: 'Up/Down choose · Enter continue', activeId: current ? 'keep' : 'none' });
}

function serverOverlay(server, returnParent, manageable, message) {
  const target = server.endpoint ?? commandLine(server);
  const lines = [
    `Server     ${server.id}`,
    `Transport  ${server.transport === 'streamable_http' ? 'Streamable HTTP' : 'stdio'}`,
    `Target     ${target}`,
    `Status     ${server.enabled ? 'enabled' : 'disabled'} · ${server.runtime}`,
    `Auth       ${isManagedMcpCredentialReference(server.credentialEnv) ? 'managed local token' : server.credentialEnv ? `environment · ${server.credentialEnv}` : 'none'}`,
  ];
  if (message) lines.push('', message);
  const items = [{ id: 'test', label: 'Test connection', detail: 'Validate initialization and capability discovery now' }];
  if (manageable) items.push(
    server.enabled
      ? { id: 'disable', label: 'Disable server', detail: 'Keep its settings but omit it from new conversations' }
      : { id: 'enable', label: 'Enable server', detail: 'Make it eligible for new conversations' },
    { id: 'edit', label: 'Edit server', detail: 'Update connection, launch, or authentication settings' },
    { id: 'delete', label: 'Delete server', detail: 'Remove this saved MCP connection' },
  );
  return menu('mcp-server', `MCP server · ${server.id}`, lines, items, {
    serverId: server.id, returnParent, actionLabel: 'Up/Down choose · Enter select · Esc back',
  });
}

function transportOverlay(returnParent) {
  return menu('mcp-transport', 'Add MCP server', [
    'Choose how NNA should connect to this MCP server.',
  ], [
    { id: 'streamable_http', label: 'Streamable HTTP', detail: 'Connect to a local, network, or hosted MCP endpoint' },
    { id: 'stdio', label: 'Local process (stdio)', detail: 'Launch an executable and communicate over standard input/output' },
  ], { returnParent, actionLabel: 'Up/Down choose · Enter continue · Esc back' });
}

function deleteConfirmationOverlay(server, returnParent) {
  return menu('mcp-delete-confirm', 'Delete MCP server', [
    `Server  ${server.id}`,
    `Target  ${server.endpoint ?? commandLine(server)}`,
    '', 'This removes the saved connection. It does not alter the external MCP service.',
  ], [
    { id: 'cancel', label: 'Keep server', detail: 'Return without changing configuration' },
    { id: 'delete', label: 'Delete server', detail: 'Remove this server from NNA configuration' },
  ], { serverId: server.id, returnParent, activeId: 'cancel', actionLabel: 'Up/Down choose · Enter confirm · Esc back' });
}

function formOverlay(form, existingEditor) {
  const step = form.steps[form.stepIndex];
  const editor = existingEditor ?? editorWith(form.draft[step.key] ?? '', step.key === 'credentialEnv' ? 128 : step.secret ? 16_384 : 4096);
  const selection = editor.selection();
  const rendered = step.secret ? `${'*'.repeat(Math.min(editor.text.length, 64))}${editor.text.length > 64 ? '...' : ''}|`
    : `${editor.text.slice(0, selection.start)}${selection.start !== selection.end ? `⟦${editor.text.slice(selection.start, selection.end)}⟧` : '│'}${editor.text.slice(selection.end)}`;
  return Object.freeze({
    kind: 'mcp-form', title: form.operation === 'add' ? 'Add MCP server' : `Edit MCP server · ${form.serverId}`,
    lines: Object.freeze([
      `Step ${form.stepIndex + 1} of ${form.steps.length} · ${step.label}`,
      step.description,
      ...(form.formError ? ['', `Cannot continue · ${form.formError}`] : []),
      '', `  ${rendered || '│'}`,
    ]),
    items: Object.freeze([]), selected: 0, offset: 0,
    actionLabel: 'Type value · Enter continue · Esc previous', form: Object.freeze(form), editor,
  });
}

function openFormStep(workspace, form, stepIndex) {
  workspace.projection.openOverlay(formOverlay({ ...form, stepIndex, formError: undefined }));
}

function openFormBack(workspace, form) {
  if (form.mode === 'credential') {
    workspace.projection.openOverlay(authenticationOverlay({ ...form, mode: undefined }));
  } else if (form.operation === 'add') {
    workspace.projection.openOverlay(transportOverlay(form.returnParent));
  } else openServer(workspace, form.serverId, form.returnParent);
}

function openBack(workspace, overlay) {
  if (overlay.kind === 'mcp-transport') openManager(workspace, overlay.returnParent);
  else if (overlay.kind === 'mcp-server') openManager(workspace, overlay.returnParent, overlay.serverId);
  else if (overlay.kind === 'mcp-auth') {
    const form = overlay.formState;
    openPrimaryForm(workspace, { ...form, mode: undefined, stepIndex: 9999 });
  } else if (overlay.kind === 'mcp-delete-confirm') openServer(workspace, overlay.serverId, overlay.returnParent);
}

function openServer(workspace, id, returnParent, message) {
  const server = workspace.mcpStatus().find((entry) => entry.id === id);
  if (!server) openManager(workspace, returnParent);
  else workspace.projection.openOverlay(serverOverlay(server, returnParent, canManage(workspace), message));
}

function openManager(workspace, returnParent, selectedId, message) {
  const view = mcpOverlay(workspace.mcpStatus(), { selectedId, message, canManage: canManage(workspace) });
  workspace.projection.openOverlay(returnParent ? { ...view, ...returnParent } : view);
}

function validateField(key, value) {
  if (key === 'name' && (value.length < 1 || value.length > 128)) {
    throw new ContractError('mcp_name_invalid', 'Server name must contain 1–128 characters.');
  }
  if (key === 'endpoint') {
    let endpoint;
    try { endpoint = new URL(value); } catch { throw new ContractError('invalid_mcp_endpoint', 'Enter a complete HTTP or HTTPS MCP endpoint.'); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new ContractError('invalid_mcp_endpoint', 'MCP endpoint must use HTTP(S) and cannot embed credentials.');
    }
  }
  if (key === 'launch') parseCommand(value);
  if (key === 'cwd' && value && !isAbsolute(value)) {
    throw new ContractError('invalid_mcp_cwd', 'Working directory must be an absolute path, or blank.');
  }
  if (key === 'credentialEnv' && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value)) {
    throw new ContractError('invalid_mcp_credential', 'Enter an environment-variable name containing the MCP token.');
  }
  if (key === 'credentialToken' && (value.length < 1 || value.length > 16_384 || /[\r\n\u0000]/u.test(value))) {
    throw new ContractError('invalid_mcp_token', 'Enter a token containing 1-16384 characters without line breaks.');
  }
}

export function availableMcpId(label, existingIds = []) {
  const stem = String(label).normalize('NFKD').replaceAll(/\p{Mark}/gu, '').toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-+|-+$/gu, '').slice(0, 56) || 'mcp-server';
  const existing = new Set(existingIds);
  if (!existing.has(stem)) return stem;
  for (let index = 2; index <= 9999; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${stem.slice(0, 64 - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new ContractError('mcp_id_exhausted', 'Unable to generate a unique MCP server identifier.');
}

function commandLine(server) {
  return [server.command, ...(server.args ?? [])].map((part) => quoteArgument(part)).join(' ');
}

function quoteArgument(value) {
  const text = String(value ?? '');
  return /\s|["']/u.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text;
}

function canManage(workspace) { return workspace.projection.active().role === 'primary'; }
function parentFrom(overlay) { return overlay.parent ? { parent: overlay.parent, configSection: overlay.configSection } : null; }
function field(key, label, description, secret = false) { return Object.freeze({ key, label, description, secret }); }
function editorWith(value, limit = 4096) { const editor = new EditorBuffer(limit); editor.set(String(value)); return editor; }
function singleLineAction(action) {
  if (action.action !== 'paste') return action;
  return { ...action, text: String(action.text).split(/\r?\n/u, 1)[0] };
}
function menu(kind, title, lines, items, extra = {}) {
  const selected = Math.max(0, items.findIndex((item) => item.id === extra.activeId));
  return Object.freeze({
    kind, title, lines: Object.freeze(lines), items: Object.freeze(items.map((item) => Object.freeze(item))),
    selected, offset: 0, ...extra,
  });
}
