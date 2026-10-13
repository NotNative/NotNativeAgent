// SPDX-License-Identifier: Apache-2.0
/** HTTP requests submitted while a relay handshake is still connecting. */
export interface QueuedFetch {
  readonly run: () => void;
  readonly reject: (error: Error) => void;
}

export function abortSignalOf(input: string | URL | Request, init?: RequestInit): AbortSignal | undefined {
  if (init?.signal !== undefined) return init.signal ?? undefined;
  if (typeof input !== 'string' && !(input instanceof URL)) return (input as Request).signal ?? undefined;
  return undefined;
}

export function queueFetchDuringConnect(
  queue: QueuedFetch[], signal: AbortSignal | undefined, start: () => Promise<Response>,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('The operation was aborted.', 'AbortError')); return; }
    let settled = false;
    const remove = (): void => {
      const index = queue.indexOf(operation);
      if (index >= 0) queue.splice(index, 1);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      remove();
      reject(error);
    };
    const onAbort = (): void => fail(new DOMException('The operation was aborted.', 'AbortError'));
    const operation: QueuedFetch = {
      run: () => {
        if (settled) return;
        if (signal?.aborted) { onAbort(); return; }
        let pending;
        try { pending = start(); }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))); return; }
        settled = true;
        remove();
        pending.then(resolve, reject);
      },
      reject: fail,
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    queue.push(operation);
  });
}
