// SPDX-License-Identifier: Apache-2.0
/**
 * RuntimeAPIs — the instance-adapter contract (doc 01 §3.3).
 * P0 ships the boot-critical members fully typed; git/files bodies land with
 * docs 06/07 and grow in place. Terminal is typed exactly (§3.4) and ships as
 * a throwing stub until doc 07.
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

// ── files (routes arrive with doc 03/06) ─────────────────────────────────────
export interface FilesApi {
  listDirectory(path: string): Promise<unknown>;
  search(options: unknown): Promise<unknown>;
  createDirectory(path: string): Promise<unknown>;
}

// ── git (~60 methods; exact contract doc 06) ─────────────────────────────────
export interface GitApi {
  [method: string]: unknown;
}

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
  push?: unknown;
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
