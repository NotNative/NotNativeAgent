// SPDX-License-Identifier: Apache-2.0
import { discoverHookBundles } from './hook-manifest.js';
import { runHook } from './hook-runner.js';
import { redactExtensionData, redactText } from './redaction.js';

const EVENT_MAP = Object.freeze({
  'session.start:post': ['session', 'post', 'session.start'],
  'session.end:pre': ['session', 'pre', 'session.end'],
  'turn:pre': ['turn', 'pre', 'turn.pre'],
  'turn:post': ['turn', 'terminal', 'turn.terminal'],
  'tool.call:pre': ['tool_request', 'pre', 'tool_request.pre'],
  'tool.call:post': ['tool_request', 'terminal', 'tool_request.terminal'],
  'compaction:pre': ['compaction', 'pre', 'compaction.pre'],
  'compaction:post': ['compaction', 'terminal', 'compaction.terminal'],
  'context.checkpoint:post': ['context_checkpoint', 'terminal', 'context_checkpoint.terminal'],
  'maintenance:idle': ['maintenance', 'active', 'maintenance.idle'],
});
const MAX_HOOK_ROOTS = 2;
const MAX_LOADED_BUNDLES = 32;
const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
const HOOK_TIMEOUT_GRACE_MS = 250;
const MAX_HOOK_TIMEOUT_MS = 300_000;
const DEFAULT_HOOK_CONCURRENCY = 1;
const MAX_HOOK_OUTPUT_BYTES = 262_144;

export class HookRuntime {
  #unregister = [];
  #runtime = new Map();

  constructor(options) {
    this.root = options.root;
    this.roots = Object.freeze(options.roots ?? [{ scope: 'user', path: options.root }]);
    this.events = options.events;
    this.runner = options.runner ?? runHook;
    this.statuses = Object.freeze([]);
  }

