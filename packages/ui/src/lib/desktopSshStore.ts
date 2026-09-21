// SPDX-License-Identifier: Apache-2.0
/**
 * Desktop SSH store (doc 08 section 7.3). Config loads once; operation
 * statuses arrive as PUSHED events (never polling; refreshStatuses is the
 * one manual full pass). Every mutation rides the doc-09 bridge seam: the
 * store triggers it and mirrors the truth it is told - it invents no
 * connection lifecycle of its own. The in-shelf rows stay keyed by id and
 * the list view sorts by updatedAtMs descending (newest first).
 */
import { normalizeSshInstance, SSH_PHASES, type DesktopSshInstance, type DesktopSshInstanceStatus, type SshPhase } from './desktopSsh.ts';
import { desktopSshImportHosts, type SshImportCandidate } from './desktopSshImport.ts';

/** Doc 09 command vocabulary (typed now, implemented in P12). */
export interface DesktopSshBridge {
  invoke(command: string, payload?: unknown): Promise<unknown>;
  listenStatus(handler: (status: DesktopSshInstanceStatus) => void): () => void;
  readSshConfig(): Promise<string>;
}

export const SSH_BRIDGE_COMMANDS = {
  connect: 'desktopSshConnect',
  disconnect: 'desktopSshDisconnect',
  cancel: 'desktopSshCancelConnecting',
  retry: 'desktopSshRetry',
  upsert: 'desktopSshUpsertInstance',
  remove: 'desktopSshRemoveInstance',
  createFromCommand: 'desktopSshCreateFromCommand',
  refreshStatuses: 'desktopSshRefreshStatuses',
} as const;

export const SSH_BRIDGE_UNAVAILABLE = 'desktop ssh bridge is unavailable outside the desktop shell';

export interface DesktopSshState {
  loaded: boolean;
  instances: DesktopSshInstance[];
  statuses: Record<string, DesktopSshInstanceStatus>;
  importCandidates: SshImportCandidate[];
  lastError: string | null;
}

