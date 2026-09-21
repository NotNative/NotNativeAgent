// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * P8-6 SSH machines contract gates (doc 08 sections 7.2/7.3; the doc 09
 * bridge internals are P12). The store rides the bridge seam only: statuses
 * are pushed events, never polling; the web surface passes no bridge and the
 * gates pin exactly that posture.
 */
import { describe, expect, it } from 'vitest';

import {
  needsSecretStorageConfirm,
  normalizeSshInstance,
  parseSshCommand,
  remoteLanNeedsPassword,
  SSH_DEFAULT_TIMEOUT_SEC,
  SSH_PHASES,
  sshRuntimeKey,
  suggestRandomLocalPort,
  type DesktopSshInstance,
  type PortForward,
} from '../desktopSsh.ts';
import { desktopSshImportHosts, importCandidateIsUseable, parseSshConfig } from '../desktopSshImport.ts';
import {
  createDesktopSshStore,
  isSshPhase,
  normalizeStatus,
  sortStatuses,
  SSH_BRIDGE_COMMANDS,
  SSH_BRIDGE_UNAVAILABLE,
  type DesktopSshBridge,
  type DesktopSshStore,
} from '../desktopSshStore.ts';

const SAMPLE_CONFIG = [
  '# ~/.ssh/config',
  'Host atlas',
  'Host *',
  'Match user git',
  '  HostName git.example.com',
  'Host web1 beta1 web2',
  '  HostName 10.0.0.9',
  '  User deploy',
  'Host *.prod.example.com',
  '  HostName 10.1.1.2',
  'Host',   // no aliases: no rows
  '',
].join('\n');

function instance(overrides: Partial<DesktopSshInstance> = {}): DesktopSshInstance {
  const base = normalizeSshInstance({
    id: 'ssh-1',
    sshCommand: 'ssh -p 2222 deploy@atlas.example',
    connectionTimeoutSec: 45,
    remoteOpenchamber: {
      mode: 'managed',
      keepRunning: true,
      preferredPort: 3903,
      bindHost: '127.0.0.1',
      installMethod: 'bun',
      uploadBundleOverSsh: true,
    },
    localForward: { preferredLocalPort: 4101, bindHost: 'localhost' },
    auth: {
      sshPassword: { enabled: true, value: 'hunter2', store: 'never' },
      openchamberPassword: { enabled: true, value: 'pw', store: 'settings' },
    },
    portForwards: [
      { id: 'f1', enabled: true, type: 'local', localPort: 8081, remotePort: 80 },
      { id: 'f2', enabled: false, type: 'dynamic', localPort: 1080 },
    ],
  });
  return { ...(base as DesktopSshInstance), ...overrides };
}

