// SPDX-License-Identifier: Apache-2.0
/**
 * Harness event feed for server-owned runtimes (doc 12 §D.3 wiring: the
 * message-queue runtime is created AFTER the event hub; NND has no hub
 * module yet, so the queue taps the harness event stream through the
 * adapter seam — `GET /api/global/event` — and re-tries with backoff.
 * Tests inject `ManualQueueFeed` and drive events in-process.
 */
import { HARNESS_INTERNAL_ORIGIN, callHarness } from './queue-adapter-calls.ts';

export interface QueueEnvelope {
  directory?: string;
  payload: { id: string; type: string; properties: Record<string, unknown> };
}

export type QueueEventListener = (envelope: QueueEnvelope) => void;

export interface QueueFeed {
  /** Pump start (fire and forget); interrupts ride the reconnect loop. */
  start?(): void;
  onEvent(listener: QueueEventListener): () => void;
  onConnected(listener: () => void): () => void;
  stop?(): void;
}

/** In-process feed seams: `emit` and `connected` stay synchronous so tests
 *  (and any future producer) drive the runtime deterministically. */
export class ManualQueueFeed implements QueueFeed {
  private listeners = new Set<QueueEventListener>();
  private connectedListeners = new Set<() => void>();

  emit(envelope: QueueEnvelope): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(envelope);
      } catch {
        /* a broken listener must never break the feed */
      }
    }
  }

  connected(): void {
    for (const listener of [...this.connectedListeners]) {
      try {
        listener();
      } catch {
        /* same containment */
      }
    }
  }

  onEvent(listener: QueueEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onConnected(listener: () => void): () => void {
    this.connectedListeners.add(listener);
    return () => this.connectedListeners.delete(listener);
  }
}

const FEED_RECONNECT_DELAY_MS = 2_000;

const sleep = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));

/** Parses one SSE frame block into a queue envelope, or null for noise. */
export function parseFeedFrame(block: string): QueueEnvelope | null {
  const dataLines = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  if (dataLines.length === 0) return null;
  try {
    const parsed = JSON.parse(dataLines.join('\n')) as QueueEnvelope;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.payload || typeof parsed.payload.type !== 'string') return null;
    return { directory: parsed.directory, payload: parsed.payload };
  } catch {
    return null;
  }
}

/** Real pump: consumes the harness event stream through the adapter seam
 *  and re-connects on any close/failure; notifies `connected` on every
 *  successful (re)open so the runtime can reconcile (§D.3). */
export class AdapterQueueFeed implements QueueFeed {
  private listeners = new Set<QueueEventListener>();
  private connectedListeners = new Set<() => void>();
  private stopped = false;
  private buffer = '';

  start(): void {
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.listeners.clear();
    this.connectedListeners.clear();
  }

  onEvent(listener: QueueEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onConnected(listener: () => void): () => void {
    this.connectedListeners.add(listener);
    return () => this.connectedListeners.delete(listener);
  }

  private emit(envelope: QueueEnvelope): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(envelope);
      } catch {
        /* containment: any feed consumer failure is isolated */
      }
    }
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const response = await callHarness(new Request(`${HARNESS_INTERNAL_ORIGIN}/api/global/event`));
        if (!response.ok || !response.body) throw new Error(`queue feed open failed: ${response.status}`);
        for (const listener of [...this.connectedListeners]) {
          try {
            listener();
          } catch {
            /* containment */
          }
        }
        await this.pump(response.body);
      } catch {
        if (this.stopped) return;
        await sleep(FEED_RECONNECT_DELAY_MS);
      }
    }
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    this.buffer = '';
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      this.buffer += decoder.decode(next.value, { stream: true });
      for (;;) {
        const boundary = this.buffer.indexOf('\n\n');
        if (boundary < 0) break;
        const frame = parseFeedFrame(this.buffer.slice(0, boundary));
        this.buffer = this.buffer.slice(boundary + 2);
        if (frame) this.emit(frame);
      }
    }
  }
}
