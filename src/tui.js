// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { TerminalInputDecoder, TerminalMode, sanitizeTerminal, terminalCapabilities } from './tui/terminal-adapter.js';
import { headerTargetAt, TuiRenderer } from './tui/renderer.js';
import { validateKeyBindings } from './experience/projection.js';
import { RetainedTerminalScreen } from './tui/terminal-screen.js';
import { createRenderLoop } from './tui/render-loop.js';
export { adaptiveRenderDelay, createRenderLoop } from './tui/render-loop.js';
import { commandDefinition } from './tui/commands.js';
import { auditOverlay, configOverlay, gatewayOverlay, mcpOverlay, overlayCommandDraft, providerOverlay, valueOverlay, skillsOverlay, webFetchOverlay, webSearchOverlay, workspaceTrustOverlay } from './tui/overlays.js';
import { runContextCommand } from './tui/context.js';
import { handleCommandPickerAction, resetCommandPicker } from './tui/command-picker.js';
import { handleHealthOverlayAction, healthOverlay } from './tui/health.js';
import { handleDreamSelection, openDreamCommand, reopenDreamManager } from './tui/dream.js';
import { compactActiveConversation, confirmConversationClear, handoffActiveConversation, requestConversationClear } from './experience/context.js';
import { handleAttachmentCommand } from './tui/attachment-command.js';
import { handleMemoryCommand } from './tui/memory-command.js';
import { handleMcpCommand } from './tui/mcp-command.js';
import { handleModelCommand, handleProviderCommand } from './tui/provider-command.js';
import { handleWorkspaceTrust } from './tui/trust-command.js';
import { handleMouse, scrollPageUp } from './tui/mouse.js';
import { attachDroppedPaths, copyTerminalSelection, rightClickClipboard, clearTerminalSelection, pasteClipboard } from './tui/clipboard-actions.js';
import { recordTuiClick } from './tui/telemetry.js';
import { handlePermissionCommand, permissionChoice } from './tui/permission-command.js';
import { handleCopyCommand } from './tui/copy-command.js';
import { createTuiWorkspace } from './tui/runtime-workspace.js';
import { handleEditorAction } from './tui/editor-actions.js';
import { handleGatewayCommand, handleGatewaySelection } from './tui/gateway-command.js';
import { handleWebFetchCommand } from './tui/webfetch-command.js'; import { beginWebFetchManagementSelection, handleWebFetchSetupAction } from './tui/webfetch-setup.js'; import { beginWebSearchManagementSelection, handleWebSearchSetupAction } from './tui/websearch-setup.js';
import { beginProviderManagementSelection, handleProviderRoleNavigation, handleProviderSetupAction } from './tui/provider-setup.js'; import { beginProviderRouteSettingsSelection, handleProviderRouteSettingsAction } from './tui/provider-route-settings.js';
import { beginMcpManagementSelection, handleMcpSetupAction } from './tui/mcp-setup.js';
import { DestructiveKeyGuard, handleDestructiveCancel, handleDestructiveEscape } from './tui/destructive-key-guard.js';
import { handleResumeCommand, openRuntimeInspection } from './tui/runtime-inspection.js';
import { handleSupportCommand } from './tui/support-command.js';
import { handleWorkCommand, handleWorkSelection, openPlan } from './tui/work-command.js';
import { modelNotice, routeNotice, strictInteger } from './tui/command-support.js';
import { handleSecretsCommand } from './tui/secret-command.js';
import { beginSecretManagementSelection, handleSecretSetupAction } from './tui/secret-setup.js'; import { invokeProjectVerification } from './tui/verification-command.js'; import { registerFatalTuiCleanup } from './tui/fatal-cleanup.js';
export async function runTui(input, output, diagnostics, options) {
  const { capabilities, bindings } = prepareTui(input, output, options);
  const terminal = new TerminalMode(input, output, capabilities), renderer = options.renderer ?? new TuiRenderer(),
    screen = new RetainedTerminalScreen(output), decoder = new TerminalInputDecoder(bindings);
  let stopping = false, fatalError = null, onData = null, resize = null, escapeTimer = null, renderLoop;
  const destructiveKeys = new DestructiveKeyGuard({ windowMs: options.destructiveKeyWindowMs });
  let tail = Promise.resolve(), finish; const finished = new Promise((resolve) => { finish = resolve; });
  const render = () => renderLoop?.schedule(), workspaceFactory = options.workspaceFactory ?? createTuiWorkspace;
  const elevationControl = createElevationControl({
    input, output, terminal, state: () => ({ onData, stopping, renderLoop }),
    disarmEscape: () => { clearTimeout(escapeTimer); escapeTimer = null; },
  });
  const { logger, workspace } = await workspaceFactory({ ...options, elevationControl }, output, render); const unregisterFatalCleanup = registerFatalTuiCleanup(options.fatalBoundary, terminal, workspace, logger);
  workspace.projection.bindings = bindings;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    destructiveKeys.reset(); clearTerminalSelection(workspace); renderLoop.cancel(); clearTimeout(escapeTimer);
    await finalizeTui(terminal, workspace, logger, finish);
  };
  renderLoop = createRenderLoop(output, capabilities, screen, renderer, workspace.projection, (error) => {
    fatalError ??= error; tail = tail.then(stop);
  });
  const signal = () => { tail = tail.then(stop); };
  const suspend = () => {
    terminal.restore();
    process.removeListener('SIGTSTP', suspend);
    process.kill(process.pid, 'SIGTSTP');
  };
  const resume = () => { terminal.enter(); renderLoop.invalidate(); renderLoop.now(); process.once('SIGTSTP', suspend); };
  try {
    terminal.enter();
    await initializeWorkspace(workspace, options); await workspace.initializeSessionBroker?.();
    await workspace.initializeDream?.(); renderLoop.now();
    onData = (chunk) => {
      clearTimeout(escapeTimer); escapeTimer = null;
      tail = consumeInput(tail, chunk, decoder, workspace, stop, destructiveKeys);
      if (decoder.hasPendingEscape()) {
        escapeTimer = setTimeout(() => {
          escapeTimer = null;
          tail = consumeActions(tail, decoder.flushEscape(), workspace, stop, decoder, destructiveKeys);
        }, 25);
      }
    };
    input.on('data', onData);
    resize = () => { renderLoop.invalidate(); render(); };
    output.on('resize', resize);
    process.once('SIGINT', signal); process.once('SIGTERM', signal);
    if (process.platform !== 'win32') { process.once('SIGTSTP', suspend); process.on('SIGCONT', resume); }
    await Promise.race([new Promise((resolve) => input.once('end', resolve)), finished]);
    await tail;
    await stop();
    if (fatalError) throw fatalError;
  } catch (error) {
    terminal.restore(); safeDiagnostic(diagnostics, error);
    throw error;
  } finally {
    unregisterFatalCleanup(); removeTuiListeners(input, output, { onData, resize, signal, suspend, resume });
  }
}
export async function finalizeTui(terminal, workspace, logger, finish) {
  terminal.restore();
  let failure = null;
  try { await workspace.shutdown(); } catch (error) { failure = error; }
  try { await logger.flush?.(); } catch (error) {
    if (!failure) failure = error;
    else failure.secondaryFailures = [...(failure.secondaryFailures ?? []), error];
  }
  finally { finish(); }
  if (failure) throw failure;
}
function safeDiagnostic(diagnostics, error) {
  const code = sanitizeTerminal(error?.code ?? 'interactive_failure');
  try { diagnostics.write(`nna tui: ${code}\n`); } catch { /* preserve causal failure */ }
}
async function initializeWorkspace(workspace, options) {
  if (options.sessionId || options.sessionName) {
    await workspace.create(options.sessionName ?? 'Main', options.sessionId ?? undefined, {
      role: 'primary', nameLocked: Boolean(options.sessionName),
    });
  } else await workspace.restore();
}
function removeTuiListeners(input, output, listeners) {
  process.removeListener('SIGINT', listeners.signal); process.removeListener('SIGTERM', listeners.signal);
  if (process.platform !== 'win32') {
    process.removeListener('SIGTSTP', listeners.suspend); process.removeListener('SIGCONT', listeners.resume);
  }
  if (listeners.onData) input.removeListener('data', listeners.onData);
  if (listeners.resize) output.removeListener('resize', listeners.resize);
}
function consumeInput(tail, chunk, decoder, workspace, stop, destructiveKeys) {
  return consumeActions(tail, decoder.push(chunk), workspace, stop, decoder, destructiveKeys);
}
function consumeActions(tail, actions, workspace, stop, decoder, destructiveKeys) {
  return tail.then(() => handleActions(actions, workspace, stop, decoder, destructiveKeys))
    .catch((error) => workspace.reportError(error));
}
function prepareTui(input, output, options) {
  const effectiveOptions = {
    ...options.config.tui, ...options,
    reducedMotion: options.reducedMotion ?? options.config.tui.reducedMotion,
    color: options.color ?? options.config.tui.color,
    // The Console owns its viewport. This prevents terminal-native wheel
    // scrolling from escaping into shell history while NNA is active; mouse
    // wheel input remains routed through the retained transcript projection.
    alternateScreen: options.alternateScreen ?? true,
  };
  return {
    capabilities: terminalCapabilities(input, output, effectiveOptions),
    bindings: validateKeyBindings(options.keyBindings ?? options.config.tui.keyBindings),
  };
}
export async function handleActions(actions, workspace, stop, decoder, destructiveKeys = new DestructiveKeyGuard()) {
  workspace.dream?.activity(actions[0]?.action ?? 'input'); const actionCount = Math.min(actions.length, 4096);
  for (let index = 0; index < actionCount; index += 1) {
    const action = actions[index]; const session = workspace.projection.active();
    if (!session) return;
    if (!['back', 'cancel'].includes(action.action)) destructiveKeys.reset();
    if (!['mouse', 'cancel'].includes(action.action)) clearTerminalSelection(workspace); workspace.projection.clearNotice();
    if (action.action === 'reset_keys') await resetKeys(workspace, decoder);
    else if (session.pendingPermission && action.action === 'insert' && selectedPermission(action, session)) await workspace.decideActive(selectedPermission(action, session));
    else if (session.pendingPermission && ['history_up', 'history_down'].includes(action.action)) {
      session.permissionOffset = Math.max(0, session.permissionOffset + (action.action === 'history_up' ? -1 : 1));
    }
    else if (session.pendingPermission && !['allow_once', 'deny', 'cancel', 'back', 'help', 'mouse'].includes(action.action)) {
      workspace.projection.showNotice('approval', 'Resolve the pending decision before editing.');
    }
    else if (action.action === 'mouse') {
      recordTuiClick(workspace, action);
      await handleMouse(action, workspace, headerTargetAt,
        () => handleOverlayAction({ action: 'submit' }, workspace), {
          rightClick: () => rightClickClipboard(workspace,
            () => pasteClipboard(workspace, handleOverlayAction, handleEditorAction, 'right_click')),
        });
    }
    else if (action.action === 'paste_clipboard') await pasteClipboard(workspace, handleOverlayAction, handleEditorAction);
    else if (workspace.projection.overlay) await handleOverlayAction(action, workspace);
    else if (workspace.projection.help && action.action === 'back') workspace.projection.help = false;
    else if (action.action === 'back') await handleDestructiveEscape(workspace, destructiveKeys);
    else if (action.action === 'paste' && await attachDroppedPaths(workspace, action.text)) { /* queued as attachments */ }
    else if (handleCommandPickerAction(action, session)) { /* command picker consumed the action */ }
    else if (handleEditorAction(action, session.editor)) { resetCommandPicker(session); }
    else if (action.action === 'home') session.editor.moveLine('start');
    else if (action.action === 'end') {
      if (session.viewportEnd === null) session.editor.moveLine('end');
      else workspace.projection.followActive();
    }
    else if (action.action === 'history_up') moveOrNavigate(session.editor, -1);
    else if (action.action === 'history_down') moveOrNavigate(session.editor, 1);
    else if (action.action === 'scroll_page_up') await scrollPageUp(workspace);
    else if (action.action === 'scroll_page_down') workspace.projection.scrollActive(10);
    else if (action.action === 'scroll_bottom') workspace.projection.followActive();
    else if (action.action === 'toggle_activity') workspace.projection.toggleLatestActivity();
    else if (action.action === 'new_tab') await workspace.createNext();
    else if (action.action === 'close_tab') await workspace.closeActive(false);
    else if (action.action === 'next_tab') workspace.projection.cycleActive(1);
    else if (action.action === 'previous_tab') workspace.projection.cycleActive(-1);
    else if (action.action === 'cycle_review') workspace.cycleReviewPosture();
    else if (/^tab_[1-8]$/u.test(action.action)) {
      workspace.projection.activateIndex(Number(action.action.slice(-1)) - 1);
    }
    else if (action.action === 'help') workspace.projection.help = !workspace.projection.help;
    else if (action.action === 'cancel') {
      if (!await copyTerminalSelection(workspace)) await handleDestructiveCancel(workspace, stop, destructiveKeys);
    }
    else if (action.action === 'allow_once') await workspace.decideActive('allow_once');
    else if (action.action === 'deny') await workspace.decideActive('deny');
    else if (action.action === 'submit') await submitEditor(workspace, stop);
    else if (action.action === 'input_rejected') throw new ContractError(action.reason, 'terminal input was rejected');
  }
  decoder.setBindings(workspace.projection.bindings); workspace.onChange();
}
function createElevationControl(options) {
  return { run: async (operation, notice) => {
    const { onData, stopping, renderLoop } = options.state();
    if (!onData || stopping) throw new Error('elevation_terminal_unavailable');
    options.disarmEscape(); renderLoop?.cancel();
    options.input.removeListener('data', onData); options.terminal.restore();
    options.output.write(`\nNNA elevation requested\n${notice}\n\n`);
    try { return await operation(); } finally {
      if (!options.state().stopping) {
        options.input.on('data', onData); options.terminal.enter(); renderLoop.invalidate(); renderLoop.now();
      }
    }
  } };
}
function selectedPermission(action, session) {
  return permissionChoice(action.text, session.pendingPermission.choices);
}
async function resetKeys(workspace, decoder) {
  workspace.projection.bindings = validateKeyBindings();
  decoder.setBindings(workspace.projection.bindings);
  try {
    workspace.projection.bindings = await workspace.configureKeyBindings({});
    workspace.projection.showNotice('configuration', 'Key bindings restored to defaults and saved.');
  } catch (error) {
    workspace.projection.showNotice('configuration', `Defaults active for this run; save failed (${error.code ?? 'configuration_write_failed'}).`);
  }
}
async function handleOverlayAction(action, workspace) {
  const projection = workspace.projection;
  if (await handleSpecialOverlayAction(action, workspace)) return;
  if (['history_up', 'history_down'].includes(action.action)) {
    const direction = action.action === 'history_up' ? -1 : 1;
    if (projection.overlay.items?.length) projection.moveOverlaySelection(direction);
    else projection.scrollOverlay(direction);
  } else if (action.action === 'submit' && projection.overlay.items?.length) {
    const overlay = projection.overlay;
    const selected = overlay.items[overlay.selected];
    if (await handleWorkSelection(selected, workspace, overlay)) return;
    if (beginProviderRouteSettingsSelection(selected, workspace, overlay)) return;
    if (beginProviderManagementSelection(selected, workspace, overlay)) return;
    if (beginMcpManagementSelection(selected, workspace, overlay)) return;
    if (await beginSecretManagementSelection(selected, workspace, overlay)) return;
    if (beginWebFetchManagementSelection(selected, workspace, overlay)) return; if (await beginWebSearchManagementSelection(selected, workspace, overlay)) return;
    const draft = overlayCommandDraft(overlay.kind, selected.id);
    if (draft) {
      projection.closeOverlay(); projection.active().editor.set(draft);
      projection.showNotice('command', 'Complete the command fields, then press Enter.');
      return;
    }
    if (overlay.kind === 'config') {
      await openConfigurationSection(selected.id, workspace);
      return;
    }
    if (selected.id === 'inherit') await workspace.usePrimaryRoute();
    else if (overlay.kind === 'provider' && selected.id === 'clear-role') await workspace.clearProviderForRole(overlay.role);
    else if (overlay.kind === 'tab' && selected.id === 'action:close') { projection.closeOverlay(); await workspace.closeActive(false); return; }
    else if (overlay.kind === 'provider') await workspace.selectProviderForRole(overlay.role ?? 'primary', selected.id);
    else if (overlay.kind === 'model') await workspace.selectModel(selected.id);
    else if (overlay.kind === 'skills') { prepareSkillInvocation(projection, selected.id); return; }
    else if (overlay.kind === 'dream') { await handleDreamSelection(selected.id, workspace); return; }
    else if (overlay.kind === 'websearch') {
      const result = await webSearchAction(selected.id, workspace);
      projection.openOverlay(webSearchOverlay(result, { selectedId: selected.id, message: webSearchMessage(selected.id) }));
      return;
    }
    else if (overlay.kind === 'gateway') { await handleGatewaySelection(selected.id, workspace); return; }
    else if (overlay.kind === 'workspace-trust') { await updateWorkspaceTrust(selected.id, workspace); return; }
    else if (overlay.kind === 'resume') { projection.closeOverlay(); await workspace.resume(selected.id); return; }
    projection.closeOverlay();
    const notice = overlay.kind === 'model' ? modelNotice(workspace)
      : overlay.kind === 'provider' && overlay.role !== 'primary'
        ? `${overlay.role} profile ${selected.id === 'clear-role' ? 'cleared' : 'updated'} globally for all conversations.`
        : routeNotice(workspace);
    projection.showNotice('route', notice);
  } else if (action.action === 'back' && projection.overlay.parent === 'dream') {
    await reopenDreamManager(workspace);
  } else if (action.action === 'back' && projection.overlay.parent === 'config') {
    projection.openOverlay(configOverlay(workspace.activeConfig(), { selectedId: projection.overlay.configSection }));
  } else if (action.action === 'back' && projection.overlay.parent === 'plan') {
    openPlan(workspace, `task:${projection.overlay.taskId}`);
  } else if (['help', 'cancel', 'back'].includes(action.action)) {
    projection.closeOverlay();
  } else {
    projection.showNotice('overlay', 'Close the current view with Ctrl+G or Ctrl+C.');
  }
}
async function handleSpecialOverlayAction(action, workspace) {
  if (await handleProviderRouteSettingsAction(action, workspace)) return true;
  if (await handleProviderSetupAction(action, workspace)) return true;
  if (await handleMcpSetupAction(action, workspace)) return true;
  if (await handleSecretSetupAction(action, workspace)) return true;
  if (await handleWebFetchSetupAction(action, workspace)) return true; if (await handleWebSearchSetupAction(action, workspace)) return true;
  return handleProviderRoleNavigation(action, workspace) || handleHealthOverlayAction(action, workspace);
}
function prepareSkillInvocation(projection, id) {
  projection.closeOverlay();
  projection.active().editor.set(`/skill ${id} `);
  projection.showNotice('skill', 'Add an optional request, then press Enter to invoke this skill.');
}
async function openConfigurationSection(section, workspace) {
  if (section === 'provider') await handleProviderCommand('', workspace, { routeNotice, strictInteger });
  else if (section === 'model') await handleModelCommand('', workspace, { modelNotice });
  else if (section === 'mcp') await handleMcpCommand('', workspace);
  else if (section === 'secrets') await handleSecretsCommand('', workspace);
  else if (section === 'websearch') workspace.projection.openOverlay(webSearchOverlay(await workspace.webSearchStatus(false)));
  else if (section === 'webfetch') workspace.projection.openOverlay(webFetchOverlay((await workspace.webFetchCommand(['status'])).config));
  else if (section === 'gateway') workspace.projection.openOverlay(gatewayOverlay(await workspace.gatewayCommand(['status'])));
  else if (section === 'context') await runContextCommand('', workspace);
  else if (['hooks', 'extensions'].includes(section)) await openRuntimeInspection(section, workspace);
  else if (section === 'workspace-trust') workspace.projection.openOverlay(workspaceTrustOverlay(workspace.activeConfig().workspaceRoot));
  else throw new ContractError('config_section_invalid', 'unknown configuration section');
  workspace.projection.openOverlay(Object.freeze({
    ...workspace.projection.overlay, parent: 'config', configSection: section,
  }));
}
async function updateWorkspaceTrust(selection, workspace) {
  await handleWorkspaceTrust(selection === 'trust', workspace);
  workspace.projection.closeOverlay();
}
export function shouldExitOnCancel(session) {
  return !session.pendingPermission && !session.activeTurnId;
}
export async function submitEditor(workspace, stop) {
  const session = workspace.projection.active();
  if (!session) throw new ContractError('tui_session_missing', 'no active conversation is available');
  const content = session.editor.text;
  if (!content.trim()) return;
  if (session.pendingPermission) {
    workspace.projection.showNotice('approval', 'Use the displayed approval keys before submitting input.');
    return;
  }
  if (content.endsWith('\\') && session.editor.cursor === content.length) {
    session.editor.backspace();
    session.editor.insert('\n');
    return;
  }
  if (!content.trimStart().startsWith('/')) {
    if (session.activeTurnId) {
      const result = await workspace.steerActive(content);
      if (result.accepted) session.editor.take();
      return;
    }
    session.editor.take();
    workspace.submitActive(content);
    return;
  }
  await command(content.trim(), workspace, stop);
  session.editor.take();
}
async function command(value, workspace, stop) {
  const [name, ...rest] = value.split(/\s+/u);
  const argument = rest.join(' ');
  if (!commandDefinition(name)) throw new ContractError('unknown_tui_command', `unknown command ${name}`);
  if (name === '/new') await workspace.create(argument || 'Conversation', undefined, { nameLocked: Boolean(argument) });
  else if (name === '/resume') await handleResumeCommand(argument, workspace);
  else if (name === '/workspace') await workspace.createAtWorkspace(argument);
  else if (['/attach', '/attachments', '/detach', '/attachment'].includes(name)) {
    await handleAttachmentCommand(name, argument, workspace);
  }
  else if (name === '/switch') workspace.switch(argument);
  else if (name === '/rename') workspace.renameActive(argument);
  else if (name === '/close') await workspace.closeActive(false);
  else if (name === '/confirm' && argument === 'close') await workspace.closeActive(true);
  else if (name === '/confirm' && argument === 'clear conversation') await confirmConversationClear(workspace);
  else if (name === '/audit') workspace.projection.openOverlay(auditOverlay(
    workspace.activeEngine().reviewerAudit(), workspace.activeEngine().governanceAudit(),
    workspace.activeEngine().governance.health(),
  ));
  else if (name === '/permissions') handlePermissionCommand(argument, workspace);
  else if (name === '/health') workspace.projection.openOverlay(healthOverlay(await workspace.activeEngine().health(), workspace.projection.active()));
  else if (name === '/trace') await traceCommand(argument, workspace);
  else if (name === '/dream') await openDreamCommand(argument, workspace);
  else if (['/hooks', '/extensions', '/stats', '/status', '/files', '/project', '/sessions', '/agents'].includes(name)) {
    await openRuntimeInspection(name === '/status' ? 'stats' : name.slice(1), workspace);
  }
  else if (name === '/provider') await handleProviderCommand(argument, workspace, { routeNotice, strictInteger });
  else if (name === '/model') await handleModelCommand(argument, workspace, { modelNotice });
  else if (name === '/mcp') await handleMcpCommand(argument, workspace);
  else if (name === '/secrets') await handleSecretsCommand(argument, workspace);
  else if (name === '/memory') await handleMemoryCommand(argument, workspace);
  else if (name === '/skills') workspace.projection.openOverlay(skillsOverlay(workspace.activeEngine().skills.catalog()));
  else if (name === '/skill') await invokeSkill(argument, workspace);
  else if (name === '/devteam') await invokeNamedSkill('devteam', argument, workspace);
  else if (name === '/research') await invokeNamedSkill('research', argument, workspace);
  else if (name === '/troubleshoot') await invokeNamedSkill('troubleshoot', argument, workspace);
  else if (name === '/trust' && argument === 'workspace') await handleWorkspaceTrust(true, workspace);
  else if (name === '/untrust' && argument === 'workspace') await handleWorkspaceTrust(false, workspace);
  else if (name === '/config') await configCommand(argument, workspace);
  else if (['/websearch', '/search-config', '/search_config'].includes(name)) await webSearchCommand(argument, workspace);
  else if (name === '/webfetch') await handleWebFetchCommand(argument, workspace);
  else if (name === '/gateway') await handleGatewayCommand(argument, workspace);
  else if (name === '/context') await runContextCommand(argument, workspace);
  else if (['/plan', '/tasks', '/goal', '/task'].includes(name)) await handleWorkCommand(name, argument, workspace);
  else if (name === '/diff') workspace.projection.openOverlay(valueOverlay('diff', argument ? `Changes · ${argument}` : 'Conversation changes', workspace.activeEngine().tools.diff(argument || null)));
  else if (name === '/verify') invokeProjectVerification(argument, workspace);
  else if (name === '/copy') await handleCopyCommand(argument, workspace);
  else if (name === '/compact' && !argument) await compactActiveConversation(workspace);
  else if (name === '/handoff' && !argument) await handoffActiveConversation(workspace);
  else if (name === '/clear' && argument === 'conversation') requestConversationClear(workspace);
  else if (name === '/help') workspace.projection.help = !workspace.projection.help;
  else if (name === '/steer' && argument) await workspace.steerActive(argument);
  else if (name === '/support' || name === '/bundle') await handleSupportCommand(name, argument, workspace);
  else if (name === '/quit') await stop();
  else throw new ContractError('tui_command_invalid', `invalid usage for ${name}`);
}
async function invokeSkill(argument, workspace) {
  const [id, ...request] = argument.trim().split(/\s+/u);
  if (!id) throw new ContractError('skill_id_required', '/skill requires a registered skill id');
  return invokeNamedSkill(id, request.join(' '), workspace);
}
async function invokeNamedSkill(id, request, workspace) {
  const session = workspace.projection.active();
  if (!session) throw new ContractError('tui_session_missing', 'no active conversation is available');
  if (session.activeTurnId) throw new ContractError('turn_active', 'wait for or cancel the active turn before invoking a skill');
  const skill = workspace.activeEngine().skills.queueUser(id);
  const content = request.trim() || `Run the ${skill.id} workflow using the current conversation as the request and report the result.`;
  workspace.submitActive(content);
}
async function traceCommand(argument, workspace) {
  const engine = workspace.activeEngine();
  let rows;
  let title = 'Recent forensic trace';
  if (!argument) rows = await engine.telemetry.query({ sessionId: engine.sessionId, limit: 250 });
  else if (argument === 'failures') {
    rows = await engine.telemetry.query({ sessionId: engine.sessionId, status: 'failed', limit: 500 });
    title = 'Forensic trace failures';
  } else if (argument === 'open') {
    rows = await engine.telemetry.openSpans(500);
    title = 'Open forensic spans';
  } else if (argument.startsWith('turn ')) {
    const turnId = argument.slice(5).trim();
    if (!turnId) throw new ContractError('trace_command_invalid', 'use /trace turn ID');
    rows = await engine.telemetry.query({ turnId, limit: 2000 });
    title = `Forensic trace | ${turnId}`;
  } else throw new ContractError('trace_command_invalid', 'use /trace, /trace failures, /trace open, or /trace turn ID');
  workspace.projection.openOverlay(valueOverlay('trace', title, traceView(rows)));
}
function traceView(rows) {
  return rows.map((row) => ({
    at: row.timestamp, sequence: row.sequence, event: row.event_name, status: row.status,
    duration_ms: row.duration_ms, turn: row.turn_id, step: row.step_id, attempt: row.attempt_id,
    tool: row.tool_request_id, reason: row.reason_code, span: row.span_id,
  }));
}
async function webSearchCommand(argument, workspace) {
  if (!argument || argument === 'status') {
    workspace.projection.openOverlay(webSearchOverlay(await workspace.webSearchStatus(false)));
    return;
  }
  const [action, ...rest] = argument.trim().split(/\s+/u);
  let result;
  if (action === 'test') result = await workspace.webSearchStatus(true);
  else if (action === 'deploy') result = await workspace.deployWebSearch();
  else if (['disable', 'reset'].includes(action)) result = await workspace.disableWebSearch();
  else if (['remove', 'remove-deployment'].includes(action)) result = await workspace.removeWebSearchDeployment();
  else if (['start', 'stop'].includes(action)) result = await workspace.manageWebSearch(action);
  else if (action === 'configure') {
    if (rest.length === 0) throw new ContractError('web_search_endpoint_required', 'use /websearch configure URL');
    result = await workspace.configureWebSearch(rest.join(' '), false);
  } else result = await workspace.configureWebSearch(argument, false);
  workspace.projection.openOverlay(webSearchOverlay(result, { message: webSearchMessage(action) }));
}
async function webSearchAction(action, workspace) {
  if (action === 'test') return workspace.webSearchStatus(true);
  if (action === 'deploy') return workspace.deployWebSearch();
  if (action === 'disable') return workspace.disableWebSearch();
  if (action === 'remove') return workspace.removeWebSearchDeployment();
  if (['start', 'stop'].includes(action)) return workspace.manageWebSearch(action);
  throw new ContractError('web_search_action_invalid', 'unknown WebSearch menu action');
}
function webSearchMessage(action) {
  if (action === 'deploy') return 'Local SearXNG was deployed or redeployed, validated, and activated.';
  if (action === 'disable' || action === 'reset') return 'WebSearch was disabled and its saved configuration was removed.';
  if (action === 'remove' || action === 'remove-deployment') return 'The NNA-managed local SearXNG deployment was removed.';
  if (action === 'stop') return 'Managed SearXNG stopped; no data was removed.';
  if (action === 'start') return 'Managed SearXNG started and validated.';
  return 'Endpoint validation completed.';
}
async function configCommand(argument, workspace) {
  if (!argument) {
    workspace.projection.openOverlay(configOverlay(workspace.activeConfig()));
    return;
  }
  throw new ContractError('config_read_only', 'Use /config without arguments; provider, model, MCP, and WebSearch have dedicated managers.');
}
function moveOrNavigate(editor, direction) {
  if (editor.text.length === 0) editor.navigateHistory(direction);
  else editor.moveVertical(direction);
}
