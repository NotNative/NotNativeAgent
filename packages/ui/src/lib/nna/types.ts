/**
 * Harness wire shapes — doc 02 §5–§7. This file is the contract both the mock
 * harness (server) and the UI facade compile against; NNA must match it too.
 * Types only (erasable): the server imports it with `import type` so nothing
 * from the UI package enters the server runtime graph.
 */

export interface SessionTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface SessionDiffSummary {
  additions: number;
  deletions: number;
  files: number;
}

export interface Session {
  id: string;
  slug: string;
  projectID: string;
  workspaceID?: string;
  directory: string;
  path?: string;
  parentID?: string;
  summary?: SessionDiffSummary;
  cost?: number;
  tokens: SessionTokens;
  share?: { url?: string };
  title: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  version: string;
  metadata?: Record<string, unknown>;
  time: { created: number; updated: number; compacting?: number; archived?: number };
  permission?: Array<{ permission: string; pattern: string; action: 'allow' | 'deny' | 'ask' }>;
  revert?: { messageID: string; partID?: string; snapshot?: string; diff?: string };
}

export interface UserMessage {
  id: string;
  sessionID: string;
  role: 'user';
  time: { created: number };
  format?: { type: 'text' } | { type: 'json_schema'; schema: unknown; retryCount?: number };
  agent: string;
  model: { providerID: string; modelID: string; variant?: string };
  system?: string;
  tools?: Record<string, boolean>;
}

export interface AssistantMessage {
  id: string;
  sessionID: string;
  role: 'assistant';
  time: { created: number; completed?: number };
  error?: HarnessErrorObject;
  parentID?: string;
  modelID: string;
  providerID: string;
  mode?: string;
  agent?: string;
  path?: { cwd: string; root: string };
  cost?: number;
  tokens?: { total?: number } & Partial<SessionTokens>;
  variant?: string;
  finish?: string;
}

export type Message = UserMessage | AssistantMessage;

/** Error union — `name` strings are exact (doc 02 §6.2). */
export interface HarnessErrorObject {
  name:
    | 'ProviderAuthError'
    | 'UnknownError'
    | 'MessageOutputLengthError'
    | 'MessageAbortedError'
    | 'StructuredOutputError'
    | 'ContextOverflowError'
    | 'ContentFilterError'
    | 'APIError';
  /** Real harness errors nest details here; the server-synthesized restart
   *  error carries `message` at the top level instead. Both forms are legal. */
  data?: Record<string, unknown> & { message?: string };
  message?: string;
}

export type ToolState =
  | { status: 'pending'; input: Record<string, unknown>; raw: string }
  | { status: 'running'; input: Record<string, unknown>; title?: string; metadata?: Record<string, unknown>; time: { start: number } }
  | {
      status: 'completed';
      input: Record<string, unknown>;
      output: string;
      title: string;
      metadata: Record<string, unknown>;
      time: { start: number; end: number; compacted?: number };
      attachments?: FilePart[];
    }
  | { status: 'error'; input: Record<string, unknown>; error: string; metadata?: Record<string, unknown>; time: { start: number; end: number } };

export interface PartBase {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
}
export interface TextPart extends PartBase {
  type: 'text';
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
  metadata?: Record<string, unknown>;
}
export interface ReasoningPart extends PartBase {
  type: 'reasoning';
  text: string;
  time: { start: number; end?: number };
}
export interface FilePart extends PartBase {
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
}
export interface ToolPart extends PartBase {
  type: 'tool';
  callID: string;
  tool: string;
  state: ToolState;
  metadata?: Record<string, unknown>;
}
export interface StepFinishPart extends PartBase {
  type: 'step-finish';
  reason: string;
  cost?: number;
  tokens?: Partial<SessionTokens>;
}
export interface StepStartPart extends PartBase {
  type: 'step-start';
  snapshot?: string;
}
export type Part =
  | TextPart
  | ReasoningPart
  | FilePart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | (PartBase & Record<string, unknown>);

/** One history entry — REST returns `[{info, parts}]` ordered by time.created. */
export interface MessageEntry {
  info: Message;
  parts: Part[];
}

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled' | string;
  priority: 'high' | 'medium' | 'low' | string;
}

export type SessionStatus =
  | { type: 'idle' }
  | { type: 'busy' }
  | {
      type: 'retry';
      attempt: number;
      message: string;
      next: number;
      action?: { reason: string; provider: string; title: string; message: string; label: string; link?: string };
    };

export interface PermissionRequest {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
}

export interface PermissionV2Request {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  source?: { type: 'tool'; messageID: string; callID: string };
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
  custom?: boolean;
}

export interface QuestionRequest {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID: string; callID: string };
}

export interface Model {
  id: string;
  providerID: string;
  api?: { id: string; url?: string; npm?: string };
  name: string;
  capabilities?: Record<string, unknown>;
  cost?: Record<string, unknown>;
  limit?: { context?: number; input?: number; output?: number };
  status?: 'alpha' | 'beta' | 'deprecated' | 'active' | string;
  release_date?: string;
  variants?: Record<string, Record<string, unknown>>;
}

export interface Provider {
  id: string;
  name: string;
  source?: 'env' | 'config' | 'custom' | 'api' | string;
  env?: string[];
  key?: string;
  options?: Record<string, unknown>;
  models: Record<string, Model>;
}

export interface AgentInfo {
  name: string;
  description?: string;
  mode?: 'primary' | 'subagent' | 'all' | string;
  model?: string;
  hidden?: boolean;
  color?: string;
}

export interface CommandInfo {
  name: string;
  description?: string;
  agent?: string;
  model?: string;
  source?: string;
  template?: string;
}

export interface HarnessPath {
  home: string;
  state: string;
  config: string;
  worktree: string;
  directory: string;
}

export interface Project {
  id: string;
  worktree: string;
  vcs?: 'git' | string;
  name?: string;
  time: { created: number; updated: number; initialized?: number };
  sandboxes: string[];
}

export interface HarnessConfig extends Record<string, unknown> {
  model?: string;
  small_model?: string;
  default_agent?: string;
  username?: string;
}

export interface PromptPartInput {
  type: string;
  text?: string;
  synthetic?: boolean;
  mime?: string;
  filename?: string;
  url?: string;
  [key: string]: unknown;
}

export interface PromptAsyncBody {
  messageID?: string;
  model: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
  tools?: Record<string, boolean>;
  format?: unknown;
  system?: string;
  delivery?: 'steer' | 'queue';
  parts: PromptPartInput[];
}

/** §5.1 global-stream envelope; directory stream may also carry the bare payload. */
export interface GlobalEvent {
  directory?: string;
  payload: HarnessEventPayload;
}

export interface HarnessEventPayload {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}
