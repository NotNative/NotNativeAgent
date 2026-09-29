// SPDX-License-Identifier: Apache-2.0
/** P10-45 MCP stores (doc 15 F.3): runtime status + config lists/drafts.
 * Mocked at the harness-client and config-transport seams; the assertions
 * cover store semantics: TTL cache, generation drops, test-connection
 * cleanup, deferred-restart refetch, and the draft body builder. */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/nnd/client.ts', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  harnessClient: {
    getMcp: vi.fn(), connectMcp: vi.fn(), disconnectMcp: vi.fn(),
    startMcpAuth: vi.fn(), mcpAuthCallback: vi.fn(), authenticateMcp: vi.fn(),
    removeMcpAuth: vi.fn(),
  },
}));
vi.mock('../../lib/mcp-config-api.ts', () => ({
  listMcpConfigs: vi.fn(), createMcpConfig: vi.fn(),
  patchMcpConfig: vi.fn(), deleteMcpConfig: vi.fn(),
}));

import { harnessClient } from '../../lib/nnd/client.ts';
import {
  createMcpConfig, deleteMcpConfig, listMcpConfigs, patchMcpConfig,
} from '../../lib/mcp-config-api.ts';
import { computeMcpHealth, directoryKey, useMcpStore } from '../useMcpStore.ts';
import {
  type McpDraft,
  buildMcpBody, draftFromRecord, newDraft, parseCommandLine, rowsToMap,
  useMcpConfigStore,
} from '../useMcpConfigStore.ts';
import type { McpConfigRecord } from '../../lib/mcp-config-api.ts';

const getMcpMock = vi.mocked(harnessClient.getMcp);
const connectMock = vi.mocked(harnessClient.connectMcp);
const disconnectMock = vi.mocked(harnessClient.disconnectMcp);
const startAuthMock = vi.mocked(harnessClient.startMcpAuth);
const callbackMock = vi.mocked(harnessClient.mcpAuthCallback);
const removeAuthMock = vi.mocked(harnessClient.removeMcpAuth);
const listMock = vi.mocked(listMcpConfigs);
const createMock = vi.mocked(createMcpConfig);
const patchMock = vi.mocked(patchMcpConfig);
const deleteMock = vi.mocked(deleteMcpConfig);

const WS = directoryKey('C:/ws');

// The stores use localStorage opportunistically; the node test env has none.
beforeAll(() => {
  if (!globalThis.localStorage) {
    const entries = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => { entries.set(key, value); },
      removeItem: (key) => { entries.delete(key); },
    } as Storage;
  }
});

function record(name: string, extra: Record<string, unknown> = {}): McpConfigRecord {
  return { name, scope: 'user', type: 'local', enabled: true, ...extra } as McpConfigRecord;
}

beforeEach(() => {
  vi.resetAllMocks();
  getMcpMock.mockResolvedValue({ data: {} });
  listMock.mockResolvedValue({ ok: true, mcp: {} });
  useMcpStore.getState().resetForRuntimeSwitch();
  useMcpConfigStore.getState().resetForRuntimeSwitch();
});

