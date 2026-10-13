// SPDX-License-Identifier: Apache-2.0
/**
 * Turn projection (doc 05 §C.1): user messages head turns; assistant messages
 * attach by parent adjacency; a renderable session needs explicit part buckets.
 * Operates over the FLATTENED presentation type (doc 05 §0.2).
 */
import type { PresentationMessage, Message } from '../lib/nnd/types.ts';

export interface ChatTurn {
  userMessage: PresentationMessage;
  assistant: PresentationMessage[];
  offset: number;
}

export function isRenderable(messages: PresentationMessage[] | undefined, partBucketOf: (messageID: string) => unknown): boolean {
  if (!messages || messages.length === 0) return false;
  return messages.every((message) => partBucketOf(message.id) !== undefined);
}

/** Project the chronological message array into turns. */
export function projectTurns(messages: Message[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const source of messages) {
    const message: PresentationMessage = source as unknown as PresentationMessage;
    if (message.role === 'user') {
      turns.push({ userMessage: message, assistant: [], offset: 0 });
      continue;
    }
    const current = turns.at(-1);
    if (current) current.assistant.push(message);
    else turns.push({ userMessage: message, assistant: [message], offset: 0 });
  }
  return turns.map((turn, index) => ({ ...turn, offset: index }));
}

/** The streaming tail: the LAST assistant message while it is unfinished. */
export function streamingTail(turns: ChatTurn[]): PresentationMessage | null {
  const last = turns.at(-1);
  if (!last || last.assistant.length === 0) return null;
  const trailing = last.assistant.at(-1)!;
  return trailing.time.completed === undefined ? trailing : null;
}

/** Has the turn settled (final answer or abort) — governance for Activity. */
export function turnSettled(turn: ChatTurn): boolean {
  const final = turn.assistant.at(-1);
  if (!final || final.time.completed === undefined) return false;
  return final.finish === 'stop' || final.finish === 'tool-calls' || final.error !== undefined;
}

/** §E.1 status derivation over the LIVE trailing assistant message. */
export type AssistantLiveStatus =
  | { kind: 'thinking' }
  | { kind: 'tool'; tool: string }
  | { kind: 'composing' }
  | null;

const TOOL_PHRASES: Record<string, string | undefined> = {
  read: 'reading file', write: 'writing file', edit: 'editing file',
  multiedit: 'editing files', apply_patch: 'applying patch', bash: 'running command',
  grep: 'searching content', glob: 'finding files', list: 'listing directory',
  task: 'delegating task', webfetch: 'fetching URL', websearch: 'searching web',
  codesearch: 'web code search', todowrite: 'updating todos', todoread: 'reading todos',
  skill: 'learning skill', question: 'asking question',
  plan_enter: 'switching to planning', plan_exit: 'switching to building',
};

export function toolPhrase(tool: string): string {
  return TOOL_PHRASES[tool] ?? `using ${tool}`;
}

export function assistantLiveStatus(partsOf: (messageID: string) => PartLite[] | undefined, messageID: string | undefined): AssistantLiveStatus {
  if (!messageID) return null;
  const parts = partsOf(messageID);
  if (!parts) return null;
  for (const part of [...parts].reverse()) {
    const running = part.state?.status === 'running' || part.state?.status === 'pending';
    if (part.type === 'reasoning' && (running || part.time?.end === undefined)) return { kind: 'thinking' };
    if (part.type === 'tool' && running) return { kind: 'tool', tool: part.tool ?? 'tool' };
  }
  const text = parts.find((part) => part.type === 'text' && part.time?.end === undefined);
  return text ? { kind: 'composing' } : null;
}

export interface PartLite {
  type: string;
  tool?: string;
  state?: { status?: string };
  time?: { start?: number; end?: number };
  text?: string;
  [key: string]: unknown;
}

/** Stable pseudo-random working phrase keyed by message id (§E.1). */
const WORKING_PHRASES = ['working', 'processing', 'preparing', 'warming up', 'gears turning', 'computing', 'calculating', 'analyzing', 'wheels spinning', 'calibrating', 'synthesizing', 'connecting dots', 'inspecting logic', 'weighing options'];

export function workingPhrase(messageID: string): string {
  let hash = 0;
  for (const ch of messageID) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return WORKING_PHRASES[Math.abs(hash) % WORKING_PHRASES.length]!;
}
