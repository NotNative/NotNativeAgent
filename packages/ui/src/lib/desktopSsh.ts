// SPDX-License-Identifier: Apache-2.0
/**
 * Desktop SSH instance contract (doc 08 sections 7.2-7.3). The UI owns
 * configuration editing, the import view, phase rendering, retry
 * affordances, and the store machinery; durability/IPC/spawning and every
 * master-connection internal are doc 09 (P12). Every operation cross the
 * bridge only - the UI never spawns ssh itself (S7.4).
 */

export type SshRemoteBind = '127.0.0.1' | '0.0.0.0';
export type SshLocalBind = '127.0.0.1' | 'localhost' | '0.0.0.0';
export type SshRemoteMode = 'managed' | 'external';
export type SshInstallMethod = 'auto' | 'npm' | 'bun';
export type SshForwardKind = 'local' | 'remote' | 'dynamic';
export type SecretStoreChoice = 'never' | 'settings';

export interface StoredSecret {
  enabled: boolean;
  value?: string;
  store: SecretStoreChoice;
}

export interface PortForward {
  id: string;
  enabled: boolean;
  type: SshForwardKind;
  localHost?: string;
  localPort?: number;
  remoteHost?: string;
  remotePort?: number;
}

export interface DesktopSshInstance {
  id: string;
  nickname?: string;
  sshCommand: string;
  sshParsed: { destination: string | null; args: string[] };
  connectionTimeoutSec: number;
  remoteOpenchamber: {
    mode: SshRemoteMode;
    keepRunning: boolean;
    preferredPort?: number;
    bindHost: SshRemoteBind;
    installMethod: SshInstallMethod;
    uploadBundleOverSsh: boolean;
  };
  localForward: {
    preferredLocalPort?: number;
    bindHost: SshLocalBind;
  };
  auth: {
    sshPassword?: StoredSecret;
    openchamberPassword?: StoredSecret;
  };
  portForwards: PortForward[];
}

export const SSH_PHASES = [
  'idle', 'config_resolved', 'auth_check', 'remote_installing', 'master_connecting', 'remote_probe',
  'installing', 'updating', 'server_detecting', 'server_starting', 'forwarding',
  'ready', 'degraded', 'error',
] as const;

export type SshPhase = (typeof SSH_PHASES)[number];

export interface DesktopSshInstanceStatus {
  id: string;
  phase: SshPhase;
  detail?: string;
  localUrl?: string;
  localPort?: number;
  remotePort?: number;
  startedByUs: boolean;
  retryAttempt: number;
  requiresUserAction: boolean;
  updatedAtMs: number;
}

export const SSH_DEFAULT_TIMEOUT_SEC = 30;
const SSH_TIMEOUT_RANGE = { min: 5, max: 600 };

/** S7.2: `sshCommand` parses into destination + args. The program word
 *  (ssh/ssh.exe/absolute path) is excluded; quoted tokens stay joined;
 *  `-p 2222` style value flags consume their next token; the destination is
 *  the LAST positional token. */
export function parseSshCommand(command: string): { destination: string | null; args: string[] } {
  const tokens = tokenizeSshCommand(command);
  const program = tokens[0];
  const programName = program === undefined ? '' : program.split(/[\\/]/u).pop() ?? '';
  if (programName !== '' && /^ssh(\.exe)?$/iu.test(programName)) {
    tokens.shift();
  }
  const positionals: string[] = [];
  const args: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) break;
    if (isValueFlag(token) && index + 1 < tokens.length) {
      const value = tokens[index + 1];
      args.push(token, value ?? '');
      index += 1;
      continue;
    }
    if (token.startsWith('-')) {
      args.push(token);
      continue;
    }
    positionals.push(token);
  }
  const destination = positionals.length > 0 ? positionals[positionals.length - 1] ?? null : null;
  return { destination, args };
}

