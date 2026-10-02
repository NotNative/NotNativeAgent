// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { ContractError } from './ids.js';
const LEASES = new WeakMap();

export function assertHeldNndServiceLease(lease, dataId) {
  const state = LEASES.get(lease);
  if (!state || state.dataId !== dataId || !state.held()) {
    throw lockError('nnd_lock_lost', 'A live NND singleton lease for this data root is required.');
  }
}

export async function withNndServiceLease(lease, dataId, operation) {
  assertHeldNndServiceLease(lease, dataId);
  const state = LEASES.get(lease);
  if (state.pending.size >= 8) throw lockError('nnd_lock_operation_limit', 'NND singleton operation capacity is exhausted.');
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(lockError('nnd_lock_lost', 'NND singleton operation was cancelled.')), { once: true });
    timer = setTimeout(() => controller.abort(), 15000);
  });
  const pending = Promise.resolve().then(() => operation(controller.signal));
  const active = { pending, controller };
  state.pending.add(active);
  const completed = () => { clearTimeout(timer); state.pending.delete(active); };
  // Security: caller cancellation is not evidence that the underlying writer stopped.
  pending.then(completed, completed);
  const result = await Promise.race([pending, expired]);
  if (lease.error) throw lease.error;
  return result;
}

async function drainOperations(pending) {
  if (pending.size === 0) return;
  let timer;
  try {
    await Promise.race([
      Promise.allSettled([...pending].map((active) => active.pending)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(lockError('nnd_lock_lost', 'NND operations remain active; singleton ownership is retained.')), 5000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

function lockError(code, message, cause) {
  return new ContractError(code, message, { cause });
}

async function lockIdentity(dataRoot) {
  if (typeof dataRoot !== 'string' || dataRoot.length > 4096
    || /[\u0000-\u001f]/u.test(dataRoot) || !isAbsolute(dataRoot)) {
    throw lockError('nnd_lock_acquire_failed', 'NND data root must be an absolute existing directory.');
  }
  try {
    const canonical = resolve(await realpath(dataRoot));
    if (!(await stat(canonical)).isDirectory()) throw new Error('Data root is not a directory.');
    const digest = createHash('sha256').update(canonical.toLowerCase()).digest('hex');
    return { dataId: `data_${digest}`, pipeName: `\\\\.\\pipe\\nna-nnd-${digest}` };
  } catch (cause) {
    throw lockError('nnd_lock_acquire_failed', 'Cannot resolve the NND data root.', cause);
  }
}

function createLease(server, identity) {
  let failure = null;
  let closing = false;
  let closed = false;
  let closePromise;
  let settleLost;
  const pending = new Set();
  const lost = new Promise((resolve) => { settleLost = resolve; });
  const fail = (cause) => {
    failure ??= lockError('nnd_lock_lost', 'NND singleton ownership failed.', cause);
    for (const active of pending) active.controller.abort();
    settleLost(failure);
  };
  server.on('error', fail);
  server.on('close', () => {
    closed = true;
    if (!closing) fail(new Error('NND singleton listener closed unexpectedly.'));
    else settleLost(null);
  });
  const lease = Object.freeze({
    ...identity,
    lost,
    get error() { return failure; },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = drainOperations(pending).then(() => new Promise((resolve, reject) => {
        if (closed) { resolve(); return; }
        server.close((cause) => {
          if (cause) { fail(cause); reject(failure); }
          else resolve();
        });
      })).catch((error) => { closePromise = null; throw error; });
      return closePromise;
    },
  });
  LEASES.set(lease, { dataId: identity.dataId, pending, held: () => !closing && !closed && !failure });
  return lease;
}

function listenExclusive(server, identity) {
  return new Promise((resolve, reject) => {
    const failed = (cause) => {
      server.removeListener('listening', ready);
      const occupied = cause.code === 'EADDRINUSE';
      reject(lockError(occupied ? 'nnd_service_already_running' : 'nnd_lock_acquire_failed',
        occupied ? 'NND data root already has a singleton owner. Do not take over its process.'
          : 'Cannot acquire NND singleton ownership.', cause));
    };
    const ready = () => {
      const lease = createLease(server, identity);
      server.removeListener('error', failed);
      resolve(lease);
    };
    server.once('error', failed);
    server.once('listening', ready);
    try { server.listen({ path: identity.pipeName, exclusive: true, backlog: 1 }); }
    catch (cause) { server.removeListener('error', failed); failed(cause); }
  });
}

export async function acquireNndServiceLock({ dataRoot } = {}) {
  if (process.platform !== 'win32') {
    throw lockError('nnd_service_platform_unsupported', 'NND singleton ownership requires Windows.');
  }
  const identity = await lockIdentity(dataRoot);
  // Security: this pipe is only a kernel lifetime lock, never a command or credential channel.
  const server = createServer((socket) => {
    socket.on('error', () => { socket.destroy(); });
    socket.destroy();
  });
  server.maxConnections = 1;
  return listenExclusive(server, identity);
}
