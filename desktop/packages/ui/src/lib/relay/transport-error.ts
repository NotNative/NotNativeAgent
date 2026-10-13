// SPDX-License-Identifier: Apache-2.0
/**
 * Ambiguous transport failures (doc 08 §3.10, `transport-error.ts`). When
 * a request dies AFTER its head reached the wire (host StreamAbort,
 * StreamEnd before response head, channel death, malformed head) the
 * client does not know whether the server processed it. Callers that
 * would otherwise retry — notably prompt sends — must tell that state
 * apart: failures get a non-enumerable
 * `__openchamberAmbiguousTransport` flag. A fresh tagged error is created
 * per failure so the flag can never leak to waiters whose request never
 * reached the wire.
 */

const AMBIGUOUS_FLAG = '__openchamberAmbiguousTransport';

export type AmbiguousTransportError = Error & { [AMBIGUOUS_FLAG]?: true };

export function markAmbiguousTransportFailure<T extends Error>(error: T): T {
  const target = error as unknown as { [AMBIGUOUS_FLAG]?: boolean };
  try {
    Object.defineProperty(target, AMBIGUOUS_FLAG, {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    target[AMBIGUOUS_FLAG] = true;
  }
  return error;
}

export function isAmbiguousTransportFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { [AMBIGUOUS_FLAG]?: unknown })[AMBIGUOUS_FLAG] === true;
}

export function ambiguousTransportError(message: string): Error {
  return markAmbiguousTransportFailure(new Error(message));
}

/** Fresh channel-death message shape ("relay tunnel reset: <cause>"). */
export function tunnelResetError(cause: string | undefined | null): Error {
  return ambiguousTransportError(`relay tunnel reset: ${cause ?? 'channel failure'}`);
}
