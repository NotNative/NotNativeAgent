// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal session types (doc 07 section 4.1): id/cwd/dims/theme/shell/mode/
 * purpose/status/exit/sequence/history/lastActivity/backend per session.
 * Purpose ids are capped at 128 chars after trim; ids are client-provided
 * URLs or randomUUID, both capped at 128.
 */
export type TerminalMode = 'interactive' | 'command';

export type TerminalStatus = 'running' | 'exited' | 'error';

export type TerminalShellId = 'auto' | 'bash' | 'zsh' | 'sh' | 'fish' | 'pwsh' | 'powershell' | 'cmd' | 'dash' | 'ksh' | 'nu';

export type TerminalPurpose =
  | { type: 'terminal' }
  | { type: 'project-action'; actionId: string; executionId: string };

export interface TerminalShellOption { id: TerminalShellId; name: string; supportsLogin: boolean }

export interface TerminalServerSession {
  sessionId: string;
  cwd: string;
  status: TerminalStatus;
  createdAt: number;
  mode: TerminalMode;
  purpose: TerminalPurpose;
}

export interface CreateTerminalOptions {
  cwd: string;
  sessionId?: string;
  cols?: number;
  rows?: number;
  themeMode?: 'light' | 'dark';
  terminalBackground?: string;
  terminalForeground?: string;
  shell?: TerminalShellId;
  loginShell?: boolean;
  purpose?: TerminalPurpose;
  mode?: TerminalMode;
  command?: string;
}

export interface CreateTerminalResponse {
  sessionId: string;
  cols: number;
  rows: number;
  status: TerminalStatus;
  mode: TerminalMode;
  purpose: TerminalPurpose;
}

export interface TerminalAppearance {
  themeMode?: 'light' | 'dark';
  terminalBackground?: string;
  terminalForeground?: string;
}
