// SPDX-License-Identifier: Apache-2.0
/**
 * Tunnel HTTP API (doc 08 §4.6, route table doc 03 §5.34): dependency
 * check, provider registry, doctor diagnostics, status, managed-remote
 * token upsert, start, and stop. Registered INSIDE the global UI gate.
 * Error mapping: validation_error/missing_dependency 400,
 * provider_unsupported/mode_unsupported 422, startup_failed 500. Bodies
 * use the bounded reader; responses are no-store. Doctor flags include
 * the CLI-parity `hasSavedManagedRemoteProfile=1` (§4.4) so doctor can
 * pass readiness without tokens riding query strings; POST bodies are
 * never echoed.
 */
import type { Hono } from 'hono';
import { ENV } from '../env.ts';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import { checkExecutable, tunnelSpawnDeps, type TunnelSpawnDeps } from '../lib/tunnels/tunnel-spawn.ts';
import { TUNNEL_PROVIDER_CAPABILITIES, type TunnelProvider } from '../lib/tunnels/tunnel-capabilities.ts';
import { providerCheckFor } from '../lib/tunnels/tunnel-install.ts';
import {
  firstIngressHostname, probeManagedLocalConfig,
} from '../lib/tunnels/cloudflare-managed.ts';
import { resolveTunnelConfigPath, resolveTunnelHostname, TunnelServiceError, type TunnelServiceErrorCode } from '../lib/tunnels/tunnel-validate.ts';
import { getTunnelService, type TunnelService, type TunnelSettingsDefaults } from '../lib/tunnels/tunnel-service.ts';
import { getManagedRemoteProfileStore } from '../lib/tunnels/tunnel-profile-store.ts';
import { readTunnelSettingsDefaults } from '../lib/tunnels/tunnel-settings.ts';
import { getTunnelAuthController } from '../lib/auth/tunnel-auth.ts';
import { getUiAuthController } from '../lib/auth/ui-auth.ts';

const BODY_MAX = 64 * 1024;

/** Tunnel-scope control guard (review P1): a device bearer/URL token may
 * run the tunnel plane anywhere; at local|unknown-socket scope any local
 * caller (open mode/session/cookie) operates the console; everywhere else
 * (tunnel|unknown-public, i.e. the gate admitted a tunnel-session cookie)
 * only READS are allowed — start/stop/token-profile are operator verbs and
 * a stolen one-time link must never become a foothold (an attacker-supplied
 * tunnel head or a linked-free stop). §4.5: the tunnel session grants
 * exactly the local-anonymous level "and nothing above". */
function operatorGuarded(
  headers: Headers,
  url: URL,
  socketAddress?: string,
): Response | null {
  if (getUiAuthController().credentialGrant(headers, url, 'PUT')) return null;
  const scope = getTunnelAuthController().classify(headers, url, socketAddress);
  if (scope !== 'local') {
    return jsonRoute(403, {
      error: 'Tunnel control is disabled for tunnel scope',
      code: 'tunnel_locked',
      tunnelLocked: true,
    });
  }
  return null;
}

function jsonRoute(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function service(): TunnelService {
  return getTunnelService({
    dataDir: ENV.dataDir,
    localPort: ENV.port,
    settings: readTunnelSettingsDefaults,
  });
}

function statusForCode(error: TunnelServiceError): number {
  switch (error.code as TunnelServiceErrorCode) {
    case 'provider_unsupported':
    case 'mode_unsupported':
      return 422;
    case 'startup_failed':
      return 500;
    default:
      return 400;
  }
}

function tunnelFailure(error: unknown, options: { unsupportedAsBadRequest?: boolean } = {}): Response {
  if (error instanceof TunnelServiceError) {
    let status = statusForCode(error);
    if (options.unsupportedAsBadRequest === true) {
      status = error.code === 'provider_unsupported' || error.code === 'mode_unsupported' ? 400 : status;
    }
    return jsonRoute(status, { ok: false, error: error.message, code: error.code, detail: error.detail ?? undefined });
  }
  return jsonRoute(500, { ok: false, error: 'Tunnel service failed', code: 'startup_failed' });
}

function providerParam(value: string | undefined): TunnelProvider {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw === '') return 'cloudflare'; // §4.1 blank fallback
  if (raw === 'cloudflare' || raw === 'ngrok') return raw;
  throw new TunnelServiceError('provider_unsupported', 'Unsupported tunnel provider', `unsupported provider: ${raw}`);
}

