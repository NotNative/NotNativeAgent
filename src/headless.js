// SPDX-License-Identifier: Apache-2.0
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveManifest } from './config.js';
import { parseProtocolLine, PROTOCOL_VERSION, safeError } from './contracts.js';
import { SessionEngine } from './engine.js';
import { CanonicalIngress } from './ingress.js';
import { ContractError, newId, requireExternalId } from './ids.js';
import { userDataPaths } from './product.js';
import { applyLaunchProviderOverrides } from './provider/launch-overrides.js';
import { manifestFromConfig } from './provider/route-configuration.js';
import { StructuredLog } from './structured-log.js';

export async function runHeadless(input, output, diagnostics, options = {}) {
  const writer = new ProtocolWriter(output, options.outputLimits);
  const logger = await initializeLogger(options, diagnostics);
  let engine = null;
  let ingress = null;
  let cleanShutdown = false;
  let activeRequestId = null;
  const owned = new Set();
  try {
    for await (const line of interruptibleLines(input, writer, options.maxLineBytes ?? 262_144)) {
      if (line.trim().length === 0) continue;
      activeRequestId = null;
      const command = parseProtocolLine(line);
      activeRequestId = command.request_id;
      if (!engine) {
        const initialized = await initialize(command, writer, logger, options);
        engine = initialized.engine;
        ingress = initialized.ingress;
        continue;
      }
      if (command.type === 'initialize') throw new ContractError('already_initialized', 'runtime is already initialized');
      if (command.type === 'submit' || command.type === 'attachment_retry') {
        if (owned.size >= (options.maxOutstandingRequests ?? 64)) {
          await writeObserved(writer, logger, {
            version: '1.0', type: 'error', request_id: command.request_id,
            ...safeError(new ContractError('request_queue_full', 'headless request queue is full'), command.type),
          }, engine.sessionId);
          continue;
        }
        const task = dispatch(command, ingress, engine, writer, logger)
          .catch(() => null).finally(() => owned.delete(task));
        owned.add(task);
        continue;
      }
      await dispatch(command, ingress, engine, writer, logger);
      if (command.type === 'shutdown') {
        cleanShutdown = true;
        break;
      }
    }
  } catch (error) {
    if (!writer.failed) {
      await writeObserved(writer, logger, {
        version: '1.0', type: 'error',
        ...(activeRequestId ? { request_id: activeRequestId } : {}),
        ...safeError(error, 'headless_protocol'),
      }, engine?.sessionId);
    }
    diagnostics.write(`nna: ${safeError(error, 'headless_protocol').code}\n`);
    process.exitCode = 4;
  } finally {
    if (engine && !cleanShutdown && engine.state.state !== 'shutting_down') {
      await engine.shutdown({ request_id: newId('disconnect'), type: 'shutdown' }).catch(() => undefined);
    }
    await Promise.allSettled([...owned]);
    await writer.close().catch(() => undefined);
    await logger?.flush().catch(() => undefined);
  }
}

