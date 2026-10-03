// SPDX-License-Identifier: Apache-2.0
import { beforeEach, expect, it, vi } from 'vitest';
import { harnessClient } from '../../lib/nnd/client.ts';
import { runtimeFetch } from '../../lib/runtime-fetch.ts';
import { createSession, type EngineServices } from '../session-lifecycle.ts';
import { beginAuthorityRecovery, finishAuthorityRecovery } from '../authority-sync.ts';
import { getRuntimeKey } from '../../lib/runtime-switch.ts';

vi.mock('../../lib/nnd/client.ts', () => ({
  normalizeDirectory: (value: string) => value.trim().replaceAll('\\', '/').replace(/^([a-z]):/u, (_: string, drive: string) => `${drive.toUpperCase()}:`).replace(/\/+$/u, ''),
  harnessClient: { createSession: vi.fn() },
}));
vi.mock('../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

const rootA = 'D:/repo/A', rootB = 'D:/repo/B';
const admission = (directory: string) => new Response(JSON.stringify({ directory }), { status: 200 });
const selection = vi.fn(), insert = vi.fn(), route = vi.fn();
const engine = { ensureChild: insert, registerSessionRoute: route, loaderInitializeCreated: vi.fn(),
  onSelectSession: selection } as unknown as EngineServices;
beforeEach(() => { vi.resetAllMocks(); vi.mocked(runtimeFetch).mockResolvedValue(admission(rootA)); });

it('refuses a second selected repository before any native session creation', async () => {
  vi.mocked(runtimeFetch).mockResolvedValue(new Response(JSON.stringify({ error: { message: `NNA is attached to ${rootA}. Select that workspace or reconfigure NNA before creating a session.` } }), { status: 409 }));
  await expect(createSession(engine, { directory: rootB })).rejects.toThrow(`NNA is attached to ${rootA}`);
  expect(harnessClient.createSession).not.toHaveBeenCalled();
  expect(selection).not.toHaveBeenCalled();
});

it('fails closed on aliases, missing and conflicting native root evidence', async () => {
  for (const candidate of ['D:/repo/../repo/A', '//server/share/A', 'D:repo/A']) {
    await expect(createSession(engine, { directory: candidate })).rejects.toThrow('workspace identity is unavailable');
  }
  vi.mocked(runtimeFetch).mockResolvedValue(new Response(JSON.stringify({ error: { message: 'NNA workspace identity is unavailable.' } }), { status: 503 }));
  await expect(createSession(engine, { directory: rootA })).rejects.toThrow('workspace identity is unavailable');
  expect(harnessClient.createSession).not.toHaveBeenCalled();
});

it('preserves a race-created session without selecting or dispatching in the changed root', async () => {
  vi.mocked(harnessClient.createSession).mockResolvedValue({ data: { id: 'ses_recover', directory: rootB } as never });
  await expect(createSession(engine, { directory: rootA })).rejects.toThrow('ses_recover');
  expect(harnessClient.createSession).toHaveBeenCalledOnce();
  expect(selection).not.toHaveBeenCalled();
  expect(insert).not.toHaveBeenCalled();
});

it('selects a new session only when NNA confirms the same attached workspace', async () => {
  const session = { id: 'ses_a', directory: rootA };
  vi.mocked(harnessClient.createSession).mockResolvedValue({ data: session as never });
  const store = { setState: vi.fn() }; insert.mockReturnValue(store);
  expect((await createSession(engine, { directory: rootA })).id).toBe(session.id);
  expect(harnessClient.createSession).toHaveBeenCalledWith({ title: undefined, directory: rootA });
  expect(route).toHaveBeenCalledWith('ses_a', rootA);
  expect(selection).toHaveBeenCalledWith('ses_a', rootA);
});

it('does not issue create when a replay gap appears during native workspace admission', async () => {
  let admit!: (response: Response) => void;
  vi.mocked(runtimeFetch).mockImplementation(() => new Promise((resolve) => { admit = resolve; }));
  const pending = createSession(engine, { directory: rootA });
  const runtime = getRuntimeKey();
  const token = beginAuthorityRecovery(runtime);
  admit(admission(rootA));
  try {
    await expect(pending).rejects.toThrow(/resynchronizing/);
    expect(harnessClient.createSession).not.toHaveBeenCalled();
  } finally { finishAuthorityRecovery(runtime, token, true); }
});

it('preserves a session created as native authority closes without selecting it', async () => {
  let created!: (response: Awaited<ReturnType<typeof harnessClient.createSession>>) => void;
  vi.mocked(harnessClient.createSession).mockImplementation(() => new Promise((resolve) => { created = resolve; }));
  const pending = createSession(engine, { directory: rootA });
  await vi.waitFor(() => expect(harnessClient.createSession).toHaveBeenCalledOnce());
  const runtime = getRuntimeKey();
  const token = beginAuthorityRecovery(runtime);
  created({ data: { id: 'ses_race', directory: rootA } as never });
  try {
    await expect(pending).rejects.toThrow(/ses_race.*recoverable/);
    expect(selection).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  } finally { finishAuthorityRecovery(runtime, token, true); }
});
