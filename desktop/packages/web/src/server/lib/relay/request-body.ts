// SPDX-License-Identifier: Apache-2.0
/**
 * Relay host dispatcher's client request-body buffer (doc 08 section 3.9,
 * sliced out of dispatcher.ts for the 500-line package cap). Bodies ≤ 512
 * KiB land as ONE concatenated loopback body at StreamEnd; crossing the
 * cap switches to a live web ReadableStream (the buffered prefix enqueues
 * first). While buffering, frames must keep arriving before the delivery
 * deadline; past the switch the deadline does not apply.
 */
import { Buffer } from 'node:buffer';
import { MAX_TUNNEL_PAYLOAD_BYTES } from './crypto.ts';
import { chunkPayload } from './tunnel-codec.ts';

export const RESPONSE_BODY_CHUNK_BYTES = MAX_TUNNEL_PAYLOAD_BYTES; // legacy budget when flow control is off

interface LiveBodyController {
  enqueue(chunk: Uint8Array): void;
  close(): void;
  error(reason?: unknown): void;
}

export class TunnelRequestBody {
  chunks: Buffer[] = [];
  bytes = 0;
  crossed = false;
  framesReceived = 0;
  deadlineTimer: NodeJS.Timeout | null = null;
  private controller: LiveBodyController | null = null;
  private arrived: Buffer[] = []; // live chunks seen before `start` ran
  private closed = false;

  /** Single concatenated body (content-length framing, never chunked). */
  bufferedBody(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** Live web stream: prefix flushes first, chunks arrive via `push`,
   * `close` ends it, `fail` aborts the loopback transfer. */
  requestStream(prefix: Buffer): ReadableStream<Uint8Array> {
    const body = this;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        body.controller = controller as unknown as LiveBodyController;
        if (prefix.length === 0) controller.enqueue(new Uint8Array(0));
        else for (const piece of chunkPayload(prefix, RESPONSE_BODY_CHUNK_BYTES)) controller.enqueue(piece);
        for (const chunk of body.arrived.splice(0)) controller.enqueue(chunk);
        if (body.closed) body.controller = null;
      },
      pull() { /* chunks enqueue eagerly; undici paces the transfer */ },
    });
  }

  push(chunk: Buffer): void {
    if (this.closed) return; // StreamEnd already passed; late frames never reach the loopback
    const controller = this.controller;
    if (controller === null) {
      this.arrived.push(chunk);
      return;
    }
    try {
      controller.enqueue(chunk);
    } catch {
      this.closed = true; // the transfer died server-side; keep client frames dropping
    }
  }

  close(): void {
    this.closed = true;
    const controller = this.controller;
    this.controller = null;
    if (controller === null) return;
    try {
      controller.close();
    } catch {
      // already closed by the consumer
    }
  }

  fail(reason: string): void {
    const controller = this.controller;
    this.controller = null;
    this.arrived = [];
    if (controller === null) return;
    this.closed = true;
    try {
      controller.error(new Error(reason));
    } catch {
      // already errored/closed
    }
  }

  clearDeadline(): void {
    if (this.deadlineTimer === null) return;
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = null;
  }
}
