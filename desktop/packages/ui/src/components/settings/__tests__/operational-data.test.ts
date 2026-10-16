// SPDX-License-Identifier: Apache-2.0
import { beforeEach, expect, it, vi } from 'vitest';
import { harnessClient, type HarnessSession } from '../../../lib/nnd/client.ts';
import type { MessageEntry } from '../../../lib/nnd/types.ts';
import { conversationTranscript, readDataConversations } from '../pages/conversation-data-model.ts';
import { diagnosticDocument } from '../pages/operational-diagnostics.tsx';
import type { NativeInstallationView } from '../../../lib/nnd/installation.ts';
import type { NativeEnvironmentView } from '../../../lib/nnd/environment.ts';
vi.mock('../../../lib/nnd/client.ts', () => ({ normalizeDirectory: (value: string) => value,
  harnessClient: { listSessions: vi.fn(), getSession: vi.fn(), listMessagesPage: vi.fn(), sessionStatus: vi.fn() } }));
const session = { id: 'ses_export', title: 'Export proof', directory: 'D:/project', time: { created: 1000, updated: 2000 } } as HarnessSession;
const entry = (id: string, role: 'user' | 'assistant', text: string, created: number): MessageEntry => ({
  info: { id, sessionID: session.id, role, time: { created }, agent: 'nna', model: { providerID: 'p', modelID: 'm' } },
  parts: [{ id: `${id}_text`, sessionID: session.id, messageID: id, type: 'text', text }],
} as MessageEntry);
beforeEach(() => { vi.resetAllMocks(); vi.mocked(harnessClient.getSession).mockResolvedValue({ data: session });
  vi.mocked(harnessClient.sessionStatus).mockResolvedValue({ data: {} }); });

it('exports all pages in chronological order while omitting synthetic text and tool payloads', async () => {
  const user = entry('u1', 'user', 'Original task', 1000), reply = entry('a1', 'assistant', 'Finished task', 2000);
  reply.parts.push({ type: 'tool', state: { input: { password: 'TOOL_SECRET_MARKER' }, output: 'TOOL_OUTPUT_MARKER' } } as never,
    { type: 'text', text: 'SYNTHETIC_MARKER', synthetic: true } as never, { type: 'text', text: 'IGNORED_MARKER', ignored: true } as never);
  vi.mocked(harnessClient.listMessagesPage).mockResolvedValueOnce({ data: [reply], cursor: 'older' }).mockResolvedValueOnce({ data: [user], cursor: null });
  const result = await conversationTranscript(session, new AbortController().signal);
  expect(result.indexOf('Original task')).toBeLessThan(result.indexOf('Finished task'));
  expect(result).toContain('1 tool call omitted'); expect(result).not.toMatch(/TOOL_SECRET_MARKER|TOOL_OUTPUT_MARKER|SYNTHETIC_MARKER|IGNORED_MARKER/);
  expect(harnessClient.listMessagesPage).toHaveBeenNthCalledWith(2, session.id, { directory: session.directory, limit: 100, before: 'older' });
  expect(harnessClient.getSession).toHaveBeenCalledTimes(2);
});

it.each([['read failure', 'could not be read'], ['duplicate message', 'invalid record'], ['foreign session', 'invalid record'],
  ['repeated cursor', 'cursor repeated'], ['changed conversation', 'changed during export'], ['oversize', '8 MiB export bound']])(
  'refuses %s without returning a partial transcript', async (failure, expected) => {
    const user = entry('u1', 'user', 'Task', 1000);
    if (failure === 'read failure') vi.mocked(harnessClient.listMessagesPage).mockResolvedValueOnce({ data: [user], cursor: 'older' }).mockResolvedValueOnce({ error: 'offline' });
    else if (failure === 'duplicate message') vi.mocked(harnessClient.listMessagesPage).mockResolvedValueOnce({ data: [user], cursor: 'older' }).mockResolvedValueOnce({ data: [user] });
    else if (failure === 'foreign session') { user.info.sessionID = 'ses_other'; vi.mocked(harnessClient.listMessagesPage).mockResolvedValueOnce({ data: [user] }); }
    else if (failure === 'repeated cursor') vi.mocked(harnessClient.listMessagesPage).mockResolvedValueOnce({ data: [user], cursor: 'cycle' }).mockResolvedValueOnce({ data: [entry('u2', 'user', 'Next', 2000)], cursor: 'cycle' });
    else if (failure === 'changed conversation') { vi.mocked(harnessClient.listMessagesPage).mockResolvedValueOnce({ data: [user] });
      vi.mocked(harnessClient.getSession).mockResolvedValueOnce({ data: session }).mockResolvedValueOnce({ data: { ...session, time: { ...session.time, updated: 3000 } } }); }
    else vi.mocked(harnessClient.listMessagesPage).mockResolvedValueOnce({ data: [entry('u1', 'user', 'x'.repeat(8388608), 1000)] });
    await expect(conversationTranscript(session, new AbortController().signal)).rejects.toThrow(expected);
  });

