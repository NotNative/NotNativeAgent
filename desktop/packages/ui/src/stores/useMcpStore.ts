// SPDX-License-Identifier: Apache-2.0
/**
 * MCP runtime-status store (doc 15 F.3; P10-45). Per-directory status from
 * the harness (GET /mcp), per-server diagnostics for failed connect/auth
 * attempts, silent refreshes after actions, test-connection hygiene (a test
 * must not leave a connection behind), and a generation token that drops
 * in-flight writes on runtime switch. Mock behavior follows the harness
 * wire shapes only.
 */
import { create } from 'zustand';
import { harnessClient, normalizeDirectory, type HarnessResult } from '../lib/nnd/client.ts';
import type { McpStatus, McpStatusMap } from '../lib/nnd/types.ts';

const GLOBAL_KEY = '__global__';

/** Directory map key: normalized path, or the global bucket when absent. */
export function directoryKey(directory?: string): string {
  return directory ? normalizeDirectory(directory) : GLOBAL_KEY;
}

export interface McpDiagnostic { status: 'failed'; error: string }

export interface McpHealth {
  connected: number; total: number; hasFailed: boolean; hasAuthRequired: boolean;
}

/** Connected counts; auth-required covers needs_auth + registration. */
export function computeMcpHealth(statusMap: McpStatusMap | undefined): McpHealth {
  const health: McpHealth = { connected: 0, total: 0, hasFailed: false, hasAuthRequired: false };
  for (const status of Object.values(statusMap ?? {})) {
    health.total += 1;
    if (status.status === 'connected') health.connected += 1;
    if (status.status === 'failed') health.hasFailed = true;
    if (status.status === 'needs_auth' || status.status === 'needs_client_registration') {
      health.hasAuthRequired = true;
    }
  }
  return health;
}

const STATUSES = new Set([
  'connected', 'disabled', 'failed', 'needs_auth', 'needs_client_registration',
]);

function isStatus(value: unknown): value is McpStatus {
  const record = value as { status?: unknown } | null;
  if (!record || typeof record !== 'object' || Array.isArray(value)) return false;
  return typeof record.status === 'string' && STATUSES.has(record.status);
}

function parseStatusMap(data: unknown): McpStatusMap | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data !== 'object' || Array.isArray(data)) return undefined;
  const map: McpStatusMap = {};
  for (const [name, value] of Object.entries(data as Record<string, unknown>)) {
    if (!isStatus(value)) return undefined;
    map[name] = value;
  }
  return map;
}

export interface McpStoreState {
  byDirectory: Record<string, McpStatusMap>;
  diagnosticsByDirectory: Record<string, Record<string, McpDiagnostic>>;
  loadingKeys: Record<string, boolean>;
  lastErrorKeys: Record<string, string>;
  refreshedAtKeys: Record<string, number>;
  refresh(input?: { directory?: string; silent?: boolean }): Promise<void>;
  ensureFresh(input: { maxAgeMs: number; directory?: string }): Promise<void>;
  connect(name: string, directory?: string): Promise<string | undefined>;
  disconnect(name: string, directory?: string): Promise<string | undefined>;
  testConnection(name: string, directory?: string): Promise<{
    status: string; error?: string; warning?: string;
  }>;
  startAuth(name: string, directory?: string): Promise<{ authorizationUrl?: string; error?: string }>;
  completeAuth(name: string, code: string, directory?: string): Promise<string | undefined>;
  authenticate(name: string, directory?: string): Promise<string | undefined>;
  clearAuth(name: string, directory?: string): Promise<string | undefined>;
  setDiagnostic(directory: string | undefined, name: string, error: string): void;
  clearDiagnostic(directory: string | undefined, name: string): void;
  resetForRuntimeSwitch(): void;
}

const inFlight = new Map<string, Promise<void>>();
let generation = 0;

