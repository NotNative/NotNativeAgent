// SPDX-License-Identifier: Apache-2.0
/**
 * cloudflared managed tunnels (doc 08 §4.3): managed-remote
 * (`tunnel run --token-file <path>`; token temp file 0o600, deleted on
 * exit; stdout drained WITHOUT logging per §12.1, stderr mirrored) and
 * managed-local (`tunnel [--config <path>] run`; default
 * `~/.cloudflared/config.yml`; guarded reads ≤ 256 KiB; hostname from the
 * arg or the first `ingress[].hostname` of the parsed YAML/JSON). Same
 * readiness contract for both: ready/fatal patterns, 6 s liveness
 * fallback on ANY output, 20 s hard failure; failures kill the child and
 * remove the temp token dir.
 */
import { join as pathJoin } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  MANAGED_LOCAL_DEFAULT_CONFIG_PATH, resolveTunnelHostname, TunnelServiceError,
} from './tunnel-validate.ts';
import { checkExecutable, rmTempDir, type SpawnRequest, type TunnelChildLike, type TunnelSpawnDeps } from './tunnel-spawn.ts';
import { CLOUDFLARE_INSTALL_HINT } from './tunnel-install.ts';
import { createTunnelController, type TunnelControllerLike } from './tunnel-controller.ts';
import { waitForTunnelReadiness, type ReadinessOutcome } from './tunnel-readiness.ts';

export const MANAGED_READY_LOG_PATTERNS: readonly RegExp[] = [
  /registered tunnel connection/iu,
  /connection[^\n]*registered/iu,
  /starting metrics server/iu,
  /connected to edge/iu,
];
export const MANAGED_FATAL_LOG_PATTERNS: readonly RegExp[] = [
  /error parsing.*config/iu,
  /failed to .*config/iu,
  /invalid token/iu,
  /unauthorized/iu,
  /credentials file .* not found/iu,
  /provided tunnel credentials are invalid/iu,
];
export const MANAGED_READY_OUTPUT_TIMEOUT_MS = 20_000;
export const MANAGED_READY_LIVENESS_MS = 6_000;
export const MANAGED_LOCAL_CONFIG_MAX_BYTES = 256 * 1024;

export interface ManagedRemoteTunnelOptions {
  deps: TunnelSpawnDeps;
  timeouts?: { outputTimeoutMs?: number; livenessMs?: number };
  mirrorStderr?: boolean;
}

