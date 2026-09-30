// SPDX-License-Identifier: Apache-2.0
import { spawn as nodeSpawn } from 'node:child_process';
import net from 'node:net';
import { parseDesktopSshCommand, sanitizeDesktopSshInstance } from './ssh-instances.mjs';

const DEFAULT_REMOTE_PORT = 57123;
const PROBE_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 1_500;

function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function statusFor(id, phase, previous = {}) {
  return {
    id,
    phase,
    ...(previous.detail ? { detail: previous.detail } : {}),
    ...(previous.localUrl ? { localUrl: previous.localUrl } : {}),
    ...(validPort(previous.localPort) ? { localPort: previous.localPort } : {}),
    ...(validPort(previous.remotePort) ? { remotePort: previous.remotePort } : {}),
    startedByUs: previous.startedByUs === true,
    retryAttempt: Math.max(0, Math.floor(previous.retryAttempt ?? 0)),
    requiresUserAction: previous.requiresUserAction === true,
    updatedAtMs: previous.updatedAtMs ?? Date.now(),
  };
}

function reserveLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('ssh-local-port-unavailable')));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function isHealthyOpenChamber(response) {
  if (response.status !== 200 || response.redirected === true) return false;
  const declaredSize = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > 16 * 1024) return false;
  const reader = response.body?.getReader?.();
  if (!reader) return false;
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024) {
        await reader.cancel();
        return false;
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock?.(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const health = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return health?.ok === true && health?.name === 'NotNativeDesktop';
  } catch { return false; }
}

function makeSshArgs(instance, localPort, remotePort) {
  const parsed = parseDesktopSshCommand(instance.sshCommand);
  const forbidden = new Set(['-A', '-D', '-L', '-R', '-X', '-Y']);
  for (const arg of parsed.args) {
    if (forbidden.has(arg) || [...forbidden].some((flag) => arg.startsWith(flag) && arg !== flag)) {
      throw new Error('desktop-ssh-command-forwarding-options-unsupported');
    }
  }
  return [
    '-N',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'PermitLocalCommand=no',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    ...parsed.args,
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    parsed.destination,
  ];
}

