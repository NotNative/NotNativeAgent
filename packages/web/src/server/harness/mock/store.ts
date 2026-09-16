/**
 * Mock harness state store (in-memory; the whole point of the mock is that it
 * is disposable). Directory scoping, caller message-id passthrough (doc 02
 * §11.14), authoritative status map (§11.1), and the pending permission /
 * question maps (§6.6–6.7) all live here.
 */
import { DEFAULT_DIRECTORY } from './fixtures.ts';
import type {
  MessageEntry,
  PermissionRequest,
  PermissionV2Request,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from '../../../../../ui/src/lib/nna/types.ts';

export const sessions = new Map<string, Session>();
export const entries = new Map<string, MessageEntry[]>();
export const todos = new Map<string, Todo[]>();
/** Only busy/retry live here; a successful snapshot makes omission=idle. */
export const sessionStatus = new Map<string, SessionStatus>();
export const pendingPermissions = new Map<string, PermissionRequest & { directory: string }>();
export const pendingPermissionsV2 = new Map<string, PermissionV2Request>();
export const pendingQuestions = new Map<string, QuestionRequest & { directory: string }>();
export const authStore = new Map<string, unknown>();

/** In-flight turns, keyed by session id (abort target). */
export interface ActiveTurn {
  aborted: boolean;
}
export const activeTurns = new Map<string, ActiveTurn>();

let idSeq = 0;
/** Monotonic ids like `ascendingId` (doc 02 §3.3): epoch-ordered prefix + counter. */
export function ascendingId(prefix: string): string {
  const epochPart = (Date.now() * 4096 + ++idSeq).toString(36).padStart(11, '0');
  const tail = Math.random().toString(36).slice(2, 16).padEnd(14, '0');
  return `${prefix}_${epochPart}_${tail}`;
}

/** HP-4 normalization (client rule, restated server-side). */
export function normalizeDirectory(input: string | null | undefined): string {
  if (!input) return DEFAULT_DIRECTORY;
  let value = input.trim().replaceAll('\\', '/');
  value = value.replace(/^([a-z]):/, (m, drive: string) => `${drive.toUpperCase()}:`);
  value = value.replace(/\/+$/, '');
  return value || '/';
}

/** Directory transports (§3.5a): header (percent-encoded, marker optional) → query → default. */
export function requestDirectory(request: Request, url: URL): string {
  const marker = request.headers.get('x-nnd-directory-encoding');
  const header = request.headers.get('x-nnd-directory');
  let raw: string | null = url.searchParams.get('directory');
  if (!raw && header) raw = marker === 'uri' ? decodeURIComponent(header) : header;
  return normalizeDirectory(raw);
}

export const sessionsInDirectory = (directory: string): Session[] =>
  [...sessions.values()]
    .filter((s) => s.directory === directory && s.time.archived === undefined)
    .sort((a, b) => b.time.updated - a.time.updated);