export async function startCloudflareManagedRemoteTunnel(
  port: number,
  input: { token: string | null; hostname: string | null },
  options: ManagedRemoteTunnelOptions,
): Promise<TunnelControllerLike> {
  const { deps } = options;
  if (input.token === null || input.token === '') {
    throw new TunnelServiceError('validation_error', 'Tunnel token is required for managed-remote tunnels', 'token missing');
  }
  if (input.hostname === null || input.hostname === '') {
    throw new TunnelServiceError('validation_error', 'Tunnel hostname is required for managed-remote tunnels', 'hostname missing');
  }
  return startManagedCloudflareTunnel('managed-remote', port, options, () => {
    const hostname = resolveTunnelHostname(input.hostname) as string; // validated above; normalizes case
    const tempDir = deps.mkdtempSync('openchamber-cf-token-');
    const tokenPath = pathJoin(tempDir, 'cf-token');
    deps.writeFileSync(tokenPath, input.token ?? '', { mode: 0o600 });
    const request: SpawnRequest = {
      command: 'cloudflared',
      args: ['tunnel', 'run', '--token-file', tokenPath],
      env: undefined,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    return { request, tempDir, removeOnExit: true, publicUrl: `https://${hostname}`, resolvedHostname: hostname, effectiveConfigPath: null };
  });
}

export async function startCloudflareManagedLocalTunnel(
  port: number,
  input: { configPath: string | null; hostname: string | null },
  options: ManagedRemoteTunnelOptions,
): Promise<TunnelControllerLike> {
  const { deps } = options;
  const requestedConfigPath = input.configPath ?? MANAGED_LOCAL_DEFAULT_CONFIG_PATH;
  const config = readManagedLocalConfig(deps, requestedConfigPath, input.configPath !== null);
  const rawCandidate = input.hostname !== null ? resolveTunnelHostname(input.hostname) : firstIngressHostname(config.text, requestedConfigPath);
  let candidate: string | null = null;
  if (rawCandidate !== null) {
    try {
      candidate = resolveTunnelHostname(rawCandidate); // wildcard/invalid ingress hosts land as null
    } catch {
      candidate = null;
    }
  }
  const hostname = candidate === null
    ? failValidation('Tunnel hostname is required: use --hostname or add an ingress hostname to the config', 'managed-local hostname missing')
    : candidate;
  return startManagedCloudflareTunnel('managed-local', port, options, () => {
    const request: SpawnRequest = {
      command: 'cloudflared',
      args: input.configPath !== null
        ? ['tunnel', '--config', requestedConfigPath, 'run']
        : ['tunnel', 'run'],
      env: undefined,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    return { request, tempDir: null, removeOnExit: false, publicUrl: `https://${hostname}`, resolvedHostname: hostname, effectiveConfigPath: requestedConfigPath };
  });
}

async function startManagedCloudflareTunnel(
  mode: 'managed-remote' | 'managed-local',
  port: number,
  options: ManagedRemoteTunnelOptions,
  prepare: () => { request: SpawnRequest; tempDir: string | null; removeOnExit: boolean; publicUrl: string; resolvedHostname: string | null; effectiveConfigPath: string | null },
): Promise<TunnelControllerLike> {

  const { deps } = options;
  const probe = checkExecutable('cloudflared', deps);
  if (!probe.available || probe.target === null) {
    throw new TunnelServiceError('missing_dependency', `cloudflared is not available. ${CLOUDFLARE_INSTALL_HINT}`, 'cloudflared binary missing');
  }
  const prepared = prepare();
  void port; // managed tunnels address the edge, not the local port (kept for starter parity)
  const request = { ...prepared.request, command: probe.target };
  const child = deps.spawn(request);
  const tempDir = prepared.tempDir;
  const removeTemp = tempDir !== null ? (): void => { rmTempDir(deps, tempDir); } : undefined;
  if (removeTemp !== undefined) {
    child.on('exit', () => removeTemp()); // token file deleted on exit (§4.3/§12.1)
    child.on('error', () => removeTemp());
  }
  // Managed-remote stdout is drained by the readiness sink WITHOUT being
  // logged (§12.1); stderr is mirrored for the operator (the only sink it has).
  if (options.mirrorStderr !== false) {
    child.stderr?.on('data', (chunk) => {
      process.stderr.write(chunk instanceof Buffer ? chunk : String(chunk));
    });
  }

  const wait = waitForTunnelReadiness(child, {
    readyPatterns: MANAGED_READY_LOG_PATTERNS,
    fatalPatterns: MANAGED_FATAL_LOG_PATTERNS,
    outputTimeoutMs: options.timeouts?.outputTimeoutMs ?? MANAGED_READY_OUTPUT_TIMEOUT_MS,
    livenessFallbackMs: options.timeouts?.livenessMs ?? MANAGED_READY_LIVENESS_MS,
  });

  let outcome: ReadinessOutcome;
  try {
    outcome = await wait.promise;
  } catch (rejection) {
    child.kill('SIGINT');
    removeTemp?.();
    throw readinessFailure(rejection);
  }

  return createTunnelController({
    provider: 'cloudflare',
    mode,
    child,
    publicUrl: prepared.publicUrl,
    resolvedHostname: prepared.resolvedHostname,
    effectiveConfigPath: prepared.effectiveConfigPath,
    onCleanup: removeTemp,
  });
}

function readinessFailure(rejection: unknown): TunnelServiceError {
  const reason = (rejection as { kind?: string; reason?: string; error?: Error; code?: number | null; signal?: string | null });
  const detail = reason.kind === 'fatal'
    ? `managed tunnel refused: ${reason.reason}`
    : reason.kind === 'exit'
      ? `cloudflared exited before the tunnel registered (code ${String(reason.code)}, signal ${String(reason.signal)})`
      : reason.kind === 'error'
        ? `cloudflared failed to start: ${reason.error?.message ?? 'unknown error'}`
        : 'managed tunnel readiness timed out (no ready signal within 20 seconds)';
  return new TunnelServiceError('startup_failed', detail, 'managed tunnel start failed');
}

function failValidation(message: string, detail: string): never {
  throw new TunnelServiceError('validation_error', message, detail);
}

/** Doctor probe (§4.6): the guarded read without a start attempt; returns
 * the resolved path/text so the doctor can parse an ingress hostname. */
export function probeManagedLocalConfig(
  deps: TunnelSpawnDeps,
  configPath: string | null,
): { ok: true; path: string; text: string } | { ok: false; error: TunnelServiceError } {
  try {
    const config = readManagedLocalConfig(deps, configPath ?? MANAGED_LOCAL_DEFAULT_CONFIG_PATH, configPath !== null);
    return { ok: true, path: config.path, text: config.text };
  } catch (error) {
    return { ok: false, error: error instanceof TunnelServiceError ? error : new TunnelServiceError('validation_error', String(error), 'config probe failure') };
  }
}

/** Guarded read (§4.3 assertReadableFile): file exists, is a file, has a
 * managed extension, is non-empty, ≤ 256 KiB, and is readable. */
function readManagedLocalConfig(
  deps: TunnelSpawnDeps,
  configPath: string,
  requested: boolean,
): { path: string; text: string } {
  if (configPath === '' || deps.exists(configPath) === false) throw configMissing(configPath, requested);
  if (deps.statIsFile(configPath) !== true) {
    throw validation('Managed-local tunnel config must be a regular file', `not a file: ${configPath}`);
  }
  if (!/\.(ya?ml|json)$/iu.test(configPath)) {
    throw validation('Managed-local tunnel config must be .yml, .yaml or .json', `bad extension: ${configPath}`);
  }
  const size = deps.fileSize(configPath);
  if (size === 0) throw validation('Managed-local tunnel config must not be empty', `empty config: ${configPath}`);
  if (size !== null && size > MANAGED_LOCAL_CONFIG_MAX_BYTES) {
    throw validation('Managed-local tunnel config must stay under 256 KiB', `oversize config: ${configPath}`);
  }
  let text;
  try {
    text = deps.readText(configPath);
  } catch {
    throw validation('Managed-local tunnel config could not be read', `unreadable: ${configPath}`);
  }
  return { path: configPath, text };
}

function configMissing(path: string, requested: boolean): TunnelServiceError {
  const message = requested
    ? `Managed-local tunnel config not found at ${path}`
    : `Default cloudflared config not found at ${path}`;
  return new TunnelServiceError('validation_error', message, 'missing managed-local config');
}

function validation(message: string, detail: string): TunnelServiceError {
  return new TunnelServiceError('validation_error', message, detail);
}

/** First `ingress[].hostname` of the parsed YAML/JSON; a parse failure is
 * an explicit error, a wildcard/empty hostname is treated as absent (§4.3
 * hostnames must be concrete). */
export function firstIngressHostname(configText: string, configPath: string): string | null {
  let parsed: unknown;
  try {
    parsed = configPath.endsWith('.json') ? JSON.parse(configText) : (parseYaml(configText) as unknown);
  } catch (error) {
    // review P2: never echo file content through parse errors into responses
    void error;
    throw new TunnelServiceError('validation_error', 'Managed-local tunnel config could not be parsed', 'config parse failure');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const ingress = (parsed as Record<string, unknown>)['ingress'];
  if (!Array.isArray(ingress)) return null;
  for (const entry of ingress) {
    const hostname = (entry as Record<string, unknown> | null)?.['hostname'];
    if (typeof hostname === 'string' && hostname.trim() !== '' && !hostname.includes('*')) return hostname;
  }
  return null;
}
