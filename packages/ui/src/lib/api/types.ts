// SPDX-License-Identifier: Apache-2.0
import type { GitApi } from '../git/types.ts';
import type { PushApi } from './push-types.ts';
/**
 * RuntimeAPIs — the instance-adapter contract (doc 01 §3.3).
 * P0 ships the boot-critical members fully typed; Git grows with doc 06.
 * Required and optional Files methods are typed at the shared adapter seam.
 * Terminal is typed exactly (§3.4) and ships as a throwing stub until doc 07.
 */

export interface RuntimeDescriptor {
  platform: 'web' | 'desktop' | 'vscode';
  isDesktop: boolean;
  isVSCode: boolean;
  label?: string;
}

// ── Terminal (doc 01 §3.4; PTY semantics doc 07) ────────────────────────────
export type TerminalStreamEvent =
  | {
      type: 'snapshot';
      sequence?: number;
      data?: string;
      replayData?: string;
      cols?: number;
      rows?: number;
      status?: 'running' | 'exited' | 'error';
      exitCode?: number;
      signal?: number | null;
      attempt?: number;
      maxAttempts?: number;
      runtime?: 'node' | 'bun';
      ptyBackend?: string;
      mode?: 'interactive' | 'command';
      purpose?: { type: 'terminal' } | { type: 'project-action'; actionId: string; executionId: string };
    }
  | { type: 'data'; sequence?: number; data?: string }
  | { type: 'exit'; exitCode?: number; signal?: number | null; status?: 'running' | 'exited' | 'error' }
  | { type: 'reconnecting'; attempt?: number; maxAttempts?: number };

export interface TerminalSubscription {
  close(): void;
}

export interface TerminalApi {
  createSession(options: {
    cwd: string;
    sessionId?: string;
    cols?: number;
    rows?: number;
    themeMode?: 'light' | 'dark';
    terminalBackground?: string;
    terminalForeground?: string;
    shell?:
      | 'auto'
      | 'bash'
      | 'zsh'
      | 'sh'
      | 'fish'
      | 'pwsh'
      | 'powershell'
      | 'cmd'
      | 'dash'
      | 'ksh'
      | 'nu';
    loginShell?: boolean;
    purpose?: { type: 'terminal' } | { type: 'project-action'; actionId: string; executionId: string };
    mode?: 'interactive';
  } | { cwd: string; mode: 'command'; command: string }): Promise<{
    sessionId: string;
    cols: number;
    rows: number;
    status: 'running' | 'exited' | 'error';
    mode?: 'interactive' | 'command';
    purpose?: { type: 'terminal' } | { type: 'project-action'; actionId: string; executionId: string };
  }>;
  connect(
    sessionId: string,
    handlers: { onEvent: (event: TerminalStreamEvent) => void; onError?: (error: unknown) => void },
  ): TerminalSubscription;
  sendInput(sessionId: string, input: string): void | Promise<void>;
  resize(options: { sessionId: string; cols: number; rows: number }): void | Promise<void>;
  close?(sessionId: string): void | Promise<void>;
  listShells?(): Promise<Array<{ id: string; name: string }>>;
}

// ── files (scoped OpenChamber routes from doc 03/06) ─────────────────────────
export interface RuntimeFileEntry { name: string; path: string; isDirectory: boolean; isFile?: boolean }

export interface FilesApi {
  listDirectory(directory: string, path?: string, force?: boolean): Promise<RuntimeFileEntry[]>;
  search(directory: string, query: string, limit?: number): Promise<RuntimeFileEntry[]>;
  readFileStat(directory: string, path: string, optional?: boolean): Promise<RuntimeFileStat | null>;
  readFileText(directory: string, path: string, fresh?: boolean): Promise<string>;
  writeFileText(directory: string, path: string, content: string, expectedContent?: string): Promise<void>;
  rawAssetUrl(directory: string, path: string, download?: boolean): string;
  createDirectory(directory: string, path: string): Promise<void>;
  deleteEntry(directory: string, path: string): Promise<void>;
  renameEntry(directory: string, oldPath: string, newPath: string): Promise<void>;
}

export interface RuntimeFileStat { path: string; isFile: boolean; exists?: boolean; size: number; mtimeMs: number }

// ── git (scoped review operations from doc 06) ───────────────────────────────
export type { GitApi } from '../git/types.ts';

export interface PermissionsApi {
  requestDirectoryAccess(options: { path: string }): Promise<boolean>;
  startAccessingDirectory(path: string): Promise<void>;
  stopAccessingDirectory(path: string): Promise<void>;
}

export interface NotificationsApi {
  notifyAgentCompletion(payload?: {
    title?: string;
    body?: string;
    tag?: string;
    kind?: string;
    sessionId?: string;
    directory?: string;
    requireHidden?: boolean;
  }): Promise<boolean>;
  canNotify?(): boolean;
}

export interface SettingsApi {
  load(): Promise<{ settings: Record<string, unknown>; source: 'desktop' | 'web' }>;
  save(changes: Record<string, unknown>): Promise<Record<string, unknown>>;
  restartOpenCode?(): Promise<{ restarted: boolean }>;
}

export interface ToolsApi {
  getAvailableTools(): Promise<string[]>;
}

export interface RuntimeAPIs {
  runtime: RuntimeDescriptor;
  terminal: TerminalApi;
  git: GitApi;
  files: FilesApi;
  settings: SettingsApi;
  permissions: PermissionsApi;
  notifications: NotificationsApi;
  tools: ToolsApi;
  // optional adapters (doc 01): github/linear/push/diagnostics/clientAuth/editor/vscode/worktrees
  github?: unknown;
  linear?: unknown;
  push?: PushApi;
  diagnostics?: { downloadLogs(): Promise<{ fileName: string; content: string }> };
  clientAuth?: unknown;
  worktrees?: unknown;
}

// ── Desktop boot outcome (typed now, exercised in P12) ───────────────────────
export type DesktopBootOutcome =
  | { target: 'local'; status: 'ok'; localAvailable?: false }
  | { target: 'remote'; status: 'ok'; hostId: string; url: string; localAvailable?: false }
  | { target: null; status: 'not-configured'; localAvailable?: false }
  | { target: 'local'; status: 'unreachable'; localAvailable?: false }
  | { target: 'remote'; status: 'unreachable'; hostId: string; url: string }
  | { target: 'remote'; status: 'incompatible'; hostId: string; url: string }
  | { target: 'remote'; status: 'wrong-service'; hostId: string; url: string }
  | { target: 'remote'; status: 'missing'; hostId: string };
