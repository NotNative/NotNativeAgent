// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDirectoryStore } from '../../sync/child-store.ts';
import { sessionMarkdown, exportSession } from '../session-export.ts';
import type { Message, Part } from '../../lib/nnd/types.ts';

const message = (id: string, role: 'user' | 'assistant', created: number): Message =>
  ({ id, sessionID: 's1', role, time: { created } }) as Message;
const textPart = (id: string, messageID: string, text: string): Part =>
  ({ id, sessionID: 's1', messageID, type: 'text', text }) as Part;
const toolPart = (id: string, messageID: string): Part =>
  ({ id, sessionID: 's1', messageID, type: 'tool', callID: 'call-1' }) as Part;

function store(): ReturnType<typeof createDirectoryStore> {
  return createDirectoryStore({
    message: { s1: [message('u1', 'user', 1), message('a1', 'assistant', 2), message('u2', 'user', 3)] },
    part: {
      u1: [textPart('p1', 'u1', 'Fix the login bug')],
      a1: [textPart('p2', 'a1', 'Patch applied.'), toolPart('p3', 'a1')],
      u2: [textPart('p4', 'u2', 'thanks')],
    },
  });
}

describe('session transcript export (W-24.export)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('composes chronological prompt/reply markdown with a tool aside and no synthetic noise', () => {
    const markdown = sessionMarkdown(store(), 's1', 'Login session');
    expect(markdown.startsWith('# Login session\n')).toBe(true);
    expect(markdown).toContain('## ');
    expect(markdown).toContain('— Prompt\n\nFix the login bug');
    expect(markdown).toContain('— Reply\n\nPatch applied.');
    expect(markdown).toContain('> 1 tool call omitted');
    expect(markdown).toContain('thanks');
    expect(markdown.indexOf('Fix the login bug')).toBeLessThan(markdown.indexOf('Patch applied.'));
    expect(markdown.indexOf('Patch applied.')).toBeLessThan(markdown.indexOf('thanks'));
  });

  it('falls back to placeholders and the session id when content or title is missing', () => {
    const markdown = sessionMarkdown(store(), 's1');
    expect(markdown.startsWith('# s1\n')).toBe(true);
    const empty = sessionMarkdown(createDirectoryStore(), 's9');
    expect(empty).toContain('0 turns');
  });

  it('downloads the export as a sanitized .md file through an object URL', () => {
    const created: Blob[] = [];
    const revoked: string[] = [];
    vi.stubGlobal('URL', { createObjectURL: (blob: Blob) => { created.push(blob); return 'blob:x'; }, revokeObjectURL: (url: string) => revoked.push(url) });
    const clicks: string[] = [];
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(): void { clicks.push(this.download); };
    try {
      exportSession(store(), 's1', 'My: odd/ title?');
      expect(clicks).toEqual(['My_odd_title_.md']);
      expect(created).toHaveLength(1);
      expect(revoked).toEqual(['blob:x']);
    } finally { HTMLAnchorElement.prototype.click = original; vi.unstubAllGlobals(); }
  });
});