export const useMcpStore = create<McpStoreState>()((set, get) => ({
  byDirectory: {},
  diagnosticsByDirectory: {},
  loadingKeys: {},
  lastErrorKeys: {},
  refreshedAtKeys: {},

  async refresh({ directory, silent } = {}) {
    const key = directoryKey(directory);
    const token = generation;
    if (!silent) set((s) => ({ loadingKeys: { ...s.loadingKeys, [key]: true } }));
    const run = harnessClient.getMcp({ directory })
      .then((result: HarnessResult<unknown>) => {
        if (token !== generation) return;
        const parsed = parseStatusMap(result.data);
        if (result.error || parsed === undefined) {
          set((s) => ({ lastErrorKeys: { ...s.lastErrorKeys, [key]: result.error ?? 'MCP status failed' } }));
          return;
        }
        set((s) => {
          const lastErrorKeys = { ...s.lastErrorKeys };
          delete lastErrorKeys[key];
          const diagnostics = { ...(s.diagnosticsByDirectory[key] ?? {}) };
          for (const name of Object.keys(parsed)) delete diagnostics[name];
          return {
            byDirectory: { ...s.byDirectory, [key]: parsed },
            diagnosticsByDirectory: { ...s.diagnosticsByDirectory, [key]: diagnostics },
            lastErrorKeys,
            refreshedAtKeys: { ...s.refreshedAtKeys, [key]: Date.now() },
          };
        });
      })
      .catch((error: unknown) => {
        if (token !== generation) return;
        set((s) => ({ lastErrorKeys: {
          ...s.lastErrorKeys,
          [key]: error instanceof Error ? error.message : 'MCP status request failed',
        } }));
      })
      .finally(() => {
        if (token !== generation) return;
        if (!silent) set((s) => {
          const loadingKeys = { ...s.loadingKeys };
          delete loadingKeys[key];
          return { loadingKeys };
        });
        inFlight.delete(key);
      });
    inFlight.set(key, run);
    await run;
  },

  async ensureFresh({ maxAgeMs, directory }) {
    const key = directoryKey(directory);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const at = get().refreshedAtKeys[key] ?? 0;
    if (Date.now() - at <= maxAgeMs) return;
    await get().refresh({ directory, silent: true });
  },

  async connect(name, directory) {
    const key = directoryKey(directory);
    const result = await harnessClient.connectMcp(name, { directory });
    if (result.error) {
      set((s) => ({ diagnosticsByDirectory: {
        ...s.diagnosticsByDirectory,
        [key]: { ...(s.diagnosticsByDirectory[key] ?? {}), [name]: { status: 'failed', error: result.error ?? 'connect failed' } },
      } }));
      await get().refresh({ directory, silent: true });
      return result.error;
    }
    await get().refresh({ directory, silent: true });
    return undefined;
  },

  async disconnect(name, directory) {
    const result = await harnessClient.disconnectMcp(name, { directory });
    await get().refresh({ directory, silent: true });
    return result.error;
  },

  async testConnection(name, directory) {
    const key = directoryKey(directory);
    await get().refresh({ directory, silent: true });
    if (get().lastErrorKeys[key] !== undefined) {
      return { status: 'unknown', error: get().lastErrorKeys[key] };
    }
    const before = get().byDirectory[key] ?? {};
    const wasConnected = before[name]?.status === 'connected';
    const connectResult = await harnessClient.connectMcp(name, { directory });
    await get().refresh({ directory, silent: true });
    const after = get().byDirectory[key] ?? {};
    const readbackError = get().lastErrorKeys[key];
    if (connectResult.error) {
      return { status: 'failed', error: connectResult.error };
    }
    const status = after[name]?.status ?? 'unknown';
    let cleanedUp = wasConnected;
    const shouldCleanUp = !wasConnected && (status === 'connected'
      || (readbackError !== undefined && status === 'unknown'));
    if (shouldCleanUp) {
      const cleanup = await harnessClient.disconnectMcp(name, { directory });
      await get().refresh({ directory, silent: true });
      cleanedUp = !cleanup.error;
      if (cleanup.error) {
        return { status, warning: cleanup.error, ...(readbackError ? { error: readbackError } : {}) };
      }
    }
    if (readbackError !== undefined) {
      return {
        status,
        error: readbackError,
      ...(cleanedUp ? {} : { warning: 'MCP connection could not be cleaned up' }),
      };
    }
    return { status };
  },

  async startAuth(name, directory) {
    const result = await harnessClient.startMcpAuth(name, { directory });
    const body = result.data as { authorizationUrl?: string } | undefined;
    if (result.error) return { error: result.error ?? 'connect failed' };
    return { authorizationUrl: body?.authorizationUrl };
  },

  async completeAuth(name, code, directory) {
    const result = await harnessClient.mcpAuthCallback(name, code, { directory });
    await get().refresh({ directory, silent: true });
    return result.error;
  },

  async authenticate(name, directory) {
    const result = await harnessClient.authenticateMcp(name, { directory });
    await get().refresh({ directory, silent: true });
    return result.error;
  },

  async clearAuth(name, directory) {
    const result = await harnessClient.removeMcpAuth(name, { directory });
    if (result.error) return result.error;
    const disconnect = await harnessClient.disconnectMcp(name, { directory });
    await get().refresh({ directory, silent: true });
    return disconnect.error;
  },

  setDiagnostic(directory, name, error) {
    const key = directoryKey(directory);
    set((s) => ({ diagnosticsByDirectory: {
      ...s.diagnosticsByDirectory,
      [key]: { ...(s.diagnosticsByDirectory[key] ?? {}), [name]: { status: 'failed', error } },
    } }));
  },

  clearDiagnostic(directory, name) {
    const key = directoryKey(directory);
    set((s) => {
      const diagnostics = { ...(s.diagnosticsByDirectory[key] ?? {}) };
      delete diagnostics[name];
      return { diagnosticsByDirectory: { ...s.diagnosticsByDirectory, [key]: diagnostics } };
    });
  },

  resetForRuntimeSwitch() {
    generation += 1;
    inFlight.clear();
    set({
      byDirectory: {}, diagnosticsByDirectory: {}, loadingKeys: {},
      lastErrorKeys: {}, refreshedAtKeys: {},
    });
  },
}));