  async initialize() {
    const statuses = [];
    const identities = new Set();
    let loaded = 0;
    for (const source of this.roots.slice(MAX_HOOK_ROOTS)) {
      statuses.push(Object.freeze({ bundle: '*', scope: source.scope, status: 'skipped', code: 'hook_root_limit' }));
    }
    for (const source of this.roots.slice(0, MAX_HOOK_ROOTS)) {
      const discovered = await discoverHookBundles(source.path);
      statuses.push(...discovered.diagnostics.map((item) => Object.freeze({ ...item, scope: source.scope })));
      for (const bundle of discovered.bundles) {
        if (loaded >= MAX_LOADED_BUNDLES) {
          statuses.push(Object.freeze({ bundle: bundle.name, scope: source.scope, status: 'skipped', code: 'hook_bundle_limit' }));
          continue;
        }
        if (identities.has(bundle.name)) {
          statuses.push(Object.freeze({ bundle: bundle.name, scope: source.scope, status: 'skipped', code: 'hook_identity_conflict' }));
          continue;
        }
        identities.add(bundle.name); loaded += 1;
        statuses.push(this.#registerBundle(bundle, source.scope));
      }
    }
    this.statuses = Object.freeze(statuses);
    return this.statuses;
  }

  close() {
    for (const unregister of this.#unregister.splice(0)) unregister();
  }

  health() {
    const bundles = this.statuses.map((item) => withRuntime(item, this.#runtime));
    const registrationErrors = bundles.filter((item) => item.status !== 'loaded').length;
    const invocationFailures = bundles.reduce((total, item) => total + (item.runtime?.failures ?? 0), 0);
    const errors = registrationErrors + invocationFailures;
    return Object.freeze({
      status: errors > 0 ? 'degraded' : 'ready', root: this.root, roots: this.roots,
      bundles: Object.freeze(bundles), errors, registration_errors: registrationErrors,
      invocation_failures: invocationFailures,
    });
  }

  #registerBundle(bundle, scope) {
    this.#runtime.set(runtimeKey(scope, bundle.name), runtimeState());
    let registered = 0;
    let skipped = 0;
    bundle.subscriptions.forEach((subscription, index) => {
      const mapped = EVENT_MAP[`${subscription.event}:${subscription.phase}`];
      if (!mapped) { skipped += 1; return; }
      const [category, phase, eventName] = mapped;
      const timeoutMs = Number.isInteger(subscription.timeoutMs) ? subscription.timeoutMs : DEFAULT_HOOK_TIMEOUT_MS;
      const maxConcurrent = Number.isInteger(subscription.maxConcurrent) ? subscription.maxConcurrent : DEFAULT_HOOK_CONCURRENCY;
      const unregister = this.events.register({
        id: `hook.${scope}.${bundle.name}.${index}`, category, phase,
        blocking: subscription.blocking, priority: subscription.priority,
        timeoutMs: Math.min(timeoutMs + HOOK_TIMEOUT_GRACE_MS, MAX_HOOK_TIMEOUT_MS), failurePolicy: 'continue',
        cancellation: subscription.blocking ? 'propagate' : 'detach',
        origin: `hook:${scope}:${bundle.name}`, trust: 'operator_configured',
        inputContract: 'nna.hook-event/1.0', outputContract: 'nna.hook-result/1.0',
        resourceBounds: Object.freeze({
          maxOutputBytes: MAX_HOOK_OUTPUT_BYTES, maxConcurrent,
        }),
      }, (event, signal) => this.#invoke(bundle, subscription, eventName, event, signal, scope));
      this.#unregister.push(unregister); registered += 1;
    });
    return Object.freeze({ bundle: bundle.name, version: bundle.version, scope, status: 'loaded', registered, skipped });
  }

  async #invoke(bundle, subscription, eventName, event, signal, scope) {
    if (event.event_name !== eventName) return { decision: 'continue', code: 'hook_event_filtered' };
    const payload = legacyPayload(subscription, event);
    try {
      const result = await this.runner(subscription, bundle, payload, signal);
      recordRuntime(this.#runtime.get(runtimeKey(scope, bundle.name)), result, subscription);
      return Object.freeze({ ...result, hook: bundle.name, event: subscription.event, phase: subscription.phase });
    } catch (error) {
      recordRuntime(this.#runtime.get(runtimeKey(scope, bundle.name)), {
        decision: 'continue', code: error?.code ?? 'hook_invocation_failed',
      }, subscription);
      throw error;
    }
  }
}

function runtimeKey(scope, name) { return `${scope}:${name}`; }

function runtimeState() {
  return { invocations: 0, failures: 0, denials: 0, last_code: null, last_event: null };
}

function recordRuntime(state, result, subscription) {
  if (!state) return;
  state.invocations += 1;
  if (result?.decision === 'deny') state.denials += 1;
  if (hookFailed(result?.code)) state.failures += 1;
  state.last_code = result?.code ?? 'hook_result_invalid';
  state.last_event = `${subscription.event}:${subscription.phase}`;
}

function hookFailed(code) {
  return !['hook_completed', 'hook_context', 'hook_event_filtered', 'hook_cancelled', 'hook_denied'].includes(code);
}

function withRuntime(item, states) {
  const state = states.get(runtimeKey(item.scope, item.bundle));
  if (!state) return item;
  return Object.freeze({ ...item, runtime: Object.freeze({ ...state }) });
}

function legacyPayload(subscription, event) {
  return Object.freeze(redactExtensionData({
    event: subscription.event, phase: subscription.phase,
    session_id: event.session_id, turn_id: event.turn_id, step_id: event.step_id,
    tool_request_id: event.tool_request_id, outcome: event.outcome, ...event.payload,
  }));
}

export function hookContexts(dispatch) {
  const results = Array.isArray(dispatch?.results) ? dispatch.results : [];
  return Object.freeze(results.filter((item) => typeof item?.additionalContext === 'string')
    .map((item) => Object.freeze({ source: typeof item.hook === 'string' ? item.hook : 'hook', content: redactText(item.additionalContext) })));
}
