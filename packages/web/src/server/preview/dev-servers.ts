// SPDX-License-Identifier: Apache-2.0
/** Advisory local listener discovery; never guesses from package scripts. */
import { execFile } from 'node:child_process';
import type { Hono } from 'hono';
import { ENV } from '../env.ts';

export interface DevServer { port: number; pid: number | null; command: string; url: string }
type Run = (command: string, args: string[]) => Promise<string>;
const IGNORED = new Set([22, 53, 445, 631, 5432, 3306, 6379, 27017, 9229]);

function addressPort(value: string): number | null {
  const match = /^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\*|\[::1\]|\[::\]|::1|::):(\d+)$/iu.exec(value);
  const port = match ? Number(match[1]) : NaN;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function parseNetstatListeners(output: string): DevServer[] {
  const byPort = new Map<number, DevServer>();
  for (const line of output.split(/\r?\n/u)) {
    const cells = line.trim().split(/\s+/u);
    if (cells.length < 5 || !/^tcp$/iu.test(cells[0]!) || !/^listening$/iu.test(cells[3]!)) continue;
    const port = addressPort(cells[1]!);
    if (port === null) continue;
    const rawPid = Number(cells[4]);
    const pid = Number.isSafeInteger(rawPid) && rawPid > 0 ? rawPid : null;
    const prior = byPort.get(port);
    if (!prior || (prior.pid === null && pid !== null)) byPort.set(port, {
      port, pid, command: '', url: `http://localhost:${port}/`,
    });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

export function selectDevServers(listeners: DevServer[], ownPorts: readonly number[], ownPid: number): DevServer[] {
  return listeners.filter((item) => !IGNORED.has(item.port) && !ownPorts.includes(item.port)
    && item.pid !== ownPid);
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 2500, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

export function createDevServerScanner(options: { run?: Run; platform?: NodeJS.Platform;
  ownPorts?: () => number[]; ownPid?: number } = {}) {
  const run = options.run ?? runCommand;
  const platform = options.platform ?? process.platform;
  const ownPorts = options.ownPorts ?? (() => [ENV.port]);
  const ownPid = options.ownPid ?? process.pid;
  let cached: { at: number; servers: DevServer[] } | null = null;
  return async (): Promise<{ ok: true; servers: DevServer[] } | { ok: false; reason: string }> => {
    if (cached && Date.now() - cached.at < 3000) return { ok: true, servers: cached.servers };
    if (platform !== 'win32') return { ok: false, reason: 'no-listener-source' };
    let output: string;
    try { output = await run('netstat', ['-ano', '-p', 'TCP']); }
    catch { return { ok: false, reason: 'netstat-unavailable' }; }
    if (!output.trim()) return { ok: false, reason: 'netstat-unavailable' };
    const ports = ownPorts();
    const servers = selectDevServers(parseNetstatListeners(output), ports, ownPid);
    cached = { at: Date.now(), servers };
    return { ok: true, servers };
  };
}

function attachedHarnessPort(): number {
  try {
    const url = new URL(ENV.nnaHarnessUrl);
    return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : 0;
  } catch { return 0; }
}

export function registerDevServerRoutes(app: Hono,
  scanner = createDevServerScanner({ ownPorts: () => [ENV.port, attachedHarnessPort()] })): void {
  app.get('/api/dev-servers', async (c) => {
    const result = await scanner();
    return result.ok ? c.json({ servers: result.servers })
      : c.json({ error: 'Port discovery is unavailable', reason: result.reason }, 503);
  });
}
