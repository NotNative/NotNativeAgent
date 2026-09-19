// SPDX-License-Identifier: Apache-2.0
/**
 * ngrok quick tunnel (doc 08 §4.3): binary presence; authtoken from
 * NGROK_AUTHTOKEN, else `ngrok config check` (failure detail carries the
 * `ngrok config add-authtoken <your-ngrok-token>` remediation);
 * `https://api.ngrok.com/` reachable inside 5 s. Spawn `http --log=stdout
 * --log-format=json 127.0.0.1:<port>`; the public URL parses from stdout
 * JSON lines (`url`/`public_url`; regex fallback) AND is polled from the
 * local ngrok API at 4040 (preferred https tunnel first). URL validation
 * demands `https:` + a hostname containing "ngrok"; failures summarize the
 * recent log lines into the thrown error.
 */
import { checkExecutable, type SpawnRequest, type TunnelChildLike, type TunnelSpawnDeps } from './tunnel-spawn.ts';
import { TunnelServiceError } from './tunnel-validate.ts';
import { NGROK_INSTALL_HINT } from './tunnel-install.ts';
import { createTunnelController, type TunnelControllerLike } from './tunnel-controller.ts';

export const NGROK_URL_TIMEOUT_MS = 30_000;
export const NGROK_API_POLL_MS = 250;
export const NGROK_API_URL = 'http://127.0.0.1:4040/api/tunnels';

export interface NgrokQuickOptions {
  deps: TunnelSpawnDeps;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number;
  pollMs?: number;
}

export async function startNgrokQuickTunnel(port: number, options: NgrokQuickOptions): Promise<TunnelControllerLike> {
  const { deps } = options;
  const probe = checkExecutable('ngrok', deps);
  if (!probe.available || probe.target === null) {
    throw new TunnelServiceError('missing_dependency', `ngrok is not available. ${NGROK_INSTALL_HINT}`, 'ngrok binary missing');
  }
  void probe.target; // reserved for future invocation parity; checks spur below
  await assertNgrokPrerequisites(deps, probe.target, options.fetch ?? fetch);
  const child = deps.spawn({
    command: probe.target,
    args: ['http', '--log=stdout', '--log-format=json', `127.0.0.1:${port}`],
    env: undefined,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  const push = makeNgrokLinePush(lines);
  // stdout lines ride the race's own listener (push + harvest review);
  // stderr only accumulates here for the failure summarizer.
  child.stderr?.on('data', push);

  const harvested = await raceNgrokUrl(child, lines, options).catch((error: unknown) => {
    child.kill('SIGINT');
    throw error instanceof TunnelServiceError ? error : new TunnelServiceError('startup_failed', String(error), 'ngrok start failed');
  });
  if (harvested === null) {
    child.kill('SIGINT');
    throw new TunnelServiceError('startup_failed', summarizeNgrokOutput(lines.slice(-40)), 'ngrok start failed');
  }
  return createTunnelController({
    provider: 'ngrok',
    mode: 'quick',
    child,
    publicUrl: normalizeNgrokPublicUrl(harvested) ?? harvested,
    resolvedHostname: null,
    effectiveConfigPath: null,
  });
}

/** JSON-log line accumulator shared by both stdout and stderr. */
function makeNgrokLinePush(lines: string[]): (chunk: Buffer | string) => string[] {
  return (chunk: Buffer | string): string[] => {
    const incoming = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const line of incoming.split('\n')) {
      const trimmed = line.trim();
      if (trimmed !== '') lines.push(trimmed);
    }
    return lines;
  };
}

async function assertNgrokPrerequisites(deps: TunnelSpawnDeps, target: string, doFetch: typeof fetch): Promise<void> {
  if ((deps.env('NGROK_AUTHTOKEN') ?? '') !== '') return;
  const check = deps.spawnSync(target, ['config', 'check']);
  if (check.status !== 0 || check.error !== undefined) {
    throw new TunnelServiceError('missing_dependency',
      'ngrok authtoken is not configured — run "ngrok config add-authtoken <your-ngrok-token>" or set NGROK_AUTHTOKEN',
      'ngrok authtoken missing');
  }
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await doFetch('https://api.ngrok.com/', { signal: controller.signal });
    if (response.status >= 500) throw new Error(`ngrok API answered ${response.status}`);
  } catch {
    throw new TunnelServiceError('missing_dependency', 'The ngrok API at https://api.ngrok.com/ is unreachable — check the network', 'ngrok api unreachable');
  } finally {
    clearTimeout(abortTimer);
  }
}

/** URL sources race: any-emitted stdout URL, the API poll preferring an
 * https ngrok tunnel, or the 30 s timeout. */
