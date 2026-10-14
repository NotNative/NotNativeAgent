// SPDX-License-Identifier: Apache-2.0
/**
 * Message-queue item schema (doc 12 §D.1, server-side canonical). `content`
 * is the raw user text for display/editing (newline edges trimmed, ≤ 200 000
 * chars); `text` defaults to content with the leading agent mention stripped
 * (delivered later as an {type:'agent',name} part AFTER everything else).
 * Attachments parse fully or the WHOLE item rejects — a queue must never
 * hold an item the server cannot deliver later. Context parts ride verbatim
 * as the courier (the metadata object is the UI's payload); only the
 * envelope is validated. `dataUrl` never joins a public snapshot.
 */
import { randomBytes } from 'node:crypto';

export const QUEUE_CONTENT_MAX_CHARS = 200_000;
export const QUEUE_CONTEXT_PREVIEW_MAX_CHARS = 103;
export const QUEUE_SNAPSHOT_PREVIEW_MAX_CHARS = 100;
/** The item id doubles as the NNA submission's idempotency identity
 *  (`messageID`), so NEW ids must satisfy NNA's bounded external-id rule;
 *  legacy stored ids that do not match simply ride without the identity
 *  (dispatch omits `messageID` for them — compatibility, never a send block). */
export const QUEUE_ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type AttachmentSource = 'local' | 'server' | 'vscode';

export interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  source: AttachmentSource;
  serverPath?: string;
  dataUrl: string;
}

export type ContextPart =
  | { kind: 'context'; text: string; metadata: object; instructions?: string }
  | { kind: 'instruction'; text: string }
  | { kind: 'synthetic'; text: string };

export interface SendConfig {
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
}

export interface QueueItem {
  id: string;
  createdAt: number;
  content: string;
  text: string;
  agentMention?: string;
  attachments: Attachment[];
  context: ContextPart[];
  contextPreview?: string;
  sendConfig: SendConfig;
}

/** Parse rejection: HTTP 400 through the route family (§D.1). */
export class QueueItemValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueItemValidationError';
  }
}

/** Duplicate/conflicting enqueue: HTTP 409 through the route family (F9). */
export class QueueItemConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueueItemConflictError';
  }
}

/** `queued-<ms>-<rand 7>` (§D.1). The random tail is hex; 7 chars only. */
export function newQueueItemId(): string {
  return `queued-${Date.now()}-${randomBytes(7).toString('hex').slice(0, 7)}`;
}

/** Trim `\n` runs at both ends only (interior newlines are content). */
export function trimNewlineEdges(text: string): string {
  return text.replace(/^[\n]+/u, '').replace(/[\n]+$/u, '');
}

function fail(message: string): never {
  throw new QueueItemValidationError(message);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = requireString(value, field);
  return text.trim() === '' ? undefined : text;
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function parseAttachmentSource(value: unknown): AttachmentSource {
  return value === 'server' || value === 'vscode' ? value : 'local'; // unknown source coerces local (§D.1)
}

function shortRandom(length: number): string {
  return randomBytes(length + 2).toString('hex').slice(0, length);
}

function parseAttachment(raw: unknown, index: number): Attachment {
  const entry = asObject(raw, `attachments[${index}]`);
  const attachment: Attachment = {
    id: optionalString(entry.id, `attachments[${index}].id`) ?? `att-${shortRandom(7)}`,
    filename: requireString(entry.filename, `attachments[${index}].filename`),
    mimeType: requireString(entry.mimeType, `attachments[${index}].mimeType`),
    size: typeof entry.size === 'number' && Number.isFinite(entry.size) ? entry.size : 0,
    source: parseAttachmentSource(entry.source),
    dataUrl: requireString(entry.dataUrl, `attachments[${index}].dataUrl`),
  };
  const serverPath = optionalString(entry.serverPath, `attachments[${index}].serverPath`);
  if (serverPath) attachment.serverPath = serverPath;
  return attachment;
}

function parseContextEntry(raw: unknown, index: number): ContextPart {
  const entry = asObject(raw, `context[${index}]`);
  const kind = entry.kind;
  const text = requireString(entry.text, `context[${index}].text`);
  if (kind === 'instruction') return { kind: 'instruction', text };
  if (kind === 'synthetic') return { kind: 'synthetic', text };
  if (kind === 'context') {
    // The metadata object is REQUIRED on context kind (§D.1): a context part
    // without its UI payload cannot be rendered back, so the item rejects.
    const metadata = entry.metadata;
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      fail(`context[${index}].metadata must be an object`);
    }
    const part: ContextPart = { kind: 'context', text, metadata: metadata as object };
    const instructions = optionalString(entry.instructions, `context[${index}].instructions`);
    if (instructions) part.instructions = instructions;
    return part;
  }
  fail(`context[${index}].kind must be context|instruction|synthetic`);
}

function parseSendConfig(raw: unknown): SendConfig {
  const entry = asObject(raw, 'sendConfig');
  const providerID = requireString(entry.providerID, 'sendConfig.providerID').trim();
  const modelID = requireString(entry.modelID, 'sendConfig.modelID').trim();
  if (providerID === '' || modelID === '') fail('sendConfig requires providerID and modelID');
  const config: SendConfig = { providerID, modelID };
  const agent = optionalString(entry.agent, 'sendConfig.agent');
  const variant = optionalString(entry.variant, 'sendConfig.variant');
  if (agent) config.agent = agent;
  if (variant) config.variant = variant;
  return config;
}

/** Leading `@name` mention stripped (composer idiom; the name rides the
 *  {type:'agent'} part at dispatch). Registry verification absent today. */
