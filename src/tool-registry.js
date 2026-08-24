// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ContractError, newId } from './ids.js';
import { GuidanceCatalog } from './guidance/catalog.js';
import { guidanceDefinitions } from './guidance/tools.js';
import { PathPolicy } from './path-policy.js';
import { userDataPaths } from './product.js';
import { webSearchDefinition } from './web-search-tool.js';
import { webFetchDefinition } from './web-fetch-tool.js';
import { webBrowseDefinition } from './web-browse-tool.js';
import { rankToolDefinitions, toolSearchDefinition } from './tools/search.js';
import { processRunDefinition, shellRunDefinition } from './tools/process.js';
import { elevationDefinition } from './elevation-tool.js';
import { projectVerifyDefinition } from './tools/project-verification.js';
import { filesystemExtraDefinitions } from './tools/filesystem-extra.js';
import { lspDiagnosticsDefinition } from './tools/lsp-diagnostics.js';
import { filesystemReadDefinitions, ReadReceiptLedger } from './tools/filesystem-read.js';
import { filesystemEditDefinition } from './tools/filesystem-edit.js';
import { filesystemDiscoveryDefinitions } from './tools/filesystem-discovery.js';
import { canonicalFilesystemDefinitions } from './tools/filesystem-canonical.js';
import { imageInspectDefinition } from './tools/image-inspection.js';
import { skillToolDefinitions } from './skill-registry.js';
import { FileChangeLedger } from './persistence/file-change-ledger.js';
import { selfDiagnosticsDefinitions } from './tools/self-diagnostics.js';
import { mcpControlDefinitions } from './mcp-control-tools.js';
import { subagentDefinition } from './subagent-tool.js';
import { gitInspectionDefinition } from './tools/git-inspection.js';
import { prepareLineEdit } from './stale-edit-recovery.js';
import { providerSchema, schemaShapeValidator, schemaValidator } from './tools/schema.js';
import { conversationWorkDefinitions } from './conversation-work-tools.js';
import { ReferenceStore, referenceDefinitions } from './tools/reference-store.js';
import { PROVIDER_NATIVE, allowedByManifest, catalogVisible, providerVisible } from './tools/provider-surface.js';
import { withPreparedWriteTarget } from './tools/write-target.js';
import { normalizeArgumentAliases } from './tools/argument-normalization.js';
import { advanceFromAuthoredState, mutationEvidence, transactionalSnapshot,
  withAuthoredAdvanceMetadata } from './tools/filesystem-mutation-state.js';