export function createDesktopSshTransport({
  getInstances,
  emitStatus = () => {},
  spawnProcess = nodeSpawn,
  fetchImpl = globalThis.fetch,
  chooseLocalPort = reserveLocalPort,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  now = Date.now,
  platform = process.platform,
} = {}) {
  if (typeof getInstances !== 'function') throw new TypeError('getInstances is required');
  const processes = new Map();
  const statuses = new Map();
  const pendingAttempts = new Map();
  // Removing an instance can race an in-flight connect promise. Keep the id
  // tombstoned until a later explicit connect so that its cancellation path
  // cannot resurrect a status row after forgetStatus() has removed it.
  const forgottenIds = new Set();

  function publish(id, phase, extra = {}) {
    const prior = statuses.get(id) ?? {};
    const next = statusFor(id, phase, { ...prior, ...extra, updatedAtMs: now() });
    if (forgottenIds.has(id)) return next;
    statuses.set(id, next);
    try { emitStatus(next); } catch { /* Renderer status delivery is best effort. */ }
    return next;
  }

  function stop(id, detail = 'disconnected') {
    const current = processes.get(id);
    if (!current) return publish(id, 'idle', { detail, startedByUs: false });
    current.cancelled = true;
    processes.delete(id);
    try { current.child?.kill(); } catch {}
    return publish(id, 'idle', { ...current.status, detail, startedByUs: false });
  }

  async function waitForHealth(id, record, url, deadline) {
    while (now() < deadline) {
      if (record.cancelled || processes.get(id) !== record) throw new Error('desktop-ssh-connect-cancelled');
      if (record.exitError) throw record.exitError;
      if (typeof fetchImpl === 'function') {
        try {
          const response = await fetchImpl(`${url}/health`, {
            headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          // Fetch follows redirects by default. A login page or another local
          // service can return 200 after redirecting, which is not proof that
          // the tunneled Openchamber server is healthy.
          // A 200 from an unrelated service bound to a preferred local port
          // must not make a failed SSH forward look ready.
          if (await isHealthyOpenChamber(response)) return;
        } catch { /* Tunnel may still be starting. */ }
      }
      await sleep(PROBE_INTERVAL_MS);
    }
    throw new Error('desktop-ssh-remote-health-timeout');
  }

  function connect(id, options = {}) {
    if (processes.has(id)) return { ok: false, error: 'desktop-ssh-already-connected-or-connecting' };
    forgottenIds.delete(id);
    // Reserve the instance before the first await (notably chooseLocalPort).
    // Otherwise two rapid connect requests can both spawn tunnels and one
    // child becomes unreachable from disconnect/dispose when the map is
    // overwritten by the second request.
    const record = { child: null, status: {}, cancelled: false, exitError: null };
    processes.set(id, record);
    const attempts = pendingAttempts.get(id) ?? new Set();
    attempts.add(record);
    pendingAttempts.set(id, attempts);
    return connectReserved(id, options, record).finally(() => {
      attempts.delete(record);
      if (attempts.size === 0) {
        pendingAttempts.delete(id);
        forgottenIds.delete(id);
      }
    });
  }

  async function connectReserved(id, { retryAttempt = 0 } = {}, record) {
    const release = () => {
      if (processes.get(id) === record) processes.delete(id);
    };
    const cancelled = () => record.cancelled || processes.get(id) !== record;
    let instance;
    try {
      instance = getInstances().find((item) => item.id === id);
      if (!instance) { release(); return { ok: false, error: 'desktop-ssh-instance-not-found' }; }
      instance = sanitizeDesktopSshInstance(instance);
    } catch { release(); return { ok: false, error: 'desktop-ssh-instance-invalid' }; }
    if (instance.remoteOpenchamber.mode !== 'external') {
      release();
      publish(id, 'error', { detail: 'managed-remote-start-not-implemented', retryAttempt, requiresUserAction: true });
      return { ok: false, error: 'desktop-ssh-managed-mode-unavailable' };
    }

    const remotePort = instance.remoteOpenchamber.preferredPort ?? DEFAULT_REMOTE_PORT;
    if (!validPort(remotePort)) { release(); return { ok: false, error: 'desktop-ssh-remote-port-invalid' }; }
    publish(id, 'config_resolved', {
      detail: '', localUrl: '', localPort: undefined, retryAttempt, startedByUs: true, remotePort,
    });
    let localPort;
    try {
      localPort = instance.localForward.preferredLocalPort ?? await chooseLocalPort();
      if (!validPort(localPort)) throw new Error('desktop-ssh-local-port-invalid');
    } catch (error) {
      release();
      publish(id, 'error', { detail: error.message, retryAttempt, requiresUserAction: false });
      return { ok: false, error: 'desktop-ssh-local-port-unavailable' };
    }
    if (cancelled()) return { ok: false, error: 'desktop-ssh-connect-cancelled' };

    const localUrl = `http://127.0.0.1:${localPort}`;
    const detail = { localUrl, localPort, remotePort, startedByUs: true, retryAttempt };
    publish(id, 'master_connecting', detail);
    let args;
    try { args = makeSshArgs(instance, localPort, remotePort); }
    catch (error) {
      release();
      publish(id, 'error', { ...detail, detail: error.message, requiresUserAction: true });
      return { ok: false, error: error.message };
    }

    record.status = detail;
    let child;
    try {
      child = spawnProcess(platform === 'win32' ? 'ssh.exe' : 'ssh', args, {
        stdio: 'ignore', windowsHide: true, shell: false,
      });
      record.child = child;
    } catch (error) {
      release();
      const reason = error instanceof Error ? error.message : 'desktop-ssh-process-spawn-failed';
      publish(id, 'error', { ...detail, detail: reason, startedByUs: false, requiresUserAction: true });
      return { ok: false, error: reason };
    }
    child.once('error', (error) => { record.exitError = error; });
    child.once('exit', (code) => {
      if (processes.get(id) !== record || record.cancelled) return;
      record.exitError = new Error(`desktop-ssh-process-exited-${code ?? 'unknown'}`);
      processes.delete(id);
      publish(id, 'error', { ...detail, detail: record.exitError.message, startedByUs: false });
    });

    const deadline = now() + instance.connectionTimeoutSec * 1_000;
    publish(id, 'remote_probe', detail);
    try {
      await waitForHealth(id, record, localUrl, deadline);
      if (record.cancelled || processes.get(id) !== record) throw new Error('desktop-ssh-connect-cancelled');
      const ready = publish(id, 'ready', detail);
      record.status = ready;
      return { ok: true, result: ready };
    } catch (error) {
      const stillOwnsInstance = processes.get(id) === record;
      if (stillOwnsInstance) {
        processes.delete(id);
        record.cancelled = true;
        try { child.kill(); } catch {}
      }
      const reason = error instanceof Error ? error.message : 'desktop-ssh-connect-failed';
      // Cancellation or replacement already published the authoritative
      // state. A stale connect promise must not overwrite a newer attempt.
      if (stillOwnsInstance) {
        publish(id, reason === 'desktop-ssh-connect-cancelled' ? 'idle' : 'error', {
          ...detail, detail: reason, startedByUs: false,
          requiresUserAction: reason !== 'desktop-ssh-connect-cancelled',
        });
      }
      return { ok: false, error: reason };
    }
  }

  return {
    connect,
    disconnect(id) { return { ok: true, result: stop(id) }; },
    cancel(id) { return { ok: true, result: stop(id, 'connection-cancelled') }; },
    getStatuses() { return [...statuses.values()]; },
    forgetStatus(id) {
      statuses.delete(id);
      if (pendingAttempts.has(id)) forgottenIds.add(id);
      else forgottenIds.delete(id);
    },
    dispose() { for (const id of processes.keys()) stop(id, 'application-shutdown'); },
  };
}

export { makeSshArgs };