describe('S7.2 instances contract', () => {
  it('sshCommand parses quoting, value flags and the last positional destination', () => {
    expect(parseSshCommand('ssh -p 2222 -i "my key.pem" deploy@atlas.example')).toEqual({
      destination: 'deploy@atlas.example',
      args: ['-p', '2222', '-i', 'my key.pem'],
    });
    expect(parseSshCommand('ssh host.two').destination).toBe('host.two');
    expect(parseSshCommand("ssh -o 'ProxyCommand nc x' b.yaml@mail ").destination).toBe('b.yaml@mail');
    expect(parseSshCommand('ssh -L 8081:127.0.0.1:80 user@h').destination).toBe('user@h');
    expect(parseSshCommand('ssh').destination).toBeNull();
  });

  it('the program word is excluded by basename (absolute paths and .exe case)', () => {
    expect(parseSshCommand('/usr/bin/ssh')).toEqual({ destination: null, args: [] });
    expect(parseSshCommand('/usr/bin/ssh -p 2222 h').destination).toBe('h');
    expect(parseSshCommand('"C:\\Program Files\\OpenSSH\\SSH.EXE" -p 22 h').destination).toBe('h');
  });

  it('-q stays boolean and -4/-J/-o value splitting follows ssh semantics', () => {
    expect(parseSshCommand('ssh -q host')).toEqual({ destination: 'host', args: ['-q'] });
    expect(parseSshCommand('ssh -4 -o "ProxyCommand nc x" -J hop target')).toEqual({
      destination: 'target',
      args: ['-4', '-o', 'ProxyCommand nc x', '-J', 'hop'],
    });
    expect(parseSshCommand('ssh -p')).toEqual({ destination: null, args: ['-p'] });
  });

  it('normalize defaults deferentially and rejects junk', () => {
    const normalized = normalizeSshInstance({ id: 'x', sshCommand: 'ssh h' });
    expect(normalized?.connectionTimeoutSec).toBe(SSH_DEFAULT_TIMEOUT_SEC);
    expect(normalized?.remoteOpenchamber.mode).toBe('external');
    expect(normalized?.remoteOpenchamber.bindHost).toBe('127.0.0.1');
    expect(normalized?.localForward.bindHost).toBe('127.0.0.1');
    expect(normalized?.auth).toEqual({});
    expect(normalized?.portForwards).toEqual([]);
    expect(normalizeSshInstance({ id: '   ', sshCommand: 'ssh h' })).toBeNull();
    expect(normalizeSshInstance({ id: 'x', sshCommand: '   ' })).toBeNull();
    expect(normalizeSshInstance(null)).toBeNull();
    expect(normalizeSshInstance([1])).toBeNull();
  });

  it('the timeout clamps into 5..600 and forwards survive normalization with ids', () => {
    const fast = normalizeSshInstance({ id: 'x', sshCommand: 'ssh h', connectionTimeoutSec: 1 });
    expect(fast?.connectionTimeoutSec).toBe(5);
    const slow = normalizeSshInstance({ id: 'x', sshCommand: 'ssh h', connectionTimeoutSec: 9000 });
    expect(slow?.connectionTimeoutSec).toBe(600);
    const withForwards = normalizeSshInstance({
      id: 'x',
      sshCommand: 'ssh h',
      portForwards: [
        { type: 'remote', remotePort: 6379 },
        { type: 'bogus' },
      ],
    });
    const forwards = (withForwards?.portForwards ?? []) as PortForward[];
    expect(forwards).toHaveLength(1);
    expect(forwards[0]?.enabled).toBe(false);
    expect(String(forwards[0]?.id)).toMatch(/^fwd_/u);
    expect(forwards[0]?.remotePort).toBe(6379);
  });

  it('the confirm and remote-LAN password rules follow the instance', () => {
    const lanNoPassword = normalizeSshInstance({
      id: 'x',
      sshCommand: 'ssh h',
      remoteOpenchamber: { bindHost: '0.0.0.0' },
    });
    expect(remoteLanNeedsPassword(lanNoPassword as DesktopSshInstance)).toBe(true);
    const base = instance();
    const lanWithPassword: DesktopSshInstance = {
      ...base,
      remoteOpenchamber: { ...base.remoteOpenchamber, bindHost: '0.0.0.0' },
      auth: { openchamberPassword: { enabled: true, value: 'pw', store: 'settings' } },
    };
    expect(remoteLanNeedsPassword(lanWithPassword)).toBe(false);
    const loopback = instance();
    expect(remoteLanNeedsPassword(loopback)).toBe(false);
    const neverStore = instance({
      auth: { sshPassword: { enabled: true, value: 'a', store: 'never' } },
    } as unknown as Partial<DesktopSshInstance>);
    expect(needsSecretStorageConfirm(neverStore)).toBe(false);
    const settingsStore = instance({
      auth: { openchamberPassword: { enabled: true, value: 'b', store: 'settings' } },
    } as unknown as Partial<DesktopSshInstance>);
    expect(needsSecretStorageConfirm(settingsStore)).toBe(true);
    // Doc-literal: the store choice confirms the deploy, enabled or not.
    const disabledSettings = instance({
      auth: { openchamberPassword: { enabled: false, store: 'settings' } },
    });
    expect(needsSecretStorageConfirm(disabledSettings)).toBe(true);
  });

  it('the runtime key is the ssh:<id> scheme pinned for S7.4 plugging', () => {
    expect(sshRuntimeKey('ssh-9')).toBe('ssh:ssh-9');
  });

  it('the random port suggestion dodges the busy set and exhausts sanely', () => {
    const busy = new Array(2000).fill(0).map(() => 49_152);
    const port = suggestRandomLocalPort(busy, () => 0.4);
    expect(port).toBeGreaterThanOrEqual(49_152);
    expect(port).toBeLessThanOrEqual(61_000);
    expect(busy.includes(port) && port !== 49_152).toBe(false);
  });
});

