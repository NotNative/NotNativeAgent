// SPDX-License-Identifier: Apache-2.0
/**
 * Relay host service (doc 08 §3.12, step-8 tail): the demand-driven relay
 * lifecycle — never a remembered switch. Demand signals (relay pairing
 * sessions / paired relay devices) reconcile `privateRelay.enabled` and
 * start/stop the host; the machine claim (`relay-host.lock`) arbitrates
 * which local instance hosts, with the 30 s watcher stand-down and the
 * 120 s takeover grace; a passive hold-out (§3.12 env) suppresses
 * boot/demand/watcher hosting while explicit enable/pairing still hosts
 * (force-claim). §3.15 routes live in routes/relay.ts behind the global
 * UI auth gate.
 */
import { ENV } from '../../env.ts';
import {
  getSharedRelayIdentityStore,
  publicJwkCanonical,
  type RelayIdentity,
  type RelayIdentityStore,
} from './identity.ts';
import {
  RelayConfigStore,
  normalizeRelayUrl,
  readRelayHostHoldOut,
  relayUrlLocked,
  resolveRelayUrl,
  DEFAULT_RELAY_URL,
} from './relay-config.ts';
import { RelayHostLock, type RelayClaimOutcome } from './host-lock.ts';
import { RELAY_CLOSE, RelayHostBroker } from './host-broker.ts';
import { type CapabilityOptions } from './handshake.ts';
import { createRelayLegHost, type RelayLegHost } from './leg-host.ts';
import type { RelayHostStatus } from './host-broker.ts';
import type { ManagedHost, RelayHostServiceTiming } from './host-service-types.ts';

export const DEFAULT_RELAY_SERVICE_TIMING: RelayHostServiceTiming = {
  claimWatcherMs: 30_000,
  demandPollMs: 60_000,
  claimTakeoverGraceMs: 120_000,
};

export type DemandSignal = () => boolean | Promise<boolean>;

export type RelayLifecycleState = 'disabled' | 'connecting' | 'connected' | 'reconnecting' | 'standby';

export interface RelayServiceStatus {
  enabled: boolean;
  state: RelayLifecycleState;
  serverId: string | null;
  connectedClients: number;
  relayUrl: string | null;
  relayUrlLocked: boolean;
  lastError?: string | null;
}

export interface RelayCandidate {
  type: 'relay';
  relayUrl: string;
  serverId: string;
  hostEncPubJwk: Record<string, unknown>;
  priority: number;
}

export interface RelayHostService {
  /** Demand reconcile (§3.12): boot, pairing create/cancel/redeem, device
   * revoke/purge and the 60 s poll all funnel here. A failed demand check
   * with no affirmative answer THROWS — a read failure never fakes “no
   * demand” on live relay devices. */
  reconcile(): Promise<void>;
  /** Boot wiring: reconcile now, arm the 60 s demand poll and the 30 s
   * claim watcher (§3.12). */
  start(): void;
  /** §3.12 pairing turn-on: writes enabled:true if needed, starts the
   * host with a force-claim, returns the §3.13 relay candidate (null
   * when the host is down or the config is unreadable). */
  ensureEnabledForPairing(): Promise<RelayCandidate | null>;
  /** §3.15 enable: normalize the URL, persist, restart the host with
   * force-claim (bypasses the passive hold-out). */
  enable(relayUrl?: unknown): Promise<RelayServiceStatus>;
  /** §3.15 disable: persist enabled:false, stop host + watcher. */
  disable(): Promise<RelayServiceStatus>;
  /** §3.13: the relay candidate while the host is up; null otherwise. */
  getPairingCandidate(): Promise<RelayCandidate | null>;
  /** §3.12 status shape. */
  getStatus(): Promise<RelayServiceStatus>;
  dispose(): void;
}

export interface RelayHostServiceOptions {
  dataDir?: string;
  identity?: RelayIdentityStore;
  config?: RelayConfigStore;
  lock?: RelayHostLock;
  demandSignals?: DemandSignal[];
  timing?: Partial<RelayHostServiceTiming>;
  /** Host seam: the default builds the real broker + §3.9 leg mux. */
  hostFactory?: (identity: RelayIdentityStore, relayUrl: string) => Promise<ManagedHost>;
  localPort?: number;
  platform?: string;
  appVersion?: string;
}

