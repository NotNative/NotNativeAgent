// SPDX-License-Identifier: Apache-2.0
/** P10-58 H.2 consumer contract: server namespace, identity anchor, toggles. */
import { describe, expect, it } from 'vitest';
import { recapFor } from '../work-status.ts';
import { parseSessionAssistView } from '../session-assist-view.ts';

function storeFor(metadata: unknown, messages: unknown[] = []): never {
  return {
    sessionStatusReady: true, session_status: {}, session: [{ id: 's1', metadata }],
    message: { s1: messages },
  } as never;
}

const message = (id: string, role: 'assistant' | 'user' = 'assistant') => ({ id, role, time: { completed: 2 } });
const valid = { recap: 'Built the thing', suggestion: 'Run tests next', forMessageID: 'a1', generatedAt: Date.now() - 65_000 };

describe('session-assist consumer', () => {
  it('parses only openchamber.assist and rejects malformed freshness', () => {
    expect(parseSessionAssistView({ openchamber: { assist: valid } })).toEqual(valid);
    expect(parseSessionAssistView({ openchamber: { assist: {
      ...valid, generatedAt: -10 * 24 * 60 * 60 * 1000 } } })).toBeNull();
    expect(parseSessionAssistView({ openchamber: { assist: {
      ...valid, generatedAt: Date.now() + 10 * 24 * 60 * 60 * 1000 } } })).not.toBeNull();
    expect(parseSessionAssistView({ openchamber: { assist: {
      ...valid, generatedAt: Date.now() + 200 * 24 * 60 * 60 * 1000 } } })).toBeNull();
    expect(parseSessionAssistView({ nnd: { assist: valid } })).toBeNull();
    expect(parseSessionAssistView({ openchamber: { assist: { ...valid, generatedAt: 0 } } })).toBeNull();
    expect(parseSessionAssistView({ openchamber: { assist: { ...valid, forMessageID: '12' } } })).toBeNull();
    expect(parseSessionAssistView({ openchamber: { assist: { ...valid, recap: '', suggestion: ' ' } } })).toBeNull();
  });

  it('rejects oversized externally supplied values instead of silently trusting them', () => {
    const bounded = parseSessionAssistView({ openchamber: { assist: {
      ...valid, recap: 'a'.repeat(400), suggestion: 'b'.repeat(600) } } });
    expect(bounded?.recap).toHaveLength(320);
    expect(bounded?.suggestion).toHaveLength(500);
  });

  it('anchors by last assistant identity, even after a trailing user event', () => {
    const state = storeFor({ openchamber: { assist: valid } },
      [message('a1'), message('user-1', 'user')]);
    expect(recapFor(state, 's1')?.recap).toBe('Built the thing');
    expect(recapFor(state, 's1')?.suggestion).toBe('Run tests next');
    expect(recapFor(storeFor({ openchamber: { assist: { ...valid, forMessageID: 'a2' } } },
      [message('a1')]), 's1')).toBeNull();
  });

  it('does not anchor while the last assistant remains incomplete', () => {
    const state = storeFor({ openchamber: { assist: valid } },
      [{ id: 'a1', role: 'assistant', time: { created: 1 } }]);
    expect(recapFor(state, 's1')).toBeNull();
  });

  it('independent toggles can leave only a suggestion or suppress a stale render', () => {
    const state = storeFor({ openchamber: { assist: valid } }, [message('a1')]);
    expect(recapFor(state, 's1', Date.now(), { recap: false, suggestion: true }))
      .toEqual({ recap: null, suggestion: 'Run tests next' });
    expect(recapFor(state, 's1', Date.now(), { recap: true, suggestion: false }))
      .toEqual({ recap: 'Built the thing', suggestion: null });
    expect(recapFor(state, 's1', Date.now(), { recap: false, suggestion: false })).toBeNull();
  });
});
