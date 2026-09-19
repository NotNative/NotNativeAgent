// SPDX-License-Identifier: Apache-2.0
// In-process fake relay "broker/host" half for tunnel-client tests. It
// speaks the SAME primitives as the client mirror (shared ui crypto +
// codec), answers one legal hello per leg, and drives the wire back:
// HttpResponse/HttpBody/StreamEnd, fragmented WsText/WsBinary, WsOpen/Ws
// Close, StreamAbort, and it keeps the Â§3.8 host-ack ledger (cumulative
// nonzero raw frame bytes) plus the latest DeliveryAck the client sent.
import {
  decodeHandshakeHello, encodeHandshakeReady, deriveSessionKeys, openSession, encryptFrame,
  decryptFrame, generateEphemeralKeypair, type OpenedSession, type RelayJwk,
} from '../crypto.ts';
import { decodeFrameOrContainer, encodeTunnelFrame, TunnelFrameType } from '../tunnel-codec.ts';
import { utf8Bytes, utf8Text } from '../bytes.ts';

export interface FakeWire {
  deliverText(text: string): void;
  deliverBytes(bytes: Uint8Array): void;
  onclose: ((event: { code: number; reason: string | undefined }) => void) | null;
}

export interface HttpRequestHead {
  method: string;
  path: string;
  headers: Record<string, string>;
  hasBody?: boolean;
}

export interface FakeHost {
  /** Every decoded clientâ†’host frame in wire order (test assertions). */
  saw: Array<{ type: number; streamId: number; payload: Uint8Array }>;
  requests: HttpRequestHead[];
  bodyBytesByStream: Map<number, Uint8Array[]>;
  wsMessages: Map<number, Array<{ text: string; binary: boolean }>>;
  wsCloses: Map<number, { code: number; reason: string }>;
  acks: number[];
  lastPingAt: number;
  rawSentBytes: number;
  established: boolean;
}

export class FakeBroker {
  session: OpenedSession | null = null;
  host: FakeHost = {
    saw: [], requests: [], bodyBytesByStream: new Map(), wsMessages: new Map(), wsCloses: new Map(),
    acks: [], lastPingAt: -1, rawSentBytes: 0, established: false,
  };
  private outbox: Promise<void> = Promise.resolve();
  private inbound: Promise<void> = Promise.resolve();
  private nonce = '';

  constructor(
    readonly wire: FakeWire,
    private readonly hostKeys: { privateJwk: RelayJwk; publicJwk: RelayJwk },
  ) {}

  async onClientMessage(data: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    // Serialize the wire order (the decrypt counter check requires it, Â§3.4).
    const run = this.inbound.then((): Promise<void> => this.processClientMessage(data));
    this.inbound = run.catch(() => undefined);
    await run;
  }

  private async processClientMessage(data: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    if (typeof data === 'string') {
      const hello = decodeHandshakeHello(utf8Bytes(data));
      if (hello === null) return; // junk text before establishment is ignored
      this.nonce = hello.nonce;
      const keys = await deriveSessionKeys(this.hostKeys.privateJwk, hello.clientPubJwk, this.nonce);
      this.session = openSession(keys);
      this.host.established = true;
      this.wire.deliverText(utf8Text(encodeHandshakeReady({ batch: true, flowControl: false })));
      return;
    }
    const session = this.session;
    if (session === null) return;
    const bytes = bytesOf(data);
    const plaintext = await decryptFrame(session.clientToHost, bytes);
    const decoded = decodeFrameOrContainer(plaintext);
    if (decoded === null) return;
    for (const frame of decoded.frames) this.hostFrame(frame);
  }

  private hostFrame(frame: { type: number; streamId: number; payload: Uint8Array }): void {
    this.host.saw.push({ type: frame.type, streamId: frame.streamId, payload: frame.payload });
    if (frame.streamId === 0) {
      if (frame.type === TunnelFrameType.Ping) this.host.lastPingAt = Date.now();
      if (frame.type === TunnelFrameType.DeliveryAck) {
        this.host.acks.push(decodeCumulative8B(frame.payload));
      }
      return;
    }
    switch (frame.type) {
      case TunnelFrameType.HttpRequest: {
        const head = JSON.parse(utf8Text(frame.payload)) as HttpRequestHead;
        this.host.requests.push(head);
        break;
      }
      case TunnelFrameType.HttpBody: {
        const list = this.host.bodyBytesByStream.get(frame.streamId) ?? [];
        list.push(frame.payload);
        this.host.bodyBytesByStream.set(frame.streamId, list);
        break;
      }
      case TunnelFrameType.StreamEnd:
      case TunnelFrameType.StreamAbort:
        return; // terminal markers need no bookkeeping in the fake
      case TunnelFrameType.WsText:
      case TunnelFrameType.WsBinary: {
        const list = this.host.wsMessages.get(frame.streamId) ?? [];
        list.push({ text: utf8Text(frame.payload), binary: frame.type === TunnelFrameType.WsBinary });
        this.host.wsMessages.set(frame.streamId, list);
        break;
      }
      case TunnelFrameType.WsClose: {
        const close = JSON.parse(utf8Text(frame.payload)) as { code: number; reason?: string };
        this.host.wsCloses.set(frame.streamId, { code: close.code, reason: close.reason ?? '' });
        break;
      }
      default:
        break;
    }
  }

  /** Encrypted brokerâ†’client send; raw nonzero counts book the ledger. */
  sendFrame(type: number, streamId: number, payload: Uint8Array, hasMore = false): Promise<void> {
    const session = this.session;
    if (session === null) throw new Error('fake broker not established');
    const raw = encodeTunnelFrame({ type, streamId, hasMore, payload });
    const rawBytes = raw.length;
    const run = this.outbox.then(async (): Promise<void> => {
      if (streamId !== 0) this.host.rawSentBytes += rawBytes;
      const encrypted = await encryptFrame(session.hostToClient, raw);
      this.wire.deliverBytes(encrypted);
    });
    this.outbox = run.catch(() => undefined);
    return run;
  }
}

export function bytesOf(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  const view = data as ArrayBufferView<ArrayBuffer>;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function decodeCumulative8B(payload: Uint8Array): number {
  let value = 0n;
  for (let i = 0; i < 8; i += 1) value = (value << 8n) | BigInt(payload[i] ?? 0);
  return Number(value);
}

/** Â§3.4 host key material (pairing-identity stand-in for the tests). */
export async function makeHostKeys(): Promise<{ privateJwk: RelayJwk; publicJwk: RelayJwk }> {
  return await generateEphemeralKeypair();
}

/** Repeatedly evaluates |condition| until it holds or |ms| elapses. */
export async function until(condition: () => boolean, ms = 5000, step = 5): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, step));
  }
}
