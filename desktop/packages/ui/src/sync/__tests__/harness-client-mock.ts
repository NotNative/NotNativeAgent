// SPDX-License-Identifier: Apache-2.0
/**
 * Test support: controllable harness client. vi.mock of ../lib/nnd/client.ts
 * replaces the SDK facade singleton; tests register per-operation handlers and
 * read the recorded calls.
 */
import type { HarnessResult } from '../../lib/nnd/client.ts';

export interface MockCall {
  op: string;
  path: string;
  method: string;
  body: unknown;
  directory?: string;
  opts?: Record<string, unknown>;
}

export type HarnessHandler = (call: MockCall) => unknown | HarnessResult<unknown>;

const handlers = new Map<string, HarnessHandler>();
export const recorded: MockCall[] = [];

export function configureHarness(spec: Record<string, HarnessHandler>): void {
  handlers.clear();
  recorded.length = 0;
  for (const [op, handler] of Object.entries(spec)) handlers.set(op, handler);
}

export function callsFor(op: string): MockCall[] {
  return recorded.filter((call) => call.op === op);
}

function ok(data: unknown): HarnessResult<unknown> {
  return { data, response: { status: 200 } };
}

async function handle(op: string, path: string, method: string, body: unknown, directory?: string, opts?: Record<string, unknown>): Promise<HarnessResult<unknown>> {
  const call: MockCall = { op, path, method, body, directory, opts };
  recorded.push(call);
  const handler = handlers.get(op);
  if (!handler) return { error: `unmocked harness op: ${op}` };
  const value = await handler(call);
  if (value && typeof value === 'object' && ('error' in value || 'data' in value)) return value as HarnessResult<unknown>;
  return ok(value);
}

