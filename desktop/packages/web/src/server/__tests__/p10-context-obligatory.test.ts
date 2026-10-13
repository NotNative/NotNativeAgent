// SPDX-License-Identifier: Apache-0.0
import { describe, expect, it } from 'vitest';
import {
  OBLIGATORY_CURSOR_KEY,
  OBLIGATORY_KNOWLEDGE_KEY,
  OBLIGATORY_MESSAGES_KEY,
  OBLIGATORY_NAMESPACE,
  mergeObligatoryCursor,
  mergeObligatoryMessages,
  parseObligatoryMessages,
} from '../context/obligatory-messages.ts';
import { ContextObligatoryRuntime } from '../context/context-obligatory-runtime.ts';
import type { ContextRestorationPorts } from '../context/context-obligatory-runtime.ts';
import { ManualQueueFeed } from '../queue/queue-feed.ts';

const id = 'ses_context';

function pin(createdAt: number, text: string): unknown {
  return { info: { id: `message-${createdAt}`, role: 'user', time: { completed: createdAt } },
    parts: [{ type: 'text', text }] };
}

function model(): unknown {
  return { info: { id: 'assistant-tail', role: 'assistant', providerID: 'provider', modelID: 'model',
    agent: 'build', time: { completed: 9 } }, parts: [{ type: 'text', text: 'Done' }] };
}

function setup(metadata: Record<string, unknown> = {}) {
  const feed = new ManualQueueFeed();
  let knowledge: { text: string; signature: string } | null = null;
  let promptOk = true;
  let cursorOk = true;
  const prompts: unknown[] = [];
  const cursorWrites: Array<Record<string, unknown>> = [];
  const delivered: string[] = [];
  const resetKeys: string[] = [];
  const ports: ContextRestorationPorts = {
    readSession: async () => ({ id, metadata }),
    readMessages: async (_sessionId, _directory, limit) => {
      expect(limit).toBe(20);
      return [
        pin(1, 'Keep this requirement'), model(),
        { info: { id: 'summary-1', role: 'assistant', summary: true, time: { completed: 11 } }, parts: [] },
      ];
    },
    readMessage: async (_sessionId, _directory, messageId) => {
      if (messageId === 'message-1') return pin(1, 'Keep this requirement');
      if (messageId === 'message-2') return pin(2, '  ' + '\n\nEarlier requirement');
      throw new Error(`missing ${messageId}`);
    },
    resetKnowledgeDelivery: (resetSessionId, resetDirectory) => {
      resetKeys.push(`${resetSessionId}:${resetDirectory}`);
    },
    prepareKnowledge: async () => knowledge,
    sendPrompt: async (_sessionId, _directory, body) => {
      prompts.push(body);
      return { ok: promptOk };
    },
    writeCursor: async (_sessionId, _directory, cursorPatch) => {
      cursorWrites.push(cursorPatch);
      return cursorOk;
    },
  };
  const runtime = new ContextObligatoryRuntime(feed, ports,
    (sessionId, directory) => delivered.push(`${sessionId}:${directory}`));
  return { feed, ports, runtime, prompts, cursorWrites, delivered, resetKeys,
    emit: () => feed.emit({ directory: '/project', payload: { id: 'event', type: 'session.compacted',
      properties: { sessionID: id } } }),
    setKnowledge: (value: typeof knowledge) => { knowledge = value; },
    setPromptOk: (value: boolean) => { promptOk = value; },
    setCursorOk: (value: boolean) => { cursorOk = value; } };
}

describe('P10 obligatory message metadata', () => {
  it('drops malformed and duplicate messages while merging new pins', () => {
    const valid = { id: 'one', createdAt: 2, role: 'assistant' };
    const parsed = parseObligatoryMessages({ [OBLIGATORY_NAMESPACE]: {
      [OBLIGATORY_MESSAGES_KEY]: [null, { ...valid, createdAt: 'bad' }, valid, valid] } });
    expect(parsed).toEqual([valid]);
    const next = mergeObligatoryMessages({ [OBLIGATORY_NAMESPACE]: {
      [OBLIGATORY_MESSAGES_KEY]: parsed } }, { id: 'two', createdAt: 1, role: 'user' }, true);
    const messages = parseObligatoryMessages(next);
    expect(messages.map((message) => message.id)).toEqual(['one', 'two']);
    expect(mergeObligatoryMessages(next, messages[1]!, false)[OBLIGATORY_NAMESPACE])
      .toEqual({ [OBLIGATORY_MESSAGES_KEY]: [valid] });
  });

  it('writes cursor and knowledge signature together', () => {
    const metadata = mergeObligatoryCursor({ existing: true }, 'summary-9', 'signature-9');
    expect(readCursor(metadata)).toBe('summary-9');
    expect(readSignature(metadata)).toBe('signature-9');
    expect(readCursor(mergeObligatoryCursor(metadata, 'summary-10', null))).toBe('summary-10');
    expect(mergeObligatoryCursor(metadata, 'summary-10', null)[OBLIGATORY_NAMESPACE]).toEqual({
      [OBLIGATORY_CURSOR_KEY]: 'summary-10' });
  });
});

function readCursor(metadata: unknown): unknown {
  return (metadata as Record<string, Record<string, unknown>>)[OBLIGATORY_NAMESPACE]?.[OBLIGATORY_CURSOR_KEY];
}

function readSignature(metadata: unknown): unknown {
  return (metadata as Record<string, Record<string, unknown>>)[OBLIGATORY_NAMESPACE]?.[OBLIGATORY_KNOWLEDGE_KEY];
}