// Real-ssh value options. `-q` is deliberately absent: it is quiet-mode
// boolean, so consuming its neighbour would swallow the destination
// (`ssh -q host` parses wrong). Attached values (-p465) ride as boolean
// tokens; destination = last positional is unaffected (E-08-62).
const VALUE_FLAGS = new Set(['-p', '-P', '-l', '-b', '-c', '-F', '-i', '-I', '-J', '-m', '-o', '-O', '-s', '-w', '-D', '-L', '-R']);

function isValueFlag(token: string): boolean {
  return token.startsWith('-') && !token.includes('=') && VALUE_FLAGS.has(token);
}

function tokenizeSshCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of command.trim()) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (started || current !== '') tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (current !== '' || quote !== null) tokens.push(current);
  return tokens;
}

function isBind(value: unknown, choices: readonly string[]): boolean {
  return typeof value === 'string' && (choices as readonly string[]).includes(value);
}

function storedSecret(input: unknown): StoredSecret {
  const shaped = (input ?? {}) as Record<string, unknown>;
  const enabled = shaped.enabled === true;
  const store: SecretStoreChoice = shaped.store === 'settings' ? 'settings' : 'never';
  const secret: StoredSecret = { enabled, store };
  if (typeof shaped.value === 'string' && shaped.value !== '') secret.value = shaped.value;
  return secret;
}

/** S7.2 strict normalizer: an unusable input answers null rather than a
 *  half-shaped record; every defaulted group is honest about its defaults. */
export function normalizeSshInstance(input: unknown): DesktopSshInstance | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const shape = input as Record<string, unknown>;
  const id = typeof shape.id === 'string' && shape.id.trim() !== '' ? shape.id : null;
  const sshCommand = typeof shape.sshCommand === 'string' && shape.sshCommand.trim() !== '' ? shape.sshCommand.trim() : null;
  if (id === null || sshCommand === null) return null;
  const remote = (shape.remoteOpenchamber ?? {}) as Record<string, unknown>;
  const local = (shape.localForward ?? {}) as Record<string, unknown>;
  const auth = (shape.auth ?? {}) as Record<string, unknown>;
  const timeout = typeof shape.connectionTimeoutSec === 'number' && Number.isFinite(shape.connectionTimeoutSec)
    ? Math.min(SSH_TIMEOUT_RANGE.max, Math.max(SSH_TIMEOUT_RANGE.min, Math.round(shape.connectionTimeoutSec)))
    : SSH_DEFAULT_TIMEOUT_SEC;
  const instance: DesktopSshInstance = {
    id,
    sshCommand,
    sshParsed: parseSshCommand(sshCommand),
    connectionTimeoutSec: timeout,
    remoteOpenchamber: {
      mode: remote.mode === 'managed' ? 'managed' : 'external',
      keepRunning: remote.keepRunning === true,
      ...(typeof remote.preferredPort === 'number' && remote.preferredPort >= 1 && remote.preferredPort <= 65_535
        ? { preferredPort: remote.preferredPort }
        : {}),
      bindHost: isBind(remote.bindHost, ['127.0.0.1', '0.0.0.0'] as const) ? remote.bindHost as SshRemoteBind : '127.0.0.1',
      installMethod: isBind(remote.installMethod, ['auto', 'npm', 'bun'] as const) ? remote.installMethod as SshInstallMethod : 'auto',
      uploadBundleOverSsh: remote.uploadBundleOverSsh === true,
    },
    localForward: {
      ...(typeof local.preferredLocalPort === 'number' && local.preferredLocalPort >= 1 && local.preferredLocalPort <= 65_535
        ? { preferredLocalPort: local.preferredLocalPort }
        : {}),
      bindHost: isBind(local.bindHost, ['127.0.0.1', 'localhost', '0.0.0.0'] as const) ? local.bindHost as SshLocalBind : '127.0.0.1',
    },
    auth: {
      ...(shape.auth !== undefined ? { sshPassword: storedSecret(auth.sshPassword) } : {}),
      ...(shape.auth !== undefined ? { openchamberPassword: storedSecret(auth.openchamberPassword) } : {}),
    },
    portForwards: normalizeForwards(shape.portForwards),
  };
  if (typeof shape.nickname === 'string' && shape.nickname.trim() !== '') instance.nickname = shape.nickname.trim();
  return instance;
}

