// SPDX-License-Identifier: Apache-2.0
/**
 * Sync engine state shapes (doc 04 §A.4). One DirectoryStore per normalized
 * directory; global sidecars live in their own stores and NEVER merge here.
 */
import type {
  AgentInfo,
  CommandInfo,
  HarnessConfig,
  HarnessPath,
  Message,
  MessageEntry,
  Part,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from '../lib/nnd/types.ts';

export type SessionListSource = 'empty' | 'persisted' | 'live' | 'authoritative';

export interface FileDiff {
  file: string;
  before?: string;
  after?: string;
  patch?: string;
  additions?: number;
  deletions?: number;
  status?: string;
}

export interface SyncState {
  status: 'loading' | 'partial' | 'complete';
  agent: AgentInfo[];
  command: CommandInfo[];
  project: string | null;
  projectMeta: Record<string, unknown>;
  icon: string | null;
  provider: unknown[];
  config: HarnessConfig | null;
  path: HarnessPath | null;
  session: Session[];
  sessionTotal: number;
  sessionListSource: SessionListSource;
  sessionRevision: number;
  sessionEventRevision: Record<string, number>;
  sessionDeletedRevision: Record<string, number>;
  session_status: Record<string, SessionStatus>;
  sessionStatusReady: boolean;
  session_diff: Record<string, FileDiff[]>;
  todo: Record<string, Todo[]>;
  permission: Record<string, PermissionRequest[]>;
  question: Record<string, QuestionRequest[]>;
  mcp: unknown;
  lsp: unknown[];
  vcs: { branch?: string } | null;
  limit: number;
  message: Record<string, Message[]>;
  part: Record<string, Part[]>;
}

export interface DirectoryStore extends SyncState {
  patch: (partial: Partial<SyncState>) => void;
  replace: (next: SyncState) => void;
}

export const INITIAL_STATE: SyncState = {
  status: 'loading',
  agent: [],
  command: [],
  project: null,
  projectMeta: {},
  icon: null,
  provider: [],
  config: null,
  path: null,
  session: [],
  sessionTotal: 0,
  sessionListSource: 'empty',
  sessionRevision: 0,
  sessionEventRevision: {},
  sessionDeletedRevision: {},
  session_status: {},
  sessionStatusReady: false,
  session_diff: {},
  todo: {},
  permission: {},
  question: {},
  mcp: null,
  lsp: [],
  vcs: null,
  limit: 5,
  message: {},
  part: {},
};

// ── constants (exact values, doc 04 §A.4 / §D.1) ────────────────────────────
export const MAX_DIR_STORES = 30;
export const EVICTION_GRACE_MS = 30_000;
export const DIR_IDLE_TTL_MS = 20 * 60_000;
export const SESSION_CACHE_LIMIT = 40; // desktop; 4 on constrained runtimes (deferred surfaces)

export const FLUSH_FRAME_MS = 33;
export const BACKPRESSURE_FLUSH_FRAME_MS = 200;
export const BACKPRESSURE_MODE_MS = 10_000;
export const STREAM_YIELD_MS = 8;
export const DEFAULT_RECONNECT_DELAY_MS = 250;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
export const WS_FALLBACK_WINDOW_MS = 60_000;
export const DEFAULT_WS_READY_TIMEOUT_MS = 2_000;
export const RETRY_BACKOFF_BASE_MS = 250;
export const RETRY_BACKOFF_CAP_VISIBLE_MS = 5_000;
export const RETRY_BACKOFF_CAP_HIDDEN_OR_OFFLINE_MS = 60_000;
export const RETRY_BACKOFF_MAX_EXPONENT = 8;
export const BOOT_DEBOUNCE_MS = 1500;

export const ACTIVE_SESSION_WATCHDOG_INTERVAL_MS = 5_000;
export const ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS = 5_000;
export const ACTIVE_SESSION_FULL_RESYNC_COOLDOWN_MS = 15_000;
export const STALE_STREAM_AFTER_MS = 20_000;
export const MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS = 750;
export const CHILD_SESSION_DISCOVERY_INTERVAL_MS = 15_000;

export const RECONNECT_MESSAGE_LIMIT = 30;
export const SESSION_MATERIALIZATION_MESSAGE_LIMIT = 30;
export const SESSION_MATERIALIZATION_COOLDOWN_MS = 5_000;
export const LIVE_STATUS_TTL_MS = 15_000;

export const SESSION_PAGE_SIZE = 50; // loader initial page (desktop)
export const SESSION_OLDER_PAGE_SIZE = 100;
export const INITIAL_EXPANSION_LIMITS = [100, 150];
export const DIRECTORY_SESSION_REFRESH_CONCURRENCY = 2;
export const GLOBAL_PAGE_SIZE = 500;

export const CONNECTION_GRACE_MS = 2_000;
export const SEND_CONFIRMATION_REFETCH_LIMIT = 30;
export const SEND_CONFIRMATION_RECONNECT_TIMEOUT_MS = 3_000;
export const SEND_CONFIRMATION_REFETCH_ATTEMPTS = 3;
export const MAX_RECORDED_SEND_FAILURES = 20;

export type MaterializationReason =
  | 'missing-owning-message'
  | 'orphan-delta'
  | 'missing-delta-part'
  | 'empty-assistant-message'
  | 'child-session-idle'
  | 'child-session-discovered'
  | 'ensure-session-messages'
  | 'stream-reconnect'
  | 'transport-switch'
  | 'stale-status-resync'
  | 'settled-running-tool'
  | 'boot-open';

export interface MaterializationRequest {
  reason: MaterializationReason;
  sessionID: string;
  /** for settled-running-tool / empty-assistant-message precision */
  messageID?: string;
}