export interface DesktopSshStore {
  readonly loaded: boolean;
  readonly instances: DesktopSshInstance[];
  readonly statuses: Record<string, DesktopSshInstanceStatus>;
  readonly importCandidates: SshImportCandidate[];
  readonly lastError: string | null;
  getBridge(): DesktopSshBridge | null;
  setBridge(bridge: DesktopSshBridge | null): void;
  loadConfig(): Promise<void>;
  refreshImportCandidates(): Promise<void>;
  refreshStatuses(): Promise<void>;
  connect(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  cancelConnecting(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  upsert(instance: DesktopSshInstance): Promise<void>;
  createFromCommand(sshCommand: string, nickname?: string): Promise<string | null>;
  remove(id: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function sortStatuses(rows: readonly DesktopSshInstanceStatus[]): DesktopSshInstanceStatus[] {
  return rows.slice().sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

export function isSshPhase(value: unknown): value is SshPhase {
  return typeof value === 'string' && (SSH_PHASES as readonly string[]).includes(value);
}

interface Core {
  state: DesktopSshState;
  listeners: Set<() => void>;
  bridge: DesktopSshBridge | null;
  detachListen: (() => void) | null;
  emit(): void;
  read(): DesktopSshState;
}

export function normalizeStatus(input: unknown): DesktopSshInstanceStatus | null {
  if (input === null || typeof input !== 'object') return null;
  const shape = input as Record<string, unknown>;
  if (typeof shape.id !== 'string' || shape.id === '') return null;
  if (!isSshPhase(shape.phase)) return null;
  const stamp = typeof shape.updatedAtMs === 'number' && Number.isFinite(shape.updatedAtMs) ? shape.updatedAtMs : Date.now();
  const retry = typeof shape.retryAttempt === 'number' && Number.isFinite(shape.retryAttempt)
    ? Math.max(0, Math.floor(shape.retryAttempt))
    : 0;
  const localPort = statusPort(shape.localPort);
  const remotePort = statusPort(shape.remotePort);
  return {
    id: shape.id,
    phase: shape.phase,
    ...(typeof shape.detail === 'string' && shape.detail !== '' ? { detail: shape.detail } : {}),
    ...(typeof shape.localUrl === 'string' && shape.localUrl !== '' ? { localUrl: shape.localUrl } : {}),
    ...(localPort !== null ? { localPort } : {}),
    ...(remotePort !== null ? { remotePort } : {}),
    startedByUs: shape.startedByUs === true,
    retryAttempt: retry,
    requiresUserAction: shape.requiresUserAction === true,
    updatedAtMs: stamp,
  };
}

const STATUS_PORT_MIN = 1;
const STATUS_PORT_MAX = 65_535;

/** Same 1..65535 rule the instance normalizer enforces (E-08-58). */
function statusPort(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const port = Math.floor(value);
  return port >= STATUS_PORT_MIN && port <= STATUS_PORT_MAX ? port : null;
}

function createCore(bridge: DesktopSshBridge | null): Core {
  const core: Core = {
    state: { loaded: false, instances: [], statuses: {}, importCandidates: [], lastError: null },
    listeners: new Set(),
    bridge,
    detachListen: null,
    emit(): void { for (const listener of core.listeners) listener(); },
    read(): DesktopSshState { return { ...core.state }; },
  };
  return core;
}

function setBridge(core: Core, next: DesktopSshBridge | null): void {
  core.bridge = next;
  core.state = {
    ...core.state,
    loaded: false,
    instances: [],
    statuses: {},
    importCandidates: [],
  };
  if (core.detachListen !== null) { core.detachListen(); core.detachListen = null; }
  core.emit();
}

function applyStatus(core: Core, status: DesktopSshInstanceStatus): void {
  const current = core.state.statuses[status.id];
  // Section 7.3: pushed events never move a status backward in time; a late
  // reordering of the publisher's queue is idempotent-ordered, not a
  // regression of the phase the shell already showed.
  if (current !== undefined && current.updatedAtMs > status.updatedAtMs) return;
  core.state = {
    ...core.state,
    statuses: { ...core.state.statuses, [status.id]: status },
  };
  core.emit();
}

function noteFailure(core: Core, error: unknown): void {
  core.state = { ...core.state, lastError: error instanceof Error ? error.message : String(error) };
  core.emit();
}

async function invokeBridge(core: Core, command: string, payload?: unknown): Promise<unknown> {
  if (core.bridge === null) throw new Error(SSH_BRIDGE_UNAVAILABLE);
  return await core.bridge.invoke(command, payload);
}

async function loadConfig(core: Core): Promise<void> {
  if (core.bridge === null) {
    core.state = { ...core.state, loaded: true, instances: [], statuses: {}, lastError: SSH_BRIDGE_UNAVAILABLE };
    core.emit();
    return;
  }
  try {
    const reply = (await core.bridge.invoke('desktopSshConfig')) as unknown;
    const rows = (reply as { instances?: unknown[] } | null)?.instances ?? [];
    core.state = {
      ...core.state,
      loaded: true,
      instances: (Array.isArray(rows) ? rows : []).map((row) => normalizeSshInstance(row)).filter((row): row is DesktopSshInstance => row !== null),
      lastError: null,
    };
    startListening(core);
    core.emit();
  } catch (error) {
    noteFailure(core, error);
    // A healthy bridge must not lose its pushed status stream to a
    // transient config-read failure (S7.3: pushed events are the channel).
    startListening(core);
  }
}

function startListening(core: Core): void {
  if (core.bridge === null) return;
  if (core.detachListen !== null) core.detachListen();
  core.detachListen = core.bridge.listenStatus((status) => {
    const normalized = normalizeStatus(status);
    if (normalized !== null) applyStatus(core, normalized);
  });
}

function makeActions(core: Core): Omit<DesktopSshStore, keyof DesktopSshState | 'subscribe' | 'getBridge' | 'setBridge' | 'loadConfig' | 'refreshImportCandidates'> {
  return {
    refreshStatuses: async (): Promise<void> => {
      if (core.bridge === null) { noteBridgeUnavailable(core); return; }
      try {
        const rows = (await core.bridge.invoke(SSH_BRIDGE_COMMANDS.refreshStatuses)) as unknown[] | null;
        let applied = 0;
        for (const row of Array.isArray(rows) ? rows : []) {
          const normalized = normalizeStatus(row);
          if (normalized !== null) { applyStatus(core, normalized); applied += 1; }
        }
        if (applied > 0 && core.state.lastError !== null) {
          core.state = { ...core.state, lastError: null };
          core.emit();
        }
      } catch (error) { noteFailure(core, error); }
    },
    connect: async (id: string): Promise<void> => {
      try { await invokeBridge(core, SSH_BRIDGE_COMMANDS.connect, { id }); } catch (error) { noteFailure(core, error); }
    },
    disconnect: async (id: string): Promise<void> => {
      try { await invokeBridge(core, SSH_BRIDGE_COMMANDS.disconnect, { id }); } catch (error) { noteFailure(core, error); }
    },
    cancelConnecting: async (id: string): Promise<void> => {
      try { await invokeBridge(core, SSH_BRIDGE_COMMANDS.cancel, { id }); } catch (error) { noteFailure(core, error); }
    },
    retry: async (id: string): Promise<void> => {
      try { await invokeBridge(core, SSH_BRIDGE_COMMANDS.retry, { id }); } catch (error) { noteFailure(core, error); }
    },
    upsert: (instance: DesktopSshInstance): Promise<void> => upsertInstance(core, instance),
    createFromCommand: (sshCommand: string, nickname?: string): Promise<string | null> => createFromCommand(core, sshCommand, nickname),
    remove: (id: string): Promise<void> => removeInstance(core, id),
  };
}

async function upsertInstance(core: Core, instance: DesktopSshInstance): Promise<void> {
  try {
    const normalized = normalizeSshInstance(instance);
    if (normalized === null) throw new Error('ssh instance did not normalize');
    await invokeBridge(core, SSH_BRIDGE_COMMANDS.upsert, { instance: normalized });
    const existing = core.state.instances.some((row) => row.id === normalized.id);
    core.state = {
      ...core.state,
      // An edit keeps its row position; only genuinely new instances append.
      instances: existing
        ? core.state.instances.map((row) => (row.id === normalized.id ? normalized : row))
        : [...core.state.instances, normalized],
      lastError: null,
    };
    core.emit();
  } catch (error) { noteFailure(core, error); }
}

async function createFromCommand(core: Core, sshCommand: string, nickname?: string): Promise<string | null> {
  try {
    const reply = (await invokeBridge(core, SSH_BRIDGE_COMMANDS.createFromCommand, { sshCommand, nickname })) as { id?: string } | null;
    if (typeof reply?.id !== 'string') {
      // A refusal without a throw must stay traceable, not just return null.
      noteFailure(core, `${SSH_BRIDGE_COMMANDS.createFromCommand} returned no instance id`);
      return null;
    }
    await loadConfig(core);
    return reply.id;
  } catch (error) {
    noteFailure(core, error);
    return null;
  }
}

async function removeInstance(core: Core, id: string): Promise<void> {
  try {
    await invokeBridge(core, SSH_BRIDGE_COMMANDS.remove, { id });
    core.state = {
      ...core.state,
      instances: core.state.instances.filter((row) => row.id !== id),
      statuses: Object.fromEntries(Object.entries(core.state.statuses).filter(([key]) => key !== id)),
    };
    core.emit();
  } catch (error) { noteFailure(core, error); }
}

async function refreshImportCandidates(core: Core): Promise<void> {
  if (core.bridge === null) { noteBridgeUnavailable(core); return; }
  try {
    core.state = {
      ...core.state,
      importCandidates: await desktopSshImportHosts(core.bridge),
      lastError: null,
    };
    core.emit();
  } catch (error) { noteFailure(core, error); }
}

function noteBridgeUnavailable(core: Core): void {
  core.state = { ...core.state, lastError: SSH_BRIDGE_UNAVAILABLE };
  core.emit();
}

/** Factory (S7.3): one store per desktop shell; the web surface passes no
 *  bridge, and existence of the bridge is what the UI gates faces on. */
export function createDesktopSshStore(bridge: DesktopSshBridge | null = null): DesktopSshStore {
  const core = createCore(bridge);
  const actions = makeActions(core);
  return {
    get loaded() { return core.state.loaded; },
    get instances() { return [...core.state.instances]; },
    get statuses() { return { ...core.state.statuses }; },
    get importCandidates() { return [...core.state.importCandidates]; },
    get lastError() { return core.state.lastError; },
    getBridge: () => core.bridge,
    setBridge: (next) => setBridge(core, next),
    loadConfig: () => loadConfig(core),
    refreshImportCandidates: () => refreshImportCandidates(core),
    ...actions,
    subscribe(listener: () => void): () => void {
      core.listeners.add(listener);
      return () => core.listeners.delete(listener);
    },
  };
}
