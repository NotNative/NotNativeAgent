// SPDX-License-Identifier: Apache-2.0
/**
 * Tunnel service (doc 08 §4.2/§4.6/§4.7): ONE live controller per
 * instance. `start` serializes through a promise mutex; concurrent starts
 * cannot orphan child processes. Same provider+mode+publicUrl re-start
 * reuses the tunnel id (cookie-bearing sessions of it survive); a
 * different provider/mode/url stops the previous controller first, then
 * revokes the previous tunnel's artifacts (newest-only bootstrap + all its
 * sessions, reason 'tunnel-revoked'). A failed start clears controller and
 * active record WITHOUT revoking previous artifacts (§4.7 failure path).
 * `stop` invalidates even when the controller is already gone, and a dead
 * controller is lazily re-synced to inactive by `status` (no revocation).
 */
import { randomBytes } from 'node:crypto';
import { getTunnelAuthController, type TunnelAuthController, type TunnelSession } from '../auth/tunnel-auth.ts';
import { getManagedRemoteProfileStore, type ManagedRemoteProfileStore } from './tunnel-profile-store.ts';
import {
  normalizeTunnelStartRequest, TunnelServiceError, type NormalizedTunnelStartRequest,
} from './tunnel-validate.ts';
import { tunnelSpawnDeps, type TunnelSpawnDeps } from './tunnel-spawn.ts';
import { buildDefaultStarters, type TunnelStarterRegistry } from './tunnel-starters.ts';
import type { TunnelControllerLike } from './tunnel-controller.ts';

export interface TunnelSettingsDefaults {
  provider?: unknown;
  mode?: unknown;
  managedLocalTunnelConfigPath?: unknown;
  managedRemoteTunnelHostname?: unknown;
  managedRemoteTunnelToken?: unknown;
  tunnelBootstrapTtlMs?: number | null;
  tunnelSessionTtlMs?: number | null;
}

export interface TunnelServiceOptions {
  dataDir?: string;
  localPort: number;
  settings: () => TunnelSettingsDefaults;
  tunnelAuth?: TunnelAuthController;
  profileStore?: ManagedRemoteProfileStore;
  spawnDeps?: TunnelSpawnDeps;
  starters?: TunnelStarterRegistry;
}

export interface TunnelStartOutcome {
  url: string;
  mode: string;
  provider: string;
  providerMetadata: { configPath: string | null; resolvedHostname: string | null };
  tunnelId: string;
  bootstrapToken: string;
  bootstrapExpiresAt: string | null;
  replacedTunnel: boolean;
  replaced: { mode: string; provider: string; url: string } | null;
  revokedBootstrapCount: number;
  invalidatedSessionCount: number;
}

export interface TunnelStopOutcome {
  ok: true;
  revokedBootstrapCount: number;
  invalidatedSessionCount: number;
}

export interface TunnelStatus {
  active: boolean;
  url: string | null;
  mode: string | null;
  provider: string | null;
  providerMetadata: { configPath: string | null; resolvedHostname: string | null };
  hasManagedRemoteTunnelToken: boolean;
  managedRemoteTunnelHostname: string | null;
  managedRemoteTunnelPresets: Array<{ id: string; name: string; hostname: string }>;
  managedRemoteTunnelTokenPresetIds: string[];
  hasBootstrapToken: boolean;
  bootstrapExpiresAt: string | null;
  policy: 'tunnel-gated';
  activeTunnelMode: string | null;
  activeSessions: Array<Record<string, unknown>>;
  localPort: number;
  ttlConfig: { bootstrapTtlMs: number; sessionTtlMs: number };
}

function asBlankableString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function blankOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function publicUrlFor(request: NormalizedTunnelStartRequest): string {
  if (request.mode === 'quick') return 'quick'; // per-process random URLs: never reusable
  return `https://${request.hostname ?? ''}`;
}

const JUNK_PASSTHROUGH = Symbol('junk');

/** A present-but-non-string request field rides into the normalizer
 * verbatim so it throws validation_error instead of silently falling
 * through to stored secrets (review P2). */
