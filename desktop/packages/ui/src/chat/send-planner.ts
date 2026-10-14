// SPDX-License-Identifier: Apache-2.0
/**
 * Send planning (doc 05 §B.9/§B.11/§H.1/§H.7/§H.8 + §F.4). Pure over a
 * planning snapshot; the composer owns identity snapshots and engine calls.
 */
import { classifyCommand, expandPrompt, skillMentionInstruction, type PromptToken } from './prompt-language.ts';
import type { QueuedMessage } from './drafts.ts';

export interface SendTarget {
  sessionID: string | null; // null = create from draft
  directory: string;
  model: { providerID: string; modelID: string };
  agent?: string;
}

export interface PlannedSend {
  deliverable: { text: string; parts: ({ type: 'text'; text: string } | { type: 'file'; url?: string; filename?: string; mime?: string })[] } | null;
  localCommand: { name: string; kind: 'action' | 'transition' } | null;
  queueTarget: QueuedMessage | null;
  denyPermissions: boolean;
  rejectQuestions: boolean;
  delivery: 'steer' | null;
  skillInstruction: string | null;
  error: null | 'blocked-turn';
}

/** §B.9 step 1 scope: only command|skill tokens may head a send. */
function firstCommandToken(tokens: PromptToken[], text: string): PromptToken | null {
  const leadStart = text.search(/\S/u);
  if (leadStart < 0) return null;
  return tokens.find((token) => (token.kind === 'command' || token.kind === 'skill') && token.start === leadStart) ?? null;
}

export function planSend(input: {
  text: string;
  queued: QueuedMessage[];
  busy: boolean;
  blockedByPermission: boolean;
  blockedByQuestion: boolean;
  memorySettings: 'queue' | 'steer';
  targets?: SendTarget;
  snippets: Map<string, string>;
  tokens: PromptToken[];
  attachmentNames: string[];
}): PlannedSend {
  const base: PlannedSend = {
    deliverable: null, localCommand: null, queueTarget: null, denyPermissions: false,
    rejectQuestions: false, delivery: null, skillInstruction: skillNames(input.tokens).length ? skillMentionInstruction(skillNames(input.tokens)) : null,
    error: null,
  };
  if (input.blockedByPermission || input.blockedByQuestion) {
    // §F.4: sending is authoritative — clear blockers, queue for post-turn delivery
    return { ...base, denyPermissions: input.blockedByPermission, rejectQuestions: input.blockedByQuestion, queueTarget: buildQueued(input), error: null };
  }
  const leadingCommand = firstCommandToken(input.tokens, input.text);
  if (leadingCommand) {
    const kind = classifyCommand(leadingCommand.name);
    if (kind === 'action' || kind === 'transition') {
      return { ...base, localCommand: { name: leadingCommand.name, kind } };
    }
  }
  if (input.busy) {
    if (input.memorySettings === 'steer') return { ...base, deliverable: assemble(input), delivery: 'steer' };
    return { ...base, queueTarget: buildQueued(input) };
  }
  const deliverable = assemble(input);
  return { ...base, deliverable };
}

function assemble(input: { text: string; queued: QueuedMessage[]; snippets: Map<string, string>; attachmentNames: string[] }): PlannedSend['deliverable'] {
  const primary = expandPrompt(input.text, input.snippets);
  const parts: ({ type: 'text'; text: string } | { type: 'file'; url?: string; filename?: string; mime?: string })[] = [
    { type: 'text', text: primary },
    ...input.queued.map((item) => ({ type: 'text' as const, text: expandPrompt(item.text, input.snippets) })),
  ];
  return { text: primary, parts };
}

function buildQueued(input: { text: string; queued: QueuedMessage[]; tokens: PromptToken[]; attachmentNames: string[] }): QueuedMessage {
  return {
    id: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    text: input.text,
    mentions: input.tokens.filter((token) => token.kind === 'mention').map((token) => token.name),
    attachments: input.attachmentNames.map((name) => ({ name, mime: 'application/octet-stream' })),
    queuedAt: Date.now(),
  };
}

function skillNames(tokens: PromptToken[]): string[] {
  return [...new Set(tokens.filter((token) => token.kind === 'skill').map((token) => token.name))];
}

/** §B.9 error mapping label family (toast text selection is composer-side). */
export function sendErrorKind(error: unknown): 'payload-too-large' | 'runtime-changed' | 'busy' | 'transport' | 'server' | 'unknown' {
  const status = (error as { status?: number })?.status;
  if (status === 413) return 'payload-too-large';
  const message = String((error as { message?: string })?.message ?? error);
  if (/runtime (changed|switch)/iu.test(message)) return 'runtime-changed';
  // Why: NNA validates busy state itself and refuses a submission against an
  // active turn with the structured code `session_busy` (409, "NND session
  // already has an active turn"). Prefer that code when the client preserved
  // it — machine state is authoritative (CTL-DATA) — and keep the prose match
  // only as the fallback for paths that dropped the code before this
  // classifier ran. Other 409 conflicts (an upload conflict, a duplicate id)
  // carry no busy marker and keep the generic label.
  const code = (error as { code?: string })?.code;
  if (code === 'session_busy') return 'busy';
  if (code) return status === undefined ? 'unknown' : 'server';
  if (/session_busy|already has an active turn/iu.test(message)) return 'busy';
  if (/timeout|network|failed to fetch|gateway|econnreset|socket/iu.test(message)) return 'transport';
  if (status !== undefined) return 'server';
  return 'unknown';
}