async function initialize(command, writer, logger, options) {
  if (command.type !== 'initialize') {
    throw new ContractError('initialization_required', 'initialize must be the first command');
  }
  const selectedProfile = selectRequestedProfile([
    command.manifest.provider_profile_id, command.provider_profile_id,
    command.provider_profile, options.providerProfile,
  ]);
  const manifest = selectedProfile
    ? await manifestWithSelectedProvider(command.manifest, selectedProfile, options)
    : withoutProviderSelector(command.manifest);
  const config = resolveManifest(manifest, {
    missionPrincipal: 'authenticated-stdio-host', principal: 'authenticated-stdio-host',
    executionManifestId: command.execution_manifest_id ?? command.request_id,
    hostOrigin: command.host_origin ?? 'stdio-parent', hostIdentity: command.host_identity,
  });
  const paths = userDataPaths();
  const sessionId = command.session_id ? requireExternalId(command.session_id, 'session_id') : newId('session');
  const storeRoot = options.storeRoot ?? paths.sessions;
  if (command.require_existing_session === true) {
    if (!command.session_id) throw new ContractError('session_id_required', 'resuming a session requires session_id');
    try { await access(join(storeRoot, `${sessionId}.journal.ndjson`)); }
    catch (error) {
      if (error?.code === 'ENOENT') throw new ContractError('session_missing', 'the requested durable session was not found');
      throw error;
    }
  }
  const engine = new SessionEngine({
    config, sessionId, storeRoot,
    providerFactory: options.providerFactory, semanticReviewer: options.semanticReviewer,
    semanticReviewTimeoutMs: options.semanticReviewTimeoutMs,
    reviewerRoot: options.reviewerRoot ?? paths.reviewerLedger, memoryAdapter: options.memoryAdapter,
    mcpTransportFactory: options.mcpTransportFactory, attachmentRoot: options.attachmentRoot,
    hookRoot: options.hookRoot, hookRunner: options.hookRunner,
    webSearchConfigPath: options.webSearchConfigPath, webSearchClient: options.webSearchClient,
    output: (record) => writeObserved(writer, logger, record, sessionId),
  });
  await engine.initialize();
  const ingress = new CanonicalIngress(engine);
  await writeObserved(writer, logger, initializedFrame(command, engine, config), sessionId);
  return { engine, ingress };
}

function initializedFrame(command, engine, config) {
  const route = config.routes.primary;
  const profile = config.providerProfiles[route.providerId];
  return {
    version: '1.0', type: 'initialized', request_id: command.request_id,
    runtime_id: engine.runtimeId, session_id: engine.sessionId,
    status: 'ready', provider_profile: profile.displayName,
    provider_profile_id: profile.id, endpoint: profile.endpoint, model: route.model,
    provider: {
      profile_id: profile.id, display_name: profile.displayName,
      endpoint: profile.endpoint, model: route.model,
    },
    protocol: PROTOCOL_VERSION, capabilities: {
      streaming: true,
      tools: config.executionManifest.allowedCapabilities.includes('tools'),
      steering: config.executionManifest.allowedCapabilities.includes('steering'),
      attachments: config.attachments.enabled, memory: config.memory.enabled,
      mcp: config.mcpServers.some((item) => item.enabled),
      skills: config.skills.length > 0,
    },
    tools: engine.tools.snapshot().map((item) => item.name).sort(),
    skills: engine.skills.catalog(),
    limits: config.limits, persistence: config.persistence,
    execution_manifest: config.executionManifest, mission: config.mission,
    recovered_interruptions: engine.recoveryNotices,
  };
}

function selectRequestedProfile(candidates) {
  const selected = candidates.filter(Boolean);
  if (new Set(selected).size > 1) {
    throw new ContractError('provider_profile_conflict', 'initialize provider profile selection conflicts with the launch -provider selection');
  }
  return selected[0] ?? null;
}

async function manifestWithSelectedProvider(hostManifest, selector, options) {
  const operatorConfig = options.operatorConfig ?? await options.loadOperatorConfig?.();
  if (!operatorConfig) {
    throw new ContractError('provider_configuration_unavailable', 'saved NNA provider profiles are unavailable to this host');
  }
  const selected = applyLaunchProviderOverrides(operatorConfig, { providerProfile: selector });
  const routing = manifestFromConfig(selected);
  const manifest = withoutProviderSelector(hostManifest);
  delete manifest.provider;
  manifest.providers = routing.providers;
  manifest.routes = routing.routes;
  return manifest;
}

function withoutProviderSelector(hostManifest) {
  const manifest = structuredClone(hostManifest);
  delete manifest.provider_profile_id;
  return manifest;
}

