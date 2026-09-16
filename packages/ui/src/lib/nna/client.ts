/**
 * Harness SDK facade (doc 01 HP-2/3/4/5; method catalog lands with doc 02).
 *  - every read returns { data, error }; non-2xx → `<op> failed (<status>): <msg>`
 *  - GETs carry a 30 s timeout (POST + /event bypass); the wait is abandoned on
 *    timeout while a shared coalesced fetch may complete
 *  - one current directory (normalized) travels on every scoped call
 */
import { runtimeFetch } from '../runtime-fetch.ts';
import { getEventStreamUrl } from '../runtime-url.ts';
import {
  DEFAULT_BASE_URL,
  DIRECTORY_ENCODING_HEADER,
  DIRECTORY_HEADER,
  HARNESS_HEALTH_TIMEOUT_MS,
  HARNESS_REQUEST_TIMEOUT_MS,
} from './constants.ts';

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

function directoryHeaders(headers: Headers): Headers {
  if (!currentDirectory) return headers;
  if (/[^\x00-\xFF]/.test(currentDirectory)) {
    headers.set(DIRECTORY_HEADER, encodeURI(currentDirectory));
    headers.set(DIRECTORY_ENCODING_HEADER, 'uri');
  } else {
    headers.set(DIRECTORY_HEADER, currentDirectory);
  }
  return headers;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function unwrap<T>(body: unknown): HarnessResult<T> {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    const data = (body as Record<string, unknown>).data as T;
    if (data === undefined || data === null) return { error: 'operation failed: empty response' };
    return { data };
  }
  if (body === null || body === undefined) return { error: 'operation failed: empty response' };
  return { data: body as T };
}

export class HarnessError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HarnessError';
    this.status = status;
  }
}

async function request<T>(
  operation: string,
  path: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<HarnessResult<T>> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = directoryHeaders(new Headers(init?.headers));
  const isEvent = path.includes('/event');

  const doFetch = runtimeFetch(`${base}${path}`, { ...init, method, headers });
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
    return { error: `${operation} failed: ${String(error)}` };
  }

  const body = await readJson(response);
  if (!response.ok) {
    const message =
      (body as { error?: { message?: string } } | null)?.error?.message ??
      (body as { message?: string } | null)?.message ??
      response.statusText;
    return {
      error: `${operation} failed (${response.status}): ${message}`,
      response: { status: response.status },
    };
  }
  const result = unwrap<T>(body);
  result.response = { status: response.status };
  return result;
}

// ── operations ──────────────────────────────────────────────────────────────
export interface HarnessSession {
  id: string;
  title: string;
  directory: string;
  time: { created: number; updated: number };
}

export interface HarnessMessage {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  time: { created: number };
  parts: Array<Record<string, unknown>>;
}

export const harnessClient = {
  async listSessions(): Promise<HarnessResult<HarnessSession[]>> {
    return request('listSessions', '/session');
  },
  async createSession(input: { title?: string; directory?: string }): Promise<HarnessResult<HarnessSession>> {
    return request('createSession', '/session', {
      method: 'POST',
      body: (JSON.stringify(input) ?? '') as BodyInit,
      headers: { 'content-type': 'application/json' },
    });
  },
  async listMessages(sessionId: string): Promise<HarnessResult<HarnessMessage[]>> {    return request('listMessages', `/session/${encodeURIComponent(sessionId)}/message`);
  },
  async sendMessage(
    sessionId: string,
    parts: Array<Record<string, unknown>>,
  ): Promise<HarnessResult<{ accepted: boolean }>> {
    return request('sendMessage', `/session/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      body: JSON.stringify({ parts }) ?? '',
      headers: { 'content-type': 'application/json' },
    });
  },
  async listProviders(): Promise<HarnessResult<unknown>> {
    return request('listProviders', '/provider');
  },
  async listAgents(): Promise<HarnessResult<unknown>> {
    return request('listAgents', '/agent');
  },
  async getConfig(): Promise<HarnessResult<unknown>> {
    return request('getConfig', '/config');
  },
  async getPath(): Promise<HarnessResult<unknown>> {
    return request('getPath', '/path');
  },
  /** HP-5 health probe — short timeout, no coalescing surprises. */
  async probe(): Promise<HarnessResult<unknown>> {
    return request('probe', '/path', undefined, HARNESS_HEALTH_TIMEOUT_MS);
  },
  async eventStreamUrl(): Promise<string> {
    return getEventStreamUrl('/api/event');
  },
};
