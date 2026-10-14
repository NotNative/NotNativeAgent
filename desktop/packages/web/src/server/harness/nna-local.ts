// SPDX-License-Identifier: Apache-2.0
/** Owns the local NNA integration child used by the packaged desktop default. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { harnessError, type HarnessAdapter } from './adapter.ts';
import { readNnaPrimaryWorkspaceId } from './nna-workspace-identity.ts';

const READY_LIMIT = 16 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const EARLY_EXIT_RETRY_DELAY_MS = 250;
// NNA creates base64url tokens.  Keep this ASCII-only at the readiness
// boundary so it is always safe to place in a Node HTTP header later.
const TOKEN = /^[A-Za-z0-9_-]{32,512}$/u;

export interface LocalNnaLaunchOptions {
  command: string;
  commandArguments?: string[];
  dataRoot?: string;
  /** Legacy caller hint; never used as session authority. */
  workspaceId?: string;
  fetch?: typeof fetch;
  browserCallback?: { url: string; token: string };
  agentToolCallback?: { url: string; token: string };
  startupTimeoutMs?: number;
  spawnChild?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcessWithoutNullStreams;
}

export interface NnaCommandResolutionOptions {
  command?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  readFile?: (path: string, encoding: 'utf8') => Promise<string>;
  access?: (path: string) => Promise<unknown>;
}

export interface ResolvedNnaCommand {
  command: string;
  arguments: string[];
  dataRoot?: string;
}

/** Resolves a co-installed Windows NNA without relying on the user's PATH. */
export async function resolveNnaCommand(options: NnaCommandResolutionOptions = {}): Promise<ResolvedNnaCommand> {
  const explicit = options.command?.trim();
  if (explicit) return { command: explicit, arguments: [] };
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { command: 'nna', arguments: [] };
  // Use the requested platform's path rules even in cross-platform tests. More
  // importantly, do not let a POSIX host misclassify a recorded Windows path.
  const platformPath = path.win32;
  const environment = options.environment ?? process.env;
  const localAppData = environment.LOCALAPPDATA ?? platformPath.join(options.homeDirectory ?? os.homedir(), 'AppData', 'Local');
  const descriptorPath = platformPath.join(localAppData, 'NotNativeAgent', 'install.json');
  try {
    const source = await (options.readFile ?? readFile)(descriptorPath, 'utf8');
    const descriptor = JSON.parse(source) as { product?: unknown; node?: unknown; install_root?: unknown; data_root?: unknown };
    if (descriptor.product !== 'NotNativeAgent' || typeof descriptor.node !== 'string' || !platformPath.isAbsolute(descriptor.node)
      || typeof descriptor.install_root !== 'string' || !platformPath.isAbsolute(descriptor.install_root)
      || typeof descriptor.data_root !== 'string' || !platformPath.isAbsolute(descriptor.data_root)) throw new Error('invalid');
    const cli = platformPath.join(descriptor.install_root, 'installed', 'src', 'cli.js');
    await (options.access ?? access)(descriptor.node);
    await (options.access ?? access)(cli);
    return { command: descriptor.node, arguments: [cli], dataRoot: descriptor.data_root };
  } catch {
    // A PATH binary remains a valid deployment path for portable/nonstandard installs.
    return { command: 'nna', arguments: [] };
  }
}

export interface LocalNnaHarness {
  endpoint: string;
  token: string;
  principal(): string;
  isRunning(): boolean;
  dispose(): void;
}

export interface ManagedLocalNnaHarness extends LocalNnaHarness {
  workspaceId(): string | null;
  ensurePrimaryWorkspaceId(): Promise<string | null>;
}

class EarlyNnaExitError extends Error {
  constructor(exitCode: number | null, diagnosticCode: string | null) {
    super(`NNA local harness exited before readiness${diagnosticCode ? ` (${diagnosticCode})`
      : exitCode === null ? '' : ` (exit ${exitCode})`}`);
  }
}