async function dispatch(command, ingress, engine, writer, logger) {
  try {
    const result = await ingress.submit(command, 'authenticated-stdio-host');
    if (result.duplicate) await writeObserved(writer, logger, duplicateAck(command, engine), engine.sessionId);
    else if (command.type === 'cancel') {
      await writeObserved(writer, logger, {
        version: '1.0', type: 'accepted', request_id: command.request_id,
        accepted: result.accepted, command_type: 'cancel', turn_id: result.turn_id ?? null,
      }, engine.sessionId);
    }
    return result;
  } catch (error) {
    await writeObserved(writer, logger, {
      version: '1.0', type: 'error', ...safeError(error, command.type),
    }, engine.sessionId);
    return null;
  }
}

async function initializeLogger(options, diagnostics) {
  if (!options.logger && !options.logPath) return null;
  const logger = options.logger ?? new StructuredLog({ path: options.logPath });
  try { return await logger.initialize(); }
  catch {
    diagnostics.write('nna: structured_log_unavailable\n');
    return null;
  }
}

async function writeObserved(writer, logger, record, sessionId = null) {
  logger?.record(record, { sessionId });
  await writer.write(record);
}

export class ProtocolWriter {
  #tail = Promise.resolve();
  #pendingBytes = 0;
  #failure = null;
  #rejectFailure;

  constructor(stream, limits = {}) {
    this.stream = stream;
    this.maxQueuedBytes = limits?.maxQueuedBytes ?? 4_194_304;
    this.maxLineBytes = limits?.maxLineBytes ?? 2_359_296;
    this.failure = new Promise((_resolve, reject) => { this.#rejectFailure = reject; });
    this.failure.catch(() => undefined);
    stream.on('error', (error) => this.#fail(error));
  }

  write(value) {
    const line = `${JSON.stringify(value)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > this.maxLineBytes) return Promise.reject(outputError('output_line_too_large'));
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#pendingBytes + bytes > this.maxQueuedBytes) {
      return this.#tail.then(() => this.write(value));
    }
    this.#pendingBytes += bytes;
    const operation = this.#tail.then(() => this.#send(line))
      .finally(() => { this.#pendingBytes -= bytes; });
    this.#tail = operation;
    return operation;
  }

  async close() {
    await this.#tail;
  }

  get failed() { return this.#failure; }

  get pendingBytes() { return this.#pendingBytes; }

  async #send(line) {
    if (this.#failure) throw this.#failure;
    try {
      if (!this.stream.write(line, 'utf8')) await once(this.stream, 'drain');
    } catch {
      throw this.#failure ?? outputError('output_stream_failed');
    }
  }

  #fail(error) {
    if (this.#failure) return;
    this.#failure = outputError(error?.code === 'EPIPE' ? 'output_broken_pipe' : 'output_stream_failed');
    this.#rejectFailure(this.#failure);
  }
}

async function* interruptibleLines(stream, writer, maxBytes) {
  const iterator = boundedLines(stream, maxBytes)[Symbol.asyncIterator]();
  while (true) {
    const next = await Promise.race([iterator.next(), writer.failure]);
    if (next.done) return;
    yield next.value;
  }
}

function outputError(code) {
  return new ContractError(code, code === 'output_broken_pipe'
    ? 'headless output host disconnected' : 'headless output boundary failed');
}

async function* boundedLines(stream, maxBytes) {
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    if (pending.length > maxBytes && pending.indexOf(0x0a) < 0) {
      throw new ContractError('line_too_large', `input exceeds ${maxBytes} bytes`);
    }
    let newline = pending.indexOf(0x0a);
    while (newline >= 0) {
      const line = pending.subarray(0, newline);
      if (line.length > maxBytes) throw new ContractError('line_too_large', `input exceeds ${maxBytes} bytes`);
      yield new TextDecoder('utf-8', { fatal: true }).decode(line).replace(/\r$/u, '');
      pending = pending.subarray(newline + 1);
      newline = pending.indexOf(0x0a);
    }
  }
  if (pending.length > 0) yield new TextDecoder('utf-8', { fatal: true }).decode(pending);
}

function duplicateAck(command, engine) {
  return {
    version: '1.0', type: 'accepted', request_id: command.request_id,
    accepted: false, duplicate: true, session_id: engine.sessionId,
  };
}