import { directBrowserIntent, SITUATIONAL_TOOL_NAMES, taskActivatedToolNames } from './tools/capability-activation.js';
import { telegramNotificationDefinition } from './notifications/telegram.js';
import { sessionHistoryDefinitions } from './session-history-tools.js';
import { logicalLines, replaceLineRange } from './tools/text-edit-helpers.js';
import { planProviderToolNames, providerSurfacePhase } from './tools/provider-surface-planner.js';
const MAX_TEXT_BYTES = 1_048_576;
const MAX_MODEL_AUTHORED_TEXT_BYTES = 32_768;
const SITUATIONAL = new Set(SITUATIONAL_TOOL_NAMES);
export class ToolRegistry {
  #definitions = new Map();
  #history = new Map();
  #providerIds = new Set();
  #exposed = new Map();
  #readReceipts = new ReadReceiptLedger();
  #references = new ReferenceStore();
  #changes;
  constructor(workspaceRoot, options = {}) {
    this.enabled = options.enabled !== false;
    this.hosted = options.hosted === true;
    this.allowedTools = Array.isArray(options.allowedTools) ? new Set(options.allowedTools) : null;
    this.paths = new PathPolicy(workspaceRoot, { boundedToWorkspace: options.boundedToWorkspace, protectedRoots: [userDataPaths().root] });
    this.#changes = new FileChangeLedger(this.paths.inputRoot);
    this.guidance = new GuidanceCatalog(options.guidanceRoot);
    this.webSearchConfigPath = options.webSearchConfigPath ?? userDataPaths().webSearchConfig;
    this.webSearchClient = options.webSearchClient;
    this.webFetchConfigPath = options.webFetchConfigPath ?? userDataPaths().webFetchConfig;
    this.browserManager = options.browserManager; this.secretBroker = options.secretBroker; this.sessionId = options.sessionId;
    this.observeImage = options.observeImage; this.imageMaxBytes = options.imageMaxBytes;
    this.browserRoot = options.browserRoot ?? join(userDataPaths().root, 'runtime', 'browser', options.sessionId ?? 'standalone');
    this.managedPlaywrightRoot = options.managedPlaywrightRoot ?? userDataPaths().managedPlaywright;
    this.lspConfigPath = options.lspConfigPath ?? join(userDataPaths().config, 'lsp.json');
    this.lspSpawnProcess = options.lspSpawnProcess;
    this.skills = options.skillRegistry;
    this.diagnosticContext = options.diagnosticContext;
    this.mcpControl = options.mcpControl;
    this.subagentControl = options.subagentControl;
    this.conversationWork = options.conversationWork;
    this.telegramNotifications = options.telegramNotifications; this.activeTurnId = options.activeTurnId; this.sessionHistory = options.sessionHistory;
    this.elevationBroker = options.elevationBroker;
  }
  async initialize() {
    await this.paths.initialize();
    await this.guidance.initialize();
    if (!this.enabled) return;
    for (const definition of referenceDefinitions(this.#references, this.paths)) this.#install(definition);
    const legacyFilesystem = [
      ...filesystemReadDefinitions(this.paths, this.#readReceipts, this.#references),
      ...filesystemDiscoveryDefinitions(this.paths),
    ];
    for (const definition of legacyFilesystem) this.#install(definition);
    this.#install(writeDefinition(this.paths, this.#changes, this.#readReceipts));
    this.#install(filesystemEditDefinition(this.paths, this.#changes, this.#readReceipts, atomicWrite, verifyExpectedState));
    this.#install(editLinesDefinition(this.paths, this.#changes, this.#readReceipts));
    this.#install(deleteDefinition(this.paths, this.#changes, this.#readReceipts));
    const filesystemExtras = filesystemExtraDefinitions(this.paths, this.#changes, this.#readReceipts);
    for (const definition of filesystemExtras) this.#install(definition);
    const legacyFilesystemMap = new Map([...legacyFilesystem, ...filesystemExtras].map((definition) => [definition.name, definition]));
    for (const definition of canonicalFilesystemDefinitions(this.paths, legacyFilesystemMap)) this.#install(definition);
    for (const definition of guidanceDefinitions(this.guidance)) this.#install(definition);
    for (const definition of selfDiagnosticsDefinitions(this.diagnosticContext)) this.#install(definition);
    for (const definition of mcpControlDefinitions(this.mcpControl)) this.#install(definition);
    this.#install(webSearchDefinition({ configPath: this.webSearchConfigPath, client: this.webSearchClient, references: this.#references }));
    this.#install(webFetchDefinition({ configPath: this.webFetchConfigPath, references: this.#references }));
    if (!this.hosted) this.#install(webBrowseDefinition({ manager: this.browserManager, root: this.browserRoot, paths: this.paths,
      managedPlaywrightRoot: this.managedPlaywrightRoot, configPath: this.webFetchConfigPath,
      secretBroker: this.secretBroker, sessionId: this.sessionId }));
    this.#install(imageInspectDefinition(this.paths, this.observeImage, { maxBytes: this.imageMaxBytes })); this.#install(toolSearchDefinition(this));
    this.#install(processRunDefinition(this.paths, this.#references)); if (!this.hosted) this.#install(shellRunDefinition(this.paths, this.#references));
    if (!this.hosted && this.elevationBroker) this.#install(elevationDefinition(this.paths, this.elevationBroker));
    this.#install(projectVerifyDefinition(this.paths));
    this.#install(gitInspectionDefinition(this.paths));
    this.#install(lspDiagnosticsDefinition(this.paths, { configPath: this.lspConfigPath, spawnProcess: this.lspSpawnProcess }));
    if (this.skills) for (const definition of skillToolDefinitions(this.skills)) this.#install(definition);
    if (this.subagentControl && !this.hosted) this.#install(subagentDefinition(this.subagentControl));
    if (this.conversationWork) for (const definition of conversationWorkDefinitions(this.conversationWork)) this.#install(definition);
    if (this.telegramNotifications) this.#install(telegramNotificationDefinition(this.telegramNotifications, this.activeTurnId));
    for (const definition of sessionHistoryDefinitions(this.sessionHistory)) this.#install(definition);
  }
  async close() { await this.definition('web.browse')?.manager?.close?.(); }
  snapshot() {
    return Object.freeze([...this.#definitions.values()].map(({ executor: _executor, validate: _validate, ...item }) => deepFreeze(structuredClone(item))));
  }
  catalogSnapshot() {
    return Object.freeze(this.snapshot().filter((item) => catalogVisible(item.name) || this.allowedTools?.has(item.name)));
  }
  providerDefinitions(query = '', options = {}) {
    return this.providerSurface(query, options).definitions;
  }
  providerSurface(query = '', options = {}) {
    const phase = providerSurfacePhase(options.phase);
    const activated = new Set(taskActivatedToolNames(query));
    // Hosted or explicitly-ceilinged registries may provide process.run without a shell.
    // Preserve execution capability there without making process.run compete with shell.run
    // in the ordinary root model surface.
    if (activated.has('shell.run') && !this.#definitions.has('shell.run') && this.#definitions.has('process.run')) {
      activated.add('process.run');
    }
    const relevant = new Set(query.trim() ? this.searchCatalog(query, 6).map((item) => item.name)
      .filter((name) => !SITUATIONAL.has(name) || activated.has(name))
      // The governed canonical browser is the direct task-intent capability.
      // Do not let a semantically similar external browser schema compete with
      // it unless that exact external tool was explicitly exposed or granted.
      .filter((name) => !activated.has('web.browse') || name === 'web.browse'
        || !/(?:browser|browse)/u.test(name) || this.#exposed.has(name)) : []);
    const snapshot = this.snapshot();
    const callable = snapshot.filter((item) => providerVisible(
      item.name, this.#exposed.has(item.name), activated.has(item.name),
    ) || this.allowedTools?.has(item.name));
    const projected = new Map(callable.map((item) => [item.name, {
      type: 'function',
      // Keep human-readable field semantics on the wire. The compact projection
      // removed every property description, leaving local models to infer
      // conditional contracts from names alone while runtime validation still
      // enforced the omitted rules.
      function: { name: item.name, description: compactPurpose(item), parameters: providerSchema(item.inputSchema, { mode: 'documented' }) },
    }]));
    const plan = planProviderToolNames({
      availableNames: callable.map((item) => item.name), activatedNames: activated,
      relevantNames: relevant, exposedNames: this.#exposed.keys(),
      directNames: directBrowserIntent(query) ? ['web.browse'] : [], allowedNames: this.allowedTools,
      phase, encodedDefinition: (name) => Buffer.byteLength(JSON.stringify(projected.get(name)), 'utf8'),
    });
    const definitions = Object.freeze(plan.names.map((name) => Object.freeze(projected.get(name))));
    const receiptCore = {
      schema: 'nna.provider-tool-surface.v1', policyVersion: 'progressive-action-clarity-v1',
      phase: plan.phase, selectedToolNames: plan.names, omittedToolNames: plan.omitted,
      schemaBytes: plan.schemaBytes, limits: plan.limits, selectionReasons: plan.reasons,
    };
    return Object.freeze({
      definitions,
      receipt: Object.freeze({ ...receiptCore, fingerprint: createHash('sha256')
        .update(JSON.stringify(receiptCore)).digest('hex') }),
    });
  }
  search(query, limit = 12) {
    return rankToolDefinitions(this.snapshot(), query, limit);
  }
  searchCatalog(query, limit = 12) { return rankToolDefinitions(this.catalogSnapshot(), query, limit); }
  diff(path = null) { return this.#changes.diff(path); }
  changeSnapshot() { return this.#changes.snapshot(); }
  expose(names, options = {}) {
    const uses = Number.isSafeInteger(options.uses) ? Math.max(1, Math.min(32, options.uses)) : 1;
    for (const name of names) {
      if (!this.#definitions.has(name)) continue;
      const prior = this.#exposed.get(name);
      this.#exposed.delete(name);
      this.#exposed.set(name, { remainingUses: Math.max(prior?.remainingUses ?? 0, uses) });
      while (this.#exposed.size > 32) this.#exposed.delete(this.#exposed.keys().next().value);
    }
  }
  async seal(call, context) {
    if (this.#providerIds.has(call.providerCallId)) {
      throw new ContractError('duplicate_tool_call', 'provider tool-call identity was already used');
    }
    const definition = this.#definitions.get(call.name);
    if (!definition) throw new ContractError('unknown_tool', `tool ${call.name} is unavailable`);
    const binding = call.name.startsWith('ref.')
      ? { args: call.args, bindings: [] } : this.#references.bindArguments(call.args);
    const validated = await definition.validate(binding.args);
    const normalized = binding.bindings.length === 0 ? validated : {
      ...validated, resolved: { ...validated.resolved, referenceBindings: binding.bindings },
    };
    this.#assertReadBeforeMutation(call.name, normalized);
    this.#providerIds.add(call.providerCallId);
    const exposure = this.#exposed.get(call.name);
    if (exposure) {
      if (exposure.remainingUses <= 1) this.#exposed.delete(call.name);
      else this.#exposed.set(call.name, { remainingUses: exposure.remainingUses - 1 });
    }
    return deepFreeze({
      id: newId('tool'), providerCallId: call.providerCallId, toolName: call.name,
      args: normalized.args, resolved: normalized.resolved,
      definitionVersion: definition.version, policyVersion: context.policyVersion,
      authorityId: context.authority.id, authorityVersion: context.authority.version,
      authorityRestrictionVersion: context.authority.restrictionVersion ?? 0,
      stateRevision: context.stateRevision ?? 0,
      stepId: context.stepId, caller: context.caller, surface: context.surface,
      workspaceRoot: this.paths.root, createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    });
  }
  #assertReadBeforeMutation(name, normalized) {
    if (!name.startsWith('fs.') || !normalized?.args?.expected_sha256) return;
    const target = normalized.resolved?.source?.path ?? normalized.resolved?.path;
    if (!target || normalized.resolved?.exists === false) return;
    if (normalized.resolved?.staleEditRecovered === true) return;
    const transaction = normalized.resolved?.transactionalReceipt;
    if (transaction) {
      if (!['fs.write_text', 'fs.edit_text'].includes(name)
        || transaction.origin !== 'runtime_transaction'
        || transaction.path !== target
        || transaction.digest !== normalized.args.expected_sha256) {
        throw new ContractError('read_receipt_required', 'runtime transaction snapshot is invalid for this mutation');
      }
      return;
    }
    if (name === 'fs.edit_lines' || (name === 'fs.edit_text' && normalized.args.edit_mode === 'lines')) {
      this.#readReceipts.require(target, normalized.args.expected_sha256, {
        start: normalized.args.start_line, end: normalized.args.end_line,
      });
    } else this.#readReceipts.require(target, normalized.args.expected_sha256, { full: true });
  }
  definition(name, version = null) {
    return version === null ? this.#definitions.get(name) : this.#history.get(`${name}@${version}`);
  }
  installExternal(definition) {
    if (!definition || typeof definition.executor !== 'function') {
      throw new ContractError('invalid_external_tool', 'external tool requires an executor');
    }
    this.#install({ ...definition, validate: definition.validate ?? schemaValidator(definition.inputSchema) });
  }
  revokeSource(source) {
    for (const [name, definition] of this.#definitions) {
      if (definition.source === source) this.#definitions.delete(name);
    }
  }
  #install(definition) {
    if (this.hosted && definition.name === 'agent.run') return false;
    if (!allowedByManifest(this.allowedTools, definition.name)) return false;
    if (this.#definitions.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
    const maxOutputBytes = definition.maxOutputBytes ?? 1_048_576;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 2_097_152) {
      throw new ContractError('invalid_tool_output_bound', 'tool output policy must be 1 to 2097152 bytes');
    }
    const validate = definition.validate ?? schemaValidator(definition.inputSchema);
    const validateShape = schemaShapeValidator(definition.inputSchema);
    const normalizeArgs = definition.normalizeArgs ?? ((args) => args);
    const { normalizeArgs: _normalizeArgs, ...installedDefinition } = definition;
    const frozen = Object.freeze({
      ...installedDefinition, maxOutputBytes,
      validate: async (args) => {
        const normalized = normalizeArgs(args); await validateShape(normalized);
        return validate(normalized);
      },
    });
    this.#definitions.set(definition.name, frozen);
    this.#history.set(`${definition.name}@${definition.version}`, frozen);
    return true;
  }
}

function compactPurpose(definition) {
  const override = definition.providerFacade?.description;
  const purpose = typeof override === 'string' && override.trim() ? override.trim() : definition.purpose;
  const text = typeof purpose === 'string' ? purpose.trim().replace(/\s+/gu, ' ') : `Call ${definition.name}`;
  const sentence = text.match(/^.*?[.!?](?:\s|$)/u)?.[0]?.trim() ?? text;
  return sentence.length <= 180 ? sentence : `${sentence.slice(0, 179)}…`;
}
function writeDefinition(paths, changes, receipts) {
  return {
    name: 'fs.write_text', version: 2, purpose: 'Atomically write one provider-safe UTF-8 file payload, creating missing parent directories for a new target. Keep generated files compact and split larger implementations across files or follow with anchored edits. A successful full write becomes the current authored file state, so a redundant read is not required before a subsequent edit.',
    sideEffect: 'reversible', scope: 'workspace', cancellation: true, timeoutMs: 10_000,
    inputSchema: objectSchema({
      path: { type: 'string', maxLength: 4096, description: 'Required destination file path.' },
      content: { type: 'string', maxLength: MAX_MODEL_AUTHORED_TEXT_BYTES, description: 'Required complete UTF-8 content, at most 32 KiB. Split larger implementations across files or use subsequent anchored edits.' },
    }, ['path', 'content']),
    normalizeArgs: (args) => normalizeArgumentAliases(args, {
      path: ['filePath', 'file_path'], content: ['text'],
    }),
    validate: async (args) => {
      requireShape(args, ['path', 'content']);
      if (Buffer.byteLength(args.content, 'utf8') > MAX_MODEL_AUTHORED_TEXT_BYTES) {
        throw new ContractError('tool_arguments_too_large', 'write content exceeds the provider-safe 32 KiB payload bound; split the implementation across files or edits');
      }
      const resolved = await paths.withRecovery(await paths.resolveWriteWithParents(args.path));
      const existingSize = resolved.exists ? (await stat(resolved.path)).size : 0;
      if (existingSize > MAX_TEXT_BYTES) {
        throw new ContractError('tool_target_too_large', 'existing file exceeds transactional write bound');
      }
      const explicitReceipt = resolved.exists ? receipts.peek(resolved.path, { full: true }) : null;
      const transaction = resolved.exists && !explicitReceipt && resolved.insideWorkspace
        ? await transactionalSnapshot(resolved) : null;
      if (resolved.exists && !explicitReceipt && !transaction) receipts.latest(resolved.path, { full: true });
      const digest = explicitReceipt?.digest ?? transaction?.digest ?? null;
      return {
        args: { path: args.path, content: args.content, expected_sha256: digest },
        resolved: {
          ...resolved, readReceiptId: explicitReceipt?.id ?? null, transactionalReceipt: transaction,
          mutationEvidence: mutationEvidence('replace', digest, args.content, existingSize),
        },
      };
    },
    executor: (request, signal) => executeFullWrite(paths, receipts, request, signal, changes),
  };
}
async function executeFullWrite(paths, receipts, request, signal, changes) {
  const prepared = await advanceFromAuthoredState(request, receipts);
  const result = await withPreparedWriteTarget(paths, prepared.request, signal,
    () => atomicWrite(prepared.request, signal, {}, changes));
  receipts.recordAuthored(prepared.request.resolved.path, sha256(prepared.request.args.content), prepared.request.args.content);
  return withAuthoredAdvanceMetadata(result, prepared.advanced);
}
function editLinesDefinition(paths, changes, receipts) {
  return {
    name: 'fs.edit_lines', version: 3,
    purpose: 'Replace one inclusive line range in an existing UTF-8 file. Supply only path, start_line, end_line, and replacement; use fs.edit_text instead when selecting exact text. Read the relevant numbered lines first so NNA can anchor and revalidate the edit.',
    sideEffect: 'reversible', scope: 'workspace', cancellation: true, timeoutMs: 10_000,
    inputSchema: objectSchema({
      path: { type: 'string', maxLength: 4096, description: 'Required path previously read with fs.read or fs.read_lines.' },
      start_line: { type: 'integer', minimum: 1, maximum: 10_000_000, description: 'Required first one-based line in the inclusive replacement range.' },
      end_line: { type: 'integer', minimum: 1, maximum: 10_000_000, description: 'Required last one-based line in the inclusive replacement range.' },
      replacement: { type: 'string', maxLength: MAX_MODEL_AUTHORED_TEXT_BYTES, description: 'Required replacement text, at most 32 KiB. Keep the range focused and use multiple edits for larger rewrites; use an empty string to remove the selected lines.' },
    }, ['path', 'start_line', 'end_line', 'replacement']),
    validate: async (args) => {
      requireShape(args, ['path', 'start_line', 'end_line', 'replacement']);
      if (!Number.isSafeInteger(args.start_line) || !Number.isSafeInteger(args.end_line)
        || args.start_line < 1 || args.end_line < args.start_line || args.end_line - args.start_line >= 400) {
        throw new ContractError('tool_schema_invalid', 'line range must be ordered, positive, and at most 400 lines');
      }
      if (typeof args.replacement !== 'string' || Buffer.byteLength(args.replacement, 'utf8') > MAX_MODEL_AUTHORED_TEXT_BYTES) {
        throw new ContractError('tool_arguments_too_large', 'replacement exceeds the provider-safe 32 KiB payload bound; edit a smaller line range');
      }
      const resolved = await paths.withRecovery(await paths.resolveRead(args.path));
      const receipt = receipts.latest(resolved.path, { start: args.start_line, end: args.end_line });
      const content = await readFile(resolved.path, 'utf8');
      const actual = sha256(content);
      const boundArgs = { ...args, expected_sha256: receipt.digest };
      const prepared = prepareLineEdit(receipts, resolved.path, boundArgs, content, actual);
      if (prepared.endLine > logicalLines(content).length) {
        throw new ContractError('edit_line_out_of_range', 'line range exceeds the file snapshot');
      }
      return {
        args: { ...boundArgs, start_line: prepared.startLine, end_line: prepared.endLine, expected_sha256: prepared.expectedSha256 },
        resolved: { ...resolved, staleEditRecovered: prepared.recovered, readReceiptId: receipt.id, readReceiptSha256: receipt.digest },
      };
    },
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
      await verifyExpectedState(request);
      const content = await readFile(request.resolved.path, 'utf8');
      const updated = replaceLineRange(content, request.args.start_line, request.args.end_line, request.args.replacement);
      if (Buffer.byteLength(updated, 'utf8') > MAX_TEXT_BYTES) {
        throw new ContractError('tool_arguments_too_large', 'edited content exceeds bound');
      }
      return atomicWrite({ ...request, args: { ...request.args, content: updated } }, signal, {
        message: 'anchored line edit completed', replacements: request.args.end_line - request.args.start_line + 1,
      }, changes);
    },
  };
}
function deleteDefinition(paths, changes, receipts) {
  return {
    name: 'fs.delete_file', version: 1,
    purpose: 'Permanently delete one accessible regular file after exact-content revalidation and mandatory review.',
    sideEffect: 'irreversible', scope: 'workspace', cancellation: true, timeoutMs: 10_000,
    inputSchema: objectSchema({
      path: { type: 'string', maxLength: 4096, description: 'Required path to the existing regular file.' },
    }, ['path']),
    validate: async (args) => {
      requireShape(args, ['path']);
      const resolved = await paths.withRecovery(await paths.resolveRead(args.path));
      const receipt = receipts.latest(resolved.path, { full: true });
      return {
        args: { path: args.path, expected_sha256: receipt.digest },
        resolved: { ...resolved, readReceiptId: receipt.id },
      };
    },
    executor: (request, signal) => executeDelete(request, signal, changes),
  };
}
async function executeDelete(request, signal, changes) {
  if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
  await verifyExpectedState(request);
  const before = await readFile(request.resolved.path);
  if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled before commit');
  await unlink(request.resolved.path);
  changes.record(request.resolved.path, before, null, 'fs.delete_file');
  return { content: 'file deleted', metadata: { path: request.args.path } };
}
async function atomicWrite(request, signal, detail = {}, changes = null) {
  if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
  await verifyExpectedState(request);
  const before = request.resolved.exists ? await readFile(request.resolved.path) : null;
  const temporary = join(dirname(request.resolved.path), `.nna-write-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(request.args.content, 'utf8');
    await handle.sync();
    if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled before commit');
    await handle.close();
    await rename(temporary, request.resolved.path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  changes?.record(request.resolved.path, before, Buffer.from(request.args.content, 'utf8'), request.toolName ?? 'fs.write_text');
  return {
    content: detail.message ?? 'write completed',
    metadata: {
      bytes: Buffer.byteLength(request.args.content), path: request.args.path,
      sha256: sha256(request.args.content),
      ...(detail.replacements === undefined ? {} : { replacements: detail.replacements }),
    },
  };
}
async function verifyExpectedState(request) {
  if (!request.resolved.exists) {
    try {
      await stat(request.resolved.path);
      throw new ContractError('tool_revalidation_drift', 'target was created after review');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
  const current = await readFile(request.resolved.path);
  const actual = createHash('sha256').update(current).digest('hex');
  if (actual !== request.args.expected_sha256) {
    throw new ContractError('tool_revalidation_drift', 'target changed after review');
  }
}
function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}
function requireShape(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError('tool_schema_invalid', 'tool arguments must be an object');
  }
  const allowed = new Set([...required, ...optional]);
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) throw new ContractError('tool_schema_invalid', `required argument "${missing}" is missing`);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new ContractError('tool_schema_invalid', `unknown argument "${unknown}"`);
  if (typeof value.path !== 'string' || (Object.hasOwn(value, 'content') && typeof value.content !== 'string')) {
    throw new ContractError('tool_schema_invalid', 'tool argument types are invalid');
  }
}
function objectSchema(properties, required) { return { type: 'object', properties, required, additionalProperties: false }; }
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}
