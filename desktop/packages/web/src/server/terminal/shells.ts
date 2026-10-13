// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal shells (doc 07 section 4.4): id allowlist (auto bash zsh sh fish
 * pwsh powershell cmd dash ksh nu), discovery per platform (documented
 * candidate lists), auto fallback chains, login-arg table, and the
 * command-mode argv tables. An explicit unavailable preference fails
 * create/restart loudly (never silently substituted). NND reads
 * NOTNATIVE_TERMINAL_SHELL (documented OPENCHAMBER_TERMINAL_SHELL rename).
 */
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join as joinPath } from 'node:path';
import type { TerminalShellId, TerminalShellOption } from './types.ts';

export const SHELL_IDS: TerminalShellId[] = ['auto', 'bash', 'zsh', 'sh', 'fish', 'pwsh', 'powershell', 'cmd', 'dash', 'ksh', 'nu'];
export const SHELL_OVERRIDE_ENV = 'NOTNATIVE_TERMINAL_SHELL'; // documented OPENCHAMBER_TERMINAL_SHELL rename

const LOGIN_ARGS: Partial<Record<Exclude<TerminalShellId, 'auto'>, { arg: string; windowsUnsupported: boolean }>> = {
  bash: { arg: '-l', windowsUnsupported: false },
  zsh: { arg: '-l', windowsUnsupported: false },
  ksh: { arg: '-l', windowsUnsupported: false },
  fish: { arg: '--login', windowsUnsupported: false },
  nu: { arg: '--login', windowsUnsupported: false },
  pwsh: { arg: '-Login', windowsUnsupported: true }, // pwsh on Windows: login not supported
  // powershell, cmd, sh, dash: login request errors
};

const ID_BY_EXEC: Record<string, Exclude<TerminalShellId, 'auto'>> = {
  bash: 'bash', zsh: 'zsh', sh: 'sh', fish: 'fish', pwsh: 'pwsh', powershell: 'powershell', cmd: 'cmd', dash: 'dash', ksh: 'ksh', nu: 'nu',
};

const EXECUTABLES_BY_ID: Partial<Record<Exclude<TerminalShellId, 'auto'>, string[]>> = {
  bash: ['bash', 'bash.exe'],
  zsh: ['zsh'],
  sh: ['sh', 'sh.exe'],
  fish: ['fish'],
  pwsh: ['pwsh.exe', 'pwsh'],
  powershell: ['powershell.exe'],
  cmd: ['cmd.exe', 'cmd'],
  dash: ['dash'],
  ksh: ['ksh'],
  nu: ['nu', 'nu.exe'],
};

const SUPPORTS_LOGIN: Partial<Record<Exclude<TerminalShellId, 'auto'>, boolean>> = {
  bash: true, zsh: true, ksh: true, fish: true, nu: true, pwsh: false, powershell: false, cmd: false, sh: false, dash: false,
};

/** section 4.4: normalize + validate the preference (lowercase/trim; only
 * allowlist ids or auto; anything else rejected). */
export function normalizeShellPreference(input: string | undefined): TerminalShellId | null {
  if (input === undefined || input === null || input === '') return 'auto';
  const lowered = input.trim().toLowerCase();
  return (SHELL_IDS as string[]).includes(lowered) ? lowered as TerminalShellId : null;
}

export function loginRequestSupported(id: Exclude<TerminalShellId, 'auto'>, isWindows: boolean): boolean {
  const entry = LOGIN_ARGS[id];
  if (entry === undefined) return false; // powershell/cmd/sh/dash
  if (isWindows && entry.windowsUnsupported) return false;
  return true;
}

export function loginArg(id: Exclude<TerminalShellId, 'auto'>): string | null {
  return LOGIN_ARGS[id]?.arg ?? null;
}

/** Interactive launch = executable + login args only. */
export function buildInteractiveArgv(executable: string, id: Exclude<TerminalShellId, 'auto'>, loginShell: boolean): string[] {
  const args = [executable];
  if (loginShell) {
    const arg = loginArg(id);
    if (arg !== null) args.push(arg);
  }
  return args;
}

/** Command-mode argv launches so the PTY exits when the command exits. */
export function buildCommandArgv(executable: string, id: Exclude<TerminalShellId, 'auto'>, loginShell: boolean, command: string): string[] {
  const args = buildInteractiveArgv(executable, id, loginShell && loginArg(id) !== null);
  if (id === 'nu') return [...args, '-c', command];
  if (id === 'pwsh' || id === 'powershell') return [...args, '-Command', command];
  if (id === 'cmd') return [...args, '/d', '/s', '/c', command];
  return [...args, '-i', '-c', command];
}

