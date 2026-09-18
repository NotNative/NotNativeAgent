// SPDX-License-Identifier: Apache-2.0
/**
 * Relay leg host (doc 08 sections 3.5-3.9 assembly, step 8 tail): the
 * per-connection L3 machinery that rides one established E2EE leg.
 * Ingress: one decrypted plaintext message per broker frame — a single
 * tunnel frame ([0x00]) or a batch container ([0x01]) — is decoded, WS
 * fragmented messages are reassembled, and the frames feed the host
 * dispatcher (§3.9). Egress: dispatcher frames pass the §3.7 outbound
 * batcher (when the `batch` capability was negotiated) before one
 * encrypted broker message per container. Channel-level failures close
 * the leg 1011 exactly once.
 */
import {
  createFragmentAssembler,
  decodeTunnelFrame,
  type TunnelFrame,
} from './tunnel-codec.ts';
import { decodeFrameOrContainer, createOutboundFrameBatcher, type OutboundBatcherOptions, type OutboundFrameBatcher } from './batch.ts';
import { createTunnelHost, type TunnelHost } from './dispatcher.ts';
import type { CapabilityOptions } from './handshake.ts';
import type { RelayHostSocketLikeFactory } from './dispatcher-ws.ts';
import { createLoopbackSocketFactory } from './loopback-adapters.ts';
import { readEnvBatchWindowMs } from './relay-config.ts';

export interface RelayLegHostDeps {
  connectionId: string;
  localPort: number;
  /** §3.8/§3.9 carrier: one encrypted broker message per call. */
  send: (plaintext: Uint8Array) => Promise<void> | void;
  /** §3.9: channel-level failures close the relay leg (1011), once. */
  onChannelFailure: (reason: string) => void;
  /** The NEGOTIATED capability set (both-peers-advertise; §3.4). */
  capabilities: CapabilityOptions;
  /** Loopback socket dials for the WS mux; tests inject fakes. */
  wsFactory?: RelayHostSocketLikeFactory;
}

export interface RelayLegHost {
  acceptPlaintext(plaintext: Uint8Array): void;
  dispose(): void;
}

/** §3.7 host batcher options: the env window override (§11.2 row) feeds
 * the production gate; tests override the batcher directly. */
export function legBatchOptions(): OutboundBatcherOptions {
  return { windowMs: readEnvBatchWindowMs() };
}

export function createRelayLegHost(deps: RelayLegHostDeps): RelayLegHost {
  return new RelayLegHostImpl(deps);
}

class RelayLegHostImpl implements RelayLegHost {
  private failed = false;
  private readonly assembler = createFragmentAssembler();
  private readonly batcher: OutboundFrameBatcher | null;
  private readonly batching: boolean;
  private readonly host: TunnelHost;
  private readonly deps: RelayLegHostDeps;
  private ingressChain: Promise<void> = Promise.resolve();

  constructor(deps: RelayLegHostDeps) {
    this.deps = deps;
    this.batching = deps.capabilities.batch;
    this.batcher = this.batching
      ? createOutboundFrameBatcher((bytes) => this.deps.send(bytes), legBatchOptions())
      : null;
    this.host = createTunnelHost({
      localPort: deps.localPort,
      connectionId: deps.connectionId,
      send: (plaintext) => this.sendOut(Buffer.from(plaintext)),
      flowControl: deps.capabilities.flowControl,
      onChannelFailure: (reason) => this.fail(reason),
      wsFactory: deps.wsFactory ?? createLoopbackSocketFactory(),
    });
  }

  /** Inbound entry (broker L2 decrypt): one plaintext message. */
  acceptPlaintext(plaintext: Uint8Array): void {
    if (this.failed) return;
    const bytes = plaintext;
    this.ingressChain = this.ingressChain
      .then(() => this.ingestPlaintext(bytes))
      .catch((error: unknown) => this.fail(`relay tunnel parsing failed: ${messageOf(error)}`));
  }

  dispose(): void {
    this.failed = true;
    this.batcher?.dispose();
    this.host.dispose();
    this.ingressChain = Promise.resolve();
  }

  private async ingestPlaintext(plaintext: Uint8Array): Promise<void> {
    const frames = acceptPlainBytes(Buffer.from(plaintext));
    for (const frameBytes of frames) {
      let frame: TunnelFrame;
      try {
        frame = decodeTunnelFrame(frameBytes);
        const assembled = this.assembler.push(frame);
        if (assembled === null) continue;
        frame = { type: assembled.type, streamId: assembled.streamId, hasMore: false, payload: assembled.payload };
      } catch (error) {
        this.fail(`relay tunnel framing violated: ${messageOf(error)}`);
        return;
      }
      await this.host.handleFrame(frame);
    }
  }

  /** The dispatcher's carrier: frames may batch into one message. */
  private async sendOut(bytes: Buffer): Promise<void> {
    if (this.batcher !== null) {
      try {
        await this.batcher.offerEncoded(bytes); // offerEncoded chains already collapse into fail()
      } catch (error) {
        this.fail(`relay leg send failed: ${messageOf(error)}`);
      }
      return;
    }
    try {
      await this.deps.send(bytes); // direct carrier rejects when the broker leg is gone
    } catch (error) {
      this.fail(`relay leg send failed: ${messageOf(error)}`);
    }
  }

  private fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    this.dispose();
    this.deps.onChannelFailure(reason);
  }
}

/** Decodes one L2 plaintext message into its tunnel frames ([0x00]/
 * [0x01] containers, or a bare §3.7 setup frame); junk is a channel
 * failure. */
function acceptPlainBytes(plaintext: Buffer): Buffer[] {
  const decoded = decodeFrameOrContainer(plaintext);
  if (decoded === null) throw new Error('unrecognized relay tunnel container');
  return decoded.kind === 'single' ? [decoded.frame] : decoded.frames;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
