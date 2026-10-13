// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal session record shapes (doc 07 sections 3.2/4.1/4.2): socket
 * adapter surface, per-session runtime record, in-flight create flight,
 * and the normalized validated create request. Type-only module (erasable
 * imports): runtime code and validation share the shapes without runtime
 * cycles. E-07-7: an exited id is replaceable-by-create; ValidatedCreate
 * carries the raw source options next to the normalized fields.
 */
import type { HistorySanitizer } from './history.ts';
import type { PtyEvents, PtyHandle } from './pty-backend.ts';
import type { ThemeQuestionAnswerer } from './theme-response.ts';
import type {
  CreateTerminalOptions, CreateTerminalResponse, TerminalMode,
  TerminalPurpose, TerminalShellId, TerminalStatus,
} from './types.ts';

export interface SocketLike {
  send(frame: Buffer): void;
  close(): void;
}

export interface TerminalResolvedAppearance {
  themeMode: 'light' | 'dark';
  terminalBackground?: string;
  terminalForeground?: string;
}

export interface SessionRecord {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  appearance: TerminalResolvedAppearance;
  mode: TerminalMode;
  command: string | null;
  purpose: TerminalPurpose;
  shellId: Exclude<TerminalShellId, 'auto'>;
  loginShell: boolean;
  status: TerminalStatus;
  exitCode?: number;
  signal?: number;
  sequence: number;
  history: string;
  lastActivity: number;
  pty: (PtyHandle & PtyEvents) | null;
  historyTrimmer: HistorySanitizer;
  themeAnswerer: ThemeQuestionAnswerer;
  attached: Set<SocketLike>;
  createdAt: number;
}

export interface PendingCreate {
  id: string;
  options: CreateTerminalOptions;
  cancelled: boolean;
  /** True once the flight resolved (recorded or rejected): no longer adoptable. */
  settled: boolean;
  promise: Promise<CreateTerminalResponse>;
}

export interface ValidatedCreate {
  id: string;
  /** Normalized cwd (trim, backslashes to slashes, trailing slash stripped). */
  cwd: string;
  cols: number;
  rows: number;
  mode: TerminalMode;
  command: string | null;
  purpose: TerminalPurpose;
  shell: TerminalShellId | undefined;
  loginShell: boolean;
  appearance: TerminalResolvedAppearance;
  /** Raw client options (spawn cwd stays the client-provided string). */
  source: CreateTerminalOptions;
}