/** A child that dies before its first readiness frame gets one fresh launch.
 * Persistent configuration and registration failures still surface promptly. */
export async function startLocalNnaHarnessWithRetry(options: LocalNnaLaunchOptions): Promise<ManagedLocalNnaHarness> {
  try {
    return await startLocalNnaHarness(options);
  } catch (error) {
    if (!(error instanceof EarlyNnaExitError)) throw error;
    await new Promise((resolve) => setTimeout(resolve, EARLY_EXIT_RETRY_DELAY_MS));
    return startLocalNnaHarness(options);
  }
}

/** Starts NNA and accepts only its one-line, loopback readiness protocol. */
export function startLocalNnaHarness(options: LocalNnaLaunchOptions): Promise<ManagedLocalNnaHarness> {
  if (!options.command.trim()) return Promise.reject(new Error('NNA command is required'));
  if (options.browserCallback && !validBrowserCallback(options.browserCallback)) return Promise.reject(new Error('NNA browser callback is invalid'));
  if (options.agentToolCallback && !validAgentToolCallback(options.agentToolCallback)) {
    return Promise.reject(new Error('NNA agent tool callback is invalid'));
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnNnaChild(options);
  } catch {
    return Promise.reject(new Error('NNA local harness could not start'));
  }
  const lifetime = { running: true };
  // Premature exit, errors, and explicit disposal share this one state.
  child.once('exit', () => { lifetime.running = false; });
  // NNA CLI failures emit `nna: <code>`. Keep only that bounded identifier;
  // raw stderr may contain credentials and must never reach browser/log errors.
  const diagnostic = createNnaDiagnosticCapture();
  const stop = (): void => { if (lifetime.running) { lifetime.running = false; child.kill(); } };
  return awaitNnaReady(options, child, diagnostic, lifetime, stop);
}

function awaitNnaReady(options: LocalNnaLaunchOptions, child: ChildProcessWithoutNullStreams,
  diagnostic: ReturnType<typeof createNnaDiagnosticCapture>, lifetime: { running: boolean },
  stop: () => void): Promise<ManagedLocalNnaHarness> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => fail('NNA local harness did not become ready'), options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    let buffered = '';
    let settled = false;
    // Keep this listener after readiness too. ChildProcess may emit `error`
    // if a later kill fails; without a listener that would crash the host.
    const onError = (): void => { lifetime.running = false; fail('NNA local harness could not start'); };
    const onPrematureExit = (code: number | null): void => fail(new EarlyNnaExitError(code, diagnostic.finish()));
    const onData = (part: Buffer | string): void => {
      if (settled) return;
      buffered += String(part);
      if (Buffer.byteLength(buffered, 'utf8') > READY_LIMIT) return fail('NNA local harness readiness is too large');
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      const line = buffered.slice(0, newline).replace(/\r$/u, '');
      if (buffered.slice(newline + 1).trim()) return fail('NNA local harness emitted unexpected stdout');
      let ready: { endpoint?: unknown; token?: unknown; type?: unknown; protocol?: unknown; instance_id?: unknown };
      try { ready = JSON.parse(line) as typeof ready; } catch { return fail('NNA local harness readiness is invalid'); }
      if (ready.type !== 'ready' || ready.protocol !== '1.0' || typeof ready.instance_id !== 'string') return fail('NNA local harness readiness is incompatible');
      if (typeof ready.endpoint !== 'string' || !isLoopbackOrigin(ready.endpoint) || typeof ready.token !== 'string' || !TOKEN.test(ready.token)) return fail('NNA local harness readiness is unsafe');
      settled = true; clean();
      // NNA's stdout is protocol-only, but continue draining it after the
      // readiness frame so an accidental diagnostic cannot stall its child.
      child.stdout.resume();
      resolve(createResolvedHarness(ready.endpoint, ready.token, options.fetch, lifetime, stop));
    };
    const clean = (): void => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.stderr.off('data', diagnostic.write);
      child.stderr.resume();
      child.off('exit', onPrematureExit);
    };
    const fail = (reason: string | Error): void => {
      if (settled) return;
      settled = true; clean(); stop(); reject(typeof reason === 'string' ? new Error(reason) : reason);
    };
    child.on('error', onError);
    child.once('exit', onPrematureExit);
    child.stdout.on('data', onData);
    child.stderr.on('data', diagnostic.write);
  });
}

