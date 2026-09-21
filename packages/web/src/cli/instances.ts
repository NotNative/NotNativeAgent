// SPDX-License-Identifier: Apache-2.0
/**
 * Instance discovery + auto-start (doc 08 S5.9 + doc 03 S10.1 serve row):
 * `connect-url` ensures a server instance runs on the target port — it first
 * probes an existing process, and when none answers it spawns the server as a
 * detached child (logs to <data-dir>/logs/notnative-<port>.log), writes a small
 * instance registry record, and waits for /health readiness (30 s cap). The
 * NND registry is deliberately simpler than the doc-03 instance files until
 * the full CLI/serve slice lands (registered delta).
 */
import { spawn } from 'node:child_process';
import { openSync, mkdirSync, writeFileSync, closeSync, rmSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV } from '../server/env.ts';

export const AUTOSTART_READINESS_TIMEOUT_MS = 30_000;
export const AUTOSTART_READINESS_POLL_MS = 250;
export const PROBE_TIMEOUT_MS = 2_000;

export interface InstanceRecord {
  pid: number;
  port: number;
  host: string;
  startedAt: string;
  autoStarted: true;
}

export function writeInstanceRecord(record: InstanceRecord, dataDir?: string): void {
  mkdirSync(dirname(instanceRecordPath(record.port, dataDir)), { recursive: true });
  writeFileSync(instanceRecordPath(record.port, dataDir), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/** Best-effort record cleanup after a failed start (the future stop/status
 *  slice must not chase a pid this run never successfully started). */
export function removeInstanceRecord(port: number, dataDir?: string): void {
  rmSync(instanceRecordPath(port, dataDir), { force: true });
}

export interface SpawnSeam {
  spawnDetached(command: string, args: string[], env: Record<string, string>, logPath: string): number;
}

/** Best-effort SIGTERM for the child THIS run spawned; ESRCH/dead children
 *  are simply false (the OS already reaped it). Never touches foreign pids:
 *  the caller passes only the pid its own spawnDetached returned. */
function defaultChildKill(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

const defaultSpawnSeam: SpawnSeam = {
  spawnDetached(command, args, env, logPath) {
    // Detached with real file descriptors: the child must never inherit the
    // invoker's stdio pipes, or a daemonized server pins the launching shell.
    // The fd is created for the child alone; a synchronous spawn failure must
    // not leak it in the launcher process.
    mkdirSync(dirname(logPath), { recursive: true });
    const logFd = openSync(logPath, 'a+');
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, ...env },
      });
      child.unref();
      return child.pid ?? 0;
    } finally {
      closeSync(logFd);
    }
  },
};

export interface ServerTarget {
  port: number;
  host: string;
  serverUrl: string;
  source: 'explicit' | 'configured' | 'lan-detected' | 'loopback-fallback';
}

export function instanceRecordPath(port: number, dataDir?: string): string {
  return `${dataDir ?? ENV.dataDir}/instances/notnative-${port}.json`;
}

function healthUrl(port: number): string {
  return `http://127.0.0.1:${port}/health`;
}

export interface ProbeOutcome { answered: boolean; response?: { status: number } }

/** GET /health with a hard timeout; any answer (200 or not) = a live process
 *  on the port is the server (404 from something else still says "occupied"). */
export async function probePortHealth(
  port: number,
  io: { fetch: typeof fetch } = { fetch: globalThis.fetch },
): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await io.fetch(healthUrl(port), { signal: controller.signal });
    return { answered: true, response: { status: response.status } };
  } catch {
    return { answered: false };
  } finally {
    clearTimeout(timer);
  }
}

export interface EnsureRunningOutcome {
  autoStarted: boolean;
  readiness: 'ready' | 'timeout';
}

/** Probe, and when nothing answers spawn the server and wait for readiness
 *  (30 s cap). A readiness timeout is a FAILED start: the child this run
 *  spawned is SIGTERMed best-effort and its instance record is removed, so
 *  no orphaned child outlives the reporting failure. */
export async function ensureServerRunning(
  target: ServerTarget,
  options: ServeOptions,
  seams: {
    probe: (port: number) => Promise<ProbeOutcome>;
    prepareWait: (stage: 'pre-spawn' | 'post-spawn') => Promise<void>;
    spawn: SpawnSeam | null;
    kill?: (pid: number) => boolean;
    record: (record: InstanceRecord) => void;
    clearRecord: (port: number) => void;
    readinessTimeoutMs?: number;
  },
): Promise<EnsureRunningOutcome> {
  const existing = await seams.probe(target.port);
  if (existing.answered) return { autoStarted: false, readiness: 'ready' };
  await seams.prepareWait('pre-spawn');
  const serverEntry = resolvePath(dirname(fileURLToPath(import.meta.url)), '../server/index.ts');
  const logPath = `${options.dataDir ?? ENV.dataDir}/logs/notnative-${target.port}.log`;
  const spawnSeam = seams.spawn ?? defaultSpawnSeam;
  const pid = spawnSeam.spawnDetached(
    process.execPath,
    [serverEntry],
    {
      NOTNATIVE_PORT: String(target.port),
      PORT: String(target.port),
      NOTNATIVE_HOST: target.host,
      ...(options.uiPassword !== undefined ? { NOTNATIVE_UI_PASSWORD: options.uiPassword } : {}),
    },
    logPath,
  );
  if (pid === 0) return { autoStarted: true, readiness: 'timeout' };
  seams.record({
    pid,
    port: target.port,
    host: target.host,
    startedAt: new Date().toISOString(),
    autoStarted: true,
  });
  await seams.prepareWait('post-spawn');
  const deadline = Date.now() + (seams.readinessTimeoutMs ?? AUTOSTART_READINESS_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if ((await seams.probe(target.port)).answered) return { autoStarted: true, readiness: 'ready' };
    await new Promise((resolveSleep) => setTimeout(resolveSleep, AUTOSTART_READINESS_POLL_MS));
  }
  // Give the never-ready child a graceful shot; the record cannot claim a
  // server that is not answering.
  (seams.kill ?? defaultChildKill)(pid);
  seams.clearRecord(target.port);
  return { autoStarted: true, readiness: 'timeout' };
}

export interface ServeOptions {
  uiPassword?: string;
  dataDir?: string;
}
