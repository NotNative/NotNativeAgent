// SPDX-License-Identifier: Apache-2.0
/**
 * P9-1 test seams (doc 12 message queue): an in-process fake harness
 * adapter (session status / 2-message tail / command catalog / command +
 * prompt_async send records with canned outcomes and a held-send gate),
 * a manual event feed, a control-bus spy, item builders, and a small
 * runtime factory. Never spawns a real server.
 */
import { join as joinPath } from 'node:path';
import { registerHarnessAdapter, harnessError, type HarnessAdapter } from '../../harness/adapter.ts';
import { subscribeControlEvents, type ControlEvent } from '../../lib/bus.ts';
import { ManualQueueFeed, type QueueEnvelope } from '../../queue/queue-feed.ts';
import { MessageQueueStore, QUEUE_FILE_NAME } from '../../queue/queue-store.ts';
import { MessageQueueRuntime, QUEUE_TIMING, type QueueTimingOverride } from '../../queue/queue-runtime.ts';
import { NULL_KNOWLEDGE_PROVIDER, type ProjectKnowledgeProvider } from '../../queue/queue-hooks.ts';

export type { ProjectKnowledgeProvider };

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export type FakeSendOutcome = { kind: 'ok' } | { kind: 'fail'; status: number } | { kind: 'hold' };

export interface FakeSendRecord {
  sessionId: string;
  route: 'command' | 'prompt_async';
  body: Record<string, unknown>;
}

/** Fake harness adapter: only the endpoints the queue runtime calls. */
export class FakeQueueHarness implements HarnessAdapter {
  readonly sends: FakeSendRecord[] = [];
  readonly servedPaths: string[] = [];
  statusFailure = false;
  tailFailure = false;
  statusPayload: unknown = {};
  tailPayload: unknown = [];
  catalog: Array<Record<string, unknown>> = [];
  outcomes: FakeSendOutcome[] = [];
  private heldResolvers: Array<(response: Response) => void> = [];
  private statusGates: Array<(response: Response) => void> = [];
  private gateNextStatus = false;

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, '');
    const method = request.method.toUpperCase();
    this.servedPaths.push(`${method} ${path}`);
    if (method === 'GET' && path === '/session/status') {
      if (this.gateNextStatus) {
        this.gateNextStatus = false;
        return new Promise<Response>((resolvePromise) => this.statusGates.push(resolvePromise));
      }
      return this.statusFailure ? harnessError('fake status failure', 502) : json(this.statusPayload);
    }
    if (method === 'GET' && path === '/command') return json(this.catalog);
    const messageMatch = /^\/session\/([^/]+)\/message$/.exec(path);
    if (messageMatch && method === 'GET') {
      return this.tailFailure ? harnessError('fake tail failure', 502) : json(this.tailPayload);
    }
    const sendMatch = /^\/session\/([^/]+)\/(command|prompt_async)$/.exec(path);
    if (sendMatch && method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const route = String(sendMatch[2]) as FakeSendRecord['route'];
      this.sends.push({ sessionId: decodeURIComponent(String(sendMatch[1])), route, body });
      return this.respondForSend(route);
    }
    return harnessError(`fake harness: unhandled ${method} ${path}`, 404);
  }

  private respondForSend(route: 'command' | 'prompt_async'): Promise<Response> {
    const outcome = this.outcomes.shift() ?? { kind: 'ok' as const };
    if (outcome.kind === 'fail') return Promise.resolve(harnessError('fake send failure', outcome.status));
    if (outcome.kind === 'hold') {
      return new Promise<Response>((resolvePromise) => this.heldResolvers.push(resolvePromise));
    }
    return Promise.resolve(route === 'prompt_async' ? new Response(null, { status: 204 }) : json({ info: {} }));
  }

  enqueueOutcome(outcome: FakeSendOutcome): void {
    this.outcomes.push(outcome);
  }

  /** Park the NEXT /session/status fetch so a mutation can race the tick. */
  gateNextStatusCheck(): void {
    this.gateNextStatus = true;
  }

  /** Parked status checks the tick currently waits on. */
  get parkedStatusChecks(): number {
    return this.statusGates.length;
  }

  releaseStatusChecks(): void {
    const resolvers = [...this.statusGates];
    this.statusGates = [];
    for (const resolvePromise of resolvers) resolvePromise(json(this.statusPayload));
  }

  /** Gate: the NEXT POST resolves only after releaseHeldSends(). */
  get heldCount(): number {
    return this.heldResolvers.length;
  }

  releaseHeldSends(status = 204): void {
    const resolvers = [...this.heldResolvers];
    this.heldResolvers = [];
    for (const resolvePromise of resolvers) resolvePromise(new Response(null, { status }));
  }
}

