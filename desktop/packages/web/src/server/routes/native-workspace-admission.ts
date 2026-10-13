// SPDX-License-Identifier: Apache-2.0
/** Admission for NNA's single attached workspace. The browser supplies only a
 * candidate; native /path and local filesystem identity are checked here. */
import { lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';
import type { Hono } from 'hono';
import { ENV } from '../env.ts';
import { getHarnessAdapter, harnessError } from '../harness/adapter.ts';
import { DIRECTORY_ENCODING_HEADER, DIRECTORY_HEADER } from '../lib/harnessNaming.ts';

export class WorkspaceAdmissionError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export function workspacePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 2 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+$|^([a-z]):/gu, (match, drive: string) => drive ? `${drive.toUpperCase()}:` : '');
  if (!normalized || normalized.startsWith('//') || normalized.includes('//')
    || normalized.split('/').some(part => part === '.' || part === '..')) return null;
  if (/^[A-Z]:\//u.test(normalized) || (normalized.startsWith('/') && !normalized.startsWith('//'))) return normalized;
  return null;
}

function sameWorkspacePath(left: unknown, right: unknown): boolean {
  const a = workspacePath(left), b = workspacePath(right);
  if (!a || !b) return false;
  return /^[A-Z]:\//u.test(a) && /^[A-Z]:\//u.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function requirePlainDirectory(directory: string): Promise<string> {
  const windows = /^[A-Z]:\//u.test(directory);
  const path = windows ? win32 : posix;
  const native = windows ? directory.replaceAll('/', '\\') : directory;
  let cursor = path.parse(native).root;
  if (!cursor) throw new WorkspaceAdmissionError('Workspace filesystem identity is unavailable.', 503);
  for (const part of native.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor).catch(() => null);
    if (!info || !info.isDirectory() || info.isSymbolicLink()) {
      throw new WorkspaceAdmissionError('Workspace filesystem identity is unavailable; resolve links and refresh NNA.', 503);
    }
  }
  const resolved = await realpath(native).catch(() => null);
  if (!resolved || !sameWorkspacePath(resolved, directory)) {
    throw new WorkspaceAdmissionError('Workspace filesystem identity is unavailable; use its canonical path.', 503);
  }
  return resolved;
}

export async function admitNativeWorkspace(candidate: unknown, readPath: () => Promise<unknown> = readNativePath): Promise<string> {
  const chosen = workspacePath(candidate);
  const raw = await readPath();
  const data = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const native = workspacePath(data.directory);
  if (!chosen || !native || !sameWorkspacePath(native, data.worktree)) {
    throw new WorkspaceAdmissionError('NNA workspace identity is unavailable. Refresh the native connection before creating a session.', 503);
  }
  if (!sameWorkspacePath(chosen, native)) throw new WorkspaceAdmissionError(`NNA is attached to ${native}. Select that workspace or reconfigure NNA before creating a session.`);
  await requirePlainDirectory(native);
  return native;
}

type WorkspaceInventory = { selection_enabled?: unknown; installation_id?: unknown; data_id?: unknown;
  revision?: unknown; attached?: { root?: unknown; id?: unknown };
  admitted?: { root?: unknown; id?: unknown; operation_id?: unknown }[] };
const WORKSPACE_ID = /^ws_[a-f0-9]{24}$/u;
// The selected native service can spend most of 30 seconds on durable grant
// readback. Keep this below the adapter's 60-second admission-specific bound.
const NATIVE_ADMISSION_TIMEOUT_MS = 55_000;
const NATIVE_OTHER_TIMEOUT_MS = 30_000;

async function readNativeAdmissions(): Promise<unknown> {
  const response = await getHarnessAdapter().handle(new Request('http://harness.internal/api/v1/nnd/workspaces/admissions', {
    method: 'GET', signal: AbortSignal.timeout(NATIVE_ADMISSION_TIMEOUT_MS),
  }));
  if (!response.ok) throw new WorkspaceAdmissionError(`NNA workspace admission inventory is unavailable (native status ${response.status}).`, 503);
  try { return await response.json(); }
  catch { throw new WorkspaceAdmissionError('NNA returned an invalid workspace admission inventory.', 503); }
}

/** Keep local Git mutations scoped to a root already verified by NNA. */
export async function assertNativeWorkspaceRoot(candidate: unknown): Promise<void> {
  const normalized = workspacePath(candidate);
  if (typeof candidate !== 'string' || !normalized || candidate !== candidate.trim()
    || process.platform !== 'win32' && candidate !== normalized) {
    throw new WorkspaceAdmissionError('Workspace path must use its canonical spelling.', 400);
  }
  try { await admitNativeWorkspace(candidate); }
  catch (error) {
    if (!(error instanceof WorkspaceAdmissionError) || error.status !== 409) throw error;
    await admitSelectedWorkspace(candidate);
  }
}

