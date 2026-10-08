// SPDX-License-Identifier: Apache-2.0
/**
 * Harness SDK facade (doc 02 §3.3/§3.5a/App D). The only browser path to the
 * harness. Synthesizes the `{data,error,response}` result envelope client-side
 * (D12: harness wire bodies are bare payloads); never fabricates statuses.
 * Directory transport follows §3.5a: GET/HEAD carry `?directory=`, other
 * methods carry the percent-encoded header (+ `uri` marker when encoded).
 */
import { runtimeFetch } from '../runtime-fetch.ts';
import type { ReviewMode, ReviewModeSnapshot } from './review-mode.ts';
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
  headers?: Headers;
}

/** Per-call directory override (sync engine addresses many directories at once). */
export interface DirOption {
  directory?: string;
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

function applyDirectory(method: string, path: string, headers: Headers, dirOverride?: string): string {
  const dir = dirOverride !== undefined ? normalizeDirectory(dirOverride) : currentDirectory;
  if (!dir) return path;
  const isRead = method === 'GET' || method === 'HEAD';
  if (isRead) {
    const key = path.startsWith('/api/') ? 'location[directory]' : 'directory';
    const joiner = path.includes('?') ? '&' : '?';
    return `${path}${joiner}${key}=${encodeURIComponent(dir)}`;
  }
  if (/[^\x00-\xFF]/.test(dir)) {
    headers.set(DIRECTORY_HEADER, encodeURIComponent(dir));
    headers.set(DIRECTORY_ENCODING_HEADER, 'uri');
  } else {
    headers.set(DIRECTORY_HEADER, dir);
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
  dirOverride?: string,
): Promise<HarnessResult<T>> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  const finalPath = applyDirectory(method, path, headers, dirOverride);
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

  let body: unknown;
  try {
    body = await readBody(response);
  } catch (error) {
    return { error: `${operation} failed: ${String(error)}`, response: { status: response.status }, headers: response.headers };
  }
  if (!response.ok) {
    const message =
      (body as { error?: { message?: string } } | null)?.error?.message ??
      (body as { message?: string } | null)?.message ??
      response.statusText;
    return { error: `${operation} failed (${response.status}): ${message}`, response: { status: response.status }, headers: response.headers };
  }
  return { data: body as T, response: { status: response.status }, headers: response.headers };
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
  async listProviderProfiles(): Promise<HarnessResult<{ profiles: unknown[]; configured_primary_route?: unknown; runtime_route?: unknown; provider_routing_pending?: boolean | null }>> {
    return request('listProviderProfiles', '/v1/provider-profiles');
  },
  async createProviderProfile(input: { profile_id: string; display_name?: string; endpoint: string; model: string; credential_env?: string }): Promise<HarnessResult<{ profile: unknown }>> {
    return request('createProviderProfile', '/v1/provider-profiles', post(input));
  },
  async updateProviderProfile(id: string, input: { display_name?: string; endpoint?: string; model?: string; credential_env?: string }): Promise<HarnessResult<{ profile: unknown }>> {
    return request('updateProviderProfile', `/v1/provider-profiles/${sid(id)}`, PATCH(input));
  },
  async setPrimaryProviderRoute(providerId: string, model: string): Promise<HarnessResult<{ configured_primary_route: unknown; runtime_route: unknown }>> {
    return request('setPrimaryProviderRoute', '/v1/provider-route', PATCH({ provider_id: providerId, model }));
  },
  async getSubagentProviderRoute(): Promise<HarnessResult<{ configured_route: unknown; runtime_route: unknown }>> {
    return request('getSubagentProviderRoute', '/v1/provider-route/subagent');
  },
  async setSubagentProviderRoute(providerId: string, model: string): Promise<HarnessResult<{ configured_route: unknown; runtime_route: unknown }>> {
    return request('setSubagentProviderRoute', '/v1/provider-route/subagent', PATCH({ provider_id: providerId, model }));
  },
  async activatePrimaryProviderRoute(): Promise<HarnessResult<{ runtime_route: unknown; existing_sessions_unchanged: boolean }>> {
    return request('activatePrimaryProviderRoute', '/v1/provider-route/activate', post({}));
  },
  async discoverProviderModels(profileId: string): Promise<HarnessResult<{ profile_id: string; models: unknown[] }>> {
    return request('discoverProviderModels', `/v1/provider-profiles/${sid(profileId)}/discover`, post({}));
  },
  async testProviderProfile(profileId: string): Promise<HarnessResult<{
    profile_id: string; status: string; selected_model: string; discovered_models: number;
  }>> {
    return request('testProviderProfile', `/v1/provider-profiles/${sid(profileId)}/test`, post({}));
  },
  async getNnaMcpInventory(): Promise<HarnessResult<{ version: number; state: string; servers: unknown[] }>> {
    return request('getNnaMcpInventory', '/v1/nnd/mcp');
  },
  async getNnaSkillsInventory(): Promise<HarnessResult<{ version: number; state: string; skills: unknown[] }>> {
    return request('getNnaSkillsInventory', '/v1/nnd/skills');
  },
  async getNnaAgentInventory(): Promise<HarnessResult<{ version: number; state: string; route: unknown; roles: unknown[] }>> {
    return request('getNnaAgentInventory', '/v1/nnd/agents');
  },
  async getSessionGoal(sessionId: string): Promise<HarnessResult<{ goal: unknown | null; revision: number }>> {
    return request('getSessionGoal', `/v1/nnd/sessions/${sid(sessionId)}/goal`);
  },
  async getSessionReviewMode(sessionId: string): Promise<HarnessResult<ReviewModeSnapshot>> {
    return request('getSessionReviewMode', `/v1/nnd/sessions/${sid(sessionId)}/review-mode`);
  },
  async setSessionReviewMode(sessionId: string, mode: ReviewMode, revision: number): Promise<HarnessResult<ReviewModeSnapshot>> {
    return request('setSessionReviewMode', `/v1/nnd/sessions/${sid(sessionId)}/review-mode`, { ...post({ mode, expected_revision: revision }), method: 'PUT' });
  },
  async getSessionGoalEvidence(sessionId: string): Promise<HarnessResult<{
    session_id: string; latest_request_id: string | null; window_truncated: boolean;
    turns: { request_id: string; outcome: string; tokens: number | null; measurement: string }[];
  }>> {
    return request('getSessionGoalEvidence', `/v1/nnd/sessions/${sid(sessionId)}/goal-evidence`);
  },
  async putSessionGoal(sessionId: string, goal: unknown, expectedId: string | null, expectedRevision: number): Promise<HarnessResult<{ goal: unknown; revision: number }>> {
    return request('putSessionGoal', `/v1/nnd/sessions/${sid(sessionId)}/goal`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ goal, expected_id: expectedId, expected_revision: expectedRevision }),
    });
  },
  async clearSessionGoal(sessionId: string, expectedId: string, expectedRevision: number): Promise<HarnessResult<{ goal: null; revision: number }>> {
    return request('clearSessionGoal', `/v1/nnd/sessions/${sid(sessionId)}/goal`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected_id: expectedId, expected_revision: expectedRevision }),
    });
  },
  // lifecycle/health
  async globalHealth(): Promise<HarnessResult<{ healthy: boolean; version: string }>> {
    return request('globalHealth', '/global/health', undefined, HARNESS_HEALTH_TIMEOUT_MS);
  },
  /** HP-5 probe target: the harness's own health endpoint. */
  async probe(): Promise<HarnessResult<{ healthy: boolean; version: string }>> {
    return this.globalHealth();
  },

  // identity
  async getPath(opts?: DirOption): Promise<HarnessResult<HarnessPath>> {
    return request('getPath', '/path', undefined, undefined, opts?.directory);
  },
  async getProject(opts?: DirOption): Promise<HarnessResult<unknown>> {
    return request('getProject', '/project/current', undefined, undefined, opts?.directory);
  },
  async listProjects(opts?: DirOption): Promise<HarnessResult<unknown[]>> {
    return request('listProjects', '/project', undefined, undefined, opts?.directory);
  },
  async getMcp(opts?: DirOption): Promise<HarnessResult<unknown>> {
    return request('getMcp', '/mcp', undefined, undefined, opts?.directory);
  },
  async addMcp(name: string, config: unknown, opts?: DirOption & { scope?: 'user' | 'project' }): Promise<HarnessResult<unknown>> {
    return request('addMcp', '/mcp', post({ name, config, scope: opts?.scope }), undefined, opts?.directory);
  },
  async connectMcp(name: string, opts?: DirOption): Promise<HarnessResult<unknown>> {
    return request('connectMcp', `/mcp/${encodeURIComponent(name)}/connect`, post({}), undefined, opts?.directory);
  },
  async disconnectMcp(name: string, opts?: DirOption): Promise<HarnessResult<unknown>> {
    return request('disconnectMcp', `/mcp/${encodeURIComponent(name)}/disconnect`, post({}), undefined, opts?.directory);
  },
  async startMcpAuth(name: string, opts?: DirOption): Promise<HarnessResult<{ authorizationUrl?: string }>> {
    return request('startMcpAuth', `/mcp/${encodeURIComponent(name)}/auth`, post({}), undefined, opts?.directory);
  },
  async mcpAuthCallback(name: string, code: string, opts?: DirOption): Promise<HarnessResult<unknown>> {
    return request('mcpAuthCallback', `/mcp/${encodeURIComponent(name)}/auth/callback`, post({ code }), undefined, opts?.directory);
  },
  async authenticateMcp(name: string, opts?: DirOption): Promise<HarnessResult<unknown>> {
    return request('authenticateMcp', `/mcp/${encodeURIComponent(name)}/auth/authenticate`, post({}), 15 * 60_000, opts?.directory);
  },
  async removeMcpAuth(name: string, opts?: DirOption): Promise<HarnessResult<unknown>> {
    return request('removeMcpAuth', `/mcp/${encodeURIComponent(name)}/auth`, { method: 'DELETE' }, undefined, opts?.directory);
  },
  async getLsp(opts?: DirOption): Promise<HarnessResult<unknown[]>> {
    return request('getLsp', '/lsp', undefined, undefined, opts?.directory);
  },
  async getVcs(opts?: DirOption): Promise<HarnessResult<{ branch: string; default_branch?: string }>> {
    return request('getVcs', '/vcs', undefined, undefined, opts?.directory);
  },

  // sessions (P-04)
  async listSessions(opts?: DirOption & { roots?: boolean; archived?: boolean; limit?: number }): Promise<HarnessResult<HarnessSession[]>> {
    const parts: string[] = [];
    if (opts?.roots !== undefined) parts.push(`roots=${opts.roots}`);
    if (opts?.archived !== undefined) parts.push(`archived=${opts.archived}`);
    if (opts?.limit !== undefined) parts.push(`limit=${opts.limit}`);
    const query = parts.length ? `?${parts.join('&')}` : '';
    return request('listSessions', `/session${query}`, undefined, undefined, opts?.directory);
  },
  async createSession(input: { title?: string; directory?: string; parentID?: string; workspace_id?: string }): Promise<HarnessResult<HarnessSession>> {
    return request('createSession', '/session', post(input), undefined, input.directory);
  },
  async getSession(sessionId: string, opts?: DirOption): Promise<HarnessResult<HarnessSession>> {
    return request('getSession', `/session/${sid(sessionId)}`, undefined, undefined, opts?.directory);
  },
  async listActivity(sessionId: string, opts?: DirOption): Promise<HarnessResult<unknown[]>> {
    return request('listActivity', `/session/${sid(sessionId)}/activity`, undefined, undefined, opts?.directory);
  },
  async readActivityHistoryPage(sessionId: string, cursor?: string): Promise<HarnessResult<unknown>> {
    const query = `?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    // Native history accepts only limit/cursor; the authenticated principal,
    // not the browser's ambient directory, selects the owned session.
    return request('readActivityHistoryPage', `/v1/nnd/sessions/${sid(sessionId)}/activity-history${query}`,
      undefined, undefined, '');
  },
  async readActivityTombstones(after = 0): Promise<HarnessResult<unknown>> {
    return request('readActivityTombstones', `/v1/nnd/activity-tombstones?after=${after}&limit=50`,
      undefined, undefined, '');
  },
  async childSteeringCapability(sessionId: string, opts?: DirOption): Promise<HarnessResult<{
    session_id: string; revision: number; capabilities: { steer_subagent: boolean }; availability: string;
  }>> {
    return request('childSteeringCapability', `/v1/nnd/sessions/${sid(sessionId)}/capabilities`, undefined, undefined, opts?.directory);
  },
  async steerChildSession(sessionId: string, body: { request_id: string; content: string }, opts?: DirOption): Promise<HarnessResult<{ accepted: boolean; reason?: string; steering_id?: string }>> {
    return request('steerChildSession', `/v1/nnd/sessions/${sid(sessionId)}/steer`, post(body), undefined, opts?.directory);
  },
  async updateSession(sessionId: string, patchBody: Record<string, unknown>, opts?: DirOption): Promise<HarnessResult<HarnessSession>> {
    return request('updateSession', `/session/${sid(sessionId)}`, PATCH(patchBody), undefined, opts?.directory);
  },
  async deleteSession(sessionId: string, opts?: DirOption): Promise<HarnessResult<boolean>> {
    return request('deleteSession', `/session/${sid(sessionId)}`, DEL(), undefined, opts?.directory);
  },
  async forkSession(sessionId: string, messageID?: string, opts?: DirOption): Promise<HarnessResult<HarnessSession>> {
    return request('forkSession', `/session/${sid(sessionId)}/fork`, post({ ...(messageID ? { messageID } : {}) }), undefined, opts?.directory);
  },
  async abortSession(sessionId: string, opts?: DirOption): Promise<HarnessResult<boolean>> {
    return request('abortSession', `/session/${sid(sessionId)}/abort`, post({}), undefined, opts?.directory);
  },
  async revertSession(sessionId: string, messageID: string, partID?: string, opts?: DirOption): Promise<HarnessResult<HarnessSession>> {
    return request('revertSession', `/session/${sid(sessionId)}/revert`, post({ messageID, ...(partID ? { partID } : {}) }), undefined, opts?.directory);
  },
  async unrevertSession(sessionId: string, opts?: DirOption): Promise<HarnessResult<HarnessSession>> {
    return request('unrevertSession', `/session/${sid(sessionId)}/unrevert`, post({}), undefined, opts?.directory);
  },
  async summarizeSession(sessionId: string, model?: { providerID?: string; modelID?: string }, opts?: DirOption): Promise<HarnessResult<boolean>> {
    return request('summarizeSession', `/session/${sid(sessionId)}/summarize`, post(model ?? {}), undefined, opts?.directory);
  },
  async listChildren(sessionId: string, opts?: DirOption): Promise<HarnessResult<HarnessSession[]>> {
    return request('listChildren', `/session/${sid(sessionId)}/children`, undefined, undefined, opts?.directory);
  },
  async listTodos(sessionId: string, opts?: DirOption): Promise<HarnessResult<Todo[]>> {
    return request('listTodos', `/session/${sid(sessionId)}/todo`, undefined, undefined, opts?.directory);
  },
  /** Authoritative status map (P-07): omission ⇒ idle; failure ⇒ error, never {}. */
  async sessionStatus(opts?: DirOption): Promise<HarnessResult<Record<string, SessionStatus>>> {
    return request('sessionStatus', '/session/status', undefined, undefined, opts?.directory);
  },

  // turns (P-05)
  async listMessages(sessionId: string, limit?: number, opts?: DirOption): Promise<HarnessResult<MessageEntry[]>> {
    const query = limit ? `?limit=${limit}` : '';
    return request('listMessages', `/session/${sid(sessionId)}/message${query}`, undefined, undefined, opts?.directory);
  },
  /** Cursor page (doc 04 §E.1): `before` is an exclusive message id; the next
   * older cursor arrives in the `x-next-cursor` response header. */
  async listMessagesPage(sessionId: string, opts?: DirOption & { limit?: number; before?: string }): Promise<HarnessResult<MessageEntry[]> & { cursor?: string | null }> {
    const parts: string[] = [];
    if (opts?.limit !== undefined) parts.push(`limit=${opts.limit}`);
    if (opts?.before) parts.push(`before=${encodeURIComponent(opts.before)}`);
    const query = parts.length ? `?${parts.join('&')}` : '';
    const result = await request<MessageEntry[]>('listMessagesPage', `/session/${sid(sessionId)}/message${query}`, undefined, undefined, opts?.directory);
    if (result.error) return result;
    return { ...result, cursor: result.headers?.get('x-next-cursor') ?? null };
  },
  async promptAsync(sessionId: string, body: PromptAsyncBody, opts?: DirOption): Promise<HarnessResult<void>> {
    return request('promptAsync', `/session/${sid(sessionId)}/prompt_async`, post(body), undefined, opts?.directory);
  },
  async uploadAttachment(sessionId: string, body: { upload_id: string; filename: string; mime_type: string; data_url: string },
    opts?: DirOption): Promise<HarnessResult<{ upload_id: string; sha256: string; mime_type: string; bytes: number; expires_at: string }>> {
    return request('uploadAttachment', `/v1/nnd/sessions/${sid(sessionId)}/attachments`, post(body), undefined, opts?.directory);
  },
  async sendCommand(sessionId: string, body: Record<string, unknown>, opts?: DirOption): Promise<HarnessResult<{ info: unknown; parts: unknown }>> {
    return request('sendCommand', `/session/${sid(sessionId)}/command`, post(body), undefined, opts?.directory);
  },
  async runShell(sessionId: string, body: Record<string, unknown>, opts?: DirOption): Promise<HarnessResult<{ info: unknown; parts: unknown }>> {
    return request('runShell', `/session/${sid(sessionId)}/shell`, post(body), undefined, opts?.directory);
  },

  // permissions (P-08)
  async listPermissions(opts?: DirOption): Promise<HarnessResult<PermissionRequest[]>> {
    return request('listPermissions', '/permission', undefined, undefined, opts?.directory);
  },
  async replyToPermission(requestId: string, reply: 'once' | 'always' | 'reject', message?: string, opts?: DirOption): Promise<HarnessResult<boolean>> {
    return request('replyToPermission', `/permission/${sid(requestId)}/reply`, post({ reply, ...(message ? { message } : {}) }), undefined, opts?.directory);
  },
  async getPermissionV2(sessionId: string, requestId: string, opts?: DirOption): Promise<HarnessResult<unknown>> {
    return request('getPermissionV2', `/api/session/${sid(sessionId)}/permission/${sid(requestId)}`, undefined, undefined, opts?.directory);
  },

  // questions (P-09)
  async listQuestions(opts?: DirOption): Promise<HarnessResult<QuestionRequest[]>> {
    return request('listQuestions', '/question', undefined, undefined, opts?.directory);
  },
  async replyToQuestion(requestId: string, answers: string[][], opts?: DirOption): Promise<HarnessResult<boolean>> {
    return request('replyToQuestion', `/question/${sid(requestId)}/reply`, post({ answers }), undefined, opts?.directory);
  },
  async rejectQuestion(requestId: string, opts?: DirOption): Promise<HarnessResult<boolean>> {
    return request('rejectQuestion', `/question/${sid(requestId)}/reject`, post({}), undefined, opts?.directory);
  },

  // config/providers/agents (P-10/P-11/P-12)
  async getConfig(opts?: DirOption): Promise<HarnessResult<HarnessConfig>> {
    return request('getConfig', '/config', undefined, undefined, opts?.directory);
  },
  async updateConfig(config: Record<string, unknown>): Promise<HarnessResult<HarnessConfig>> {
    return request('updateConfig', '/config', { method: 'PATCH', body: JSON.stringify({ config }), headers: { 'content-type': 'application/json' } });
  },
  async getProvidersForConfig(opts?: DirOption): Promise<HarnessResult<{ providers: Provider[]; default: Record<string, string> }>> {
    return request('getProvidersForConfig', '/config/providers', undefined, undefined, opts?.directory);
  },
  async listProviders(opts?: DirOption): Promise<HarnessResult<Provider[]>> {
    return request('listProviders', '/provider', undefined, undefined, opts?.directory);
  },
  async listAgents(opts?: DirOption): Promise<HarnessResult<AgentInfo[]>> {
    return request('listAgents', '/agent', undefined, undefined, opts?.directory);
  },
  async listCommands(opts?: DirOption): Promise<HarnessResult<CommandInfo[]>> {
    return request('listCommands', '/command', undefined, undefined, opts?.directory);
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