function normalizeForwards(input: unknown): PortForward[] {
  if (!Array.isArray(input)) return [];
  const out: PortForward[] = [];
  for (const raw of input.slice(0, 64)) {
    if (raw === null || typeof raw !== 'object') continue;
    const shape = raw as Record<string, unknown>;
    const kind = isBind(shape.type, ['local', 'remote', 'dynamic'] as const) ? shape.type as SshForwardKind : null;
    if (kind === null) continue;
    const forward: PortForward = {
      id: typeof shape.id === 'string' && shape.id !== '' ? shape.id : forwardId(),
      enabled: shape.enabled === true,
      type: kind,
    };
    if (typeof shape.localHost === 'string' && shape.localHost.trim() !== '') forward.localHost = shape.localHost.trim();
    if (typeof shape.localPort === 'number' && shape.localPort >= 1 && shape.localPort <= 65_535) forward.localPort = shape.localPort;
    if (typeof shape.remoteHost === 'string' && shape.remoteHost.trim() !== '') forward.remoteHost = shape.remoteHost.trim();
    if (typeof shape.remotePort === 'number' && shape.remotePort >= 1 && shape.remotePort <= 65_535) forward.remotePort = shape.remotePort;
    out.push(forward);
  }
  return out;
}

let forwardCounter = 0;

/** Non-crypto row id: uniqueness matters, entropy does not. */
export function forwardId(): string {
  forwardCounter = (forwardCounter + 1) % 4_096;
  return `fwd_${Date.now().toString(36)}_${forwardCounter.toString(36)}`;
}

/** S7.3 remote-LAN rule: `0.0.0.0` exposes the remote UI to that machine's
 *  network, so its OpenChamber password must be present (or configured). */
export function remoteLanNeedsPassword(instance: DesktopSshInstance): boolean {
  if (instance.remoteOpenchamber.bindHost !== '0.0.0.0') return false;
  const password = instance.auth.openchamberPassword;
  const armed = password?.enabled === true && typeof password.value === 'string' && password.value !== '';
  return !armed;
}

/** Deploy confirmation rule (RemoteInstancesPage rules): a secret chosen to
 *  live in the settings store sits in plaintext on the remote - confirm. */
export function needsSecretStorageConfirm(instance: DesktopSshInstance): boolean {
  return storedSecret(instance.auth.sshPassword).store === 'settings' || storedSecret(instance.auth.openchamberPassword).store === 'settings';
}

/** S7.4: an ssh instance plugs in as just another runtime endpoint keyed
 *  from the instance id. Doc 01's key vocabulary ('local', 'host:<id>') has
 *  no ssh chip, so the `ssh:<id>` scheme is ours and prefix-collision-free
 *  against paired-host ids (E-08-61). */
export function sshRuntimeKey(instanceId: string): string {
  return `ssh:${instanceId}`;
}

const RANDOM_PORT_MIN = 49_152;
const RANDOM_PORT_MAX = 61_000;

/** Port-in-use retry helper: a fresh random port that dodges the busy set. */
export function suggestRandomLocalPort(busy: readonly number[], rng: () => number = Math.random): number {
  const taken = new Set(busy);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const candidate = RANDOM_PORT_MIN + Math.floor(rng() * (RANDOM_PORT_MAX - RANDOM_PORT_MIN));
    if (!taken.has(candidate)) return candidate;
  }
  for (let candidate = RANDOM_PORT_MIN; candidate <= RANDOM_PORT_MAX; candidate += 1) {
    if (!taken.has(candidate)) return candidate;
  }
  return RANDOM_PORT_MAX;
}
