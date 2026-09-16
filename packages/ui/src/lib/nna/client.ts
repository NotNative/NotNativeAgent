/**
 * Harness SDK facade (doc 02 §3.3/§3.5a/App D). The only browser path to the
 * harness. Synthesizes the `{data,error,response}` result envelope client-side
 * (D12: harness wire bodies are bare payloads); never fabricates statuses.
 * Directory transport follows §3.5a: GET/HEAD carry `?directory=`, other
 * methods carry the percent-encoded header (+ `uri` marker when encoded).
 */
import { runtimeFetch } from '../runtime-fetch.ts';
import { getRealtimeBaseUrl } from '../runtime-url.ts';
import {
  DEFAULT_BASE_URL,
  DIRECTORY_ENCODING_HEADER,
  DIRECTORY_HEADER,
  HARNESS_HEALTH_TIMEOUT_MS,
  HARNESS_REQUEST_TIMEOUT_MS,
} from './constants.ts';
import type {
  AgentInfo,
  CommandInfo,
  HarnessConfig,
  HarnessPath,
  MessageEntry,
  PermissionRequest,
  PromptAsyncBody,
  Provider,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from './types.ts';

export type HarnessSession = Session;

export interface HarnessResult<T> {
  data?: T;
  error?: string;
  response?: { status: number };
}

const base = DEFAULT_BASE_URL.replace(/\/+$/, '');

/** HP-4 normalization: forward slashes, uppercased drive letter, trimmed. */
export function normalizeDirectory(dir: string): string {
  let value = dir.trim().replaceAll('\\', '/');
  value = value.replace(/^([a-z]):/, (_m, drive: string) => `${drive.toUpperCase()}:`);
  value = value.replace(/\/+$/, '');
  return value;
}

let currentDirectory = '';

export function setHarnessDirectory(directory: string): void {
  currentDirectory = normalizeDirectory(directory);
}

export function getHarnessDirectory(): string {
  return currentDirectory;
}

let idCounter = 0;
/** Monotonic client message ids (§11.14): the harness echoes them verbatim. */
export function ascendingId(prefix: string): string {
  const epochPart = (Date.now() * 4096 + ++idCounter).toString(36).padStart(11, '0');
  const tail = Math.random().toString(36).slice(2, 16).padEnd(14, '0');
  return `${prefix}_${epochPart}_${tail}`;
}

function applyDirectory(method: string, path: string, headers: Headers): string {
  if (!currentDirectory) return path;
  const isRead = method === 'GET' || method === 'HEAD';
  if (isRead) {
    const key = path.startsWith('/api/') ? 'location[directory]' : 'directory';
    const joiner = path.includes('?') ? '&' : '?';
    return `${path}${joiner}${key}=${encodeURIComponent(currentDirectory)}`;
  }
  if (/[^\x00-\xFF]/.test(currentDirectory)) {
    headers.set(DIRECTORY_HEADER, encodeURIComponent(currentDirectory));
    headers.set(DIRECTORY_ENCODING_HEADER, 'uri');
  } else {
    headers.set(DIRECTORY_HEADER, currentDirectory);
  }
  return path;
}

export class HarnessError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HarnessError';
    this.status = status;
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Result-envelope factory (never throws; callers branch on `error`). */
async function request<T>(
  operation: string,
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<HarnessResult<T>> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  const finalPath = applyDirectory(method, path, headers);
  const isEvent = finalPath.includes('/event');

  const doFetch = runtimeFetch(`${base}${finalPath}`, { ...init, method, headers });
  let response: Response;
  try {
    if (method === 'GET' && !isEvent) {
      const timeout = timeoutMs ?? HARNESS_REQUEST_TIMEOUT_MS;
      response = await Promise.race([
        doFetch,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new HarnessError(`${operation} failed: request timed out`, 408)), timeout),
        ),
      ]);
    } else {
      response = await doFetch;
    }
  } catch (error) {
    if (error instanceof HarnessError) return { error: error.message };
    return { error: `${operation} failed: ${String(error)}` }; // transport failure (§11.8), no invented status
  }

  const body = await readBody(response);
  if (!response.ok) {
    const message =
      (body as { error?: { message?: string } } | null)?.error?.message ??
      (body as { message?: string } | null)?.message ??
      response.statusText;
    return { error: `${operation} failed (${response.status}): ${message}`, response: { status: response.status } };
  }
  return { data: body as T, response: { status: response.status } };
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});
const PATCH = (body: unknown): RequestInit => ({
  method: 'PATCH',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
});
const DEL = (): RequestInit => ({ method: 'DELETE' });
const sid = (id: string) => encodeURIComponent(id);

