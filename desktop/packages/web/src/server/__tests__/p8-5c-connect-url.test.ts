// SPDX-License-Identifier: Apache-2.0
/**
 * P8-5c connect-url CLI gates (doc 08 sections 5.9 + 5.5/5.1; doc 03 S10).
 *
 * ASCII-only on purpose (the CP1252 round-trip lesson from the P8-5b
 * harnesses): section references are spelled with a plain S. The gates pin:
 * - the exact server-URL resolution order (explicit --server > host/env
 *   passthrough > concrete host > LAN scan > loopback fallback);
 * - the candidate set (direct priority 10 + relay priority 30 on request or
 *   when the host relay is enabled; relay endpoint chain env > stored >
 *   default; identity lazy-mint from the shared strict store);
 * - the on-disk pairing session (usesRelay, label, allowedClientKinds, TTL)
 *   and the byte-link through the SHARED ui encoder + parser;
 * - the three output modes, discovery/auto-start posture, and the CLI
 *   dispatch rules (unknown command suggestions, usage codes).
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { parsePairingConnectionPayload } from '@notnative/ui/lib/connection-payload.ts';
import { serverIdFromJwk, publicJwkCanonical } from '../lib/relay/identity.ts';
import { CliUsageError, parseInvocation, suggestCloseMatches, type FlagSpec } from '../../cli/args.ts';
import { CliRuntimeError } from '../../cli/output.ts';
import type { ServerTarget, SpawnSeam } from '../../cli/instances.ts';
import type { ResolvedOutputMode } from '../../cli/output.ts';

let resolution: typeof import('../../cli/connect-url.ts') | null = null;
let command: typeof import('../../cli/connect-url-command.ts') | null = null;
let instances: typeof import('../../cli/instances.ts') | null = null;
let dispatch: typeof import('../../cli/main.ts') | null = null;

const DATA_DIR = join(tmpdir(), `nnd-p85c-${process.pid}`);
const PORT = 3987;
const HUMAN: ResolvedOutputMode = { mode: 'human', human: true };
const QUIET: ResolvedOutputMode = { mode: 'quiet', human: false };
const JSON_MODE: ResolvedOutputMode = { mode: 'json', human: false };

beforeAll(async () => {
  process.env.NOTNATIVE_DATA_DIR = DATA_DIR;
  mkdirSync(DATA_DIR, { recursive: true });
  resolution = await import('../../cli/connect-url.ts');
  command = await import('../../cli/connect-url-command.ts');
  instances = await import('../../cli/instances.ts');
  dispatch = await import('../../cli/main.ts');
});

beforeEach(() => {
  for (const file of ['relay-config.json', 'client-pairing-sessions.json', 'relay-identity.json']) {
    rmSync(join(DATA_DIR, file), { force: true });
  }
  rmSync(join(DATA_DIR, 'instances'), { recursive: true, force: true });
});

afterAll(() => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

function resolve(input: Parameters<NonNullable<typeof resolution>['resolveServerTarget']>[0]): ServerTarget {
  return (resolution as NonNullable<typeof resolution>).resolveServerTarget(input);
}

function writeRelayConfig(enabled: boolean, relayUrl: string | null): void {
  writeFileSync(
    join(DATA_DIR, 'relay-config.json'),
    `${JSON.stringify({ version: 1, enabled, relayUrl }, null, 2)}\n`,
  );
}

function fakeSpawnSeam(calls: Array<{ command: string; args: string[]; env: Record<string, string> }>): SpawnSeam {
  return {
    spawnDetached(spawnCommand: string, spawnArgs: string[], env: Record<string, string>): number {
      calls.push({ command: spawnCommand, args: spawnArgs, env });
      return 4242;
    },
  };
}

interface RunResult {
  stdout: string;
  stderr: string;
  killCalls: number[];
  storeRows: () => Array<Record<string, unknown>>;
  spawnCalls: Array<{ command: string; args: string[]; env: Record<string, string> }>;
}

async function runConnect(
  flags: import('../../cli/connect-url-command.ts').ConnectUrlFlags,
  mode: ResolvedOutputMode,
  options: {
    probeFirstAnswer?: boolean;
    readinessAnswers?: boolean;
    readinessTimeoutMs?: number;
    spawnCalls?: Array<{ command: string; args: string[]; env: Record<string, string> }>;
    /** Out-param: kill-call records survive a rejection of the run. */
    killOut?: number[];
  } = {},
): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const killCalls = options.killOut ?? [];
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array): boolean => {
    stdout.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array): boolean => {
    stderr.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write);
  const spawnCalls = options.spawnCalls ?? [];
  const firstAnswered = options.probeFirstAnswer ?? false;
  const laterAnswers = options.readinessAnswers ?? true;
  let calls = 0;
  const probe = async (): Promise<{ answered: boolean }> => {
    calls += 1;
    return { answered: calls === 1 ? firstAnswered : laterAnswers };
  };
  try {
    await (command as NonNullable<typeof command>).runConnectUrl(flags, mode, {
      dataDir: DATA_DIR,
      probe,
      spawn: fakeSpawnSeam(spawnCalls),
      kill: (pid) => { killCalls.push(pid); return true; }, // tests never reach the real process table
      readinessTimeoutMs: options.readinessTimeoutMs,
    });
  } finally {
    writeSpy.mockRestore();
    errorSpy.mockRestore();
  }
  return {
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    killCalls,
    spawnCalls,
    storeRows: () => {
      const path = join(DATA_DIR, 'client-pairing-sessions.json');
      if (!existsSync(path)) return [];
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sessions?: Array<Record<string, unknown>> };
      return parsed.sessions ?? [];
    },
  };
}