function createResolvedHarness(endpoint: string, token: string, requestFetch: typeof fetch | undefined,
  lifetime: { running: boolean }, stop: () => void): ManagedLocalNnaHarness {
  let primaryId: string | null = null;
  let pending: Promise<string | null> | null = null;
  const ensurePrimaryWorkspaceId = (): Promise<string | null> => {
    if (pending) return pending;
    pending = readNnaPrimaryWorkspaceId({ endpoint, token,
      principal: mintLocalPrincipal(null), fetch: requestFetch }).then(id => {
      primaryId = lifetime.running ? id : null;
      return primaryId;
    }).finally(() => { pending = null; });
    return pending;
  };
  return { endpoint, token, isRunning: () => lifetime.running, dispose: stop,
    principal: () => mintLocalPrincipal(primaryId), workspaceId: () => primaryId,
    ensurePrimaryWorkspaceId };
}

function spawnNnaChild(options: LocalNnaLaunchOptions): ChildProcessWithoutNullStreams {
  return (options.spawnChild ?? spawn)(options.command, [...(options.commandArguments ?? []), 'nnd', 'serve'], {
    stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
    env: localChildEnvironment(options),
  }) as ChildProcessWithoutNullStreams;
}

function createNnaDiagnosticCapture(): { write(part: Buffer | string): void; finish(): string | null } {
  let diagnosticCode: string | null = null;
  let stderrLine = '';
  const captureLine = (line: string): void => {
    const match = /^nna: ([a-z][a-z0-9_]{0,63})\r?$/u.exec(line);
    if (match) diagnosticCode = match[1]!;
  };
  return {
    write(part) {
      stderrLine += String(part);
      if (stderrLine.length > READY_LIMIT) stderrLine = stderrLine.slice(-READY_LIMIT);
      let newline = stderrLine.indexOf('\n');
      while (newline >= 0) {
        captureLine(stderrLine.slice(0, newline));
        stderrLine = stderrLine.slice(newline + 1);
        newline = stderrLine.indexOf('\n');
      }
    },
    finish() { captureLine(stderrLine); return diagnosticCode; },
  };
}

function localChildEnvironment(options: LocalNnaLaunchOptions): NodeJS.ProcessEnv {
  // Browser authority must be supplied by this launch, never inherited from
  // an operator shell or an earlier NND process with a different bridge.
  const environment: NodeJS.ProcessEnv = { ...process.env, ...(options.dataRoot ? { NNA_HOME: options.dataRoot } : {}) };
  delete environment.NNA_NND_BROWSER_URL;
  delete environment.NNA_NND_BROWSER_TOKEN;
  delete environment.NNA_NND_AGENT_TOOL_URL;
  delete environment.NNA_NND_AGENT_TOOL_TOKEN;
  if (options.browserCallback) {
    environment.NNA_NND_BROWSER_URL = options.browserCallback.url;
    environment.NNA_NND_BROWSER_TOKEN = options.browserCallback.token;
  }
  if (options.agentToolCallback) {
    environment.NNA_NND_AGENT_TOOL_URL = options.agentToolCallback.url;
    environment.NNA_NND_AGENT_TOOL_TOKEN = options.agentToolCallback.token;
  }
  return environment;
}

function validBrowserCallback(callback: { url: string; token: string }): boolean {
  return /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/api\/browser-control\/request$/u.test(callback.url) && TOKEN.test(callback.token);
}

function validAgentToolCallback(callback: { url: string; token: string }): boolean {
  return /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/api\/agent-tool\/callback$/u.test(callback.url) && TOKEN.test(callback.token);
}