/** Registry convenience for tests that pass through the app gate. */
export function installFakeHarness(harness: FakeQueueHarness): void {
  registerHarnessAdapter(harness);
}

/** Manual feed: tests drive envelopes + connect notifications directly. */
export { ManualQueueFeed as FakeQueueFeed };

export function feedEnvelope(sessionId: string, type: string, properties: Record<string, unknown>, directory = 'D:/work/app'): QueueEnvelope {
  return { directory, payload: { id: String(properties.id ?? 1), type, properties: { sessionID: sessionId, ...properties } } };
}

/** Control-bus spy: keeps every `notnative:*` frame it observed. */
export class ControlBusSpy {
  readonly records: ControlEvent[] = [];
  private unsubscribe: (() => void) | null = null;

  start(): this {
    this.unsubscribe = subscribeControlEvents((event) => this.records.push(event));
    return this;
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  updates(): Array<{ type: string; payload: { revision: number; session: string } }> {
    return this.records
      .filter((event) => event.type === 'notnative:message-queue.updated')
      .map((event) => event as unknown as { type: string; payload: { revision: number; session: string } });
  }

  clear(): void {
    this.records.length = 0;
  }
}

export function rawItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    content: 'queued text',
    sendConfig: { providerID: 'nnd-mock', modelID: 'mock-smart' },
    ...overrides,
  };
}

export const WORK_TREE = 'D:/work/app';

/** Compact runtime factory with test timings; caller owns dispose(). */
export function makeQueueRuntime(
  feed: ManualQueueFeed,
  dataDir: string,
  timing: QueueTimingOverride = {},
  knowledge: ProjectKnowledgeProvider = NULL_KNOWLEDGE_PROVIDER,
): MessageQueueRuntime {
  const store = new MessageQueueStore(joinPath(dataDir, QUEUE_FILE_NAME));
  return new MessageQueueRuntime(store, feed, knowledge, { ...QUEUE_TIMING, ...timing });
}

/** Polling wait for feed/timer-driven behavior (real timers in tests). */
export async function waitUntil(predicate: () => boolean, timeoutMs = 2000, stepMs = 10, describeTimeout?: () => string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      const detail = describeTimeout ? ` [${describeTimeout()}]` : '';
      throw new Error(`waitUntil timed out${detail}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, stepMs));
  }
}

export const SHORT_TIMING: QueueTimingOverride = {
  quietMs: 10,
  verifyBackoffMs: 80,
  abortHoldMs: 150,
  backoffBaseMs: 60, // keeps failure ladders fast in tests; the formula/cap is pinned by failureDelayMs
};

/** Assistant `message.updated` info builders (mock-wire shapes). */
export function assistantInfo(options: { completed?: boolean; aborted?: boolean } = {}): Record<string, unknown> {
  const info: Record<string, unknown> = { role: 'assistant', time: { created: Date.now() } };
  if (options.completed) (info.time as Record<string, unknown>).completed = Date.now();
  if (options.aborted) info.error = { name: 'MessageAbortedError', data: { message: 'aborted' } };
  return info;
}

/** Fake knowledge seam recording `recordDelivered` per §D.3.6. */
export function fakeKnowledge(): ProjectKnowledgeProvider & { state: { delivered: number; fail: boolean; text: string | null } } {
  const state = { delivered: 0, fail: false, text: 'project knowledge body' as string | null };
  return {
    state,
    resolve: () => {
      if (state.fail) throw new Error('knowledge lookup failed');
      return state.text;
    },
    recordDelivered: () => {
      state.delivered += 1;
    },
  };
}
