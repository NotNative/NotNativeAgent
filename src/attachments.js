// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ContractError, newId } from './ids.js';
import { CapabilityCache } from './capability-cache.js';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

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
      if (result.state === 'admitted') admitted.push(result);
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
        catch (error) { await this.#recordCleanupFailure(item, error, true); }
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
  constructor(router, cache = new CapabilityCache()) {
    this.router = router;
    this.cache = cache;
  }

  async observe(item, prompt, signal) {
    const logicalRequestId = newId('vision_request');
    const attempts = [];
    const primary = this.router.resolve('primary');
    try {
      // Always let the active primary model see the image first. Capability
      // declarations and prior observations are advisory only: local hosts can
      // change a model or chat template without changing the saved profile.
      // Vision is a request-scoped fallback after an explicit provider reject.
      const result = await observeWith(this.router, primary, 'primary', item, prompt, signal);
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
      const vision = this.router.resolve('vision');
      if (sameRoute(primary, vision)) {
        throw annotateRouteError(
          new ContractError('no_eligible_vision_route', 'no eligible vision route is configured'),
          logicalRequestId, attempts,
        );
      }
      try {
        const result = await observeWith(this.router, vision, 'vision', item, prompt, signal);
        this.cache.record(vision, 'image_input', this.router.config.version, true);
        attempts.push(attemptFact(vision, 'consumed'));
        return { ...result, logicalRequestId, attempts };
      } catch (visionError) {
        attempts.push(attemptFact(vision, visionError.code ?? 'failed'));
        throw annotateRouteError(visionError, logicalRequestId, attempts);
      }
    }
  }
}

async function observeWith(router, resolution, role, item, prompt, signal) {
  if (signal?.aborted) throw new ContractError('attachment_cancelled', 'attachment admission was cancelled', true);
  const bytes = await readFile(item.managedPath);
  if (signal?.aborted) throw new ContractError('attachment_cancelled', 'attachment admission was cancelled', true);
  const request = {
    model: resolution.model, temperature: 0,
    messages: [{ role: 'user', content: [
      { type: 'text', text: `Observe this image for the primary agent. User context: ${prompt.slice(0, 4096)}` },
      { type: 'image_url', image_url: { url: `data:${item.mimeType};base64,${bytes.toString('base64')}` } },
    ] }],
    tools: [],
  };
  let text = '';
  const deadline = AbortSignal.timeout(resolution.deadlineMs);
  const parentSignal = signal ?? new AbortController().signal;
  const boundedSignal = AbortSignal.any([parentSignal, deadline]);
  const iterator = router.provider(resolution).stream(request, boundedSignal)[Symbol.asyncIterator]();
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
      const event = next.value;
      if (event.type === 'text') text += event.text;
    }
  } catch (error) {
    if (deadline.aborted && !parentSignal.aborted) {
      throw new ContractError('attachment_route_timeout', 'attachment route exceeded its deadline', true);
    }
    throw error;
  } finally {
    boundedSignal.removeEventListener('abort', abortHandler);
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
  if (boundedSignal.aborted) {
    if (deadline.aborted && !parentSignal.aborted) {
      throw new ContractError('attachment_route_timeout', 'attachment route exceeded its deadline', true);
    }
    throw new ContractError('attachment_cancelled', 'attachment admission was cancelled', true);
  }
  if (text.trim().length === 0) throw new ContractError('attachment_empty_observation', 'vision route returned no observation', true);
  return { text: text.slice(0, 131_072), route: role };
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
