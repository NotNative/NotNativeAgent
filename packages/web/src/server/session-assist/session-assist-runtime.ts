// SPDX-License-Identifier: Apache-2.0
/** Live H.2 assist lifecycle: idle arms, activity and runtime changes invalidate. */
import type { QueueEnvelope, QueueFeed } from '../queue/queue-feed.ts';
import {
  ASSIST_RECAP_CHAR_LIMIT,
  ASSIST_SUGGESTION_CHAR_LIMIT,
  mergeAssistIntoMetadata,
  type AssistPayload,
} from './assist-metadata.ts';

export const ASSIST_QUIET_MS = 60_000;
export const ASSIST_GENERATION_TIMEOUT_MS = 120_000;

export interface SessionAssistPorts {
  readSession(sessionId: string, directory: string): Promise<unknown>;
  readMessages(sessionId: string, directory: string): Promise<unknown>;
  writeMetadata(sessionId: string, directory: string, metadata: Record<string, unknown>): Promise<boolean>;
  generate(input: {
    sessionId: string;
    directory: string;
    model: { providerID: string; modelID: string } | null;
    transcript: string;
  }): Promise<{ recap: unknown; suggestion: unknown } | null>;
}

interface Timed { timer: ReturnType<typeof setTimeout>; at: number }

export type SessionAssistTickResult = { kind: 'wait' | 'written' | 'conflict'; reason?: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function completedAssistantTail(messages: unknown): { id: string; text: string } | null {
  const last = record(Array.isArray(messages) ? messages.at(-1) : null);
  const info = record(last?.info);
  if (info?.role !== 'assistant' || typeof info.id !== 'string' || info.id === ''
    || !Number.isFinite(record(info.time)?.completed)) return null;
  if (!Array.isArray(last?.parts)) return null;
  return {
    id: info.id,
    text: last.parts.flatMap((part) => {
      const item = record(part);
      return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
    }).join('\n'),
  };
}

export class SessionAssistRuntime {
  private readonly feed: QueueFeed;
  private readonly ports: SessionAssistPorts;
  private readonly enabled: () => boolean;
  private readonly timing: { quietMs: number };
  private readonly timers = new Map<string, Timed>();
  private readonly directories = new Map<string, string>();
  private readonly inFlight = new Set<string>();
  private readonly generations = new Map<string, number>();
  private readonly pending = new Map<string, number>();
  private readonly armedAt = new Map<string, number>();
  private unsubs: Array<() => void> = [];
  private stopped = false;

  constructor(
    feed: QueueFeed,
    ports: SessionAssistPorts,
    enabled: () => boolean,
    timing: { quietMs: number } = { quietMs: ASSIST_QUIET_MS },
  ) {
    this.feed = feed;
    this.ports = ports;
    this.enabled = enabled;
    this.timing = timing;
  }

  start(): void {
    this.unsubs.push(this.feed.onEvent((envelope) => this.onEvent(envelope)));
  }

  dispose(): void {
    this.stopped = true;
    for (const id of [...this.timers.keys()]) this.clear(id);
    for (const unsubscribe of this.unsubs) unsubscribe();
    this.unsubs = [];
    this.armedAt.clear();
    this.directories.clear();
    this.generations.clear();
    this.pending.clear();
  }

  settingsChanged(): void {
    if (this.stopped) return;
    if (this.enabled()) return;
    const exceptions: unknown[] = [];
    for (const id of [...this.directories.keys()]) {
      try {
        this.invalidate(id);
      } catch (error) {
        exceptions.push(error);
      }
    }
    this.armedAt.clear();
    this.generations.clear();
    this.pending.clear();
    if (exceptions.length > 0) throw exceptions[0];
  }

  private remember(id: string, directory: unknown): boolean {
    if (typeof directory === 'string' && directory !== '') this.directories.set(id, directory);
    return this.directories.has(id);
  }

  private onEvent(envelope: QueueEnvelope): void {
    if (this.stopped) return;
    const properties = record(envelope.payload?.properties);
    const id = properties?.sessionID ?? properties?.sessionId;
    if (typeof id !== 'string' || id === '') return;
    if (envelope.payload.type === 'session.deleted') { this.forget(id); return; }
    const info = record(properties?.info);
    if (!this.remember(id, envelope.directory ?? info?.directory)) return;
    if (!this.enabled()) { this.invalidate(id); return; }
    if (envelope.payload.type === 'session.status') {
      const type = record(properties?.status)?.type;
      if (type === 'idle') this.arm(id);
      else this.invalidate(id);
    }
    if (envelope.payload.type === 'message.updated' && info?.role === 'user'
      && !this.timers.has(id)) {
      const createdAt = record(info.time)?.created;
      const at = this.armedAt.get(id) ?? Number.NEGATIVE_INFINITY;
      if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt > at) {
        this.invalidate(id);
      }
    }
  }

  private forget(id: string): void {
    this.invalidate(id);
    this.clear(id);
    this.armedAt.delete(id);
    this.directories.delete(id);
  }

  private clear(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer.timer);
    this.timers.delete(id);
  }

  private invalidate(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.pending.delete(id);
    this.clear(id);
    this.armedAt.delete(id);
  }

  private arm(id: string): void {
    if (this.inFlight.has(id)) {
      this.pending.set(id, Math.min(this.timing.quietMs, this.pending.get(id) ?? Number.POSITIVE_INFINITY));
      return;
    }
    const at = Date.now() + this.timing.quietMs;
    const previous = this.timers.get(id);
    if (previous?.at === at) return;
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => { this.timers.delete(id); this.armedAt.delete(id); void this.tick(id); },
      this.timing.quietMs);
    timer.unref?.();
    this.timers.set(id, { timer, at });
    this.armedAt.set(id, Date.now());
  }

  private armPending(id: string, delay: number): void {
    const timer = setTimeout(() => { this.timers.delete(id); void this.tick(id); }, Math.max(1, delay));
    timer.unref?.();
    this.timers.set(id, { timer, at: Date.now() + Math.max(0, delay) });
  }

  async tick(id: string): Promise<SessionAssistTickResult> {
    if (this.stopped || !this.enabled()) return { kind: 'wait', reason: 'runtime inactive' };
    if (this.inFlight.has(id)) {
      this.pending.set(id, Math.min(this.timing.quietMs, this.pending.get(id) ?? Number.POSITIVE_INFINITY));
      return { kind: 'wait', reason: 'tick in flight' };
    }
    const directory = this.directories.get(id);
    if (!directory) return { kind: 'wait', reason: 'directory unavailable' };
    this.inFlight.add(id);
    const generation = this.generations.get(id) ?? 0;
    const stillCurrent = (): boolean => !this.stopped && this.enabled()
      && generation === this.generations.get(id)
      && this.directories.get(id) === directory && this.inFlight.has(id);
    try {
      const session = await this.ports.readSession(id, directory);
      const shape = record(session);
      if (!stillCurrent()) return { kind: 'wait', reason: 'generation changed' };
      if (!shape || shape.id !== id || shape.parentID || shape.archived) {
        return { kind: 'wait', reason: 'session unavailable' };
      }
      const messages = await this.ports.readMessages(id, directory);
      if (!stillCurrent()) return { kind: 'wait', reason: 'generation changed' };
      const tail = completedAssistantTail(messages);
      if (!tail) return { kind: 'wait', reason: 'assistant tail unavailable' };
      const route = record(record(shape.info)?.route);
      const model = record(record(route?.primary)?.model);
      const providerID = typeof model?.providerID === 'string' && model.providerID !== '' ? model.providerID : '';
      const modelID = typeof model?.modelID === 'string' && model.modelID !== '' ? model.modelID : '';
      const preferredModel = providerID !== '' && modelID !== '' ? { providerID, modelID } : null;
      const result = await this.ports.generate({
        sessionId: id, directory, model: preferredModel, transcript: tail.text,
      });
      if (result === null || !stillCurrent()) return { kind: 'wait', reason: 'generation refused or stale' };
      const recap = typeof result.recap === 'string' ? result.recap.trim() : '';
      const suggestion = typeof result.suggestion === 'string' ? result.suggestion.trim() : '';
      if (recap === '' && suggestion === '') return { kind: 'wait', reason: 'empty assist' };
      const payload: AssistPayload = {
        recap: recap.slice(0, ASSIST_RECAP_CHAR_LIMIT),
        suggestion: suggestion.slice(0, ASSIST_SUGGESTION_CHAR_LIMIT),
        forMessageID: tail.id,
        generatedAt: Date.now(),
      };
      const fresh = await this.ports.readSession(id, directory);
      const freshShape = record(fresh);
      if (!freshShape || freshShape.id !== id || !stillCurrent()) return { kind: 'conflict' };
      const freshMessages = await this.ports.readMessages(id, directory);
      const freshTail = completedAssistantTail(freshMessages);
      if (!freshTail || freshTail.id !== tail.id || !stillCurrent()) return { kind: 'conflict' };
      const metadata = mergeAssistIntoMetadata(
        freshShape.metadata as Record<string, unknown> | undefined, payload,
      );
      const written = await this.ports.writeMetadata(id, directory, metadata);
      return written ? { kind: 'written' } : { kind: 'conflict' };
    } catch {
      return { kind: 'wait', reason: 'assist dependency unavailable' };
    } finally {
      this.deleteInFlight(id, directory);
    }
  }

  private deleteInFlight(id: string, directory: string): void {
    const isActive = this.inFlight.has(id);
    if (isActive) this.inFlight.delete(id);
    if (!isActive) return;
    if (this.stopped || !this.enabled() || this.directories.get(id) !== directory) {
      this.pending.delete(id);
      return;
    }
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (pending !== undefined) this.armPending(id, pending);
  }
}
