// SPDX-License-Identifier: Apache-2.0
/** P9-5d execution core: title-linked source discovery, last assistant
 * extraction, magic-prompt fusion composition, and launch dispatch. */
import { StoreApi } from 'zustand/vanilla';
import { describe, expect, it, vi } from 'vitest';
import type { MessageEntry, Part, Session } from '../../nnd/types.ts';
import { INITIAL_STATE } from '../../../sync/types.ts';
import { create } from 'zustand';
import type { DirectoryStore } from '../../../sync/types.ts';
import {
  collectFusionSources,
  composeFusionPrompt,
  fusionIdentityFromSession,
  renderMagicPrompt,
  resolveFusionOutputs,
  startFusion,
} from '../fusion.ts';

function session(input: { id: string; title: string; directory: string; created: number; project?: string }): Session {
  return {
    id: input.id,
    slug: input.title,
    projectID: 'project',
    directory: input.directory,
    title: input.title,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    version: '1',
    metadata: { ...(input.project ? { projectDirectory: input.project } : {}) },
    time: { created: input.created, updated: input.created },
  } as never;
}

function store(sessions: Session[], messages: Record<string, { message: MessageEntry['info']; parts: Part[] }> = {}): StoreApi<DirectoryStore> {
  const state = structuredClone(INITIAL_STATE);
  state.session = sessions;
  for (const [messageID, entry] of Object.entries(messages)) {
    state.message[entry.message.sessionID] = [entry.message];
    state.part[messageID] = entry.parts;
  }
  return create(() => state as never) as unknown as StoreApi<DirectoryStore>;
}

const trigger = session({ id: 's_trigger', title: 'rework/openai/alpha', directory: 'C:/repo', created: 10 });

describe('fusion title collection', () => {
  it('selects matching non-fusion runs by group, run group, and project directory', () => {
    const matching = session({ id: 's_match', title: 'rework/mock/fast', directory: 'C:/wt-match', created: 1, project: 'C:/repo' });
    const archived = session({ id: 's_archived', title: 'rework/anthropic/long', directory: 'C:/wt-old', created: 2, project: 'C:/repo' });
    const otherProject = session({ id: 's_other', title: 'rework/gemini/others', directory: 'C:/wt-other', created: 3, project: 'C:/elsewhere' });
    const otherRunGroup = session({ id: 's_group', title: 'g1/rework/gemini/group', directory: 'C:/wt-g1', created: 4, project: 'C:/repo' });
    const otherGroup = session({ id: 's_other-group', title: 'other/openai/solo', directory: 'C:/wt-other-group', created: 5, project: 'C:/repo' });
    const fusion = session({ id: 's_fusion', title: 'rework/openai/alpha/fusion', directory: 'C:/wt-fusion', created: 6, project: 'C:/repo' });
    const duplicate = { ...matching, id: 's_match', time: { created: 99, updated: 99 } };
    const stores = new Map([
      ['C:/wt-match', store([])],
      ['C:/wt-old', store([])],
      ['C:/wt-other', store([])],
      ['C:/wt-g1', store([])],
      ['C:/wt-other-group', store([])],
      ['C:/wt-fusion', store([])],
    ]);
    stores.set('C:/repo', store([duplicate]));
    const sources = collectFusionSources(trigger, {
      storeOfDirectory: (directory) => stores.get(directory),
      directoryOfSession: () => undefined,
      globalActive: () => [matching],
      globalArchived: () => [archived],
      currentStore: () => stores.get('C:/repo')!,
    });
    expect(sources.map((source) => source.session.id)).toEqual(['s_match', 's_archived', 's_trigger']);
  });

  it('exposes only a parsed non-fusion title as a fusion identity', () => {
    expect(fusionIdentityFromSession(trigger)?.groupSlug).toBe('rework');
    expect(fusionIdentityFromSession(session({ id: 'f', title: 'rework/openai/alpha/fusion', created: 1, directory: 'x' }))).toBeNull();
    expect(fusionIdentityFromSession(session({ id: 'n', title: '普通会话', created: 1, directory: 'x' }))).toBeNull();
  });
});

describe('fusion output resolution', () => {
  it('uses local assistant text, falls back remotely, and drops empty outputs', async () => {
    const local = session({ id: 's_local', title: 'rework/local/model', directory: 'C:/wt-local', created: 1, project: 'C:/repo' });
    const remote = session({ id: 's_remote', title: 'rework/remote/model', directory: 'C:/wt-remote', created: 2, project: 'C:/repo' });
    const empty = session({ id: 's_empty', title: 'rework/empty/model', directory: 'C:/wt-empty', created: 3, project: 'C:/repo' });
    const stores = new Map([
      ['C:/wt-local', store([local], {
        msg_local: {
          message: {
            id: 'msg_local', sessionID: 's_local', role: 'assistant', time: { created: 4 },
          } as never,
          parts: [
            { id: 'hidden', sessionID: '', messageID: 'msg_local', type: 'text', text: 'hidden', synthetic: true },
            { id: 'visible', sessionID: '', messageID: 'msg_local', type: 'text', text: 'Local output' },
          ] as never,
        },
      })],
      ['C:/wt-empty', store([empty])],
      ['C:/repo', store([])],
    ]);
    const sources = collectFusionSources(trigger, {
      storeOfDirectory: (directory) => stores.get(directory),
      directoryOfSession: () => undefined,
      globalActive: () => [local, remote, empty],
      globalArchived: () => [],
      currentStore: () => stores.get('C:/repo')!,
    });
    const listMessages = vi.fn().mockImplementation(async (request: { sessionID: string }) => {
      if (request.sessionID === 's_empty') return [
        {
          info: { id: 'msg_empty', role: 'assistant', time: { created: 5 }, error: undefined },
          parts: [{ id: 'empty', sessionID: '', messageID: 'msg_empty', type: 'text', text: '   ' }],
        },
      ] as never;
      return [
        {
          info: { id: 'msg_remote', role: 'assistant', time: { created: 5 }, error: undefined },
          parts: [{ id: 'remote', sessionID: '', messageID: 'msg_remote', type: 'text', text: 'Remote output' }],
        },
      ] as never;
    });
    const outputs = await resolveFusionOutputs(sources.filter((source) => source.session.id !== 's_trigger'), {
      storeOfDirectory: (directory) => stores.get(directory),
      directoryOfSession: () => undefined,
      listMessages,
    });
    expect(listMessages).toHaveBeenCalledTimes(2);
    expect(outputs.map((output) => output.text)).toEqual(['Local output', 'Remote output']);
  });
});