it.each(['before', 'after'])('refuses a busy conversation %s fetching pages', async when => {
  const busy = { data: { [session.id]: { type: 'busy' as const } } };
  if (when === 'before') vi.mocked(harnessClient.sessionStatus).mockResolvedValueOnce(busy);
  else vi.mocked(harnessClient.sessionStatus).mockResolvedValueOnce({ data: {} }).mockResolvedValueOnce(busy);
  vi.mocked(harnessClient.listMessagesPage).mockResolvedValueOnce({ data: [entry('u1', 'user', 'Task', 1000)] });
  await expect(conversationTranscript(session, new AbortController().signal)).rejects.toThrow('idle conversation');
  expect(harnessClient.listMessagesPage).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
});

it('discards a late transcript page after cancellation', async () => {
  const controller = new AbortController(); let finish!: (value: { data: MessageEntry[] }) => void;
  vi.mocked(harnessClient.listMessagesPage).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const result = conversationTranscript(session, controller.signal); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  controller.abort(); finish({ data: [entry('u1', 'user', 'late', 1000)] }); await expect(result).rejects.toThrow();
  expect(harnessClient.getSession).toHaveBeenCalledTimes(1);
});

it('excludes child rows while preserving empty success and refusing a failed conversation list', async () => {
  vi.mocked(harnessClient.listSessions).mockResolvedValueOnce({ data: [session, { ...session, id: 'child', parentID: session.id }] });
  expect((await readDataConversations(new AbortController().signal)).map(row => row.id)).toEqual([session.id]);
  vi.mocked(harnessClient.listSessions).mockResolvedValueOnce({ data: [] }); expect(await readDataConversations(new AbortController().signal)).toEqual([]);
  vi.mocked(harnessClient.listSessions).mockResolvedValueOnce({ error: 'offline' }); await expect(readDataConversations(new AbortController().signal)).rejects.toThrow('unavailable');
});

it.each([false, true])('exports diagnostic presence only; include paths = %s', paths => {
  const installation = { product: 'NotNativeAgent', version: '20261016-1', node_major: 24, install_root: 'PRIVATE_APP_PATH',
    data_root: 'PRIVATE_DATA_PATH', node: 'PRIVATE_NODE_PATH', credential: 'PRIVATE_INSTALL_SECRET' } as unknown as NativeInstallationView;
  const environment = { observed: [{ name: 'NNA_TELEGRAM_BOT_TOKEN', present: true, secret: true, value: 'PRIVATE_TOKEN_VALUE' },
    { name: 'NNA_MODEL', present: true, secret: false, value: 'PRIVATE_MODEL_VALUE' }] } as NativeEnvironmentView;
  const result = diagnosticDocument(installation, environment, paths), serialized = JSON.stringify(result);
  expect(result.environment).toEqual([{ name: 'NNA_TELEGRAM_BOT_TOKEN', present: true }, { name: 'NNA_MODEL', present: true }]);
  expect(serialized).not.toMatch(/PRIVATE_INSTALL_SECRET|PRIVATE_TOKEN_VALUE|PRIVATE_MODEL_VALUE/);
  expect(Object.hasOwn(result, 'paths')).toBe(paths); expect(serialized.includes('PRIVATE_DATA_PATH')).toBe(paths);
  expect(result).toMatchObject({ format: 'nna-diagnostic-summary', version: 1, package_version: '20261016-1' });
});
