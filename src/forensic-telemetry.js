// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { newId } from './ids.js';
import { userDataPaths, VERSION } from './product.js';
import { sanitizeTelemetry, supportTelemetryProjection } from './forensic-telemetry-sanitize.js';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'denied', 'skipped', 'superseded', 'unknown_effect']);

export class ForensicTelemetry {
  #worker = null;
  #ready = null;
  #requests = new Map();
  #requestSequence = 0;
  #recordSequence = 0;
  #health;
  #closed = false;

  constructor(options) {
    this.workspaceRoot = options.workspaceRoot;
    this.sessionId = options.sessionId;
    this.runtimeId = options.runtimeId;
    this.conversationId = options.conversationId ?? options.sessionId;
    this.dbPath = options.dbPath ?? join(options.root ?? userDataPaths().projects, workspaceIdentity(options.workspaceRoot), 'events.db');
    this.maxAgeMs = options.maxAgeMs ?? 30 * 86_400_000;
    this.volatileMaxAgeMs = options.volatileMaxAgeMs ?? 3 * 86_400_000;
    this.maxBytes = options.maxBytes ?? 1_073_741_824;
    this.#health = { status: 'starting', dbPath: this.dbPath, writes: 0, lastWriteAt: null, bytes: 0, retentionDays: 30, maxBytes: this.maxBytes };
  }