// ── operations (catalog: doc 02 §3.4) ────────────────────────────────────────
export const harnessClient = {
  // lifecycle/health
  async globalHealth(): Promise<HarnessResult<{ healthy: boolean; version: string }>> {
    return request('globalHealth', '/global/health', undefined, HARNESS_HEALTH_TIMEOUT_MS);
  },
  /** HP-5 probe target: the harness's own health endpoint. */
  async probe(): Promise<HarnessResult<{ healthy: boolean; version: string }>> {
    return this.globalHealth();
  },

  // identity
  async getPath(): Promise<HarnessResult<HarnessPath>> {
    return request('getPath', '/path');
  },
  async getProject(): Promise<HarnessResult<unknown>> {
    return request('getProject', '/project/current');
  },

  // sessions (P-04)
  async listSessions(): Promise<HarnessResult<HarnessSession[]>> {
    return request('listSessions', '/session');
  },
  async createSession(input: { title?: string; directory?: string; parentID?: string }): Promise<HarnessResult<HarnessSession>> {
    return request('createSession', '/session', post(input));
  },
  async getSession(sessionId: string): Promise<HarnessResult<HarnessSession>> {
    return request('getSession', `/session/${sid(sessionId)}`);
  },
  async updateSession(sessionId: string, patchBody: Record<string, unknown>): Promise<HarnessResult<HarnessSession>> {
    return request('updateSession', `/session/${sid(sessionId)}`, PATCH(patchBody));
  },
  async deleteSession(sessionId: string): Promise<HarnessResult<boolean>> {
    return request('deleteSession', `/session/${sid(sessionId)}`, DEL());
  },
  async forkSession(sessionId: string, messageID?: string): Promise<HarnessResult<HarnessSession>> {
    return request('forkSession', `/session/${sid(sessionId)}/fork`, post({ ...(messageID ? { messageID } : {}) }));
  },
  async abortSession(sessionId: string): Promise<HarnessResult<boolean>> {
    return request('abortSession', `/session/${sid(sessionId)}/abort`, post({}));
  },
  async revertSession(sessionId: string, messageID: string, partID?: string): Promise<HarnessResult<HarnessSession>> {
    return request('revertSession', `/session/${sid(sessionId)}/revert`, post({ messageID, ...(partID ? { partID } : {}) }));
  },
  async unrevertSession(sessionId: string): Promise<HarnessResult<HarnessSession>> {
    return request('unrevertSession', `/session/${sid(sessionId)}/unrevert`, post({}));
  },
  async summarizeSession(sessionId: string, model?: { providerID?: string; modelID?: string }): Promise<HarnessResult<boolean>> {
    return request('summarizeSession', `/session/${sid(sessionId)}/summarize`, post(model ?? {}));
  },
  async listChildren(sessionId: string): Promise<HarnessResult<HarnessSession[]>> {
    return request('listChildren', `/session/${sid(sessionId)}/children`);
  },
  async listTodos(sessionId: string): Promise<HarnessResult<Todo[]>> {
    return request('listTodos', `/session/${sid(sessionId)}/todo`);
  },
  /** Authoritative status map (P-07): omission ⇒ idle; failure ⇒ error, never {}. */
  async sessionStatus(): Promise<HarnessResult<Record<string, SessionStatus>>> {
    return request('sessionStatus', '/session/status');
  },

  // turns (P-05)
  async listMessages(sessionId: string, limit?: number): Promise<HarnessResult<MessageEntry[]>> {
    const query = limit ? `?limit=${limit}` : '';
    return request('listMessages', `/session/${sid(sessionId)}/message${query}`);
  },
  async promptAsync(sessionId: string, body: PromptAsyncBody): Promise<HarnessResult<void>> {
    return request('promptAsync', `/session/${sid(sessionId)}/prompt_async`, post(body));
  },
  async sendCommand(sessionId: string, body: Record<string, unknown>): Promise<HarnessResult<{ info: unknown; parts: unknown }>> {
    return request('sendCommand', `/session/${sid(sessionId)}/command`, post(body));
  },
  async runShell(sessionId: string, body: Record<string, unknown>): Promise<HarnessResult<{ info: unknown; parts: unknown }>> {
    return request('runShell', `/session/${sid(sessionId)}/shell`, post(body));
  },

  // permissions (P-08)
  async listPermissions(): Promise<HarnessResult<PermissionRequest[]>> {
    return request('listPermissions', '/permission');
  },
  async replyToPermission(requestId: string, reply: 'once' | 'always' | 'reject', message?: string): Promise<HarnessResult<boolean>> {
    return request('replyToPermission', `/permission/${sid(requestId)}/reply`, post({ reply, ...(message ? { message } : {}) }));
  },
  async getPermissionV2(sessionId: string, requestId: string): Promise<HarnessResult<unknown>> {
    return request('getPermissionV2', `/api/session/${sid(sessionId)}/permission/${sid(requestId)}`);
  },

  // questions (P-09)
  async listQuestions(): Promise<HarnessResult<QuestionRequest[]>> {
    return request('listQuestions', '/question');
  },
  async replyToQuestion(requestId: string, answers: string[][]): Promise<HarnessResult<boolean>> {
    return request('replyToQuestion', `/question/${sid(requestId)}/reply`, post({ answers }));
  },
  async rejectQuestion(requestId: string): Promise<HarnessResult<boolean>> {
    return request('rejectQuestion', `/question/${sid(requestId)}/reject`, post({}));
  },

  // config/providers/agents (P-10/P-11/P-12)
  async getConfig(): Promise<HarnessResult<HarnessConfig>> {
    return request('getConfig', '/config');
  },
  async updateConfig(config: Record<string, unknown>): Promise<HarnessResult<HarnessConfig>> {
    return request('updateConfig', '/config', { method: 'PATCH', body: JSON.stringify({ config }), headers: { 'content-type': 'application/json' } });
  },
  async getProvidersForConfig(): Promise<HarnessResult<{ providers: Provider[]; default: Record<string, string> }>> {
    return request('getProvidersForConfig', '/config/providers');
  },
  async listProviders(): Promise<HarnessResult<Provider[]>> {
    return request('listProviders', '/provider');
  },
  async listAgents(): Promise<HarnessResult<AgentInfo[]>> {
    return request('listAgents', '/agent');
  },
  async listCommands(): Promise<HarnessResult<CommandInfo[]>> {
    return request('listCommands', '/command');
  },
  async listToolIds(): Promise<HarnessResult<string[]>> {
    return request('listToolIds', '/experimental/tool/ids');
  },

  // streams (P-06): URL builders — EventSource owns reconnect/Last-Event-ID
  harnessEventUrl(): string {
    const query = currentDirectory ? `?directory=${encodeURIComponent(currentDirectory)}` : '';
    return `${getRealtimeBaseUrl()}/api/event${query}`;
  },
  async eventStreamUrl(): Promise<string> {
    return this.harnessEventUrl();
  },
};