/** Register a freshly created worktree before the desktop exposes it as a
 * selectable project. A lost POST acknowledgment is resolved by operation
 * receipt; a failed readback never claims that admission succeeded. */
export async function admitCreatedNativeWorkspace(candidate: unknown): Promise<string> {
  const requested = workspacePath(candidate);
  if (!requested) throw new WorkspaceAdmissionError('Created worktree path is invalid.', 400);
  // NNA's canonical grant compares exact native spelling with realpath.
  // Slash-normalized browser display paths are not valid mutation roots.
  const root = await requirePlainDirectory(requested);
  const initial = await readNativeAdmissions() as WorkspaceInventory;
  if (initial.selection_enabled !== true || typeof initial.installation_id !== 'string'
    || typeof initial.data_id !== 'string' || typeof initial.revision !== 'string') {
    throw new WorkspaceAdmissionError('NNA workspace admission identity is unavailable.', 503);
  }
  const operationId = randomUUID();
  const base = 'http://harness.internal/api/v1/nnd/workspaces/admissions';
  const adapter = getHarnessAdapter();
  let response: Response | null = null;
  try {
    response = await adapter.handle(new Request(base, { method: 'POST',
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(NATIVE_ADMISSION_TIMEOUT_MS),
      body: JSON.stringify({ installation_id: initial.installation_id, data_id: initial.data_id,
        expected_revision: initial.revision, operation_id: operationId, root }),
    }));
  } catch { /* An unknown acknowledgment must be resolved by receipt. */ }
  let receipt = response?.ok ? await response.json().catch(() => null) : null;
  if (receipt === null) {
    const lookup = await adapter.handle(new Request(`${base}/operations/${operationId}`, {
      method: 'GET', signal: AbortSignal.timeout(NATIVE_ADMISSION_TIMEOUT_MS),
    })).catch(() => null);
    receipt = lookup?.ok ? await lookup.json().catch(() => null) : null;
  }
  const inventory = await readNativeAdmissions() as WorkspaceInventory;
  if (inventory.installation_id !== initial.installation_id || inventory.data_id !== initial.data_id
    || !Array.isArray(inventory.admitted)) {
    throw new WorkspaceAdmissionError('NNA worktree admission readback is unavailable. The Git worktree remains on disk for recovery.', 503);
  }
  const row = inventory.admitted.find(value => sameWorkspacePath(value.root, root)
    && value.operation_id === operationId && WORKSPACE_ID.test(String(value.id)));
  if (!validAdmissionReceipt(receipt, operationId) && !row) throw new WorkspaceAdmissionError(
    'NNA worktree admission was not confirmed. The Git worktree remains on disk for recovery.', 503);
  if (!row || typeof row.id !== 'string') {
    throw new WorkspaceAdmissionError('NNA did not verify the new worktree. The Git worktree remains on disk for recovery.', 503);
  }
  return row.id;
}

export async function assertNoNativeWorkspaceSessions(candidate: unknown): Promise<void> {
  const response = await getHarnessAdapter().handle(new Request('http://harness.internal/api/session?roots=true&archived=true', {
    method: 'GET', signal: AbortSignal.timeout(NATIVE_OTHER_TIMEOUT_MS),
  }));
  if (!response.ok) throw new WorkspaceAdmissionError('NNA session inventory is unavailable; worktree removal is refused.', 503);
  const sessions = await response.json().catch(() => null) as unknown;
  if (!Array.isArray(sessions) || !sessions.every(value => value && typeof value === 'object')) {
    throw new WorkspaceAdmissionError('NNA session inventory is unreadable; worktree removal is refused.', 503);
  }
  if (sessions.some(value => sameWorkspacePath((value as { directory?: unknown }).directory, candidate))) {
    throw new WorkspaceAdmissionError('This worktree still has NNA sessions. Remove those sessions before deleting it.', 409);
  }
}

