// SPDX-License-Identifier: Apache-2.0
import { ContractError, newId } from './ids.js';

export const MAX_SUBSCRIPTION_TIMEOUT_MS = 86_405_000;

const PHASES = Object.freeze({
  session: { pre: true, post: false },
  turn: { pre: true, active: false, terminal: false },
  model_step: { pre: true, active: false, terminal: false },
  provider_attempt: { pre: true, active: false, terminal: false },
  tool_request: { pre: true, active: false, terminal: false },
  permission: { pre: true, active: false, terminal: false },
  steering: { pre: true, active: false, terminal: false },
  compaction: { pre: true, active: false, terminal: false },
  context_checkpoint: { terminal: false },
  recovery: { pre: true, active: false, terminal: false },
  diagnostic: { committed: false },
  maintenance: { active: false },
  persistence: { committed: false },
});

export class EventHub {
  #subscriptions = [];
  #registration = 0;
  #background = new Map();
  #running = new Map();
  #closed = false;
  #dropped = 0;
  #invariantFailures = 0;
  #observer = null;

  constructor(options = {}) {
    this.maxBackground = boundedInteger(options.maxBackground, 64, 1, 1024);
    this.#observer = options.observer ?? null;
  }

  setObserver(observer) {
    this.#observer = observer ?? null;
  }

