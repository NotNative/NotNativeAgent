// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { FairScheduler } from './fair-scheduler.js';

const ITERATOR_CLOSE_TIMEOUT_MS = 25;

export class ProviderRunner {
  constructor(options) {
    this.state = options.state;
    this.lifecycles = options.lifecycles;
    this.telemetry = options.telemetry;
    this.dialects = options.dialects;
    this.reliability = options.reliability;
    this.publish = options.publish;
    this.acceptText = options.acceptText;
    this.status = options.status;
    this.settleAttempt = options.settleAttempt;
    this.recordRecovery = options.recordRecovery;
    this.scheduler = options.scheduler;
    this.queueStatus = options.queueStatus;
    this.runtimeResolver = options.runtimeResolver;
    this.prepareRequest = options.prepareRequest;
    this.verifyRequest = options.verifyRequest;
    this.recordTokenReceipt = options.recordTokenReceipt;
    this.scheduler ??= new FairScheduler();
    this.queueStatus ??= () => undefined;
  }

  async run(provider, request, deadlines, active, manifest = null, route = null) {
    // The owning engine sets active.cancelled when its turn controller accepts cancellation.
    const localLimit = this.reliability?.localRetryLimit(active) ?? active.recovery.localLimit;
    for (let attempt = 0; attempt < localLimit; attempt += 1) {
      const lifecycle = this.lifecycles.start('provider_attempt', active.stepId);
      active.attemptId = lifecycle.id;
      const attemptId = lifecycle.id;
      this.state.transition('invoking_model', { trigger: 'provider_attempt', turnId: active.turnId });
      await this.publish('provider_attempt.started', 'provider_attempt', 'active', active);
      const release = await this.scheduler.acquire(
        active.providerResource, active.sessionId, active.controller.signal,
        (position) => this.queueStatus(active, position),
        active.runtimeModel?.parallelCapacity ?? null,
      );
      let retryDelay = null;
      let attemptOutcome = 'failed';
      let attemptReason = null;
      const requestSpan = `provider-request:${active.attemptId}`;
      const requestStarted = process.hrtime.bigint();
      initializeAttempt(active);
      try {
        await this.verifyRequest?.(request, manifest, route, active);
        this.telemetry?.record('provider.request', 'started', {
          request, model: active.modelName, provider_profile: active.providerResource,
        }, providerCorrelation(active, requestSpan));
        const attemptUsage = await this.#invoke(provider, request, deadlines, active);
        this.#accountAttemptUsage(active);
        this.#observeCacheUsage(active, attemptUsage);
        this.#recordSucceeded(active, requestSpan, requestStarted);
        attemptOutcome = 'completed';
        return;
      } catch (error) {
        this.#accountAttemptUsage(active);
        attemptOutcome = active.cancelled ? 'cancelled' : 'failed';
        attemptReason = error?.code ?? 'provider_failed';
        this.#recordFailed(active, error, requestSpan, requestStarted);
        const partial = active.stepText.length > 0 || active.toolAssembler.size > 0;
        const plan = error.retryable
          ? (this.reliability?.providerRetry(active, error.code, attempt, partial, error.retryAfterMs)
            ?? active.recovery.providerRetry(error.code, attempt, partial, error.retryAfterMs))
          : { retry: false };
        if (!plan.retry || active.cancelled) throw error;
        await this.settleAttempt(active, 'failed');
        this.state.transition('recovering', { trigger: error.code, turnId: active.turnId });
        await this.recordRecovery(plan.action, active);
        retryDelay = plan.delayMs;
      } finally {
        try { await this.#recordAttemptReceipt(manifest, active, {
          outcome: attemptOutcome, reasonCode: attemptReason, attemptId,
          usage: active.attemptUsage, outputBytes: active.attemptOutputBytes,
          durationMs: elapsedMs(requestStarted),
        }); } finally { release(); }
      }
      await cancellableDelay(retryDelay, active.controller.signal);
    }
  }

  #observeCacheUsage(active, usage) {
    this.reliability?.observeProviderUsage?.({
      providerProfile: active.providerResource, model: active.modelName,
    }, usage);
  }

  #accountAttemptUsage(active) {
    if (active.attemptUsageAccounted) return;
    active.usage = mergeUsage(active.usage, active.attemptUsage);
    active.attemptUsageAccounted = true;
  }

  #recordSucceeded(active, requestSpan, requestStarted) {
    this.telemetry?.record('provider.request', 'succeeded', {
      model: active.modelName, provider_profile: active.providerResource,
      finish_reason: active.finishReason, usage: active.usage,
      response_text: active.stepText, reasoning_bytes: active.reasoningBytes,
      step_reasoning_bytes: active.stepReasoningBytes,
    }, { ...providerCorrelation(active, requestSpan), durationMs: elapsedMs(requestStarted), outcome: 'completed' });
    this.dialects?.observe({ profile: { id: active.providerResource }, model: active.modelName }, { status: 'succeeded' });
  }

  #recordFailed(active, error, requestSpan, requestStarted) {
    this.telemetry?.record('provider.request', active.cancelled ? 'cancelled' : 'failed', {
      model: active.modelName, provider_profile: active.providerResource,
      finish_reason: active.finishReason, usage: active.usage,
      partial_response_text: active.stepText, reasoning_bytes: active.reasoningBytes,
      step_reasoning_bytes: active.stepReasoningBytes,
      failure: { code: error?.code ?? 'provider_failed', retryable: error?.retryable === true },
    }, { ...providerCorrelation(active, requestSpan), durationMs: elapsedMs(requestStarted), reasonCode: error?.code });
    this.dialects?.observe(
      { profile: { id: active.providerResource }, model: active.modelName },
      { status: active.cancelled ? 'cancelled' : 'failed', code: error?.code ?? 'provider_failed' },
    );
  }

  async #recordAttemptReceipt(manifest, active, detail) {
    if (active.providerDispatched) await this.recordTokenReceipt?.(manifest, active, detail);
  }

  async runRoutes(router, candidates, requestFactory, deadlines, active, context = []) {
    const bounded = candidates.slice(0, candidates[0]?.budget ?? candidates.length);
    let lastError;
    for (const [index, route] of bounded.entries()) {
      if (!route || !route.profile?.id || typeof route.model !== 'string') {
        throw new ContractError('provider_route_invalid', 'provider routing produced an invalid candidate');
      }
      active.logicalRequestId = route.logicalRequestId;
      active.modelName = route.model;
      active.providerResource = route.profile.id;
      if (this.runtimeResolver) active.runtimeModel = await this.runtimeResolver(route, active.controller.signal);
      try {
        const request = requestFactory(route);
        const manifest = await this.prepareRequest?.(request, route, active, context) ?? null;
        await this.run(router.provider(route), request, { ...deadlines, overallMs: route.deadlineMs }, active, manifest, route);
        return route;
      } catch (error) {
        lastError = error;
        const partial = active.stepText.length > 0 || active.toolAssembler.size > 0;
        if (index === bounded.length - 1 || partial || !fallbackEligible(error)) throw error;
        await this.settleAttempt(active, 'failed');
        this.state.transition('recovering', { trigger: 'route_fallback', turnId: active.turnId });
        await this.recordRecovery({
          category: error.code, action: 'route_fallback', count: index + 1,
          logicalRequestId: route.logicalRequestId, from: route.profile.id,
          to: bounded[index + 1].profile.id, partial: false,
        }, active);
      }
    }
    throw lastError ?? new ContractError('route_unavailable', 'no route candidate was attempted');
  }

  async #invoke(provider, request, deadlines, active) {
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort();
    active.controller.signal.addEventListener('abort', cancel, { once: true });
    const timer = Number.isFinite(deadlines.overallMs)
      ? setTimeout(() => { timedOut = true; controller.abort(); }, deadlines.overallMs) : null;
    try {
      active.providerDispatched = true;
      return await this.#consume(provider, request, active, controller.signal, deadlines);
    } catch (error) {
      if (active.cancelled) throw new ContractError('provider_cancelled', 'provider was cancelled');
      if (timedOut) throw new ContractError('provider_timeout', 'provider attempt timed out', true);
      throw error;
    } finally {
      clearTimeout(timer);
      active.controller.signal.removeEventListener('abort', cancel);
      controller.abort();
    }
  }

  async #consume(provider, request, active, signal, deadlines) {
    let opened = false;
    let attemptUsage = null;
    const stream = provider.stream(request, signal);
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw new ContractError('provider_stream_invalid', 'provider did not return an asynchronous event stream');
    }
    const iterator = stream[Symbol.asyncIterator]();
    try {
      while (true) {
        const boundary = opened ? 'provider_idle_timeout' : 'provider_first_token_timeout';
        const duration = opened ? deadlines.idleMs : deadlines.firstTokenMs;
        const next = await boundedNext(iterator, duration, boundary);
        if (next.done) break;
        const item = next.value;
        if (active.controller.signal.aborted) throw new ContractError('provider_cancelled', 'provider was cancelled');
        assertProviderEvent(item, active.providerTerminal);
        if (!opened) {
          this.state.transition('streaming_model', { trigger: 'stream_opened', turnId: active.turnId });
          opened = true;
        }
        if (item.type === 'text') {
          active.attemptOutputBytes += Buffer.byteLength(item.text, 'utf8');
          await this.acceptText(item.text, active);
        }
        else if (item.type === 'reasoning') {
          if (active.stepReasoningBytes === 0) await this.status?.('reasoning', active);
          const bytes = Buffer.byteLength(item.text, 'utf8');
          active.reasoningBytes += bytes;
          active.stepReasoningBytes += bytes;
          active.attemptOutputBytes += bytes;
        }
        else if (item.type === 'tool_fragment') {
          active.attemptOutputBytes += Buffer.byteLength(JSON.stringify(item.fragments), 'utf8');
          active.toolAssembler.add(item.fragments);
        }
        else if (item.type === 'usage') {
          attemptUsage = validatedUsage(item.usage);
          active.attemptUsage = attemptUsage;
        }
        else if (item.type === 'metadata') active.finishReason = item.finishReason;
        else if (item.type === 'terminal') {
          active.providerTerminal = true;
          active.finishReason = item.finishReason ?? active.finishReason;
          if (item.usage != null) {
            attemptUsage = validatedUsage(item.usage);
            active.attemptUsage = attemptUsage;
          }
        }
      }
      if (!opened) throw new ContractError('provider_empty_stream', 'provider produced no stream items', true);
      if (!active.providerTerminal) throw new ContractError('provider_missing_terminal', 'provider did not terminate cleanly');
      return attemptUsage;
    } finally { await closeIterator(iterator); }
  }
}