  async initialize() {
    if (this.#ready) return this.#ready;
    this.#ready = new Promise((resolve) => {
      const worker = new Worker(new URL('./forensic-telemetry-worker.js', import.meta.url), {
        execArgv: ['--disable-warning=ExperimentalWarning'],
        workerData: {
          dbPath: this.dbPath, maxAgeMs: this.maxAgeMs, volatileMaxAgeMs: this.volatileMaxAgeMs,
          maxBytes: this.maxBytes, activeSessionId: this.sessionId,
        },
      });
      this.#worker = worker;
      worker.on('message', (message) => this.#message(message, resolve));
      worker.on('error', () => this.#degrade('telemetry_worker_failed', resolve));
      worker.on('exit', (code) => { if (!this.#closed && code !== 0) this.#degrade('telemetry_worker_exited', resolve); });
    });
    await this.#ready;
    if (this.#health.status === 'ready') {
      this.record('telemetry.session', 'started', {
        product_version: VERSION, workspace: this.workspaceRoot, retention_days: this.maxAgeMs / 86_400_000,
        max_bytes: this.maxBytes, local_only: true, rich_capture: true,
        volatile_retention_days: this.volatileMaxAgeMs / 86_400_000,
      }, { spanId: `telemetry:${this.sessionId}` });
    }
    return this.health();
  }

  record(eventName, status, payload = {}, correlation = {}) {
    if (this.#closed || !this.#worker || this.#health.status === 'degraded') return false;
    const row = rowFrom(this, eventName, status, payload, correlation, ++this.#recordSequence);
    try { this.#worker.postMessage({ type: 'record', row }); return true; }
    catch { this.#degrade('telemetry_write_failed'); return false; }
  }

  eventObserver() {
    return Object.freeze({
      dispatchStarted: (event) => this.record('engine.phase', 'started', event, eventCorrelation(event)),
      dispatchFinished: (event, result, durationMs) => this.record(
        'engine.phase', terminalStatus(result?.decision), { event, dispatch: result },
        { ...eventCorrelation(event), durationMs, outcome: result?.decision ?? event.outcome },
      ),
      dispatchFailed: (event, error, durationMs) => this.record(
        'engine.phase', 'failed', { event, failure: failureShape(error) },
        { ...eventCorrelation(event), durationMs, reasonCode: error?.code },
      ),
      subscriberStarted: (event, subscription, spanId) => this.record(
        'engine.subscriber', 'started', { event_name: event.event_name, subscription },
        { ...eventCorrelation(event), spanId, parentSpanId: event.event_id },
      ),
      subscriberFinished: (event, subscription, spanId, result, durationMs) => this.record(
        'engine.subscriber', terminalStatus(result?.decision), { event_name: event.event_name, subscription, result },
        { ...eventCorrelation(event), spanId, parentSpanId: event.event_id, durationMs, outcome: result?.decision },
      ),
      subscriberFailed: (event, subscription, spanId, error, durationMs) => this.record(
        'engine.subscriber', 'failed', { event_name: event.event_name, subscription, failure: failureShape(error) },
        { ...eventCorrelation(event), spanId, parentSpanId: event.event_id, durationMs, reasonCode: error?.code },
      ),
    });
  }

  stateObserver() {
    return Object.freeze({
      transitionStarted: (fact) => this.record('state.transition', 'started', fact, transitionCorrelation(fact)),
      transitionFinished: (fact, status) => this.record('state.transition', status, fact, {
        ...transitionCorrelation(fact), outcome: fact.to,
      }),
      transitionFailed: (fact, error) => this.record('state.transition', 'failed', {
        ...fact, failure: failureShape(error),
      }, { ...transitionCorrelation(fact), reasonCode: error?.code }),
    });
  }

  lifecycleObserver() {
    return Object.freeze({
      lifecycleStarted: (record) => this.record('lifecycle.record', 'started', record, lifecycleCorrelation(record)),
      lifecycleFinished: (record) => this.record(
        'lifecycle.record', terminalStatus(record.outcome), record,
        { ...lifecycleCorrelation(record), outcome: record.outcome },
      ),
    });
  }

  async query(options = {}) {
    await this.#ready;
    return this.#request('query', { options }, []);
  }

  async openSpans(limit = 200) {
    await this.#ready;
    return this.#request('open_spans', { limit }, []);
  }

  async supportSnapshot(options = {}) {
    const sessionId = options.sessionId ?? this.sessionId;
    const rows = await this.query({ sessionId, limit: options.limit ?? 2000 });
    const open = (await this.openSpans(200)).filter((row) => row.session_id === sessionId);
    return Object.freeze({
      format: 1, local_source: this.dbPath, rows: Object.freeze(rows.map(supportTelemetryProjection)),
      open_spans: Object.freeze(open.map(supportTelemetryProjection)),
    });
  }

  async health() {
    if (!this.#worker || this.#health.status === 'degraded') return Object.freeze({ ...this.#health });
    const health = await this.#request('health');
    if (health) this.#health = health;
    return Object.freeze({ ...this.#health });
  }

  async flush() {
    if (!this.#worker) return this.health();
    const health = await this.#request('flush');
    if (health) this.#health = health;
    return this.health();
  }

  async close() {
    if (this.#closed) return;
    if (!this.#worker) { this.#closed = true; return; }
    if (this.#health.status !== 'degraded') {
      this.record('telemetry.session', 'succeeded', { product_version: VERSION }, { spanId: `telemetry:${this.sessionId}` });
      await this.flush();
      await this.#request('close', {}, { closed: false });
    }
    this.#closed = true;
    await this.#worker.terminate().catch(() => undefined);
    this.#worker = null;
  }

  #request(type, payload = {}, fallback = null) {
    if (!this.#worker || this.#closed || this.#health.status === 'degraded') return Promise.resolve(fallback);
    const id = `telemetry_request_${++this.#requestSequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#requests.delete(id);
        this.#degrade('telemetry_timeout');
        resolve(fallback);
      }, 5000);
      this.#requests.set(id, { resolve, timer, fallback });
      try { this.#worker.postMessage({ type, id, ...payload }); }
      catch {
        clearTimeout(timer);
        this.#requests.delete(id);
        this.#degrade('telemetry_request_failed');
        resolve(fallback);
      }
    });
  }

  #message(message, readyResolve) {
    if (message.type === 'ready') { this.#health = { ...this.#health, status: 'ready', dbPath: message.dbPath }; readyResolve(this.#health); return; }
    if (message.type === 'fatal' || message.type === 'degraded') { this.#degrade(message.code, readyResolve, message.message); return; }
    if (message.type !== 'response') return;
    const pending = this.#requests.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer); this.#requests.delete(message.id);
    if (message.error) { this.#degrade(message.error); pending.resolve(pending.fallback); }
    else pending.resolve(message.value);
  }

  #degrade(code, readyResolve = () => undefined, detail = null) {
    this.#health = {
      ...this.#health, status: 'degraded', code, lastErrorAt: new Date().toISOString(),
      ...(typeof detail === 'string' && detail.length > 0 ? { detail: detail.slice(0, 160) } : {}),
    };
    readyResolve(this.#health);
    for (const pending of this.#requests.values()) {
      clearTimeout(pending.timer);
      pending.resolve(pending.fallback);
    }
    this.#requests.clear();
  }
}

export class NullTelemetry {
  async initialize() { return this.health(); }
  record() { return false; }
  eventObserver() { return null; }
  stateObserver() { return null; }
  lifecycleObserver() { return null; }
  async query() { return []; }
  async openSpans() { return []; }
  async supportSnapshot() { return { format: 1, rows: [], open_spans: [], disabled: true }; }
  async health() { return Object.freeze({ status: 'disabled', reason: 'telemetry_disabled' }); }
  async flush() { return this.health(); }
  async close() {}
}

export function createForensicTelemetry(options) {
  if (options.telemetry === false || process.env.NODE_TEST_CONTEXT) return new NullTelemetry();
  if (options.telemetry && typeof options.telemetry.record === 'function') return options.telemetry;
  return new ForensicTelemetry(options);
}

function rowFrom(owner, eventName, status, payload, correlation, sequence) {
  return Object.freeze({
    timestamp: new Date().toISOString(), monotonic_ns: process.hrtime.bigint().toString(),
    event_name: boundedName(eventName), source: correlation.source ?? 'nna', status,
    outcome: correlation.outcome ?? null, reason_code: correlation.reasonCode ?? payload?.reason_code ?? payload?.code ?? null,
    effect_certainty: correlation.effectCertainty ?? payload?.effect_certainty ?? null,
    duration_ms: finite(correlation.durationMs), sequence,
    runtime_id: correlation.runtimeId ?? owner.runtimeId, session_id: correlation.sessionId ?? owner.sessionId,
    conversation_id: correlation.conversationId ?? owner.conversationId,
    turn_id: correlation.turnId ?? payload?.turn_id ?? null, step_id: correlation.stepId ?? payload?.step_id ?? null,
    attempt_id: correlation.attemptId ?? payload?.attempt_id ?? null,
    agent_run_id: correlation.agentRunId ?? payload?.agent_run_id ?? null,
    parent_agent_run_id: correlation.parentAgentRunId ?? payload?.parent_agent_run_id ?? null,
    provider_request_id: correlation.providerRequestId ?? payload?.provider_request_id ?? null,
    tool_request_id: correlation.toolRequestId ?? payload?.tool_request_id ?? null,
    hook_invocation_id: correlation.hookInvocationId ?? payload?.hook_invocation_id ?? null,
    span_id: correlation.spanId ?? newId('span'), parent_span_id: correlation.parentSpanId ?? null,
    payload: sanitizeTelemetry(payload),
  });
}

function eventCorrelation(event) {
  return {
    runtimeId: event.runtime_id, sessionId: event.session_id, conversationId: event.conversation_id,
    turnId: event.turn_id, stepId: event.step_id, attemptId: event.attempt_id,
    toolRequestId: event.tool_request_id, spanId: event.event_id,
    parentSpanId: event.parent_span_id, outcome: event.outcome,
  };
}

function transitionCorrelation(fact) {
  return { turnId: fact.turnId, spanId: fact.id };
}

function lifecycleCorrelation(record) {
  const correlation = { spanId: record.id, parentSpanId: record.parentId };
  if (record.kind === 'turn') correlation.turnId = record.id;
  if (record.kind === 'model_step') correlation.stepId = record.id;
  if (record.kind === 'provider_attempt') correlation.attemptId = record.id;
  if (record.kind === 'tool_call') correlation.toolRequestId = record.id;
  return correlation;
}

function terminalStatus(decision) {
  if (TERMINAL.has(decision)) return decision;
  return decision === 'deny' ? 'denied' : 'succeeded';
}

function failureShape(error) {
  return { code: error?.code ?? 'unclassified_failure', retryable: error?.retryable === true, name: error?.name ?? 'Error' };
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boundedName(value) {
  const text = String(value ?? 'runtime.event');
  return text.length <= 128 ? text : text.slice(0, 128);
}

function workspaceIdentity(path) {
  const label = basename(path).replace(/[^A-Za-z0-9._-]+/gu, '-').slice(0, 48) || 'workspace';
  const digest = createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 16);
  return `${label}-${digest}`;
}