describe('MCP runtime store', () => {
  it('publishes status and clears the error key', async () => {
    getMcpMock.mockResolvedValue({ data: { alpha: { status: 'connected' } } });
    await useMcpStore.getState().refresh({ directory: 'C:/ws' });
    expect(useMcpStore.getState().byDirectory[WS]).toEqual({ alpha: { status: 'connected' } });
    expect(useMcpStore.getState().lastErrorKeys[WS]).toBeUndefined();
    expect(useMcpStore.getState().loadingKeys[WS]).toBeUndefined();
  });

  it('keeps the prior map when the payload is malformed', async () => {
    getMcpMock.mockResolvedValue({ data: { alpha: { status: 'connected' } } });
    await useMcpStore.getState().refresh({ directory: 'C:/ws' });
    getMcpMock.mockResolvedValue({ data: { alpha: 'nope' } });
    await useMcpStore.getState().refresh({ directory: 'C:/ws' });
    expect(useMcpStore.getState().byDirectory[WS]).toEqual({ alpha: { status: 'connected' } });
    expect(typeof useMcpStore.getState().lastErrorKeys[WS]).toBe('string');
  });

  it('drops in-flight writes after a runtime switch', async () => {
    let settle: (value: unknown) => void = () => undefined;
    getMcpMock.mockReturnValue(new Promise((resolve) => {
      settle = resolve as (value: unknown) => void;
    }));
    const pending = useMcpStore.getState().refresh({ directory: 'C:/ws' });
    useMcpStore.getState().resetForRuntimeSwitch();
    settle({ data: { alpha: { status: 'connected' } } });
    await pending;
    expect(useMcpStore.getState().byDirectory).toEqual({});
  });

  it('records a diagnostic that the next status clears', async () => {
    connectMock.mockResolvedValue({ error: 'boom' });
    const failure = await useMcpStore.getState().connect('alpha', 'C:/ws');
    expect(failure).toBe('boom');
    expect(useMcpStore.getState().diagnosticsByDirectory[WS]?.alpha).toEqual({ status: 'failed', error: 'boom' });
    getMcpMock.mockResolvedValue({ data: { alpha: { status: 'connected' } } });
    await useMcpStore.getState().refresh({ directory: 'C:/ws' });
    expect(useMcpStore.getState().diagnosticsByDirectory[WS]?.alpha).toBeUndefined();
  });

  it('test-connection leaves no connection behind', async () => {
    getMcpMock
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { alpha: { status: 'connected' } } })
      .mockResolvedValue({ data: { alpha: { status: 'connected' } } });
    connectMock.mockResolvedValue({});
    disconnectMock.mockResolvedValue({});
    const outcome = await useMcpStore.getState().testConnection('alpha', 'C:/ws');
    expect(outcome).toEqual({ status: 'connected' });
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces cleanup failure as a warning', async () => {
    getMcpMock
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValue({ data: { alpha: { status: 'connected' } } });
    connectMock.mockResolvedValue({});
    disconnectMock.mockResolvedValue({ error: 'stuck' });
    const outcome = await useMcpStore.getState().testConnection('alpha', 'C:/ws');
    expect(outcome.status).toBe('connected');
    expect(outcome.warning).toBe('stuck');
  });

  it('ensureFresh shares one in-flight refresh and honors maxAge', async () => {
    let settle: (value: unknown) => void = () => undefined;
    getMcpMock.mockReturnValue(new Promise((resolve) => {
      settle = resolve as (value: unknown) => void;
    }));
    const first = useMcpStore.getState().ensureFresh({ maxAgeMs: 1000, directory: 'C:/ws' });
    const second = useMcpStore.getState().ensureFresh({ maxAgeMs: 1000, directory: 'C:/ws' });
    settle({ data: { alpha: { status: 'connected' } } });
    await Promise.all([first, second]);
    expect(getMcpMock).toHaveBeenCalledTimes(1);
    await useMcpStore.getState().ensureFresh({ maxAgeMs: 60_000, directory: 'C:/ws' });
    expect(getMcpMock).toHaveBeenCalledTimes(1);
  });

  it('clearing auth also disconnects the live session', async () => {
    removeAuthMock.mockResolvedValue({});
    disconnectMock.mockResolvedValue({});
    const failure = await useMcpStore.getState().clearAuth('alpha', 'C:/ws');
    expect(failure).toBeUndefined();
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });

  it('does not claim clearAuth success when disconnect cleanup fails', async () => {
    removeAuthMock.mockResolvedValue({});
    disconnectMock.mockResolvedValue({ error: 'still connected' });
    expect(await useMcpStore.getState().clearAuth('alpha', 'C:/ws')).toBe('still connected');
  });

  it('aborts test-connection before opening when status readback fails', async () => {
    getMcpMock.mockResolvedValue({ error: 'status request failed' });
    const outcome = await useMcpStore.getState().testConnection('alpha', 'C:/ws');
    expect(outcome).toEqual({ status: 'unknown', error: 'status request failed' });
    expect(connectMock).not.toHaveBeenCalled();
    expect(disconnectMock).not.toHaveBeenCalled();
  });

  it('cleans up a connected test when the final readback fails', async () => {
    getMcpMock
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValue({ error: 'snapshot lost' });
    connectMock.mockResolvedValue({});
    disconnectMock.mockResolvedValue({});
    const outcome = await useMcpStore.getState().testConnection('alpha', 'C:/ws');
    expect(outcome).toEqual({ status: 'unknown', error: 'snapshot lost' });
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });

  it('keeps an auth failure and reports the authorization URL', async () => {
    startAuthMock.mockResolvedValue({ error: 'denied' });
    expect(await useMcpStore.getState().startAuth('alpha', 'C:/ws')).toEqual({ error: 'denied' });
    startAuthMock.mockResolvedValue({ data: { authorizationUrl: 'https://x.test/auth' } });
    expect(await useMcpStore.getState().startAuth('alpha', 'C:/ws')).toEqual({
      authorizationUrl: 'https://x.test/auth',
    });
  });

  it('completes the OAuth callback silently', async () => {
    callbackMock.mockResolvedValue({});
    getMcpMock.mockResolvedValue({ data: { alpha: { status: 'connected' } } });
    expect(await useMcpStore.getState().completeAuth('alpha', 'code-1', 'C:/ws')).toBeUndefined();
    expect(callbackMock).toHaveBeenCalledWith('alpha', 'code-1', { directory: 'C:/ws' });
    expect(useMcpStore.getState().byDirectory[WS]).toEqual({ alpha: { status: 'connected' } });
  });

  it('counts health across the auth-required variants', () => {
    expect(computeMcpHealth({
      a: { status: 'connected' },
      b: { status: 'needs_auth' },
      c: { status: 'needs_client_registration', error: 'x' },
      d: { status: 'disabled' },
    })).toEqual({ connected: 1, total: 4, hasFailed: false, hasAuthRequired: true });
    expect(computeMcpHealth(undefined)).toEqual({
      connected: 0, total: 0, hasFailed: false, hasAuthRequired: false,
    });
  });
});