describe('S7.3 import candidates (~/.ssh/config)', () => {
  it('aliases expand per row, glob-only rows keep their pattern flag, Match/Include skip', () => {
    const rows = parseSshConfig(SAMPLE_CONFIG);
    expect(rows.map((row) => row.host)).toEqual(['atlas', 'web1', 'beta1', 'web2', '*.prod.example.com']);
    const atlas = rows.find((row) => row.host === 'atlas');
    expect(atlas?.pattern).toBe(false);
    expect(atlas?.sshCommand).toBe('ssh atlas');
    expect(atlas?.source).toBe('~/.ssh/config');
    expect(rows.find((row) => row.host === 'web1')?.pattern).toBe(false);
    const prod = rows.find((row) => row.host === '*.prod.example.com');
    expect(prod?.pattern).toBe(true);
    expect(importCandidateIsUseable({ host: 'atlas', pattern: false, source: 's', sshCommand: 'ssh atlas' })).toBe(true);
    expect(importCandidateIsUseable({ host: 'x', pattern: false, source: 's', sshCommand: 'ssh    ' })).toBe(false);
  });

  it('the bridge read guard returns nothing outside the shell', async () => {
    expect(await desktopSshImportHosts({ readSshConfig: async () => '' })).toEqual([]);
    const rows = await desktopSshImportHosts({ readSshConfig: async () => SAMPLE_CONFIG });
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('S7.3 store phases and pushed events', () => {
  const status = (partial: Parameters<typeof normalizeStatus>[0]) => normalizeStatus({
    startedByUs: true,
    retryAttempt: 0,
    requiresUserAction: false,
    updatedAtMs: 100,
    ...(partial as object),
  });

  it('phases are exactly the S7.3 machine and unknown phases are rejected', () => {
    expect([...SSH_PHASES].join(' ')).toBe('idle config_resolved auth_check master_connecting remote_probe installing updating server_detecting server_starting forwarding ready degraded error');
    expect(isSshPhase('ready')).toBe(true);
    expect(isSshPhase('running')).toBe(false);
    expect(status({ id: 'a', phase: 'ready' })?.phase).toBe('ready');
    expect(status({ id: 'a', phase: 'dancing' })).toBeNull();
    expect(status({ id: '', phase: 'idle' })).toBeNull();
  });

  it('statuses sort newest-first by updatedAtMs, ties keep input order', () => {
    const rows = [
      normalizeStatus({ id: 'old', phase: 'ready', updatedAtMs: 50, startedByUs: false })!,
      normalizeStatus({ id: 'new', phase: 'idle', updatedAtMs: 900, startedByUs: false })!,
      normalizeStatus({ id: 'mid', phase: 'error', updatedAtMs: 400, startedByUs: false })!,
    ];
    expect(sortStatuses(rows).map((row) => row.id)).toEqual(['new', 'mid', 'old']);
    const ties = [
      normalizeStatus({ id: 'first', phase: 'idle', updatedAtMs: 5, startedByUs: false })!,
      normalizeStatus({ id: 'second', phase: 'idle', updatedAtMs: 5, startedByUs: false })!,
    ];
    expect(sortStatuses(ties).map((row) => row.id)).toEqual(['first', 'second']);
  });

  it('status ports normalize with the same 1..65535 rule as instances', () => {
    expect(status({ id: 'a', phase: 'ready', localPort: 4101.7 })?.localPort).toBe(4101);
    expect(status({ id: 'a', phase: 'ready', localPort: -1 })?.localPort).toBeUndefined();
    expect(status({ id: 'a', phase: 'ready', remotePort: 70_000 })?.remotePort).toBeUndefined();
    expect(status({ id: 'a', phase: 'ready', remotePort: 'x' as unknown as number })?.remotePort).toBeUndefined();
  });

  interface InvokeLog { command: string; payload?: unknown }

  function fakeBridge(): { bridge: DesktopSshBridge; invokes: InvokeLog[]; pushStatus: (row: unknown) => void } {
    const invokes: InvokeLog[] = [];
    let sink: ((row: unknown) => void) | null = null;
    const bridge: DesktopSshBridge = {
      invoke: async (command, payload) => {
        invokes.push({ command, payload });
        return command === SSH_BRIDGE_COMMANDS.createFromCommand ? { id: 'ssh-9' } : null;
      },
      listenStatus: (handler) => { sink = handler as (row: unknown) => void; return () => { sink = null; }; },
      readSshConfig: async () => SAMPLE_CONFIG,
    };
    return { bridge, invokes, pushStatus: (row) => sink?.(row) };
  }

  it('actions ride the bridge; pushes merge; mutations update the in-shelf rows', async () => {
    const { bridge, invokes, pushStatus } = fakeBridge();
    const store = createDesktopSshStore(bridge);
    await store.loadConfig();
    expect(store.loaded).toBe(true);
    await store.refreshImportCandidates();
    expect(store.importCandidates.length).toBeGreaterThan(0);

    await store.connect('a');
    await store.disconnect('a');
    await store.cancelConnecting('a');
    await store.retry('a');
    const commands = invokes.map((entry) => entry.command);
    expect(commands.filter((command) => command === SSH_BRIDGE_COMMANDS.connect)).toHaveLength(1);

    pushStatus(status({ id: 'a', phase: 'ready', localUrl: 'http://127.0.0.1:4101' }));
    pushStatus(status({ id: 'a', phase: 'forwarding', updatedAtMs: 50 }));
    expect(store.statuses['a']?.phase).toBe('ready');
    expect(store.statuses['a']?.localUrl).toBe('http://127.0.0.1:4101');
    // Equal stamps REPLACE (only strictly older pushes are dropped).
    pushStatus(status({ id: 'a', phase: 'forwarding', updatedAtMs: 100 }));
    expect(store.statuses['a']?.phase).toBe('forwarding');

    const normalized = instance({ id: 'ssh-9', nickname: 'atlas' });
    await store.upsert(normalized);
    expect(store.instances.find((row) => row.id === 'ssh-9')?.nickname).toBe('atlas');
    const handle = await store.createFromCommand('ssh atlas', 'atlas2');
    expect(handle).toBe('ssh-9');
    await store.remove('ssh-9');
    expect(store.instances.find((row) => row.id === 'ssh-9')).toBeUndefined();
    expect(store.statuses['ssh-9']).toBeUndefined();
  });

  it('the manual full pass (refreshStatuses) applies every pushed snapshot row', async () => {
    const { bridge, invokes } = fakeBridge();
    let snapshotRows: unknown[] = [
      { id: 'b', phase: 'degraded', detail: 'port busy', startedByUs: true, retryAttempt: 2, requiresUserAction: true, updatedAtMs: 7 },
      { id: 'junk' },
    ];
    const store = createDesktopSshStore({
      ...bridge,
      invoke: async (command) => {
        invokes.push({ command });
        return snapshotRows;
      },
    });
    await store.loadConfig();
    await store.refreshStatuses();
    expect(store.statuses['b']?.phase).toBe('degraded');
    expect(store.statuses['b']?.detail).toBe('port busy');
    expect(store.statuses['b']?.requiresUserAction).toBe(true);
    expect(store.statuses['junk']).toBeUndefined();
    snapshotRows = [];
    await store.refreshStatuses();
    expect(store.statuses['b']?.phase).toBe('degraded');
    expect(store.lastError).toBeNull();
  });

  it('every trigger without a bridge records the unavailability in lastError', async () => {
    const probe = async (trigger: (store: DesktopSshStore) => Promise<unknown>): Promise<string | null> => {
      const store = createDesktopSshStore(null);
      await trigger(store);
      return store.lastError;
    };
    expect(await probe((store) => store.refreshStatuses())).toBe(SSH_BRIDGE_UNAVAILABLE);
    expect(await probe((store) => store.refreshImportCandidates())).toBe(SSH_BRIDGE_UNAVAILABLE);
    expect(await probe((store) => store.connect('a'))).toBe(SSH_BRIDGE_UNAVAILABLE);
  });

  it('a transient config-read failure never kills the pushed status stream', async () => {
    const { bridge, pushStatus } = fakeBridge();
    const store = createDesktopSshStore({
      ...bridge,
      invoke: async (command) => {
        if (command === 'desktopSshConfig') throw new Error('config boom');
        return null;
      },
    });
    await store.loadConfig();
    expect(store.loaded).toBe(false);
    expect(store.lastError).toBe('config boom');
    pushStatus(status({ id: 'a', phase: 'master_connecting' }));
    expect(store.statuses['a']?.phase).toBe('master_connecting');
  });

  it('a bridge refusal without an id stays traceable through lastError', async () => {
    const { bridge } = fakeBridge();
    let reply: unknown = {};
    const store = createDesktopSshStore({
      ...bridge,
      invoke: async () => reply,
    });
    expect(await store.createFromCommand('ssh atlas')).toBeNull();
    expect(store.lastError).toContain(SSH_BRIDGE_COMMANDS.createFromCommand);
    reply = { id: 'ssh-9' };
    expect(await store.createFromCommand('ssh atlas')).toBe('ssh-9');
    expect(store.lastError).toBeNull();
  });

  it('upsert edits keep their row position and new rows append', async () => {
    const { bridge } = fakeBridge();
    const store = createDesktopSshStore(bridge);
    await store.upsert(instance({ id: 'a' }));
    await store.upsert(instance({ id: 'b' }));
    expect(store.instances.map((row) => row.id)).toEqual(['a', 'b']);
    await store.upsert(instance({ id: 'a', nickname: 'edited' }));
    expect(store.instances.map((row) => row.id)).toEqual(['a', 'b']);
    expect(store.instances[0]?.nickname).toBe('edited');
  });

  it('setBridge clears the shelf: statuses, instances, the loaded flag', async () => {
    const { bridge, pushStatus } = fakeBridge();
    const store = createDesktopSshStore(bridge);
    await store.loadConfig();
    pushStatus(status({ id: 'a', phase: 'ready' }));
    expect(store.statuses['a']).toBeDefined();
    store.setBridge(bridge);
    expect(store.statuses).toEqual({});
    expect(store.instances).toEqual([]);
    expect(store.loaded).toBe(false);
  });

  it('the import-candidates guard answers empty on null/empty bridge text', async () => {
    const { bridge } = fakeBridge();
    const nullText = createDesktopSshStore({ ...bridge, readSshConfig: async () => null as unknown as string });
    await nullText.refreshImportCandidates();
    expect(nullText.importCandidates).toEqual([]);
    expect(nullText.lastError).toBeNull();
    const emptyText = createDesktopSshStore({ ...bridge, readSshConfig: async () => '   ' });
    await emptyText.refreshImportCandidates();
    expect(emptyText.importCandidates).toEqual([]);
  });

  it('without a bridge the store loads empty and every trigger stays honest', async () => {
    const store = createDesktopSshStore(null);
    await store.loadConfig();
    expect(store.loaded).toBe(true);
    expect(store.instances).toEqual([]);
    expect(store.lastError).toBe(SSH_BRIDGE_UNAVAILABLE);
    await store.connect('a');
    expect(store.lastError).toBe(SSH_BRIDGE_UNAVAILABLE);
    expect(store.getBridge()).toBeNull();
    store.setBridge(fakeBridge().bridge);
    expect(store.getBridge()).not.toBeNull();
    expect(store.loaded).toBe(false);
  });
});
