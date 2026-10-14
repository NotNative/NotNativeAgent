// SPDX-License-Identifier: Apache-2.0
/** Shared P9-6b orchestration contracts, constants, and result helpers. */
import type { AgentInfo, CommandInfo, Provider } from '../../../../ui/src/lib/nnd/types.ts';
import type { ObjectiveStore } from '../goals/objective-store.ts';
import type { GoalPayload } from '../goals/goal-payload.ts';
import type { DistillPort } from '../goals/goal-distill.ts';
import type { ProjectKnowledgeProvider } from '../queue/queue-hooks.ts';

export type RecordObject = Record<string, unknown>;

export const SESSION_BODY_MAX_CHARS = 1_000_000;
export const BUDGET_MIN = 1_000;
export const BUDGET_MAX = 100_000_000;
export const WORKTREE_WAIT_MS = 60_000;

export interface OrchestratorSettings {
  defaultAgent?: string;
  defaultModel?: string;
  defaultVariant?: string;
}

export interface WorktreeRequest {
  mode?: string;
  name?: string;
  branchName?: string;
  startRef?: string;
  setUpstream?: boolean;
}

export interface CreatedWorktree { directory: string; branch: string | null }

export interface SessionHarnessPorts {
  providers: (directory: string) => Promise<readonly Provider[]>;
  agents: (directory: string) => Promise<readonly AgentInfo[]>;
  config: (directory: string) => Promise<RecordObject>;
  commands: (directory: string) => Promise<readonly CommandInfo[]>;
  createSession: (directory: string, title: string,
    route?: { providerID: string; model: string }) => Promise<RecordObject>;
  readSession: (sessionId: string, directory: string) => Promise<RecordObject>;
  readMessages: (sessionId: string, directory: string, limit: number) => Promise<unknown[]>;
  sendPrompt: (sessionId: string, directory: string, body: RecordObject) => Promise<{ ok: boolean; status: number }>;
  sendCommand: (sessionId: string, directory: string, body: RecordObject) => Promise<{ ok: boolean; status: number }>;
  forkSession: (sessionId: string, directory: string, body: RecordObject) => Promise<RecordObject>;
  archiveSession: (sessionId: string, directory: string, archivedAt: number) => Promise<boolean>;
  writeGoal: (sessionId: string, directory: string, body: {
    goal: GoalPayload; expected_id: string | null; expected_revision: number;
  }) => Promise<boolean>;
  patchSession: (sessionId: string, directory: string, body: RecordObject) => Promise<RecordObject>;
  projects?: () => Promise<unknown[]>;
}

export interface OrchestratorDeps {
  harness: SessionHarnessPorts;
  expand?: (text: string, directory: string) => Promise<string> | string;
  knowledge?: ProjectKnowledgeProvider;
  projectDirectory?: (projectId: string) => Promise<string | null> | string | null;
  directoryExists?: (directory: string) => Promise<boolean> | boolean;
  settingsFor?: (directory: string) => OrchestratorSettings;
  distill?: DistillPort;
  objectiveStore?: Pick<ObjectiveStore, 'write'>;
  createWorktree?: (directory: string, requested: WorktreeRequest) => Promise<CreatedWorktree>;
  waitForWorktree?: (directory: string, timeoutMs?: number) => Promise<boolean>;
  waitForHarnessReady?: (directory?: string) => Promise<boolean>;
  emit?: (event: RecordObject) => void;
  waitForPromptLanded?: (sessionId: string, directory: string, baseline: ReadonlySet<string>) => Promise<boolean>;
  now?: () => number;
}

export interface ScopeInput { directory?: string; projectId?: string }
export interface SelectionInput { model?: string | RecordObject; agent?: unknown; variant?: unknown }

export interface CreateInput {
  scope: ScopeInput;
  title?: string;
  prompt?: string;
  selection?: SelectionInput;
  goal?: boolean;
  goalTokenBudget?: number;
  worktree?: WorktreeRequest;
  /** F9 durable creation identity: a retry with the same id replays the
   *  original outcome; a changed payload under the same id is rejected. */
  operationId?: string;
}

export interface RunInput {
  scope: ScopeInput;
  prompt: string;
  selection: SelectionInput;
  goal?: boolean;
  goalTokenBudget?: number;
  boundary?: string;
}

export interface DispatchContext {
  sessionId: string;
  directory: string;
  prompt: string;
  goal: boolean;
  goalTokenBudget?: number;
  goalConfigured?: boolean;
}

export type SessionOrchestrationError = {
  status: 400 | 404 | 409 | 500 | 502 | 503;
  error: string;
  partial?: boolean;
  partialAction?: 'worktree-created' | 'goal-configured' | 'fork-created';
  sessionId?: string;
  directory?: string;
};

export type SessionOrchestrationResponse =
  | { ok: true; body: RecordObject }
  | { ok: false; failure: SessionOrchestrationError };

export type ServiceOutcome = Promise<SessionOrchestrationResponse>;
export type ResolvedSelection = { providerID: string; modelID: string; variant?: string; agent: string };

export function fail(status: SessionOrchestrationError['status'], error: string,
  context: Partial<Omit<SessionOrchestrationError, 'status' | 'error'>> = {},
): SessionOrchestrationResponse {
  return { ok: false, failure: { status, error, ...context } };
}

export function ok(body: RecordObject): SessionOrchestrationResponse { return { ok: true, body }; }

export function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'object' && value !== null) {
    const message = (value as RecordObject).message;
    return typeof message === 'string' && message !== '' ? message : 'orchestrator action failed';
  }
  return String(value);
}

export function asRecord(value: unknown): RecordObject | null {
  return value === null || typeof value !== 'object' || Array.isArray(value) ? null : value as RecordObject;
}

export function textOf(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
