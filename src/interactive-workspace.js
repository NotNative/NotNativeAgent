// SPDX-License-Identifier: Apache-2.0
import { CanonicalIngress } from './ingress.js';
import { SessionEngine } from './engine.js';
import { ContractError, newId } from './ids.js';
import { TuiProjection } from './tui-model.js';
import { FairScheduler } from './fair-scheduler.js';
import { userDataPaths } from './product.js';
import {
  booleanSettingValue, manifestFromConfig, withBooleanSetting, withContextSettings, withRecoverySettings,
  withPrimaryRoute, withUpdatedProvider,
  withGlobalSpecialistRoutes,
  withKeyBindings, withMcpEnabled, withMcpServer, withMcpServerUpdate, withoutMcpServer, withRuntimeLimits,
} from './route-configuration.js';
import { SearxngClient } from './searxng-client.js';
import { SearxngDeployment } from './searxng-deployment.js';
import { configuredMcpStatus, testConfiguredMcpServer } from './workspace-mcp.js';
import {
  configureWebSearch, deployWebSearch, disableWebSearch, manageWebSearch, resetWebSearch, webSearchStatus,
} from './workspace-websearch.js';
import { nextReviewPosture, reviewPostureNotice } from './review-posture.js';
import { restoreTranscript } from './workspace-transcript.js';
import { restorePresentation, tabPoolRecords } from './workspace-presentation.js';
import { createNextConversation, createWorkspaceConversation } from './workspace-directory.js';
import { restoreWorkspace } from './workspace-restore.js';
import { validateKeyBindings } from './key-bindings.js';
import { WorkspaceTabPersistence } from './workspace-tab-persistence.js';
import { boundedProviderCapabilities } from './provider-capabilities.js';
import { availableWorkspaceModels, qualifyWorkspaceModel } from './workspace-models.js';
import { advanceWorkspaceConfig, publishWorkspaceConfiguration, writeWorkspaceManifest } from './workspace-configuration-publication.js';
import { providerAdditionPlan, providerCatalogEntries, routePresentation, specialistRouteEntries } from './workspace-provider-catalog.js';
import { clearWorkspaceProviderRole, deleteWorkspaceProvider, selectWorkspaceProviderRole } from './workspace-provider-routing.js';
import { runGatewayCommand } from './gateway-cli.js';
import { runWebFetchCommand } from './web-fetch-cli.js';
import { discoverWorkspaceProviderModels } from './workspace-provider-discovery.js';
import { deleteManagedMcpCredential, saveManagedMcpCredential } from './mcp-credentials.js';
import { initializeWorkspaceDream, runWorkspaceDreamCommand } from './workspace-dream.js';
import { resumeWorkspaceConversation } from './workspace-resume.js';
import { SecretBroker } from './secret-broker.js';
import { ConsoleAuthority } from './console-authority.js';
import { cancelWorkspaceSession, clearWorkspaceSession, compactWorkspaceSession, handoffWorkspaceSession, initializeWorkspaceSessionBroker, submitWorkspaceSession, workspaceBrokerSessions } from './workspace-session-broker.js';
export class InteractiveWorkspace {
  #tasks = new Set();
  constructor(options) {
    this.config = options.config;
    this.options = options;
    this.projection = options.projection ?? new TuiProjection();
    this.sessions = new Map();
    this.consoleId = options.consoleId ?? newId('console');
    this.consoleAuthority = new ConsoleAuthority(options.tabPoolPath, options.authorityLock);
    this.restoreFailures = [];
    this.onChange = options.onChange ?? (() => undefined);
    this.scheduler = options.scheduler ?? new FairScheduler({
      limit: this.config.limits.providerConcurrency, maxQueued: this.config.limits.providerQueueLimit,
    });
    this.webSearchConfigPath = options.webSearchConfigPath ?? userDataPaths().webSearchConfig;
    this.gatewayConfigPath = options.gatewayConfigPath ?? userDataPaths().gatewayConfig;
    const dataPaths = options.dataPaths ?? userDataPaths();
    this.secretBroker = options.secretBroker ?? new SecretBroker({
      vaultPath: dataPaths.secretVault, keyPath: dataPaths.secretKey, auditPath: dataPaths.secretAudit,
      audit: async (event) => this.options.logger?.record({ type: 'secret_broker_event', ...event }),
    });
    this.webSearchClient = options.webSearchClient ?? new SearxngClient();
    this.searxngDeployment = options.searxngDeployment ?? new SearxngDeployment({
      root: options.managedSearxngRoot ?? userDataPaths().managedSearxng,
      client: this.webSearchClient,
    });
    this.tabPersistence = new WorkspaceTabPersistence({
      path: options.tabPoolPath, writer: options.tabPoolWriter,
      consoleId: this.consoleId,
      enabled: () => this.config.persistence === 'durable' && options.tabPoolPath && this.restoreFailures.length === 0,
      snapshot: () => ({ tabs: tabPoolRecords(this.sessions, this.projection), activeId: this.projection.activeId }),
      onFailure: (error) => {
        this.projection.showNotice('persistence',
          `Console tab state was not saved (${error.code ?? 'tab_pool_write_failed'}); it will retry on the next change.`);
        this.onChange();
      },
    });
  }
  initializeDream() { return initializeWorkspaceDream(this); }
  initializeSessionBroker() { return initializeWorkspaceSessionBroker(this); }
  dreamCommand(action) { return runWorkspaceDreamCommand(this, action); }
  async restore() {
    const result = await restoreWorkspace(this);
    if (result.complete) await this._savePoolRecoverable();
    return result.mainId;
  }
  acquireConsoleAuthority() { return this.consoleAuthority.acquire(); }
  async create(name = 'Main', sessionId = newId('session'), options = {}) {
    if (this.sessions.has(sessionId)) throw new ContractError('session_duplicate', 'conversation is already attached');
    const output = async (event) => {
      this.projection.apply(sessionId, event);
      this.options.logger?.record(event, { sessionId });
      this.onChange();
    };
    const paths = userDataPaths();
    const sourceConfig = options.config ?? this.config;
    const synchronizedConfig = withGlobalSpecialistRoutes(sourceConfig, this.config).config;
    const sessionConfig = Object.freeze({ ...synchronizedConfig, version: sourceConfig.version });
    const engine = new SessionEngine({
      config: sessionConfig, sessionId, surface: 'interactive_tui', output,
      dataPaths: this.options.dataPaths,
      storeRoot: this.options.storeRoot ?? paths.sessions,
      reviewerRoot: this.options.reviewerRoot ?? paths.reviewerLedger,
      attachmentRoot: this.options.attachmentRoot,
      providerFactory: this.options.providerFactory,
      semanticReviewer: this.options.semanticReviewer, memoryAdapter: this.options.memoryAdapter,
      mcpTransportFactory: this.options.mcpTransportFactory, hookRoot: this.options.hookRoot,
      elevationControl: this.options.elevationControl,
      hookRoots: options.hookRoots ?? this.options.hookRoots,
      skillRoots: options.skillRoots ?? this.options.skillRoots,
      scheduler: this.scheduler, secretBroker: this.secretBroker,
      webSearchConfigPath: this.webSearchConfigPath, webSearchClient: this.webSearchClient,
      mcpControl: {
        status: () => ({ configured: this.config.mcpServers, active: sessionConfig.mcpServers }),
        test: (id) => this.testMcpServer(id),
      },
    });
    await engine.initialize({ deferMcp: true });
    const ingress = new CanonicalIngress(engine, { interactive: true });
    const role = options.role ?? (this.sessions.size === 0 ? 'primary' : 'standard');
    const meaningful = options.meaningful ?? engine.transcript.some((item) => item.type === 'message' && item.role === 'user');
    this.sessions.set(sessionId, { id: sessionId, sessionId, name, engine, ingress, meaningful, main: options.main === true });
    const primary = sessionConfig.routes.primary;
    this.projection.addSession(sessionId, name, routePresentation(sessionConfig, primary, {
      workspace: sessionConfig.workspaceRoot,
    }), role);
    this.projection.sessions.get(sessionId).commandCapabilities = { memoryAvailable: engine.memory.enabled, mcpReady: engine.mcp.status().some((item) => item.state === 'ready') };
    restoreTranscript(this.projection, sessionId, engine.transcript);
    this.projection.sessions.get(sessionId).work = engine.workStatus();
    Object.assign(this.projection.sessions.get(sessionId), engine.resumeBoundary ?? { beforeSequence: null, hasMore: false });
    restorePresentation(this.projection.sessions.get(sessionId), engine, options.presentation);
    this.projection.activate(sessionId);
    if (options.persist !== false) await this._savePoolRecoverable();
    this.onChange();
    return sessionId;
  }
  resume(sessionId) { return resumeWorkspaceConversation(this, sessionId); }
  createNext() { return createNextConversation(this); }
  createAtWorkspace(value) { return createWorkspaceConversation(this, value); }
  submitActive(content) {
    const session = this._active();
    const projected = this.projection.active();
    const attachments = projected.pendingAttachments.splice(0).map(({ path, mime_type }) => ({ path, mime_type }));
    session.meaningful = true;
    this.projection.apply(session.id, { type: 'user_input', text: content });
    this.tabPersistence.observe(this.#savePool(), this.#tasks);
    return this.#own(session.ingress.submit({
      version: '1.0', type: 'submit', request_id: newId('tui'), content, attachments,
    }, 'authenticated-interactive-operator'));
  }
  brokerSessions() { return workspaceBrokerSessions(this); }
  submitSession(sessionId, content) { return submitWorkspaceSession(this, sessionId, content); }
  cancelSession(sessionId) { return cancelWorkspaceSession(this, sessionId); }
  compactSession(sessionId) { return compactWorkspaceSession(this, sessionId); } handoffSession(sessionId) { return handoffWorkspaceSession(this, sessionId); } clearSession(sessionId) { return clearWorkspaceSession(this, sessionId); }
  _savePoolForBroker() { return this.#savePool(); }
  _tasksForBroker() { return this.#tasks; }
  steerActive(content) {
    const session = this._active();
    return session.ingress.submit({
      version: '1.0', type: 'steer', request_id: newId('tui'), content,
    }, 'authenticated-interactive-operator').then((result) => {
      if (result.accepted) this.projection.apply(session.id, {
        type: 'local_status', kind: 'steering', text: 'Guidance queued for the active turn.',
      });
      this.onChange();
      return result;
    });
  }
  decideActive(choice) {
    const session = this._active();
    const pending = this.projection.active().pendingPermission;
    if (!pending) throw new ContractError('permission_missing', 'no interactive permission is pending');
    return session.ingress.submit({
      version: '1.0', type: 'permission_decision', request_id: newId('tui'),
      permission_token: pending.permission_token, tool_request_id: pending.tool_request_id, choice,
    }, 'authenticated-interactive-operator');
  }
  cancelActive() {
    const session = this._active();
    if (this.projection.active().pendingPermission) return this.decideActive('cancel');
    return session.ingress.submit({
      version: '1.0', type: 'cancel', request_id: newId('tui'),
    }, 'authenticated-interactive-operator');
  }
  retryActiveAttachment(id, content) {
    const session = this._active();
    this.projection.apply(session.id, { type: 'user_input', text: content });
    return this.#own(session.ingress.submit({
      version: '1.0', type: 'attachment_retry', request_id: newId('tui'), attachment_id: id, content,
    }, 'authenticated-interactive-operator'));
  }
  removeActiveAttachment(id) {
    const session = this._active();
    return session.ingress.submit({
      version: '1.0', type: 'attachment_remove', request_id: newId('tui'), attachment_id: id,
    }, 'authenticated-interactive-operator');
  }
  cycleReviewPosture() {
    const session = this._active();
    const projected = this.projection.active();
    projected.reviewPosture = nextReviewPosture(projected.reviewPosture);
    session.engine.reviewPosture = projected.reviewPosture;
    this.projection.showNotice('review', reviewPostureNotice(projected.reviewPosture));
    this.onChange();
    return projected.reviewPosture;
  }
  switch(idOrName) {
    const session = [...this.sessions.values()].find((item) => item.id === idOrName || item.name === idOrName);
    if (!session) throw new ContractError('session_missing', 'conversation was not found');
    this.projection.activate(session.id);
    this.onChange();
  }
  renameActive(name) {
    if (!name || name.length > 128) throw new ContractError('session_name_invalid', 'conversation name is invalid');
    const session = this._active();
    session.name = name;
    this.projection.active().name = name;
    this.tabPersistence.observe(this.#savePool(), this.#tasks);
    this.onChange();
  }
  async closeActive(confirm = false) {
    const session = this._active();
    const projected = this.projection.active();
    if (session.main) {
      this.projection.showNotice('session', 'This Console\'s Main conversation remains attached until NNA exits.');
      this.onChange();
      return { protected: true };
    }
    if (projected.activeTurnId && !confirm) {
      projected.confirmClose = true;
      this.projection.showNotice('session', 'Active work is still running; use /confirm close to cancel and close it.');
      this.onChange();
      return { confirmation_required: true };
    }
    await session.engine.shutdown({ request_id: newId('tui_close'), type: 'shutdown' });
    this.sessions.delete(session.id);
    this.projection.remove(session.id);
    await this._savePoolRecoverable();
    this.onChange();
    return { closed: true };
  }
  async shutdown() {
    this.dream?.close();
    await this.sessionBroker?.close?.();
    let poolFailure = null;
    try {
      await this.#savePool();
    } catch (error) {
      poolFailure = error;
    }
    const shutdowns = await Promise.allSettled([...this.sessions.values()].map((session) => session.engine.shutdown({
      request_id: newId('tui_shutdown'), type: 'shutdown',
    })));
    await Promise.allSettled([...this.#tasks]);
    await this.tabPersistence.wait();
    await this.consoleAuthority.release();
    if (poolFailure) throw poolFailure;
    const engineFailure = shutdowns.find((item) => item.status === 'rejected');
    if (engineFailure) throw engineFailure.reason;
  }
  activeEngine() { return this._active().engine; }
  activeConfig() {
    const engine = this.activeEngine();
    return engine.pendingConfig ?? engine.config;
  }
  async selectProvider(providerId) {
    const profile = this.activeConfig().providerProfiles[providerId];
    if (!profile) throw new ContractError('provider_missing', `provider ${providerId} is not configured`);
    return this.selectProviderForRole('primary', providerId);
  }
  async selectModel(model) {
    if (!model || model.length > 256) throw new ContractError('invalid_model', 'model name is required and bounded');
    const route = this.activeConfig().routes.primary;
    return this.selectRoute(route.providerId, model);
  }
  async selectRoute(providerId, model) {
    const active = this._active();
    const projected = this.projection.active();
    const next = withPrimaryRoute(active.engine.pendingConfig ?? active.engine.config, providerId, model);
    await this._updateSession(active, next.manifest);
    this._projectRoute(active.id, next.config.routes.primary);
    this.onChange();
    await this._savePoolRecoverable();
    return { scope: projected.role === 'primary' ? 'main_conversation' : 'conversation', providerId, model };
  }
  async usePrimaryRoute() {
    const active = this._active();
    if (this.projection.active().role === 'primary') return { scope: 'primary' };
    const current = active.engine.pendingConfig ?? active.engine.config;
    const primary = this.config.routes.primary;
    const copied = withPrimaryRoute(current, primary.providerId, primary.model);
    const manifest = withGlobalSpecialistRoutes(copied.config, this.config).manifest;
    await this._updateSession(active, manifest);
    this._projectRoute(active.id, this.config.routes.primary);
    this.onChange();
    await this._savePoolRecoverable();
    return { scope: 'copied' };
  }
  async followPrimaryRoute() { return this.usePrimaryRoute(); }
  selectProviderForRole(role, providerId) { return selectWorkspaceProviderRole(this, role, providerId); }
  clearProviderForRole(role) { return clearWorkspaceProviderRole(this, role); }
  async addProvider(input) {
    if (this.projection.active().role !== 'primary') {
      throw new ContractError('provider_primary_required', 'add providers from the Main conversation');
    }
    const { next, entries } = providerAdditionPlan(this.sessions, this._active().id, this.config, input);
    await publishWorkspaceConfiguration(this, entries, next);
    for (const entry of entries) {
      if (entry.route) this._projectRoute(entry.session.id, entry.route);
    }
    this.onChange();
    await this._savePoolRecoverable();
    return next.config.providerProfiles[input.id];
  }
  async editProvider(id, input) {
    this._requireMainProviderManagement();
    const globalNext = withUpdatedProvider(this.config, id, input);
    const entries = [];
    for (const session of this.sessions.values()) {
      const current = session.engine.pendingConfig ?? session.engine.config;
      const sessionNext = withUpdatedProvider(current, id, input);
      entries.push({ session, manifest: sessionNext.manifest, route: sessionNext.config.routes.primary });
    }
    await publishWorkspaceConfiguration(this, entries, globalNext);
    for (const entry of entries) this._projectRoute(entry.session.id, entry.route);
    this.onChange();
    await this._savePoolRecoverable();
    return globalNext.config.providerProfiles[id];
  }
  deleteProvider(id) { return deleteWorkspaceProvider(this, id); }
  async testProvider(id) {
    const config = this.activeConfig();
    const profile = config.providerProfiles[id];
    if (!profile) throw new ContractError('provider_missing', `provider ${id} is not configured`);
    const provider = this.activeEngine().router.providerForProfile(profile);
    if (typeof provider.capabilities !== 'function') {
      return { id, ready: true, models: [profile.model], detail: 'Provider has no discovery endpoint; profile is structurally valid.' };
    }
    const capabilities = await boundedProviderCapabilities(provider, this.options.providerCapabilityDeadlineMs ?? 5_000);
    return {
      id, ready: true,
      models: Array.isArray(capabilities?.models)
        ? capabilities.models.filter((item) => typeof item === 'string' && item.length > 0 && item.length <= 256) : [profile.model],
      tools: capabilities?.tools,
      images: capabilities?.images,
    };
  }
  async discoverProviderModels(input) { this._requireMainProviderManagement(); return discoverWorkspaceProviderModels(this, input); }
  async toggleConfigSetting(setting) {
    const value = !booleanSettingValue(this.config, setting);
    const config = await this.#publishGlobalConfiguration((current) => withBooleanSetting(current, setting, value));
    return { setting, value, config };
  }
  async configureContext(maxContextBytes, threshold) {
    const config = await this.#publishGlobalConfiguration((current) => withContextSettings(current, maxContextBytes, threshold));
    return { maxContextBytes, threshold: config.limits.contextCompactionThreshold };
  }
  async configureRecovery(maxModelSteps, localLimit, ladder) {
    return (await this.#publishGlobalConfiguration(
      (current) => withRecoverySettings(current, maxModelSteps, localLimit, ladder),
    )).recovery;
  }
  async configureRuntimeLimits(values) { return (await this.#publishGlobalConfiguration((current) => withRuntimeLimits(current, values))).limits; }
  async configureKeyBindings(bindings) { return validateKeyBindings((await this.#publishGlobalConfiguration((current) => withKeyBindings(current, bindings))).tui.keyBindings); }
  async #publishGlobalConfiguration(transform) {
    const globalNext = transform(this.config);
    const entries = [];
    for (const session of this.sessions.values()) {
      const current = session.engine.pendingConfig ?? session.engine.config;
      entries.push({ session, manifest: transform(current).manifest });
    }
    await publishWorkspaceConfiguration(this, entries, globalNext);
    this.onChange(); await this._savePoolRecoverable();
    return globalNext.config;
  }
  mcpStatus() { return configuredMcpStatus(this.config, this.activeEngine()); }
  async addMcpServer(input) {
    this.#requirePrimaryMcpManagement();
    return this.#publishMcpConfiguration(withMcpServer(this.config, input));
  }
  saveMcpCredential(id, token) { return saveManagedMcpCredential(this.options.dataPaths ?? userDataPaths(), id, token); }
  removeMcpCredential(reference) { return deleteManagedMcpCredential(this.options.dataPaths ?? userDataPaths(), reference); }
  async editMcpServer(id, input) { this.#requirePrimaryMcpManagement(); return this.#publishMcpConfiguration(withMcpServerUpdate(this.config, id, input)); }
  async setMcpEnabled(id, enabled) {
    this.#requirePrimaryMcpManagement();
    return this.#publishMcpConfiguration(withMcpEnabled(this.config, id, enabled));
  }
  async deleteMcpServer(id) {
    this.#requirePrimaryMcpManagement();
    const reference = this.mcpStatus().find((server) => server.id === id)?.credentialEnv;
    const result = await this.#publishMcpConfiguration(withoutMcpServer(this.config, id));
    await deleteManagedMcpCredential(this.options.dataPaths ?? userDataPaths(), reference);
    return result;
  }
  async testMcpServer(id) {
    return testConfiguredMcpServer({
      config: this.config, webSearchConfigPath: this.webSearchConfigPath,
      webSearchClient: this.webSearchClient, transportFactory: this.options.mcpTransportFactory,
    }, id);
  }
  async availableModels() { return availableWorkspaceModels(this); }
  async qualifyActiveModel() { return qualifyWorkspaceModel(this); }
  webSearchStatus(test = false) { return webSearchStatus(this.#webSearchState(), test); }
  configureWebSearch(endpoint, managed = false) { return configureWebSearch(this.#webSearchState(), endpoint, managed); }
  async disableWebSearch() { return disableWebSearch(this.#webSearchState()); }
  async resetWebSearch() { return resetWebSearch(this.#webSearchState()); }
  async deployWebSearch() { return deployWebSearch(this.#webSearchState()); }
  manageWebSearch(action) { return manageWebSearch(this.#webSearchState(), action); }
  gatewayCommand(args) { return runGatewayCommand(args, this.options.dataPaths ?? userDataPaths()); }
  listSecrets() { this.#requirePrimarySecretManagement(); return this.secretBroker.list(); }
  createSecret(input) { this.#requirePrimarySecretManagement(); return this.secretBroker.create(input); }
  rotateSecret(id, fields) { this.#requirePrimarySecretManagement(); return this.secretBroker.rotate(id, fields); }
  setSecretEnabled(id, enabled) { this.#requirePrimarySecretManagement(); return this.secretBroker.setEnabled(id, enabled); }
  deleteSecret(id) { this.#requirePrimarySecretManagement(); return this.secretBroker.remove(id); }
  webFetchCommand(args) { return runWebFetchCommand(args, this.options.dataPaths ?? userDataPaths()); }
  reportError(error) {
    this.projection.showNotice(error.code ?? 'console', error.message ?? 'Console input failed.');
    this.onChange();
  }
  _requireMainProviderManagement() {
    if (this.projection.active().role !== 'primary') {
      throw new ContractError('provider_primary_required', 'manage provider profiles from the Main conversation');
    }
  }
  _requireMainSpecialistManagement() {
    if (this.projection.active().role !== 'primary') {
      throw new ContractError('provider_main_required', 'assign global reviewer, sub-agent, and vision profiles from Main');
    }
  }
  #webSearchState() {
    return { path: this.webSearchConfigPath, client: this.webSearchClient, deployment: this.searxngDeployment };
  }
  #requirePrimaryMcpManagement() {
    if (this.projection.active().role !== 'primary') {
      throw new ContractError('mcp_primary_required', 'manage MCP servers from the Main conversation');
    }
  }
  #requirePrimarySecretManagement() {
    if (this.projection.active().role !== 'primary') {
      throw new ContractError('secret_primary_required', 'manage local secrets from the Main conversation');
    }
  }
  async #publishMcpConfiguration(next) {
    await writeWorkspaceManifest(this, next.manifest);
    this.config = advanceWorkspaceConfig(this, next.config);
    this.onChange();
    await this._savePoolRecoverable();
    return { servers: next.config.mcpServers, restartRequired: true };
  }
  async _publishProviderCatalog(next) {
    const entries = providerCatalogEntries(this.sessions, next.config);
    await publishWorkspaceConfiguration(this, entries, next);
    for (const { session } of entries) {
      this._projectRoute(session.id, (session.engine.pendingConfig ?? session.engine.config).routes.primary);
    }
    this.onChange();
    await this._savePoolRecoverable();
  }
  async _publishSpecialistRoutes(next) {
    const entries = specialistRouteEntries(this.sessions, next.config);
    await publishWorkspaceConfiguration(this, entries, next);
    this.onChange();
    await this._savePoolRecoverable();
  }
  async _updateSession(session, manifest) {
    await session.engine.updateConfiguration({
      request_id: newId('tui_config'), type: 'configuration_update', manifest,
    });
  }
  _projectRoute(sessionId, route) {
    const projected = this.projection.sessions.get(sessionId);
    const session = this.sessions.get(sessionId);
    const config = session?.engine.pendingConfig ?? session?.engine.config;
    if (projected) projected.metadata = routePresentation(config, route, projected.metadata);
  }
  _active() {
    const session = this.sessions.get(this.projection.activeId);
    if (!session) throw new ContractError('session_missing', 'no active conversation');
    return session;
  }
  #savePool() {
    return this.tabPersistence.save();
  }
  _savePoolRecoverable() {
    return this.tabPersistence.recover();
  }
  #own(operation) {
    const task = Promise.resolve(operation).catch((error) => {
      const active = this.projection.active();
      if (active) this.projection.apply(active.id, {
        type: 'error', code: error.code ?? 'interactive_failure', message: error.message,
      });
    }).finally(() => this.#tasks.delete(task));
    this.#tasks.add(task);
    return task;
  }
}
