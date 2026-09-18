// SPDX-License-Identifier: Apache-2.0
/**
 * Relay handshake state machines (doc 08 section 3.4): the host responder
 * (validates hellos, re-answers identical-hello retries atomically, closes
 * 1008 on a rekey attempt and 1011 on malformed/derive failures) and the
 * client initiator (hello re-sent every 1 s until established, 30 s
 * deadline). Fresh handshake per connection: no session resumption.
 * Direction discipline: the client encrypts with clientToHost and
 * decrypts with hostToClient; the host is mirrored.
 */
import { webcrypto } from 'node:crypto';
import type { RelayJwk } from './identity.ts';
import {
  bytesToBase64Url, decodeHandshakeHello, decodeHandshakeReady, deriveSessionKeys, encodeHandshakeHello,
  encodeHandshakeReady, openSession, publicKeyJwkFingerprint,
  type DecodedHello, type OpenedSession,
} from './crypto.ts';

export const HOST_CLOSE_REKEY = 1008; // 'rekey mismatch' — fail closed, never rekey in place
export const HOST_CLOSE_CHANNEL = 1011; // 'channel failure' — E2EE/framing failure
export const SERVER_CLOSE_PLAINTEXT = 1011; // plaintext frame on an established channel

export class HandshakeError extends Error {
  readonly closeCode: number;

  constructor(closeCode: number, message: string) {
    super(message);
    this.closeCode = closeCode;
  }
}

export interface CapabilityOptions {
  batch: boolean;
  flowControl: boolean;
}

/** Host negotiation math (§3.4): capabilities negotiate only when BOTH
 * peers advertise; flowControl honors a local disable. */
export function negotiate(host: CapabilityOptions, message: { batch: boolean; flowControl: boolean }): CapabilityOptions {
  return {
    batch: host.batch === true && message.batch === true,
    flowControl: host.flowControl !== false && message.flowControl === true,
  };
}

export interface HostResponderOptions {
  hostEncPrivateJwk: RelayJwk;
  capabilities: CapabilityOptions;
  /** Outbound plaintext JSON text (the ready answer). */
  sendText: (text: Buffer) => void | Promise<void>;
  onClose: (closeCode: number, reason: string) => void;
  onEstablished: (established: HostEstablished) => void;
  now?: () => number;
}

export interface HostEstablished {
  session: OpenedSession;
  clientFingerprint: string;
  capabilities: CapabilityOptions;
}

interface ResponderState {
  established: boolean;
  readyText: Buffer | null;
  establishedSession: HostEstablished | null;
  clientFingerprint: string;
}

/** Established channel: TEXT decisions (§3.4). The IDENTICAL-hello retry
 * (same key fingerprint) re-answers the SAME ready; a DIFFERENT fingerprint
 * is a rekey attempt -> close 1008, never rekey in place; anything else is
 * stray plaintext -> close 1011. */
async function onEstablishedText(options: HostResponderOptions, state: ResponderState, text: Buffer): Promise<void> {
  const hello = decodeHandshakeHello(text);
  if (hello === null) {
    options.onClose(SERVER_CLOSE_PLAINTEXT, 'plaintext frame on established channel');
    return;
  }
  if (publicKeyJwkFingerprint(hello.clientPubJwk) === state.clientFingerprint) {
    await options.sendText(state.readyText as Buffer);
    return;
  }
  options.onClose(HOST_CLOSE_REKEY, 'rekey mismatch');
}

/** First-legal-hello acceptance: the readyText is stored BEFORE the derive
 * runs so any interleaved hello sees an in-flight answer, not a fresh one. */
async function acceptHello(options: HostResponderOptions, state: ResponderState, hello: DecodedHello): Promise<void> {
  const capabilities = negotiate(options.capabilities, hello);
  state.readyText = encodeHandshakeReady(capabilities);
  let session: OpenedSession;
  try {
    session = openSession(await deriveSessionKeys(options.hostEncPrivateJwk, hello.clientPubJwk, hello.nonce));
  } catch {
    state.readyText = null;
    options.onClose(HOST_CLOSE_CHANNEL, 'handshake key derivation failed');
    return;
  }
  state.clientFingerprint = publicKeyJwkFingerprint(hello.clientPubJwk);
  state.established = true;
  state.establishedSession = { session, clientFingerprint: state.clientFingerprint, capabilities };
  await options.sendText(state.readyText);
  options.onEstablished(state.establishedSession as HostEstablished);
}

export interface HostResponder {
  onText(text: Buffer): Promise<void>;
  onBinary(): void;
  established: boolean;
  establishedSession: HostEstablished | null;
}

/** Host side of the E2EE handshake on a host-data leg. */
export function createHostResponder(options: HostResponderOptions): HostResponder {
  const state: ResponderState = { established: false, readyText: null, establishedSession: null, clientFingerprint: '' };
  const machine: HostResponder = {
    get established() { return state.established; },
    get establishedSession() { return state.establishedSession; },
    onBinary(): void {
      if (state.established) return; // post-establishment binaries are the caller's frame path
      options.onClose(SERVER_CLOSE_PLAINTEXT, 'binary frame before handshake');
    },
    async onText(text: Buffer): Promise<void> {
      if (state.established) return onEstablishedText(options, state, text);
      const hello = decodeHandshakeHello(text);
      if (hello === null) {
        options.onClose(HOST_CLOSE_CHANNEL, 'malformed handshake hello');
        return;
      }
      if (state.readyText === null) await acceptHello(options, state, hello);
    },
  };
  return machine;
}

