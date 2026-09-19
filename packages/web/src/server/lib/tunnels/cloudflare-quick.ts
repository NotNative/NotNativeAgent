// SPDX-License-Identifier: Apache-2.0
/**
 * cloudflared quick tunnel (doc 08 §4.3): `cloudflared tunnel --url
 * http://127.0.0.1:<port>` with HOME pointed at a fresh temp dir (isolates
 * the user's real `~/.cloudflared`), CF_TELEMETRY_DISABLE=1, windowsHide,
 * kill signal SIGINT. The public URL parses from stdout/stderr against the
 * trycloudflare pattern; the 30 s timeout kills the child, removes the
 * temp dir, and fails with "Tunnel URL not received within 30 seconds".
 */
import { type TunnelSpawnDeps, type TunnelChildLike, checkExecutable, rmTempDir } from './tunnel-spawn.ts';
import { TunnelServiceError } from './tunnel-validate.ts';
import { CLOUDFLARE_INSTALL_HINT } from './tunnel-install.ts';
import { createTunnelController, type TunnelControllerLike } from './tunnel-controller.ts';
import { TunnelOutputSink } from './tunnel-readiness.ts';

export const QUICK_TUNNEL_URL_TIMEOUT_MS = 30_000;
export const CLOUDFLARE_QUICK_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/iu;

export interface QuickTunnelOptions {
  deps?: TunnelSpawnDeps;
  timeoutMs?: number;
}

export async function startCloudflareQuickTunnel(port: number, options: QuickTunnelOptions = {}): Promise<TunnelControllerLike> {
  const deps = options.deps;
  if (deps === undefined) throw new Error('startCloudflareQuickTunnel requires deps injection (use realSpawnDeps())');
  const probe = checkExecutable('cloudflared', deps);
  if (!probe.available || probe.target === null) {
    throw new TunnelServiceError('missing_dependency', `cloudflared is not available. ${CLOUDFLARE_INSTALL_HINT}`, 'cloudflared binary missing');
  }
  const tempHome = deps.mkdtempSync('openchamber-cf-quick-');
  const child = deps.spawn({
    command: probe.target,
    args: ['tunnel', '--url', `http://127.0.0.1:${port}`],
    // §4.3 HOME is a temp dir; cloudflared is Go and on Windows reads
    // %USERPROFILE% (+APPDATA for its state), so those ride the temp dir too
    // (review P2: HOME-only isolation is a no-op on win32).
    env: {
      ...process.env,
      HOME: tempHome,
      USERPROFILE: tempHome,
      APPDATA: tempHome,
      CF_TELEMETRY_DISABLE: '1',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const cleanup = onceOnly(() => rmTempDir(deps, tempHome));
  const outcome = await settleQuickUrl(child, sink(), options.timeoutMs ?? QUICK_TUNNEL_URL_TIMEOUT_MS);
  if (outcome.kind !== 'url') {
    child.kill('SIGINT');
    cleanup();
    throw new TunnelServiceError(
      'startup_failed',
      outcome.kind === 'timeout' ? 'Tunnel URL not received within 30 seconds' : outcome.message,
      'quick tunnel start failed',
    );
  }

  return createTunnelController({
    provider: 'cloudflare',
    mode: 'quick',
    child,
    publicUrl: outcome.url,
    resolvedHostname: null,
    effectiveConfigPath: null,
    onCleanup: cleanup,
  });
}

function sink(): TunnelOutputSink {
  return new TunnelOutputSink();
}

function onceOnly(work: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    work();
  };
}

/** §4.3 quick settlement: resolve the first trycloudflare URL from either
 * stream; exit/error/timeout all settle the promise for the caller to
 * convert into a TunnelServiceError. */
function settleQuickUrl(
  child: TunnelChildLike,
  sinkLocal: TunnelOutputSink,
  timeoutMs: number,
): Promise<{ kind: 'url'; url: string } | { kind: 'exit'; message: string } | { kind: 'timeout' }> {
  const timers: ReturnType<typeof setTimeout>[] = [];
  const clearTimers = (): void => {
    for (const timer of timers) clearTimeout(timer);
    timers.length = 0;
  };
  let settled = false;
  let settledUrl: string | null = null;
  return new Promise((resolve) => {
    const finish = (result: { kind: 'url'; url: string } | { kind: 'exit'; message: string } | { kind: 'timeout' }): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };
    const onChunk = (chunk: Buffer | string): void => {
      const match = sinkLocal.append(chunk).match(CLOUDFLARE_QUICK_URL_PATTERN);
      if (match === null || match[0] === settledUrl) return;
      settledUrl = match[0];
      finish({ kind: 'url', url: settledUrl });
    };
    attach(child.stdout, onChunk);
    attach(child.stderr, onChunk);
    child.on('exit', (code, signal) => {
      finish({ kind: 'exit', message: `cloudflared exited before producing a tunnel URL (code ${String(code)}, signal ${String(signal)})` });
    });
    child.on('error', (error) => {
      finish({ kind: 'exit', message: `cloudflared failed to start: ${error.message}` });
    });
    timers.push(setTimeout(() => finish({ kind: 'timeout' }), Math.max(0, timeoutMs)));
  });
}

function attach(stream: TunnelChildLike['stdout'] | TunnelChildLike['stderr'], listener: (chunk: Buffer | string) => void): void {
  stream?.on('data', listener);
}