export function stripAgentMention(text: string): { text: string; agentMention?: string } {
  const mention = /^@([^\s@]+)\s?/u.exec(text);
  if (!mention) return { text };
  return { text: text.slice(mention[0]!.length).trimStart(), agentMention: mention[1]! };
}

/** §D.1 parse — the single entry path from the route; throws on anything the
 *  server could not deliver faithfully an offline tab/phone lifetime later. */
export function parseQueuedItemInput(raw: unknown): QueueItem {
  const body = asObject(raw, 'item');
  const content = trimNewlineEdges(requireString(body.content, 'content'));
  if (content.length > QUEUE_CONTENT_MAX_CHARS) fail(`content exceeds ${QUEUE_CONTENT_MAX_CHARS} chars`);
  const suppliedText = optionalString(body.text, 'text');
  const stripped = stripAgentMention(trimNewlineEdges(suppliedText ?? content));
  const attachments = Array.isArray(body.attachments)
    ? (body.attachments as unknown[]).map((entry, index) => parseAttachment(entry, index))
    : [];
  const context = Array.isArray(body.context)
    ? (body.context as unknown[]).map((entry, index) => parseContextEntry(entry, index))
    : [];
  if (stripped.text === '' && attachments.length === 0 && context.length === 0) {
    fail('queued item requires text, attachments, or context');
  }
  if (!body.sendConfig) fail('sendConfig with providerID+modelID is required');
  const suppliedId = optionalString(body.id, 'id');
  // The id doubles as the NNA submission identity (F9): a supplied id must
  // satisfy NNA's bounded external-id rule, else the eventual send could
  // never be idempotent. Server-generated ids always match by construction.
  if (suppliedId !== undefined && !QUEUE_ITEM_ID_PATTERN.test(suppliedId)) {
    fail('id must be a bounded item identifier');
  }
  const item: QueueItem = {
    id: suppliedId ?? newQueueItemId(),
    createdAt: typeof body.createdAt === 'number' && Number.isFinite(body.createdAt) ? body.createdAt : Date.now(),
    content,
    text: stripped.text,
    attachments,
    context,
    sendConfig: parseSendConfig(body.sendConfig),
  };
  const contextPreview = optionalString(body.contextPreview, 'contextPreview');
  if (stripped.agentMention) item.agentMention = stripped.agentMention;
  if (contextPreview) item.contextPreview = contextPreview.slice(0, QUEUE_CONTEXT_PREVIEW_MAX_CHARS);
  return item;
}

/** Duplicate-retry comparison for idempotent enqueue (F9): the payload WITHOUT
 *  the arrival stamp, projected with explicit fields so key order from a disk
 *  round-trip can never flip the answer. */
export function sameQueuePayload(left: QueueItem, right: QueueItem): boolean {
  const project = (item: QueueItem): string => JSON.stringify({
    content: item.content,
    text: item.text,
    agentMention: item.agentMention ?? null,
    attachments: item.attachments.map((attachment) => ({
      id: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType,
      size: attachment.size, source: attachment.source,
      serverPath: attachment.serverPath ?? null, dataUrl: attachment.dataUrl,
    })),
    context: item.context,
    sendConfig: item.sendConfig,
    contextPreview: item.contextPreview ?? null,
  });
  return project(left) === project(right);
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

/** Snapshot preview (§D.1): ≤ 100-char first line + `...` when narrowed;
 *  legacy chain for preview-less items: attached comment metadata text,
 *  then the first non-instruction context text, then the delivered text. */
export function deriveSnapshotPreview(item: QueueItem): string {
  const head = firstLine(item.content);
  if (head !== '') {
    const truncated = head.length > QUEUE_SNAPSHOT_PREVIEW_MAX_CHARS || trimNewlineEdges(item.content.slice(head.length)).length > 0;
    return truncated ? `${head.slice(0, QUEUE_SNAPSHOT_PREVIEW_MAX_CHARS)}...` : head;
  }
  const contextEntries = item.context.filter((part) => part.kind !== 'instruction');
  const commentText = contextEntries
    .map((part) => (part.kind === 'context' ? (part as { metadata?: { text?: unknown } }).metadata?.text : undefined))
    .find((value): value is string => typeof value === 'string' && value.trim() !== '');
  const fallback = commentText ?? contextEntries[0]?.text ?? firstLine(item.text).slice(0, QUEUE_SNAPSHOT_PREVIEW_MAX_CHARS);
  if (fallback.trim() === '') return '';
  return fallback.length > QUEUE_SNAPSHOT_PREVIEW_MAX_CHARS ? `${fallback.slice(0, QUEUE_SNAPSHOT_PREVIEW_MAX_CHARS)}...` : fallback;
}

/** Public projection shape (§D.1/§D.6): dataUrl dropped, context dropped,
 *  preview derived — the take routes return the FULL stored item instead. */
export interface PublicQueueItem {
  id: string;
  createdAt: number;
  content: string;
  text: string;
  agentMention?: string;
  attachments: Array<{ id: string; filename: string; mimeType: string; size: number; source: AttachmentSource; serverPath?: string }>;
  contextPreview?: string;
  preview: string;
  sendConfig: SendConfig;
}

export function publicQueueItem(item: QueueItem): PublicQueueItem {
  const output: PublicQueueItem = {
    id: item.id,
    createdAt: item.createdAt,
    content: item.content,
    text: item.text,
    attachments: item.attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      source: attachment.source,
      ...(attachment.serverPath ? { serverPath: attachment.serverPath } : {}),
    })),
    preview: deriveSnapshotPreview(item),
    sendConfig: item.sendConfig,
  };
  if (item.agentMention) output.agentMention = item.agentMention;
  if (item.contextPreview) output.contextPreview = item.contextPreview;
  return output;
}
