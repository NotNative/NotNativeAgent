// SPDX-License-Identifier: Apache-2.0
/**
 * MCP config store (doc 15 F.3; P10-45). Per-directory config lists with a
 * short TTL cache and in-flight dedupe, plus the edit-draft model that
 * builds the /api/config/mcp payloads. Only selectedMcpName persists; configs
 * always refetch (mutations answer deferred-restart, never a live record).
 */
import { create } from 'zustand';
import { directoryKey } from './useMcpStore.ts';
import {
  listMcpConfigs,
  createMcpConfig,
  patchMcpConfig,
  deleteMcpConfig,
  type McpConfigRecord,
  type McpEnvelope,
} from '../lib/mcp-config-api.ts';

export type McpDraftRow = { key: string; value: string };
export type McpTarget = 'opencode';

export interface McpDraft {
  name: string;
  scope: 'user' | 'project';
  target: McpTarget;
  type: 'local' | 'remote';
  command: string;
  environment: McpDraftRow[];
  headers: McpDraftRow[];
  url: string;
  oauthEnabled: boolean;
  oauth: Record<string, string>;
  timeout: string;
  enabled: boolean;
  isNew: boolean;
}

export const MCP_NAME_RULE = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/u;

const CONFIG_TTL_MS = 5_000;
const SELECTED_KEY = 'notnative.mcp.selectedName';

/** Split a command line on whitespace, honoring simple quotes. */
export function parseCommandLine(line: string): string[] {
  const out: string[] = [];
  let token = '';
  let quoted = false;
  let quote = '';
  for (const char of line) {
    if (quoted) {
      if (char === quote) {
        quoted = false;
        continue;
      }
      token += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quoted = true;
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (token !== '') {
        out.push(token);
        token = '';
      }
      continue;
    }
    token += char;
  }
  if (token !== '') out.push(token);
  return out;
}

export function rowsToMap(rows: McpDraftRow[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) {
    if (row.key.trim() !== '' && row.value !== '') map[row.key.trim()] = row.value;
  }
  return map;
}

export interface McpDraftBody {
  name: string;
  scope: 'user' | 'project';
  entry: Record<string, unknown>;
  error?: string;
}

export function buildMcpBody(draft: McpDraft): McpDraftBody {
  const base = { name: draft.name, scope: draft.scope };
  const environment = rowsToMap(draft.environment);
  const entry: Record<string, unknown> = {
    type: draft.type, environment, enabled: draft.enabled,
  };
  if (draft.type === 'local') {
    const command = parseCommandLine(draft.command);
    if (command.length === 0) return { ...base, entry, error: 'command required' };
    entry.command = command;
    return { ...base, entry };
  }
  if (draft.url.trim() === '') return { ...base, entry, error: 'url required' };
  entry.url = draft.url.trim();
  const headers = rowsToMap(draft.headers);
  entry.headers = headers;
  if (draft.oauthEnabled) {
    const oauth: Record<string, string> = {};
    for (const field of ['clientId', 'clientSecret', 'scope', 'redirectUri']) {
      const value = (draft.oauth[field] ?? '').trim();
      if (value !== '') oauth[field] = value;
    }
    entry.oauth = oauth;
  } else {
    entry.oauth = false;
  }
  if (draft.timeout.trim() !== '') {
    const timeout = Number(draft.timeout.trim());
    if (!Number.isFinite(timeout) || timeout <= 0) return { ...base, entry, error: 'timeout must be positive' };
    entry.timeout = timeout;
  }
  return { ...base, entry };
}

export function newDraft(scope: 'user' | 'project' = 'user'): McpDraft {
  return {
    name: 'mcp-server', scope, target: 'opencode', type: 'local', command: '',
    environment: [], headers: [], url: '', oauthEnabled: false,
    oauth: {}, timeout: '', enabled: true, isNew: true,
  };
}

const toRows = (map: Record<string, string> | undefined): McpDraftRow[] =>
  Object.entries(map ?? {}).map(([key, value]) => ({ key, value }));

export function draftFromRecord(record: McpConfigRecord): McpDraft {
  const oauth = record.oauth && typeof record.oauth === 'object' ? record.oauth : {};
  return {
    name: record.name, scope: record.scope, target: 'opencode', type: record.type,
    command: (record.command ?? []).join(' '), environment: toRows(record.environment),
    headers: toRows(record.headers), url: record.url ?? '',
    oauthEnabled: record.oauth !== false && record.oauth !== undefined,
    oauth: { clientId: oauth.clientId ?? '', clientSecret: oauth.clientSecret ?? '',
      scope: oauth.scope ?? '', redirectUri: oauth.redirectUri ?? '' },
    timeout: record.timeout === undefined ? '' : String(record.timeout),
    enabled: record.enabled, isNew: false,
  };
}

function readSelected(): string {
  try {
    return globalThis.localStorage ? globalThis.localStorage.getItem(SELECTED_KEY) ?? '' : '';
  } catch {
    return '';
  }
}

function writeSelected(name: string): void {
  try {
    globalThis.localStorage.setItem(SELECTED_KEY, name);
  } catch { /* storage-off stays non-fatal */ }
}