function carriedJunk(...fields: readonly unknown[]): unknown {
  for (const field of fields) {
    if (field !== undefined && field !== null && typeof field !== 'string') return field;
  }
  return JUNK_PASSTHROUGH;
}

function firstNonBlankString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

export class TunnelService {
  private readonly tunnelAuth: TunnelAuthController;
  private readonly profileStore: ManagedRemoteProfileStore;
  private readonly localPort: number;
  private readonly settings: () => TunnelSettingsDefaults;
  private readonly spawnDeps: TunnelSpawnDeps | null;
  private readonly starters: TunnelStarterRegistry;
  private controller: TunnelControllerLike | null = null;
  /** §4.7: provider+mode+url of the last recorded tunnel (id-reuse anchor
   * across controller deaths and failed starts). */
  private lastDescriptor: { provider: string; mode: string; url: string; tunnelId: string } | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: TunnelServiceOptions) {
    this.tunnelAuth = options.tunnelAuth ?? getTunnelAuthController();
    this.profileStore = options.profileStore ?? getManagedRemoteProfileStore({ dataDir: options.dataDir });
    this.localPort = options.localPort;
    this.settings = options.settings;
    this.spawnDeps = options.spawnDeps ?? null;
    this.starters = options.starters ?? buildDefaultStarters();
  }

  /** §4.2 mutex: concurrent starts serialize; one failure never strands
   * the next start (the chain continues past rejections). */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const local = this.tail.then(work, work);
    this.tail = local.then(() => undefined, () => undefined);
    return local;
  }

  async start(raw: unknown): Promise<TunnelStartOutcome> {
    return (await this.enqueue(async () => this.startLocked(raw))) as TunnelStartOutcome;
  }

  async stop(): Promise<TunnelStopOutcome> {
    return (await this.enqueue(async () => this.stopLocked())) as TunnelStopOutcome;
  }

  /** §4.6 status: lazily re-syncs a dead controller to inactive before
   * answering (no revocation — holding cookies stay intact until the
   * operator stops or replaces the tunnel). */
  status(): TunnelStatus {
    if (this.controller !== null && !this.controller.isAlive()) {
      this.controller = null;
      this.tunnelAuth.detachActiveTunnel();
    }
    const active = this.tunnelAuth.activeTunnel();
    const defaults = this.settings();
    const storeToken = this.profileStore.hasToken();
    const settingsToken = blankOrNull(defaults.managedRemoteTunnelToken) !== null;
    const presets = this.profileStore.view();
    const now = Date.now();
    return {
      active: active !== null,
      url: active?.publicUrl ?? null,
      mode: active?.mode ?? null,
      provider: active !== null ? this.lastDescriptor?.provider ?? null : null,
      providerMetadata: {
        configPath: this.controller?.effectiveConfigPath() ?? null,
        resolvedHostname: this.controller?.resolvedHostname() ?? null,
      },
      hasManagedRemoteTunnelToken: storeToken || settingsToken,
      managedRemoteTunnelHostname: blankOrNull(defaults.managedRemoteTunnelHostname),
      managedRemoteTunnelPresets: presets,
      managedRemoteTunnelTokenPresetIds: presets.map((preset) => preset.id),
      hasBootstrapToken: this.tunnelAuth.hasLiveBootstrapToken(),
      bootstrapExpiresAt: this.tunnelAuth.bootstrapExpiresAt(),
      policy: 'tunnel-gated',
      activeTunnelMode: active?.mode ?? null,
      activeSessions: this.tunnelAuth.sessionList().map((session) => statusSession(session, now)),
      localPort: this.localPort,
      ttlConfig: {
        bootstrapTtlMs: this.tunnelAuth.bootstrapTtl.enabled ? this.tunnelAuth.bootstrapTtl.ms : 0,
        sessionTtlMs: this.tunnelAuth.sessionTtl,
      },
    };
  }

  async dispose(): Promise<void> {
    try {
      await this.stop();
    } catch {
      // dispose never throws (§4.7: shutdown degrades silently)
    }
  }

  private async startLocked(raw: unknown): Promise<TunnelStartOutcome> {
    const request = this.buildRequest(raw);
    const previous = this.lastDescriptor;
    const requestKey = publicUrlFor(request); // 'quick' (never reusable) or the derived https URL
    if (this.controller !== null && this.controller.isAlive()
      && this.controller.provider === request.provider
      && this.controller.mode === request.mode
      && request.mode !== 'quick'
      && this.controller.getPublicUrl() === requestKey) {
      // Same-config re-start (§4.2 reuse): fresh bootstrap link, same tunnel
      // id, sessions untouched.
      const rotated = this.tunnelAuth.issueBootstrapToken();
      return this.outcomeFor(this.controller, request, rotated, {
        replaced: false,
        replacedFrom: null,
        revokedBootstrapCount: 1,
        invalidatedSessionCount: 0,
        tunnelId: this.tunnelAuth.activeTunnel()!.tunnelId,
      });
    }
    if (this.controller !== null) {
      this.controller.stop(); // one-controller invariant (§4.2)
      this.controller = null;
    }
    let controller: TunnelControllerLike;
    try {
      controller = await this.startController(request);
    } catch (error) {
      this.controller = null;
      this.tunnelAuth.detachActiveTunnel(); // §4.7 failure path: clear, do not revoke
      if (error instanceof TunnelServiceError) throw error;
      throw new TunnelServiceError('startup_failed', `Tunnel start failed: ${String(error)}`, 'starter failure');
    }
    const url = controller.getPublicUrl();
    const replacement = previous !== null
      && (previous.provider !== request.provider
        || previous.mode !== request.mode
        || previous.url !== url);
    const tunnelId = !replacement && previous !== null
      ? previous.tunnelId // idempotent re-start (even after a death) keeps the id
      : `tnl_${randomBytes(12).toString('hex')}`;
    this.tunnelAuth.setActiveTunnel({ tunnelId, publicUrl: url, mode: request.mode });
    let revokedBootstrapCount = 0;
    let invalidatedSessionCount = 0;
    if (replacement && previous !== null) {
      const revoked = this.tunnelAuth.revokeTunnelArtifacts(previous.tunnelId);
      revokedBootstrapCount = revoked.revokedBootstrapCount;
      invalidatedSessionCount = revoked.invalidatedSessionCount;
    }
    const rotated = this.tunnelAuth.issueBootstrapToken();
    this.lastDescriptor = { provider: request.provider, mode: request.mode, url, tunnelId };
    this.controller = controller;
    return this.outcomeFor(controller, request, rotated, {
      replaced: replacement,
      replacedFrom: replacement ? { mode: previous!.mode, provider: previous!.provider, url: previous!.url } : null,
      revokedBootstrapCount,
      invalidatedSessionCount,
      tunnelId,
    });
  }

  private async stopLocked(): Promise<TunnelStopOutcome> {
    const counts = this.tunnelAuth.clearActiveTunnel(); // revoke-first (§4.7)
    this.controller?.stop();
    this.controller = null;
    this.lastDescriptor = null;
    return { ok: true, revokedBootstrapCount: counts.revokedBootstrapCount, invalidatedSessionCount: counts.invalidatedSessionCount };
  }

  private outcomeFor(
    controller: TunnelControllerLike,
    request: NormalizedTunnelStartRequest,
    rotated: { token: string; record: { expiresAt: string | null } },
    rest: { replaced: boolean; replacedFrom: { mode: string; provider: string; url: string } | null; revokedBootstrapCount: number; invalidatedSessionCount: number; tunnelId: string },
  ): TunnelStartOutcome {
    return {
      url: controller.getPublicUrl(),
      mode: request.mode,
      provider: request.provider,
      providerMetadata: {
        configPath: controller.effectiveConfigPath(),
        resolvedHostname: controller.resolvedHostname(),
      },
      tunnelId: rest.tunnelId,
      bootstrapToken: rotated.token,
      bootstrapExpiresAt: rotated.record.expiresAt,
      replacedTunnel: rest.replaced,
      replaced: rest.replacedFrom,
      revokedBootstrapCount: rest.revokedBootstrapCount,
      invalidatedSessionCount: rest.invalidatedSessionCount,
    };
  }

  /** §4.4 resolution order: request `token`|`tunnelToken`|
   * `managedRemoteTunnelToken` → profile store (presetId, then hostname) →
   * settings `managedRemoteTunnelToken`; hostname chain mirrors the doc 03
   * surface aliases then the settings hostname. Non-string VALUES (junk
   * types) are passed through untouched so the shared normalizer throws
   * validation_error instead of silently falling through to stored secrets
   * (review P2). Deliberate deviation (ledger): the §5.34 per-request
   * `connectTtlMs`/`sessionTtlMs`/`managedRemoteTunnelPresetName` fields
   * are not honored in this rebuild — TTLs are settings-governed (§11.2). */
  private buildRequest(raw: unknown): NormalizedTunnelStartRequest {
    const record = raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw) ? {} : (raw as Record<string, unknown>);
    const defaults = this.settings();
    const hostnameJunk = carriedJunk(record.hostname, record.tunnelHostname, record.managedRemoteTunnelHostname);
    const rawHostname = hostnameJunk !== JUNK_PASSTHROUGH
      ? hostnameJunk
      : firstNonBlankString(record.hostname, record.tunnelHostname, record.managedRemoteTunnelHostname, defaults.managedRemoteTunnelHostname);
    const presetId = typeof record.managedRemoteTunnelPresetId === 'string' && record.managedRemoteTunnelPresetId !== ''
      ? record.managedRemoteTunnelPresetId
      : null;
    const storeToken = this.profileStore.resolveToken({ presetId, hostname: typeof rawHostname === 'string' ? rawHostname : null });
    const tokenJunk = carriedJunk(record.token, record.tunnelToken, record.managedRemoteTunnelToken);
    const rawToken = tokenJunk !== JUNK_PASSTHROUGH
      ? tokenJunk
      : firstNonBlankString(record.token, record.tunnelToken, record.managedRemoteTunnelToken, storeToken === '' ? null : storeToken, defaults.managedRemoteTunnelToken === '' ? null : defaults.managedRemoteTunnelToken);
    return normalizeTunnelStartRequest(
      { ...record, token: rawToken, hostname: rawHostname },
      { provider: defaults.provider, mode: defaults.mode, configPath: defaults.managedLocalTunnelConfigPath },
    );
  }

  private async startController(request: NormalizedTunnelStartRequest): Promise<TunnelControllerLike> {
    const starter = this.starters[`${request.provider}:${request.mode}`];
    if (starter === undefined) {
      throw new TunnelServiceError('mode_unsupported', 'Unsupported tunnel mode', `no starter for ${request.provider}:${request.mode}`);
    }
    return starter(this.localPort, request, this.spawnDeps ?? tunnelSpawnDeps());
  }
}

function statusSession(session: TunnelSession, now: number): Record<string, unknown> {
  const revoked = session.revokedAt !== null;
  const expired = Date.parse(session.expiresAt) <= now;
  const status = revoked ? 'revoked' : expired ? 'expired' : 'active';
  const inactiveReason = revoked ? 'tunnel-revoked' : expired ? 'session-expired' : '';
  return {
    sessionId: session.sessionId,
    tunnelId: session.tunnelId,
    mode: session.mode,
    publicUrl: session.publicUrl,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
    status,
    inactiveReason,
  };
}

let singleton: TunnelService | null = null;

export function getTunnelService(options?: TunnelServiceOptions): TunnelService {
  if (singleton === null) {
    if (options === undefined) {
      throw new Error('getTunnelService requires options on first call (localPort + settings reader)');
    }
    singleton = new TunnelService(options);
  }
  return singleton;
}

export function resetTunnelServiceForTests(): void {
  singleton = null;
}