interface DoctorCheck {
  id: string;
  label: string;
  status: 'ok' | 'fail' | 'warn';
  detail: string;
}

interface DoctorModeReport {
  mode: string;
  checks: DoctorCheck[];
  summary: { ready: number; failures: number; warnings: number };
  ready: boolean;
  blockers: string[];
}

function doctorCheck(id: string, label: string, status: DoctorCheck['status'], detail: string): DoctorCheck {
  return { id, label, status, detail };
}

export function registerTunnelRoutes(app: Hono): void {
  registerTunnelDiagnosticsRoutes(app);
  registerTunnelControlRoutes(app);
}

/** §4.6 read family: dependency check, provider registry, doctor, status. */
function registerTunnelDiagnosticsRoutes(app: Hono): void {
  app.get('/api/openchamber/tunnel/check', (c) => {
    try {
      const provider = providerParam(c.req.query('provider'));
      const deps = tunnelSpawnDeps();
      return jsonRoute(200, { ok: true, ...providerCheckFor(provider, checkExecutable(provider === 'ngrok' ? 'ngrok' : 'cloudflared', deps), deps) });
    } catch (error) {
      return tunnelFailure(error);
    }
  });

  app.get('/api/openchamber/tunnel/providers', () => jsonRoute(200, { ok: true, providers: TUNNEL_PROVIDER_CAPABILITIES }));

  const doctor = (query: Record<string, string>, body: unknown): Response => {
    try {
      const merged = mergeDoctorFlags(body, query);
      const provider = providerParam(merged.provider);
      const mode = (merged.mode ?? '').trim().toLowerCase();
      const capability = TUNNEL_PROVIDER_CAPABILITIES.find((entry) => entry.key === provider)!;
      if (mode !== '' && !capability.modes.some((descriptor) => descriptor.key === mode)) {
        // doc 03 §5.34 doctor row: unsupported mode is a 400 with the code
        return jsonRoute(400, { ok: false, error: 'Unsupported tunnel mode', code: 'mode_unsupported' });
      }
      const deps = tunnelSpawnDeps();
      const store = getManagedRemoteProfileStore({ dataDir: ENV.dataDir });
      const report = buildDoctorReport(provider, mode, merged, deps, store);
      return jsonRoute(200, { ok: true, provider, ...report });
    } catch (error) {
      return tunnelFailure(error, { unsupportedAsBadRequest: true });
    }
  };
  app.get('/api/openchamber/tunnel/doctor', (c) => doctor(readDoctorQuery(c), null));
  app.post('/api/openchamber/tunnel/doctor', async (c) => {
    const body = await readJsonBodyBounded(c.req.raw, BODY_MAX).catch(() => null);
    return doctor(readDoctorQuery(c), body);
  });

  app.get('/api/openchamber/tunnel/status', () => {
    try {
      return jsonRoute(200, service().status() as unknown as Record<string, unknown>);
    } catch (error) {
      return tunnelFailure(error);
    }
  });
}

/** §4.6 control family: managed-remote token upsert, start, stop — the
 * operator verbs (scope-guarded; diagnostics stay bearer-wide). */