function jsonDocument(script: string): Record<string, unknown> {
  return JSON.parse(script) as Record<string, unknown>;
}

describe('server-URL resolution (doc 08 S5.9 order)', () => {
  it('explicit --server normalizes the URL, keeps source explicit, binds loopback', () => {
    const target = resolve({ port: PORT, serverFlag: 'https://my-public.example.com/' });
    expect(target.serverUrl).toBe('https://my-public.example.com');
    expect(target.source).toBe('explicit');
    expect(target.host).toBe('127.0.0.1');
  });

  it('a junk --server is a usage error', () => {
    expect(() => resolve({ port: PORT, serverFlag: 'not a url' })).toThrow(CliUsageError);
    expect(() => resolve({ port: PORT, serverFlag: 'ftp://x/' })).toThrow(CliUsageError);
  });

  it('--host full-URL passes through as the public server URL (binds loopback)', () => {
    const target = resolve({ port: PORT, hostFlag: 'http://edge.example.net:9443' });
    expect(target.serverUrl).toBe('http://edge.example.net:9443');
    expect(target.source).toBe('configured');
    expect(target.host).toBe('127.0.0.1');
  });

  it('concrete non-loopback host becomes http://host:port (the autostart bind)', () => {
    const target = resolve({ port: PORT, hostFlag: '192.168.7.9' });
    expect(target.serverUrl).toBe('http://192.168.7.9:3987');
    expect(target.source).toBe('configured');
    expect(target.host).toBe('192.168.7.9');
  });

  it('loopback hostnames fall back to the loopback URL', () => {
    const target = resolve({ port: PORT, hostFlag: 'localhost' });
    expect(target.serverUrl).toBe(`http://127.0.0.1:${PORT}`);
    expect(target.source).toBe('loopback-fallback');
    expect(target.host).toBe('127.0.0.1');
  });

  it('wildcard bind uses the LAN IPv4 scan, and loopback when none', () => {
    const lan = resolve({ port: PORT, hostFlag: '0.0.0.0', lanScan: () => '10.1.2.3' });
    expect(lan.serverUrl).toBe('http://10.1.2.3:3987');
    expect(lan.source).toBe('lan-detected');
    const none = resolve({ port: PORT, hostFlag: '::', lanScan: () => null });
    expect(none.serverUrl).toBe(`http://127.0.0.1:${PORT}`);
    expect(none.source).toBe('loopback-fallback');
  });

  it('no host flag at all resolves the localhost default', () => {
    const target = resolve({ port: PORT });
    expect(target.serverUrl).toBe(`http://127.0.0.1:${PORT}`);
    expect(target.source).toBe('loopback-fallback');
  });
});

