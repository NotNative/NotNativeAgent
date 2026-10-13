// SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import type { Message, Part } from '../../lib/nnd/types.ts';
import { contextMessageLedger } from '../context-message-ledger.ts';

const message = (id: string, role: 'user' | 'assistant', created: number): Message =>
  ({ id, sessionID: 's1', role, time: { created } }) as Message;
const part = (messageID: string, type: string, payload = {}): Part =>
  ({ id: `${messageID}:${type}`, sessionID: 's1', messageID, type, ...payload }) as Part;

it('shows newest loaded metadata and reported tokens without exposing part content', () => {
  const rows = contextMessageLedger([
    message('u1', 'user', 1),
    { ...message('a1', 'assistant', 2), tokens: { input: 123, output: 8 } } as Message,
  ], {
    u1: [part('u1', 'text', { text: 'private user message' })],
    a1: [part('a1', 'reasoning', { text: 'private chain of thought' }), part('a1', 'tool', { output: 'secret' }), part('a1', 'text', { text: 'answer' })],
  });
  expect(rows.map((row) => row.id)).toEqual(['a1', 'u1']);
  expect(rows[0]).toMatchObject({ role: 'assistant', kinds: 'reasoning + text + tool', input: 123, output: 8 });
  expect(rows[1]).toMatchObject({ role: 'user', kinds: 'text', input: null, output: null });
  expect(JSON.stringify(rows)).not.toMatch(/private|secret|answer/);
});

it('caps the ledger without claiming absent history and rejects invalid time or token figures', () => {
  const messages = Array.from({ length: 120 }, (_, at) => message(`m${at}`, 'assistant', at === 119 ? Number.MAX_VALUE : at + 1));
  const rows = contextMessageLedger(messages, {});
  expect(rows).toHaveLength(100);
  expect(rows[0]).toMatchObject({ id: 'm119', created: null, kinds: 'no loaded parts', input: null, output: null });
  expect(rows.at(-1)?.id).toBe('m20');
});
