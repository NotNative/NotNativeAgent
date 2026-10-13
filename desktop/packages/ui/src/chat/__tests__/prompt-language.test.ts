// SPDX-License-Identifier: Apache-2.0
/**
 * Prompt language (doc 05 §B.3) gates: token inventory, single active
 * trigger with precedence, shell transitions, token replacement, snippet
 * expansion, and the exact §H.7 skill-mention instruction string.
 */
import { describe, expect, it } from 'vitest';
import { activeTrigger, classifyCommand, commandRegistry, expandPrompt, replaceTriggerToken, shellEnterCandidate, skillMentionInstruction, tokenizePrompt } from '../prompt-language.ts';

const registry = {
  commands: commandRegistry([{ name: 'review' } as never], ['undo', 'redo', 'compact']),
  skills: new Set(['skillx']),
  snippets: new Map([['sig', 'best regards']]),
  agents: new Set(['build']),
};

describe('tokenizePrompt', () => {
  it('inventories commands, skills, snippets, mentions in document order', () => {
    const tokens = tokenizePrompt('use /review and /skillx plus #sig with @build', registry);
    expect(tokens.map((token) => token.kind)).toEqual(['command', 'skill', 'snippet', 'mention']);
    expect(tokens.map((token) => token.name)).toEqual(['review', 'skillx', 'sig', 'build']);
  });

  it('shell mode collapses the whole document to one shell token', () => {
    const tokens = tokenizePrompt('!npm test', registry);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ kind: 'shell', name: 'npm test' });
  });
});

describe('activeTrigger', () => {
  it('returns the single active trigger at the caret with the raw query', () => {
    expect(activeTrigger('do /rev', 7)).toMatchObject({ kind: 'command-or-skill', query: 'rev' });
    expect(activeTrigger('do #sig', 7)).toMatchObject({ kind: 'snippet', query: 'sig' });
    expect(activeTrigger('ping @bu', 8)).toMatchObject({ kind: 'mention', query: 'bu' });
  });

  it('never opens mid-prose: the trigger char must sit at a boundary', () => {
    expect(activeTrigger('plain', 5)).toBeNull();
  });
});

describe('shell transitions and replacement', () => {
  it('shellEnter requires an empty document and caret 0', () => {
    expect(shellEnterCandidate('', 0, '!')).toBe(true);
    expect(shellEnterCandidate('run', 0, '!')).toBe(false);
    expect(shellEnterCandidate('', 1, '!')).toBe(false);
  });

  it('replaceTriggerToken swaps the token (prefix included) and parks after one space', () => {
    const document = 'run /compact now';
    const trigger = activeTrigger(document, 12)!; // caret at the end of '/compact'
    const result = replaceTriggerToken(document, trigger, '/undo');
    expect(result.text).toBe('run /undo now');
    expect(result.caret).toBe(10);
  });

  it('expandPrompt swaps known snippets and leaves unknown tokens as prose', () => {
    expect(expandPrompt('sign #sig and #unknown', registry.snippets)).toBe('sign best regards and #unknown');
  });
});

describe('command classification + skill instruction', () => {
  it('classifies the §H.1 action family; everything else is a prompt command', () => {
    expect(classifyCommand('undo')).toBe('action');
    expect(classifyCommand('compact')).toBe('action');
    expect(classifyCommand('review')).toBe('prompt');
    expect(commandRegistry(undefined, ['x']).has('x')).toBe(true);
  });

  it('emits the EXACT §H.7 skill-mention instruction, empty when none', () => {
    expect(skillMentionInstruction([])).toBeNull();
    expect(skillMentionInstruction(['skillx'])).toBe("The user explicitly mentioned these skills in their message: /skillx. Use the corresponding skill tool when it is relevant to accomplishing the user's request.");
  });
});