export function createRelayHostService(options: RelayHostServiceOptions = {}): RelayHostService {
  return new RelayHostServiceImpl(options);
}

// —— process-wide lifecycle (boot creates ONE service; routes reuse it) -------

let singleton: RelayHostService | null = null;

/** The running relay lifecycle. Boot passes the full options (demand
 * signals, timings); route/table consumers resolve it without re-opts. */
export function getRelayHostService(options?: RelayHostServiceOptions): RelayHostService {
  if (singleton === null) singleton = createRelayHostService(options);
  return singleton;
}

/** Test seam: disposes and forgets the singleton's timers/host. */
export function resetRelayHostServiceForTests(): void {
  if (singleton === null) return;
  singleton.dispose();
  singleton = null;
}

interface StandbyNote {
  text: string;
  since: number;
}

class RelayHostServiceImpl implements RelayHostService {
  private readonly identity: RelayIdentityStore;
  private readonly config: RelayConfigStore;
  private readonly lock: RelayHostLock;
  private readonly demandSignals: DemandSignal[];
  private readonly timing: RelayHostServiceTiming;
  private readonly hostFactory: (identity: RelayIdentityStore, relayUrl: string) => Promise<ManagedHost>;
  private readonly localPort: number;
  private readonly platform?: string;
  private readonly appVersion?: string;

  private host: ManagedHost | null = null;
  private standby: StandbyNote | null = null;
  private holdNote: string | null = null;
  private configNote: string | null = null;
  private poll: NodeJS.Timeout | null = null;
  private watcher: NodeJS.Timeout | null = null;

  constructor(options: RelayHostServiceOptions) {
    const dataDir = options.dataDir ?? ENV.dataDir;
    this.identity = options.identity ?? getSharedRelayIdentityStore(dataDir);
    this.config = options.config ?? new RelayConfigStore(dataDir);
    this.lock = options.lock ?? new RelayHostLock({ dataDir });
    this.demandSignals = options.demandSignals ?? [];
    this.timing = { ...DEFAULT_RELAY_SERVICE_TIMING, ...options.timing };
    this.localPort = options.localPort ?? ENV.port;
    this.platform = options.platform;
    this.appVersion = options.appVersion;
    this.hostFactory = options.hostFactory ?? defaultHostFactory(this.legWiring());
  }

  async reconcile(): Promise<void> {
    const config = this.requireHealthyConfig();
    const demand = await evaluateDemand(this.demandSignals);
    if (demand !== config.enabled) this.config.write({ enabled: demand, relayUrl: config.relayUrl });
    if (demand) await this.startHost({ force: false });
    else this.shutHostDown();
  }

  start(): void {
    this.clearMachines();
    void this.reconcile().catch((error: unknown) => {
      this.configNote = `relay lifecycle failed: ${messageOf(error)}`;
    });
    this.ensureMachines();
  }

  async ensureEnabledForPairing(): Promise<RelayCandidate | null> {
    const config = this.requireHealthyConfig();
    if (!config.enabled) this.config.write({ enabled: true, relayUrl: config.relayUrl });
    try {
      if (this.host !== null) {
        this.lock.forceClaim(); // reclaim authority even while running
        return this.getPairingCandidate();
      }
      await this.startHost({ force: true });
      return this.getPairingCandidate();
    } finally {
      this.ensureMachines(); // pairing creation re-arms the demand poll + watcher after any disable
    }
  }

  async enable(relayUrl?: unknown): Promise<RelayServiceStatus> {
    const config = this.requireHealthyConfig();
    const persist = typeof relayUrl === 'string' && relayUrl.length > 0
      ? normalizeRelayUrl(relayUrl)
      : config.relayUrl;
    this.config.write({ enabled: true, relayUrl: persist });
    try {
      await this.startHost({ force: true, restartIfRunning: true });
    } finally {
      this.ensureMachines();
    }
    return this.getStatus();
  }

  async disable(): Promise<RelayServiceStatus> {
    try {
      const config = this.requireHealthyConfig();
      if (config.enabled) this.config.write({ enabled: false, relayUrl: config.relayUrl });
    } catch {
      // corrupt config stays unrewritten (the service is stopped anyway)
    }
    this.shutHostDown();
    this.standby = null;
    this.lock.release();
    // the 60 s demand poll stays armed (§3.12: headless pairing writes and
    // pending sessions resurface within a minute) and the watcher keeps
    // no-oping while the service is fully idle
    return this.getStatus();
  }

