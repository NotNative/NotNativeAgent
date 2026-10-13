// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeFetch } from '../runtime-fetch.ts';
import {
  getSessionKnowledge, getSessionKnowledgeSummary, pinSessionKnowledge,
  recordSessionKnowledgeDelivered,
} from '../session-knowledge-api.ts';

vi.mock('../runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
const call = runtimeFetch as ReturnType<typeof vi.fn>;

function response(value: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => value } as Response;
}

beforeEach(() => {
  vi.mocked(runtimeFetch).mockReset();
});

describe('session knowledge API', () => {
  it('reads pending knowledge and preserves unavailability fields', async () => {
    call.mockResolvedValue(response({ text: 'Company rules', signature: 'a'.repeat(64), unavailable: true, reason: 'plan lock' }));
    await expect(getSessionKnowledge('C:/repo', 'session-1')).resolves.toEqual({
      text: 'Company rules', signature: 'a'.repeat(64), unavailable: true, reason: 'plan lock',
    });
    expect(call).toHaveBeenCalledWith('/api/session-knowledge?directory=C%3A%2Frepo&sessionId=session-1', undefined);
  });

  it('normalizes summary values', async () => {
    call.mockResolvedValue(response({
      notes: [{ id: 'n1', body: 'Note' }, 'invalid'],
      plans: [{ id: 'p1', title: 'Plan' }],
      memory: { global: 2, project: 3 },
    }));
    await expect(getSessionKnowledgeSummary('C:/repo')).resolves.toEqual({
      notes: [{ id: 'n1', body: 'Note' }], plans: [{ id: 'p1', title: 'Plan' }],
      memory: { global: 2, project: 3 },
    });
  });

  it('submits and validates pins and delivery', async () => {
    call.mockReturnValueOnce(response({ pins: { notes: ['n1', 'n1'], plans: [] } }));
    await expect(pinSessionKnowledge({
      sessionId: 'session-1', directory: 'C:/repo', kind: 'note', id: 'n1', pinned: true,
    })).resolves.toEqual({ notes: ['n1'], plans: [] });
    expect(JSON.parse(call.mock.calls[0]?.[1]?.body as string)).toMatchObject({ pinned: true, kind: 'note' });

    call.mockReturnValueOnce(response({ recorded: true }));
    await expect(recordSessionKnowledgeDelivered({
      sessionId: 'session-1', directory: 'C:/repo', signature: 'a'.repeat(64),
    })).resolves.toEqual({ recorded: true });
  });

  it('throws typed request failures and local validation errors', async () => {
    call.mockResolvedValue(response({ error: 'invalid body' }, 400));
    await expect(pinSessionKnowledge({
      sessionId: 'session-1', directory: 'C:/repo', kind: 'note', id: 'n1', pinned: true,
    })).rejects.toMatchObject({ status: 400, detail: 'invalid body' });
    await expect(recordSessionKnowledgeDelivered({
      sessionId: 'session-1', directory: 'C:/repo', signature: 'bad',
    })).rejects.toThrow('Invalid session knowledge delivery request');
  });
});