  register(declaration, handler) {
    if (this.#closed) throw new ContractError('event_hub_closed', 'event hub is closed');
    validateDeclaration(declaration, handler);
    if (this.#subscriptions.some(({ record }) => record.id === declaration.id)) {
      throw new ContractError('subscription_identity_collision', `subscription ${declaration.id} is already registered`);
    }
    const record = Object.freeze({
      ...declaration,
      order: this.#registration,
      resourceBounds: Object.freeze({ ...declaration.resourceBounds }),
    });
    this.#registration += 1;
    this.#subscriptions.push({ record, handler });
    return record.mandatory ? () => false : () => this.#remove(record.id);
  }

  async dispatch(event, signal) {
    if (this.#closed) throw new ContractError('event_hub_closed', 'event hub is closed');
    validatePhase(event.category, event.phase);
    const snapshot = immutableSnapshot(event);
    const started = process.hrtime.bigint();
    observe(this.#observer, 'dispatchStarted', snapshot);
    try {
      const matches = this.#subscriptions.filter(({ record }) => (
        record.category === event.category && record.phase === event.phase
      ));
      const nonblocking = matches.filter(({ record }) => !record.blocking);
      const blocking = matches.filter(({ record }) => record.blocking)
        .sort(compareSubscriptions);
      const results = [];
      let scheduled = 0;
      for (const item of nonblocking) scheduled += Number(this.#schedule(item, snapshot));
      for (const item of blocking) {
        const result = await this.#invokeBlocking(item, snapshot, signal);
        results.push(result);
        if (result?.decision === 'deny' && phaseIsCancelable(event.category, event.phase)) {
          const denied = Object.freeze({ ...result, results: Object.freeze(results), observers: this.#observerFacts(scheduled) });
          observe(this.#observer, 'dispatchFinished', snapshot, denied, elapsedMs(started));
          return denied;
        }
      }
      const completed = Object.freeze({ decision: 'continue', results: Object.freeze(results), observers: this.#observerFacts(scheduled) });
      observe(this.#observer, 'dispatchFinished', snapshot, completed, elapsedMs(started));
      return completed;
    } catch (error) {
      observe(this.#observer, 'dispatchFailed', snapshot, error, elapsedMs(started));
      throw error;
    }
  }

  async drain(timeoutMs = 10_000) {
    const operations = [...this.#background.values()];
    if (operations.length === 0) return this.health();
    let timer;
    await Promise.race([
      Promise.allSettled(operations),
      new Promise((resolve) => { timer = setTimeout(resolve, boundedInteger(timeoutMs, 10_000, 1, 60_000)); }),
    ]);
    clearTimeout(timer);
    return this.health();
  }

  async close(timeoutMs = 10_000) {
    this.#closed = true;
    return this.drain(timeoutMs);
  }

  health() {
    return Object.freeze({
      status: this.#closed ? 'closed'
        : this.#dropped > 0 || this.#invariantFailures > 0 ? 'degraded' : 'ready',
      queued: this.#background.size,
      running: [...this.#running.values()].reduce((sum, count) => sum + count, 0),
      capacity: this.maxBackground, dropped: this.#dropped,
      invariantFailures: this.#invariantFailures,
      overflowPolicy: 'drop_newest_noncritical',
    });
  }

  #schedule(item, event) {
    if (this.#background.size >= this.maxBackground || !this.#reserve(item)) {
      this.#dropped += 1;
      return false;
    }
    const invocationId = newId('subscription');
    const operation = invokeBounded(item, event, undefined, this.#observer).catch(() => undefined).finally(() => {
      this.#background.delete(invocationId); this.#release(item);
    });
    this.#background.set(invocationId, operation);
    return true;
  }

  async #invokeBlocking(item, event, signal) {
    if (!this.#reserve(item)) {
      return item.record.failurePolicy === 'deny'
        ? { decision: 'deny', code: 'subscriber_capacity' }
        : { decision: 'continue', code: 'subscriber_capacity' };
    }
    try { return await invokeBounded(item, event, signal, this.#observer); }
    finally { this.#release(item); }
  }

  #reserve(item) {
    const running = this.#running.get(item.record.id) ?? 0;
    if (running >= item.record.resourceBounds.maxConcurrent) return false;
    this.#running.set(item.record.id, running + 1);
    return true;
  }

  #release(item) {
    const running = this.#running.get(item.record.id);
    if (!Number.isSafeInteger(running) || running < 1) {
      this.#invariantFailures += 1;
      observe(this.#observer, 'hubInvariantFailed', item.record, 'release_without_reservation');
      return;
    }
    const remaining = running - 1;
    if (remaining <= 0) this.#running.delete(item.record.id);
    else this.#running.set(item.record.id, remaining);
  }

  #observerFacts(scheduled) {
    return Object.freeze({ scheduled, queued: this.#background.size, dropped: this.#dropped });
  }

  #remove(id) {
    const index = this.#subscriptions.findIndex(({ record }) => record.id === id);
    if (index < 0) return false;
    this.#subscriptions.splice(index, 1);
    return true;
  }
}

function immutableSnapshot(event) {
  let value;
  try { value = structuredClone(event); } catch {
    throw new ContractError('invalid_event_payload', 'event payload must be structured-cloneable');
  }
  const pending = [value];
  let nodes = 0;
  while (pending.length > 0) {
    const item = pending.pop(); nodes += 1;
    if (nodes > 20_000) throw new ContractError('invalid_event_payload', 'event payload exceeds its structure bound');
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) continue;
    pending.push(...Object.values(item)); Object.freeze(item);
  }
  return value;
}

export function phaseIsCancelable(category, phase) {
  validatePhase(category, phase);
  return PHASES[category][phase];
}

function validateDeclaration(value, handler) {
  if (!value || !boundedText(value.id) || typeof handler !== 'function') {
    throw new ContractError('invalid_subscription', 'subscription identity and handler are required');
  }
  validatePhase(value.category, value.phase);
  if (typeof value.blocking !== 'boolean') {
    throw new ContractError('invalid_subscription', 'blocking mode is required');
  }
  if (!Number.isInteger(value.priority)) throw new ContractError('invalid_subscription', 'subscription priority is required');
  requiredInteger(value.timeoutMs, 1, MAX_SUBSCRIPTION_TIMEOUT_MS);
  if (!['continue', 'deny'].includes(value.failurePolicy)) throw new ContractError('invalid_subscription', 'subscription failure policy is required');
  if (!['propagate', 'detach'].includes(value.cancellation)) throw new ContractError('invalid_subscription', 'subscription cancellation behavior is required');
  if (value.blocking && value.cancellation !== 'propagate') throw new ContractError('invalid_subscription', 'blocking subscriptions must propagate cancellation');
  if (!value.blocking && value.cancellation !== 'detach') throw new ContractError('invalid_subscription', 'nonblocking subscriptions must safely detach');
  if (!boundedText(value.inputContract) || !boundedText(value.outputContract)
    || !boundedText(value.origin) || !boundedText(value.trust)) {
    throw new ContractError('invalid_subscription', 'subscription contracts, origin, and trust are required');
  }
  if (!value.resourceBounds || typeof value.resourceBounds !== 'object' || Array.isArray(value.resourceBounds)) {
    throw new ContractError('invalid_subscription', 'subscription resource bounds are required');
  }
  requiredInteger(value.resourceBounds.maxOutputBytes, 1, 1_048_576);
  requiredInteger(value.resourceBounds.maxConcurrent, 1, 1024);
}

function validatePhase(category, phase) {
  if (!Object.hasOwn(PHASES, category) || !Object.hasOwn(PHASES[category], phase)) {
    throw new ContractError('invalid_event_phase', `undefined phase ${category}.${phase}`);
  }
}

function compareSubscriptions(a, b) {
  return a.record.priority - b.record.priority || a.record.order - b.record.order;
}

async function invokeBounded(item, event, parentSignal, observer) {
  const controller = new AbortController();
  const spanId = newId('subscriber');
  const started = process.hrtime.bigint();
  observe(observer, 'subscriberStarted', event, item.record, spanId);
  let timer; let removeParent = () => undefined;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ timeout: true });
    }, item.record.timeoutMs);
  });
  const operation = Promise.resolve()
    .then(() => item.handler(event, controller.signal))
    .then((value) => ({ value }), (error) => ({ error }));
  const cancellation = new Promise((resolve) => {
    if (item.record.cancellation !== 'propagate' || !parentSignal) return;
    const abort = () => { controller.abort(parentSignal.reason); resolve({ cancelled: true }); };
    if (parentSignal.aborted) abort();
    else {
      parentSignal.addEventListener('abort', abort, { once: true });
      removeParent = () => parentSignal.removeEventListener('abort', abort);
    }
  });
  try {
    const settled = await Promise.race([operation, timeout, cancellation]);
    if (settled.timeout || settled.cancelled || settled.error) {
      throw settled.error ?? new Error(settled.cancelled ? 'subscriber cancelled' : 'subscriber timeout');
    }
    assertOutputBound(settled.value, item.record.resourceBounds.maxOutputBytes);
    observe(observer, 'subscriberFinished', event, item.record, spanId, settled.value, elapsedMs(started));
    return settled.value;
  } catch (error) {
    observe(observer, 'subscriberFailed', event, item.record, spanId, error, elapsedMs(started));
    if (item.record.failurePolicy === 'deny') return { decision: 'deny', code: 'subscriber_failure' };
    return { decision: 'continue' };
  } finally {
    clearTimeout(timer); removeParent();
  }
}

function observe(observer, method, ...args) {
  try { observer?.[method]?.(...args); } catch { /* diagnostics never affect runtime behavior */ }
}

function elapsedMs(started) {
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new ContractError('invalid_subscription_bound', `event bound must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function requiredInteger(value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ContractError('invalid_subscription_bound', `event bound must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function boundedText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function assertOutputBound(value, maximum) {
  let encoded;
  try { encoded = value === undefined ? '' : JSON.stringify(value); }
  catch { throw new ContractError('subscriber_output_invalid', 'subscriber output must be bounded JSON'); }
  if (Buffer.byteLength(encoded) > maximum) {
    throw new ContractError('subscriber_output_too_large', 'subscriber output exceeded its declared bound');
  }
}