describe('P10 obligatory context runtime', () => {
  it('restores pins with knowledge and writes the compaction cursor once', async () => {
    const state = setup({ [OBLIGATORY_NAMESPACE]: { [OBLIGATORY_MESSAGES_KEY]: [
      { id: 'message-1', createdAt: 1, role: 'user' }, { id: 'gone', createdAt: 2, role: 'assistant' }] } });
    state.setKnowledge({ text: 'Remember delivery details', signature: 'signature-1' });
    await state.emit();
    await runtimeTick(state);
    expect(state.prompts).toHaveLength(1);
    const prompt = state.prompts[0] as { parts: Array<{ text: string }> };
    expect(prompt.parts[0]!.text).toContain('Remember delivery details');
    expect(prompt.parts[0]!.text).toContain('Keep this requirement');
    expect(state.cursorWrites).toEqual([{ [OBLIGATORY_CURSOR_KEY]: 'summary-1',
      [OBLIGATORY_KNOWLEDGE_KEY]: 'signature-1' }]);
    expect(state.delivered).toEqual([`${id}:/project`]);
    expect(state.resetKeys).toEqual([`${id}:/project`]);
  });

  it('restores individually fetched pins by createdAt and skips unreadable ones', async () => {
    const state = setup({ [OBLIGATORY_NAMESPACE]: { [OBLIGATORY_MESSAGES_KEY]: [
      { id: 'message-2', createdAt: 3, role: 'user' }, { id: 'message-1', createdAt: 1, role: 'user' },
      { id: 'gone', createdAt: 2, role: 'assistant' }] } });
    await state.emit();
    await runtimeTick(state);
    const prompt = state.prompts[0] as { parts: Array<{ text: string }> };
    expect(prompt.parts[0]!.text.indexOf('Keep this requirement')).toBeGreaterThan(0);
    expect(prompt.parts[0]!.text).toContain('Earlier requirement');
    expect(state.cursorWrites[0]![OBLIGATORY_KNOWLEDGE_KEY]).toBeUndefined();
  });

  it('restores knowledge alone and skips when there is no actionable context', async () => {
    const state = setup();
    state.setKnowledge({ text: 'Pending knowledge', signature: 'signature-2' });
    await state.emit();
    await runtimeTick(state);
    expect(state.prompts).toHaveLength(1);
    expect(state.cursorWrites[0]![OBLIGATORY_CURSOR_KEY]).toBe('summary-1');

    const empty = setup();
    await empty.emit();
    await runtimeTick(empty);
    expect(empty.prompts).toHaveLength(0);
  });

  it('stops on missing summary, stale cursor, missing model, failed send, and failed cursor', async () => {
    let state = setup();
    state.ports.readMessages = async () => [model()];
    await state.emit();
    await runtimeTick(state);
    expect(state.prompts).toHaveLength(0);

    state = setup({ [OBLIGATORY_NAMESPACE]: { [OBLIGATORY_CURSOR_KEY]: 'summary-1' } });
    await state.emit();
    await runtimeTick(state);
    expect(state.prompts).toHaveLength(0);

    state = setup({ [OBLIGATORY_NAMESPACE]: { [OBLIGATORY_MESSAGES_KEY]: [
      { id: 'message-1', createdAt: 1, role: 'user' }] } });
    state.ports.readMessages = async () => [
      pin(1, 'Keep this requirement'),
      { info: { id: 'assistant-tail', role: 'assistant', providerID: '', modelID: 'model', time: { completed: 9 } } },
      { info: { id: 'summary-1', role: 'assistant', summary: true, time: { completed: 11 } } }];
    await state.emit();
    await runtimeTick(state);
    expect(state.prompts).toHaveLength(0);

    state = setup({ [OBLIGATORY_NAMESPACE]: { [OBLIGATORY_MESSAGES_KEY]: [
      { id: 'message-1', createdAt: 1, role: 'user' }] } });
    state.setPromptOk(false);
    await state.emit();
    await runtimeTick(state);
    expect(state.prompts).toHaveLength(1);
    expect(state.cursorWrites).toHaveLength(0);

    state = setup({ [OBLIGATORY_NAMESPACE]: { [OBLIGATORY_MESSAGES_KEY]: [
      { id: 'message-1', createdAt: 1, role: 'user' }] } });
    state.setCursorOk(false);
    await state.emit();
    await runtimeTick(state);
    expect(state.cursorWrites).toHaveLength(1);
    expect(state.delivered).toHaveLength(0);
  });

  it('rejects child sessions, invalid events, and concurrent ticks for the same key', async () => {
    const state = setup({ [OBLIGATORY_NAMESPACE]: { [OBLIGATORY_MESSAGES_KEY]: [
      { id: 'message-1', createdAt: 1, role: 'user' }] } });
    state.ports.readSession = async () => ({ id, parentID: 'parent', metadata: {} });
    await state.emit();
    await runtimeTick(state);
    expect(state.prompts).toHaveLength(0);

    state.feed.emit({ payload: { id: 'bad', type: 'session.compacted', properties: { sessionID: id } } });
    await runtimeTick(state);
    expect(state.prompts).toHaveLength(0);

    let release: ((value: unknown) => void) | undefined;
    const held = new Promise((resolve) => { release = resolve; });
    state.ports.readSession = () => held as Promise<unknown>;
    const first = state.runtime.tick(id, '/project');
    const second = await state.runtime.tick(id, '/project');
    expect(second).toBe(false);
    release?.([]);
    expect(await first).toBe(false);
  });
});

async function runtimeTick(state: Awaited<ReturnType<typeof setup>>): Promise<boolean> {
  const result = state.runtime.tick(id, '/project');
  await Promise.resolve();
  await Promise.resolve();
  return result;
}
