// SPDX-License-Identifier: Apache-2.0
/**
 * Relay client handshake initiator (doc 08 §3.4, client side). Build the
 * hello once per attempt (fresh ephemeral ECDH key + 16 B nonce), send it
 * on socket open, re-send on the retry cadence until the ready arrives;
 * the overall deadline (30 s) fails the attempt. Mirrors the host-side
 * initiator in packages/web exactly (send grammar: initial + retry + one
 * final resend). Duplicate ready after establishment is ignored; foreign
 * pre-establishment plaintext is ignored as relay control noise, never
 * torn down. Capability flags negotiate only when BOTH peers advertise.
 */
import {
  generateEphemeralKeypair, randomNonceB64url, deriveSessionKeys, openSession,
  encodeHandshakeHello, decodeHandshakeReady, type DecodedReady, type OpenedSession, type RelayJwk,
} from './crypto.ts';

export const HOST_CLIENT_CLOSE_CHANNEL = 1011;

export type NegotiatedCapabilities = { batch: boolean; flowControl: boolean };

/** Capabilities negotiate only when BOTH peers advertise (§3.4). */
export function negotiate(helloSide: NegotiatedCapabilities, ready: DecodedReady): NegotiatedCapabilities {
  return {
    batch: helloSide.batch === true && ready.batch === true,
    flowControl: helloSide.flowControl !== false && ready.flowControl === true,
  };
}

export interface ClientInitiatorOptions {
  hostEncPublicJwk: RelayJwk; // the E2EE trust anchor from the pairing payload (§3.2)
  capabilities: NegotiatedCapabilities;
  sendText: (bytes: Uint8Array) => void;
  onClose: (closeCode: number, reason: string) => void;
  onEstablished: (established: {
    session: OpenedSession;
    capabilities: NegotiatedCapabilities;
    helloText: Uint8Array;
  }) => void;
  helloRetryMs?: number;
  helloTimeoutMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface ClientInitiator {
  start(): Promise<void>;
  onText(text: Uint8Array): Promise<void>;
  onBinary(): void;
  stop(): void;
  established: boolean;
}

interface InitiatorState {
  established: boolean;
  ephemeralPublicJwk: RelayJwk | null;
  ephemeralPrivateJwk: RelayJwk | null;
  nonceB64url: string;
  helloText: Uint8Array | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
}

/** Build the hello once per attempt (fresh ephemeral ECDH key + nonce). */
async function buildHello(options: ClientInitiatorOptions, state: InitiatorState): Promise<Uint8Array> {
  if (state.helloText !== null) return state.helloText;
  const pair = await generateEphemeralKeypair();
  state.ephemeralPublicJwk = pair.publicJwk;
  state.ephemeralPrivateJwk = pair.privateJwk;
  state.nonceB64url = randomNonceB64url();
  state.helloText = encodeHandshakeHello({
    clientPubJwk: pair.publicJwk,
    nonceB64url: state.nonceB64url,
    batch: options.capabilities.batch,
    flowControl: options.capabilities.flowControl,
  });
  return state.helloText;
}

type TimerField = 'retryTimer' | 'deadlineTimer';

function armTimer(state: InitiatorState, field: TimerField, setTimeoutFn: typeof setTimeout, fn: () => void, ms: number): void {
  const timer = setTimeoutFn(fn, ms);
  (timer as unknown as { unref?: () => void }).unref?.();
  state[field] = timer;
}

/** Send hello on start; retry + one final resend preserve the wire grammar
 * the host mirror emits; the deadline fails the attempt (1011). */
async function runInitiatorStart(options: ClientInitiatorOptions, state: InitiatorState): Promise<void> {
  const helloRetryMs = options.helloRetryMs ?? 1000;
  const helloTimeoutMs = options.helloTimeoutMs ?? 30_000;
  const setFn = options.setTimeoutFn ?? setTimeout;
  state.helloText = null;
  state.established = false;
  const text = await buildHello(options, state);
  options.sendText(text);
  state.deadlineTimer = setFn(() => {
    if (state.established || state.deadlineTimer === null) return;
    state.deadlineTimer = null;
    options.onClose(HOST_CLIENT_CLOSE_CHANNEL, 'relay handshake timeout');
  }, helloTimeoutMs) as ReturnType<typeof setTimeout>;
  (state.deadlineTimer as unknown as { unref?: () => void }).unref?.();
  state.retryTimer = setFn(() => {
    state.retryTimer = null;
    if (state.established || state.helloText === null) return;
    options.sendText(state.helloText);
    armTimer(state, 'retryTimer', setFn, () => {
      state.retryTimer = null;
      if (!state.established && state.helloText !== null) options.sendText(state.helloText);
    }, helloRetryMs * 2);
  }, helloRetryMs) as ReturnType<typeof setTimeout>;
  (state.retryTimer as unknown as { unref?: () => void }).unref?.();
}

function clearInitiatorTimers(options: ClientInitiatorOptions, state: InitiatorState): void {
  const clearFn = options.clearTimeoutFn ?? clearTimeout;
  clearFn(state.deadlineTimer ?? undefined);
  state.deadlineTimer = null;
  clearFn(state.retryTimer ?? undefined);
  state.retryTimer = null;
}

/** Established capture: the first ready wins; later dupes are ignored. */
async function runInitiatorText(options: ClientInitiatorOptions, state: InitiatorState, text: Uint8Array): Promise<void> {
  if (state.established) return;
  const ready = decodeHandshakeReady(text);
  if (ready === null) return;
  if (state.ephemeralPrivateJwk === null || state.ephemeralPublicJwk === null || state.nonceB64url === '') return;
  let session: OpenedSession;
  try {
    session = openSession(await deriveSessionKeys(state.ephemeralPrivateJwk, options.hostEncPublicJwk, state.nonceB64url));
  } catch {
    options.onClose(HOST_CLIENT_CLOSE_CHANNEL, 'handshake key derivation failed');
    return;
  }
  const helloText = state.helloText as Uint8Array;
  state.established = true;
  clearInitiatorTimers(options, state);
  const capabilities = negotiate(options.capabilities, ready);
  options.onEstablished({ session, capabilities, helloText });
}

export function createClientInitiator(options: ClientInitiatorOptions): ClientInitiator {
  const state: InitiatorState = {
    established: false,
    ephemeralPublicJwk: null,
    ephemeralPrivateJwk: null,
    nonceB64url: '',
    helloText: null,
    retryTimer: null,
    deadlineTimer: null,
  };
  const machine: ClientInitiator = {
    get established() { return state.established; },
    async start(): Promise<void> { return runInitiatorStart(options, state); },
    async onText(text: Uint8Array): Promise<void> { return runInitiatorText(options, state, text); },
    onBinary(): void {
      if (state.established) return;
      options.onClose(HOST_CLIENT_CLOSE_CHANNEL, 'encrypted frame before handshake completed');
    },
    stop(): void { clearInitiatorTimers(options, state); },
  };
  return machine;
}

export { decodeHandshakeReady };
