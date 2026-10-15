// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { deliverToNewSession, type NewSessionDeliveryInput } from '../composer-draft-pins.ts';
import { __resetDraftStoreForTests, readDraft, saveDraft } from '../drafts.ts';
import { useConversationDraftStore } from '../../stores/useConversationDraftStore.ts';
import { initializeRuntimeEndpoint } from '../../lib/runtime-switch.ts';
import { harnessClient } from '../../lib/nnd/client.ts';
import * as runtimeTransport from '../../lib/runtime-fetch.ts';
import { disconnectConversationDraftPersistence } from '../conversation-draft-persistence.ts';
import { useSessionViewStore } from '../../sync/view-store.ts';

initializeRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:61776', runtimeKey: 'local' });
afterEach(disconnectConversationDraftPersistence);
beforeEach(() => {
  disconnectConversationDraftPersistence();
  useConversationDraftStore.setState({ phase: 'local', syncError: null });
  vi.restoreAllMocks();
  vi.spyOn(harnessClient, 'getSession').mockResolvedValue({ data: { id: 'ses_created', directory: '/workspace', metadata: { nnd: { configuredModel: { providerID: 'selected', modelID: 'chosen' } } } } as never });
  localStorage.clear(); __resetDraftStoreForTests(); useConversationDraftStore.getState().load();
  useSessionViewStore.setState({ activeDirectory: '/workspace', currentSessionId: null, currentDraftId: null });
});
function setup() {
  const draft = useConversationDraftStore.getState().create('/workspace');
  useConversationDraftStore.getState().update(draft.id, { model: { providerID: 'selected', modelID: 'chosen' }, reviewMode: 'unattended' });
  useSessionViewStore.setState({ currentDraftId: draft.id });
  const createSession = vi.fn(async () => ({ id: 'ses_created', metadata: { nnd: { configuredModel: { providerID: 'selected', modelID: 'chosen' } } } }));
  const send = vi.fn(async (): Promise<void> => undefined);
  const input: NewSessionDeliveryInput = { directory: '/workspace', sourceKey: draft.id,
    outgoing: [{ type: 'text', text: 'Original question' }], delivery: null, model: { providerID: 'default', modelID: 'default' },
    sendAgent: 'nna', nnaConfigured: true, services: { engine: { actions: { createSession, send } } } };
  return { draft, createSession, send, input };
}

it('retries the original submission in the created session after a failed send', async () => {
  const { draft, createSession, send, input } = setup();
  send.mockRejectedValueOnce(new Error('network error'));
  await expect(deliverToNewSession(input)).rejects.toThrow('network error');
  expect(readDraft(input.directory, draft.id).start?.sessionID).toBe('ses_created');
  await deliverToNewSession({ ...input, outgoing: [{ type: 'text', text: 'Later edit' }] });
  expect(createSession).toHaveBeenCalledTimes(1);
  expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ model: { providerID: 'selected', modelID: 'chosen' }, reviewMode: 'unattended' }));
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  expect(useSessionViewStore.getState().currentSessionId).toBe('ses_created');
  expect(useConversationDraftStore.getState().drafts).toHaveLength(0);
});

it('keeps the creation operation stable after an unknown create response', async () => {
  const { createSession, input } = setup();
  createSession.mockRejectedValueOnce(new Error('response lost'));
  await expect(deliverToNewSession(input)).rejects.toThrow();
  await deliverToNewSession(input);
  expect(createSession.mock.calls[1]).toEqual(createSession.mock.calls[0]);
});

it('does not navigate away from a conversation selected during the first send', async () => {
  const { send, input } = setup();
  let done!: () => void;
  send.mockImplementationOnce(() => new Promise<void>(resolve => { done = resolve; }));
  const sending = deliverToNewSession(input);
  await vi.waitFor(() => expect(send).toHaveBeenCalled());
  useSessionViewStore.setState({ currentSessionId: 'ses_other', activeDirectory: '/other' });
  done(); await sending;
  expect(useSessionViewStore.getState()).toMatchObject({ currentSessionId: 'ses_other', activeDirectory: '/other' });
});

it('moves and restores independent drafts with their attachments', () => {
  const first = useConversationDraftStore.getState().create('/workspace');
  saveDraft('/workspace', first.id, { text: 'Keep this', attachments: [{ name: 'file.txt', mime: 'text/plain', dataUrl: 'data:text/plain;base64,YQ==' }], queue: [] });
  const second = useConversationDraftStore.getState().create('/workspace');
  useConversationDraftStore.getState().move(first.id, '/other');
  useConversationDraftStore.getState().load();
  expect(readDraft('/other', first.id).text).toBe('Keep this');
  expect(readDraft('/other', first.id).attachments[0]?.name).toBe('file.txt');
  expect(readDraft('/workspace', second.id).text).toBe('');
  expect(useConversationDraftStore.getState().drafts).toHaveLength(2);
});


it('does not create an engine session until its start snapshot is durably saved', async () => {
  const { input, createSession, send, draft } = setup(); let failing = false, revision = 0;
  vi.spyOn(runtimeTransport, 'runtimeFetch').mockImplementation(async (_path, init) => {
    if (!init || init.method === 'GET') return new Response(JSON.stringify({ version: 1, drafts: {} }));
    if (failing) return new Response(JSON.stringify({ error: 'Disk unavailable' }), { status: 503 });
    return new Response(JSON.stringify({ revision: ++revision, value: JSON.parse(String(init.body)).value }));
  });
  await useConversationDraftStore.getState().connect(); failing = true;
  await expect(deliverToNewSession(input)).rejects.toThrow('Disk unavailable');
  expect(createSession).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  const prepared = readDraft(input.directory, draft.id).start;
  expect(prepared?.operationId).toBe(draft.id);
  failing = false; await deliverToNewSession(input);
  expect(createSession).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledWith(expect.objectContaining({ messageID: prepared!.messageID }));
});
