// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { ContractError } from './ids.js';

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
  const lost = new Promise((resolve) => { settleLost = resolve; });
  const fail = (cause) => {
    failure ??= lockError('nnd_lock_lost', 'NND singleton ownership failed.', cause);
    settleLost(failure);
  };
  server.on('error', fail);
  server.on('close', () => {
    closed = true;
    if (!closing) fail(new Error('NND singleton listener closed unexpectedly.'));
    else settleLost(null);
  });
  return Object.freeze({
    ...identity,
    lost,
    get error() { return failure; },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = new Promise((resolve, reject) => {
        if (closed) { resolve(); return; }
        server.close((cause) => {
          if (cause) { fail(cause); reject(failure); }
          else resolve();
        });
      });
      return closePromise;
    },
  });
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
