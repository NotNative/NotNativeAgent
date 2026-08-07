// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ContractError, newId } from './ids.js';
import { GuidanceCatalog } from './guidance-catalog.js';
import { guidanceDefinitions } from './guidance-tools.js';
import { PathPolicy } from './path-policy.js';
import { userDataPaths } from './product.js';
import { webSearchDefinition } from './web-search-tool.js';
import { webFetchDefinition } from './web-fetch-tool.js';
import { webBrowseDefinition } from './web-browse-tool.js';
import { rankToolDefinitions, toolSearchDefinition } from './tool-search.js';
import { processRunDefinition, shellRunDefinition } from './process-tool.js';
import { filesystemExtraDefinitions } from './filesystem-extra-tools.js';
import { lspDiagnosticsDefinition } from './lsp-diagnostics.js';
import { filesystemReadDefinitions, ReadReceiptLedger } from './filesystem-read-tools.js';
import { filesystemDiscoveryDefinitions } from './filesystem-discovery-tools.js';
import { skillToolDefinitions } from './skill-registry.js';
import { FileChangeLedger } from './file-change-ledger.js';
import { selfDiagnosticsDefinitions } from './self-diagnostics-tool.js';
import { mcpControlDefinitions } from './mcp-control-tools.js';
import { subagentDefinition } from './subagent-tool.js';
import { gitInspectionDefinition } from './git-inspection-tool.js';
import { prepareLineEdit, prepareTextEdit } from './stale-edit-recovery.js';
import { conversationWorkDefinitions } from './conversation-work-tools.js';
import { CORE_TOOL_NAMES } from './core-tool-names.js';
import { telegramNotificationDefinition } from './telegram-notifications.js'; import { sessionHistoryDefinitions } from './session-history-tools.js';
const MAX_TEXT_BYTES = 1_048_576; const ALWAYS_EXPOSED = new Set(CORE_TOOL_NAMES);
export class ToolRegistry {
  #definitions = new Map();
  #history = new Map();
  #providerIds = new Set();
  #exposed = new Map();
  #readReceipts = new ReadReceiptLedger();
  #changes;
  constructor(workspaceRoot, options = {}) {
    this.enabled = options.enabled !== false;
    this.hosted = options.hosted === true;
    this.allowedTools = Array.isArray(options.allowedTools) ? new Set(options.allowedTools) : null;
    this.paths = new PathPolicy(workspaceRoot, { boundedToWorkspace: options.boundedToWorkspace });
    this.#changes = new FileChangeLedger(this.paths.inputRoot);
    this.guidance = new GuidanceCatalog(options.guidanceRoot);
    this.webSearchConfigPath = options.webSearchConfigPath ?? userDataPaths().webSearchConfig;
    this.webSearchClient = options.webSearchClient;
    this.webFetchConfigPath = options.webFetchConfigPath ?? userDataPaths().webFetchConfig;
    this.browserManager = options.browserManager; this.secretBroker = options.secretBroker; this.sessionId = options.sessionId;
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
  }
  async initialize() {
    await this.paths.initialize();
    await this.guidance.initialize();
    if (!this.enabled) return;
    for (const definition of filesystemReadDefinitions(this.paths, this.#readReceipts)) this.#install(definition);
    for (const definition of filesystemDiscoveryDefinitions(this.paths)) this.#install(definition);
    this.#install(writeDefinition(this.paths, this.#changes));
    this.#install(editDefinition(this.paths, this.#changes, this.#readReceipts));
    this.#install(editLinesDefinition(this.paths, this.#changes, this.#readReceipts));
    this.#install(deleteDefinition(this.paths, this.#changes));
    for (const definition of filesystemExtraDefinitions(this.paths, this.#changes)) this.#install(definition);
    for (const definition of guidanceDefinitions(this.guidance)) this.#install(definition);
    for (const definition of selfDiagnosticsDefinitions(this.diagnosticContext)) this.#install(definition);
    for (const definition of mcpControlDefinitions(this.mcpControl)) this.#install(definition);
    this.#install(webSearchDefinition({ configPath: this.webSearchConfigPath, client: this.webSearchClient }));
    this.#install(webFetchDefinition({ configPath: this.webFetchConfigPath }));
    if (!this.hosted) this.#install(webBrowseDefinition({ manager: this.browserManager, root: this.browserRoot,
      managedPlaywrightRoot: this.managedPlaywrightRoot, configPath: this.webFetchConfigPath,
      secretBroker: this.secretBroker, sessionId: this.sessionId }));
    this.#install(toolSearchDefinition(this));
    this.#install(processRunDefinition(this.paths)); if (!this.hosted) this.#install(shellRunDefinition(this.paths));
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
  providerDefinitions(query = '') {
    const relevant = new Set(query.trim() ? this.search(query, 6).map((item) => item.name) : []);
    const definitions = this.snapshot().filter((item) => ALWAYS_EXPOSED.has(item.name) || this.#exposed.has(item.name) || relevant.has(item.name)).map((item) => ({
      type: 'function',
      function: { name: item.name, description: item.purpose, parameters: item.inputSchema },
    }));
    this.#ageExposed();
    return definitions;
  }
  search(query, limit = 12) {
    return rankToolDefinitions(this.snapshot(), query, limit);
  }
  diff(path = null) { return this.#changes.diff(path); }
  changeSnapshot() { return this.#changes.snapshot(); }
  expose(names) {
    for (const name of names) {
      if (!this.#definitions.has(name)) continue;
      this.#exposed.delete(name); this.#exposed.set(name, 3);
      while (this.#exposed.size > 32) this.#exposed.delete(this.#exposed.keys().next().value);
    }
  }
  async seal(call, context) {
    if (this.#providerIds.has(call.providerCallId)) {
      throw new ContractError('duplicate_tool_call', 'provider tool-call identity was already used');
    }
    const definition = this.#definitions.get(call.name);
    if (!definition) throw new ContractError('unknown_tool', `tool ${call.name} is unavailable`);
    const normalized = await definition.validate(call.args);
    this.#assertReadBeforeMutation(call.name, normalized);
    this.#providerIds.add(call.providerCallId);
    return deepFreeze({
      id: newId('tool'), providerCallId: call.providerCallId, toolName: call.name,
      args: normalized.args, resolved: normalized.resolved,
      definitionVersion: definition.version, policyVersion: context.policyVersion,
      authorityId: context.authority.id, authorityVersion: context.authority.version,
      authorityRestrictionVersion: context.authority.restrictionVersion ?? 0,
      stepId: context.stepId, caller: context.caller, surface: context.surface,
      workspaceRoot: this.paths.root, createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    });
  }
  #assertReadBeforeMutation(name, normalized) {
    if (!name.startsWith('fs.') || !normalized?.args?.expected_sha256) return;
    const target = normalized.resolved?.source?.path ?? normalized.resolved?.path;
    if (!target || normalized.resolved?.exists === false) return;
    if (normalized.resolved?.staleEditRecovered === true) return;
    if (name === 'fs.edit_lines') {
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
  #ageExposed() {
    for (const [name, remaining] of this.#exposed) {
      if (remaining <= 1) this.#exposed.delete(name);
      else this.#exposed.set(name, remaining - 1);
    }
  }
  #install(definition) {
    if (this.hosted && definition.name === 'agent.run') return false;
    if (this.allowedTools && !this.allowedTools.has(definition.name)) return false;
    if (this.#definitions.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
    const maxOutputBytes = definition.maxOutputBytes ?? 1_048_576;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 2_097_152) {
      throw new ContractError('invalid_tool_output_bound', 'tool output policy must be 1 to 2097152 bytes');
    }
    const frozen = Object.freeze({ ...definition, maxOutputBytes });
    this.#definitions.set(definition.name, frozen);
    this.#history.set(`${definition.name}@${definition.version}`, frozen);
    return true;
  }
}
function schemaValidator(schema) {
  if (!schema || schema.type !== 'object' || (schema.properties && typeof schema.properties !== 'object')) {
    throw new ContractError('invalid_external_schema', 'external tool input schema must describe an object');
  }
  validateSchema(schema);
  return async (args) => {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new ContractError('tool_schema_invalid', 'tool arguments must be an object');
    }
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some((key) => !Object.hasOwn(args, key))) {
      throw new ContractError('tool_schema_invalid', 'tool arguments omit a required property');
    }
    if (schema.additionalProperties === false
      && Object.keys(args).some((key) => !Object.hasOwn(schema.properties ?? {}, key))) {
      throw new ContractError('tool_schema_invalid', 'tool arguments contain an unknown property');
    }
    for (const [key, value] of Object.entries(args)) validateValue(value, schema.properties?.[key], 0);
    return { args: structuredClone(args), resolved: { source: 'external' } };
  };
}
function validateValue(value, rule, depth) {
  if (!rule?.type) return;
  if (depth > 12) throw new ContractError('tool_schema_invalid', 'tool argument nesting exceeds bound');
  const types = Array.isArray(rule.type) ? rule.type : [rule.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!types.includes(actual) && !(actual === 'number' && types.includes('integer') && Number.isInteger(value))) {
    throw new ContractError('tool_schema_invalid', 'tool argument type does not match schema');
  }
  if (typeof value === 'string' && value.length > (rule.maxLength ?? 131_072)) {
    throw new ContractError('tool_schema_invalid', 'tool string argument exceeds bound');
  }
  if (Array.isArray(value)) {
    if (value.length > (rule.maxItems ?? 4096)) throw new ContractError('tool_schema_invalid', 'tool array exceeds bound');
    for (const item of value) validateValue(item, rule.items, depth + 1);
  } else if (value && typeof value === 'object') {
    const required = Array.isArray(rule.required) ? rule.required : [];
    if (required.some((key) => !Object.hasOwn(value, key))) throw new ContractError('tool_schema_invalid', 'nested required property is missing');
    if (rule.additionalProperties === false
      && Object.keys(value).some((key) => !Object.hasOwn(rule.properties ?? {}, key))) {
      throw new ContractError('tool_schema_invalid', 'nested tool argument contains an unknown property');
    }
    for (const [key, item] of Object.entries(value)) validateValue(item, rule.properties?.[key], depth + 1);
  }
}
function validateSchema(schema) {
  let encoded;
  try { encoded = JSON.stringify(schema); } catch {
    throw new ContractError('invalid_external_schema', 'external tool schema is not serializable');
  }
  if (Buffer.byteLength(encoded) > 131_072) {
    throw new ContractError('invalid_external_schema', 'external tool schema exceeds bound');
  }
  const stack = [{ value: schema, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop();
    nodes += 1;
    if (nodes > 10_000 || depth > 24) throw new ContractError('invalid_external_schema', 'external schema structure exceeds bound');
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) stack.push({ value: child, depth: depth + 1 });
    }
  }
}
function writeDefinition(paths, changes) {
  return {
    name: 'fs.write_text', version: 1, purpose: 'Atomically write bounded UTF-8 text to one accessible file after reading existing content.',
    sideEffect: 'reversible', scope: 'workspace', cancellation: true, timeoutMs: 10_000,
    inputSchema: objectSchema({
      path: { type: 'string', maxLength: 4096 },
      content: { type: 'string', maxLength: MAX_TEXT_BYTES },
      expected_sha256: { type: ['string', 'null'], pattern: '^[0-9a-f]{64}$' },
    }, ['path', 'content']),
    validate: async (args) => {
      requireShape(args, ['path', 'content'], ['expected_sha256']);
      if (Buffer.byteLength(args.content, 'utf8') > MAX_TEXT_BYTES) {
        throw new ContractError('tool_arguments_too_large', 'write content exceeds bound');
      }
      const resolved = await paths.withRecovery(await paths.resolveWrite(args.path));
      const expected = args.expected_sha256 ?? null;
      if (resolved.exists && !/^[0-9a-f]{64}$/u.test(expected ?? '')) {
        throw new ContractError('expected_hash_required', 'existing file write requires expected_sha256');
      }
      return { args: { path: args.path, content: args.content, expected_sha256: expected }, resolved };
    },
    executor: (request, signal) => atomicWrite(request, signal, {}, changes),
  };
}
function editDefinition(paths, changes, receipts) {
  return {
    name: 'fs.edit_text', version: 1,
    purpose: 'Replace exact text in one existing accessible file without rewriting unrelated content.',
    sideEffect: 'reversible', scope: 'workspace', cancellation: true, timeoutMs: 10_000,
    inputSchema: objectSchema({
      path: { type: 'string', maxLength: 4096 },
      old_text: { type: 'string', minLength: 1, maxLength: MAX_TEXT_BYTES },
      new_text: { type: 'string', maxLength: MAX_TEXT_BYTES },
      replace_all: { type: 'boolean' },
      expected_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    }, ['path', 'old_text', 'new_text', 'expected_sha256']),
    validate: async (args) => validateEdit(paths, args, receipts),
    executor: (request, signal) => executeEdit(request, signal, changes),
  };
}

