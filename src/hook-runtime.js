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
});

export class HookRuntime {
  #unregister = [];

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
    for (const source of this.roots.slice(0, 2)) {
      const discovered = await discoverHookBundles(source.path);
      statuses.push(...discovered.diagnostics.map((item) => Object.freeze({ ...item, scope: source.scope })));
      for (const bundle of discovered.bundles) {
        if (loaded >= 32) break;
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
    const errors = this.statuses.filter((item) => item.status !== 'loaded').length;
    return Object.freeze({ status: errors > 0 ? 'degraded' : 'ready', root: this.root, roots: this.roots, bundles: this.statuses, errors });
  }

  #registerBundle(bundle, scope) {
    let registered = 0;
    let skipped = 0;
    bundle.subscriptions.forEach((subscription, index) => {
      const mapped = EVENT_MAP[`${subscription.event}:${subscription.phase}`];
      if (!mapped) { skipped += 1; return; }
      const [category, phase, eventName] = mapped;
      const unregister = this.events.register({
        id: `hook.${scope}.${bundle.name}.${index}`, category, phase,
        blocking: subscription.blocking, priority: subscription.priority,
        timeoutMs: subscription.timeoutMs + 250, failurePolicy: 'continue',
        cancellation: subscription.blocking ? 'propagate' : 'detach',
        origin: `hook:${scope}:${bundle.name}`, trust: 'operator_configured',
        inputContract: 'nna.hook-event/1.0', outputContract: 'nna.hook-result/1.0',
        resourceBounds: Object.freeze({ maxOutputBytes: 262_144, maxConcurrent: 1 }),
      }, (event, signal) => this.#invoke(bundle, subscription, eventName, event, signal));
      this.#unregister.push(unregister); registered += 1;
    });
    return Object.freeze({ bundle: bundle.name, version: bundle.version, scope, status: 'loaded', registered, skipped });
  }

  async #invoke(bundle, subscription, eventName, event, signal) {
    if (event.event_name !== eventName) return { decision: 'continue', code: 'hook_event_filtered' };
    const payload = legacyPayload(subscription, event);
    const result = await this.runner(subscription, bundle, payload, signal);
    return Object.freeze({ ...result, hook: bundle.name, event: subscription.event, phase: subscription.phase });
  }
}

function legacyPayload(subscription, event) {
  return Object.freeze(redactExtensionData({
    event: subscription.event, phase: subscription.phase,
    session_id: event.session_id, turn_id: event.turn_id, step_id: event.step_id,
    tool_request_id: event.tool_request_id, ...event.payload,
  }));
}

export function hookContexts(dispatch) {
  return Object.freeze((dispatch?.results ?? []).filter((item) => typeof item?.additionalContext === 'string')
    .map((item) => Object.freeze({ source: item.hook, content: redactText(item.additionalContext) })));
}