/** Discovery per section 4.4 (Windows column + generic PATH name search).
 * Candidates are deduped by executable; entries keep their allowlist id. */
export function discoverShells(): TerminalShellOption[] {
  const seen = new Set<string>();
  const options: TerminalShellOption[] = [];
  for (const executable of candidateExecutables()) {
    const resolved = resolveExecutable(executable);
    if (resolved === null || seen.has(resolved.toLowerCase())) continue;
    seen.add(resolved.toLowerCase());
    const id = idOf(resolved);
    if (id === null) continue;
    options.push({ id, name: displayName(id, resolved), supportsLogin: SUPPORTS_LOGIN[id] === true });
  }
  return options;
}

/** Auto resolution for spawning: first default-chain hit; null = unavailable
 * (explicit ids that are unavailable FAIL create - never substitute). */
export function resolveAutoShell(): { executable: string; id: Exclude<TerminalShellId, 'auto'> } | null {
  for (const executable of candidateExecutables()) {
    const resolved = resolveExecutable(executable);
    if (resolved === null) continue;
    const id = idOf(resolved);
    if (id === null) continue;
    return { executable: resolved, id };
  }
  return null;
}

export function resolveExplicitShell(id: Exclude<TerminalShellId, 'auto'>): { executable: string; id: Exclude<TerminalShellId, 'auto'> } | null {
  for (const name of EXECUTABLES_BY_ID[id] ?? []) {
    const resolved = resolveExecutable(name);
    if (resolved !== null) return { executable: resolved, id };
  }
  return null;
}

function candidateExecutables(): string[] {
  const isWindows = process.platform === 'win32';
  const candidates = [
    process.env[SHELL_OVERRIDE_ENV],
    process.env.SHELL,
    isWindows ? process.env.ComSpec : undefined,
    isWindows ? joinPath(process.env.SystemRoot ?? 'C:\\WINDOWS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : undefined,
    'pwsh.exe', 'powershell.exe', 'cmd.exe',
  ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  if (!isWindows) {
    for (const entry of etcShellsEntries()) candidates.push(entry); // documented etc/shells breadth
    candidates.push('/bin/zsh', '/bin/bash', '/bin/sh');
    for (const name of ['zsh', 'bash', 'sh']) candidates.push(name);
  }
  return candidates;
}

function resolveExecutable(candidate: string): string | null {
  if (candidate.includes('/') || candidate.includes('\\') || candidate.includes(':')) {
    return existsSync(candidate) ? candidate : null;
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    const full = joinPath(dir, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

function idOf(executable: string): Exclude<TerminalShellId, 'auto'> | null {
  const base = executable.split(/[\\/]/u).pop()!.toLowerCase().replace(/\.(exe|cmd)$/u, '');
  return ID_BY_EXEC[base] ?? null;
}

function displayName(id: Exclude<TerminalShellId, 'auto'>, executable: string): string {
  const base = executable.split(/[\\/]/u).pop() ?? id;
  return base;
}

/** Login-shell PATH probe: v1 keeps the host PATH (E-07 registered). */
export function buildAugmentedPath(): string {
  return process.env.PATH ?? '';
}

/** section 4.3 env construction: base server env, augmented PATH, TERM set,
 * host-private plumbing deleted. */
export function buildPtyEnv(dark: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['NODE_CHANNEL_FD', 'BASH_XTRACEFD', 'BASH_ENV', 'ENV', 'ELECTRON_RUN_AS_NODE', 'ARGV0']) {
    delete env[key];
  }
  env.PATH = buildAugmentedPath();
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.COLORFGBG = dark ? '15;0' : '0;15';
  return env;
}

/** POSIX launch wrapper (section 4.3): env -u strips the host plumbing the
 * JS-side delete cannot reach (OS native environ); no-op elsewhere. */
export function resolvePosixPtyLaunch(executable: string, args: string[]): { executable: string; args: string[] } {
  const envBinary = ['/usr/bin/env', '/bin/env'].find((candidate) => existsSync(candidate));
  if (process.platform === 'win32' || envBinary === undefined) return { executable, args };
  const removals = ['ARGV0', 'NODE_CHANNEL_FD'].flatMap((key) => ['-u', key]);
  return { executable: envBinary, args: [...removals, executable, ...args] };
}

/** etc/shells entries for discovery breadth (documented order row). */
export function etcShellsEntries(): string[] {
  try {
    return readFileSync('/etc/shells', 'utf8').split('\n').map((row) => row.trim()).filter((row) => row.length > 0 && !row.startsWith('#'));
  } catch {
    return [];
  }
}