function registerTunnelControlRoutes(app: Hono): void {
  const guard = (c: { req: { raw: Request }; env: unknown }): Response | null => {
    const headers = c.req.raw.headers;
    if (getUiAuthController().credentialGrant(headers, new URL(c.req.raw.url), 'PUT')) return null;
    return operatorGuarded(headers, new URL(c.req.raw.url), socketAddressOf(c.env));
  };

  app.put('/api/openchamber/tunnel/managed-remote-token', async (c) => {
    const denied = guard(c);
    if (denied !== null) return denied;
    try {
      const body = await readJsonBodyBounded(c.req.raw, BODY_MAX).catch(() => null);
      const record = (body ?? {}) as Record<string, unknown>;
      const fields: Array<[string, string | null]> = [
        ['presetId', requiredString(record.presetId)],
        ['presetName', requiredString(record.presetName)],
        ['managedRemoteTunnelHostname', requiredString(record.managedRemoteTunnelHostname)],
        ['managedRemoteTunnelToken', requiredString(record.managedRemoteTunnelToken)],
      ];
      for (const [name, value] of fields) {
        if (value === null) return jsonRoute(400, { error: `Missing managed-remote tunnel field: ${name}`, code: 'validation_error' });
      }
      const store = getManagedRemoteProfileStore({ dataDir: ENV.dataDir });
      await store.upsert({
        id: fields[0]![1] as string,
        name: fields[1]![1] as string,
        hostname: fields[2]![1] as string,
        token: fields[3]![1] as string,
      });
      return jsonRoute(200, { ok: true, managedRemoteTunnelTokenPresetIds: store.list().map((entry) => entry.id) });
    } catch (error) {
      return tunnelFailure(error);
    }
  });

  app.post('/api/openchamber/tunnel/start', async (c) => {
    const denied = guard(c);
    if (denied !== null) return denied;
    try {
      const body = await readJsonBodyBounded(c.req.raw, BODY_MAX).catch(() => null);
      const outcome = await service().start(body);
      return jsonRoute(200, await startResponse(outcome));
    } catch (error) {
      return tunnelFailure(error);
    }
  });

  app.post('/api/openchamber/tunnel/stop', async (c) => {
    const denied = guard(c);
    if (denied !== null) return denied;
    try {
      return jsonRoute(200, await service().stop());
    } catch (error) {
      return tunnelFailure(error);
    }
  });
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Doctor input join: POST body wins, query fills the gaps (§4.6 — body
 * flagged booleans normalize to '1'). */
function mergeDoctorFlags(body: unknown, query: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(body === null || typeof body !== 'object' || Array.isArray(body) ? {} : body as Record<string, unknown>)) {
    if (typeof value === 'string') merged[key] = value;
    if (value === true) merged[key] = '1';
  }
  for (const [key, value] of Object.entries(query)) if (merged[key] === undefined) merged[key] = value;
  return merged;
}

function readDoctorQuery(c: { req: { raw: Request } }): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of new URL(c.req.raw.url).searchParams.entries()) query[key] = value;
  return query;
}