describe('fusion prompt and launch', () => {
  it('renders overrides and packages result blocks as synthetic parts', () => {
    expect(renderMagicPrompt('{{sourceCount}} {{unknown}} {{}}', { sourceCount: 'two' })).toBe('two {{unknown}} {{}}');
    const prompt = composeFusionPrompt([
      { source: { session: trigger, projectDirectory: 'p', sessionDirectory: 'p' }, title: 'Run 1', text: 'First' },
    ], { 'session.fusion.visible': 'Fusing {{sourceCount}}: {{sourceLabels}}', 'session.fusion.instructions': 'Combine.' });
    expect(prompt.visibleParts[0]).toEqual({ type: 'text', text: 'Fusing 1: 1. Run 1' });
    expect(prompt.hiddenParts.at(0)?.synthetic).toBe(true);
    expect(prompt.hiddenParts.some((part) => part.text.includes('--- RESULT 1: Run 1 ---\nFirst\n--- END RESULT 1 ---'))).toBe(true);
    expect(prompt.hiddenParts.at(-1)?.text).toContain('--- FUSION INPUTS END ---');
  });

  it('creates, switches, closes, and dispatches one fusion turn', async () => {
    const one = session({ id: 's_one', title: 'rework/openai/one', directory: 'C:/wt-one', created: 1, project: 'C:/repo' });
    const storeApi = store([one]);
    const created = session({ id: 's_fused', title: 'rework/gemini/large/fusion', directory: 'C:/repo', created: 100, project: 'C:/repo' });
    const createSession = vi.fn().mockResolvedValue(created);
    const selectCurrentSession = vi.fn();
    const closeDialog = vi.fn();
    const send = vi.fn().mockResolvedValue(undefined);
    const listMessages = vi.fn().mockResolvedValue([
      {
        info: { id: 'msg_one', role: 'assistant', time: { created: 2 }, error: undefined },
        parts: [{ id: 'p', sessionID: '', messageID: 'msg_one', type: 'text', text: 'First answer' }],
      },
    ] as never);
    const result = await startFusion(
      {
        trigger,
        identity: fusionIdentityFromSession(trigger)!,
        model: { providerID: 'gemini', modelID: 'large', variant: 'thinking' },
        agent: 'nna',
      },
      {
        candidates: {
          storeOfDirectory: () => storeApi,
          directoryOfSession: () => undefined,
          globalActive: () => [],
          globalArchived: () => [],
          currentStore: () => store([one]),
        },
        createSession,
        selectCurrentSession,
        closeDialog,
        listMessages,
        listMagicPromptOverrides: async () => ({}),
        send,
      },
    );
    expect(result.sourceCount).toBe(2);
    expect(createSession).toHaveBeenCalledWith({ directory: 'C:/repo', title: 'rework/gemini/large/fusion' });
    expect(selectCurrentSession).toHaveBeenCalledWith({ sessionID: 's_fused', directory: 'C:/repo' });
    expect(closeDialog).toHaveBeenCalledBefore(send);
    expect(send).toHaveBeenCalledWith({
      directory: 'C:/repo',
      sessionID: 's_fused',
      parts: expect.arrayContaining([
        { type: 'text', text: 'Reconcile the following 2 competing outputs into a single final answer.' },
        { type: 'text', text: expect.stringContaining('--- RESULT 1: rework/openai/one ---\nFirst answer'), synthetic: true },
      ]),
      model: { providerID: 'gemini', modelID: 'large', variant: 'thinking' },
      agent: 'nna',
    });
  });

  it('fails before creating a session when no output remains', async () => {
    const listMessages = vi.fn().mockResolvedValue([]);
    const createSession = vi.fn();
    await expect(startFusion(
      { trigger, identity: fusionIdentityFromSession(trigger)!, model: { providerID: 'openai', modelID: 'model' } },
      {
        candidates: {
          storeOfDirectory: () => store([]),
          directoryOfSession: () => undefined,
          globalActive: () => [],
          globalArchived: () => [],
          currentStore: () => store([]),
        },
        createSession,
        selectCurrentSession: () => undefined,
        closeDialog: () => undefined,
        listMessages,
        listMagicPromptOverrides: async () => ({}),
        send: vi.fn(),
      },
    )).rejects.toThrow('no outputs');
    expect(createSession).not.toHaveBeenCalled();
  });
});
