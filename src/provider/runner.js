// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { FairScheduler } from './fair-scheduler.js';

const ITERATOR_CLOSE_TIMEOUT_MS = 25;
const LOCAL_HEALTH_PROBE_INTERVAL_MS = 60_000;
const LOCAL_HEALTH_PROBE_TIMEOUT_MS = 5_000;
const TRUSTED_LOCAL_IDLE_WATCHDOG_MS = 120_000;

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
    this.healthProbeIntervalMs = options.healthProbeIntervalMs ?? LOCAL_HEALTH_PROBE_INTERVAL_MS;
    this.healthProbeTimeoutMs = options.healthProbeTimeoutMs ?? LOCAL_HEALTH_PROBE_TIMEOUT_MS;
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
      initializeAttempt(active, request.maxOutputTokens);
      try {
        await this.verifyRequest?.(request, manifest, route, active);
        this.telemetry?.record('provider.request', 'started', {
          model: active.modelName, provider_profile: active.providerResource,
          message_count: request.messages?.length ?? 0, tool_count: request.tools?.length ?? 0,
          reasoning_continuity: request.messages?.some((message) => typeof message?.reasoning_content === 'string') ?? false,
        }, providerCorrelation(active, requestSpan));
        const attemptUsage = await this.#invoke(provider, request, deadlines, active);
        this.#accountAttemptUsage(active);
        this.#observeCacheUsage(active, attemptUsage);
        this.#recordSucceeded(active, requestSpan, requestStarted);
        attemptOutcome = 'completed';
        active.stepReasoningText = active.attemptReasoningText;
        active.stepReasoningReplayable = active.attemptReasoningReplayable;
        return;
      } catch (error) {
        this.#accountAttemptUsage(active);
        attemptOutcome = active.cancelled ? 'cancelled' : 'failed';
        attemptReason = error?.code ?? 'provider_failed';
        this.#recordFailed(active, error, requestSpan, requestStarted);
        const partial = hasCommittedAttemptOutput(error, active);
        const plan = error.retryable
          ? (this.reliability?.providerRetry(active, error.code, attempt, partial, error.retryAfterMs)
            ?? active.recovery.providerRetry(error.code, attempt, partial, error.retryAfterMs))
          : { retry: false };
        if (!plan.retry || active.cancelled) throw error;
        await this.#settleRetryableAttempt(active);
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

  async #settleRetryableAttempt(active) {
    await this.settleAttempt(active, 'failed');
    active.toolAssembler.reset();
  }

  #recordSucceeded(active, requestSpan, requestStarted) {
    this.telemetry?.record('provider.request', 'succeeded', {
      model: active.modelName, provider_profile: active.providerResource,
      finish_reason: active.finishReason, usage: active.usage,
      response_text: active.stepText, reasoning_bytes: active.reasoningBytes,
      step_reasoning_bytes: active.stepReasoningBytes,
      transport_bytes: active.attemptTransportBytes,
    }, { ...providerCorrelation(active, requestSpan), durationMs: elapsedMs(requestStarted), outcome: 'completed' });
    this.dialects?.observe({ profile: { id: active.providerResource }, model: active.modelName }, { status: 'succeeded' });
  }

  #recordFailed(active, error, requestSpan, requestStarted) {
    this.telemetry?.record('provider.request', active.cancelled ? 'cancelled' : 'failed', {
      model: active.modelName, provider_profile: active.providerResource,
      finish_reason: active.finishReason, usage: active.usage,
      partial_response_text: active.stepText, reasoning_bytes: active.reasoningBytes,
      step_reasoning_bytes: active.stepReasoningBytes,
      transport_bytes: active.attemptTransportBytes,
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
        await this.run(router.provider(route), request,
          effectiveProviderDeadlines(deadlines, route), active, manifest, route);
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
    const monitor = startProviderHealthMonitor({
      provider, active, signal, telemetry: this.telemetry,
      intervalMs: this.healthProbeIntervalMs, timeoutMs: this.healthProbeTimeoutMs,
    });
    try {
      while (true) {
        const boundary = opened ? 'provider_idle_timeout' : 'provider_first_token_timeout';
        const duration = opened ? deadlines.idleMs : deadlines.firstTokenMs;
        const renewFromHealth = opened ? deadlines.renewIdleOnHealth : deadlines.renewFirstTokenOnHealth;
        const next = await boundedNext(
          iterator, duration, boundary,
          renewFromHealth ? () => active.lastProviderHealthAt : null,
        );
        if (next.done) break;
        const item = next.value;
        active.lastProviderActivityAt = Date.now();
        if (active.controller.signal.aborted) throw new ContractError('provider_cancelled', 'provider was cancelled');
        assertProviderEvent(item, active.providerTerminal);
        if (!opened) {
          this.state.transition('streaming_model', { trigger: 'stream_opened', turnId: active.turnId });
          opened = true;
        }
        const usage = await this.#consumeEvent(item, active);
        if (usage) attemptUsage = usage;
        if (item.type === 'tool_fragment' && active.toolAssembler.hasEquivalentCompleteCalls) {
          // parallel_tool_calls is disabled. Once a second complete equivalent
          // call arrives, later copies cannot add useful work and some local
          // providers otherwise stream dozens of them until the output limit.
          active.providerTerminal = true;
          active.finishReason = 'tool_calls';
          this.telemetry?.record('provider.tool_stream', 'stopped', {
            reason: 'equivalent_complete_tool_call', tool_call_count: active.toolAssembler.size,
          }, providerCorrelation(active, `provider-request:${active.attemptId}`));
          break;
        }
      }
      if (!opened) throw new ContractError('provider_empty_stream', 'provider produced no stream items', true);
      if (!active.providerTerminal) throw new ContractError('provider_missing_terminal', 'provider did not terminate cleanly');
      return attemptUsage;
    } finally {
      await monitor.stop();
      await closeIterator(iterator);
    }
  }

  async #consumeEvent(item, active) {
    if (item.type === 'transport_activity') active.attemptTransportBytes += item.bytes;
    else if (item.type === 'text') {
      active.attemptOutputBytes += Buffer.byteLength(item.text, 'utf8');
      await this.acceptText(item.text, active);
    } else if (item.type === 'reasoning') {
      if (active.stepReasoningBytes === 0) await this.status?.('reasoning', active);
      const bytes = Buffer.byteLength(item.text, 'utf8');
      active.reasoningBytes += bytes;
      active.stepReasoningBytes += bytes;
      active.attemptOutputBytes += bytes;
      if (!active.attemptReasoningOverflow) {
        const appendReasoningChunk = this.reliability?.appendReasoningChunk;
        const appended = typeof appendReasoningChunk === 'function'
          ? appendReasoningChunk(active.attemptReasoningText, item.text)
          : `${active.attemptReasoningText ?? ''}${item.text}`;
        if (appended === null) {
          active.attemptReasoningText = '';
          active.attemptReasoningReplayable = false;
          active.attemptReasoningOverflow = true;
        } else {
          active.attemptReasoningText = appended;
          if (item.field === 'reasoning_content') active.attemptReasoningReplayable = true;
        }
      }
    } else if (item.type === 'tool_fragment') {
      active.attemptOutputBytes += Buffer.byteLength(JSON.stringify(item.fragments), 'utf8');
      active.toolAssembler.add(item.fragments);
    } else if (item.type === 'usage') {
      active.attemptUsage = validatedUsage(item.usage);
      return active.attemptUsage;
    } else if (item.type === 'metadata') active.finishReason = item.finishReason;
    else if (item.type === 'terminal') {
      active.providerTerminal = true;
      active.finishReason = item.finishReason ?? active.finishReason;
      if (item.usage != null) {
        active.attemptUsage = validatedUsage(item.usage);
        return active.attemptUsage;
      }
    }
    return null;
  }
}