/** Wrapper gives an explicit harness-down result rather than an empty projection. */
export function guardLocalNnaHarness(adapter: HarnessAdapter,
  harness: Pick<LocalNnaHarness, 'isRunning'> & Partial<Pick<ManagedLocalNnaHarness, 'workspaceId' | 'ensurePrimaryWorkspaceId'>>): HarnessAdapter {
  return { handle: async (request) => {
    if (!harness.isRunning()) return harnessError('NNA local harness stopped', 502, 'nnd_harness_stopped');
    const pathname = new URL(request.url).pathname;
    const creates = request.method === 'POST' && (pathname === '/api/session' || /^\/api\/session\/[^/]+\/fork$/u.test(pathname));
    if (!/^\/api\/session(?:\/|$)/u.test(pathname) || !harness.ensurePrimaryWorkspaceId) return adapter.handle(request);
    const id = creates || !harness.workspaceId?.() ? await harness.ensurePrimaryWorkspaceId() : harness.workspaceId();
    if (!id) return harnessError('NNA primary workspace identity is unavailable. Complete NNA setup and refresh the connection.', 503, 'nnd_workspace_identity_unavailable');
    const selected = creates ? await request.clone().json().catch(() => null) as Record<string, unknown> | null : null;
    const expectedId = typeof selected?.workspace_id === 'string' && /^ws_[a-f0-9]{24}$/u.test(selected.workspace_id)
      ? selected.workspace_id : id;
    const response = await adapter.handle(request);
    if (!creates || !response.ok) return response;
    const record = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
    if (!record || record.projectID !== expectedId) {
      const session = typeof record?.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(record.id) ? record.id : 'unknown';
      return harnessError(`NNA created session ${session} with a changed workspace identity. It remains recoverable in NNA; refresh before sending.`, 409, 'nnd_workspace_identity_mismatch');
    }
    return response;
  } };
}

function isLoopbackOrigin(value: string): boolean {
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { return false; }
  return endpoint.protocol === 'http:' && !endpoint.username && !endpoint.password
    && endpoint.pathname === '/' && !endpoint.search && !endpoint.hash
    // `localhost` is not a safe authority boundary: hosts/DNS configuration
    // can map it to a remote address. The NNA readiness protocol mandates
    // this exact numeric loopback host.
    && endpoint.hostname === '127.0.0.1' && endpoint.port !== '' && Number(endpoint.port) > 0;
}

function mintLocalPrincipal(workspaceId: string | null): string {
  const now = new Date().toISOString();
  return Buffer.from(JSON.stringify({
    subject_id: 'nnd-local-operator', platform_role: 'operator',
    // Mirrors NNA src/nnd-service-native.js nativeNndPrincipal PERMISSIONS
    // exactly (the installed native principal is the authority); drift here
    // starves the local harness of settings families the operator holds.
    permissions: ['integration.health', 'nnd.read', 'nnd.setup.read', 'nnd.setup.activate',
      'nnd.session.create', 'nnd.session.submit', 'nnd.session.update', 'nnd.session.abort', 'nnd.session.delete',
      'nnd.session.assist',
      'nnd.goal.manage', 'nnd.steer', 'nnd.walkthrough.generate', 'nnd.notification.generate',
      'nnd.configuration.read', 'nnd.configuration.manage', 'nnd.configuration.repair',
      'nnd.service.manage', 'nnd.update.manage', 'nnd.package.manage',
      'nnd.workspace.read', 'nnd.workspace.manage',
      'secret.read', 'secret.manage', 'secret.audit',
      'provider.read', 'provider.profile.write', 'provider.discover', 'provider.test', 'provider.route.manage', 'provider.route.activate'],
    workspace_ids: workspaceId ? [workspaceId] : [], group_ids: [], trace_id: randomUUID(), request_id: randomUUID(), issued_at: now,
  }), 'utf8').toString('base64url');
}