export interface ClientInitiatorOptions {
  hostEncPublicJwk: RelayJwk; // the E2EE trust anchor from the pairing payload (§3.2)
  capabilities: CapabilityOptions;
  sendText: (text: Buffer) => void;
  onClose: (closeCode: number, reason: string) => void;
  onEstablished: (established: { session: OpenedSession; capabilities: CapabilityOptions; helloText: Buffer }) => void;
  helloRetryMs?: number;
  helloTimeoutMs?: number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface ClientInitiator {
  start(): void;
  onText(text: Buffer): Promise<void>;
  onBinary(): void;
  stop(): void;
  established: boolean;
}

interface InitiatorState {
  established: boolean;
  ephemeralPublicJwk: RelayJwk | null;
  ephemeralPrivateKey: Parameters<typeof webcrypto.subtle.exportKey>[1] | null;
  nonceB64url: string;
  helloText: Buffer | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
}

/** Builds the hello once per attempt: fresh ephemeral ECDH key + 16 B nonce. */
async function initiatorHello(options: ClientInitiatorOptions, state: InitiatorState): Promise<Buffer> {
  if (state.helloText !== null) return state.helloText;
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  state.ephemeralPrivateKey = pair.privateKey;
  const publicJwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey) as RelayJwk;
  state.ephemeralPublicJwk = { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y };
  state.nonceB64url = bytesToBase64Url(webcrypto.getRandomValues(new Uint8Array(16)));
  state.helloText = encodeHandshakeHello({ clientPubJwk: state.ephemeralPublicJwk, nonceB64url: state.nonceB64url, ...options.capabilities });
  return state.helloText;
}

/** Send hello on start, re-send on the retry cadence until the ready arrives;
 * the overall deadline fails the attempt (1011). */
async function startInitiator(options: ClientInitiatorOptions, state: InitiatorState): Promise<void> {
  const helloRetryMs = options.helloRetryMs ?? 1000;
  const helloTimeoutMs = options.helloTimeoutMs ?? 30_000;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  state.helloText = null;
  state.established = false;
  const text = await initiatorHello(options, state);
  options.sendText(text);
  state.deadlineTimer = setTimeoutFn(() => {
    if (state.established || state.deadlineTimer === null) return;
    state.deadlineTimer = null;
    options.onClose(HOST_CLOSE_CHANNEL, 'relay handshake timeout');
  }, helloTimeoutMs) as never;
  (state.deadlineTimer as unknown as { unref?: () => void }).unref?.();
  state.retryTimer = setTimeoutFn(() => {
    state.retryTimer = null;
    if (state.established || state.helloText === null) return;
    options.sendText(state.helloText);
    state.retryTimer = setTimeoutFn(() => {
      state.retryTimer = null;
      if (!state.established && state.helloText !== null) options.sendText(state.helloText);
    }, helloRetryMs * 2) as never;
    (state.retryTimer as unknown as { unref?: () => void }).unref?.();
  }, helloRetryMs) as never;
  (state.retryTimer as unknown as { unref?: () => void }).unref?.();
}

async function onInitiatorText(options: ClientInitiatorOptions, state: InitiatorState, text: Buffer): Promise<void> {
  if (state.established) return; // duplicate ready is ignored after establishment
  const ready = decodeHandshakeReady(text);
  if (ready === null || state.ephemeralPrivateKey === null || state.nonceB64url === '' || state.ephemeralPublicJwk === null) {
    return; // pre-establishment unknown plaintext is ignored (relay control noise), not torn down
  }
  let session: OpenedSession;
  try {
    const privateJwk = await webcrypto.subtle.exportKey('jwk', state.ephemeralPrivateKey) as RelayJwk;
    session = openSession(await deriveSessionKeys(privateJwk, options.hostEncPublicJwk, state.nonceB64url));
  } catch {
    options.onClose(HOST_CLOSE_CHANNEL, 'handshake key derivation failed');
    return;
  }
  // Capability mirror: negotiated only when BOTH peers advertise.
  const capabilities = negotiate(options.capabilities, ready);
  state.established = true;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  clearTimeoutFn(state.deadlineTimer ?? undefined);
  state.deadlineTimer = null;
  clearTimeoutFn(state.retryTimer ?? undefined);
  state.retryTimer = null;
  const echo: Buffer = state.helloText as Buffer;
  options.onEstablished({ session, capabilities, helloText: echo });
}

/** Client side: send hello on open, re-send on a 1 s interval until the
 * ready arrives; overall 30 s deadline fails the attempt (1011). */
export function createClientInitiator(options: ClientInitiatorOptions): ClientInitiator {
  const state: InitiatorState = {
    established: false,
    ephemeralPublicJwk: null,
    ephemeralPrivateKey: null,
    nonceB64url: '',
    helloText: null,
    retryTimer: null,
    deadlineTimer: null,
  };
  const machine: ClientInitiator = {
    get established() { return state.established; },
    async start(): Promise<void> { return startInitiator(options, state); },
    async onText(text: Buffer): Promise<void> { return onInitiatorText(options, state, text); },
    onBinary(): void {
      if (state.established) return;
      options.onClose(SERVER_CLOSE_PLAINTEXT, 'encrypted frame before handshake completed');
    },
    stop(): void {
      const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
      clearTimeoutFn(state.deadlineTimer ?? undefined);
      state.deadlineTimer = null;
      clearTimeoutFn(state.retryTimer ?? undefined);
      state.retryTimer = null;
    },
  };
  return machine;
}