function hasCommittedAttemptOutput(error, active) {
  if (active.stepText.length > 0) return true;
  // Invariant: identity drift happens while provider fragments are still only
  // buffered. They have not crossed the tool validation or execution boundary.
  return error?.code !== 'tool_identity_drift' && active.toolAssembler.size > 0;
}

function mergeUsage(current, update) {
  if (!update) return current;
  const result = { ...(current ?? {}) };
  for (const [key, value] of Object.entries(update)) result[key] = (result[key] ?? 0) + value;
  return Object.freeze(result);
}

function initializeAttempt(active, outputLimitTokens = null) {
  active.attemptUsage = null;
  active.attemptUsageAccounted = false;
  active.attemptOutputLimitTokens = Number.isSafeInteger(outputLimitTokens) && outputLimitTokens > 0
    ? outputLimitTokens : null;
  active.attemptOutputBytes = 0;
  active.attemptTransportBytes = 0;
  active.attemptReasoningText = '';
  active.attemptReasoningReplayable = false;
  active.attemptReasoningOverflow = false;
  active.providerDispatched = false;
  active.lastProviderActivityAt = Date.now();
  active.lastProviderHealthAt = null;
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
    if (typeof item.text === 'string' && item.text.length > 0
      && (item.type !== 'reasoning' || item.field === undefined || ['reasoning', 'reasoning_content'].includes(item.field))) return;
    throw new ContractError('provider_event_invalid', `provider emitted empty ${item.type} content`);
  }
  if (item.type === 'transport_activity' && Number.isSafeInteger(item.bytes) && item.bytes > 0) return;
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
    'provider_missing_terminal', 'provider_transport_idle_timeout', 'provider_transport_error',
  ]).has(error?.code);
}

