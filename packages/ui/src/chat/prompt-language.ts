// SPDX-License-Identifier: Apache-2.0
/**
 * Prompt language (doc 05 §B.3): plain-string document; the exact text sent
 * is the document. Token kinds, ONE active autocomplete trigger (precedence
 * command > skill > snippet > mention), and shell-mode normalization.
 */
import type { CommandInfo } from '../lib/nnd/types.ts';

export type PromptTokenKind = 'command' | 'skill' | 'snippet' | 'mention' | 'shell';

export interface PromptToken {
  kind: PromptTokenKind;
  name: string;
  start: number;
  end: number;
}

export interface AutocompleteTrigger {
  kind: 'command-or-skill' | 'snippet' | 'mention';
  query: string;
  tokenStart: number;
  tokenEnd: number;
}

const TRIGGER_PRECEDENCE: Record<string, number> = { command: 0, skill: 0, snippet: 0, mention: 0 };

/** Token inventory for a document: `/name` commands+skills, `#snippet`,
 * `@mention`; a leading `!document` is shell mode (the whole text). */
export function tokenizePrompt(document: string, registry: { commands: Set<string>; skills: Set<string>; snippets: ReadonlyMap<string, string>; agents: Set<string> }): PromptToken[] {
  const tokens: PromptToken[] = [];
  if (document.startsWith('!')) {
    tokens.push({ kind: 'shell', name: document.slice(1).trim(), start: 0, end: document.length });
    return tokens;
  }
  for (const match of document.matchAll(/([\/#@])([A-Za-z0-9_.\/\\-]+|[\w-]+)/gu)) {
    const kind: PromptTokenKind = match[1] === '/' ? memberKind(match[2]!, registry) : match[1] === '#' ? 'snippet' : 'mention';
    const start = match.index ?? 0;
    tokens.push({ kind, name: match[2]!, start, end: start + match[0].length });
  }
  return tokens.sort((a, b) => a.start - b.start);
}

function memberKind(name: string, registry: { commands: Set<string>; skills: Set<string> }): PromptTokenKind {
  if (registry.skills.has(name)) return 'skill';
  if (registry.commands.has(name)) return 'command';
  return 'command'; // membership authority; unknown stay prose via highlight consumer
}

/** The ONE active trigger at the caret, or null. Query is raw token text. */
export function activeTrigger(document: string, caret: number): AutocompleteTrigger | null {
  const before = document.slice(0, caret);
  const match = /(^|\s)([\/#@])([A-Za-z0-9_.\/\\-]*)$/u.exec(before);
  if (!match) return null;
  const prefix = match[2]!;
  const tokenStart = before.length - match[3]!.length - 1; // include the trigger char
  if (prefix === '#' && match[3] !== '') return { kind: 'snippet', query: match[3]!, tokenStart, tokenEnd: caret };
  if (prefix === '@') return { kind: 'mention', query: match[3] ?? '', tokenStart, tokenEnd: caret };
  // '/' opens command-or-skill even before letters; '#' requires letters so
  // hashtag-style prose never opens the picker mid-sentence
  if (prefix === '/') return { kind: 'command-or-skill', query: match[3] ?? '', tokenStart, tokenEnd: caret };
  return null;
}

export const TRIGGER_ORDER = Object.keys(TRIGGER_PRECEDENCE);

/** Shell-mode transitions (§B.3): `!` at caret 0 enters; empty backspace or
 * Escape exits; the `!` is auto-normalized away in the stored document. */
export function shellEnterCandidate(document: string, caret: number, typed: string): boolean {
  return document.length === 0 && caret === 0 && (typed === '!' || /^!\s*$/.test(typed));
}

export function exitShellOnBackspace(document: string): boolean {
  return document.length === 0;
}

/** Replace the token under (start, caret) with `replacement`, returning the
 * next caret position (token text + ONE trailing space kept for idioms). */
export function replaceTriggerToken(document: string, trigger: AutocompleteTrigger, replacement: string): { text: string; caret: number } {
  const head = document.slice(0, trigger.tokenStart);
  const tail = document.slice(trigger.tokenEnd);
  const text = `${head}${replacement} ${tail.replace(/^\s+/u, '')}`;
  return { text, caret: trigger.tokenStart + replacement.length + 1 };
}

/** §H.3/§H.2: expand `#snippet` tokens over text (failure keeps the
 * original; expansion is registry-driven and non-throwing). */
export function expandPrompt(text: string, snippets: Map<string, string>): string {
  return text.replace(/#([\w-]+)/gu, (whole, name: string) => snippets.get(name) ?? whole);
}

/** §H.7 exact instruction when a skill is named inline (registry exact casing). */
export function skillMentionInstruction(names: string[]): string | null {
  if (names.length === 0) return null;
  return `The user explicitly mentioned these skills in their message: ${names.map((n) => `/${n}`).join(', ')}. Use the corresponding skill tool when it is relevant to accomplishing the user's request.`;
}

/** Command classifier for submit planning (§H.1/B.9 step 1). */
export type PlannedCommandKind = 'action' | 'prompt' | 'transition' | 'unknown';

const ACTION_COMMANDS = new Set(['undo', 'redo', 'timeline', 'handoff-review', 'compact']);
const TRANSITION_COMMANDS = new Set(['btw']);

export function classifyCommand(name: string): PlannedCommandKind {
  if (ACTION_COMMANDS.has(name)) return 'action';
  if (TRANSITION_COMMANDS.has(name)) return 'transition';
  return 'prompt'; // registry-covered + magic prompts; 'unknown' resolves to plain prose at submit
}

/** Registry helper: exact-name membership set built from the harness catalog. */
export function commandRegistry(commands: CommandInfo[] | undefined, builtins: string[]): Set<string> {
  return new Set([...(commands ?? []).map((command) => command.name), ...builtins]);
}
