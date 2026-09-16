// SPDX-License-Identifier: Apache-2.0
/**
 * Config/connection store (doc 01 §14, HP-5). The sync engine (P2/doc 04) will
 * own session/message state; this store keeps the connection classification and
 * the provider/agent inventories the shell boot gate depends on.
 */
import { create } from 'zustand';
import { harnessClient } from '../lib/nnd/client.ts';

export type ConnectionPhase = 'connecting' | 'reconnecting' | 'connected';
export type DisconnectReason = string | null;

interface ConfigState {
  providers: unknown[];
  agents: unknown[];
  isConnected: boolean;
  haveEverConnected: boolean;
  connectionPhase: ConnectionPhase;
  lastDisconnectReason: DisconnectReason;
  isInitialized: boolean;

  checkConnection: () => Promise<boolean>;
  loadProviders: () => Promise<void>;
  loadAgents: () => Promise<void>;
  markInitialized: (value: boolean) => void;
  resetForRuntimeSwitch: () => void;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const useConfigStore = create<ConfigState>((set, get) => ({
  providers: [],
  agents: [],
  isConnected: false,
  haveEverConnected: false,
  connectionPhase: 'connecting',
  lastDisconnectReason: null,
  isInitialized: false,

  // HP-5: ≤5 attempts, linear backoff sleep(400·attempt)
  async checkConnection() {
    set({ connectionPhase: get().haveEverConnected ? 'reconnecting' : 'connecting' });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await harnessClient.probe();
      if (!result.error && result.data !== undefined) {
        set({
          isConnected: true,
          haveEverConnected: true,
          connectionPhase: 'connected',
          lastDisconnectReason: null,
        });
        return true;
      }
      set({ lastDisconnectReason: 'health_check_failed' });
      if (attempt < 5) await sleep(400 * attempt);
    }
    set({ isConnected: false, connectionPhase: 'connecting' });
    return false;
  },

  // loaders swallow errors by design (doc 01 §4.3 step 5 — the recovery poll
  // must re-run them, so failure cannot be detectable via rejection)
  async loadProviders() {
    const result = await harnessClient.listProviders();
    if (result.error) return;
    const payload = result.data as { all?: unknown[] } | unknown[] | undefined;
    const providers = Array.isArray(payload) ? payload : ((payload as { all?: unknown[] })?.all ?? []);
    set({ providers: Array.isArray(providers) ? providers : [] });
  },

  async loadAgents() {
    const result = await harnessClient.listAgents();
    if (result.error) return;
    set({ agents: Array.isArray(result.data) ? (result.data as unknown[]) : [] });
  },

  markInitialized(value) {
    set({ isInitialized: value });
  },

  // doc 01 §11.2 config-store reset (exact fields)
  resetForRuntimeSwitch() {
    set({
      providers: [],
      agents: [],
      isConnected: false,
      isInitialized: false,
      connectionPhase: 'connecting',
      lastDisconnectReason: null,
    });
  },
}));