function socketAddressOf(env: unknown): string | undefined {
  const socket = (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket;
  return typeof socket?.remoteAddress === 'string' ? socket.remoteAddress : undefined;
}

/** §4.6 start response: the service outcome enriched with the settings/
 * status overlays + the one-time /connect link built from the fresh
 * bootstrap token. */
async function startResponse(outcome: Awaited<ReturnType<TunnelService['start']>>): Promise<Record<string, unknown>> {
  const settings = readTunnelSettingsDefaults();
  const status = service().status();
  return {
    ...outcome,
    ok: true,
    managedRemoteTunnelHostname: typeof settings.managedRemoteTunnelHostname === 'string' && settings.managedRemoteTunnelHostname !== ''
      ? settings.managedRemoteTunnelHostname
      : null,
    managedRemoteTunnelPresets: status.managedRemoteTunnelPresets,
    managedRemoteTunnelTokenPresetIds: status.managedRemoteTunnelTokenPresetIds,
    connectUrl: `${outcome.url}/connect?t=${outcome.bootstrapToken}`,
    policy: 'tunnel-gated',
    activeTunnelMode: status.activeTunnelMode,
    activeSessions: status.activeSessions,
    localPort: status.localPort,
    ttlConfig: status.ttlConfig,
  };
}

function buildDoctorReport(
  provider: TunnelProvider,
  modeRaw: string,
  flags: Record<string, string>,
  deps: TunnelSpawnDeps,
  store: ReturnType<typeof getManagedRemoteProfileStore>,
): { providerChecks: DoctorCheck[]; modes: DoctorModeReport[] } {
  const settings = readTunnelSettingsDefaults();
  const target = provider === 'ngrok' ? 'ngrok' : 'cloudflared';
  const presence = checkExecutable(target, deps);
  const providerChecks: DoctorCheck[] = [
    presence.available
      ? doctorCheck('binary', `${target} availability`, 'ok', presence.version ?? `${target} found`)
      : doctorCheck('binary', `${target} availability`, 'fail', `${target} is not on PATH`),
  ];
  if (provider === 'ngrok') {
    const tokenPresent = (deps.env('NGROK_AUTHTOKEN') ?? '') !== '';
    providerChecks.push(tokenPresent
      ? doctorCheck('authtoken', 'ngrok authtoken', 'ok', 'NGROK_AUTHTOKEN set')
      : doctorCheck('authtoken', 'ngrok authtoken', 'fail', 'run "ngrok config add-authtoken <your-ngrok-token>" or set NGROK_AUTHTOKEN'));
  }
  const capability = TUNNEL_PROVIDER_CAPABILITIES.find((entry) => entry.key === provider)!;
  const modes = capability.modes
    .filter((descriptor) => modeRaw === '' || descriptor.key === modeRaw)
    .map((descriptor) => describeMode(descriptor.key, flags, deps, store, settings, presence.available));
  return { providerChecks, modes };
}

function describeMode(
  mode: string,
  flags: Record<string, string>,
  deps: TunnelSpawnDeps,
  store: ReturnType<typeof getManagedRemoteProfileStore>,
  settings: TunnelSettingsDefaults,
  binaryOk: boolean,
): DoctorModeReport {
  const checks: DoctorCheck[] = [];
  if (!binaryOk) {
    checks.push(doctorCheck('binary', 'provider binary', 'fail', 'the provider binary is required for every mode'));
  }
  if (mode === 'managed-remote') {
    const tokenFlags = [
      flags.tokenProvided === '1',
      store.hasToken(),
      typeof settings.managedRemoteTunnelToken === 'string' && settings.managedRemoteTunnelToken !== '',
      flags.hasSavedManagedRemoteProfile === '1', // CLI parity flag (§4.4)
    ];
    checks.push(tokenFlags.some(Boolean)
      ? doctorCheck('token', 'run token', 'ok', 'token available from the request, saved profile, or settings')
      : doctorCheck('token', 'run token', 'fail', 'no saved managed-remote token; provide a token or save a profile'));
    const hostname = resolveDoctorHostname(flags.hostname ?? '', settings.managedRemoteTunnelHostname);
    checks.push(hostname === null
      ? doctorCheck('hostname', 'public hostname', 'fail', 'provide a tunnel hostname or set managedRemoteTunnelHostname')
      : doctorCheck('hostname', 'public hostname', 'ok', hostname));
  }
  if (mode === 'managed-local') {
    const resolvedPath = flags.configPath === undefined || flags.configPath === ''
      ? { path: null as string | null }
      : resolveConfigPathForDoctor(flags.configPath ?? '');
    if ('error' in resolvedPath) {
      checks.push(doctorCheck('config', 'cloudflared config file', 'fail', resolvedPath.error.message));
    } else {
      const probe = probeManagedLocalConfig(deps, resolvedPath.path);
      if (probe.ok) {
        checks.push(doctorCheck('config', 'cloudflared config file', 'ok', probe.path));
        const fromConfig = firstIngressHostname(probe.text, probe.path);
        const hostname = flags.hostname !== undefined && flags.hostname !== ''
          ? resolveDoctorHostname(flags.hostname ?? '', null)
          : fromConfig === null ? null : resolveDoctorHostname(fromConfig, null);
        checks.push(hostname === null
          ? doctorCheck('hostname', 'public hostname', 'fail', 'use --hostname or add an ingress hostname to the config')
          : doctorCheck('hostname', 'public hostname', 'ok', hostname));
      } else {
        checks.push(doctorCheck('config', 'cloudflared config file', 'fail', probe.error.message));
      }
    }
  }
  const failures = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  return {
    mode,
    checks,
    summary: { ready: checks.length - failures - warnings, failures, warnings },
    ready: failures === 0,
    blockers: checks.filter((check) => check.status === 'fail').map((check) => `${check.id}: ${check.detail}`),
  };
}

function resolveDoctorHostname(value: string, settingsHostname: unknown): string | null {
  try {
    return resolveTunnelHostname(value) ?? resolveTunnelHostname(settingsHostname);
  } catch {
    return null;
  }
}

/** Doctor config-path resolution: the §4.2 home-containment validator, but
 * doctor answers the validator's message instead of throwing. */
function resolveConfigPathForDoctor(value: string): { path: string | null } | { error: TunnelServiceError } {
  try {
    return { path: resolveTunnelConfigPath(value) };
  } catch (error) {
    return { error: error instanceof TunnelServiceError ? error : new TunnelServiceError('validation_error', String(error), 'config path probe failure') };
  }
}