export async function revokeNativeWorkspaceForRemoval(candidate: unknown): Promise<void> {
  const root = workspacePath(candidate);
  if (!root) throw new WorkspaceAdmissionError('Removed worktree path is invalid.', 400);
  const initial = await readNativeAdmissions() as WorkspaceInventory;
  if (initial.selection_enabled !== true || typeof initial.installation_id !== 'string'
    || typeof initial.data_id !== 'string' || typeof initial.revision !== 'string'
    || !Array.isArray(initial.admitted)) {
    throw new WorkspaceAdmissionError('NNA workspace admission inventory is unavailable.', 503);
  }
  // An external deletion already moves the row to `unavailable`; ordinary
  // removal revokes the healthy row before Git deletes the directory.
  const unavailable = (initial as WorkspaceInventory & { unavailable?: { root?: unknown }[] }).unavailable;
  const stored = [...initial.admitted, ...(unavailable ?? [])].find(row => sameWorkspacePath(row.root, root));
  if (!stored) throw new WorkspaceAdmissionError(
    'This linked worktree is not admitted by NNA. Use + Add workspace to verify it before removal.', 409);
  if (typeof stored.root !== 'string' || !workspacePath(stored.root)) {
    throw new WorkspaceAdmissionError('NNA returned an invalid worktree admission root.', 503);
  }
  const operationId = randomUUID();
  const base = 'http://harness.internal/api/v1/nnd/workspaces/admissions';
  const adapter = getHarnessAdapter();
  let response: Response | null = null;
  try {
    response = await adapter.handle(new Request(`${base}/revoke`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(NATIVE_ADMISSION_TIMEOUT_MS),
      body: JSON.stringify({ installation_id: initial.installation_id, data_id: initial.data_id,
        expected_revision: initial.revision, operation_id: operationId, root: stored.root }),
    }));
  } catch { /* Discover an unknown acknowledgment below. */ }
  let receipt = response?.ok ? await response.json().catch(() => null) : null;
  if (receipt === null) {
    const lookup = await adapter.handle(new Request(`${base}/operations/${operationId}`, {
      method: 'GET', signal: AbortSignal.timeout(NATIVE_ADMISSION_TIMEOUT_MS),
    })).catch(() => null);
    receipt = lookup?.ok ? await lookup.json().catch(() => null) : null;
  }
  if (!validAdmissionReceipt(receipt, operationId)) throw new WorkspaceAdmissionError(
    'NNA worktree cleanup was not confirmed. Refresh the native inventory before retrying.', 503);
  const current = await readNativeAdmissions() as WorkspaceInventory & { unavailable?: { root?: unknown }[] };
  if (current.installation_id !== initial.installation_id || current.data_id !== initial.data_id
    || current.admitted?.some(row => sameWorkspacePath(row.root, root))
    || current.unavailable?.some(row => sameWorkspacePath(row.root, root))) {
    throw new WorkspaceAdmissionError('NNA still lists the removed worktree. Refresh the native inventory before retrying.', 503);
  }
}

function validAdmissionReceipt(value: unknown, operationId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return receipt.operation_id === operationId && receipt.persistence === 'saved';
}

async function admitSelectedWorkspace(candidate: unknown, requestedId?: unknown,
  readPath: () => Promise<unknown> = readNativePath,
  readInventory: () => Promise<unknown> = readNativeAdmissions): Promise<{ directory: string; workspace_id: string }> {
  const chosen = workspacePath(candidate);
  if (!chosen || requestedId !== undefined && (!WORKSPACE_ID.test(String(requestedId)))) {
    throw new WorkspaceAdmissionError('Workspace selection is invalid.', 400);
  }
  const raw = await readInventory();
  const inventory = raw && typeof raw === 'object' ? raw as WorkspaceInventory : {};
  if (inventory.selection_enabled !== true || !Array.isArray(inventory.admitted)
    || !workspacePath(inventory.attached?.root)) {
    throw new WorkspaceAdmissionError('NNA workspace selection is unavailable.', 503);
  }
  await admitNativeWorkspace(inventory.attached?.root, readPath);
  const rows = [inventory.attached, ...inventory.admitted];
  const row = rows.find(value => WORKSPACE_ID.test(String(value?.id))
    && sameWorkspacePath(value?.root, chosen) && (requestedId === undefined || value?.id === requestedId));
  if (!row || typeof row.id !== 'string' || typeof row.root !== 'string' || !workspacePath(row.root)) {
    throw new WorkspaceAdmissionError('This workspace is not admitted by NNA.', 409);
  }
  await requirePlainDirectory(workspacePath(row.root)!);
  return { directory: row.root, workspace_id: row.id };
}