function editLinesDefinition(paths, changes, receipts) {
  return {
    name: 'fs.edit_lines', version: 1,
    purpose: 'Replace an inclusive line range previously shown by fs.read_lines in the same exact file snapshot.',
    sideEffect: 'reversible', scope: 'workspace', cancellation: true, timeoutMs: 10_000,
    inputSchema: objectSchema({
      path: { type: 'string', maxLength: 4096 },
      start_line: { type: 'integer', minimum: 1, maximum: 10_000_000 },
      end_line: { type: 'integer', minimum: 1, maximum: 10_000_000 },
      replacement: { type: 'string', maxLength: MAX_TEXT_BYTES },
      expected_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    }, ['path', 'start_line', 'end_line', 'replacement', 'expected_sha256']),
    validate: async (args) => {
      requireShape(args, ['path', 'start_line', 'end_line', 'replacement', 'expected_sha256']);
      requireHash(args.expected_sha256);
      if (!Number.isSafeInteger(args.start_line) || !Number.isSafeInteger(args.end_line)
        || args.start_line < 1 || args.end_line < args.start_line || args.end_line - args.start_line >= 400) {
        throw new ContractError('tool_schema_invalid', 'line range must be ordered, positive, and at most 400 lines');
      }
      if (typeof args.replacement !== 'string' || Buffer.byteLength(args.replacement, 'utf8') > MAX_TEXT_BYTES) {
        throw new ContractError('tool_arguments_too_large', 'replacement exceeds the text bound');
      }
      const resolved = await paths.withRecovery(await paths.resolveRead(args.path));
      const content = await readFile(resolved.path, 'utf8');
      const actual = sha256(content);
      const prepared = prepareLineEdit(receipts, resolved.path, args, content, actual);
      if (prepared.endLine > logicalLines(content).length) {
        throw new ContractError('edit_line_out_of_range', 'line range exceeds the file snapshot');
      }
      return {
        args: { ...args, start_line: prepared.startLine, end_line: prepared.endLine, expected_sha256: prepared.expectedSha256 },
        resolved: { ...resolved, staleEditRecovered: prepared.recovered, requestedExpectedSha256: args.expected_sha256 },
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

async function validateEdit(paths, args, receipts) {
  requireShape(args, ['path', 'old_text', 'new_text', 'expected_sha256'], ['replace_all']);
  requireHash(args.expected_sha256);
  if (typeof args.old_text !== 'string' || args.old_text.length === 0
    || typeof args.new_text !== 'string' || (args.replace_all !== undefined && typeof args.replace_all !== 'boolean')) {
    throw new ContractError('tool_schema_invalid', 'text edit arguments are invalid');
  }
  const resolved = await paths.withRecovery(await paths.resolveRead(args.path));
  if (resolved.size > MAX_TEXT_BYTES) throw new ContractError('tool_target_too_large', 'file exceeds edit bound');
  const content = await readFile(resolved.path, 'utf8');
  const actual = sha256(content);
  const prepared = prepareTextEdit(receipts, resolved.path, args, content, actual);
  const updated = replaceText(content, args.old_text, args.new_text, Boolean(args.replace_all));
  if (Buffer.byteLength(updated, 'utf8') > MAX_TEXT_BYTES) {
    throw new ContractError('tool_arguments_too_large', 'edited content exceeds bound');
  }
  return {
    args: {
      path: args.path, old_text: args.old_text, new_text: args.new_text,
      replace_all: Boolean(args.replace_all), expected_sha256: prepared.expectedSha256,
    },
    resolved: { ...resolved, staleEditRecovered: prepared.recovered, requestedExpectedSha256: args.expected_sha256 },
  };
}

async function executeEdit(request, signal, changes) {
  if (signal.aborted) throw new ContractError('tool_cancelled', 'tool was cancelled');
  await verifyExpectedState(request);
  const content = await readFile(request.resolved.path, 'utf8');
  const occurrences = countOccurrences(content, request.args.old_text);
  if (occurrences === 0 || (!request.args.replace_all && occurrences !== 1)) {
    throw new ContractError('tool_revalidation_drift', 'edit match changed after review');
  }
  const updated = replaceText(content, request.args.old_text, request.args.new_text, request.args.replace_all);
  return atomicWrite({ ...request, args: { ...request.args, content: updated } }, signal, {
    message: 'edit completed', replacements: request.args.replace_all ? occurrences : 1,
  }, changes);
}

function deleteDefinition(paths, changes) {
  return {
    name: 'fs.delete_file', version: 1,
    purpose: 'Permanently delete one accessible regular file after exact-content revalidation and mandatory review.',
    sideEffect: 'irreversible', scope: 'workspace', cancellation: true, timeoutMs: 10_000,
    inputSchema: objectSchema({
      path: { type: 'string', maxLength: 4096 },
      expected_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    }, ['path', 'expected_sha256']),
    validate: async (args) => {
      requireShape(args, ['path', 'expected_sha256']);
      requireHash(args.expected_sha256);
      const resolved = await paths.withRecovery(await paths.resolveRead(args.path));
      const content = await readFile(resolved.path);
      requireExpectedContent(content, args.expected_sha256);
      return { args: { path: args.path, expected_sha256: args.expected_sha256 }, resolved };
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
function requireHash(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new ContractError('expected_hash_required', 'operation requires a lowercase expected_sha256');
  }
}
function requireExpectedContent(content, expected) {
  if (sha256(content) !== expected) {
    throw new ContractError('tool_revalidation_drift', 'target does not match expected_sha256');
  }
}
function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function logicalLines(content) {
  const lines = content.split(/\r?\n/u);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines.length > 0 ? lines : [''];
}

function replaceLineRange(content, startLine, endLine, replacement) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const trailing = content.endsWith('\n');
  const lines = logicalLines(content);
  const inserted = replacement.length === 0 ? [] : replacement.replace(/\r\n/gu, '\n').split('\n');
  if (inserted.at(-1) === '') inserted.pop();
  lines.splice(startLine - 1, endLine - startLine + 1, ...inserted);
  const result = lines.join(newline);
  return trailing && result.length > 0 ? `${result}${newline}` : result;
}
function countOccurrences(content, search) {
  let count = 0; let offset = 0;
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count += 1;
    offset += search.length;
  }
  return count;
}
function replaceText(content, oldText, newText, replaceAll) { return replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText); }
function requireShape(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError('tool_schema_invalid', 'tool arguments must be an object');
  }
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ContractError('tool_schema_invalid', 'tool arguments do not match the schema');
  }
  if (typeof value.path !== 'string' || (Object.hasOwn(value, 'content') && typeof value.content !== 'string')) {
    throw new ContractError('tool_schema_invalid', 'tool argument types are invalid');
  }
}
function objectSchema(properties, required) { return { type: 'object', properties, required, additionalProperties: false }; }
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}