export type McpMutation = { ok: true } | { ok: false; error: string };

export interface McpConfigStoreState {
  configsByDirectory: Record<string, Record<string, McpConfigRecord>>;
  expiresAtKeys: Record<string, number>;
  loadingKeys: Record<string, boolean>;
  lastErrorKeys: Record<string, string>;
  draft: McpDraft | null;
  selectedMcpName: string;
  load(input?: { directory?: string; force?: boolean }): Promise<void>;
  openDraft(draft?: McpDraft): void;
  patchDraft(patch: Partial<McpDraft>): void;
  closeDraft(): void;
  select(name: string): void;
  createEntry(name: string, draft: McpDraft, directory?: string): Promise<McpMutation>;
  patchEntry(name: string, draft: McpDraft, directory?: string): Promise<McpMutation>;
  deleteEntry(name: string, directory?: string): Promise<McpMutation>;
  resetForRuntimeSwitch(): void;
}

const inFlightLoad = new Map<string, Promise<void>>();
let configGeneration = 0;

export const useMcpConfigStore = create<McpConfigStoreState>()((set, get) => ({
  configsByDirectory: {},
  expiresAtKeys: {},
  loadingKeys: {},
  lastErrorKeys: {},
  draft: null,
  selectedMcpName: readSelected(),

  async load({ directory, force } = {}) {
    const key = directoryKey(directory);
    if (!force && (get().expiresAtKeys[key] ?? 0) > Date.now()) return;
    const pending = inFlightLoad.get(key);
    if (pending && !force) return pending;
    const token = configGeneration;
    set((state) => ({ loadingKeys: { ...state.loadingKeys, [key]: true } }));
    const run = listMcpConfigs(directory)
      .then((result: McpEnvelope<{ mcp: Record<string, McpConfigRecord> }>) => {
        if (token !== configGeneration) return;
        if (!result.ok) {
          set((state) => ({ lastErrorKeys: { ...state.lastErrorKeys, [key]: result.error } }));
          return;
        }
        const raw = typeof result.mcp === 'object' && result.mcp !== null && !Array.isArray(result.mcp)
          ? result.mcp as Record<string, McpConfigRecord>
          : {};
        const configs: Record<string, McpConfigRecord> = {};
        for (const [name, record] of Object.entries(raw)) {
          if (!record || record.name !== name) continue;
          configs[name] = record;
        }
        set((state) => {
          const lastErrorKeys = { ...state.lastErrorKeys };
          delete lastErrorKeys[key];
          return {
          configsByDirectory: { ...state.configsByDirectory, [key]: configs },
          expiresAtKeys: { ...state.expiresAtKeys, [key]: Date.now() + CONFIG_TTL_MS },
          lastErrorKeys,
          };
        });
      })
      .catch((error: unknown) => {
        if (token !== configGeneration) return;
        set((state) => ({ lastErrorKeys: {
          ...state.lastErrorKeys,
          [key]: error instanceof Error ? String(error) : 'load failed',
        } }));
      })
      .finally(() => {
        inFlightLoad.delete(key);
        if (token !== configGeneration) return;
        set((state) => {
          const loadingKeys = { ...state.loadingKeys };
          delete loadingKeys[key];
          return { loadingKeys };
        });
      });
    inFlightLoad.set(key, run);
    await run;
  },

  openDraft(draft) {
    set({ draft: draft ?? newDraft() });
  },

  patchDraft(patch) {
    const current = get().draft ?? newDraft();
    set({ draft: { ...current, ...patch } });
  },

  closeDraft() {
    set({ draft: null });
  },

  select(name) {
    set({ selectedMcpName: name });
    writeSelected(name);
  },

  async createEntry(name, draft, directory) {
    if (!MCP_NAME_RULE.test(name)) return { ok: false, error: 'invalid server name' };
    const body = buildMcpBody({ ...draft, name });
    if (body.error) return { ok: false, error: body.error };
    const result = await createMcpConfig(
      name, { ...body.entry, scope: body.scope, ...(directory ? { directory } : {}) }, directory,
    );
    if (!result.ok) return { ok: false, error: result.error };
    await get().load({ directory, force: true });
    return { ok: true };
  },

  async patchEntry(name, draft, directory) {
    const body = buildMcpBody({ ...draft, name });
    if (body.error) return { ok: false, error: body.error };
    const result = await patchMcpConfig(name, body.entry, directory);
    if (!result.ok) return { ok: false, error: result.error };
    await get().load({ directory, force: true });
    return { ok: true };
  },

  async deleteEntry(name, directory) {
    const result = await deleteMcpConfig(name, directory);
    if (!result.ok) return { ok: false, error: result.error };
    await get().load({ directory, force: true });
    return { ok: true };
  },

  resetForRuntimeSwitch() {
    configGeneration += 1;
    inFlightLoad.clear();
    set({
      configsByDirectory: {}, expiresAtKeys: {}, loadingKeys: {},
      lastErrorKeys: {}, draft: null,
    });
  },
}));