  async getPairingCandidate(): Promise<RelayCandidate | null> {
    const broker = this.host;
    if (broker === null || this.config.read().corrupt) return null;
    const status = broker.getStatus();
    if (status.state === 'disabled' || status.serverId === null) return null;
    let identity: RelayIdentity;
    try {
      identity = await this.identity.resolve();
    } catch {
      return null;
    }
    return {
      type: 'relay',
      relayUrl: status.relayUrl ?? DEFAULT_RELAY_URL,
      serverId: status.serverId,
      hostEncPubJwk: publicJwkCanonical(identity.encryption.publicJwk) as unknown as Record<string, unknown>,
      priority: 30,
    };
  }

  async getStatus(): Promise<RelayServiceStatus> {
    const config = this.config.read();
    const brokerStatus = this.host !== null ? this.host.getStatus() : null;
    let serverId: string | null = null;
    try {
      serverId = brokerStatus?.serverId ?? (await this.identity.serverId());
    } catch {
      serverId = null;
    }
    let state: RelayLifecycleState = 'disabled';
    if (this.standby !== null || this.holdNote !== null) state = 'standby';
    else if (brokerStatus !== null) state = brokerStatus.state === 'disabled' ? 'disabled' : brokerStatus.state;
    return {
      enabled: config.corrupt ? false : config.enabled,
      state,
      serverId,
      connectedClients: brokerStatus?.connectedClients ?? 0,
      relayUrl: brokerStatus?.relayUrl ?? (config.corrupt ? null : resolveRelayUrl(config)),
      relayUrlLocked: relayUrlLocked(),
      lastError: this.composeLastError(brokerStatus?.lastError ?? null),
    };
  }

  dispose(): void {
    this.shutHostDown();
    this.standby = null;
    this.clearMachines();
    this.lock.release();
  }

  // —— stage internals ---------------------------------------------------------

  private async startHost(input: { force: boolean; restartIfRunning?: boolean }): Promise<void> {
    if (readRelayHostHoldOut() && !input.force) {
      this.holdNote = 'relay hosting is disabled on this instance (passive hold-out)';
      this.shutHostDown();
      return;
    }
    this.holdNote = null;
    if (this.host !== null && !input.restartIfRunning) return;
    // §3.12 takeover grace: while a standby hold is active the freed claim
    // is claimable only after the grace (watcher or reconcile alike); a
    // fresh boot carries no standby and reclaims instantly.
    const standby = this.standby;
    if (standby !== null && !input.force && Date.now() - standby.since < this.timing.claimTakeoverGraceMs) return;
    const claim = input.force ? this.lock.forceClaim() : this.lock.tryClaim();
    if (claim === 'contended') {
      this.shutHostDown();
      this.standby = this.takeoverStandbyNote();
      return;
    }
    // 'claimed' (ours now) or 'write-failed' (§3.12 pre-lock posture: the
    // host still starts; the worker arbitrates). The lock already warned.
    this.shutHostDown();
    this.standby = null;
    const relayUrl = this.resolveRelayUrlWithConfig();
    const created = await this.hostFactory(this.identity, relayUrl);
    this.host = created;
    try {
      await created.start({ relayUrl, platform: this.platform, appVersion: this.appVersion });
    } catch (error: unknown) {
      this.host = null;
      created.stop();
      throw error;
    }
  }

  private runClaimWatcher(): void {
    if (this.host === null && this.standby === null) return;
    const foreign = this.lock.foreignClaimant();
    if (this.host !== null) {
      if (foreign !== null) {
        this.shutHostDown();
        this.standby = this.takeoverStandbyNote();
      }
      return;
    }
    if (this.holdNote !== null) return; // held instances never take over via the watcher
    const standby = this.standby;
    if (standby === null) return;
    if (Date.now() - standby.since < this.timing.claimTakeoverGraceMs) return;
    if (foreign !== null) return;
    if (this.lock.tryClaim() === 'claimed') {
      this.standby = null;
      void this.startHost({ force: true }).catch((error: unknown) => {
        this.configNote = `relay takeover failed: ${messageOf(error)}`;
      });
    }
  }

