// SPDX-License-Identifier: Apache-2.0

const PROVIDER_RECOVERY_HEALTH_INTERVAL_MS = 10_000;

export async function fallbackAfterContentFreeCompletion(options) {
  const { active, candidates, index, route } = options;
  if (hasUsableProviderOutput(active) || index >= candidates.length - 1) return false;
  await options.settleAttempt(active, 'empty');
  active.toolAssembler.reset();
  options.state.transition('recovering', { trigger: 'empty_route_fallback', turnId: active.turnId });
  await options.recordRecovery({
    category: 'provider_unusable_completion', action: 'route_fallback', count: index + 1,
    logicalRequestId: route.logicalRequestId, from: route.profile.id,
    to: candidates[index + 1].profile.id, partial: false,
  }, active);
  return true;
}

export async function waitForProviderRecovery(provider, active, options = {}) {
  const waiter = providerRecoveryWaiter(active.controller.signal);
  active.providerRecoveryWaiter = waiter;
  try {
    const initial = await recoveryDelay(options.delayMs, active.controller.signal, waiter.promise);
    if (initial !== 'completed') return initial;
    if (provider?.profile?.trustZone === 'public_network' || typeof provider?.health !== 'function') return 'retry';
    let sequence = 0;
    while (true) {
      sequence += 1;
      const health = await raceRecoveryWait(probeProviderHealth(
        provider, active, options.telemetry, options.healthProbeTimeoutMs, sequence, waiter.promise,
      ), waiter.promise);
      if (health === 'steering' || health === 'cancelled') return health;
      if (health === true) return 'retry';
      const interval = Math.max(options.delayMs, PROVIDER_RECOVERY_HEALTH_INTERVAL_MS);
      const waited = await recoveryDelay(interval, active.controller.signal, waiter.promise);
      if (waited !== 'completed') return waited;
    }
  } finally {
    waiter.dispose();
    if (active.providerRecoveryWaiter === waiter) active.providerRecoveryWaiter = null;
  }
}

export function startProviderHealthMonitor({ provider, active, signal, telemetry, intervalMs, timeoutMs }) {
  if (provider?.profile?.trustZone === 'public_network' || typeof provider?.health !== 'function'
    || !Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { stop: async () => undefined };
  }
  let stopped = false; let timer = null; let pending = null; let probeController = null; let sequence = 0;
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
    const correlation = providerCorrelation(active, `provider-health:${active.attemptId}:${sequence}`);
    telemetry?.record('provider.health', 'started', {
      model: active.modelName, provider_profile: active.providerResource, silence_ms: silenceMs,
    }, correlation);
    try {
      await provider.health(controller.signal);
      active.lastProviderHealthAt = Date.now();
      telemetry?.record('provider.health', 'succeeded', {
        model: active.modelName, provider_profile: active.providerResource, silence_ms: silenceMs,
      }, { ...correlation, outcome: 'completed' });
    } catch (error) {
      if (!signal.aborted && !stopped) telemetry?.record('provider.health', 'failed', {
        model: active.modelName, provider_profile: active.providerResource, silence_ms: silenceMs,
        failure: { code: error?.code ?? 'provider_health_unavailable', retryable: true },
      }, { ...correlation, outcome: 'failed', reasonCode: error?.code });
    } finally {
      clearTimeout(deadline); signal.removeEventListener('abort', cancel);
      probeController = null; pending = null; schedule();
    }
  };
  schedule();
  return { stop: async () => {
    stopped = true; clearTimeout(timer); probeController?.abort(); await pending?.catch(() => undefined);
  } };
}

function hasUsableProviderOutput(active) {
  return active.stepText.length > 0 || active.stepReasoningBytes > 0 || active.toolAssembler.size > 0;
}

function providerRecoveryWaiter(signal) {
  let resolve; let settled = false;
  const promise = new Promise((yes) => {
    resolve = (reason) => {
      if (settled) return false;
      settled = true; yes(reason); return true;
    };
  });
  const abort = () => resolve('cancelled');
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return Object.freeze({ promise, resolve, dispose: () => signal.removeEventListener('abort', abort) });
}

async function raceRecoveryWait(operation, waiter) {
  const value = await Promise.race([
    Promise.resolve(operation).then((result) => ({ kind: 'completed', result })),
    waiter.then((reason) => ({ kind: reason })),
  ]);
  return value.kind === 'completed' ? (value.result ?? 'completed') : value.kind;
}

async function recoveryDelay(milliseconds, signal, waiter) {
  if (signal.aborted) return 'cancelled';
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel); resolve(value);
    };
    const timer = setTimeout(() => finish('completed'), milliseconds);
    const cancel = () => finish('cancelled');
    signal.addEventListener('abort', cancel, { once: true });
    waiter.then((reason) => finish(reason));
  });
}

async function probeProviderHealth(provider, active, telemetry, timeoutMs, sequence, waiter) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  active.controller.signal.addEventListener('abort', cancel, { once: true });
  waiter.then(cancel);
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  const correlation = providerCorrelation(active, `provider-recovery-health:${active.attemptId}:${sequence}`);
  telemetry?.record('provider.health', 'started', providerHealthDetail(active), correlation);
  try {
    const healthy = await provider.health(controller.signal) === true;
    telemetry?.record('provider.health', healthy ? 'succeeded' : 'failed', providerHealthDetail(active, healthy), {
      ...correlation, outcome: healthy ? 'completed' : 'failed',
    });
    return healthy;
  } catch (error) {
    if (!active.controller.signal.aborted) telemetry?.record('provider.health', 'failed', providerHealthDetail(active, false, error), {
      ...correlation, outcome: 'failed', reasonCode: error?.code,
    });
    return false;
  } finally {
    clearTimeout(deadline); active.controller.signal.removeEventListener('abort', cancel);
  }
}

function providerHealthDetail(active, healthy = true, error = null) {
  return {
    model: active.modelName, provider_profile: active.providerResource, recovery_wait: true,
    ...(healthy ? {} : { failure: { code: error?.code ?? 'provider_health_unavailable', retryable: true } }),
  };
}

function providerCorrelation(active, spanId) {
  return {
    spanId, parentSpanId: active.attemptId, turnId: active.turnId,
    stepId: active.stepId, attemptId: active.attemptId, providerRequestId: active.logicalRequestId,
  };
}