describe('candidates + relay chain (S5.5/S5.9)', () => {
  it('the relay candidate rides --relay: default endpoint + lazy-minted identity', async () => {
    const result = await runConnect({ port: PORT, relay: true }, JSON_MODE, {
      probeFirstAnswer: true,
      readinessAnswers: true,
    });
    const document = jsonDocument(result.stdout) as {
      candidates: Array<{ type: string; relayUrl?: string; serverId: string; hostEncPubJwk: Record<string, string>; priority: number; url?: string }>;
      autoStarted: boolean;
      pairingId: string;
    };
    expect(document.candidates).toHaveLength(2);
    expect(document.candidates[0]?.type).toBe('lan');
    expect(document.candidates[1]?.type).toBe('relay');
    expect(document.candidates[1]?.relayUrl).toBe('wss://relay.openchamber.dev/ws');
    expect(document.candidates[1]?.priority).toBe(30);
    expect(document.candidates[1]?.hostEncPubJwk.kty).toBe('EC');
    expect(document.autoStarted).toBe(false);
    expect(existsSync(join(DATA_DIR, 'relay-identity.json'))).toBe(true);
    expect(result.storeRows()).toHaveLength(1);
    expect(result.storeRows()[0]?.usesRelay).toBe(true);
  });

  it('an enabled relay config adds the candidate without --relay', async () => {
    writeRelayConfig(true, 'wss://relay.example.internal/ws');
    const result = await runConnect({ port: PORT }, JSON_MODE, { probeFirstAnswer: true });
    const document = jsonDocument(result.stdout) as { candidates: Array<{ type: string; relayUrl?: string }> };
    expect(document.candidates).toHaveLength(2);
    expect(document.candidates[1]?.relayUrl).toBe('wss://relay.example.internal/ws');
    expect(result.storeRows()[0]?.usesRelay).toBe(true);
  });

  it('the NOTNATIVE_RELAY_URL env pins the endpoint ahead of the stored one', async () => {
    writeRelayConfig(true, 'wss://relay.example.internal/ws');
    vi.stubEnv('NOTNATIVE_RELAY_URL', 'wss://env.relay.example/ws');
    try {
      const result = await runConnect({ port: PORT }, JSON_MODE, { probeFirstAnswer: true });
      const document = jsonDocument(result.stdout) as { candidates: Array<{ type: string; relayUrl?: string }> };
      expect(document.candidates[1]?.relayUrl).toBe('wss://env.relay.example/ws');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a corrupt relay config is never read as enabled (no surprise relay leg)', async () => {
    writeFileSync(join(DATA_DIR, 'relay-config.json'), 'not json');
    const result = await runConnect({ port: PORT }, JSON_MODE, { probeFirstAnswer: true });
    const document = jsonDocument(result.stdout) as { candidates: Array<{ type: string }> };
    expect(document.candidates).toHaveLength(1);
    expect(result.storeRows()[0]?.usesRelay).toBe(false);
  });

  it('a disabled relay config without --relay gives a direct-only link', async () => {
    writeRelayConfig(false, null);
    const result = await runConnect({ port: PORT }, JSON_MODE, { probeFirstAnswer: true });
    const document = jsonDocument(result.stdout) as { candidates: Array<{ type: string }> };
    expect(document.candidates).toHaveLength(1);
    expect(result.storeRows()[0]?.usesRelay).toBe(false);
  });

  it('http --server advertises a lan candidate; https an https-seen tunnel candidate', async () => {
    const httpResult = await runConnect({ port: PORT, server: 'http://edge.example:9999' }, JSON_MODE, { probeFirstAnswer: true });
    expect((jsonDocument(httpResult.stdout) as { candidates: Array<{ type: string }> }).candidates[0]?.type).toBe('lan');
    const httpsResult = await runConnect({ port: PORT, server: 'https://edge.example:9999' }, JSON_MODE, { probeFirstAnswer: true });
    expect((jsonDocument(httpsResult.stdout) as { candidates: Array<{ type: string }> }).candidates[0]?.type).toBe('tunnel');
  });
});

describe('pairing session + link (S5.1/S5.2/S5.9)', () => {
  it('the link round-trips through the ui parser with exact session fields', async () => {
    const result = await runConnect({ port: PORT, name: 'atlas' }, JSON_MODE, { probeFirstAnswer: true });
    const document = jsonDocument(result.stdout) as { connectUrl: string; pairingId: string; fingerprint: string; expiresAt: string };
    const payload = parsePairingConnectionPayload(document.connectUrl)!;
    expect(payload.v).toBe(2);
    expect(payload.pairingId).toBe(document.pairingId);
    expect(payload.fingerprint).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/u);
    expect(payload.secret).toHaveLength(43);
    expect(typeof payload.label).toBe('string');
    expect((payload.label as string).length).toBeGreaterThan(0);
    expect(payload.candidates).toHaveLength(1);
    expect(payload.expiresAt).toBe(document.expiresAt);
    const row = result.storeRows()[0] as {
      id: string;
      label: string;
      allowedClientKinds: string[];
      expiresAt: string;
      usedAt: null;
      fingerprint: string;
    };
    expect(row.id).toBe(document.pairingId);
    expect(row.label).toBe('atlas');
    expect(row.allowedClientKinds).toEqual(['mobile', 'desktop']);
    expect(row.usedAt).toBeNull();
    expect(row.fingerprint).toBe(document.fingerprint);
    const ttl = Date.parse(row.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThan(10 * 60_000 + 3_000);
  });

  it('the serverId + hostEncPubJwk stay stable across runs (shared singleton discipline)', async () => {
    const first = await runConnect({ port: PORT, relay: true }, JSON_MODE, { probeFirstAnswer: true });
    const second = await runConnect({ port: PORT, relay: true }, JSON_MODE, { probeFirstAnswer: true });
    const firstDocument = jsonDocument(first.stdout) as { candidates: Array<{ serverId?: string; hostEncPubJwk?: Record<string, string> }> };
    const secondDocument = jsonDocument(second.stdout) as { candidates: Array<{ serverId?: string; hostEncPubJwk?: Record<string, string> }> };
    const firstRelay = firstDocument.candidates[1];
    const secondRelay = secondDocument.candidates[1];
    expect(firstRelay?.serverId).toBeTruthy();
    expect(secondRelay?.serverId).toBe(firstRelay?.serverId);
    expect(secondRelay?.hostEncPubJwk).toEqual(firstRelay?.hostEncPubJwk);
  });

  it('a name label is trimmed and capped by the store (80 chars)', async () => {
    const result = await runConnect({ port: PORT, name: `  ${'x'.repeat(120)} ` }, JSON_MODE, { probeFirstAnswer: true });
    expect(String(result.storeRows()[0]?.label)).toHaveLength(80);
  });
});

describe('output modes (doc 03 S10.3 + doc 08 S5.9)', () => {
  it('--quiet prints only the link (one openchamber:// line, its own secret)', async () => {
    const result = await runConnect({ port: PORT }, QUIET, { probeFirstAnswer: true });
    const lines = result.stdout.split('\n').filter((entry) => entry !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^openchamber:\/\/connect\?v=2&p=[A-Za-z0-9_-]+$/u);
    // Byte-parity with the parser: the only printed line round-trips.
    expect(parsePairingConnectionPayload(lines[0] ?? '')).not.toBeNull();
  });

  it('--json keeps exactly the S5.9 fields and wins over --quiet', async () => {
    const result = await runConnect({ port: PORT, json: true, quiet: true }, JSON_MODE, { probeFirstAnswer: true });
    const document = jsonDocument(result.stdout) as Record<string, unknown>;
    expect(Object.keys(document).sort()).toEqual([
      'autoStarted', 'candidates', 'connectUrl', 'expiresAt', 'fingerprint', 'pairingId', 'serverUrl',
    ]);
  });

  it('human mode shows the URL source, fingerprint, loopback + relay advisories', async () => {
    writeRelayConfig(false, null);
    const result = await runConnect({ port: PORT, relay: true }, HUMAN, { probeFirstAnswer: true });
    expect(result.stdout).toContain(`Server URL: http://127.0.0.1:${PORT} (source: loopback-fallback)`);
    expect(result.stdout).toContain('Fingerprint: ');
    expect(result.stdout).toContain('[LAN_UNREACHABLE]');
    expect(result.stdout).toContain('[RELAY_STARTING]');
    expect(result.stdout).toContain('Relay fallback: wss://relay.openchamber.dev/ws');
    expect(result.stdout).toContain('openchamber://connect?v=2&p=');
  });

  it('a password-less auto-start warns: human stdout glyphs, quiet stderr only', async () => {
    const humanResult = await runConnect({ port: PORT, uiPassword: '' }, HUMAN, { probeFirstAnswer: false });
    expect(humanResult.stdout).toContain('[PASSWORD_NOT_SET]');
    const quietResult = await runConnect({ port: PORT }, QUIET, { probeFirstAnswer: false });
    expect(quietResult.stderr).toContain('warning PASSWORD_NOT_SET:');
    // S10.3: `connect-url --quiet` stdout remains exactly the link.
    const lines = quietResult.stdout.split('\n').filter((entry) => entry !== '');
    expect(lines).toHaveLength(1);
    expect(parsePairingConnectionPayload(lines[0] ?? '')).not.toBeNull();
  });
});

describe('discovery + auto-start (S5.9 ensure posture)', () => {
  it('an answering probe skips the spawn (autoStarted false, no instance record)', async () => {
    const result = await runConnect({ port: PORT }, JSON_MODE, { probeFirstAnswer: true });
    expect(jsonDocument(result.stdout).autoStarted).toBe(false);
    expect(result.spawnCalls).toHaveLength(0);
    expect(existsSync(join(DATA_DIR, 'instances', `notnative-${PORT}.json`))).toBe(false);
  });

  it('an unanswered probe auto-starts once and writes the record with the env brands', async () => {
    const calls: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
    const result = await runConnect(
      { port: PORT, host: '192.168.7.9', uiPassword: 'pw' },
      JSON_MODE,
      { probeFirstAnswer: false, spawnCalls: calls },
    );
    expect(jsonDocument(result.stdout).autoStarted).toBe(true);
    expect(result.spawnCalls).toHaveLength(1);
    const call = result.spawnCalls[0]!;
    expect(call.command).toBe(process.execPath);
    expect(call.args[0]).toBe('--experimental-transform-types');
    expect(call.args[1]?.endsWith('index.ts')).toBe(true);
    expect(call.args[1]).toContain('server');
    expect(call.env.NOTNATIVE_PORT).toBe(String(PORT));
    expect(call.env.NOTNATIVE_HOST).toBe('192.168.7.9');
    expect(call.env.NOTNATIVE_UI_PASSWORD).toBe('pw');
    const recordPath = join(DATA_DIR, 'instances', `notnative-${PORT}.json`);
    expect(existsSync(recordPath)).toBe(true);
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { pid: number; host: string; autoStarted: boolean };
    expect(record.pid).toBe(4242);
    expect(record.host).toBe('192.168.7.9');
    expect(record.autoStarted).toBe(true);
  });

  it('a readiness timeout fails as a runtime error, kills the spawned child, clears the record', async () => {
    const killCalls: number[] = [];
    await expect(runConnect({ port: PORT }, JSON_MODE, {
      probeFirstAnswer: false,
      readinessAnswers: false,
      readinessTimeoutMs: 50,
      killOut: killCalls,
    })).rejects.toThrow(CliRuntimeError);
    expect(killCalls).toEqual([4242]); // exactly the pid the spawn seam returned
    expect(existsSync(join(DATA_DIR, 'instances', `notnative-${PORT}.json`))).toBe(false);
  });
});

describe('CLI dispatch + parser (doc 03 S10 global rules)', () => {
  it('unknown commands suggest close matches; junk stays unsuggested', () => {
    expect(suggestCloseMatches('conect-url', ['connect-url', 'help', 'version', 'serve'])).toEqual(['connect-url']);
    expect(suggestCloseMatches('heln', ['connect-url', 'help', 'version'])).toEqual(['help']);
    expect(suggestCloseMatches('zzz', ['connect-url', 'help', 'version'])).toEqual([]);
    expect(suggestCloseMatches('', ['connect-url', 'help', 'version'])).toEqual([]);
  });

  it('unknown flags are usage errors carrying the name', () => {
    const specs: FlagSpec[] = [{ name: 'port', kind: 'number', short: '-p' }];
    expect(() => parseInvocation(['--relayy'], specs)).toThrow(CliUsageError);
  });

  it('short forms match their declared aliases and carry values', () => {
    const specs: FlagSpec[] = [
      { name: 'port', kind: 'number', short: '-p' },
      { name: 'quiet', kind: 'boolean', short: '-q' },
      { name: 'json', kind: 'boolean' },
    ];
    const parsed = parseInvocation(['-p', '3987', '-q', '--json'], specs);
    expect(parsed.flags.port).toBe(3987);
    expect(parsed.flags.quiet).toBe(true);
    expect(parsed.flags.json).toBe(true);
  });

  it('a range-broken --port is a usage error with exit code 2', async () => {
    await expect(runConnect({ port: 70_000 } as never, JSON_MODE, { probeFirstAnswer: true }))
      .rejects.toThrow(CliUsageError);
    await expect(runConnect({ port: 0 } as never, JSON_MODE, { probeFirstAnswer: true }))
      .rejects.toThrow(CliUsageError);
  });

  it('the qrcode terminal dep renders (bound module: dependency present for --qr)', () => {
    const terminal = createRequire(import.meta.url)('qrcode-terminal') as { generate: (text: string, options: { small: boolean }, callback: (code: string) => void) => void };
    const captured: { code: string | null } = { code: null };
    const realisticLink = `openchamber://connect?v=2&p=${'q'.repeat(120)}`;
    expect(() => terminal.generate(realisticLink, { small: true }, (code) => { captured.code = code; })).not.toThrow();
    expect(captured.code).not.toBeNull();
  });

  it('the instance record path helper names the data dir', () => {
    expect((instances as NonNullable<typeof instances>).instanceRecordPath(123, '/tmp/x')).toBe('/tmp/x/instances/notnative-123.json');
  });
});

describe('parser edges (doc 03 S10 pin: flag forms + numeric junk)', () => {
  const dispatchSpecs = (): FlagSpec[] => (dispatch as NonNullable<typeof dispatch>).CONNECT_URL_SPECS as FlagSpec[];

  it('--lan parses from its spec (S10.1/5.9 --lan = host 0.0.0.0)', () => {
    const parsed = parseInvocation(['--lan', '-p', '3988'], dispatchSpecs());
    expect(parsed.flags.lan).toBe(true);
    expect(parsed.flags.port).toBe(3988);
    expect(parsed.command).toBeNull(); // no trailing garbage
  });

  it('a short -p=x junk form is rejected with its REAL syntax in the message', () => {
    expect(() => parseInvocation(['-p=x'], dispatchSpecs())).toThrow(/"-p=x"/u);
  });

  it('numeric junk is refused at the parser: empty value and NaN', () => {
    expect(() => parseInvocation(['--port='], dispatchSpecs())).toThrow(/expects a number, got ""/u);
    expect(() => parseInvocation(['--port', 'abc'], dispatchSpecs())).toThrow(/expects a number, got "abc"/u);
    // octal-looking '08' is still an honest decimal 8 (range-checked later)
    expect(parseInvocation(['--port', '08'], dispatchSpecs()).flags.port).toBe(8);
  });

  it('duplicate flags are last-writer-wins; --no-qr negates the boolean', () => {
    const parsed = parseInvocation(['--relay', '--no-relay', '--qr=true', '--no-qr'], dispatchSpecs());
    expect(parsed.flags.relay).toBe(false);
    expect(parsed.flags.qr).toBe(false);
  });
});

describe('S5.9 resolution hardening (canonical URLs + host tokens)', () => {
  it('an uppercase scheme canonicalizes so https advertises a tunnel candidate', async () => {
    const result = await runConnect({ port: PORT, server: 'HTTPS://Edge.Example:9300' }, JSON_MODE, { probeFirstAnswer: true });
    const document = jsonDocument(result.stdout) as { serverUrl: string; candidates: Array<{ type: string; url?: string }> };
    expect(document.serverUrl).toBe('https://edge.example:9300');
    expect(document.candidates[0]?.type).toBe('tunnel');
    expect(document.candidates[0]?.url).toBe('https://edge.example:9300');
  });

  it('a bare IPv6 host rides as a bracketed URL; junk pathy hosts are usage errors', () => {
    const ipv6 = resolve({ port: PORT, hostFlag: 'fe80::1' });
    expect(ipv6.serverUrl).toBe(`http://[fe80::1]:${PORT}`);
    expect(ipv6.host).toBe('fe80::1');
    expect(() => resolve({ port: PORT, hostFlag: 'ns.example.com/path' })).toThrow(CliUsageError);
    expect(() => resolve({ port: PORT, hostFlag: 'a@b' })).toThrow(CliUsageError);
  });

  it('a fractional --port is a range usage error naming the value', async () => {
    await expect(runConnect({ port: '1.9' }, JSON_MODE, { probeFirstAnswer: true }))
      .rejects.toThrow(/got "1\.9"/u);
  });

  it('an explicit --ui-password suppresses the auto-start password warning', async () => {
    const result = await runConnect({ port: PORT, uiPassword: 'pw' }, HUMAN, { probeFirstAnswer: false });
    expect(result.stdout).not.toContain('PASSWORD_NOT_SET');
  });
});

describe('CLI dispatch (doc 03 S10: suggestions, help routing, exit codes)', () => {
  interface DispatchCapture { stdout: string; stderr: string }

  async function runDispatch(argv: readonly string[]): Promise<DispatchCapture & { exitCode: number }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array): boolean => {
      stdout.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array): boolean => {
      stderr.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      const outcome = await (dispatch as NonNullable<typeof dispatch>).main(argv);
      return { exitCode: outcome.exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
    } finally {
      writeSpy.mockRestore();
      errorSpy.mockRestore();
    }
  }

  it('an unknown pending command suggests the roster word and exits 2', async () => {
    const capture = await runDispatch(['stpo']);
    expect(capture.exitCode).toBe(2);
    expect(capture.stdout).toContain('"stpo"');
    expect(capture.stdout).toContain('did you mean "stop"?');
    expect(capture.stdout).toContain('Pending the P4 CLI slice');
  });

  it('a bare-flag invocation (no command) is a usage error, never an implicit run', async () => {
    // bin.ts maps the CliUsageError class to its carried exit code (2); the
    // dispatch itself never reaches the command body.
    await expect(runDispatch(['--json', '--quiet'])).rejects.toThrow(CliUsageError);
    await expect(runDispatch(['--json', '--quiet'])).rejects.toThrow(/no command given/u);
  });

  it('a positional after the command is a usage error, not a silently ignored token', async () => {
    await expect(runDispatch(['connect-url', 'extra'])).rejects.toThrow(/unexpected argument "extra"/u);
  });

  it('help routes: bare help/-h -> overview, help connect-url / connect-url -h -> topic', async () => {
    const bareHelp = await runDispatch(['help']);
    expect(bareHelp.exitCode).toBe(0);
    expect(bareHelp.stdout).toContain('Pending the P4 CLI slice');
    const shortHelp = await runDispatch(['-h']);
    expect(shortHelp.exitCode).toBe(0);
    expect(shortHelp.stdout).toContain('Output modes');
    const topic = await runDispatch(['help', 'connect-url']);
    expect(topic.exitCode).toBe(0);
    expect(topic.stdout).toContain('pairing-v2 connect link');
    const commandHelp = await runDispatch(['connect-url', '-h']);
    expect(commandHelp.exitCode).toBe(0);
    expect(commandHelp.stdout).toContain('pairing-v2 connect link');
  });

  it('help with a pending topic or unknown topic exits 2 with guidance', async () => {
    const pending = await runDispatch(['help', 'serve']);
    expect(pending.exitCode).toBe(2);
    expect(pending.stdout).toContain('"serve" is not available');
    await expect(runDispatch(['help', 'nope'])).rejects.toThrow(/unknown help topic/u);
    await expect(runDispatch(['version', 'extra'])).rejects.toThrow(/takes no arguments/u);
  });
});