function mergeUsage(current, update) {
  if (!update) return current;
  const result = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(update)) result[key] = (result[key] ?? 0) + value;
  return Object.freeze(result);
}

function initializeAttempt(active) {
  active.attemptUsage = null;
  active.attemptUsageAccounted = false;
  active.attemptOutputBytes = 0;
  active.providerDispatched = false;
}

function providerCorrelation(active, spanId) {
  return {
    spanId, parentSpanId: active.attemptId, turnId: active.turnId,
    stepId: active.stepId, attemptId: active.attemptId,
    providerRequestId: active.logicalRequestId,
  };
}

function elapsedMs(started) {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function validatedUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    throw new ContractError('provider_usage_invalid', 'provider emitted invalid usage metadata');
  }
  for (const value of Object.values(usage)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new ContractError('provider_usage_invalid', 'provider emitted invalid usage metadata');
    }
  }
  return Object.freeze({ ...usage });
}

function assertProviderEvent(item, terminalSeen) {
  if (!item || typeof item !== 'object') {
    throw new ContractError('provider_event_invalid', 'provider emitted an invalid event');
  }
  if (terminalSeen) {
    throw new ContractError('provider_conflicting_terminal', 'provider emitted data after its terminal event');
  }
  if (item.type === 'text' || item.type === 'reasoning') {
    if (typeof item.text === 'string' && item.text.length > 0) return;
    throw new ContractError('provider_event_invalid', `provider emitted empty ${item.type} content`);
  }
  if (item.type === 'tool_fragment' && Array.isArray(item.fragments)) return;
  if (item.type === 'usage' && item.usage && typeof item.usage === 'object') return;
  if (item.type === 'metadata' && typeof item.finishReason === 'string') return;
  if (item.type === 'terminal') return;
  throw new ContractError('provider_event_invalid', 'provider emitted an unsupported event');
}

async function closeIterator(iterator) {
  if (typeof iterator.return !== 'function') return;
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, ITERATOR_CLOSE_TIMEOUT_MS); });
  try { await Promise.race([iterator.return().catch(() => undefined), deadline]); }
  finally { clearTimeout(timer); }
}

function fallbackEligible(error) {
  return new Set([
    'provider_transient', 'provider_timeout', 'provider_connect_timeout',
    'provider_first_token_timeout', 'provider_idle_timeout', 'provider_empty_stream',
    'provider_missing_terminal',
  ]).has(error?.code);
}

async function boundedNext(iterator, milliseconds, code) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timeout: true }), milliseconds);
  });
  const operation = iterator.next().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    const settled = await Promise.race([operation, timeout]);
    if (settled.timeout) throw new ContractError(code, 'provider stream deadline expired', true);
    if (settled.error) throw settled.error;
    return settled.value;
  } finally {
    clearTimeout(timer);
  }
}

async function cancellableDelay(milliseconds, signal) {
  if (signal.aborted) throw new ContractError('provider_cancelled', 'provider was cancelled');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new ContractError('provider_cancelled', 'provider was cancelled'));
    }, { once: true });
  });
}
