import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeFetch } from '../../runtime-fetch.ts';
import { harnessClient, normalizeDirectory } from '../client.ts';

vi.mock('../../runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
beforeEach(() => vi.mocked(runtimeFetch).mockReset());

describe('normalizeDirectory (HP-4)', () => {
  it('unifies separators, uppercases drive, trims trailing slashes', () => {
    expect(normalizeDirectory('C:\\work\\repo\\')).toBe('C:/work/repo');
    expect(normalizeDirectory('/home/user/dev/')).toBe('/home/user/dev');
    expect(normalizeDirectory('c:/lower')).toBe('C:/lower');
    expect(normalizeDirectory('  spaced/path  ')).toBe('spaced/path');
  });
});

describe('NNA-owned permission mode contract', () => {
  it('encodes session identity and sends the expected revision to the authenticated proxy', async () => {
    const fetcher = vi.mocked(runtimeFetch); fetcher.mockClear();
    fetcher.mockImplementation(async () => new Response('{}', { status: 200 }));
    await harnessClient.getSessionReviewMode('session/a');
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/nnd/sessions/session%2Fa/review-mode');
    await harnessClient.setSessionReviewMode('session/a', 'auto-review', 4);
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/v1/nnd/sessions/session%2Fa/review-mode');
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe('PUT');
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ mode: 'auto-review', expected_revision: 4 });
  });
  it('returns a readable error envelope when response body reading fails', async () => {
    const response = new Response('{}', { status: 200 });
    vi.spyOn(response, 'text').mockRejectedValue(new Error('connection closed'));
    vi.mocked(runtimeFetch).mockResolvedValueOnce(response);
    const result = await harnessClient.getSessionReviewMode('s1');
    expect(result.error).toContain('connection closed');
    expect(result.data).toBeUndefined();
  });
});

describe('NNA child steering contract', () => {
  it('addresses capability and steering through the authenticated harness proxy', async () => {
    const fetcher = vi.mocked(runtimeFetch);
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ session_id: 'agent_1', revision: 1,
      capabilities: { steer_subagent: true }, availability: 'granted' }), { status: 200 }));
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true }), { status: 202 }));
    const capability = await harnessClient.childSteeringCapability('agent_1', { directory: 'D:/work' });
    expect(capability.data?.capabilities.steer_subagent).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/nnd/sessions/agent_1/capabilities?directory=D%3A%2Fwork');
    const result = await harnessClient.steerChildSession('agent_1', { request_id: 'steer_1', content: 'Continue' }, { directory: 'D:/work' });
    expect(result.response?.status).toBe(202);
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/v1/nnd/sessions/agent_1/steer');
    expect((fetcher.mock.calls[1]?.[1]?.headers as Headers).get('x-nnd-directory')).toBe('D:/work');
  });
});
