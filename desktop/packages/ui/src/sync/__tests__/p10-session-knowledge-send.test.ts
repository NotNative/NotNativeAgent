// SPDX-License-Identifier: Apache-2.0
/** P10-53 UI send-path knowledge rider (doc 15 §B.6). */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../lib/nnd/client.ts', () => import('./harness-client-mock.ts'));
vi.mock('../../lib/session-knowledge-api.ts', () => ({
  getSessionKnowledge: vi.fn(),
  recordSessionKnowledgeDelivered: vi.fn(),
}));
vi.mock('../../lib/runtime-switch.ts', () => ({
  getRuntimeKey: () => 'test-runtime',
  onRuntimeEndpointChanged: () => () => undefined,
}));

import { configureHarness, callsFor } from './harness-client-mock.ts';
import { getSessionKnowledge, recordSessionKnowledgeDelivered }
  from '../../lib/session-knowledge-api.ts';
import { createSyncEngine } from '../sync-engine.ts';
import { useConfigStore } from '../../stores/useConfigStore.ts';

const readKnowledge = vi.mocked(getSessionKnowledge);
const recordDelivered = vi.mocked(recordSessionKnowledgeDelivered);
const pending = (text = 'Standing context') => ({
  text, signature: 'a'.repeat(64), unavailable: false as const,
});

beforeEach(() => {
  configureHarness({ promptAsync: () => ({ error: undefined, response: { status: 204 } }) });
  useConfigStore.setState({ isConnected: true });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('session-knowledge send rider', () => {
  it('prepends pending knowledge and records delivery after prompt success', async () => {
    readKnowledge.mockResolvedValue(pending());
    recordDelivered.mockResolvedValue({ recorded: true });
    const engine = createSyncEngine();
    await engine.actions.send({
      directory: 'D:/work', sessionID: 'session-1',
      parts: [{ type: 'text', text: 'Question' }],
      model: { providerID: 'provider', modelID: 'model' },
    });
    expect(callsFor('promptAsync').length).toBe(1);
    expect(callsFor('promptAsync').at(0)?.body).toMatchObject({
      parts: [
        { type: 'text', text: 'Standing context', synthetic: true,
          systemContext: 'session-knowledge' },
        { type: 'text', text: 'Question' },
      ],
    });
    expect(recordDelivered).toHaveBeenCalledWith({
      directory: 'D:/work', sessionId: 'session-1', signature: 'a'.repeat(64),
    });
  });

  it('does not record delivery when the prompt fails or knowledge is unavailable', async () => {
    readKnowledge.mockResolvedValue({ ...pending(), unavailable: true, text: '', signature: '' });
    configureHarness({ promptAsync: () => Promise.reject(new Error('send failed')) });
    const engine = createSyncEngine();
    await expect(engine.actions.send({
      directory: 'D:/work', sessionID: 'session-1',
      parts: [{ type: 'text', text: 'Question' }],
      model: { providerID: 'provider', modelID: 'model' },
    })).rejects.toThrow('send failed');
    expect(callsFor('promptAsync').at(0)?.body).toMatchObject({ parts: [{ type: 'text', text: 'Question' }] });
    expect(recordDelivered).not.toHaveBeenCalled();
  });

it('records delivery when an ambiguous prompt is confirmed as landed', async () => {
  readKnowledge.mockResolvedValue(pending());
  recordDelivered.mockResolvedValue({ recorded: true });
  configureHarness({
    promptAsync: () => ({ error: 'transport died', response: undefined as never }),
    listMessages: () => {
      const sent = (callsFor('promptAsync').at(-1)?.body as { messageID?: string }).messageID;
      return { data: sent ? [{ info: { id: sent, sessionID: 'session-1' } }] : [], response: { status: 200 } };
    },
  });
  const engine = createSyncEngine();
  await engine.actions.send({
    directory: 'D:/work', sessionID: 'session-1',
    parts: [{ type: 'text', text: 'Question' }],
    model: { providerID: 'provider', modelID: 'model' },
  });
  expect(callsFor('listMessages')).toHaveLength(1);
  expect(recordDelivered).toHaveBeenCalledWith({
    directory: 'D:/work', sessionId: 'session-1', signature: 'a'.repeat(64),
  });
});

  it('continues the send when knowledge discovery fails', async () => {
    readKnowledge.mockRejectedValue(new Error('knowledge offline'));
    recordDelivered.mockResolvedValue({ recorded: true });
    const engine = createSyncEngine();
    await expect(engine.actions.send({
      directory: 'D:/work', sessionID: 'session-1',
      parts: [{ type: 'text', text: 'Question' }],
      model: { providerID: 'provider', modelID: 'model' },
    })).resolves.toBeUndefined();
    expect(callsFor('promptAsync').at(0)?.body).toMatchObject({
      parts: [{ type: 'text', text: 'Question' }],
    });
    expect(recordDelivered).not.toHaveBeenCalled();
  });
});