describe('MCP config store', () => {
  it('caches the list inside the TTL window; force bypasses', async () => {
    await useMcpConfigStore.getState().load({ directory: 'C:/ws' });
    await useMcpConfigStore.getState().load({ directory: 'C:/ws' });
    expect(listMock).toHaveBeenCalledTimes(1);
    await useMcpConfigStore.getState().load({ directory: 'C:/ws', force: true });
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the prior list when a record contradicts its key', async () => {
    listMock.mockResolvedValue({ ok: true, mcp: { alpha: record('beta') } });
    await useMcpConfigStore.getState().load({ directory: 'C:/ws', force: true });
    expect(useMcpConfigStore.getState().configsByDirectory[WS]).toEqual({});
    listMock.mockResolvedValue({ ok: true, mcp: { alpha: record('alpha') } });
    await useMcpConfigStore.getState().load({ directory: 'C:/ws', force: true });
    expect(Object.keys(useMcpConfigStore.getState().configsByDirectory[WS] ?? {})).toEqual(['alpha']);
  });

  it('reports a load failure without losing the list', async () => {
    listMock.mockResolvedValue({ ok: true, mcp: { alpha: record('alpha') } });
    await useMcpConfigStore.getState().load({ directory: 'C:/ws', force: true });
    listMock.mockResolvedValue({ ok: false, status: 500, error: 'disk on fire' });
    await useMcpConfigStore.getState().load({ directory: 'C:/ws', force: true });
    expect(useMcpConfigStore.getState().configsByDirectory[WS]).toEqual({ alpha: record('alpha') });
    expect(useMcpConfigStore.getState().lastErrorKeys[WS]).toBe('disk on fire');
  });

  it('splits quoted command lines and drops blank rows', () => {
    expect(parseCommandLine('npx -y "my server" arg')).toEqual(['npx', '-y', 'my server', 'arg']);
    expect(parseCommandLine('   ')).toEqual([]);
    expect(parseCommandLine('unclosed "quote')).toEqual(['unclosed', 'quote']);
    expect(rowsToMap([
      { key: 'TOKEN', value: 'x' }, { key: ' ', value: 'y' }, { key: 'K', value: '' },
    ])).toEqual({ TOKEN: 'x' });
  });

  it('builds local bodies with the parsed command', () => {
    const body = buildMcpBody({ ...newDraft(), command: 'npx -y demo' });
    expect(body.name).toBe('mcp-server');
    expect(body.entry.command).toEqual(['npx', '-y', 'demo']);
    expect(body.entry.environment).toEqual({});
    expect(buildMcpBody({ ...newDraft(), command: '   ' }).error).toBe('command required');
  });

  it('builds remote bodies with oauth and timeout rules', () => {
    const draft = {
      ...newDraft(), type: 'remote' as const, url: ' https://mcp.test/x ', headers: [{ key: 'A', value: '' }],
      oauthEnabled: true, oauth: { clientId: ' cid ', clientSecret: '', scope: '', redirectUri: '' },
      timeout: '45000',
    };
    const body = buildMcpBody(draft);
    expect(body.entry.url).toBe('https://mcp.test/x');
    expect(body.entry.headers).toEqual({});
    expect(body.entry.oauth).toEqual({ clientId: 'cid' });
    expect(body.entry.timeout).toBe(45000);
    expect(buildMcpBody({ ...draft, timeout: 'nope' } as McpDraft).error).toBe('timeout must be positive');
    expect(buildMcpBody({ ...newDraft(), type: 'remote', url: '' }).error).toBe('url required');
    const off = buildMcpBody({ ...newDraft(), type: 'remote', url: 'https://mcp.test/x' });
    expect(off.entry.oauth).toBe(false);
  });

  it('rebuilds an editable draft from a record', () => {
    const draft = draftFromRecord(record('alpha', {
      command: ['npx', '-y', 'demo'], environment: { TOKEN: 'x' },
    }));
    expect(draft.command).toBe('npx -y demo');
    expect(draft.environment).toEqual([{ key: 'TOKEN', value: 'x' }]);
    expect(draft.isNew).toBe(false);
    const remote = draftFromRecord(record('beta', {
      type: 'remote', url: 'https://mcp.test/x', oauth: { clientId: 'cid' }, timeout: 30000,
    }));
    expect(remote.oauthEnabled).toBe(true);
    expect(remote.oauth.clientId).toBe('cid');
    expect(remote.timeout).toBe('30000');
    const plain = draftFromRecord(record('gamma', { type: 'remote', url: 'https://mcp.test/y' }));
    expect(plain.oauthEnabled).toBe(false);
  });

  it('creates only for valid names and refetches the list', async () => {
    createMock.mockResolvedValue({
      ok: true, requiresReload: false, requiresRestart: true, restartDeferred: true, message: 'done',
    });
    const rejection = await useMcpConfigStore.getState().createEntry('Bad Name', newDraft());
    expect(rejection).toEqual({ ok: false, error: 'invalid server name' });
    expect(createMock).not.toHaveBeenCalled();
    const acceptance = await useMcpConfigStore.getState()
      .createEntry('alpha', { ...newDraft(), command: 'demo' });
    expect(acceptance).toEqual({ ok: true });
    expect(createMock).toHaveBeenCalledWith('alpha', expect.objectContaining({
      scope: 'user', type: 'local', command: ['demo'],
    }), undefined);
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft open when the server refuses', async () => {
    useMcpConfigStore.getState().openDraft(newDraft());
    patchMock.mockResolvedValue({ ok: false, status: 409, error: 'MCP server exists' });
    const outcome = await useMcpConfigStore.getState()
      .patchEntry('alpha', { ...newDraft(), command: 'demo' });
    expect(outcome).toEqual({ ok: false, error: 'MCP server exists' });
    expect(useMcpConfigStore.getState().draft).not.toBeNull();
    useMcpConfigStore.getState().closeDraft();
    expect(useMcpConfigStore.getState().draft).toBeNull();
  });

  it('clears retained remote headers when the draft drops them', async () => {
    patchMock.mockResolvedValue({
      ok: true, requiresReload: false, requiresRestart: true, restartDeferred: true, message: 'done',
    });
    await useMcpConfigStore.getState().patchEntry('alpha', {
      ...newDraft(), type: 'remote', url: 'https://mcp.test/x',
    });
    expect(patchMock).toHaveBeenCalledWith('alpha', expect.objectContaining({
      url: 'https://mcp.test/x', headers: {}, oauth: false,
    }), undefined);
  });

  it('deletes from the source layer and reloads', async () => {
    deleteMock.mockResolvedValue({
      ok: true, requiresReload: false, requiresRestart: true, message: 'gone',
    });
    expect(await useMcpConfigStore.getState().deleteEntry('alpha', 'C:/ws')).toEqual({ ok: true });
    expect(deleteMock).toHaveBeenCalledWith('alpha', 'C:/ws');
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it('patches the draft in place and remembers the selection', () => {
    useMcpConfigStore.getState().openDraft(newDraft());
    useMcpConfigStore.getState().patchDraft({ command: 'npx demo' });
    useMcpConfigStore.getState().patchDraft({ enabled: false });
    expect(useMcpConfigStore.getState().draft).toMatchObject({
      command: 'npx demo', enabled: false, type: 'local',
    });
    useMcpConfigStore.getState().select('alpha');
    expect(useMcpConfigStore.getState().selectedMcpName).toBe('alpha');
    expect(globalThis.localStorage.getItem('notnative.mcp.selectedName')).toBe('alpha');
  });
});