async function boundedNext(iterator, milliseconds, code, renewedAt = null) {
  if (!Number.isFinite(milliseconds)) return iterator.next();
  const startedAt = Date.now();
  const operation = iterator.next().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  while (true) {
    const renewal = typeof renewedAt === 'function' ? renewedAt() : null;
    const leaseStartedAt = Number.isFinite(renewal) ? Math.max(startedAt, renewal) : startedAt;
    const remaining = Math.max(0, milliseconds - (Date.now() - leaseStartedAt));
    if (remaining === 0) throw new ContractError(code, 'provider stream deadline expired', true);
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timeout: true }), remaining);
    });
    try {
      const settled = await Promise.race([operation, timeout]);
      if (settled.timeout) continue;
      if (settled.error) throw settled.error;
      return settled.value;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function effectiveProviderDeadlines(deadlines, route) {
  const trustedLocal = route.profile.trustZone !== 'public_network';
  return {
    overallMs: route.deadlineMs,
    firstTokenMs: trustedLocal && !deadlines.firstTokenExplicit ? null : deadlines.firstTokenMs,
    idleMs: trustedLocal && !deadlines.idleExplicit ? TRUSTED_LOCAL_IDLE_WATCHDOG_MS : deadlines.idleMs,
    renewFirstTokenOnHealth: trustedLocal && !deadlines.firstTokenExplicit,
    renewIdleOnHealth: trustedLocal && !deadlines.idleExplicit,
  };
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

function startProviderHealthMonitor({ provider, active, signal, telemetry, intervalMs, timeoutMs }) {
  if (provider?.profile?.trustZone === 'public_network' || typeof provider?.health !== 'function'
    || !Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { stop: async () => undefined };
  }
  let stopped = false;
  let timer = null;
  let pending = null;
  let probeController = null;
  let sequence = 0;
  const schedule = (delayMs = intervalMs) => {
    if (stopped) return;
    timer = setTimeout(() => { pending = run(); }, delayMs);
    timer.unref?.();
  };
  const run = async () => {
    if (stopped || signal.aborted) return;
    const silenceMs = Date.now() - (active.lastProviderActivityAt ?? Date.now());
    if (silenceMs < intervalMs) { schedule(Math.max(1, intervalMs - silenceMs)); return; }
    sequence += 1;
    const controller = new AbortController();
    probeController = controller;
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    deadline.unref?.();
    const spanId = `provider-health:${active.attemptId}:${sequence}`;
    telemetry?.record('provider.health', 'started', {
      model: active.modelName, provider_profile: active.providerResource, silence_ms: silenceMs,
    }, providerCorrelation(active, spanId));
    try {
      await provider.health(controller.signal);
      active.lastProviderHealthAt = Date.now();
      telemetry?.record('provider.health', 'succeeded', {
        model: active.modelName, provider_profile: active.providerResource, silence_ms: silenceMs,
      }, { ...providerCorrelation(active, spanId), outcome: 'completed' });
    } catch (error) {
      if (!signal.aborted && !stopped) telemetry?.record('provider.health', 'failed', {
        model: active.modelName, provider_profile: active.providerResource, silence_ms: silenceMs,
        failure: { code: error?.code ?? 'provider_health_unavailable', retryable: true },
      }, { ...providerCorrelation(active, spanId), outcome: 'failed', reasonCode: error?.code });
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', cancel);
      probeController = null;
      pending = null;
      schedule();
    }
  };
  schedule();
  return { stop: async () => {
    stopped = true;
    clearTimeout(timer);
    probeController?.abort();
    await pending?.catch(() => undefined);
  } };
}