async function raceNgrokUrl(
  child: TunnelChildLike,
  lines: string[],
  options: NgrokQuickOptions,
): Promise<string | null> {
  return new Promise((resolveUrl) => {
    let settled = false;
    const push = makeNgrokLinePush(lines);
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      clearTimeout(abortTimer);
      resolveUrl(value);
    };
    const checkLines = (): void => {
      for (const line of [...lines].reverse()) {
        const candidate = urlFromLogLine(line);
        if (candidate !== null) {
          finish(candidate);
          return;
        }
      }
    };
    const doFetch = options.fetch ?? fetch;
    const poller = setInterval(async () => {
      try {
        const response = await doFetch(NGROK_API_URL, { signal: signalForTimeoutAbort(1500) });
        if (!response.ok) return;
        const doc = await response.json() as { tunnels?: Array<{ public_url?: string; url?: string; proto?: string }> };
        const preferred = pickNgrokApiUrl(doc);
        if (preferred === null) return;
        const normalized = normalizeNgrokPublicUrl(preferred);
        if (normalized === null) return; // non-ngrok URL: keep waiting for the real one
        checkLines();
        finish(normalized);
      } catch {
        // the poll is a secondary source; failures keep the wait on stdout
      }
    }, Math.max(10, options.pollMs ?? NGROK_API_POLL_MS));
    const abortTimer = setTimeout(() => finish(null), Math.max(0, options.timeoutMs ?? NGROK_URL_TIMEOUT_MS));
    child.stdout?.on('data', (chunk) => {
      push(chunk);
      checkLines();
    });
    child.on('exit', (code, signal) => {
      lines.push(`ngrok tunnel exited (code ${String(code)}, signal ${String(signal)})`);
      checkLines();
      finish(null);
    });
    child.on('error', () => {
      checkLines();
    });
    checkLines();
  });
}

function signalForTimeoutAbort(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

/** §4.3 API harvest: the tunnels array flattened to url strings, https
 * tunnels preferred first. */
export function pickNgrokApiUrl(doc: { tunnels?: Array<{ public_url?: string; url?: string; proto?: string }> }): string | null {
  const tunnels = Array.isArray(doc.tunnels) ? doc.tunnels : [];
  const flat = tunnels.map((entry) => entry.public_url ?? entry.url);
  const preferred = flat.find((value) => typeof value === 'string' && value.startsWith('https://'))
    ?? flat.find((value) => typeof value === 'string');
  return typeof preferred === 'string' ? preferred : null;
}

/** Log-line URL harvest: JSON lines carrying `url`/`public_url`, then a
 * regex fallback for non-JSON output; ngrok-host validation applies. */
export function urlFromLogLine(line: string): string | null {
  try {
    const doc = JSON.parse(line) as Record<string, unknown>;
    for (const key of ['url', 'public_url']) {
      const value = doc[key];
      if (typeof value === 'string') return normalizeNgrokPublicUrl(value);
    }
  } catch {
    // non-JSON line: regex fallback below
  }
  const match = line.match(/https:\/\/[a-z0-9-]+\.ngrok[a-z0-9-]*\.(?:io|app|dev|com|dev\.[a-z.]+)\/?/iu);
  if (match === null) return null;
  return normalizeNgrokPublicUrl(match[0]);
}

/** §4.3: https + hostname containing "ngrok"; trailing slash stripped. */
export function normalizeNgrokPublicUrl(value: string): string | null {
  if (!value.startsWith('https://')) return null;
  let host = '';
  try {
    host = new URL(value).hostname;
  } catch {
    return null;
  }
  if (!host.includes('ngrok')) return null;
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/** Failure summarizer (§4.3 summarizeNgrokOutput): the last error-level
 * JSON `err` excluding "context canceled", then failure-ish `msg`, then
 * `ERROR:` lines (up to 4), then the final non-empty line. */
export function summarizeNgrokOutput(lines: readonly string[]): string {
  for (const line of lines) {
    try {
      const doc = JSON.parse(line) as { err?: string; lvl?: unknown; msg?: unknown };
      if (typeof doc.err === 'string' && doc.err !== '' && !doc.err.includes('context canceled')) {
        return `ngrok tunnel failed: ${doc.err}`;
      }
    } catch {
      // JSON-only summarizer fallback
    }
  }
  for (const line of lines) {
    try {
      const doc = JSON.parse(line) as { msg?: unknown; lvl?: unknown };
      if (doc.lvl === 'error' && typeof doc.msg === 'string' && /error|fail|refus|invalid|cannot/iu.test(doc.msg)) {
        return `ngrok tunnel failed: ${doc.msg}`;
      }
    } catch {
      continue;
    }
  }
  const errorCapitals = lines.filter((line) => line.startsWith('ERROR:')).slice(0, 4);
  if (errorCapitals.length > 0) return `ngrok tunnel failed: ${errorCapitals.join('; ')}`;
  const last = lines[lines.length - 1];
  return `ngrok tunnel failed: ${last ?? 'no output received'}`;
}