  /** The pid-named stand-down note; NULL claim is the generic fallback
   * (e.g. the claim died between poll and prod). */
  private takeoverStandbyNote(): StandbyNote {
    const foreign = this.lock.foreignClaimant();
    const text = foreign !== null
      ? `relay host is owned by another local OpenChamber process (pid ${foreign.pid})`
      : 'relay host claim is held elsewhere';
    return { text, since: Date.now() };
  }

  private composeLastError(brokerError: string | null): string | null {
    return this.configNote ?? this.holdNote ?? this.standby?.text ?? brokerError;
  }

  private shutHostDown(): void {
    const host = this.host;
    this.host = null;
    host?.stop();
  }

  private clearMachines(): void {
    if (this.poll !== null) clearInterval(this.poll);
    if (this.watcher !== null) clearInterval(this.watcher);
    this.poll = null;
    this.watcher = null;
  }

  /** Arms the 60 s demand poll + 30 s claim watcher exactly once. Explicit
   * turn-ons (enable/pairing) call this so a lifecycle that was never
   * started (route-only singletons) or is being resumed still reconciles. */
  private ensureMachines(): void {
    if (this.poll !== null && this.watcher !== null) return;
    this.clearMachines(); // drop any partial pair before re-arming
    this.poll = setInterval(() => {
      void this.reconcile().catch((error: unknown) => {
        this.configNote = `relay demand poll failed: ${messageOf(error)}`;
      });
    }, this.timing.demandPollMs);
    this.poll.unref?.();
    this.watcher = setInterval(() => this.runClaimWatcher(), this.timing.claimWatcherMs);
    this.watcher.unref?.();
  }

  private requireHealthyConfig(): { enabled: boolean; relayUrl: string | null } {
    const config = this.config.read();
    if (config.corrupt) {
      const note = 'relay config file is corrupt; relay lifecycle is stopped';
      if (this.configNote === null) this.configNote = note;
      throw new Error(note);
    }
    this.configNote = null;
    return { enabled: config.enabled, relayUrl: config.relayUrl };
  }

  private resolveRelayUrlWithConfig(): string {
    const config = this.config.read();
    return resolveRelayUrl(config.corrupt ? { enabled: false, relayUrl: null, corrupt: false } : config);
  }

  private legWiring(): { localPort: number; platform?: string; appVersion?: string } {
    return { localPort: this.localPort, platform: this.platform, appVersion: this.appVersion };
  }
}

/** The production managed host: broker + one §3.9 leg mux per established
 * connection (dispatcher, batcher, loopback fetch/ws dial). */
function defaultHostFactory(wiring: { localPort: number; platform?: string; appVersion?: string }) {
  return async (identity: RelayIdentityStore, _relayUrl: string): Promise<ManagedHost> => {
    void _relayUrl;
    return productionBroker(identity, wiring);
  };
}

function productionBroker(identity: RelayIdentityStore, wiring: { localPort: number; platform?: string; appVersion?: string }): RelayHostBroker {
  const legs = new Map<string, RelayLegHost>();
  const broker = new RelayHostBroker({
    identity,
    onLegEstablished: (connectionId: string, capabilities: CapabilityOptions) => {
      legs.get(connectionId)?.dispose();
      legs.set(connectionId, createRelayLegHost({
        connectionId,
        localPort: wiring.localPort,
        send: (plaintext) => broker.sendToClient(connectionId, plaintext),
        onChannelFailure: (reason) => broker.terminateLeg(connectionId, RELAY_CLOSE.ChannelFailure, reason),
        capabilities,
      }));
    },
    onLegFrame: (connectionId: string, payload: Uint8Array) => {
      legs.get(connectionId)?.acceptPlaintext(payload);
    },
    onLegClosed: (connectionId: string) => {
      legs.get(connectionId)?.dispose();
      legs.delete(connectionId);
    },
  });
  return broker;
}

/** §3.12 reconcile demand math: any affirmative wins; a failed check with
 * no affirmative answer throws (never fake “no demand”). */
async function evaluateDemand(signals: DemandSignal[]): Promise<boolean> {
  const settled = await Promise.allSettled(signals.map((signal) => Promise.resolve().then(signal)));
  let affirmed = false;
  let failed = false;
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value === true) affirmed = true;
    if (result.status === 'rejected') failed = true;
  }
  if (!affirmed && failed) throw new Error('relay demand evaluation failed');
  return affirmed;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { RelayHostStatus };
