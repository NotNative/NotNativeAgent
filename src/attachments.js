// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ContractError, newId } from './ids.js';
import { routeReasoningFields } from './provider/reasoning.js';
import { CapabilityCache } from './capability-cache.js';
import { reachedOutputCeiling } from './reliability/output-headroom.js';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_OBSERVATION_BYTES = 131_072;
const MAX_OBSERVATION_EVENTS = 65_536;
const OBSERVATION_OUTPUT_TOKENS = 8192;

export class AttachmentManager {
  #items = new Map();

  constructor(options) {
    this.config = options.config;
    this.root = options.root;
    this.router = options.router;
    this.persist = options.persist;
    this.status = options.status ?? (async () => undefined);
    this.removeFile = options.removeFile ?? unlink;
    this.cleanupOnClose = options.cleanupOnClose === true;
  }

  async prepare(inputs, prompt, signal) {
    if (!this.config.enabled) throw new ContractError('attachments_disabled', 'attachments are disabled');
    const staged = [];
    try {
      for (const input of inputs) staged.push(await this.#stage(input));
    } catch (error) {
      await Promise.allSettled(staged.map((item) => this.remove(item.id)));
      throw error;
    }
    const admitted = [];
    const failures = [];
    for (const item of staged) {
      const result = await this.#admit(item, prompt, signal);
      if (result.admittedAt) admitted.push(result);
      else failures.push(result);
    }
    return Object.freeze({ admitted: Object.freeze(admitted), failures: Object.freeze(failures) });
  }

  async retry(id, prompt, signal) {
    const item = this.#items.get(id);
    if (!item || item.state !== 'pending_failed') {
      throw new ContractError('attachment_retry_invalid', 'only a pending-failed attachment may be retried');
    }
    return this.#admit(item, prompt, signal);
  }

  restore(records) {
    for (const record of records) {
      if (record.type === 'attachment_fact' && record.payload?.id) {
        this.#items.set(record.payload.id, Object.freeze(record.payload));
      }
    }
  }

  async remove(id) {
    const item = this.#items.get(id);
    if (!item || ['removed', 'rejected'].includes(item.state)) return false;
    try { await this.#removeManaged(item.managedPath); }
    catch (error) {
      const fact = freezeFact({
        ...item, state: 'cleanup_failed', reason: 'attachment_cleanup_failed',
        guidance: 'The managed image could not be removed. Resolve the filesystem error, then retry removal.',
        cleanupError: error.code ?? 'filesystem_error', decidedAt: new Date().toISOString(),
      });
      this.#items.set(id, fact);
      await this.persist('attachment_fact', fact);
      await this.status(fact);
      throw new ContractError('attachment_cleanup_failed', 'managed attachment removal could not be verified', true);
    }
    const fact = freezeFact({ ...item, state: 'removed', removedAt: new Date().toISOString() });
    this.#items.set(id, fact);
    await this.persist('attachment_fact', fact);
    await this.status(fact);
    return true;
  }

  async close() {
    if (!this.cleanupOnClose) return;
    await Promise.allSettled([...this.#items.values()]
      .filter((item) => ['staged', 'pending_failed'].includes(item.state))
      .map((item) => unlink(item.managedPath)));
  }

  async #stage(input) {
    validateInput(input);
    const source = await stat(input.path);
    if (!source.isFile() || source.size > this.config.maxBytes) {
      throw new ContractError('attachment_size_invalid', 'attachment is not a bounded regular file');
    }
    const bytes = await readFile(input.path);
    if (bytes.length !== source.size || bytes.length > this.config.maxBytes) {
      throw new ContractError('attachment_source_changed', 'attachment changed during staging');
    }
    verifyMagic(bytes, input.mime_type);
    const id = newId('attachment');
    const directory = join(this.root, id);
    const managedPath = join(directory, basename(input.path));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(managedPath, bytes, { flag: 'wx', mode: 0o600 });
    const fact = freezeFact({
      type: 'attachment_fact', id, state: 'staged', mimeType: input.mime_type, sourceName: basename(input.path),
      size: source.size, sha256: createHash('sha256').update(bytes).digest('hex'),
      managedPath, createdAt: new Date().toISOString(),
    });
    await this.persist('attachment_fact', fact);
    this.#items.set(id, fact);
    await this.status(fact);
    return fact;
  }

  async #admit(item, prompt, signal) {
    try {
      const observation = await this.router.observe(item, prompt, signal);
      const fact = freezeFact({
        ...item, state: 'admitted', observation: observation.text,
        route: observation.route, logicalRequestId: observation.logicalRequestId,
        attempts: observation.attempts, admittedAt: new Date().toISOString(),
      });
      await this.persist('attachment_fact', fact);
      this.#items.set(item.id, fact);
      await this.status(fact);
      if (!this.config.retain) {
        try { await this.#removeManaged(item.managedPath); }
        catch (error) { return this.#recordCleanupFailure(fact, error, true); }
      }
      return fact;
    } catch (error) {
      const temporary = error.retryable === true;
      const state = temporary ? 'pending_failed' : 'rejected';
      let cleanupError = null;
      if (!temporary) {
        try { await this.#removeManaged(item.managedPath); }
        catch (failure) { cleanupError = failure; }
      }
      const unresolvedCleanup = cleanupError !== null;
      const fact = freezeFact({
        ...item, state: unresolvedCleanup ? 'cleanup_failed' : state,
        reason: unresolvedCleanup ? 'attachment_cleanup_failed' : error.code ?? 'attachment_admission_failed',
        logicalRequestId: error.logicalRequestId ?? null,
        attempts: error.routeAttempts ?? [],
        guidance: unresolvedCleanup
          ? 'The image was not analyzed, and its managed copy could not be removed. Resolve the filesystem error, then retry removal.'
          : attachmentGuidance(error, temporary),
        cleanupError: cleanupError?.code ?? null,
        decidedAt: new Date().toISOString(),
      });
      await this.persist('attachment_fact', fact);
      this.#items.set(item.id, fact);
      await this.status(fact);
      return fact;
    }
  }

  async #recordCleanupFailure(item, error, analyzed) {
    const fact = freezeFact({
      ...item, state: 'cleanup_failed', reason: 'attachment_cleanup_failed',
      guidance: `The image was ${analyzed ? '' : 'not '}analyzed, but its managed copy could not be removed. Resolve the filesystem error, then retry removal.`,
      cleanupError: error.code ?? 'filesystem_error', decidedAt: new Date().toISOString(),
    });
    this.#items.set(item.id, fact);
    await this.persist('attachment_fact', fact);
    await this.status(fact);
    return fact;
  }

  async #removeManaged(path) {
    try { await this.removeFile(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function attachmentGuidance(error, temporary) {
  if (temporary) return 'The image was not analyzed. Retry this attachment or remove it.';
  if (error.code === 'no_eligible_vision_route') {
    return 'The image was removed and not analyzed. Configure an image-capable primary or vision route, then reattach it.';
  }
  return 'The image was removed and not analyzed. Correct the reported configuration or image problem, then reattach it.';
}

export class AttachmentObservationRouter {
  constructor(router, cache = new CapabilityCache(), options = {}) {
    this.router = router;
    this.cache = cache;
    this.recordTokenReceipt = options.recordTokenReceipt;
  }

  async observe(item, prompt, signal) {
    const logicalRequestId = newId('vision_request');
    const attempts = [];
    const primary = this.router.resolve('primary');
    const vision = this.router.resolve('vision');
    if (!sameRoute(primary, vision)) {
      try {
        const result = await observeWith(this.router, vision, 'vision', item, prompt, signal, this.recordTokenReceipt);
        this.cache.record(vision, 'image_input', this.router.config.version, true);
        attempts.push(attemptFact(vision, 'consumed'));
        return { ...result, logicalRequestId, attempts };
      } catch (error) {
        this.cache.record(vision, 'image_input', this.router.config.version, false);
        attempts.push(attemptFact(vision, error.code ?? 'failed'));
        throw annotateRouteError(error, logicalRequestId, attempts);
      }
    }
    try {
      const result = await observeWith(this.router, primary, 'primary', item, prompt, signal, this.recordTokenReceipt);
      this.cache.record(primary, 'image_input', this.router.config.version, true);
      attempts.push(attemptFact(primary, 'consumed'));
      return { ...result, logicalRequestId, attempts };
    } catch (error) {
      if (error.code !== 'provider_image_unsupported') {
        attempts.push(attemptFact(primary, error.code ?? 'failed'));
        throw annotateRouteError(error, logicalRequestId, attempts);
      }
      this.cache.record(primary, 'image_input', this.router.config.version, false);
      attempts.push(attemptFact(primary, 'unsupported'));
      throw annotateRouteError(
        new ContractError('no_eligible_vision_route', 'no distinct eligible vision route is configured'),
        logicalRequestId, attempts,
      );
    }
  }
}

async function observeWith(router, resolution, role, item, prompt, signal, recordTokenReceipt) {
  if (signal?.aborted) throw new ContractError('attachment_cancelled', 'attachment admission was cancelled', true);
  const bytes = await readFile(item.managedPath);
  if (signal?.aborted) throw new ContractError('attachment_cancelled', 'attachment admission was cancelled', true);
  const request = {
    model: resolution.model, temperature: 0,
    maxOutputTokens: Math.min(OBSERVATION_OUTPUT_TOKENS, resolution.maxOutputTokens ?? OBSERVATION_OUTPUT_TOKENS),
    ...routeReasoningFields(resolution),
    messages: [{ role: 'user', content: [
      { type: 'text', text: `Observe this image for the primary agent. User context: ${prompt.slice(0, 4096)}` },
      { type: 'image_url', image_url: { url: `data:${item.mimeType};base64,${bytes.toString('base64')}` } },
    ] }],
    tools: [],
  };
  const accounting = { usage: null, outputBytes: 0, outcome: 'failed', reasonCode: null };
  const attemptId = newId('vision_attempt');
  const started = process.hrtime.bigint();
  try {
    const text = await collectObservation(router.provider(resolution), request, signal, resolution, accounting);
    accounting.outcome = 'completed';
    return { text, route: role };
  } catch (error) {
    accounting.outcome = signal?.aborted ? 'cancelled' : 'failed';
    accounting.reasonCode = error?.code ?? 'attachment_observation_failed';
    throw error;
  } finally {
    await recordTokenReceipt?.({
      request, context: request.messages, route: resolution, role: `vision_${role}`, attemptId,
      outcome: accounting.outcome, reasonCode: accounting.reasonCode,
      usage: accounting.usage, outputBytes: accounting.outputBytes,
      durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    });
  }
}

async function collectObservation(provider, request, signal, resolution, accounting) {
  const collected = { text: '', events: 0, outputLimitTokens: request.maxOutputTokens };
  const parentSignal = signal ?? new AbortController().signal;
  const deadline = resolution.deadlineMs == null ? null : AbortSignal.timeout(resolution.deadlineMs);
  const controller = new AbortController();
  const boundedSignal = AbortSignal.any([parentSignal, controller.signal, ...(deadline ? [deadline] : [])]);
  const iterator = provider.stream(request, boundedSignal)[Symbol.asyncIterator]();
  let abortHandler;
  const aborted = new Promise((_, reject) => {
    abortHandler = () => reject(new ContractError('attachment_cancelled', 'attachment admission was cancelled', true));
    if (boundedSignal.aborted) abortHandler();
    else boundedSignal.addEventListener('abort', abortHandler, { once: true });
  });
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) break;
      appendObservation(next.value, collected, accounting);
    }
  } catch (error) {
    if (deadline?.aborted && !parentSignal.aborted) {
      throw new ContractError('attachment_route_timeout', 'attachment route exceeded its deadline', true);
    }
    throw error;
  } finally {
    boundedSignal.removeEventListener('abort', abortHandler);
    controller.abort();
    // Iterator cleanup cannot replace the admission outcome.
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
  if (parentSignal.aborted || deadline?.aborted) {
    if (deadline?.aborted && !parentSignal.aborted) {
      throw new ContractError('attachment_route_timeout', 'attachment route exceeded its deadline', true);
    }
    throw new ContractError('attachment_cancelled', 'attachment admission was cancelled', true);
  }
  if (collected.text.trim().length === 0) throw new ContractError('attachment_empty_observation', 'vision route returned no observation', true);
  return collected.text;
}

function appendObservation(event, collected, accounting) {
  collected.events += 1;
  if (event.type === 'text' || event.type === 'reasoning') {
    accounting.outputBytes += Buffer.byteLength(event.text ?? '', 'utf8');
  }
  // Invariant: bound output before appending; a partial description is not admitted as complete evidence.
  if (accounting.outputBytes > MAX_OBSERVATION_BYTES || collected.events > MAX_OBSERVATION_EVENTS) {
    throw new ContractError('attachment_observation_too_large', 'vision output exceeded its byte or event limit');
  }
  if (event.type === 'terminal' && reachedOutputCeiling({
    finishReason: event.finishReason, usage: event.usage ?? accounting.usage, outputLimitTokens: collected.outputLimitTokens,
  })) {
    throw new ContractError('attachment_observation_truncated', 'vision output stopped before the observation completed');
  }
  if (event.type === 'text') collected.text += event.text;
  else if (event.type === 'usage') accounting.usage = event.usage;
}

function attemptFact(resolution, outcome) {
  return Object.freeze({
    id: newId('vision_attempt'), providerId: resolution.profile.id,
    model: resolution.model, outcome,
  });
}

function annotateRouteError(error, logicalRequestId, attempts) {
  error.logicalRequestId = logicalRequestId;
  error.routeAttempts = Object.freeze([...attempts]);
  return error;
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || typeof input.path !== 'string'
    || !IMAGE_TYPES.has(input.mime_type)) {
    throw new ContractError('attachment_invalid', 'attachment requires a supported image path and MIME type');
  }
}

function verifyMagic(bytes, mime) {
  const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : mime === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8
      : mime === 'image/gif' ? bytes.subarray(0, 3).toString() === 'GIF'
        : bytes.subarray(8, 12).toString() === 'WEBP';
  if (!valid) throw new ContractError('attachment_integrity_invalid', 'attachment bytes do not match declared MIME type');
}

function sameRoute(left, right) {
  return left.profile.id === right.profile.id && left.model === right.model;
}

function freezeFact(value) {
  return Object.freeze(value);
}
