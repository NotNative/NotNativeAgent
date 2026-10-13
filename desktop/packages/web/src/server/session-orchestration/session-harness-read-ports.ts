// SPDX-License-Identifier: Apache-2.0
/** HP-1 provider/catalog/session-read seams for session orchestration. */
import type { AgentInfo, CommandInfo, Provider } from '../../../../ui/src/lib/nnd/types.ts';
import { callHarness, callHarnessJson, harnessRequest } from '../queue/queue-adapter-calls.ts';
import { CREATE_TIMEOUT_MS, READ_TIMEOUT_MS } from './session-harness-port-timeouts.ts';
import { idOf } from './session-harness-port-seams.ts';

function createCatalogReadPorts(): {
  providers: (directory: string) => Promise<readonly Provider[]>;
  agents: (directory: string) => Promise<readonly AgentInfo[]>;
  config: (directory: string) => Promise<Record<string, unknown>>;
  commands: (directory: string) => Promise<readonly CommandInfo[]>;
} {
  return {
    providers: (directory) => callHarnessJson(harnessRequest('/config/providers', directory, {
      method: 'GET', signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    })).then((value) => {
      const records = Array.isArray(value)
        ? value
        : value !== null && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).providers)
          ? (value as Record<string, unknown>).providers as unknown[]
          : [];
      return records as Provider[];
    }),
    agents: (directory) => callHarnessJson(harnessRequest('/agent', directory, {
      method: 'GET', signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    })).then((value) => Array.isArray(value) ? value as AgentInfo[] : []),
    config: (directory) => callHarnessJson(harnessRequest('/config', directory, {
      method: 'GET', signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    })).then((value) => (value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : {})),
    commands: (directory) => callHarnessJson(harnessRequest('/command', directory, {
      method: 'GET', signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    })).then((value) => Array.isArray(value) ? value as CommandInfo[] : []),
  };
}

function createSessionRecordReadPorts(): {
  createSession: (directory: string, title: string) => Promise<Record<string, unknown>>;
  readSession: (sessionId: string, directory: string) => Promise<Record<string, unknown>>;
  readMessages: (sessionId: string, directory: string, limit: number) => Promise<unknown[]>;
} {
  return {
    createSession: async (directory: string, title: string,
      route?: { providerID: string; model: string }) => {
      const response = await callHarness(harnessRequest('/session', directory, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ directory, title, ...(route ?? {}) }),
        signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
      }));
      if (!response.ok) throw new Error(`session create rejected with ${response.status}`);
      const record = await response.json().catch(() => null);
      return record !== null && typeof record === 'object' && !Array.isArray(record)
        ? record as Record<string, unknown> : {};
    },
    readSession: async (sessionId, directory) => {
      const response = await callHarness(harnessRequest(`/session/${idOf(sessionId)}`, directory, {
        method: 'GET', signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      }));
      if (!response.ok) throw new Error(`session read rejected with ${response.status}`);
      const record = await response.json().catch(() => null);
      if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid session record');
      return record as Record<string, unknown>;
    },
    readMessages: async (sessionId, directory, limit) => {
      const response = await callHarness(harnessRequest(`/session/${idOf(sessionId)}/message?limit=${Math.max(1, limit)}`, directory, {
        method: 'GET', signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      }));
      if (!response.ok) throw new Error(`message read rejected with ${response.status}`);
      const record = await response.json().catch(() => null);
      return Array.isArray(record) ? record : [];
    },
  };
}

export function createSessionReadPorts(): {
  providers: (directory: string) => Promise<readonly Provider[]>;
  agents: (directory: string) => Promise<readonly AgentInfo[]>;
  config: (directory: string) => Promise<Record<string, unknown>>;
  commands: (directory: string) => Promise<readonly CommandInfo[]>;
  createSession: (directory: string, title: string) => Promise<Record<string, unknown>>;
  readSession: (sessionId: string, directory: string) => Promise<Record<string, unknown>>;
  readMessages: (sessionId: string, directory: string, limit: number) => Promise<unknown[]>;
} {
  return { ...createCatalogReadPorts(), ...createSessionRecordReadPorts() };
}
