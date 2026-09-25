import { describe, expect, it, vi } from 'vitest';
import { runtimeFetch } from '../../runtime-fetch.ts';
import { harnessClient, normalizeDirectory } from '../client.ts';

vi.mock('../../runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));

describe('normalizeDirectory (HP-4)', () => {
  it('unifies separators, uppercases drive, trims trailing slashes', () => {
    expect(normalizeDirectory('C:\\work\\repo\\')).toBe('C:/work/repo');
    expect(normalizeDirectory('/home/user/dev/')).toBe('/home/user/dev');
    expect(normalizeDirectory('c:/lower')).toBe('C:/lower');
    expect(normalizeDirectory('  spaced/path  ')).toBe('spaced/path');
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