async function readNativePath(): Promise<unknown> {
  const response = await getHarnessAdapter().handle(new Request('http://harness.internal/api/path', {
    method: 'GET', signal: AbortSignal.timeout(NATIVE_OTHER_TIMEOUT_MS),
  }));
  if (!response.ok) throw new WorkspaceAdmissionError('NNA workspace identity is unavailable. Refresh the native connection.', 503);
  try { return await response.json(); } catch { throw new WorkspaceAdmissionError('NNA returned an invalid workspace identity.', 503); }
}

/** Shared server boundary for browser proxy, orchestration, and scheduled jobs.
 * NNA's response remains authoritative; a race-created session is preserved. */
export async function handleNativeSessionCreation(request: Request,
  forward: (request: Request) => Promise<Response>, readPath: () => Promise<unknown> = readNativePath): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (ENV.harness === 'mock' || request.method !== 'POST'
    || (path !== '/api/session' && !/^\/api\/session\/[^/]+\/fork$/u.test(path))) return forward(request);
  try {
    const body = await request.clone().json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return harnessError('Session create body is invalid.', 400);
    const raw = await readPath();
    const selected = body.workspace_id === undefined ? null
      : await admitSelectedWorkspace(body.directory, body.workspace_id, async () => raw);
    const native = selected?.directory ?? await admitNativeWorkspace(raw && typeof raw === 'object'
      ? (raw as Record<string, unknown>).directory : null, async () => raw);
    let header = request.headers.get(DIRECTORY_HEADER);
    const encoding = request.headers.get(DIRECTORY_ENCODING_HEADER);
    if (encoding && encoding !== 'uri' || encoding === 'uri' && header === null) {
      return harnessError('Session workspace header is invalid.', 400);
    }
    if (encoding === 'uri' && header !== null) {
      try { header = decodeURIComponent(header); }
      catch { return harnessError('Session workspace header is invalid.', 400); }
    }
    const query = new URL(request.url).searchParams.get('location[directory]');
    for (const candidate of [header, query, body.directory]) {
      if (candidate !== null && candidate !== undefined && !sameWorkspacePath(candidate, native)) {
        return harnessError(`NNA is attached to ${native}. Select that workspace or reconfigure NNA before creating a session.`, 409);
      }
    }
    const forwarding = selected ? new Request(request, {
      body: JSON.stringify({ ...body, directory: native }),
    }) : request;
    const response = await forward(forwarding);
    if (!response.ok) return response;
    const record = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return harnessError('NNA created a session with an unreadable workspace. Refresh before sending.', 502);
    }
    const actual = record.directory;
    if (!sameWorkspacePath(actual, native)) {
      const id = typeof record.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(record.id) ? record.id : 'unknown';
      return harnessError(`NNA created session ${id} in a changed or unknown workspace. The session remains recoverable in NNA; refresh before sending.`, 409);
    }
    if (selected && record.projectID !== selected.workspace_id) {
      return harnessError('NNA created a session with a changed workspace identity. Refresh before sending.', 409);
    }
    return response;
  } catch (error) {
    const failure = error instanceof WorkspaceAdmissionError ? error : new WorkspaceAdmissionError('NNA workspace identity is unavailable.', 503);
    return harnessError(failure.message, failure.status);
  }
}

export function registerNativeWorkspaceAdmissionRoute(app: Hono): void {
  app.get('/api/native-workspace/admission', async c => {
    try {
      const candidate = c.req.query('directory');
      // The in-process mock has no native installation or filesystem-bound
      // root. This compatibility path is never used for an NNA attachment.
      let directory = ENV.harness === 'mock' ? workspacePath(candidate) : null;
      let workspaceId: string | undefined;
      if (ENV.harness !== 'mock') {
        try { directory = await admitNativeWorkspace(candidate); }
        catch (error) {
          if (!(error instanceof WorkspaceAdmissionError) || error.status !== 409) throw error;
          let selected: { directory: string; workspace_id: string };
          try { selected = await admitSelectedWorkspace(candidate); }
          catch (selectionError) {
            if (!(selectionError instanceof WorkspaceAdmissionError) || selectionError.status === 409) throw error;
            throw selectionError;
          }
          directory = selected.directory; workspaceId = selected.workspace_id;
        }
      }
      if (!directory) throw new WorkspaceAdmissionError('Workspace path is invalid.', 400);
      return c.json({ directory, ...(workspaceId ? { workspace_id: workspaceId } : {}) });
    } catch (error) {
      const failure = error instanceof WorkspaceAdmissionError ? error : new WorkspaceAdmissionError('NNA workspace identity is unavailable.', 503);
      return c.json({ error: { message: failure.message } }, failure.status as 400 | 409 | 503);
    }
  });
}