export const harnessClient: Record<string, unknown> & {
  [op: string]: (...args: never[]) => Promise<HarnessResult<unknown>>;
} = {
  globalHealth: () => handle('globalHealth', '/global/health', 'GET', undefined),
  probe: () => handle('probe', '/global/health', 'GET', undefined),
  getPath: (opts?: { directory?: string }) => handle('getPath', '/path', 'GET', undefined, opts?.directory),
  getProject: (opts?: { directory?: string }) => handle('getProject', '/project/current', 'GET', undefined, opts?.directory),
  listProjects: (opts?: { directory?: string }) => handle('listProjects', '/project', 'GET', undefined, opts?.directory),
  getMcp: (opts?: { directory?: string }) => handle('getMcp', '/mcp', 'GET', undefined, opts?.directory),
  getLsp: (opts?: { directory?: string }) => handle('getLsp', '/lsp', 'GET', undefined, opts?.directory),
  listSessions: (opts?: { roots?: boolean; archived?: boolean; limit?: number; directory?: string }) => handle('listSessions', '/session', 'GET', undefined, opts?.directory, opts as unknown as Record<string, unknown>),
  createSession: (body: unknown) => handle('createSession', '/session', 'POST', body, (body as { directory?: string }).directory),
  getSession: (id: string, opts?: { directory?: string }) => handle('getSession', `/session/${id}`, 'GET', undefined, opts?.directory, opts as unknown as Record<string, unknown>),
  updateSession: (id: string, patch: unknown, opts?: { directory?: string }) => handle('updateSession', `/session/${id}`, 'PATCH', patch, opts?.directory, opts as unknown as Record<string, unknown>),
  deleteSession: (id: string, opts?: { directory?: string }) => handle('deleteSession', `/session/${id}`, 'DELETE', undefined, opts?.directory, opts as unknown as Record<string, unknown>),
  forkSession: (id: string, messageID?: string, opts?: { directory?: string }) => handle('forkSession', `/session/${id}/fork`, 'POST', { messageID }, opts?.directory),
  abortSession: (id: string) => handle('abortSession', `/session/${id}/abort`, 'POST', {}),
  sessionStatus: (opts?: { directory?: string }) => handle('sessionStatus', '/session/status', 'GET', undefined, opts?.directory, opts as unknown as Record<string, unknown>),
  listMessages: (id: string, limit?: number, opts?: { directory?: string }) => handle('listMessages', `/session/${id}/message`, 'GET', undefined, opts?.directory, { ...(opts ?? {}), limit }),
  listMessagesPage: (id: string, opts?: { limit?: number; before?: string; directory?: string }) => handle('listMessagesPage', `/session/${id}/message`, 'GET', undefined, opts?.directory, opts as unknown as Record<string, unknown>),
  promptAsync: (id: string, body: unknown, opts?: { directory?: string }) => handle('promptAsync', `/session/${id}/prompt_async`, 'POST', body, opts?.directory, opts as unknown as Record<string, unknown>),
  uploadAttachment: (id: string, body: unknown, opts?: { directory?: string }) => handle('uploadAttachment', `/v1/nnd/sessions/${id}/attachments`, 'POST', body, opts?.directory, opts as unknown as Record<string, unknown>),
  sendCommand: (id: string, body: unknown, opts?: { directory?: string }) => handle('sendCommand', `/session/${id}/command`, 'POST', body, opts?.directory, opts as unknown as Record<string, unknown>),
  listPermissions: (opts?: { directory?: string }) => handle('listPermissions', '/permission', 'GET', undefined, opts?.directory, opts as unknown as Record<string, unknown>),
  replyToPermission: (id: string, reply: string, _message: string | undefined, opts?: { directory?: string }) => handle('replyToPermission', `/permission/${id}/reply`, 'POST', { reply }, opts?.directory, opts as unknown as Record<string, unknown>),
  listQuestions: (opts?: { directory?: string }) => handle('listQuestions', '/question', 'GET', undefined, opts?.directory, opts as unknown as Record<string, unknown>),
  replyToQuestion: (id: string, answers: string[][], opts?: { directory?: string }) => handle('replyToQuestion', `/question/${id}/reply`, 'POST', { answers }, opts?.directory, opts as unknown as Record<string, unknown>),
  rejectQuestion: (id: string, opts?: { directory?: string }) => handle('rejectQuestion', `/question/${id}/reject`, 'POST', {}, opts?.directory, opts as unknown as Record<string, unknown>),
  getConfig: (opts?: { directory?: string }) => handle('getConfig', '/config', 'GET', undefined, opts?.directory, opts as unknown as Record<string, unknown>),
  listProviders: (opts?: { directory?: string }) => handle('listProviders', '/provider', 'GET', undefined, opts?.directory, opts as unknown as Record<string, unknown>),
  listAgents: (opts?: { directory?: string }) => handle('listAgents', '/agent', 'GET', undefined, opts?.directory, opts as unknown as Record<string, unknown>),
  listCommands: (opts?: { directory?: string }) => handle('listCommands', '/command', 'GET', undefined, opts?.directory, opts as unknown as Record<string, unknown>),
  harnessEventUrl: () => 'http://harness.test/api/event',
  eventStreamUrl: async () => 'http://harness.test/api/event',
  childSteeringCapability: (id: string, opts?: { directory?: string }) => handle('childSteeringCapability', `/v1/nnd/sessions/${id}/capabilities`, 'GET', undefined, opts?.directory),
} as never;

/** HP-4 normalization (mirrors the production implementation). */
export function normalizeDirectory(dir: string): string {
  let value = dir.trim().replaceAll('\\', '/');
  value = value.replace(/^([a-z]):/, (_m, drive: string) => `${drive.toUpperCase()}:`);
  value = value.replace(/\/+$/, '');
  return value;
}

export function getHarnessDirectory(): string {
  return '';
}

let idCounter = 0;
export function ascendingId(prefix: string): string {
  const epochPart = (Date.now() * 4096 + ++idCounter).toString(36).padStart(11, '0');
  return `${prefix}_${epochPart}_testtail`;
}

export function setHarnessDirectory(): void {
  /* no-op in tests */
}

export const DEFAULT_BASE_URL = '/api';
export const DIRECTORY_HEADER = 'x-nnd-directory';
export const DIRECTORY_ENCODING_HEADER = 'x-nnd-directory-encoding';
export const HARNESS_REQUEST_TIMEOUT_MS = 30_000;
export const HARNESS_HEALTH_TIMEOUT_MS = 4_000;
export const EVENT_STREAM_PATH = '/api/event';
export const URL_TOKEN_PARAM = 'nn_url_token';
export const RUNTIME_CHANGED_MESSAGE = 'Message was not sent because the runtime changed.';
